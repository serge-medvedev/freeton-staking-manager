'use strict';

const _ = require('lodash');
const fs = require('fs').promises;
const debug = require('debug')('lib:staking-manager');
const mem = require('mem');
const moment = require('moment');
const { TONClient } = require('ton-client-node-js');
const Queue = require('better-queue');
const Datastore = require('./datastore');
const TONConfig = require('./ton-config');
const { execFift, execValidatorEngineConsole } = require('./ton-tools');
const { msig, defaultStake, apiServer, dbFiles } = require('../config');

function sleep(ms) {
    return new Promise(resolve => {
        setTimeout(resolve, ms)
    });
}

function getWalletAddr() {
    return `${msig.addr.wc}:${msig.addr.id}`;
}

async function genRecoverQuery() {
    const bocFile = '/tmp/recover-query.boc';

    await execFift('recover-stake.fif', bocFile);

    return fs.readFile(bocFile, { encoding: 'base64' });
}

async function getNewKey() {
    const { stdout } = await execValidatorEngineConsole('newkey');
    const key = _.get(stdout.match(/created new key (?<key>[0-9A-Fa-f]+)/), 'groups.key');

    if (_.isNil(key)) {
        throw new Error('key generation failed');
    }

    return key;
}

async function genValidatorElectReq(walletAddr, electionStart, maxFactor, electionADNLKey) {
    const { stdout } = await execFift(
        'validator-elect-req.fif', walletAddr, electionStart, maxFactor, electionADNLKey, '/tmp/validator-to-sign.bin');

    const request = _.get(stdout.match(/^(?<request>[0-9A-Fa-f]+)$/m), 'groups.request');

    if ( _.isNil(request)) {
        throw new Error('validator elect req generation failed');
    }

    return request;
}

async function exportPub(electionKey) {
    const { stdout } = await execValidatorEngineConsole(
        `exportpub ${electionKey}`
    );

    return _.get(stdout.match(/got public key: (?<key>\S+)/), 'groups.key');
}

async function signRequest(electionKey, request) {
    const { stdout } = await execValidatorEngineConsole(
        `sign ${electionKey} ${request}`
    );

    return _.get(stdout.match(/got signature (?<signature>\S+)/), 'groups.signature');
}

async function genValidatorElectSigned(walletAddr, electionStart, maxFactor, electionADNLKey, publicKey, signature) {
    const bocFile = '/tmp/validator-query.boc';
    
    await execFift(
        'validator-elect-signed.fif', walletAddr, electionStart, maxFactor, electionADNLKey, publicKey, signature, bocFile);

    return fs.readFile(bocFile, { encoding: 'base64' });
}

class StakingManager {
    constructor(client, datastore, tonConfig) {
        this.client = client;
        this.datastore = datastore;
        this.tonConfig = tonConfig;

        this.getConfigMemoized = mem(_.bindKey(this.tonConfig, 'get'));

        this.runGetQueue = new Queue((params, cb) => {
            this.client.contracts.runGet(params)
                .then(_.partial(cb, null))
                .catch(cb);
        });
    }

    static async create() {
        const client = await TONClient.create({ servers: [apiServer] });
        const datastore = new Datastore(dbFiles.config, dbFiles.elections);
        const tonConfig = await TONConfig.create();

        return new StakingManager(client, datastore, tonConfig);
    }

    getConfig(id) {
        const freshOnly = _.some([34, 36], p => p === id);

        return freshOnly ? this.tonConfig.get(id) : this.getConfigMemoized(id);
    }

    runGet(params) {
        return new Promise((resolve, reject) => {
            this.runGetQueue.push(params, (err, result) => {
                _.isNil(err) ? resolve(result) : reject(err);
            });
        });
    }

    async getElectorAddr() {
        let addr = '-1:3333333333333333333333333333333333333333333333333333333333333333';

        try {
            addr = `-1:${await this.getConfig(1)}`;
        }
        finally {
            return addr;
        }
    }

    async sendStake(sendOnce = true, maxFactor = 3, sendAttempts = 10) {
        const activeElectionId = await this.getActiveElectionId();

        if (activeElectionId === 0) {
            debug('INFO: No current elections');

            return;
        }

        if (await this.datastore.skipNextElections()) {
            debug(`INFO: Elections ${activeElectionId}, skipped`);

            return;
        }

        const info = await this.datastore.getElectionsInfo(activeElectionId);
        const cumulativeStake = _.chain(info).get('stake').toInteger().value();

        if (sendOnce && cumulativeStake > 0) {
            debug(`INFO: Elections ${activeElectionId}, already submitted`);

            return;
        }

        debug(`INFO: Elections ${activeElectionId}`);

        const stake = await this.getNextStakeSize();
        const nanostake = stake * 1000000000;
        const balance = await this.getWalletBalance();
        const walletAddr = getWalletAddr();

        if (nanostake > balance) {
            throw new Error(`Not enough tokens (${balance}) in ${walletAddr} wallet`);
        }

        const minStake = await this.getMinStake();

        if (cumulativeStake === 0 && nanostake < minStake) {
            throw new Error(`Initial stake is less than min stake allowed (${nanostake} < ${minStake})`);
        }

        const { totalStake } = this.getParticipantListExtended();
        const minTotalStakeFractionAllowed = _.ceil(totalStake / 4096);

        if (nanostake < minTotalStakeFractionAllowed) {
            throw new Error(`No way to send less than ${minTotalStakeFractionAllowed} nanotokens at the moment`);
        }

        await this.sendStakeImpl(stake, activeElectionId, maxFactor, sendAttempts);
    }

