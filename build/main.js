"use strict";
/*
 * Created with @iobroker/create-adapter v3.1.2
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.GoogleSharedlocations2 = void 0;
// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = __importStar(require("@iobroker/adapter-core"));
const User_1 = require("./lib/User");
const Fence_1 = require("./lib/Fence");
const Cookie_1 = require("./lib/Cookie");
//used to test timeout against
const MAX_INT32 = 2 ** 31 - 1; // 2147483647 (hex 0x7FFFFFFF)
// Load your modules here, e.g.:
// import * as fs from 'node:fs';
/**
 * The adapter class
 */
class GoogleSharedlocations2 extends utils.Adapter {
    _pollTimeout;
    _pollInterval = 300;
    _successFullPolls = 1; // let us try a relogin at start, if cookie does not work.
    _lastBrowserRefresh = 0;
    _users = {};
    fences = [];
    cookie;
    /**
     * Creates an instance of the adapter.
     *
     * @param options - adapter options
     */
    constructor(options = {}) {
        super({
            ...options,
            name: 'google-sharedlocations2',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        // this.on('objectChange', this.onObjectChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
        this.cookie = new Cookie_1.Cookie(this, utils.getAbsoluteInstanceDataDir(this));
    }
    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Initialize your adapter here
        // Reset the connection indicator during startup
        await this.setState('info.connection', false, true);
        //meta object is required to store the login screenshot in the instance file storage
        await this.setForeignObjectNotExistsAsync(this.namespace, {
            type: 'meta',
            common: {
                name: 'Adapter files',
                type: 'meta.user',
            },
            native: {},
        });
        await this.cookie.init();
        await this.subscribeStatesAsync('info.*');
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
        this.log.info(`Working with pollInterval of ${this._pollInterval}s`);
        //read fences:
        for (const fenceConfig of this.config.fences || []) {
            const fence = new Fence_1.Fence(fenceConfig.name, fenceConfig.latitude, fenceConfig.longitude, fenceConfig.radius, fenceConfig.user, fenceConfig.fenceId);
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
            }
            else {
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
    pollPositions() {
        this._pollTimeout = this.setTimeout(async () => {
            if (!this.cookie.isValid()) {
                this.log.debug('Cannot poll positions, no cookies available!');
            }
            else {
                this.log.debug('Polling positions with current cookies.');
                const lastSuccessPolls = this._successFullPolls;
                await this.sendRequest();
                if (this._successFullPolls > 0 && lastSuccessPolls < this._successFullPolls) {
                    if (Date.now() - this._lastBrowserRefresh > 24 * 60 * 60 * 1000) {
                        //try to get some more headers from google:
                        //await this.cookie.improveCookie(); -> somehow fails always..?? Don't understand, why.
                        await this.cookie.refreshCookieWithBrowser();
                        this._lastBrowserRefresh = Date.now();
                    }
                }
            }
            //schedule next poll
            return this.pollPositions();
        }, this._pollInterval * 1000);
    }
    async sendRequest() {
        const results = await this.cookie.sendRequest();
        if (!results) {
            await this.setState('info.connection', false, true);
            if (this._successFullPolls > 0) {
                //try to get new cookie:
                this.log.debug(`Polling failed, trying to obtain new cookies, because got ${this._successFullPolls} valid results before.`);
                this._successFullPolls = 0;
                await this.cookie.loginToGetNewCookies();
            }
        }
        else {
            this._successFullPolls += 1;
            await this.setState('info.connection', true, true);
            for (const location of results) {
                const user = new User_1.User(location);
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
    async fillIntoObjects(user) {
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
                await this.setObjectNotExistsAsync(basepath, deviceObj);
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
        }
        catch (e) {
            this.log.error(`Could not parse user location data: ${e.message}`);
        }
    }
    async notifyPlaces(user) {
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
    async checkFences(user) {
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
    async onUnload(callback) {
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
        }
        catch (error) {
            this.log.error(`Error during unloading: ${error.message}`);
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
    async onStateChange(id, state) {
        if (id.endsWith('info.currentCookies') && state && !state.ack) {
            if (state.val === '') {
                this.log.info('Current cookies state was cleared, trying to obtain new cookies.');
                this._successFullPolls = 0;
                this.cookie.readCookieFromString(''); //clear old cookie
                await this.cookie.loginToGetNewCookies(true);
            }
            else {
                this.log.info('Current cookies state was changed from outside the adapter, updating internal cookie store.');
                this.cookie.readCookieFromString(state.val);
            }
            if (this.cookie.isValid()) {
                await this.sendRequest();
            }
        }
        else if (id.endsWith('info.forceRefreshWithBrowser') && state && !state.ack) {
            this.log.info('Force refresh in browser state was triggered, trying to obtain new cookies.');
            await this.cookie.refreshCookieWithBrowser();
            if (this.cookie.isValid()) {
                await this.sendRequest();
            }
            await this.setState('info.forceRefreshWithBrowser', false, true);
        }
    }
    /**
     * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
     * Using this method requires "common.messagebox" property to be set to true in io-package.json
     *
     * @param obj - message object
     */
    onMessage(obj) {
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
                }
                catch (e) {
                    this.log.error(`Error processing getUsers message: ${e.message}`);
                    this.sendTo(obj.from, obj.command, [], obj.callback);
                }
            }
        }
    }
}
exports.GoogleSharedlocations2 = GoogleSharedlocations2;
//if (require.main !== module) {
// Export the constructor in compact mode
//module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new GoogleSharedlocations2(options);
//} else {
// otherwise start the instance directly
(() => new GoogleSharedlocations2())();
//}
//# sourceMappingURL=main.js.map