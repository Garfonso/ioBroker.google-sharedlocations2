import type { GoogleSharedlocations2 } from '../main';
import puppeteer from 'puppeteer';
import type { Browser, Page, CookieData, CookiePriority, CookieSameSite } from 'puppeteer';
import { mkdir, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);

/** File name of the login screenshot inside the instance file storage. */
const LOGIN_SCREENSHOT_FILE = 'login/current.png';
/** Fallback for how long to keep the browser open while the user confirms a Google challenge, if not configured. */
const DEFAULT_CHALLENGE_TIMEOUT_SECONDS = 120;
/** Fallback remote debugging port, if remote debugging is enabled but no port is configured. */
const DEFAULT_REMOTE_DEBUGGING_PORT = 9222;

/**
 * Helper class to manage Google cookies.
 */
export class Cookie {
    cookies: CookieData[] = [];
    username?: string;
    password?: string;
    adapter: GoogleSharedlocations2;
    log;
    private browser: Browser | null = null;
    private browserInstallTried = false;
    dataDir: string;

    /**
     * Construct cookie helper
     *
     * @param adapter - adapter instance
     * @param dataDir - data directory of the instance to store browser data to.
     */
    constructor(adapter: GoogleSharedlocations2, dataDir: string) {
        this.username = '';
        this.password = '';
        this.adapter = adapter;
        this.log = adapter.log;
        this.dataDir = dataDir;
    }

    /**
     * Initialize the cookie helper by loading the cookie from state.
     */
    async init(): Promise<void> {
        this.username = this.adapter.config.googleUsername;
        this.password = this.adapter.config.googlePassword;
        this.log = this.adapter.log; // does not exist during construction...
        try {
            //ensure data dir exists
            await mkdir(this.dataDir, { recursive: true }); //recursive true should prevent error if already exists.
            const state = await this.adapter.getStateAsync('info.cookieStore');
            const stringState = await this.adapter.getStateAsync('info.currentCookies');
            if (state && state.val && typeof state.val === 'string') {
                try {
                    this.cookies = JSON.parse(state.val);
                    this.log?.debug(`Loaded ${this.cookies.length} cookies from state.`);
                    if (this.isValid()) {
                        return;
                    }
                } catch (e) {
                    this.log?.error(
                        `Error parsing cookies from state: ${(e as Error).message}, using string as cookie.`,
                    );
                }
            }

            if (stringState && stringState.val && typeof stringState.val === 'string') {
                this.log?.debug('Loaded cookie string from state, trying to convert to new format.');
                this.readCookieFromString(stringState.val);
                if (this.isValid()) {
                    return;
                }
            }

            this.log?.debug('No cookie found in states, trying to log in to get new one.');
            await this.loginToGetNewCookies();
        } catch (err: any) {
            this.log?.error(`Error loading cookie from state: ${err}`);
        }
    }

    /**
     * Store the current cookie in an iobroker state.
     */
    async storeCookie(): Promise<void> {
        try {
            await this.adapter.setState('info.cookieStore', JSON.stringify(this.cookies), true);
            await this.adapter.setState(
                'info.currentCookies',
                this.cookies.map(c => `${c.name}=${c.value}`).join('; '),
                true,
            );
        } catch (err: any) {
            this.log?.error(`Error storing cookie: ${err}`);
        }
    }

    /**
     * Read cookie from a string in the format "name=value; name2=value2" and store it in the cookies array.
     *
     * @param cookieString - cookie string to read from
     */
    readCookieFromString(cookieString: string): void {
        this.cookies = cookieString
            .split(';')
            .map(pair => {
                const parts = pair.trim().split('=');
                return parts.length >= 2
                    ? {
                          name: parts[0].trim(),
                          value: parts.slice(1).join('=').trim(),
                          domain: '.google.com',
                          path: '/',
                          secure: true,
                      }
                    : null;
            })
            .filter(c => c !== null);
        this.log.debug(`Converted cookie string to ${this.cookies.length} cookies.`);
    }

