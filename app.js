const _ = require('lodash');
const debug = require('debug')('app');
const express = require('express');
const cookieParser = require('cookie-parser');
const logger = require('morgan');
const { CronJob } = require('cron');
const { periodicJobs } = require('./config');
const stakingManagerInstance = require('./lib/staking-manager-instance');
const apiRouter = require('./routes/api');

const app = express();

app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

app.use('/', apiRouter);

module.exports = app;

function createJobFn(fnName) {
    return async () => {
        debug('INFO: BEGIN');

        const stakingManager = await stakingManagerInstance.get();

        try {
            const timeDiff = await stakingManager.getTimeDiff();
            const { acceptableTimeDiff } = periodicJobs;

            if (timeDiff > acceptableTimeDiff) {
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
