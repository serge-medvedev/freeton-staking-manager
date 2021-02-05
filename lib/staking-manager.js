'use strict';

const _ = require('lodash');
const fs = require('fs').promises;
const debug = require('debug')('lib:staking-manager');
const mem = require('mem');
const moment = require('moment');
const { TonClient } = require('@tonclient/core');
const { libNode } = require('@tonclient/lib-node');
const Queue = require('better-queue');
const { file: tmpFile } = require('tmp-promise');
const Datastore = require('./datastore');
const TONConfig = require('./ton-config');
const { execFift, execLiteClient, execValidatorEngineConsole, execGenerateRandomId } = require('./ton-tools');
const { toolset, funding, msig, depool, defaultStake, apiServer, dbFiles } = require('../config');

TonClient.useBinaryLibrary(libNode);

function sleep(ms) {
    return new Promise(resolve => {
        setTimeout(resolve, ms)
    });
}

function getWalletAddr() {
    return `${msig.addr.wc}:${msig.addr.id}`;
}

function getEventAnticipationTimeout() {
    const minValue = 60000;
    const maxValue = 600000;

    return _
        .chain(depool.eventAnticipationTimeout)
        .defaultTo(minValue)
        .thru(v => Math.min(Math.max(v, minValue), maxValue))
        .value();
}

async function genRecoverQuery() {
    const { path, cleanup } = await tmpFile();

    await execFift('recover-stake.fif', path);

    const result = await fs.readFile(path, 'base64');

    cleanup();

    return result;
}

async function getNewKey() {
    const { stdout } = await execValidatorEngineConsole('newkey');
    const key = _.get(stdout.match(/created new key (?<key>[0-9A-Fa-f]+)/), 'groups.key');

    if (_.isNil(key)) {
        throw new Error('key generation failed');
    }

    return key;
}

async function getNewKeyPair() {
    const { path, cleanup } = await tmpFile();
    const { stdout } = await execGenerateRandomId('keys', path);
    const publicKey = _.get(stdout.match(/^(?<key>[0-9A-Fa-f]+)/), 'groups.key');
    const secretKeyFileContentsBase64 = await fs.readFile(path, 'base64');

    await execValidatorEngineConsole(`importf ${path}`);

    cleanup();

    return {
        publicKey,
        secretKeyFileContentsBase64
    }
}

async function genValidatorElectReq(walletAddr, electionStart, maxFactor, electionADNLKey) {
    const { path, cleanup } = await tmpFile();
    const { stdout } = await execFift(
        'validator-elect-req.fif', walletAddr, electionStart, maxFactor, electionADNLKey, path);
    const request = _.get(stdout.match(/^(?<request>[0-9A-Fa-f]+)$/m), 'groups.request');

    cleanup();

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
    const { path, cleanup } = await tmpFile();

    await execFift(
        'validator-elect-signed.fif', walletAddr, electionStart, maxFactor, electionADNLKey, publicKey, signature, path);

    const result = await fs.readFile(path, 'base64');

    cleanup();

    return result;
}

async function getWalletABI() {
    const abiFile = msig.setcode ? 'contracts/solidity/setcodemultisig/SetcodeMultisigWallet.abi.json'
                                 : 'contracts/solidity/safemultisig/SafeMultisigWallet.abi.json';

    return JSON.parse(await fs.readFile(abiFile));
}

async function getDePoolABI() {
    const abiFile = 'contracts/solidity/depool/DePool.abi.json';

    return JSON.parse(await fs.readFile(abiFile));
}

class StakingManager {
    constructor(client, datastore, tonConfig) {
        this.client = client;
        this.datastore = datastore;
        this.tonConfig = tonConfig;

        this.getConfigMemoized = mem(_.bindKey(this.tonConfig, 'get'));

        this.runGetQueue = new Queue((params, cb) => {
            this.client.tvm.run_get(params)
                .then(_.partial(cb, null))
                .catch(cb);
        });
    }

