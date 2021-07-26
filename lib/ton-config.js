'use strict';

const _ = require('lodash');
const debug = require('debug')('lib:ton-config');
const tonConfigParamSubfields = require('./ton-config-param-subfields');

class TONConfig {
    constructor(client) {
        this.client = client;
    }

    async get(id) {
        const seqnoQueryResult = await this.client.net.query_collection({
            collection: 'blocks',
            filter: {},
            order: [{ path: 'seq_no', direction: 'DESC' }],
            result: 'id prev_key_block_seqno',
            limit: 1
        });
        const prevKeyBlockSeqno = _.get(seqnoQueryResult, 'result.0.prev_key_block_seqno');

        if (_.isNil(prevKeyBlockSeqno)) {
            throw new Error('failed to obtain prev_key_block_seqno');
        }

        const configParamQueryResult = await this.client.net.query_collection({
            collection: 'blocks',
            filter: {
                seq_no: { eq: prevKeyBlockSeqno },
                workchain_id: { eq: -1 }
            },
            result: `master { config { p${id} ${tonConfigParamSubfields[`p${id}`]} } }`
        });

        return _.get(configParamQueryResult, `result.0.master.config.p${id}`);
    }
}

module.exports = TONConfig;
