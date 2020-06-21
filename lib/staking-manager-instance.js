'use strict';

const StakingManager = require('./staking-manager');

const instance = StakingManager.create();

module.exports = {
    get: () => instance
}
