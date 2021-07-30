const debug = require('debug')('lib:legacy-smp');
const fs = require('fs').promises;
const _ = require('lodash');
const Queue = require('better-queue');
const { file: tmpFile } = require('tmp-promise');
const { execLiteClient, execValidatorEngineConsole, execGenerateRandomId } = require('./ton-tools');
const StakingManagementPolicy = require('./smp');

function replacer(key, value) {
    return _.isNil(value) ? null : value;
}

class LegacyStakingManagementPolicy extends StakingManagementPolicy {
    constructor(client, ...args) {
        super(client, ...args);

        this.client = client;
        this.runGetQueue = new Queue((params, cb) => {
            this.client.tvm.run_get(params)
                .then(_.partial(cb, null))
                .catch(cb);
        });
    }

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
        const { path, cleanup } = await tmpFile();
        const { stdout } = await execGenerateRandomId('keys', path);
        const key = _.get(stdout.match(/^(?<key>[0-9A-Fa-f]+)/), 'groups.key');
        const secret = await fs.readFile(path, 'base64');

        await execValidatorEngineConsole(`importf ${path}`);

        cleanup();

        return { key, secret }
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

        await execValidatorEngineConsole(
            `addpermkey ${electionKey} ${electionStart} ${electionStop}`,
            `addtempkey ${electionKey} ${electionKey} ${electionStop}`,
            `addadnl ${electionADNLKey} 0`,
            `addvalidatoraddr ${electionKey} ${electionADNLKey} ${electionStop}`
        );
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

        const { stdout } = await execValidatorEngineConsole(
            `exportpub ${electionKey}`
        );

        return _.get(stdout.match(/got public key: (?<key>\S+)/), 'groups.key');
    }

    async signRequest(electionKey, request) {
        const { stdout } = await execValidatorEngineConsole(
            `sign ${electionKey} ${request}`
        );

        return _.get(stdout.match(/got signature (?<signature>\S+)/), 'groups.signature');
    }

    async getPastElectionIds() {
        const result = await this.runGet({
            account: await super.getElectorBOC(),
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

    async submitTransactionViaLiteClient(message_encode_params) {
        const { message } = await this.client.abi.encode_message(message_encode_params);
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

    async getRawParticipantsListExtended() {
        return this.runGet({
            account: await super.getElectorBOC(),
            function_name: 'participant_list_extended'
        });
    }

    async restoreKeysImpl({ id, key, adnlKey, secrets }) {
        for (const secret of secrets) {
            const { path, cleanup } = await tmpFile();

            await fs.writeFile(path, secret, 'base64');

            const { stdout } = await execValidatorEngineConsole(`importf ${path}`);

            debug(stdout);

            cleanup();
        }

        const validationPeriod = await super.getValidationPeriod();

        await this.addKeysAndValidatorAddr(id, validationPeriod, key, adnlKey);
    }

    async getTimeDiff() {
        const { stdout } = await execValidatorEngineConsole('getstats');
        const unixtime = _
            .chain(stdout.match(/unixtime\s+(?<t>\d+)/))
            .get('groups.t')
            .parseInt()
            .value();
        const masterchainblocktime = _
            .chain(stdout.match(/masterchainblocktime\s+(?<t>\d+)/))
            .get('groups.t')
            .parseInt()
            .value();

        if (_.some([masterchainblocktime, unixtime], _.isNaN)) {
            throw new Error('failed to get "masterchainblocktime" and/or "unixtime"');
        }

        return masterchainblocktime - unixtime;
    }
}

async function getNewKey() {
    const { stdout } = await execValidatorEngineConsole('newkey');
    const key = _.get(stdout.match(/created new key (?<key>[0-9A-Fa-f]+)/), 'groups.key');

    if (_.isNil(key)) {
        throw new Error('key generation failed');
    }

    return key;
}

module.exports = LegacyStakingManagementPolicy;
