'use strict';

const _ = require('lodash');
const debug = require('debug')('api');
const express = require('express');
const Validator = require('../validator');

const router = express.Router();
let validator;

(async () => {
    validator = await Validator.create();
})();

router.get('/runOnce', async (req, res, next) => {
    try {
        await validator.runOnce();

        res.send();
    }
    catch (err) {
        console.error(err.message);

        res.status(500).json(err);
    }
});

router.get('/nextStake', async (req, res, next) => {
    try {
        const result = await validator.getNextStakeSize();

        res.send(result.toString());
    }
    catch (err) {
        console.error(err.message);

        res.status(500).json(err);
    }
});

router.post('/nextStake', async (req, res, next) => {
    try {
        await validator.setNextStakeSize(_.toInteger(req.query.value));

        res.send();
    }
    catch (err) {
        console.error(err.message);

        res.status(500).json(err);
    }
});

router.post('/nextElections/:action', async (req, res, next) => {
    try {
        switch(req.params.action) {
            case 'skip': {
                await validator.skipNextElections(true);
            } break;
            case 'participate': {
                await validator.skipNextElections(false);
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

router.get('/activeElectionId', async (req, res, next) => {
    try {
        const result = await validator.getActiveElectionId();

        res.json(result);
    }
    catch (err) {
        console.error(err.message);

        res.status(500).json(err);
    }
});

router.get('/config', async (req, res, next) => {
    try {
        const result = await validator.getConfig(req.query.id);

        res.json(result);
    }
    catch (err) {
        console.error(err.message);

        res.status(500).json(err);
    }
});

module.exports = router;