    /**
     * Augment the current cookie with data from the 'set-cookie' header.
     *
     * @param headersObj - HTTP headers of response
     */
    async augmentCookieFromHeader(headersObj: Headers): Promise<void> {
        const headers = headersObj.getSetCookie();
        if (headers.length > 0) {
            this.log?.debug('New header received.');
            const oldLength = this.cookies.length;

            //split old cookie and new cookie. Update single values.
            for (const header of headers) {
                //console.log('Processing header cookie:', header);
                const keyValues = header.split('; ');
                const firstCookie = keyValues.shift();
                if (firstCookie === undefined) {
                    this.log.debug(`Invalid cookie header: ${header}`);
                    continue;
                }
                const [name, value] = firstCookie.split('='); // first part is cookie, rest are attributes like path, secure etc.
                const cookie = {
                    name: name.trim(),
                    value: value.trim(),
                    domain: '.google.com',
                } as CookieData;
                for (const kv of keyValues) {
                    const [k, v] = kv.split('=');
                    switch (k.toLowerCase()) {
                        case 'domain':
                            cookie.domain = v ? v.trim() : '.google.com';
                            break;
                        case 'path':
                            cookie.path = v ? v.trim() : '/';
                            break;
                        case 'secure':
                            cookie.secure = true;
                            break;
                        case 'httponly':
                            cookie.httpOnly = true;
                            break;
                        case 'samesite':
                            cookie.sameSite = v ? (v.trim() as CookieSameSite) : 'Lax';
                            break;
                        case 'expires':
                            cookie.expires = new Date(v).getTime() / 1000; //puppeteer expects expires in seconds, not milliseconds
                            break;
                        case 'priority':
                            cookie.priority = v ? (v.trim() as CookiePriority) : 'Medium';
                            break;
                        default:
                            this.log.debug(`Unknown cookie attribute: ${k}=${v}`);
                    }
                }
                const cIndex = this.cookies.findIndex(c => c.name === name);
                if (cIndex < 0) {
                    this.log.debug(`Adding new cookie from header: ${cookie.name}`);
                    this.cookies.push(cookie); //add
                } else {
                    this.log.debug(`Updating cookie from header: ${cookie.name}`);
                    this.cookies[cIndex] = cookie; //update
                }
            }

            // seems puppeteer sets expires to -1 if not present.
            this.cookies
                .filter(c => c.expires && c.expires > 0 && c.expires < Date.now() / 1000)
                .forEach(c =>
                    this.log.debug(
                        `Cookie ${c.name} expired at ${new Date(c.expires! * 1000).toISOString()} - ${c.expires}`,
                    ),
                );
            this.cookies = this.cookies.filter(c => !c.expires || c.expires < 0 || c.expires > Date.now() / 1000); //remove expired cookies

            this.log?.debug(`Cookie updated. Length: ${oldLength} -> ${this.cookies.length}`);
            return this.storeCookie();
        }
    }

    /**
     * Improve the current cookie by making a request to Google My Account page.
     */
    async improveCookie(): Promise<boolean> {
        const url = 'https://myaccount.google.com/?hl=en';
        const options = {
            headers: {
                Cookie: this.cookies.map(c => `${c.name}=${c.value}`).join('; '),
            },
            method: 'get',
        };

        try {
            this.log.debug('Trying to improve cookie.');
            const response = await fetch(url, options);

            if (response.status !== 200) {
                this.log?.error(`Failed improving cookie: ${response.status} - ${response.statusText}`);
                //response body can be a whole Google account page, so only log a truncated version on debug.
                this.log?.debug(`Response body was: ${(await response.text()).slice(0, 500)}`);
                return false;
            }
            await this.augmentCookieFromHeader(response.headers);
            return true;
        } catch (err) {
            this.log?.error(`Connection to google maps failed: ${(err as Error).message}`);
            return false;
        }
    }