    async sendStakeImpl(stake, activeElectionId, maxFactor, sendAttempts) {
        const info = await this.datastore.getElectionsInfo(activeElectionId);

        info.id = activeElectionId;

        if (! _.every(['key', 'adnlKey'], _.partial(_.has, info))) {
            info.key = await getNewKey();
            info.adnlKey = await getNewKey();

            await this.addKeysAndValidatorAddr(info.id, info.key, info.adnlKey);
            await this.datastore.setElectionsInfo(info);
        }

        const walletAddr = getWalletAddr();

        if (! _.has(info, 'publicKey')) {
            const request = await genValidatorElectReq(walletAddr, info.id, maxFactor, info.adnlKey);
            const publicKey = await exportPub(info.key);
            const signature = await signRequest(info.key, request);

            info.publicKey = publicKey;
            info.signature = signature;

            await this.datastore.setElectionsInfo(info);
        }

        const payload = await genValidatorElectSigned(
            walletAddr, info.id, maxFactor, info.adnlKey, info.publicKey, info.signature);

        for (let n = 1; n <= sendAttempts; ++n) {
            const result = await this.submitTransaction({
                dest: await this.getElectorAddr(),
                value: stake * 1000000000,
                bounce: true,
                allBalance: false,
                payload
            });

            if (_.get(result, 'transaction.action.success')) {
                debug(`INFO: submitTransaction attempt ${n}... PASS`);

                info.stake = stake;

                await this.datastore.setElectionsInfo(info);

                break;
            }

            debug(`INFO: submitTransaction attempt ${n}... FAIL`);

            await sleep(n * 1000);
        }
    }

    async recoverStake(sendAttempts = 10) {
        const recoverAmount = await this.computeReturnedStake();

        if (recoverAmount !== 0) {
            const payload = await genRecoverQuery();

            for (let n = 1; n <= sendAttempts; ++n) {
                const result = await this.submitTransaction({
                    dest: await this.getElectorAddr(),
                    value: 1000000000,
                    bounce: true,
                    allBalance: false,
                    payload
                });

                if (_.get(result, 'transaction.action.success')) {
                    debug(`INFO: submitTransaction attempt ${n}... PASS`);

                    break;
                }

                debug(`INFO: submitTransaction attempt ${n}... FAIL`);

                await sleep(n * 1000);
            }

            debug(`INFO: Recover of ${recoverAmount} nanotoken(s) is requested`);
        }
        else {
            debug('INFO: Nothing to recover');
        }
    }

    async getActiveElectionId() {
        const result = await this.runGet({
            address: await this.getElectorAddr(),
            functionName: 'active_election_id'
        });
        const value = _.get(result, 'output.0');

        if (_.isNil(value)) {
            throw new Error('failed to get active election id');
        }

        return parseInt(value);
    }

    async submitTransaction(input) {
        const address = `${msig.addr.wc}:${msig.addr.id}`;
        const abiFile = msig.setcode ? 'contracts/solidity/setcodemultisig/SetcodeMultisigWallet.abi.json'
                                     : 'contracts/solidity/safemultisig/SafeMultisigWallet.abi.json';
        const abi = JSON.parse(await fs.readFile(abiFile));

        return this.client.contracts.run({
            address,
            abi,
            functionName: 'submitTransaction',
            input,
            keyPair: msig.keys
        });
    }

    async computeReturnedStake() {
        const result = await this.runGet({
            address: await this.getElectorAddr(),
            functionName: 'compute_returned_stake',
            input: [`0x${msig.addr.id}`]
        });
        const value = _.get(result, 'output.0');

        if (_.isNil(value)) {
            throw new Error('failed to compute returned stake');
        }

        return parseInt(value);
    }

    async getParticipantListExtended() {
        const result = await this.runGet({
            address: await this.getElectorAddr(),
            functionName: 'participant_list_extended'
        });
        const [electAt, electClose, minStake, totalStake, l, failed, finished] = _.get(result, 'output', []);
        const parseList = list => {
            if (_.isNil(list)) {
                return [];
            }

            const [[id, [stake, maxFactor, addr, adnlAddr]], tail] = list;
            const head = {
                id,
                stake: parseInt(stake),
                maxFactor: parseInt(maxFactor),
                addr,
                adnlAddr
            }

            return [head, ...parseList(tail)];
        }

        if (_.isNil(l)) {
            throw new Error('no participants data');
        }

        return {
            electAt: parseInt(electAt),
            electClose: parseInt(electClose),
            minStake: parseInt(minStake),
            totalStake: parseInt(totalStake),
            participants: parseList(l),
            failed: parseInt(failed),
            finished: parseInt(finished)
        };
    }

