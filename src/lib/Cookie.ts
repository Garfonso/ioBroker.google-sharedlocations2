import axios from 'axios';
import type { GoogleSharedlocations2 } from '../main';
import puppeteer from 'puppeteer';
import type { Browser } from 'puppeteer';

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

    /**
     * Construct cookie helper
     *
     * @param adapter - adapter instance
     */
    constructor(adapter: GoogleSharedlocations2) {
        this.currentCookie = '';
        this.username = '';
        this.password = '';
        this.adapter = adapter;
        this.log = adapter.log;
    }

    /**
     * Initialize the cookie helper by loading the cookie from state.
     */
    async init(): Promise<void> {
        this.username = this.adapter.config.googleUsername;
        this.password = this.adapter.config.googlePassword;
        try {
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
    async improveCookie(): Promise<void> {
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
            } else {
                await this.augmentCookieFromHeader(response.headers);
            }
        } catch (err: any) {
            this.log?.error(err);
            this.log?.info('Connection to google maps failure.');
        }
    }

    /**
     * Login to Google using puppeteer to get new cookies.
     */
    async loginToGetNewCookies(): Promise<boolean> {
        try {
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
            this.log.debug('Starting browser.');
            this.browser = await puppeteer.launch({
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
                ignoreDefaultArgs: ['--enable-automation'], //hide automation flag, did not help.
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
            //using deprecated function, but browser.cookies just does not work...???
            const cookies = await page.cookies();

            this.currentCookie = cookies
                .filter(c => c.domain.includes('google'))
                .map(c => `${c.name}=${c.value}`)
                .join('; ');
            //this.log.debug(this._cookies);
            //console.log(this._cookies);
            await this.browser.close();
            if (this.currentCookie.length < 50) {
                this.log.warn('Cookie string seems too short, login probably failed!');
            } else {
                this.log.info('Obtained new cookies from Google login.');
                await this.storeCookie();
            }
            this.browser = null;
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
