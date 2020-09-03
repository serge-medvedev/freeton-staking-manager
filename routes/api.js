'use strict';

const _ = require('lodash');
const debug = require('debug')('api');
const express = require('express');
const asyncHandler = require('express-async-handler');
const stakingManagerInstance = require('../lib/staking-manager-instance');
const { msig } = require('../config');

const router = express.Router();

function errorHandler(err, req, res, next) {
    debug('ERROR:', err);

    res.status(err.statusCode || 500).send();
}

const getLatestStakeAndWeightThrottled = _.throttle(async () => {
    let result = { stake: 0, weight: 0 }

    try {
        const stakingManager = await stakingManagerInstance.get();

        result = await stakingManager.getLatestStakeAndWeight();
    }
    finally {
        return result;
    }
}, 300000);
const getAccountBalanceThrottled = _.throttle(async () => {
    const stakingManager = await stakingManagerInstance.get();
    const addr = `${msig.addr.wc}:${msig.addr.id}`;

    return stakingManager.getAccountBalance(addr);
}, 300000);

async function getStats(interval) {
    const stakingManager = await stakingManagerInstance.get();
    const blocksSignatures = await stakingManager.countBlocksSignatures(interval);
    const { stake, weight } = await getLatestStakeAndWeightThrottled();
    const timeDiff = await stakingManager.getTimeDiff();
    const accountBalance = await getAccountBalanceThrottled();

    return {
        blocksSignatures,
        stake,
        weight,
        timeDiff,
        accountBalance
    }
}

router.post('/stake/:action', asyncHandler(async (req, res) => {
    const stakingManager = await stakingManagerInstance.get();

    switch(req.params.action) {
        case 'send': {
            const force = _.some(['yes', 'true', '1'], v => v === _.toLower(req.query.force));

            await stakingManager.sendStake(!force);
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
}), errorHandler);

router.post('/elections/:action', asyncHandler(async (req, res) => {
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
}), errorHandler);

router.get('/elections/:target', asyncHandler(async (req, res) => {
    const stakingManager = await stakingManagerInstance.get();

    let result;

    switch (req.params.target) {
        case 'history': {
            result = await stakingManager.getElectionsHistory();
        } break;
        case 'participants': {
            result = await stakingManager.participantListExtended();
        } break;
        default: {
            const err = new Error('target is neither "history" nor "participants"');

            err.statusCode = 400;

            throw err;
        }
    }

    res.json(result);
}), errorHandler);

router.post('/validation/resume', asyncHandler(async (req, res) => {
    const stakingManager = await stakingManagerInstance.get();

    await stakingManager.restoreKeys();

    res.send();
}), errorHandler);

router.get('/stats/:representation', asyncHandler(async (req, res) => {
    const stats = await getStats(
        _.chain(req.query.interval).defaultTo(60).toInteger().value()
    );

    switch (req.params.representation) {
        case 'json': {
            res.json(stats);
        } break;
        case 'influxdb': {
            const fields = _
                .chain(stats)
                .toPairs()
                .map(([k, v]) => `${_.snakeCase(k)}=${v}`)
                .join()
                .value();

            res.send(`freeton-validator,host=dev.ratatoskr.online ${fields}`);
        } break;
        default: {
            const err = new Error('representation must be either \'json\' or \'influxdb\'');

            err.statusCode = 404;

            throw err;
        }
    }
}), errorHandler);

router.get('/config', asyncHandler(async (req, res) => {
    const stakingManager = await stakingManagerInstance.get();
    const result = await stakingManager.getConfig(_.toInteger(req.query.id));

    res.json(result);
}), errorHandler);

module.exports = router;