    static async create() {
        const client = new TonClient({
            network: {
                server_address: apiServer
            },
            abi: {
                messageExpirationTimeout: 300000
            }
        });
        const datastore = new Datastore(dbFiles.config, dbFiles.elections);
        const tonConfig = new TONConfig(client);

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
        catch(err) {
            debug('failed to get config 1 - falling back to defaults');
        }
        finally {
            return addr;
        }
    }

    async getElectorBOC() {
        const result = await this.client.net.query_collection({
            collection: 'accounts',
            filter: { id: { eq: await this.getElectorAddr() } },
            result: 'boc'
        });
        const account = _.get(result, 'result.0.boc');

        if (_.isNil(account)) {
            throw new Error('failed to get account boc');
        }

        return account;
    }

    sendStake(sendOnce = true, maxFactor = 3, sendAttempts = 10) {
        switch (funding) {
            case 'depool': return this.sendStakeViaDePool(maxFactor, sendAttempts);
            default: return this.sendStakeViaWallet(sendOnce, maxFactor, sendAttempts);
        }
    }

    async sendStakeViaDePool(maxFactor, sendAttempts) {
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
        const alreadySubmitted = _
            .chain(info)
            .get('stake')
            .toInteger()
            .gt(0)
            .value();

        if (alreadySubmitted) {
            debug(`INFO: Elections ${activeElectionId}, already submitted`);

            return;
        }

        debug(`INFO: Elections ${activeElectionId}`);

        let srcAddr = await this.lookForStakeSigningRequest(activeElectionId);

        if (_.isNil(srcAddr)) {
            srcAddr = await this.waitForStakeSigningRequest(
                activeElectionId,
                getEventAnticipationTimeout());
        }

        if (_.isNil(srcAddr)) {
            throw new Error('Unable to detect relevant proxy address in DePool events');
        }

        debug(`INFO: DePool proxy address is ${srcAddr}`);

        const dstAddr = depool.addr;

        await this.sendStakeImpl(srcAddr, dstAddr, 1, activeElectionId, maxFactor, sendAttempts);
    }

    async lookForStakeSigningRequest(activeElectionId) {
        const { result } = await this.client.net.query_collection({
            collection: 'messages',
            filter: {
                src: { eq: depool.addr },
                msg_type: { eq: 2 },
                created_at: { ge: moment().subtract(1, 'day').unix() }
            },
            result: 'body'
        });
        const abi = await getDePoolABI();

        for (const entry of result) {
            entry.body = await this.client.abi.decode_message_body({
                abi: {
                    type: 'Contract',
                    value: abi
                },
                body: entry.body,
                is_internal: true
            });
        }

        const isWhatWeAreLookingFor = _.overEvery([
            _.matchesProperty('body.name', 'StakeSigningRequested'),
            _.matchesProperty('body.value.electionId', activeElectionId.toString()),
        ]);

        return _
            .chain(result)
            .findLast(isWhatWeAreLookingFor)
            .get('body.value.proxy')
            .value();
    }

    waitForStakeSigningRequest(activeElectionId, timeout) {
        return new Promise(async (resolve, reject) => {
            let subscription;
            let timeoutObject;

            const abi = await getDePoolABI();
            const isWhatWeAreWaitingFor = _.overEvery([
                _.matchesProperty('body.name', 'StakeSigningRequested'),
                _.matchesProperty('body.value.electionId', activeElectionId.toString()),
            ]);
            const onError = err => {
                clearTimeout(timeoutObject);

                if (subscription) {
                    this.client.net.unsubscribe(subscription);
                }

                reject(err);
            }
            const onDocEvent = async (doc) => {
                clearTimeout(timeoutObject);

                try {
                    doc.body = await this.client.abi.decode_message_body({
                        abi: {
                            type: 'Contract',
                            value: abi
                        },
                        body: doc.body,
                        is_internal: true
                    });

                    if (isWhatWeAreWaitingFor(doc)) {
                        await this.client.net.unsubscribe(subscription);

                        resolve(_.get(doc, 'body.value.proxy'));
                    }
                }
                catch (err) {
                    onError(err);
                }
            }

            try {
                subscription = await this.client.net.subscribe_collection({
                    collection: 'messages',
                    filter: {
                        src: { eq: depool.addr },
                        msg_type: { eq: 2 }
                    },
                    result: 'body',
                    onDocEvent
                });

                await this.sendTicktock();

                timeoutObject = setTimeout(() => {
                    onError(new Error('time is out while waiting for the stake signing request'));
                }, timeout);
            }
            catch (err) {
                onError(err);
            }
        });
    }

