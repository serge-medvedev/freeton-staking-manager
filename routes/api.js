'use strict';

const debug = require('debug')('api');
const express = require('express');
const Validator = require('../validator');
const Datastore = require('../datastore');
const { servers, freetonDB } = require('../config');

const router = express.Router();
const datastore = new Datastore(freetonDB);

router.get('/', async (req, res, next) => {
    try {
        const validator = await Validator.create(servers);
        const id = await validator.run(
            await datastore.stakeSize(), await datastore.electionId(), await datastore.skipElections());

        await datastore.electionId(id);

        res.send();
    }
    catch (err) {
        console.error(err.message);

        res.status(500).json(err);
    }
});

router.get('/config', async (req, res, next) => {
    try {
        const validator = await Validator.create(servers);
        const result = await validator.getConfig(req.query.id);

        res.json(result);
    }
    catch (err) {
        console.error(err.message);

        res.status(500).json(err);
    }
});

router.get('/activeElectionId', async (req, res, next) => {
    try {
        const validator = await Validator.create(servers);
        const electorAddr = await validator.getElectorAddr();
        const result = await validator.getActiveElectionId(electorAddr);

        res.json(result);
    }
    catch (err) {
        console.error(err.message);

        res.status(500).json(err);
    }
});

module.exports = router;
