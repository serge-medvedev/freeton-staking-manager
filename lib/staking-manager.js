'use strict';

const _ = require('lodash');
const fs = require('fs').promises;
const debug = require('debug')('lib:staking-manager');
const mem = require('mem');
const { TONClient } = require('ton-client-node-js');
const Datastore = require('./datastore');
const { execFift, execValidatorEngineConsole } = require('./ton-tools');
const configParamSubfields = require('./ton-config-param-subfields');
const { msig, apiServer, dbFiles } = require('../config');

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

async function addKeysAndValidatorAddr(electionStart, electionStop, electionKey, electionADNLKey) {
    await execValidatorEngineConsole(
        `addpermkey ${electionKey} ${electionStart} ${electionStop}`,
        `addtempkey ${electionKey} ${electionKey} ${electionStop}`,
        `addadnl ${electionADNLKey} 0`,
        `addvalidatoraddr ${electionKey} ${electionADNLKey} ${electionStop}`
    );
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

async function exportPubAndSign(electionKey, request) {
    const { stdout } = await execValidatorEngineConsole(
        `exportpub ${electionKey}`,
        `sign ${electionKey} ${request}`
    );

    const publicKey = _.get(stdout.match(/got public key: (?<key>\S+)/), 'groups.key');
    const signature = _.get(stdout.match(/got signature (?<signature>\S+)/), 'groups.signature');

    return {
        publicKey,
        signature
    }
}

async function genValidatorElectSigned(walletAddr, electionStart, maxFactor, electionADNLKey, publicKey, signature) {
    const bocFile = '/tmp/validator-query.boc';
    
    await execFift(
        'validator-elect-signed.fif', walletAddr, electionStart, maxFactor, electionADNLKey, publicKey, signature, bocFile);

    return fs.readFile(bocFile, { encoding: 'base64' });
}

async function getConfig(id, tonClient) {
    const seqnoQueryResult = await tonClient.queries.blocks.query(
        {}, 'id prev_key_block_seqno', { path: 'seq_no', direction: 'DESC' }, 1
    );
    const prevKeyBlockSeqno = _.get(seqnoQueryResult, '0.prev_key_block_seqno');

    if (_.isNil(prevKeyBlockSeqno)) {
        throw new Error('failed to obtain prev_key_block_seqno');
    }

    const configParamQueryResult = await tonClient.queries.blocks.query(
        { seq_no: { eq: prevKeyBlockSeqno }, workchain_id: { eq: -1 } },
        `master {
            config {
                p${id} ${configParamSubfields[`p${id}`]}
            }
        }`
    );
    const p = _.get(configParamQueryResult, `0.master.config.p${id}`);

    if (_.isNil(p)) {
        throw new Error(`failed to obtain configuration parameter ${id}`);
    }

    return p;
}

class StakingManager {
    constructor(client, datastore) {
        this.client = client;
        this.datastore = datastore;

        this.getConfig = mem(_.partial(getConfig, _, this.client));
    }

    static async create() {
        const client = await TONClient.create({ servers: [apiServer] });
        const datastore = new Datastore(dbFiles.config, dbFiles.elections);

        return new StakingManager(client, datastore);
    }

    async sendStake(ignoreIfAlreadySubmitted = false, maxFactor = 3, sendAttempts = 10) {
        const electorAddr = await this.getElectorAddr();
        const activeElectionId = await this.getActiveElectionIdImpl(electorAddr);

        if (activeElectionId === 0) {
            debug('INFO: No current elections');
        }
        else if (await this.checkIfToSkip()) {
            debug(`INFO: Elections ${activeElectionId}, skipped`);
        }
        else if (!ignoreIfAlreadySubmitted && await this.checkIfAlreadySubmitted(activeElectionId)) {
            debug(`INFO: Elections ${activeElectionId}, already submitted`);
        }
        else {
            debug(`INFO: Elections ${activeElectionId}`);

            await this.sendStakeImpl(electorAddr, activeElectionId, maxFactor, sendAttempts);
        }
    }

    async recoverStake(sendAttempts = 10) {
        const electorAddr = await this.getElectorAddr();

        await this.recoverStakeImpl(electorAddr, sendAttempts);
    }

    async sendStakeImpl(electorAddr, activeElectionId, maxFactor, sendAttempts) {
        const stake = await this.getNextStakeSize();
        const nanostake = stake * 1000000000;

        await this.ensureStakeIsOfAppropriateSize(nanostake);

        const electionStart = activeElectionId;
        const { validators_elected_for } = await this.getConfig(15);
        const electionStop =  electionStart + (validators_elected_for * 2);
        const info = await this.datastore.getElectionsInfo(activeElectionId);

        info.id = activeElectionId;

        if (! _.every(['key', 'adnlKey'], _.partial(_.has, info))) {
            info.key = await getNewKey();
            info.adnlKey = await getNewKey();

            await addKeysAndValidatorAddr(electionStart, electionStop, info.key, info.adnlKey);
            await this.datastore.setElectionsInfo(info);
        }

        const walletAddr = getWalletAddr();

        if (! _.has(info, 'publicKey')) {
            const request = await genValidatorElectReq(walletAddr, electionStart, maxFactor, info.adnlKey);
            const { publicKey, signature } = await exportPubAndSign(info.key, request);

            info.publicKey = publicKey;
            info.signature = signature;

            await this.datastore.setElectionsInfo(info);
        }

        const payload = await genValidatorElectSigned(
            walletAddr, electionStart, maxFactor, info.adnlKey, info.publicKey, info.signature);

        for (let n = 1; n <= sendAttempts; ++n) {
            const result = await this.submitTransaction({
                dest: electorAddr,
                value: nanostake,
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

    async recoverStakeImpl(electorAddr, sendAttempts) {
        const recoverAmount = await this.computeReturnedStake(electorAddr);

        if (recoverAmount !== 0) {
            const payload = await genRecoverQuery();

            for (let n = 1; n <= sendAttempts; ++n) {
                const result = await this.submitTransaction({
                    dest: electorAddr,
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

    async getElectorAddr() {
        return `-1:${await this.getConfig(1)}`;
    }

    async getActiveElectionId() {
        const electorAddr = await this.getElectorAddr();

        return this.getActiveElectionIdImpl(electorAddr);
    }

    async getActiveElectionIdImpl(electorAddr) {
        const result = await this.client.contracts.runGet({
            address: electorAddr,
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

    async computeReturnedStake(electorAddr) {
        const result = await this.client.contracts.runGet({
            address: electorAddr,
            functionName: 'compute_returned_stake',
            input: [`0x${msig.addr.id}`]
        });
        const value = _.get(result, 'output.0');

        if (_.isNil(value)) {
            throw new Error('failed to compute returned stake');
        }

        return parseInt(value);
    }

    async getWalletBalance() {
        const walletAddr = getWalletAddr();
        const [{ balance }] = await this.client.queries.accounts.query(
            { id: { eq: walletAddr } }, 'balance'
        );

        return parseInt(balance);
    }

    async getMinStake() {
        const { min_stake } = await this.getConfig(17);

        return parseInt(min_stake);
    }

    async ensureStakeIsOfAppropriateSize(stake) {
        if (_.isNil(stake)) {
            throw new Error('STAKE (in tokens) is not specified');
        }

        const balance = await this.getWalletBalance();
        const walletAddr = getWalletAddr();

        if (stake > balance) {
            throw new Error(`Not enough tokens (${balance}) in ${walletAddr} wallet`);
        }

        const minStake = await this.getMinStake();

        if (stake < minStake) {
            throw new Error(`stake (${stake}) is less than min_stake (${minStake})`);
        }
    }

    skipNextElections(skip) {
        return this.datastore.skipNextElections(skip);
    }

    checkIfToSkip() {
        return this.datastore.skipNextElections();
    }

    async checkIfAlreadySubmitted(id) {
        const info = await this.datastore.getElectionsInfo(id);

        return ! _.isNil(_.get(info, 'stake'));
    }

    async setNextStakeSize(value) {
        const result = await this.datastore.nextStakeSize(value);

        debug(`INFO: Stake size is set to ${value}`);

        return result;
    }

    getNextStakeSize() {
        return this.datastore.nextStakeSize();
    }

    getElectionsHistory() {
        return this.datastore.getElectionsInfo();
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
}

module.exports = StakingManager;
