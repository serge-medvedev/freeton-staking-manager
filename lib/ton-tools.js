'use strict';

const fs = require('fs');
const util = require('util');
const _ = require('lodash');
const exec = util.promisify(require('child_process').exec);
const { policy } = require('../config')

const execOpts = {
    timeout: 60000,
    killSignal: 'SIGKILL'
}

function execFift(script, ...args) {
    return exec(
        `fift -I ton/crypto/fift/lib/:ton/crypto/smartcont/ \
            -s ${script} \
            ${[...args].join(' ')}`,
        execOpts);
}

function execLiteClient(...commands) {
    const requirement = [
        _.chain(policy).get('liteServer.host').isString().value(),
        _.chain(policy).get('liteServer.port').isInteger().value()
    ];

    if (! _.every(requirement)) {
        throw new Error('execLiteClient: wrong liteServer configuration');
    }

    return exec(
        `lite-client \
            -a ${policy.liteServer.host}:${policy.liteServer.port} \
            -p certs/liteserver.pub \
            ${[...commands].map(c => `-rc '${c}'`).join(' ')} \
            -rc 'quit'`,
        execOpts);
}

function execValidatorEngineConsole(...commands) {
    const requirement = [
        _.chain(policy).get('validatorEngine.host').isString().value(),
        _.chain(policy).get('validatorEngine.port').isInteger().value()
    ];

    if (! _.every(requirement)) {
        throw new Error('execValidatorEngineConsole: wrong validatorEngine configuration');
    }

    return exec(
        `validator-engine-console \
            -a ${policy.validatorEngine.host}:${policy.validatorEngine.port} \
            -k certs/client \
            -p certs/server.pub \
            ${[...commands].map(c => `-c '${c}'`).join(' ')} \
            -c 'quit'`,
        execOpts);
}

function execGenerateRandomId(mode, name) {
    return exec(
        `generate-random-id \
            -m ${mode} \
            -n ${name}`,
        execOpts);
}

function execConsole(...commands) {
    const requirement = [
        _.chain(policy).get('console.client.privateKey').isString().value(),
        _.chain(policy).get('console.server.host').isString().value(),
        _.chain(policy).get('console.server.port').isInteger().value(),
        _.chain(policy).get('console.server.publicKey').isString().value()
    ];

    if (! _.every(requirement)) {
        throw new Error('execConsole: wrong console configuration');
    }

    const configFile = 'console.json';

    if (! fs.existsSync(configFile)) {
        fs.writeFileSync(configFile, JSON.stringify({
            config: {
                client_key: {
                    type_id: 1209251014,
                    pvt_key: policy.console.client.privateKey
                },
                server_address: `${policy.console.server.host}:${policy.console.server.port}`,
                server_key: {
                    type_id: 1209251014,
                    pub_key: policy.console.server.publicKey
                },
                timeouts: null
            }
        }));
    }

    return exec(
        `console -C ${configFile} \
            ${[...commands].map(c => `-c '${c}'`).join(' ')}`,
        execOpts);
}

function execKeyGen() {
    return exec('keygen', execOpts);
}

module.exports = {
    execFift,
    execLiteClient,
    execValidatorEngineConsole,
    execGenerateRandomId,
    execConsole,
    execKeyGen
}
