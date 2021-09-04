const _ = require('lodash');
const debug = require('debug')('app');
const express = require('express');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const logger = require('morgan');
const { CronJob } = require('cron');
const { periodicJobs } = require('./config');
const stakingManagerInstance = require('./lib/staking-manager-instance');
const apiRouter = require('./routes/api');

const app = express();

app.use(logger('dev', {
    skip: (req, res) => _.startsWith(req.originalUrl, '/stats') && res.statusCode < 400
}));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

function protectRoute(secret) {
    const middleware = (req, res, next) => {
        const token = req.header('FREETON-SM-APIKEY');

        if (_.isEmpty(token)) {
            res.status(401).send('error: token is not provided');

            return;
        }

        jwt.verify(token, secret, { algorithms: ["HS256"] }, (err, decoded) => {
            if (err) {
                debug(err);

                res.status(500).send('error: token verification failed');

                return;
            }

            const misfits = [
                process.env.FREETON_SM_ADMIN_NAME !== decoded.name,
                process.env.FREETON_SM_ADMIN_PASSWORD !== decoded.password
            ]

            if (_.some(misfits)) {
                res.status(401).send();

                return;
            }

            next();
        });
    }

    middleware.unless = require('express-unless');

    return middleware;
}

const secret = process.env.FREETON_SM_AUTH_SECRET;

if (! _.isEmpty(secret)) {
    app.use(protectRoute(secret).unless({ path: ['/auth', /\/stats*/] }));

    apiRouter.post('/auth', (req, res) => {
        const misfits = [
            _.isEmpty(process.env.FREETON_SM_ADMIN_NAME),
            _.isEmpty(process.env.FREETON_SM_ADMIN_PASSWORD),
            _.isEmpty(req.body.name),
            _.isEmpty(req.body.password),
            process.env.FREETON_SM_ADMIN_NAME !== req.body.name,
            process.env.FREETON_SM_ADMIN_PASSWORD !== req.body.password
        ];

        if (_.some(misfits)) {
            res.status(401).send('error: login/password ain\'t set/provided/valid');

            return;
        }

        const token = jwt.sign(
            _.pick(req.body, ['name', 'password']),
            secret,
            { algorithm: 'HS256', noTimestamp: true });

        res.send(token);
    });
}

app.use('/', apiRouter);

async function isTimeDiffAcceptable(threshold) {
    let result = true;

    try {
        const stakingManager = await stakingManagerInstance.get();
        const timeDiff = await stakingManager.getTimeDiff();

        result = (timeDiff > _.defaultTo(threshold, 0));
    }
    catch (err) {
        debug('ERROR:', err.message);
        debug('INFO: timeDiff getting failed - the check will be skipped');
    }

    return result;
}

function createJobFn(fnName) {
    return async () => {
        debug('INFO: BEGIN');

        try {
            const stakingManager = await stakingManagerInstance.get();
            const { acceptableTimeDiff } = periodicJobs;

            if (await isTimeDiffAcceptable(acceptableTimeDiff)) {
                await _.invoke(stakingManager, fnName);
            }
            else {
                debug(`WARN: job's canceled due to unacceptable TIME_DIFF (< ${acceptableTimeDiff})`);
            }
        }
        catch (err) {
            debug('ERROR:', err.message);
        }

        debug('INFO: END');
    }
}

function runJobs() {
    const sendStakeJob = new CronJob(periodicJobs.sendStake, createJobFn('sendStake'));
    const recoverStakeJob = new CronJob(periodicJobs.recoverStake, createJobFn('recoverStake'));

    sendStakeJob.start();
    recoverStakeJob.start();
}

if (periodicJobs.enabled) {
    runJobs();
}

module.exports = app;
