'use strict';

const _ = require('lodash');
const debug = require('debug')('api');
const express = require('express');
const stakingManagerInstance = require('../lib/staking-manager-instance');

const router = express.Router();

router.post('/stake/:action', async (req, res, next) => {
    try {
        const stakingManager = await stakingManagerInstance.get();

        switch(req.params.action) {
            case 'send': {
                const ignoreIfAlreadySubmitted = _.some(['yes', 'true', '1'], v => v === _.toLower(req.query.force));

                await stakingManager.sendStake(ignoreIfAlreadySubmitted);
            } break;
            case 'recover': {
                await stakingManager.recoverStake();
            } break;
            case 'resize': {
                await stakingManager.setNextStakeSize(_.toInteger(req.query.value));
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
});

router.post('/elections/:action', async (req, res, next) => {
    try {
        const stakingManager = await stakingManagerInstance.get();

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
        const stakingManager = await stakingManagerInstance.get();
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
        const stakingManager = await stakingManagerInstance.get();
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
        const stakingManager = await stakingManagerInstance.get();
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
        const stakingManager = await stakingManagerInstance.get();
        const result = await stakingManager.getConfig(req.query.id);

        res.json(result);
    }
    catch (err) {
        debug('ERROR:', err.message);

        res.status(500).json(err);
    }
});

module.exports = router;
