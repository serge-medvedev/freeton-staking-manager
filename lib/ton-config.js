'use strict';

const _ = require('lodash');
const debug = require('debug')('lib:ton-config');
const { TONClient } = require('ton-client-node-js');
const tonConfigParamSubfields = require('./ton-config-param-subfields');
const { apiServer } = require('../config');

class TONConfig {
    constructor(client) {
        this.client = client;
    }

    async get(id) {
        const seqnoQueryResult = await this.client.queries.blocks.query(
            {}, 'id prev_key_block_seqno', { path: 'seq_no', direction: 'DESC' }, 1
        );
        const prevKeyBlockSeqno = _.get(seqnoQueryResult, '0.prev_key_block_seqno');

        if (_.isNil(prevKeyBlockSeqno)) {
            throw new Error('failed to obtain prev_key_block_seqno');
        }

        const configParamQueryResult = await this.client.queries.blocks.query(
            { seq_no: { eq: prevKeyBlockSeqno }, workchain_id: { eq: -1 } },
            `master {
                config {
                    p${id} ${tonConfigParamSubfields[`p${id}`]}
                }
            }`
        );
        const p = _.get(configParamQueryResult, `0.master.config.p${id}`);

        if (_.isNil(p)) {
            throw new Error(`failed to obtain configuration parameter ${id}`);
        }

        return p;
    }

    static async create() {
        const client = await TONClient.create({ servers: [apiServer] });

        return new TONConfig(client);
    }
}

module.exports = TONConfig;
