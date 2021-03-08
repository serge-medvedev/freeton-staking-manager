const debug = require('debug')('lib:smp');
const assert = require('assert').strict;
const fs = require('fs').promises;
const _ = require('lodash');
const mem = require('mem');
const { file: tmpFile } = require('tmp-promise');
const { execFift } = require('./ton-tools');
const abiDePool = require('../contracts/solidity/depool/DePool.abi.json')
const abiWallet = require('../contracts/solidity/safemultisig/SafeMultisigWallet.abi.json');

function replacer(key, value) {
    return _.isNil(value) ? null : value;
}

class StakingManagementPolicy {
    constructor(client, datastore, tonConfig, wallet, policy) {
        this.client = client;
        this.datastore = datastore;
        this.tonConfig = tonConfig;
        this.wallet = wallet;
        this.policy = policy;

        this.getConfigMemoized = mem(_.bindKey(this.tonConfig, 'get'));
    }

    getConfig(id) {
        const freshOnly = _.some([34, 36], p => p === id);

        return freshOnly ? this.tonConfig.get(id) : this.getConfigMemoized(id);
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

    async getElectorAddr() {
        let addr = '-1:3333333333333333333333333333333333333333333333333333333333333333';

        try {
            addr = `-1:${await this.getConfig(1)}`;
        }
        catch(err) {
            debug('failed to get config 1 - falling back to the defaults');
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

    submitTransaction(input) {
        const message_encode_params = {
            abi: {
                type: 'Contract',
                value: abiWallet
            },
            address: this.wallet.addr,
            call_set: {
                function_name: 'submitTransaction',
                input,
            },
            is_internal: false,
            signer: {
                type: 'Keys',
                keys: this.wallet.keys
            }
        }
        const oldSchool = _.every([
            _.get(this, 'policy.type') === 'legacy',
            _.get(this, 'policy.funding.type') === 'wallet',
            _.has(this, 'policy.liteServer')
        ]);

        if (oldSchool) {
            return this.submitTransactionViaLiteClient(message_encode_params);
        }
        else {
            return this.client.processing.process_message({
                message_encode_params,
                send_events: false
            });
        }
    }

    async sendTicktock() {
        assert(_.get(this, 'policy.funding.type') === 'depool');

        const { body: payload } = await this.client.abi.encode_message_body({
            abi: {
                type: 'Contract',
                value: abiDePool
            },
            call_set: {
                function_name: 'ticktock',
                input: {}
            },
            is_internal: true,
            signer: { type: 'None' }
        });

        return this.submitTransaction({
            dest: this.policy.funding.addr,
            value: 1000000000,
            bounce: true,
            allBalance: false,
            payload
        });
    }

    async genRecoverQuery() {
        const { path, cleanup } = await tmpFile();

        await execFift('recover-stake.fif', path);

        const result = await fs.readFile(path, 'base64');

        cleanup();

        return result;
    }

    async recoverStake(sendAttempts = 10) {
        const recoverAmount = await this.computeReturnedStake(
            _.chain(this.wallet.addr).split(':').nth(1).value()
        );

        if (recoverAmount !== 0) {
            const payload = await this.genRecoverQuery();

            if (_.isEmpty(payload)) {
                throw new Error('recoverStake: recover query payload is empty');
            }

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

    async getWalletBalance() {
        const { result } = await this.client.net.query_collection({
            collection: 'accounts',
            filter: { id: { eq: this.wallet.addr } },
            result: 'balance'
        });

        return _.chain(result).nth(0).get('balance').parseInt().value();
    }

    skipNextElections(skip) {
        return this.datastore.skipNextElections(skip);
    }

    async setNextStakeSize(value) {
        const result = await this.datastore.nextStakeSize(value);

        debug(`INFO: Stake size is set to ${value}`);

        return result;
    }

    async getMinStake() {
        let result = 0x9184e72a000;

        try {
            const { min_stake } = await this.getConfig(17);

            result = parseInt(min_stake);
        }
        catch(err) {
            debug('failed to get config 17 - falling back to the defaults');
        }
        finally {
            return result;
        }
    }

    async lookForStakeSigningRequest(activeElectionId) {
        assert(_.get(this, 'policy.funding.type') === 'depool');

        const { addr: depoolAddr } = this.policy.funding;
        const { result } = await this.client.net.query_collection({
            collection: 'messages',
            filter: {
                src: { eq: depoolAddr },
                msg_type: { eq: 2 },
                created_at: { ge: Math.floor(new Date().getTime() / 1000) - 86400 }
            },
            result: 'body'
        });

        for (const entry of result) {
            entry.body = await this.client.abi.decode_message_body({
                abi: {
                    type: 'Contract',
                    value: abiDePool
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
        assert(_.get(this, 'policy.funding.type') === 'depool');

        return new Promise(async (resolve, reject) => {
            let subscription;
            let timeoutObject;

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
            const onDocEvent = async ({ result: doc }) => {
                try {
                    doc.body = await this.client.abi.decode_message_body({
                        abi: {
                            type: 'Contract',
                            value: abiDePool
                        },
                        body: doc.body,
                        is_internal: true
                    });

                    if (isWhatWeAreWaitingFor(doc)) {
                        await this.client.net.unsubscribe(subscription);

                        clearTimeout(timeoutObject);

                        resolve(_.get(doc, 'body.value.proxy'));
                    }
                }
                catch (err) {
                    onError(err);
                }
            }

            try {
                const subscriptionParams = {
                    collection: 'messages',
                    filter: {
                        src: { eq: this.policy.funding.addr },
                        msg_type: { eq: 2 }
                    },
                    result: 'body'
                }

                subscription = await this.client.net.subscribe_collection(subscriptionParams, onDocEvent);

                timeoutObject = setTimeout(() => {
                    onError(new Error('time is out while waiting for the stake signing request'));
                }, timeout);
            }
            catch (err) {
                onError(err);
            }
        });
    }

    async sendStakeImpl(dbEntry, srcAddr, dstAddr, stake, maxFactor, sendAttempts) {
        if (! _.every(['key', 'adnlKey'], _.partial(_.has, dbEntry))) {
            const { key, secret } = await this.getNewKeyPair();
            const { key: adnlKey, secret: adnlSecret } = await this.getNewKeyPair();

            dbEntry.key = key;
            dbEntry.adnlKey = adnlKey;
            dbEntry.secrets = [secret, adnlSecret];

            const validationPeriod = await this.getValidationPeriod();

            await this.addKeysAndValidatorAddr(dbEntry.id, validationPeriod, dbEntry.key, dbEntry.adnlKey);
        }

        if (! _.has(dbEntry, 'publicKey')) {
            const request = await StakingManagementPolicy.genValidatorElectReq(
                srcAddr, dbEntry.id, maxFactor, dbEntry.adnlKey);
            const publicKey = await this.exportPub(dbEntry.key);
            const signature = await this.signRequest(dbEntry.key, request);

            dbEntry.publicKey = publicKey;
            dbEntry.signature = signature;
        }

        const payload = await StakingManagementPolicy.genValidatorElectSigned(
            srcAddr, dbEntry.id, maxFactor, dbEntry.adnlKey, dbEntry.publicKey, dbEntry.signature);

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

                dbEntry.stake = stake;

                break;
            }

            debug(`INFO: submitTransaction attempt ${n}... FAIL`);

            await sleep(n * 1000);
        }
    }

    async sendStakeViaWallet(dbEntry, sendOnce, maxFactor, sendAttempts) {
        assert(_.get(this, 'policy.funding.type') === 'wallet');

        const cumulativeStake = _
            .chain(dbEntry)
            .get('stake')
            .toInteger()
            .value();

        if (sendOnce && cumulativeStake > 0) {
            debug(`INFO: Elections ${dbEntry.id}, already submitted`);

            return;
        }

        debug(`INFO: Elections ${dbEntry.id}`);

        const { defaultStake } = this.policy.funding;
        const stake = _.defaultTo(await this.datastore.nextStakeSize(), defaultStake);
        const nanostake = stake * 1000000000;
        const srcAddr = this.wallet.addr;
        const balance = await this.getWalletBalance();

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

        await this.sendStakeImpl(dbEntry, srcAddr, dstAddr, stake, maxFactor, sendAttempts);
    }

    async sendStakeViaDePool(dbEntry, maxFactor, sendAttempts) {
        assert(_.get(this, 'policy.funding.type') === 'depool');

        const alreadySubmitted = _
            .chain(dbEntry)
            .get('stake')
            .toInteger()
            .gt(0)
            .value();

        if (alreadySubmitted) {
            debug(`INFO: Elections ${dbEntry.id}, already submitted`);

            return;
        }

        debug(`INFO: Elections ${dbEntry.id}`);

        let srcAddr = await this.lookForStakeSigningRequest(dbEntry.id);
        const { addr: dstAddr, eventAnticipationTimeout } = this.policy.funding;

        if (_.isNil(srcAddr)) {
            await this.sendTicktock();

            srcAddr = await this.waitForStakeSigningRequest(
                dbEntry.id,
                _.defaultTo(eventAnticipationTimeout, 60000));
        }

        if (_.isNil(srcAddr)) {
            throw new Error('Unable to detect relevant proxy address in DePool events');
        }

        debug(`INFO: DePool proxy address is ${srcAddr}`);

        await this.sendStakeImpl(dbEntry, srcAddr, dstAddr, 1, maxFactor, sendAttempts);
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

        const dbEntry = await this.datastore.getElectionsInfo(activeElectionId);
        let err;

        try {
            switch (_.get(this, 'policy.funding.type')) {
                case 'wallet': await this.sendStakeViaWallet(dbEntry, sendOnce, maxFactor, sendAttempts); break;
                case 'depool': await this.sendStakeViaDePool(dbEntry, maxFactor, sendAttempts); break;
                default: throw new Error('sendStake: unknown funding type');
            }
        }
        catch (e) {
            err = e;
        }
        finally {
            await this.datastore.setElectionsInfo(dbEntry);

            if (err) throw err;
        }
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

            this.restoreKeysImpl(info);
        }
    }

    static async genValidatorElectReq(walletAddr, electionStart, maxFactor, electionADNLKey) {
        const requirement = [
            _.isString(walletAddr), !_.isEmpty(walletAddr),
            _.isInteger(electionStart),
            _.isInteger(maxFactor),
            _.isString(electionADNLKey), !_.isEmpty(electionADNLKey)
        ];

        if (! _.every(requirement)) {
            throw new Error(`genValidatorElectReq: invalid argument(s) detected ${JSON.stringify({
                walletAddr,
                electionStart,
                maxFactor,
                electionADNLKey
            }, replacer, 2)}`);
        }

        const { path, cleanup } = await tmpFile();
        const { stdout } = await execFift(
            'validator-elect-req.fif', walletAddr, electionStart, maxFactor, electionADNLKey, path);
        const request = _.get(stdout.match(/^(?<request>[0-9A-Fa-f]+)$/m), 'groups.request');

        cleanup();

        if ( _.isNil(request)) {
            throw new Error('validator elect req generation failed');
        }

        return request;

        /*
        const buffers = [
            Buffer.alloc(4),
            Buffer.alloc(4),
            Buffer.alloc(4),
            Buffer.from(walletAddr, 'hex'),
            Buffer.from(electionADNLKey, 'base64')
        ];

        buffers[0].writeUInt32BE(0x654C5074);
        buffers[1].writeUInt32BE(electionStart);
        buffers[2].writeUInt32BE(maxFactor * 65536.0);

        return Buffer.concat(buffers).toString('hex');
        */
    }

    static async genValidatorElectSigned(walletAddr, electionStart, maxFactor, electionADNLKey, publicKey, signature) {
        const { path, cleanup } = await tmpFile();

        await execFift(
            'validator-elect-signed.fif', walletAddr, electionStart, maxFactor, electionADNLKey, publicKey, signature, path);

        const result = await fs.readFile(path, 'base64');

        cleanup();

        return result;

        /*
        const buffers = [
            Buffer.alloc(4),
            Buffer.alloc(4),
            Buffer.from(publicKey, 'hex'),
            Buffer.alloc(4),
            Buffer.alloc(4),
            Buffer.from(electionADNLKey, 'hex')
        ];

        buffers[0].writeUInt32BE(0x4E73744B);
        buffers[1].writeUInt32BE(Math.floor(new Date().getTime() / 1000));
        buffers[3].writeUInt32BE(electionStart);
        buffers[4].writeUInt32BE(maxFactor * 65536.0);
        */
    }
}

module.exports = StakingManagementPolicy;