    async sendTicktock() {
        const { body: payload } = await this.client.abi.encode_message_body({
            abi: {
                type: 'Contract',
                value: await getDePoolABI(),
            },
            call_set: {
                function_name: 'ticktock',
                input: {}
            },
            is_internal: true,
            signer: { type: 'None' }
        });

        return this.submitTransaction({
            dest: depool.addr,
            value: 1000000000,
            bounce: true,
            allBalance: false,
            payload
        });
    }

    async sendStakeViaWallet(sendOnce, maxFactor, sendAttempts) {
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
        const srcAddr = getWalletAddr();
        const balance = await this.getAccountBalance(srcAddr);

        if (nanostake > balance) {
            throw new Error(`Not enough tokens (${balance}) in ${srcAddr} wallet`);
        }

        const minStake = await this.getMinStake();

        if (cumulativeStake === 0 && nanostake < minStake) {
            throw new Error(`Initial stake is less than min stake allowed (${nanostake} < ${minStake})`);
        }

        const { totalStake } = await this.getParticipantListExtended();
        const minTotalStakeFractionAllowed = _.ceil(totalStake / 4096);

        if (nanostake < minTotalStakeFractionAllowed) {
            throw new Error(`No way to send less than ${minTotalStakeFractionAllowed} nanotokens at the moment`);
        }

        const dstAddr = await this.getElectorAddr();

        await this.sendStakeImpl(srcAddr, dstAddr, stake, activeElectionId, maxFactor, sendAttempts);
    }

