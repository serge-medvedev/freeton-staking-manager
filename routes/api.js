'use strict';

const debug = require('debug')('api');
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const fs = require('fs').promises;
const express = require('express');
const router = express.Router();
const _ = require('lodash');
const { TONClient } = require('ton-client-node-js');
const { servers, msig, stake, validatorEngine } = require('../config')

async function getConfig(client, id) {
    const [{ prev_key_block_seqno }] = await client.queries.blocks.query(
        {}, 'id prev_key_block_seqno', { path: 'seq_no', direction: 'DESC' }, 1
    );
    const configParamSubfields = {
        p1: '',
        p15: `{
            validators_elected_for
            elections_start_before
            elections_end_before
            stake_held_for
        }`
    }
    const [{ master: { config } }] = await client.queries.blocks.query(
        { seq_no: { eq: prev_key_block_seqno }, workchain_id: { eq: -1 } },
        `master { 
            config {
                p${id} ${configParamSubfields[`p${id}`]}
            }
        }`
    );

    return config[`p${id}`];
}

async function submitTransaction(client, input) {
    const address = `${msig.addr.wc}:${msig.addr.id}`;
    const abiFile = msig.setcode ? 'contracts/solidity/setcodemultisig/SetcodeMultisigWallet.abi.json'
                                 : 'contracts/solidity/safemultisig/SafeMultisigWallet.abi.json';
    const abi = JSON.parse(await fs.readFile(abiFile));

    return client.contracts.run({
        address,
        abi,
        functionName: 'submitTransaction',
        input,
        keyPair: msig.keys
    });
}

function execFift(script, ...args) {
    return exec(
        `fift -I ton/crypto/fift/lib/:ton/crypto/smartcont/ \
            -s ${script} \
            ${[...args].join(' ')}`);
}

function execValidatorEngineConsole(...commands) {
    const opts = {
        timeout: 60000,
        killSignal: 'SIGKILL'
    }

    return exec(
        `validator-engine-console \
            -a ${validatorEngine.host}:${validatorEngine.port} \
            -k certs/client \
            -p certs/server.pub \
            ${[...commands].map(c => `-c '${c}'`).join(' ')} \
            -c 'quit'`,
        opts);
}

async function computeReturnedStake(client, electorAddr) {
    const result = await client.contracts.runGet({
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

async function getActiveElectionId(client, electorAddr) {
    const result = await client.contracts.runGet({
        address: electorAddr,
        functionName: 'active_election_id'
    });
    const value = _.get(result, 'output.0');

    if (_.isNil(value)) {
        throw new Error('failed to get active election id');
    }

    return parseInt(value);
}

function skipElections() {
    return false; // TODO: store it in DB and let it be modified via API
}

function getStake() {
    return stake * 1000000000; // TODO: store it in DB and let it be modified via API
}

async function addKeysAndValidatorAddr(client, electionStart, electionKey, electionADNLKey) {
    const {
        validators_elected_for,
        elections_start_before,
        elections_end_before,
        stake_held_for
    } = await getConfig(client, 15);
    const electionStop =  electionStart + 1000 + validators_elected_for + elections_start_before + elections_end_before + stake_held_for;

    await execValidatorEngineConsole(
        `addpermkey ${electionKey} ${electionStart} ${electionStop}`,
        `addtempkey ${electionKey} ${electionKey} ${electionStop}`,
        `addadnl ${electionADNLKey} 0`,
        `addvalidatoraddr ${electionKey} ${electionADNLKey} ${electionStop}`
    );
}

async function genValidatorElectReq(walletAddr, electionStart, electionADNLKey) {
    const { stdout } = await execFift(
        'validator-elect-req.fif', walletAddr, electionStart, 2, electionADNLKey, '/tmp/validator-to-sign.bin');

    debug('dump:', stdout);

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

    debug('dump1:', stdout);

    const publicKey = _.get(stdout.match(/got public key: (?<key>\S+)/), 'groups.key');
    const signature = _.get(stdout.match(/got signature (?<signature>\S+)/), 'groups.signature');

    return {
        publicKey,
        signature
    }
}

async function genValidatorElectSigned(walletAddr, electionStart, electionADNLKey, publicKey, signature) {
    const bocFile = '/tmp/validator-query.boc';
    
    await execFift(
        'validator-elect-signed.fif', walletAddr, electionStart, 2, electionADNLKey, publicKey, signature, bocFile);

    return fs.readFile(bocFile, { encoding: 'base64' });
}

let electionId; // TODO: store it in DB

async function validationRoutine(stake) {
    debug('INFO: BEGIN');

    if (_.isNil(stake)) {
        throw new Error('ERROR: STAKE (in tokens) is not specified');
    }

    const sendAttempts = 100;
    const client = await TONClient.create({ servers });
    const electorAddr = `-1:${await getConfig(client, 1)}`;
    const activeElectionId = await getActiveElectionId(client, electorAddr);

    if (activeElectionId === 0) {
        debug('INFO: No current elections');

        const recoverAmount = await computeReturnedStake(client, electorAddr);

        if (recoverAmount !== 0) {
            const payload = await genRecoverQuery();

            for (let n = 1; n <= sendAttempts; ++n) {
                debug(`INFO: submitTransaction attempt ${n}`);

                const result = await submitTransaction(client, {
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
            }

            debug(`INFO: Recover of ${recoverAmount} token(s) is requested`);
        }
    }
    else {
        if (skipElections()) {
            debug('INFO: END');
 
            return;
        }

        if (electionId === activeElectionId) {
            debug(`INFO: Elections ${electionId}, already submitted`);
            debug('INFO: END');

            return;
        }

        electionId = activeElectionId;

        debug(`INFO: Elections ${activeElectionId}`);

        const electionKey = await getNewKey();
        const electionADNLKey = await getNewKey();
        const electionStart = activeElectionId;

        await addKeysAndValidatorAddr(client, electionStart, electionKey, electionADNLKey);

        const walletAddr = `${msig.addr.wc}:${msig.addr.id}`;

        debug('INFO: walletAddr:', walletAddr);

        const request = await genValidatorElectReq(walletAddr, electionStart, electionADNLKey);
        debug('INFO: request:', request);
        const { publicKey, signature } = await exportPubAndSign(electionKey, request);
        debug(`INFO: publicKey=${publicKey}, signature=${signature}`);
        const payload = await genValidatorElectSigned(walletAddr, electionStart, electionADNLKey, publicKey, signature);
        debug('INFO: payload:', payload);

        for (let n = 1; n <= sendAttempts; ++n) {
            debug(`INFO: submitTransaction attempt ${n}`);

            const result = await submitTransaction(client, {
                dest: electorAddr,
                value: stake,
                bounce: true,
                allBalance: false,
                payload
            });

            if (_.get(result, 'transaction.action.success')) {
                debug(`INFO: submitTransaction attempt ${n}... PASS`);

                break;
            }

            debug(`INFO: submitTransaction attempt ${n}... FAIL`);
        }
    }

    debug('INFO: END');
}

router.get('/', async (req, res, next) => {
    try {
        const stake = getStake();

        await validationRoutine(stake);

        res.json({});
    }
    catch (err) {
        console.error(err.message);

        res.status(500).json(err);
    }
});

module.exports = router;
