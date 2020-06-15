'use strict';

const util = require('util');
const exec = util.promisify(require('child_process').exec);
const { validatorEngine } = require('./config')

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

function execValidatorEngineConsole(...commands) {
    return exec(
        `validator-engine-console \
            -a ${validatorEngine.host}:${validatorEngine.port} \
            -k certs/client \
            -p certs/server.pub \
            ${[...commands].map(c => `-c '${c}'`).join(' ')} \
            -c 'quit'`,
        execOpts);
}

module.exports = {
    execFift,
    execValidatorEngineConsole
}
