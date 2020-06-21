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

router.get('/runOnce', async (req, res, next) => {
    try {
        await stakingManager.runOnce();

        res.send();
    }
    catch (err) {
        debug('ERROR:', err.message);

        res.status(500).json(err);
    }
});

router.post('/recoverStake', async (req, res, next) => {
    debug('INFO: BEGIN');

    try {
        await stakingManager.recoverStake();

        res.send();
    }
    catch (err) {
        debug('ERROR:', err.message);

        res.status(500).json(err);
    }

    debug('INFO: END');
});

router.post('/sendStake', async (req, res, next) => {
    debug('INFO: BEGIN');

    try {
        await stakingManager.sendStake();

        res.send();
    }
    catch (err) {
        debug('ERROR:', err.message);

        res.status(500).json(err);
    }

    debug('INFO: END');
});

router.get('/nextStake', async (req, res, next) => {
    try {
        const result = await stakingManager.getNextStakeSize();

        res.send(result.toString());
    }
    catch (err) {
        debug('ERROR:', err.message);

        res.status(500).json(err);
    }
});

router.post('/nextStake', async (req, res, next) => {
    try {
        await stakingManager.setNextStakeSize(_.toInteger(req.query.value));

        res.send();
    }
    catch (err) {
        debug('ERROR:', err.message);

        res.status(500).json(err);
    }
});

router.post('/nextElections/:action', async (req, res, next) => {
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

router.get('/electionsHistory', async (req, res, next) => {
    try {
        const result = await stakingManager.getElectionsHistory();

        res.json(result);
    }
    catch (err) {
        debug('ERROR:', err.message);

        res.status(500).json(err);
    }
});

router.get('/activeElectionId', async (req, res, next) => {
    try {
        const result = await stakingManager.getActiveElectionId();

        res.json(result);
    }
    catch (err) {
        debug('ERROR:', err.message);

        res.status(500).json(err);
    }
});

router.get('/walletBalance', async (req, res, next) => {
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

module.exports = router;