    async getWalletBalance() {
        const walletAddr = getWalletAddr();
        const [{ balance }] = await this.client.queries.accounts.query(
            { id: { eq: walletAddr } }, 'balance'
        );

        return parseInt(balance);
    }

    async getMinStake() {
        let result = 0x9184e72a000;

        try {
            const { min_stake } = await this.getConfig(17);

            result = parseInt(min_stake);
        }
        finally {
            return result;
        }
    }

    skipNextElections(skip) {
        return this.datastore.skipNextElections(skip);
    }

    async setNextStakeSize(value) {
        const result = await this.datastore.nextStakeSize(value);

        debug(`INFO: Stake size is set to ${value}`);

        return result;
    }

    async getNextStakeSize() {
        return _.defaultTo(await this.datastore.nextStakeSize(), defaultStake);
    }

    async getElectionsHistory() {
        const fields = ['id', 'adnlKey', 'stake'];
        const info = await this.datastore.getElectionsInfo();

        return _.chain(info).map(doc => _.pick(doc, fields)).value();
    }

    async getTimeDiff() {
        const { stdout } = await execValidatorEngineConsole('getstats');
        const unixtime = _.get(stdout.match(/unixtime\s+(?<t>[0-9]+)/), 'groups.t');
        const masterchainblocktime = _.get(stdout.match(/masterchainblocktime\s+(?<t>[0-9]+)/), 'groups.t');

        if (_.some([masterchainblocktime, unixtime], _.isNil)) {
            throw new Error('failed to get "masterchainblocktime" and/or "unixtime"');
        }

        return _.toInteger(masterchainblocktime) - _.toInteger(unixtime);
    }

    async countBlocksSignatures(interval) {
        const le = moment().unix();
        const [prevKey, curKey] = _
            .chain(await this.datastore.getElectionsInfo())
            .takeRight(2)
            .map('key')
            .map(_.toLower)
            .value();
        const filter = {
            gen_utime: { gt: le - interval, le },
            signatures: {
                any: {
                    node_id: { eq: curKey },
                    OR: { node_id: { eq: prevKey } }
                }
            }
        }

        const [result] = await this.client.queries.blocks_signatures.aggregate({ filter });

        return _.toInteger(result);
    }

    async getLatestStakeAndWeight() {
        const keys = _
            .chain(await this.datastore.getElectionsInfo())
            .takeRight(2)
            .map('adnlKey')
            .map(_.toLower)
            .value();
        const p34 = await this.getConfig(34);
        const totalWeight = _.chain(p34).get('total_weight').parseInt().value();
        const weights = _.map(keys, adnl_addr => _
            .chain(p34)
            .get('list')
            .find({ adnl_addr })
            .get('weight')
            .parseInt()
            .divide(totalWeight)
            .value());
        const weightId = _.findIndex(weights, _.negate(_.isNaN));

        if (weightId === -1) {
            return {
                stake: 0,
                weight: 0
            }
        }

        const pastElectionsInfo = await this.runGet({
            address: await this.getElectorAddr(),
            functionName: 'past_elections'
        });
        const parseList = list => {
            if (_.isNil(list)) {
                return [];
            }

            const [[,,,,, totalStake], tail] = list;

            return [parseInt(totalStake), ...parseList(tail)];
        }
        const totalStake = _
            .chain(pastElectionsInfo)
            .get('output.0')
            .thru(parseList)
            .thru(stakes => _.nth(stakes, weightId % _.size(stakes)))
            .value();
        const weight = weights[weightId];

        return {
            stake: totalStake * weight,
            weight
        }
    }

    async getValidationPeriod() {
        let result = 65536;

        try {
            const { validators_elected_for } = await this.getConfig(15);

            result = validators_elected_for;
        }
        finally {
            return result;
        }
    }

    async getPastElectionIds() {
        const result = await this.runGet({
            address: await this.getElectorAddr(),
            functionName: 'past_election_ids'
        });
        const parseList = list => {
            if (_.isNil(list)) {
                return [];
            }

            const [id, tail] = list;

            return [parseInt(id), ...parseList(tail)];
        }

        return _.chain(result).get('output.0').thru(parseList).value();
    }

    async addKeysAndValidatorAddr(electionStart, electionKey, electionADNLKey) {
        let electionStop = electionStart;
        let validationPeriod = 65536;

        try {
            const { validators_elected_for } = await this.getConfig(15);

            validationPeriod = validators_elected_for;
        }
        finally {
            electionStop += (validationPeriod * 2);
        }

        await execValidatorEngineConsole(
            `addpermkey ${electionKey} ${electionStart} ${electionStop}`,
            `addtempkey ${electionKey} ${electionKey} ${electionStop}`,
            `addadnl ${electionADNLKey} 0`,
            `addvalidatoraddr ${electionKey} ${electionADNLKey} ${electionStop}`
        );
    }
}

module.exports = StakingManager;
