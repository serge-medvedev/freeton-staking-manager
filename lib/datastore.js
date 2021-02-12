'use strict';

const _ = require('lodash');
const NeDB = require('nedb');

class Datastore {
    constructor(config, elections) {
        this.db = {}
        this.db.config = new NeDB({
            filename: config,
            autoload: true
        });
        this.db.elections = new NeDB({
            filename: elections,
            autoload: true
        });
    }

    nextStakeSize(value) {
        return new Promise((resolve, reject) => {
            if (_.isNil(value)) {
                this.db.config.findOne({}, (err, doc) => {
                    err ? reject(err) : resolve(_.get(doc, 'nextStakeSize'));
                });
            }
            else {
                const nextStakeSize = _.isInteger(value) && (value > 0) ? value : null;

                this.db.config.update({}, { $set: { nextStakeSize } }, { upsert: true }, err => {
                    err ? reject(err) : resolve(nextStakeSize);
                });
            }
        });
    }

    skipNextElections(value) {
        return new Promise((resolve, reject) => {
            if (_.isNil(value)) {
                this.db.config.findOne({}, (err, doc) => {
                    err ? reject(err) : resolve(_.get(doc, 'skipNextElections', false));
                });
            }
            else {
                const skipNextElections = Boolean(value);

                this.db.config.update({}, { $set: { skipNextElections } }, { upsert: true }, err => {
                    err ? reject(err) : resolve(skipNextElections);
                });
            }
        });
    }

    getElectionsInfo(id) {
        return new Promise((resolve, reject) => {
            if (_.isNil(id)) {
                this.db.elections.find({}, { _id: 0 }).sort({ id: 1 }).exec((err, docs) => {
                    err ? reject(err) : resolve(_.defaultTo(docs, []));
                });
            }
            else {
                this.db.elections.findOne({ id }, { _id: 0 }).sort({ id: 1 }).exec((err, doc) => {
                    err ? reject(err) : resolve(_.defaultTo(doc, { id }));
                });
            }
        });
    }

    setElectionsInfo(info) {
        return new Promise((resolve, reject) => {
            if (_.isNil(info.id)) {
                reject(new Error('id is missing'));
            }
            else {
                this.db.elections.update(
                    { id: info.id },
                    { $set: _.omit(info, 'stake'), $inc: { stake: _.get(info, 'stake', 0) } },
                    { upsert: true },
                    (err, n, doc) => {
                        err ? reject(err) : resolve(doc);
                    });
            }
        });
    }
}

module.exports = Datastore;
