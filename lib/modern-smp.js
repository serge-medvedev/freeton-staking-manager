const debug = require('debug')('lib:modern-smp');
const _ = require('lodash');
const Queue = require('better-queue');
const { execConsole } = require('./ton-tools');
const StakingManagementPolicy = require('./smp');
const abiElector = require('../contracts/solidity/elector/Elector.abi.json')

function replacer(key, value) {
    return _.isNil(value) ? null : value;
}

class ModernStakingManagementPolicy extends StakingManagementPolicy {
    constructor(client, ...args) {
        super(client, ...args);

        this.client = client;
        this.runTVMQueue = new Queue((params, cb) => {
            this.client.tvm.run_tvm(params)
                .then(_.partial(cb, null))
                .catch(cb);
        });
    }

    runTVM(params) {
        return new Promise((resolve, reject) => {
            this.runTVMQueue.push(params, (err, result) => {
                _.isNil(err) ? resolve(result) : reject(err);
            });
        });
    }

    async callElectorMethod(call_set) {
        const { message } = await this.client.abi.encode_message({
            abi: {
                type: 'Contract',
                value: abiElector
            },
            address: await super.getElectorAddr(),
            call_set,
            is_internal: false,
            signer: { type: 'None' }
        });
        const result = await this.runTVM({
            abi: {
                type: 'Contract',
                value: abiElector
            },
            account: await super.getElectorBOC(),
            message
        });

        const value = _.get(result, 'decoded.output.value0');

        return value;
    }

    async getActiveElectionId() {
        const result = await this.callElectorMethod({
            function_name: 'active_election_id',
            input: {}
        });

        if (_.isNil(result)) {
            throw new Error('getActiveElectionId: failed to get the value');
        }

        return parseInt(result);
    }

    async computeReturnedStake(accountId) {
        const result = await this.callElectorMethod({
            function_name: 'compute_returned_stake',
            input: {
                wallet_addr: `0x${accountId}`
            }
        });

        if (_.isNil(result)) {
            throw new Error('computeReturnedStake: failed to get the value');
        }

        return parseInt(result);
    }

    async getNewKeyPair() {
        const { stdout } = await execConsole('newkey');
        const key = _.get(stdout.match(/key hash: (?<key>[0-9A-Fa-f]+)/), 'groups.key');

        return {
            key: key.toUpperCase(),
            secret: null // TODO: find a way to have this secret
        }
    }

    async addKeysAndValidatorAddr(electionStart, validationPeriod, electionKey, electionADNLKey) {
        const electionStop = electionStart + validationPeriod;
        const requirement = [
            _.isInteger(electionStart), _.isInteger(electionStop), electionStart < electionStop,
            _.isString(electionKey), !_.isEmpty(electionKey),
            _.isString(electionADNLKey), !_.isEmpty(electionADNLKey)
        ];

        if (! _.every(requirement)) {
            throw new Error(`addKeysAndValidatorAddr: invalid argument(s) detected ${JSON.stringify({
                electionStart,
                electionStop,
                electionKey,
                electionADNLKey
            }, replacer, 2)}`);
        }

        await execConsole(`addpermkey ${electionKey} ${electionStart} ${electionStop}`);
        await execConsole(`addtempkey ${electionKey} ${electionKey} ${electionStop}`);
        await execConsole(`addadnl ${electionADNLKey} "0"`);
        await execConsole(`addvalidatoraddr ${electionKey} ${electionADNLKey} ${electionStop}`);
    }

    async exportPub(electionKey) {
        const requirement = [
            _.isString(electionKey), !_.isEmpty(electionKey)
        ];

        if (! _.every(requirement)) {
            throw new Error(`exportPub: invalid argument(s) detected ${JSON.stringify({
                electionKey
            }, replacer, 2)}`);
        }

        const { stdout } = await execConsole(`exportpub ${electionKey}`);
        const pubKey = _.get(stdout.match(/imported key: (?<key>\S+)/), 'groups.key');

        return pubKey.toUpperCase();
    }

    async signRequest(electionKey, request) {
        const { stdout } = await execConsole(`sign ${electionKey} ${request}`);
        const signature = _.get(stdout.match(/got signature: (?<signature>\S+)/), 'groups.signature');

        return signature.toUpperCase();
    }

    async getParticipantListExtended() {
        // TODO: currently accessible Elector ABI doesn't provide a function for that - wait

        return {
            totalStake: 0
        }
    }

    async restoreKeysImpl({ id, key, adnlKey, secrets }) {
        throw(new Error('unsupported by this policy'));
    }
}

module.exports = ModernStakingManagementPolicy;
