const debug = require('debug')('lib:modern-smp');
const _ = require('lodash');
const Queue = require('better-queue');
const { execConsole } = require('./ton-tools');
const StakingManagementPolicy = require('./smp');
// const abiElector = require('../contracts/solidity/elector/Elector.abi.json')

function replacer(key, value) {
    return _.isNil(value) ? null : value;
}

class ModernStakingManagementPolicy extends StakingManagementPolicy {
    constructor(client, ...args) {
        super(client, ...args);

        this.client = client;
        /*
        this.runTVMQueue = new Queue((params, cb) => {
            this.client.tvm.run_tvm(params)
                .then(_.partial(cb, null))
                .catch(cb);
        });
        */
        this.runGetQueue = new Queue((params, cb) => {
            this.client.tvm.run_get(params)
                .then(_.partial(cb, null))
                .catch(cb);
        });
    }

    /*
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

        return _.get(result, 'decoded.output.value0');
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
    */

    runGet(params) {
        return new Promise((resolve, reject) => {
            this.runGetQueue.push(params, (err, result) => {
                _.isNil(err) ? resolve(result) : reject(err);
            });
        });
    }

    async getActiveElectionId() {
        const result = await this.runGet({
            account: await super.getElectorBOC(),
            function_name: 'active_election_id'
        });
        const value = _.get(result, 'output.0');

        if (_.isNil(value)) {
            throw new Error('failed to get active election id');
        }

        return parseInt(value);
    }

    async computeReturnedStake(accountId) {
        const result = await this.runGet({
            account: await super.getElectorBOC(),
            function_name: 'compute_returned_stake',
            input: [`0x${accountId}`]
        });
        const value = _.get(result, 'output.0');

        if (_.isNil(value)) {
            throw new Error('failed to compute returned stake');
        }

        return parseInt(value);
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

        await execConsole(
            `addpermkey ${electionKey} ${electionStart} ${electionStop}`,
            `addtempkey ${electionKey} ${electionKey} ${electionStop}`,
            `addadnl ${electionADNLKey} "0"`,
            `addvalidatoraddr ${electionKey} ${electionADNLKey} ${electionStop}`);
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

        // A trick required by fift - prepend 4 magic bytes to the key hash
        const buffers = [
            Buffer.alloc(4),
            Buffer.from(pubKey, 'hex')
        ];

        buffers[0].writeUInt32BE(0xC6B41348);

        return Buffer.concat(buffers).toString('base64');
    }

    async signRequest(electionKey, request) {
        const { stdout } = await execConsole(`sign ${electionKey} ${request}`);

        return _.get(stdout.match(/got signature: \S+ (?<signature>\S+)/), 'groups.signature');
    }

    /*
    async getParticipantListExtended() {
        // TODO: currently accessible Elector ABI doesn't provide a function for that - wait

        return {
            totalStake: 0
        }
    }
    */

    async getParticipantListExtended() {
        const result = await this.runGet({
            account: await super.getElectorBOC(),
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

    async restoreKeysImpl({ id, key, adnlKey, secrets }) {
        throw new Error('unsupported by this policy');
    }

    async getTimeDiff() {
        const { stdout } = await execConsole('getstats');
        const timediff = _
            .chain(stdout.match(/"timediff":\s*(?<timediff>\d+)/))
            .get('groups.timediff')
            .parseInt()
            .value();

        if (_.isNaN(timediff)) {
            throw new Error('getTimeDiff: failed to get the value');
        }

        return -timediff;
    }
}

module.exports = ModernStakingManagementPolicy;