    async sendStakeImpl(srcAddr, dstAddr, stake, activeElectionId, maxFactor, sendAttempts) {
        const info = await this.datastore.getElectionsInfo(activeElectionId);

        info.id = activeElectionId;

        if (! _.every(['key', 'adnlKey'], _.partial(_.has, info))) {
            const { publicKey: key, secretKeyFileContentsBase64: secret } = await getNewKeyPair();
            const { publicKey: adnlKey, secretKeyFileContentsBase64: adnlSecret } = await getNewKeyPair();

            info.key = key;
            info.adnlKey = adnlKey;
            info.secrets = [secret, adnlSecret];

            await this.addKeysAndValidatorAddr(info.id, info.key, info.adnlKey);
            await this.datastore.setElectionsInfo(info);
        }

        if (! _.has(info, 'publicKey')) {
            const request = await genValidatorElectReq(srcAddr, info.id, maxFactor, info.adnlKey);
            const publicKey = await exportPub(info.key);
            const signature = await signRequest(info.key, request);

            info.publicKey = publicKey;
            info.signature = signature;

            await this.datastore.setElectionsInfo(info);
        }

        const payload = await genValidatorElectSigned(
            srcAddr, info.id, maxFactor, info.adnlKey, info.publicKey, info.signature);

        for (let n = 1; n <= sendAttempts; ++n) {
            const result = await this.submitTransaction({
                dest: dstAddr,
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
            account: await this.getElectorBOC(),
            function_name: 'active_election_id'
        });
        const value = _.get(result, 'output.0');

        if (_.isNil(value)) {
            throw new Error('failed to get active election id');
        }

        return parseInt(value);
    }

    submitTransaction(input) {
        switch (toolset) {
            case 'native': return this.submitTransactionViaLiteClient(input);
            default: return this.submitTransactionViaTonos(input);
        }
    }

    async submitTransactionViaTonos(input) {
        return this.client.processing.process_message({
            message_encode_params: {
                abi: {
                    type: 'Contract',
                    value: await getWalletABI()
                },
                address: getWalletAddr(),
                call_set: {
                    function_name: 'submitTransaction',
                    input,
                },
                is_internal: false,
                signer: {
                    type: 'Keys',
                    keys: msig.keys
                }
            },
            send_events: false
        });
    }

    async submitTransactionViaLiteClient(input) {
        const { message } = await this.client.abi.encode_message({
            abi: {
                type: 'Contract',
                value: await getWalletABI(),
            },
            call_set: {
                function_name: 'submitTransaction',
                input
            },
            address: getWalletAddr(),
            is_internal: false,
            signer: {
                type: 'Keys',
                keys: msig.keys
            }
        });
        const { path, cleanup } = await tmpFile({ postfix: 'msg-body.boc' });

        await fs.writeFile(path, message, 'base64');

        const { stdout, stderr } = await execLiteClient(`sendfile ${path}`);

        debug(stdout);
        debug(stderr);

        cleanup();

        const externalMessageStatus = _.get(stderr.match(/external message status is (?<status>[0-9]+)/), 'groups.status');

        if (externalMessageStatus != 1) {
            throw new Error('lite-client failed to send the message');
        }

        return _.set({}, 'transaction.action.success', true);
    }

    async computeReturnedStake() {
        const result = await this.runGet({
            account: await this.getElectorBOC(),
            function_name: 'compute_returned_stake',
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
            account: await this.getElectorBOC(),
            function_name: 'participant_list_extended'
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

    async getAccountBalance(addr) {
        const { result } = await this.client.net.query_collection({
            collection: 'accounts',
            filter: { id: { eq: addr } },
            result: 'balance'
        });

        return _.chain(result).nth(0).get('balance').parseInt().value();
    }

    async getMinStake() {
        let result = 0x9184e72a000;

        try {
            const { min_stake } = await this.getConfig(17);

            result = parseInt(min_stake);
        }
        catch(err) {
            debug('failed to get config 17 - falling back to defaults');
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

        const { result } = await this.client.net.query_collection({
            collection: 'blocks_signatures',
            filter,
            result: 'id'
        });

        return _.size(result);
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
            account: await this.getElectorBOC(),
            function_name: 'past_elections'
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
        catch(err) {
            debug('failed to get config 15 - falling back to defaults');
        }
        finally {
            return result;
        }
    }

    async getPastElectionIds() {
        const result = await this.runGet({
            account: await this.getElectorBOC(),
            function_name: 'past_election_ids'
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
        const validationPeriod = await this.getValidationPeriod();
        const electionStop = electionStart + validationPeriod;

        await execValidatorEngineConsole(
            `addpermkey ${electionKey} ${electionStart} ${electionStop}`,
            `addtempkey ${electionKey} ${electionKey} ${electionStop}`,
            `addadnl ${electionADNLKey} 0`,
            `addvalidatoraddr ${electionKey} ${electionADNLKey} ${electionStop}`
        );
    }

    async restoreKeys() {
        const ids = await this.getPastElectionIds();
        const activeElectionId = await this.getActiveElectionId();

        if (activeElectionId !== 0) {
            ids.push(activeElectionId);
        }

        debug('ids', ids);

        for (const id of ids) {
            const info = await this.datastore.getElectionsInfo(id);

            debug('info', JSON.stringify(info, null, 2));

            if (! _.every(['key', 'adnlKey', 'secrets'], _.partial(_.has, info))) {
                throw new Error('"key", "adnlKey" and "secrets" must be provided');
            }

            for (const secret of info.secrets) {
                const { path, cleanup } = await tmpFile();

                await fs.writeFile(path, secret, 'base64');

                const { stdout } = await execValidatorEngineConsole(`importf ${path}`);

                debug(stdout);

                cleanup();
            }

            await this.addKeysAndValidatorAddr(info.id, info.key, info.adnlKey);
        }
    }
}

module.exports = StakingManager;
