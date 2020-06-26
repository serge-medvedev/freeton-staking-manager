'use strict';

const _ = require('lodash');
const debug = require('debug')('api');
const mem = require('mem');
const express = require('express');
const asyncHandler = require('express-async-handler');
const stakingManagerInstance = require('../lib/staking-manager-instance');

const router = express.Router();

function errorHandler(err, req, res, next) {
    debug('ERROR:', err.message);

    res.status(err.statusCode || 500).json(err);
}

const getLatestStakeAndWeightMemoized = mem(async () => {
    const stakingManager = await stakingManagerInstance.get();

    return stakingManager.getLatestStakeAndWeight();
});

async function getLatestStakeAndWeight() {
    const stakingManager = await stakingManagerInstance.get();
    const pastElectionIds = await stakingManager.getPastElectionIds();
    const cacheKey = _.join(pastElectionIds);

    return getLatestStakeAndWeightMemoized(cacheKey);
}

async function getStats(interval) {
    const result = {
        stake: 0,
        weight: 0,
        blocksSignatures: 0
    }

    try {
        const stakingManager = await stakingManagerInstance.get();
        const blocksSignatures = await stakingManager.countBlocksSignatures(interval);

        result.blocksSignatures = blocksSignatures;

        const { stake, weight } = await getLatestStakeAndWeight();

        result.stake = stake;
        result.weight = weight;
    }
    catch (err) {
        debug('ERROR:', err.message);
    }
    finally {
        return result;
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
}, errorHandler));

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

router.get('/timediff', asyncHandler(async (req, res) => {
    const stakingManager = await stakingManagerInstance.get();
    const result = await stakingManager.getTimeDiff();

    res.send(result.toString());
}), errorHandler);

router.get('/wallet/balance', asyncHandler(async (req, res) => {
    const stakingManager = await stakingManagerInstance.get();
    const result = await stakingManager.getWalletBalance();

    res.json(result);
}), errorHandler);

router.get('/config', asyncHandler(async (req, res) => {
    const stakingManager = await stakingManagerInstance.get();
    const result = await stakingManager.getConfig(_.toInteger(req.query.id));

    res.json(result);
}), errorHandler);

router.get('/stats/:representation', asyncHandler(async (req, res) => {
    const { stake, weight, blocksSignatures } = await getStats(
        _.chain(req.query.interval).defaultTo(60).toInteger().value()
    );

    switch (req.params.representation) {
        case 'json': {
            res.json({ stake, weight, blocksSignatures });
        } break;
        case 'influxdb': {
            res.send(`validator,host=dev.ratatoskr.online stake=${stake},weight=${weight},blocks_signatures=${blocksSignatures}`);
        } break;
        default: {
            const err = new Error('representation must be either \'json\' or \'influxdb\'');

            err.statusCode = 404;

            throw err;
        }
    }
}), errorHandler);

module.exports = router;
