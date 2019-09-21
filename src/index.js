"use strict";

var Accessory, Service, Characteristic, UUIDGen;

const request = require("request-promise");
const bonjour = require('bonjour')();
const bond_1 = require("./bond");

class BondPlatform {
    constructor(log, config, api) {
        this.log = log;
        this.config = config;
        this.api = api;

        this.accessories = [];
        this.bonds = [];

        let that = this;

        api.on('didFinishLaunching', () => {
            that.log(that.accessories.length + " cached accessories were loaded");

            that.discover();
        });
    }

    discover() {
        let that = this;

        bonjour.find({
            type: 'bond'
        }, (service) => {
            that.log("Discovered bond " + service.name);

            if ( service.addresses.length == 0 ) {
                that.log("No addresses associated with discovered bond. Skipping.");
                return;
            }

            that.log("Discovered bond " + service.name + " at " + service.addresses[0] + '.');

            that.login(this.config['email'], this.config['password'])
                .then(session => {
                    that.session = session;
                    return that.readBond(service);
                })
                .then(bond => {
                    that.bonds.push(bond);

                    bond.devices.filter(device => {
                        return !that.deviceAdded(device.id);
                    })
                    .forEach(device => {
                        that.addAccessory(device);
                    });
                })
                .catch(error => {
                    that.log(error);
                });
        });
    }

    addAccessory(device) {
        if (this.deviceAdded(device.id)) {
            this.log(device.id + " has already been added.");
            return;
        }

        if (device.type != "Fan") {
            this.log(device.id + " has an unsupported device type.");
            return;
        }

        var accessory = new Accessory(device.room + " " + device.type, UUIDGen.generate(device.id.toString()));

        accessory.context.device = device;
        accessory.reachable = true;

        accessory.addService(Service.Fan, device.room + " " + device.type);
        accessory.addService(Service.Lightbulb, device.room + " " + device.type + " Light");
        accessory.addService(Service.Switch, "Reset " + device.room + " " + device.type, "reset");

        this.setupObservers(accessory);

        accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.SerialNumber, device.id);

