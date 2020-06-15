'use strict';

const _ = require('lodash');
const NeDB = require('nedb');
const { stake } = require('./config');

class Datastore {
    constructor(filename) {
        this.db = new NeDB({
            filename,
            autoload: true
        });
    }

    stakeSize(value) {
        return new Promise((resolve, reject) => {
            if (_.isNil(value)) {
                this.db.findOne({ stakeSize: { $exists: true } }, (err, doc) => {
                    err ? reject(err) : resolve(_.get(doc, 'stakeSize', stake));
                });
            }
            else {
                this.db.update({ stakeSize: { $exists: true } }, { $set: { stakeSize: value } }, { multi: true }, err => {
                    err ? reject(err) : resolve(value);
                });
            }
        });
    }

    electionId(value) {
        return new Promise((resolve, reject) => {
            if (_.isNil(value)) {
                this.db.findOne({ electionId: { $exists: true } }, (err, doc) => {
                    err ? reject(err) : resolve(_.get(doc, 'electionId', 0));
                });
            }
            else {
                this.db.update({ electionId: { $exists: true } }, { $set: { electionId: value } }, { multi: true }, err => {
                    err ? reject(err) : resolve(value);
                });
            }
        });
    }

    skipElections(value) {
        return new Promise((resolve, reject) => {
            if (_.isNil(value)) {
                this.db.findOne({ skipElections: { $exists: true } }, (err, doc) => {
                    err ? reject(err) : resolve(_.get(doc, 'skipElections', false));
                });
            }
            else {
                this.db.update({ skipElections: { $exists: true } }, { $set: { skipElections: value } }, { multi: true }, err => {
                    err ? reject(err) : resolve(value);
                });
            }
        });
    }
}

module.exports = Datastore;