    /**
     * Start a puppeteer browser instance and return a new page. Sets up user agent and hides automation flag.
     *
     * @returns puppeteer page or undefined if browser could not be started
     */
    private async startBrowser(): Promise<Page | undefined> {
        if (this.browser) {
            this.log.info('Seems we are already trying to log in. Aborting new login attempt.');
            return;
        }
        this.log.debug('Starting browser.');
        const args = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'];
        if (this.adapter.config.remoteDebugging) {
            const port = this.adapter.config.remoteDebuggingPort || DEFAULT_REMOTE_DEBUGGING_PORT;
            //no --remote-debugging-address on purpose: Chrome then only listens on localhost. Whoever reaches
            //this port can control the browser and read the Google session, so it has to be tunneled (ssh -L).
            args.push(`--remote-debugging-port=${port}`);
            this.log.info(
                `Remote debugging enabled on localhost:${port}. Forward the port to your PC, for example ` +
                    `"ssh -L ${port}:localhost:${port} user@iobroker-host", then open http://localhost:${port} in Chrome.`,
            );
        }
        try {
            this.browser = await puppeteer.launch({
                headless: true,
                args,
                ignoreDefaultArgs: ['--enable-automation'], //h// ide automation flag, did not help.
                userDataDir: this.dataDir,
            });
            this.log.debug('browser started, opening new page.');
            const page = await this.browser.newPage();
            //hide puppeteer automation flag
            await page.evaluateOnNewDocument(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => false });
            });
            //derive the spoofed user agent from the Chrome we actually run, a version mismatch between the
            //user agent and the real browser is an obvious bot detection signal. Also keeps working after
            //puppeteer upgrades that bring a new Chrome.
            const majorVersion = (await this.browser.version()).match(/Chrome\/(\d+)/)?.[1];
            if (!majorVersion) {
                this.log.debug('Could not determine Chrome version, using the user agent Chrome reports itself.');
            } else {
                await page.setUserAgent({
                    userAgent:
                        `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
                        `Chrome/${majorVersion}.0.0.0 Safari/537.36`,
                });
            }

            return page;
        } catch (e) {
            // Browser could not be started (e.g. Chrome binary or system libs missing). Do not crash the adapter,
            // just skip the browser based cookie refresh and keep polling with the existing cookies.
            const message = (e as Error).message;
            this.log.error(`Could not launch browser: ${message}`);
            try {
                await this.browser?.close();
            } catch {
                /* ignore */
            }
            this.browser = null;
            // The Chrome binary is missing (typically after a puppeteer upgrade that needs a newer Chrome).
            // Try to download the matching Chrome once and retry, so the adapter self-heals without manual steps.
            if (/Could not find Chrome/i.test(message) && !this.browserInstallTried) {
                this.browserInstallTried = true;
                if (await this.installBrowser()) {
                    return this.startBrowser();
                }
            }
            return undefined;
        }
    }

    /**
     * Download the Chrome build that the installed puppeteer version expects, using puppeteer's own CLI so the
     * version always matches. Used as a self-heal when launching the browser failed because Chrome is missing.
     *
     * @returns true if the install command finished without error
     */
    private async installBrowser(): Promise<boolean> {
        try {
            this.log.info('Chrome is missing, trying to download the matching version. This can take a while...');
            // Resolve puppeteer's CLI from the installed package so the downloaded Chrome matches this puppeteer version.
            const pkgPath = require.resolve('puppeteer/package.json');
            const bin = JSON.parse(await readFile(pkgPath, 'utf8')).bin;
            const binRel = typeof bin === 'string' ? bin : bin.puppeteer;
            const cliPath = path.join(path.dirname(pkgPath), binRel);
            const { stdout } = await execFileAsync(process.execPath, [cliPath, 'browsers', 'install', 'chrome']);
            this.log.info(`Chrome download finished: ${stdout.trim()}`);
            return true;
        } catch (e) {
            this.log.error(`Could not download Chrome: ${(e as Error).message}`);
            return false;
        }
    }

    /**
     * Publish what the (invisible) browser currently shows: a screenshot in the instance file storage and the
     * visible page text in a state. Google challenges like "choose the number shown" only appear inside the
     * headless browser, so this is the only way for the user to see which number to confirm on the phone.
     *
     * @param page - puppeteer page to capture
     * @param reason - short description why the capture was made, stored together with the page text
     */
    private async captureBrowserState(page: Page, reason: string): Promise<void> {
        try {
            const screenshot = Buffer.from(await page.screenshot({ type: 'png' }));
            await this.adapter.writeFileAsync(this.adapter.namespace, LOGIN_SCREENSHOT_FILE, screenshot);
            await this.adapter.setState(
                'info.loginScreenshot',
                `/files/${this.adapter.namespace}/${LOGIN_SCREENSHOT_FILE}?ts=${Date.now()}`,
                true,
            );
        } catch (e) {
            this.log.warn(`Could not store login screenshot: ${(e as Error).message}`);
        }
        try {
            //the callback runs in the browser, so document exists there. Typed locally, because the adapter
            //is compiled without the DOM library.
            const text = await page.evaluate(
                () => (globalThis as { document?: { body?: { innerText?: string } } }).document?.body?.innerText || '',
            );
            await this.adapter.setState(
                'info.loginPageText',
                `${reason}\n${page.url()}\n\n${text.trim().slice(0, 2000)}`,
                true,
            );
        } catch (e) {
            this.log.warn(`Could not read login page text: ${(e as Error).message}`);
        }
    }

    /**
     * Clear the published browser state after a successful login, so an old challenge (and the account data
     * visible on it) does not stay around in the states.
     */
    private async clearBrowserState(): Promise<void> {
        try {
            await this.adapter.setState('info.loginPageText', '', true);
            await this.adapter.setState('info.loginScreenshot', '', true);
        } catch (e) {
            this.log.debug(`Could not clear login states: ${(e as Error).message}`);
        }
    }

    /**
     * Google sometimes wants an extra confirmation after the password (2FA, "is this you?", "choose the number
     * shown on your device"). Keep the browser open and publish what it shows, so the user can answer on the
     * phone instead of the login just timing out.
     *
     * @param page - puppeteer page that is still on the Google login
     * @param timeoutSeconds - how long to wait for the user to confirm
     * @returns true if the browser left accounts.google.com, i.e. the challenge was answered
     */
    private async waitForLoginChallenge(page: Page, timeoutSeconds: number): Promise<boolean> {
        this.log.warn(
            `Google wants an additional confirmation. The number to choose on your phone is in state ` +
                `info.loginPageText, a screenshot of the browser in /files/${this.adapter.namespace}/${LOGIN_SCREENSHOT_FILE}. ` +
                `Waiting up to ${timeoutSeconds}s for the confirmation.`,
        );
        const deadline = Date.now() + timeoutSeconds * 1000;
        let poll = 0;
        while (Date.now() < deadline) {
            if (!page.url().includes('accounts.google.com')) {
                this.log.info('Confirmation accepted, continuing login.');
                return true;
            }
            //refresh screenshot and text every 15s, the shown challenge can change while we wait
            if (poll % 3 === 0) {
                await this.captureBrowserState(page, 'Google wants an additional confirmation');
            }
            poll++;
            await new Promise(resolve => this.adapter.setTimeout(() => resolve(undefined), 5000));
        }
        this.log.warn('Google confirmation was not answered in time, giving up this login attempt.');
        return !page.url().includes('accounts.google.com');
    }

    /**
     * Request location Data from Google Maps
     *
     * @returns Array of location data or undefined if request failed
     */
    async sendRequest(): Promise<Array<any> | undefined> {
        if (!this.isValid()) {
            this.log.error('Cannot send request, no cookies available!');
            return;
        }

        //send request with current cookies
        //see https://github.com/costastf/locationsharinglib/blob/master/locationsharinglib/locationsharinglib.py#L105 for info on parameters
        this.log.debug('Sending request with current cookies');
        const url =
            'https://www.google.com/maps/rpc/locationsharing/read?authuser=2&hl=en&gl=us&pb=!1m7!8m6!1m3!1i14!2i8413!3i5385!2i6!3x4095!2m3!1e0!2sm!3i407105169!3m7!2sen!5e1105!12m4!1e68!2m2!1sset!2sRoadmap!4e1!5m4!1e4!8m2!1e0!1e1!6m9!1e12!2i2!26m1!4b1!30m1!1f1.3953487873077393!39b1!44e1!50e0!23i4111425';
        const options = {
            method: 'GET',
            headers: {
                Cookie: this.cookies.map(c => `${c.name}=${c.value}`).join('; '),
            },
            /*params: {
                authuser: 2,
                hl: 'en',
                gl: 'us',
                //pb is place on map. Is irrelevant, set to google head quarters here.
                pb: '!1m7!8m6!1m3!1i14!2i8413!3i5385!2i6!3x4095!2m3!1e0!2sm!3i407105169!3m7!2sen!5e1105!12m4!1e68!2m2!1sset!2sRoadmap!4e1!5m4!1e4!8m2!1e0!1e1!6m9!1e12!2i2!26m1!4b1!30m1!1f1.3953487873077393!39b1!44e1!50e0!23i4111425',
            },*/
        };
        try {
            const response = await fetch(url, options);
            this.log.debug(`Request successful, response code: ${response.status}`);
            if (response.ok) {
                const dataBuffer = await response.text();
                const data = dataBuffer.split('\n').slice(1).join('\n');
                const locationData = JSON.parse(data);
                const locations = locationData[0];
                if (locations && locations.length > 0) {
                    await this.augmentCookieFromHeader(response.headers);
                    return locations;
                }
            }
            this.log.info('No shared locations found in the response, probably not logged in.');
        } catch (e) {
            this.log.error(`Error during request: ${(e as Error).message}`);
        }
    }

    /**
     * Read the cookies from the given page and store them in the states, if they look usable.
     * Closing the browser is up to the caller, use cleanUp() for that.
     *
     * @param page - puppeteer page
     */
    private async storeCookiesFromPage(page: Page): Promise<void> {
        //using deprecated function, but browser.cookies just does not work...???
        const cookies = await page.cookies();
        const browserCookies = await this.browser!.cookies();
        this.log.debug(`Got ${cookies.length} cookies from page, ${browserCookies.length} from browser.cookies().`);

        this.cookies = cookies.filter(c => c.domain.includes('google')); //only keep google cookies, maybe some other cookies are set during login which we do not want to store.
        if (!this.isValid()) {
            this.log.warn('Cookie string seems too short, login probably failed!');
            return;
        }
        this.log.info(`Obtained new cookies from Google login with length ${this.cookies.length}.`);
        await this.storeCookie();
        await this.clearBrowserState();
    }

    /**
     * Refresh the current cookie by using puppeteer to load Google Maps with existing cookie.
     *
     * @param withCookies - if true, will try to set existing cookies in browser before loading page, default is false. This can help if cookies are still valid but not complete enough to work without browser session.
     * @returns true if refresh was successful
     */
    async refreshCookieWithBrowser(withCookies: boolean = false): Promise<boolean> {
        if (this.browser) {
            this.log.info('Seems we are already trying to log in. Aborting new login attempt.');
            return false;
        }

        this.log.debug('Trying to refresh cookie by loading Google Maps with existing cookie in Browser.');
        const page = await this.startBrowser();
        if (!page) {
            this.log.error('Could not start browser for cookie refresh.');
            await this.cleanUp();
            return false;
        }

        if (withCookies) {
            const cookieArray = [...this.cookies];
            // Legacy: this retry comes from a time when we stored broken cookies, so setCookie could fail and
            // dropping the last cookie and trying again was a way to get rid of the bad one. That bug is fixed,
            // so setCookie should succeed on the first run and the loop should break immediately. Kept for
            // backward compatibility with cookies that were stored by an older version. If the error below ever
            // shows up in a log again, something is wrong with our stored cookies and this needs a real look.
            while (cookieArray.length > 0) {
                try {
                    //await page.setCookie(...cookieArray);
                    await this.browser!.setCookie(...cookieArray);
                    break;
                } catch (e) {
                    this.log.error(`Error setting cookies in browser: ${(e as Error).message}, trying again...`);
                    const cookie = cookieArray.pop(); //remove last cookie and try again, maybe some cookies are not valid for puppeteer or something.
                    this.log.debug(`Removed cookie: ${cookie?.name}`);
                }
            }
        }

        try {
            this.log.debug('Loading Google login page to refresh cookie.');
            await page.goto(
                'https://accounts.google.com/ServiceLogin?hl=de&continue=https://www.google.com/maps&gae=cb-eomtm',
                { waitUntil: 'networkidle2', timeout: 60000 },
            );
            this.log.debug(
                'Waiting for page to load, currently waiting fixed 5 seconds, because network never gets idle for maps',
            );
            await new Promise(r => this.adapter.setTimeout(() => r(undefined), 5000));
            if (!page.url().includes('accounts.google.com')) {
                this.log.debug('Browser logged in, refreshing cookie.');
                await this.storeCookiesFromPage(page);
                const results = await this.sendRequest();
                if (results && results.length > 0) {
                    await this.cleanUp();
                    return true;
                }
            }
        } catch (e) {
            this.log.error(
                `Error during cookie refresh: ${(e as Error).message}, ${e instanceof Error ? e.stack : ''}`,
            );
        }
        await this.cleanUp();
        return false;
    }

    /**
     * Login to Google using puppeteer to get new cookies.
     *
     * @param forceLogin - if true, will try to login even if current cookie seems valid, default is false
     */
    async loginToGetNewCookies(forceLogin: boolean = false): Promise<boolean> {
        let currentStep;
        try {
            // try to refresh cookie from browser session first:
            if (!forceLogin) {
                let result = await this.refreshCookieWithBrowser();
                if (result) {
                    this.log.info('Cookie refresh successful, no need to login again.');
                    return true;
                } else if (this.isValid()) {
                    this.log.info('Current cookie seems valid, trying refresh.');
                    result = await this.refreshCookieWithBrowser(true);
                    if (result) {
                        this.log.info('Cookie refresh with existing cookies successful, no need to login again.');
                        return true;
                    }
                }
            }

            if (this.browser) {
                this.log.info('Seems we are already trying to log in. Aborting new login attempt.');
                return false;
            }
            if (!this.username || !this.password) {
                this.log.warn('Google username or password not set in adapter configuration. Can not login.');
                return false;
            }

            this.log.info('Trying to login to Google to get new cookies.');
            //testing puppeteer:
            const page = await this.startBrowser();
            if (!page) {
                this.log.error('Could not start browser for login.');
                await this.cleanUp();
                return false;
            }

            const logDebug = (msg: string): void => {
                currentStep = msg;
                this.log.debug(msg);
            };

            if (forceLogin) {
                logDebug('Force login enabled, clearing cookies and local storage.');
                const cookies = await this.browser!.cookies();
                await this.browser!.deleteCookie(...cookies);
            }

            logDebug('going to google login page.');
            await page.goto(
                'https://accounts.google.com/ServiceLogin?hl=de&continue=https://www.google.com/maps&gae=cb-eomtm',
                {
                    waitUntil: 'networkidle2',
                    timeout: 60000,
                },
            );

            logDebug('waiting for login / maps page to load (fixed 3 seconds timeout)');
            await new Promise(resolve => this.adapter.setTimeout(() => resolve(undefined), 3000));
            if (!page.url().includes('accounts.google.com')) {
                logDebug('Already logged in, refreshing cookie.');
                await this.storeCookiesFromPage(page);
                await this.cleanUp();
                const results = await this.sendRequest();
                if (results && results.length > 0) {
                    this.log.info('Login successful with existing session, no need to fill in credentials.');
                    return true;
                }
            } else {
                try {
                    logDebug('Trying to click on username, if user was logged in before.');
                    const userElement = await page.$(`[data-email="${this.username}"]`);
                    if (userElement) {
                        await userElement.click();
                    } else {
                        logDebug('No user element found, filling in username.');
                        await page.locator('#identifierId').fill(this.username);
                    }
                } catch (e: any) {
                    logDebug(`Ok, no user it seems (${e}). Let's fill in useranme`);
                    logDebug('filling in username.');
                    await page.locator('#identifierId').fill(this.username);
                }

                //is this enough, or do we need to search button in this div?
                logDebug('clicking user next button.');
                await page.locator('#identifierNext').click();
                //waiting for #password fails in headles.. :-(
                logDebug('waiting for network idle before filling password');
                await page.waitForNetworkIdle({ idleTime: 2000 });

                logDebug('filling in password.');
                //do we need to  wait until page is loaded / rendered here?
                await page.locator('input[type="password"]').fill(this.password);
                logDebug('clicking password next button.');
                await page.locator('#passwordNext').click();
                //await page.waitForNetworkIdle({ idleTime: 2000 }); -> does never happen in headless.. :-/
                logDebug(
                    'waiting for page to load after password, currently waiting fixed 3 seconds, because network never gets idle?',
                );
                await new Promise(resolve => this.adapter.setTimeout(() => resolve(undefined), 3000));

                //still on the login page -> Google asks for something else, most likely a 2FA confirmation.
                if (page.url().includes('accounts.google.com')) {
                    logDebug('Still on login page after password, Google seems to want a confirmation.');
                    const timeout = this.adapter.config.challengeTimeout ?? DEFAULT_CHALLENGE_TIMEOUT_SECONDS;
                    if (timeout > 0) {
                        await this.waitForLoginChallenge(page, timeout);
                    } else {
                        //waiting disabled, but still publish what Google wants, so the user can see it in the log.
                        await this.captureBrowserState(page, 'Google wants an additional confirmation');
                        this.log.warn(
                            'Google wants an additional confirmation, but waiting is disabled (challengeTimeout = 0). ' +
                                'See state info.loginPageText / info.loginScreenshot.',
                        );
                    }
                }

                logDebug('navigating to google maps to load right cookies.');
                await page.goto('https://www.google.com/maps');
                logDebug('getting cookies.');
                await this.storeCookiesFromPage(page);
                await this.cleanUp();
                const results = await this.sendRequest();
                if (results && results.length > 0) {
                    this.log.info('Login successful with existing session, no need to fill in credentials.');
                    return true;
                }
            }
        } catch (e) {
            this.log.error(`Error in puppeteer: ${(e as Error).message}`);
            this.log.error(`The step puppeteer failed was: ${currentStep}`);
            //publish what the browser was showing, that is usually the only way to see why the login got stuck
            try {
                const pages = await this.browser?.pages();
                if (pages?.length) {
                    await this.captureBrowserState(pages[0], `Login failed at step: ${currentStep}`);
                }
            } catch {
                /* ignore, we are in the error path already */
            }
            // try to close browser if open
            await this.cleanUp();
        }
        // ok, somehow everything failed -> see if we can retry:
        if (!forceLogin && this.username && this.password) {
            this.log.info('Retrying to login with user & password.');
            return this.loginToGetNewCookies(true);
        }
        return false;
    }

    /**
     * Clean up on unload.
     */
    async cleanUp(): Promise<void> {
        try {
            if (this.browser) {
                await this.browser.close();
                this.browser = null;
            }
        } catch (e) {
            this.log.error(`Error closing browser: ${(e as Error).message} - ${e instanceof Error ? e.stack : ''}`);
        }
    }

    /**
     * Check if the current cookie is valid.
     */
    isValid(): boolean {
        // we can not really check if cookie is valid without sending a request, but if the cookie string is very short, it is probably not valid.
        // maybe change that to some check against the array length in future?
        return this.cookies.map(c => `${c.name}=${c.value}`).join('; ').length > 50;
    }
}