        this.api.registerPlatformAccessories('homebridge-bond-home', 'Bond', [accessory]);
        this.accessories.push(accessory);
    }

    removeAccessory(accessory) {
        this.log("Removing accessory " + accessory.displayName);
        let index = this.accessories.indexOf(accessory);

        if (index > -1) {
            this.accessories.splice(index, 1);
        }

        this.api.unregisterPlatformAccessories('homebridge-bond-home', 'Bond', [accessory]);
    }

    upgrade(accessory) {
        let device = accessory.context.device;

        if (accessory.getService("Reset " + device.room + " " + device.type) == undefined) {
            this.log("Upgrading Accessory: " + accessory.displayName);
            accessory.addService(Service.Switch, "Reset " + device.room + " " + device.type, "reset");
        }

        let reverse = accessory.getService("Reverse " + device.room + " " + device.type);

        if (reverse !== undefined) {
            this.log("removing reverse switch");
            accessory.removeService(reverse);
        }
    }

    configureAccessory(accessory) {
        this.accessories.push(accessory);

        if (this.bonds.length > 0) {
            this.log("Configure Accessory: " + accessory.displayName);
            this.upgrade(accessory);
            this.setupObservers(accessory);
        } else {
            let that = this;
            let timer = setInterval(() => {
                if (this.bonds.length > 0) {
                    that.log("Configure Accessory: " + accessory.displayName);
                    this.upgrade(accessory);
                    that.setupObservers(accessory);
                    clearInterval(timer);
                }
            }, 500);
        }
    }

    setupObservers(accessory) {
        let that = this;
        let device = accessory.context.device;
        let bond = this.bondForIdentifier(device.bondId);
        let bulb = accessory.getService(Service.Lightbulb);
        let theFan = accessory.getService(Service.Fan);
        let reset = accessory.getService("Reset " + device.room + " " + device.type);

        if (device.type == "Fan" && accessory.getService(Service.Fan)) {
            theFan.getCharacteristic(Characteristic.RotationDirection)
                .on('set', function (value, callback) {
                    let command = bond.commandForName(device, "Reverse");

                    bond.sendCommand(that.session, command, device)
                        .then(() => {
                            theFan.getCharacteristic(Characteristic.RotationDirection).updateValue(value);
                            callback();
                        })
                        .catch(error => {
                            that.log(error);
                            callback();
                        });
                });

            bulb.getCharacteristic(Characteristic.On)
                .on('set', function (value, callback) {
                    let command = bond.commandForName(device, "Light Toggle");

                    // called to avoid toggling when the light is already in the requested state
                    if (value == bulb.getCharacteristic(Characteristic.On).value) {
                        callback();
                        return;
                    }

                    bond.sendCommand(that.session, command, device)
                        .then(() => {
                            bulb.getCharacteristic(Characteristic.On).updateValue(value);
                            callback();
                        })
                        .catch(error => {
                            that.log(error);
                            callback();
                        });
                });

            theFan.getCharacteristic(Characteristic.On)
                .on('set', function (value, callback) {
                    // this gets called right after a rotation set so ignore if state isn't changing
                    if (value == theFan.getCharacteristic(Characteristic.On).value) {
                        callback();
                        return;
                    }

                    let speed = value ? theFan.getCharacteristic(Characteristic.RotationSpeed).value : 0;
                    let command = that.getSpeedCommand(bond, device, speed);

                    bond.sendCommand(that.session, command, device)
                        .then(() => {
                            callback();
                        })
                        .catch(error => {
                            that.log(error);
                            callback();
                        });
                });

            theFan.getCharacteristic(Characteristic.RotationSpeed)
                .setProps({
                    minStep: 33,
                    maxValue: 99
                })
                .on('set', function (value, callback) {
                    var command = that.getSpeedCommand(bond, device, value);
                    let old = theFan.getCharacteristic(Characteristic.RotationSpeed).value;
                    theFan.getCharacteristic(Characteristic.RotationSpeed).updateValue(value);
                    bond.sendCommand(that.session, command, device)
                        .then(() => {
                            callback();
                        })
                        .catch(error => {
                            // because the on command comes in so quickly, we optimistically set our new value.
                            // if we fail roll it back
                            setTimeout(() => theFan.getCharacteristic(Characteristic.RotationSpeed).updateValue(old), 250);
                            that.log(error);
                            callback();
                        });
                });

            reset.getCharacteristic(Characteristic.On)
                .on('set', function (value, callback) {
                    theFan.getCharacteristic(Characteristic.On).updateValue(false);
                    theFan.getCharacteristic(Characteristic.RotationDirection).updateValue(false);
                    bulb.getCharacteristic(Characteristic.On).updateValue(false);

                    setTimeout(() => reset.getCharacteristic(Characteristic.On).updateValue(false), 250);

                    callback();
                })
                .on('get', function (callback) {
                    callback(null, false);
                });
        }
    }

    getSpeedCommand(bond, device, speed) {
        let commands = bond.sortedSpeedCommands(device);

        switch (speed) {
            case 33:
                return commands[0];
            case 66:
                return commands[1];
            case 99:
                return commands[2];
            default:
                return bond.powerOffCommand(device);
        }
    }

    deviceAdded(id) {
        return this.accessoryForIdentifier(id) != null;
    }

    bondForIdentifier(id) {
        let bonds = this.bonds.filter(bond => {
            return bond.id == id;
        });

        return bonds.length > 0 ? bonds[0] : null;
    }

    accessoryForIdentifier(id) {
        let accessories = this.accessories.filter(acc => {
            let device = acc.context.device;
            return device.id == id;
        });

        return accessories.length > 0 ? accessories[0] : null;
    }

    login(email, password) {
        return request({
            method: 'POST',
            uri: 'https://appbond.com/api/v1/auth/login/',
            body: {
                email: email,
                password: password
            },
            json: true
        })
        .then(body => {
            return {
                key: body.key,
                token: body.user.bond_token
            };
        });
    }

    readBond(service) {
        return request({
            method: 'GET',
            uri: 'https://appbond.com/api/v1/bonds/' + service.name,
            headers: {
                Authorization: "Token " + this.session.key
            }
        })
        .then(body => {
            return new bond_1.Bond(JSON.parse(body), service.addresses[0]);
        });
    }
}

module.exports = function (homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    Accessory = homebridge.platformAccessory;
    UUIDGen = homebridge.hap.uuid;

    homebridge.registerPlatform('homebridge-bond-home', 'Bond', BondPlatform, true);
};