/*
 * Created with @iobroker/create-adapter v3.1.2
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
import * as utils from '@iobroker/adapter-core';

import puppeteer, { type Browser } from 'puppeteer';
import axios from 'axios';

//used to test timeout against
const MAX_INT32 = 2 ** 31 - 1; // 2147483647 (hex 0x7FFFFFFF)

// Load your modules here, e.g.:
// import * as fs from 'fs';

class GoogleSharedlocations2 extends utils.Adapter {
    _cookies: string | null = null;
    _pollTimeout: ioBroker.Timeout | undefined;
    _pollInterval: number = 300;
    _successFullPolls: number = 1; // let us try a relogin at start, if cookie does not work.
    _browser: Browser | null = null;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({
            ...options,
            name: 'google-sharedlocations2',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        // this.on('objectChange', this.onObjectChange.bind(this));
        // this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    private async onReady(): Promise<void> {
        // Initialize your adapter here

        // Reset the connection indicator during startup
        await this.setState('info.connection', false, true);
        this._cookies = ((await this.getStateAsync('info.currentCookies'))?.val as string) || null;
        if (!this._cookies) {
            if (!this.config.googleUsername || !this.config.googlePassword) {
                this.log.error('Google username or password not set in adapter configuration!');
                return;
            }
            await this.loginToGetNewCookies();
        }

        await this.subscribeStatesAsync('info.currentCookies');

        //sanitize polling interval:
        this._pollInterval = this.config.pollInterval;
        if (!this._pollInterval) {
            this._pollInterval = 300;
        }
        if (this._pollInterval < 60) {
            this._pollInterval = 60;
        }
        if (this._pollInterval > MAX_INT32) {
            this._pollInterval = MAX_INT32;
        }

        //start polling positions
        await this.pollPositions();
        if (this._cookies) {
            await this.sendRequest();
        }
    }

    private async pollPositions() {
        this._pollTimeout = this.setTimeout(async () => {
            if (!this._cookies) {
                this.log.debug('Cannot poll positions, no cookies available!');
            } else {
                this.log.debug('Polling positions with current cookies.');
                await this.sendRequest();
            }
            //schedule next poll
            return this.pollPositions();
        }, this._pollInterval * 1000);
    }

    private async sendRequest() {
        if (!this._cookies) {
            this.log.error('Cannot send request, no cookies available!');
            await this.setState('info.connection', false, true);
            return;
        }

        //send request with current cookies
        this.log.debug('Sending request with current cookies');
        const options = {
            method: 'GET',
            url: "https://www.google.com/maps/rpc/locationsharing/read",
            headers: {
                'Cookie': this._cookies,
            },
            params: {
                "authuser": 2,
                "hl": "en",
                "gl": "us",
                //pb is place on map. Is irrelevant, set to google head quarters here.
                "pb": "!1m7!8m6!1m3!1i14!2i8413!3i5385!2i6!3x4095!2m3!1e0!2sm!3i407105169!3m7!2sen!5e1105!12m4!1e68!2m2!1sset!2sRoadmap!4e1!5m4!1e4!8m2!1e0!1e1!6m9!1e12!2i2!26m1!4b1!30m1!1f1.3953487873077393!39b1!44e1!50e0!23i4111425"
            }
        };

        try {
            const response = await axios.request(options);
            this.log.debug('Request successful, response code: ' + response.status);
            const data = response.data.split('\n').slice(1).join('\n');
            const locationData = JSON.parse(data);
            const locations = locationData[0];
            if (locations && locations.length > 0) {
                this._successFullPolls += 1;
                await this.setState('info.connection', true, true);
                for (const location of locations) {
                    await this.fillIntoObjects(location);
                }
            } else {
                this.log.info('No shared locations found in the response, probably not logged in.');
                if (this._successFullPolls > 0) {
                    //try to get new cookie:
                    await this.loginToGetNewCookies();
                }
            }
        } catch (e) {
            this.log.error('Error during request: ' + (e as Error).message);
            if (this._successFullPolls > 0) {
                //try to get new cookie:
                await this.loginToGetNewCookies();
            }
        }
    }

    private async fillIntoObjects(locationData: any) {
        try {
            const user = {
                id: undefined,
                photoURL: undefined,
                name: undefined,
                lat: undefined,
                long: undefined,
                address: undefined,
                battery: undefined,
                timestamp: undefined,
                accuracy: undefined
            };

            if(locationData && Array.isArray(locationData)) {
                // locationData present
                if(locationData[0] && locationData[0][0]) user['id'] = locationData[0][0];
                if(locationData[0] && locationData[0][1]) user['photoURL'] = locationData[0][1];
                if(locationData[0] && locationData[0][3]) user['name'] = locationData[0][3];
                if(locationData[1] && locationData[1][1] && locationData[1][1][2]) user['lat'] = locationData[1][1][2];
                if(locationData[1] && locationData[1][1] && locationData[1][1][1]) user['long'] = locationData[1][1][1];
                if(locationData[1] && locationData[1][4]) user['address'] = locationData[1][4];
                if(locationData[13] && locationData[13][1]) user['battery'] = locationData[13][1];
                if(locationData[1] && locationData[1][2]) user['timestamp'] = locationData[1][2];
                if(locationData[1] && locationData[1][3]) user['accuracy'] = locationData[1][3];
            }

            if (user.id) {
                const basepath = `users.${user.id}`;
                const deviceObj = {
                    _id: basepath,
                    type: 'device',
                    common: {
                        name: user.name || user.id,
                    },
                    native: {}
                };
                await this.setObjectNotExistsAsync(basepath, deviceObj as ioBroker.SettableDeviceObject);

                if (user.photoURL) {
                    await this.setObjectNotExistsAsync(`${basepath}.photoURL`, {
                        type: 'state',
                        common: {
                            name: 'Photo URL',
                            type: 'string',
                            read: true,
                            write: false,
                            role: 'text.url',
                        },
                        native: {},
                    });
                    await this.setState(`${basepath}.photoURL`, {val: user.photoURL, ts: user.timestamp, ack: true});
                }

                if (user.name) {
                    await this.setObjectNotExistsAsync(`${basepath}.name`, {
                        type: 'state',
                        common: {
                            name: 'Name',
                            type: 'string',
                            read: true,
                            write: false,
                            role: 'text',
                        },
                        native: {},
                    });
                    await this.setState(`${basepath}.name`, {val: user.name, ts: user.timestamp, ack: true});
                }

                if (user.lat) {
                    await this.setObjectNotExistsAsync(`${basepath}.lat`, {
                        type: 'state',
                        common: {
                            name: 'Latitude',
                            type: 'number',
                            read: true,
                            write: false,
                            role: 'value.gps.latitude',
                        },
                        native: {},
                    });
                    await this.setState(`${basepath}.lat`, {val: user.lat, ts: user.timestamp, ack: true});
                }

                if (user.long) {
                    await this.setObjectNotExistsAsync(`${basepath}.long`, {
                        type: 'state',
                        common: {
                            name: 'Longitude',
                            type: 'number',
                            read: true,
                            write: false,
                            role: 'value.gps.longitude',
                        },
                        native: {},
                    });
                    await this.setState(`${basepath}.long`, { val: user.long, ts: user.timestamp, ack: true});
                }

                if (user.address) {
                    await this.setObjectNotExistsAsync(`${basepath}.address`, {
                        type: 'state',
                        common: {
                            name: 'Address',
                            type: 'string',
                            read: true,
                            write: false,
                            role: 'text',
                        },
                        native: {},
                    });
                    await this.setState(`${basepath}.address`, { val: user.address, ts: user.timestamp, ack: true});
                }

                if (user.battery !== undefined) {
                    await this.setObjectNotExistsAsync(`${basepath}.battery`, {
                        type: 'state',
                        common: {
                            name: 'Battery Level',
                            type: 'number',
                            read: true,
                            write: false,
                            role: 'value.battery',
                            unit: '%'
                        },
                        native: {},
                    });
                    await this.setState(`${basepath}.battery`, { val: user.battery, ts: user.timestamp, ack: true});
                }

                if (user.accuracy !== undefined) {
                    await this.setObjectNotExistsAsync(`${basepath}.accuracy`, {
                        type: 'state',
                        common: {
                            name: 'Accuracy',
                            type: 'number',
                            read: true,
                            write: false,
                            role: 'value.gps.accuracy',
                            unit: 'm'
                        },
                        native: {},
                    });
                    await this.setState(`${basepath}.accuracy`, { val: user.accuracy, ts: user.timestamp, ack: true});
                }
            }
        } catch (e) {
            this.log.error('Could not parse user location data: ' + (e as Error).message);
        }
    }

    private async loginToGetNewCookies(): Promise<void> {
        try {
            if (this._browser) {
                this.log.info('Seems we are already trying to log in. Aborting new login attempt.');
                return;
            }
            this.log.info('Trying to login to Google to get new cookies.');
            this._successFullPolls = 0;

            //testing puppeteer:
            this.log.debug('Starting browser.');
            this._browser = await puppeteer.launch({
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-blink-features=AutomationControlled'
                ],
                ignoreDefaultArgs: ['--enable-automation'] //hide automation flag, did not help.
            });
            this.log.debug('browser started, opening new page.');
            const page = await this._browser.newPage();

            //hide puppeteer automation flag
            await page.evaluateOnNewDocument(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => false });
            });
            await page.setUserAgent({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' });

            this.log.debug('going to google login page.');
            await page.goto('https://accounts.google.com/ServiceLogin?hl=de&continue=https://www.google.com/maps&gae=cb-eomtm', {
                waitUntil: 'networkidle2',
                timeout: 60000
            });

            this.log.debug('filling in username and clicking next.');
            await page.locator('#identifierId').fill(this.config.googleUsername);
            //is this enough, or do we need to search button in this div?
            await page.locator('#identifierNext').click();
            //waiting for #password fails in headles.. :-(
            await page.waitForNetworkIdle({ idleTime: 2000 });

            this.log.debug('filling in password and clicking next.');
            //do we need to  wait until page is loaded / rendered here?
            await page.locator('input[type="password"]').fill(this.config.googlePassword);
            this.log.debug('clicking password next button.');
            await page.locator('#passwordNext').click();
            //await page.waitForNetworkIdle({ idleTime: 2000 }); -> does never happen in headless.. :-/
            await new Promise(resolve => setTimeout(resolve, 3000));

            await page.goto('https://www.google.com/maps');
            this.log.debug('getting cookies.');
            //using deprecated function, but browser.cookies just does not work...???
            const cookies = await page.cookies();

            this._cookies = cookies
                .filter(c => c.domain.includes('google'))
                .map(c => `${c.name}=${c.value}`)
                .join('; ');
            //this.log.debug(this._cookies);
            //console.log(this._cookies);
            await this._browser.close();
            if (this._cookies.length < 50) {
                this.log.warn('Cookie string seems too short, login probably failed!');
            } else {
                this.log.info('Obtained new cookies from Google login.');
                await this.setState('info.currentCookies', { val: this._cookies, ack: true });
            }
            this._browser = null;
        } catch (e) {
            this.log.error('Error in puppeteer: ' + (e as Error).message);
        }
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     *
     * @param callback - Callback function
     */
    private onUnload(callback: () => void): void {
        try {
            // Here you must clear all timeouts or intervals that may still be active
            // clearTimeout(timeout1);
            // clearTimeout(timeout2);
            // ...
            // clearInterval(interval1);
            if (this._pollTimeout) {
                clearTimeout(this._pollTimeout);
            }
            if (this._browser) {
                //ignore results here.
                this._browser.close().then(() => {}).catch(() => {});
            }
            callback();
        } catch (error) {
            this.log.error(`Error during unloading: ${(error as Error).message}`);
            callback();
        }
    }

    // If you need to react to object changes, uncomment the following block and the corresponding line in the constructor.
    // You also need to subscribe to the objects with `this.subscribeObjects`, similar to `this.subscribeStates`.
    // /**
    //  * Is called if a subscribed object changes
    //  */
    // private onObjectChange(id: string, obj: ioBroker.Object | null | undefined): void {
    //     if (obj) {
    //         // The object was changed
    //         this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
    //     } else {
    //         // The object was deleted
    //         this.log.info(`object ${id} deleted`);
    //     }
    // }

    /**
     * Is called if a subscribed state changes
     *
     * @param id - State ID
     * @param state - State object
     */
    private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        if (id.endsWith('info.currentCookies') && state && !state.ack) {
            if (state.val === '') {
                this.log.info('Current cookies state was cleared, trying to obtain new cookies.');
                this._cookies = null;
                await this.loginToGetNewCookies();
                if (this._cookies) {
                    await this.sendRequest();
                }
            } else {
                this.log.info('Current cookies state was changed from outside the adapter, updating internal cookie store.');
                this._cookies = state.val as string;
            }
        }
    }
    // If you need to accept messages in your adapter, uncomment the following block and the corresponding line in the constructor.
    // /**
    //  * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
    //  * Using this method requires "common.messagebox" property to be set to true in io-package.json
    //  */
    //
    // private onMessage(obj: ioBroker.Message): void {
    //     if (typeof obj === 'object' && obj.message) {
    //         if (obj.command === 'send') {
    //             // e.g. send email or pushover or whatever
    //             this.log.info('send command');
    //             // Send response in callback if required
    //             if (obj.callback) this.sendTo(obj.from, obj.command, 'Message received', obj.callback);
    //         }
    //     }
    // }
}
//if (require.main !== module) {
    // Export the constructor in compact mode
    //module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new GoogleSharedlocations2(options);
//} else {
    // otherwise start the instance directly
    (() => new GoogleSharedlocations2())();
//}
