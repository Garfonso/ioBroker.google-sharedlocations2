import axios from 'axios';
import type { GoogleSharedlocations2 } from '../main';
import puppeteer from 'puppeteer';
import type { Browser, Page, CookieData } from 'puppeteer';
import { mkdir } from 'fs/promises';

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
     * @param headers - HTTP headers of axios response
     */
    async augmentCookieFromHeader(headers: Record<string, any>): Promise<void> {
        if (headers['set-cookie'] && headers['set-cookie'].length) {
            this.log?.debug('New header received.');
            const oldLength = this.cookies.length;

            //split old cookie and new cookie. Update single values.
            for (const header of headers['set-cookie']) {
                //console.log('Processing header cookie:', header);
                const keyValues = header.split('; ');
                const [name, value] = keyValues.shift().split('='); // first part is cookie, rest are attributes like path, secure etc.
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
                            cookie.sameSite = v ? v.trim() : 'Lax';
                            break;
                        case 'expires':
                            cookie.expires = new Date(v).getTime() / 1000; //puppeteer expects expires in seconds, not milliseconds
                            break;
                        case 'priority':
                            cookie.priority = v ? v.trim() : 'Medium';
                            break;
                        default:
                            this.log.debug(`Unknown cookie attribute: ${k}=${v}`);
                    }
                }
                const cIndex = this.cookies.findIndex(c => c.name === name);
                if (cIndex < 0) {
                    this.log.debug(`Adding new cookie from header: ${cookie.name}=${cookie.value}`);
                    this.cookies.push(cookie); //add
                } else {
                    this.log.debug(`Updating cookie from header: ${cookie.name}=${cookie.value}`);
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
        //see https://github.com/costastf/locationsharinglib/blob/master/locationsharinglib/locationsharinglib.py#L105
        const options = {
            url: 'https://myaccount.google.com/?hl=en',
            headers: {
                Cookie: this.cookies.map(c => `${c.name}=${c.value}`).join('; '),
            },
            method: 'get',
        };

        try {
            const response = await axios(options);

            if (response.status !== 200) {
                this.log?.error(`Failed improving cookie: ${response.status}`);
                return false;
            }
            await this.augmentCookieFromHeader(response.headers);
            return true;
        } catch (err: any) {
            this.log?.error(err);
            this.log?.info('Connection to google maps failure.');
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
        this.browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
            ignoreDefaultArgs: ['--enable-automation'], //h// ide automation flag, did not help.
            userDataDir: this.dataDir,
        });
        this.log.debug('browser started, opening new page.');
        const page = await this.browser.newPage();
        //hide puppeteer automation flag
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
        });
        await page.setUserAgent({
            userAgent:
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        });

        return page;
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
        this.log.debug('Sending request with current cookies');
        const options = {
            method: 'GET',
            url: 'https://www.google.com/maps/rpc/locationsharing/read',
            headers: {
                Cookie: this.cookies.map(c => `${c.name}=${c.value}`).join('; '),
            },
            params: {
                authuser: 2,
                hl: 'en',
                gl: 'us',
                //pb is place on map. Is irrelevant, set to google head quarters here.
                pb: '!1m7!8m6!1m3!1i14!2i8413!3i5385!2i6!3x4095!2m3!1e0!2sm!3i407105169!3m7!2sen!5e1105!12m4!1e68!2m2!1sset!2sRoadmap!4e1!5m4!1e4!8m2!1e0!1e1!6m9!1e12!2i2!26m1!4b1!30m1!1f1.3953487873077393!39b1!44e1!50e0!23i4111425',
            },
        };

        try {
            const response = await axios.request(options);
            this.log.debug(`Request successful, response code: ${response.status}`);
            const data = response.data.split('\n').slice(1).join('\n');
            const locationData = JSON.parse(data);
            const locations = locationData[0];
            if (locations && locations.length > 0) {
                await this.augmentCookieFromHeader(response.headers);
                return locations;
            }
            this.log.info('No shared locations found in the response, probably not logged in.');
        } catch (e) {
            this.log.error(`Error during request: ${(e as Error).message}`);
        }
    }

    /**
     * Get cookies from the given page and store them. Also closes Browser.
     *
     * @param page - puppeteer page
     */
    private async getCookiesFromPage(page: Page): Promise<void> {
        //using deprecated function, but browser.cookies just does not work...???
        const cookies = await page.cookies();
        const browserCookies = await this.browser!.cookies();
        this.log.debug(`Got ${cookies.length} cookies from page, ${browserCookies.length} from browser.cookies().`);

        this.cookies = cookies.filter(c => c.domain.includes('google')); //only keep google cookies, maybe some other cookies are set during login which we do not want to store.
        await this.browser!.close();
        if (!this.isValid()) {
            this.log.warn('Cookie string seems too short, login probably failed!');
        } else {
            this.log.info(`Obtained new cookies from Google login with length ${this.cookies.length}.`);
            this.cookies = cookies;
            await this.storeCookie();
        }
        this.browser = null;
    }

    /**
     * Refresh the current cookie by using puppeteer to load Google Maps with existing cookie.
     *
     * @returns true if refresh was successful
     */
    async refreshCookieWithBrowser(): Promise<boolean> {
        if (this.browser) {
            this.log.info('Seems we are already trying to log in. Aborting new login attempt.');
            return false;
        }

        this.log.debug('Trying to refresh cookie by loading Google Maps with existing cookie in Browser.');
        const page = await this.startBrowser();
        if (!page) {
            this.log.error('Could not start browser for cookie refresh.');
            return false;
        }

        const cookieArray = [...this.cookies];
        // somehow we stored wrong cookies... :-/ Try to clean up here.
        while (cookieArray.length > 0) {
            try {
                //await page.setCookie(...cookieArray);
                await this.browser!.setCookie(...cookieArray);
                break;
            } catch (e) {
                this.log.error(`Error setting cookies in browser: ${(e as Error).message}, trying again...`);
                const cookie = cookieArray.pop(); //remove last cookie and try again, maybe some cookies are not valid for puppeteer or something.
                console.log('Removed cookie:', cookie);
            }
        }

        try {
            await page.goto('https://www.google.com/maps', { waitUntil: 'networkidle2', timeout: 60000 });
            await new Promise(r => setTimeout(r, 5000));

            await this.sendRequest();
            await this.getCookiesFromPage(page);
            return true;
        } catch (e) {
            this.log.error(
                `Error during cookie refresh: ${(e as Error).message}, ${e instanceof Error ? e.stack : ''}`,
            );
            return false;
        }
    }

    /**
     * Login to Google using puppeteer to get new cookies.
     */
    async loginToGetNewCookies(): Promise<boolean> {
        let currentStep;
        try {
            if (this.isValid()) {
                this.log.info('Current cookie seems valid, trying refresh.');
                await this.refreshCookieWithBrowser();
                if (this.isValid()) {
                    this.log.info('Cookie refresh successful, no need to login again.');
                    return true;
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
                return false;
            }

            const logDebug = (msg: string): void => {
                currentStep = msg;
                this.log.debug(msg);
            };
            logDebug('going to google login page.');
            await page.goto(
                'https://accounts.google.com/ServiceLogin?hl=de&continue=https://www.google.com/maps&gae=cb-eomtm',
                {
                    waitUntil: 'networkidle2',
                    timeout: 60000,
                },
            );

            logDebug('waiting for login / maps page to load (fixed 3 seconds timeout)');
            await new Promise(resolve => setTimeout(resolve, 3000));
            if (!page.url().includes('accounts.google.com')) {
                logDebug('Already logged in, refreshing cookie.');
                await this.getCookiesFromPage(page);
                return true;
            }

            logDebug('filling in username.');
            await page.locator('#identifierId').fill(this.username);
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
            await new Promise(resolve => setTimeout(resolve, 3000));

            logDebug('navigating to google maps to load right cookies.');
            await page.goto('https://www.google.com/maps');
            logDebug('getting cookies.');
            await this.getCookiesFromPage(page);
            return true;
        } catch (e) {
            this.log.error(`Error in puppeteer: ${(e as Error).message}`);
            this.log.error(`The step puppeteer failed was: ${currentStep}`);
            // try to close browser if open
            if (this.browser) {
                try {
                    await this.browser.close();
                } catch {
                    /* ignore */
                }
            }
            this.browser = null;
        }
        return false;
    }

    /**
     * Clean up on unload.
     */
    async cleanUp(): Promise<void> {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
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
