/*
 * Created with @iobroker/create-adapter v3.1.2
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
import * as utils from '@iobroker/adapter-core';

import { User } from './lib/User';
import { Fence } from './lib/Fence';
import { Cookie } from './lib/Cookie';

//used to test timeout against
const MAX_INT32 = 2 ** 31 - 1; // 2147483647 (hex 0x7FFFFFFF)

// Load your modules here, e.g.:
// import * as fs from 'fs';

/**
 * The adapter class
 */
export class GoogleSharedlocations2 extends utils.Adapter {
    _pollTimeout: ioBroker.Timeout | undefined;
    _pollInterval: number = 300;
    _successFullPolls: number = 1; // let us try a relogin at start, if cookie does not work.
    _users: Record<string, User> = {};
    fences: Fence[] = [];
    cookie: Cookie;

    /**
     * Creates an instance of the adapter.
     *
     * @param options - adapter options
     */
    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({
            ...options,
            name: 'google-sharedlocations2',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        // this.on('objectChange', this.onObjectChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
        this.cookie = new Cookie(this, utils.getAbsoluteInstanceDataDir(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    private async onReady(): Promise<void> {
        // Initialize your adapter here

        // Reset the connection indicator during startup
        await this.setState('info.connection', false, true);
        await this.cookie.init();
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

        //read fences:
        for (const fenceConfig of this.config.fences || []) {
            const fence = new Fence(
                fenceConfig.name,
                fenceConfig.latitude,
                fenceConfig.longitude,
                fenceConfig.radius,
                fenceConfig.user,
                fenceConfig.fenceId,
            );
            if (fence.valid) {
                this.fences.push(fence);
                await this.setObjectNotExistsAsync(`fences.${fence.fenceId}`, {
                    type: 'state',
                    common: {
                        name: `${fence.name}`,
                        type: 'boolean',
                        read: true,
                        write: false,
                        role: 'sensor',
                    },
                    native: {},
                });
            } else {
                this.log.warn(`Fence ${fenceConfig.name} is not valid and will be ignored.`);
            }
        }
        //clear old fences:
        const adapterObjects = await this.getAdapterObjectsAsync();
        for (const objId of Object.keys(adapterObjects)) {
            if (objId.startsWith(`${this.namespace}.fences.`) || objId.startsWith('fences.')) {
                const fenceId = objId.split('.').pop() || '';
                const found = this.fences.find(f => f.fenceId === fenceId);
                if (!found) {
                    this.log.info(`Deleting old fence state ${objId} as it is not in configuration anymore.`);
                    await this.delObjectAsync(objId);
                }
            }
        }

        //start polling positions
        this.pollPositions();
        if (this.cookie.isValid()) {
            await this.sendRequest();
        }
    }

    private pollPositions(): void {
        this._pollTimeout = this.setTimeout(async () => {
            if (!this.cookie.isValid()) {
                this.log.debug('Cannot poll positions, no cookies available!');
            } else {
                this.log.debug('Polling positions with current cookies.');
                const lastSuccessPolls = this._successFullPolls;
                await this.sendRequest();
                if (this._successFullPolls > 0 && lastSuccessPolls !== this._successFullPolls) {
                    if (this._successFullPolls % 10 === 0) {
                        //try to get some more headers from google:
                        await this.cookie.improveCookie();
                    }
                }
            }
            //schedule next poll
            return this.pollPositions();
        }, this._pollInterval * 1000);
    }

    private async sendRequest(): Promise<void> {
        const results = await this.cookie.sendRequest();
        if (!results) {
            await this.setState('info.connection', false, true);
            if (this._successFullPolls > 0) {
                //try to get new cookie:
                this._successFullPolls = 0;
                await this.cookie.loginToGetNewCookies();
            }
        } else {
            this._successFullPolls += 1;
            await this.setState('info.connection', true, true);
            for (const location of results) {
                const user = new User(location);
                if (user.id) {
                    const oldTS = this._users[user.id]?.timestamp || 0;
                    this._users[user.id] = user; // should I try to merge stuff here? Or is it always completely filled?
                    if (user.timestamp && user.timestamp <= oldTS) {
                        this.log.debug(`Ignoring older or same location data for user ${user.id}`);
                        continue;
                    }
                    await this.fillIntoObjects(user);
                    await this.notifyPlaces(user);
                    await this.checkFences(user);
                }
            }
        }
    }

    private async fillIntoObjects(user: User): Promise<void> {
        try {
            if (user.id) {
                const basepath = `users.${user.id}`;
                const deviceObj = {
                    _id: basepath,
                    type: 'device',
                    common: {
                        name: user.name || user.id,
                    },
                    native: {},
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
                    await this.setState(`${basepath}.photoURL`, { val: user.photoURL, ts: user.timestamp, ack: true });
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
                    await this.setState(`${basepath}.name`, { val: user.name, ts: user.timestamp, ack: true });
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
                    await this.setState(`${basepath}.lat`, { val: user.lat, ts: user.timestamp, ack: true });
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
                    await this.setState(`${basepath}.long`, { val: user.long, ts: user.timestamp, ack: true });
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
                    await this.setState(`${basepath}.address`, { val: user.address, ts: user.timestamp, ack: true });
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
                            unit: '%',
                        },
                        native: {},
                    });
                    await this.setState(`${basepath}.battery`, { val: user.battery, ts: user.timestamp, ack: true });
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
                            unit: 'm',
                        },
                        native: {},
                    });
                    await this.setState(`${basepath}.accuracy`, { val: user.accuracy, ts: user.timestamp, ack: true });
                }
            }
        } catch (e) {
            this.log.error(`Could not parse user location data: ${(e as Error).message}`);
        }
    }

    private async notifyPlaces(user: User): Promise<void> {
        if (this.config.placesInstance && user.id && user.lat && user.long) {
            await this.sendToAsync(this.config.placesInstance, {
                user: user.name,
                latitude: user.lat,
                longitude: user.long,
                timestamp: user.timestamp || Date.now(),
                address: user.address,
            });
        }
    }

    private async checkFences(user: User): Promise<void> {
        for (const fence of this.fences) {
            if (fence.valid && fence.user === user.id) {
                const inside = fence.isInsideFence(user);
                await this.setStateChangedAsync(`fences.${fence.fenceId}`, {
                    val: inside,
                    ts: user.timestamp,
                    ack: true,
                });
            }
        }
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     *
     * @param callback - Callback function
     */
    private async onUnload(callback: () => void): Promise<void> {
        try {
            // Here you must clear all timeouts or intervals that may still be active
            // clearTimeout(timeout1);
            // clearTimeout(timeout2);
            // ...
            // clearInterval(interval1);
            if (this._pollTimeout) {
                clearTimeout(this._pollTimeout);
            }
            await this.cookie.cleanUp();
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
                this._successFullPolls = 0;
                this.cookie.currentCookie = '';
                await this.cookie.loginToGetNewCookies();
            } else {
                this.log.info(
                    'Current cookies state was changed from outside the adapter, updating internal cookie store.',
                );
                this.cookie.currentCookie = state.val as string;
            }
            if (this.cookie.isValid()) {
                await this.sendRequest();
            }
        }
    }

    /**
     * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
     * Using this method requires "common.messagebox" property to be set to true in io-package.json
     *
     * @param obj - message object
     */
    private onMessage(obj: ioBroker.Message): void {
        this.log.debug(`Received ${obj?.command} message`);
        if (obj?.command === 'getUsers') {
            this.log.debug('Received getUsers message');
            // Send response in callback if required
            if (obj.callback) {
                try {
                    const result = Object.values(this._users).map(user => ({
                        value: user.id,
                        label: user.name || user.id,
                    }));
                    this.log.debug(`Result: ${JSON.stringify(result)}`);
                    this.sendTo(obj.from, obj.command, result, obj.callback);
                } catch (e) {
                    this.log.error(`Error processing getUsers message: ${(e as Error).message}`);
                    this.sendTo(obj.from, obj.command, [], obj.callback);
                }
            }
        }
    }
}
//if (require.main !== module) {
// Export the constructor in compact mode
//module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new GoogleSharedlocations2(options);
//} else {
// otherwise start the instance directly
(() => new GoogleSharedlocations2())();
//}
