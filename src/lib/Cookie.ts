import axios from 'axios';
import type { GoogleSharedlocations2 } from '../main';
import puppeteer from 'puppeteer';
import type { Browser, Page } from 'puppeteer';
import { stat, mkdir } from 'fs/promises';

/**
 * Helper class to manage Google cookies.
 */
export class Cookie {
    currentCookie: string;
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
        this.currentCookie = '';
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
        try {
            //ensure data dir exists
            await mkdir(this.dataDir, { recursive: true }); //recursive true should prevent error if already exists.
            const state = await this.adapter.getStateAsync('info.currentCookies');
            if (state && state.val && typeof state.val === 'string') {
                this.currentCookie = state.val;
                this.log?.debug('Loaded cookie from state.');
            } else {
                this.currentCookie = '';
                this.log?.debug('No cookie found in state, trying to log in to get new one.');
                await this.loginToGetNewCookies();
            }
        } catch (err: any) {
            this.log?.error(`Error loading cookie from state: ${err}`);
        }
    }

    /**
     * Store the current cookie in an iobroker state.
     */
    async storeCookie(): Promise<void> {
        try {
            await this.adapter.setStateAsync('info.currentCookies', this.currentCookie, true);
        } catch (err: any) {
            this.log?.error(`Error storing cookie: ${err}`);
        }
    }

    /**
     * Augment the current cookie with data from the 'set-cookie' header.
     *
     * @param headers - HTTP headers of axios response
     */
    async augmentCookieFromHeader(headers: Record<string, any>): Promise<void> {
        if (headers['set-cookie'] && headers['set-cookie'].length) {
            this.log?.debug('New header received.');
            const oldLength = this.currentCookie.length;
            const cookies = this.currentCookie.split('; ').map(c => c.split('='));

            //split old cookie and new cookie. Update single values.
            for (const header of headers['set-cookie']) {
                const incomingCookies = header.split('; ');
                for (const cookie of incomingCookies) {
                    const [name, value] = cookie.split('=');
                    const cIndex = cookies.findIndex(c => c[0] === name);
                    if (cIndex < 0) {
                        cookies.push([name, value]); //add
                    } else {
                        cookies[cIndex][1] = value; //update
                    }
                }
            }

            this.currentCookie = cookies.map(cv => cv.join('=')).join('; ');
            this.log?.debug(`Cookie updated. Length: ${oldLength} -> ${this.currentCookie.length}`);
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
                Cookie: this.currentCookie,
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
                Cookie: this.currentCookie,
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
                return locations;
            } else {
                this.log.info('No shared locations found in the response, probably not logged in.');
            }
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

        this.currentCookie = cookies
            .filter(c => c.domain.includes('google'))
            .map(c => `${c.name}=${c.value}`)
            .join('; ');
        await this.browser!.close();
        if (this.currentCookie.length < 50) {
            this.log.warn('Cookie string seems too short, login probably failed!');
        } else {
            this.log.info('Obtained new cookies from Google login.');
            await this.storeCookie();
        }
        this.browser = null;
    }

    /**
     * Refresh the current cookie by using puppeteer to load Google Maps with existing cookie.
     *
     * @returns true if refresh was successful
     */
    private async refreshCookie(): Promise<boolean> {
        if (this.browser) {
            this.log.info('Seems we are already trying to log in. Aborting new login attempt.');
            return false;
        }

        const page = await this.startBrowser();
        if (!page) {
            this.log.error('Could not start browser for cookie refresh.');
            return false;
        }

        const cookieArray = this.currentCookie
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
        await page.setCookie(...cookieArray);

        await page.goto('https://www.google.com/maps', { waitUntil: 'networkidle2', timeout: 60000 });
        await new Promise(r => setTimeout(r, 5000));

        try {
            await this.sendRequest();
            await this.getCookiesFromPage(page);
            return true;
        } catch (e) {
            this.log.error(`Error during cookie refresh: ${(e as Error).message}`);
            return false;
        }
    }

    /**
     * Login to Google using puppeteer to get new cookies.
     */
    async loginToGetNewCookies(): Promise<boolean> {
        try {
            if (this.currentCookie && this.currentCookie.length >= 50) {
                this.log.info('Current cookie seems valid, trying refresh.');
                await this.refreshCookie();
                if (this.currentCookie && this.currentCookie.length >= 50) {
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

            this.log.debug('going to google login page.');
            await page.goto(
                'https://accounts.google.com/ServiceLogin?hl=de&continue=https://www.google.com/maps&gae=cb-eomtm',
                {
                    waitUntil: 'networkidle2',
                    timeout: 60000,
                },
            );

            this.log.debug('filling in username and clicking next.');
            await page.locator('#identifierId').fill(this.username);
            //is this enough, or do we need to search button in this div?
            await page.locator('#identifierNext').click();
            //waiting for #password fails in headles.. :-(
            await page.waitForNetworkIdle({ idleTime: 2000 });

            this.log.debug('filling in password and clicking next.');
            //do we need to  wait until page is loaded / rendered here?
            await page.locator('input[type="password"]').fill(this.password);
            this.log.debug('clicking password next button.');
            await page.locator('#passwordNext').click();
            //await page.waitForNetworkIdle({ idleTime: 2000 }); -> does never happen in headless.. :-/
            await new Promise(resolve => setTimeout(resolve, 3000));

            await page.goto('https://www.google.com/maps');
            this.log.debug('getting cookies.');
            await this.getCookiesFromPage(page);
            return true;
        } catch (e) {
            this.log.error(`Error in puppeteer: ${(e as Error).message}`);
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
        return this.currentCookie.length > 50;
    }
}
