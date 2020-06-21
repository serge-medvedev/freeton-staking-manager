'use strict';

const _ = require('lodash');
const debug = require('debug')('api');
const express = require('express');
const StakingManager = require('../lib/staking-manager');

const router = express.Router();
let stakingManager;

(async () => {
    stakingManager = await StakingManager.create();
})();

router.post('/stake/:action', async (req, res, next) => {
    debug('INFO: BEGIN');

    try {
        switch(req.params.action) {
            case 'send': {
                await stakingManager.sendStake();
            } break;
            case 'recover': {
                await stakingManager.recoverStake();
            } break;
            case 'resize': {
                await stakingManager.setNextStakeSize(_.toInteger(req.query.value));

                debug(`INFO: Stake size is set to ${req.query.value}`);
            } break;
            default: {
                const err = new Error('action isn\'t "send", "recover" nor "resize"');

                err.statusCode = 400;

                throw err;
            }
        }

        res.send();
    }
    catch (err) {
        debug('ERROR:', err.message);

        res.status(err.statusCode || 500).json(err);
    }

    debug('INFO: END');
});

router.post('/elections/:action', async (req, res, next) => {
    try {
        switch(req.params.action) {
            case 'skip': {
                await stakingManager.skipNextElections(true);
            } break;
            case 'participate': {
                await stakingManager.skipNextElections(false);
            } break;
            default: {
                const err = new Error('action is neither "skip" nor "participate"');

                err.statusCode = 400;

                throw err;
            }
        }

        res.send();
    }
    catch (err) {
        debug('ERROR:', err.message);

        res.status(err.statusCode || 500).json(err);
    }
});

router.get('/elections/history', async (req, res, next) => {
    try {
        const result = await stakingManager.getElectionsHistory();

        res.json(result);
    }
    catch (err) {
        debug('ERROR:', err.message);

        res.status(500).json(err);
    }
});

router.get('/timediff', async (req, res, next) => {
    try {
        const result = await stakingManager.getTimeDiff();

        res.send(result.toString());
    }
    catch (err) {
        debug('ERROR:', err.message);

        res.status(500).json(err);
    }
});

router.get('/wallet/balance', async (req, res, next) => {
    try {
        const result = await stakingManager.getWalletBalance();

        res.json(result);
    }
    catch (err) {
        debug('ERROR:', err.message);

        res.status(500).json(err);
    }
});

router.get('/config', async (req, res, next) => {
    try {
        const result = await stakingManager.getConfig(req.query.id);

        res.json(result);
    }
    catch (err) {
        debug('ERROR:', err.message);

        res.status(500).json(err);
    }
});

module.exports = router;
