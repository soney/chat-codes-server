"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// import * as sio from 'socket.io';
const _ = require("underscore");
const commandLineArgs = require("command-line-args");
const fs = require("fs");
const path = require("path");
const ShareDB = require("sharedb");
const ShareDBMongo = require("sharedb-mongo");
const ShareDBMingo = require("sharedb-mingo-memory");
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const WebSocketJSONStream = require("websocket-json-stream");
const otText = require("ot-text");
const Logger = require("js-logger");
const events_1 = require("events");
Logger.useDefaults();
ShareDB.types.map['json0'].registerSubtype(otText.type);
class ChatCodesChannelServer extends events_1.EventEmitter {
    constructor(sharedb, wss, channelName) {
        super();
        this.sharedb = sharedb;
        this.wss = wss;
        this.channelName = channelName;
        this.channelID = s4() + s4() + s4() + s4() + s4();
        this.members = new Set();
        this.chatPromise = this.getShareDBChat();
        this.editorsPromise = this.getShareDBEditors();
        this.cursorsPromise = this.getShareDBCursors();
        this.selfDestructTimeout = null;
        this.selfDestructDelay = 5 * 60 * 60 * 1000; // 5 hours
        this.colorIndex = 0;
        Promise.all([this.subscribePromise(this.chatPromise), this.subscribePromise(this.editorsPromise)]).then((info) => {
            const chatDoc = info[0];
            const editorsDoc = info[1];
            let editedFiles = new Set();
            let editingUsers = new Set();
            let lastEvent = null;
            let editGroup = {};
            function createNewEditGroup() {
                editedFiles = new Set();
                editingUsers = new Set();
                editGroup = {
                    type: 'edit',
                    fromVersion: editorsDoc.version,
                    toVersion: editorsDoc.version,
                    files: [],
                    users: [],
                    fileContents: {},
                    startTimestamp: this.getTimestamp(),
                    endTimestamp: this.getTimestamp()
                };
                this.submitOp(chatDoc, { p: ['messages', chatDoc.data.messages.length], li: editGroup }, { source: true });
            }
            this.on('editor-event', (info) => {
                if (lastEvent !== 'edit') {
                    createNewEditGroup.call(this);
                }
                const { id } = info;
                if (!editingUsers.has(id)) {
                    editingUsers.add(id);
                    editGroup['users'].push(id);
                }
                lastEvent = 'edit';
            });
            chatDoc.on('before op', (ops) => {
                ops.forEach((op, source) => {
                    const { p, li } = op;
                    if (p.length === 2 && p[0] === 'messages' && li && li.type !== 'edit' && !source) {
                        lastEvent = 'chat';
                    }
                });
            });
            editorsDoc.on('before op', (ops) => {
                ops.forEach((op, source) => {
                    const { p, li } = op;
                    if (p.length === 3 && p[1] === 'contents') {
                        const editorIndex = p[0];
                        const editorID = editorsDoc.data[editorIndex].id;
                        const editorContents = editorsDoc.data[editorIndex].contents;
                        if (lastEvent !== 'edit') {
                            createNewEditGroup.call(this);
                        }
                        if (!editedFiles.has(editorID)) {
                            editedFiles.add(editorID);
                            editGroup['files'].push(editorID);
                            editGroup['fileContents'][editorID] = {
                                valueBefore: editorContents,
                                valueAfter: editorContents
                            };
                        }
                    }
                });
            });
            editorsDoc.on('op', (ops) => {
                ops.forEach((op, source) => {
                    const { p, li } = op;
                    if (p.length === 3 && p[1] === 'contents') {
                        const editorIndex = p[0];
                        const editorID = editorsDoc.data[editorIndex].id;
                        const editorContents = editorsDoc.data[editorIndex].contents;
                        editGroup['fileContents'][editorID]['valueAfter'] = editorContents;
                        if (lastEvent === 'edit') {
                            editGroup['toVersion'] = editorsDoc.version;
                            editGroup['endTimestamp'] = this.getTimestamp();
                            this.submitOp(chatDoc, { p: ['messages', chatDoc.data.messages.length - 1], li: editGroup, ld: _.last(chatDoc.data.messages) }, { source: true });
                        }
                        lastEvent = 'edit';
                    }
                });
            });
        }).catch((e) => {
            console.error(e.stack);
        });
    }
    subscribePromise(docPromise) {
        return docPromise.then((doc) => {
            return new Promise((resolve, reject) => {
                doc.subscribe((err) => {
                    if (err) {
                        reject(err);
                    }
                    else {
                        resolve(doc);
                    }
                });
            });
        });
    }
    submitOp(doc, data, options) {
        return new Promise((resolve, reject) => {
            doc.submitOp(data, options, (err) => {
                if (err) {
                    reject(err);
                }
                else {
                    resolve(doc);
                }
            });
        });
    }
    fetchDocFromPromise(docPromise) {
        return docPromise.then((doc) => {
            return new Promise((resolve, reject) => {
                doc.fetch((err) => {
                    if (err) {
                        reject(err);
                    }
                    else {
                        resolve(doc);
                    }
                });
            });
        });
    }
    ;
    getTimestamp() { return (new Date()).getTime(); }
    ;
    addMember(memberInfo, ws) {
        const { username, id } = memberInfo;
        const member = {
            id: id,
            joined: this.getTimestamp(),
            left: -1,
            info: {
                typingStatus: 'IDLE',
                name: username,
                colorIndex: this.colorIndex + 1
            }
        };
        this.colorIndex = (this.colorIndex + 1) % ChatCodesChannelServer.NUM_COLORS;
        this.members.add(member);
        this.stopSelfDestructTimer();
        ws.on('message', (str) => {
            try {
                const data = JSON.parse(str);
                const { ns } = data;
                if (data.cc === 1 && ns === this.getShareDBNamespace()) {
                    const { type } = data;
                    if (type === 'editor-event') {
                        this.emit('editor-event', member);
                    }
                    else if (type === 'get-editors-values') {
                        const { payload, messageID } = data;
                        const version = payload;
                        this.getEditorValues(version).then((result) => {
                            ws.send(JSON.stringify({
                                messageID,
                                ns,
                                cc: 2,
                                payload: Array.from(result.values())
                            }));
                        });
                    }
                }
            }
            catch (e) {
                console.error(e);
            }
        });
        ws.on('close', () => {
            const timestamp = this.getTimestamp();
            Promise.all([this.chatPromise]).then(([chatDoc]) => {
                const userLeft = {
                    uid: id,
                    type: 'left',
                    timestamp: timestamp
                };
                return this.submitOp(chatDoc, [{ p: ['messages', chatDoc.data.messages.length], li: userLeft }]);
            }).then((chatDoc) => {
                member.left = this.getTimestamp();
                return this.submitOp(chatDoc, [{ p: ['activeUsers', id], od: member }]);
            }).then(() => {
                return this.fetchDocFromPromise(this.cursorsPromise);
            }).then((cursorsDoc) => {
                const removeCursorsPromises = _.chain(cursorsDoc.data)
                    .map((ed, i) => {
                    const ucd = ed['userCursors'][id];
                    const usd = ed['userSelections'][id];
                    return Promise.all([this.submitOp(cursorsDoc, [{ p: [i, 'userCursors', id], od: ucd }]), this.submitOp(cursorsDoc, [{ p: [i, 'userSelections', id], od: ucd }])]);
                })
                    .flatten(true)
                    .value();
                return Promise.all(removeCursorsPromises);
            }).then(() => {
                this.members.delete(member);
                if (this.isEmpty()) {
                    this.startSelfDestructTimer();
                }
            });
            Logger.info(`Client (${id} in ${this.getChannelName()}) disconnected`);
        });
        Logger.info(`Client (${id}:${username} in ${this.getChannelName()}) joined`);
        return Promise.all([this.chatPromise]).then((result) => {
            const chatDoc = result[0];
            return this.submitOp(chatDoc, [{ p: ['activeUsers', id], oi: member }]);
        }).then((chatDoc) => {
            return this.submitOp(chatDoc, [{ p: ['allUsers', id], oi: member }]);
        }).then((chatDoc) => {
            const userJoin = {
                uid: id,
                type: 'join',
                timestamp: this.getTimestamp()
            };
            return this.submitOp(chatDoc, [{ p: ['messages', chatDoc.data['messages']['length']], li: userJoin }]);
        }).catch((err) => {
            console.error(err);
        });
    }
    getChannelName() { return this.channelName; }
    ;
    getChannelID() { return this.channelID; }
    ;
    getShareDBNamespace() { return this.getChannelName() + this.getChannelID(); }
    getShareDBObject(docName, type, defaultContents) {
        return new Promise((resolve, reject) => {
            const connection = this.sharedb.connect();
            const doc = connection.get(this.getShareDBNamespace(), docName);
            doc.fetch((err) => {
                if (err) {
                    reject(err);
                }
                else if (doc.type === null) {
                    doc.create(defaultContents, type, () => {
                        Logger.debug(`Created doc ${docName}`);
                        resolve(doc);
                    });
                }
                else {
                    resolve(doc);
                }
            });
        });
    }
    getShareDBChat() { return this.getShareDBObject('chat', 'json0', { 'activeUsers': {}, 'allUsers': {}, 'messages': [], }); }
    ;
    getShareDBEditors() { return this.getShareDBObject('editors', 'json0', []); }
    ;
    getShareDBCursors() { return this.getShareDBObject('cursors', 'json0', {}); }
    ;
    getEditorValues(version) {
        let content = [];
        let editorValues = new Map();
        const jsonType = ShareDB.types.map['json0'];
        return this.getEditorOps(0, version).then((ops) => {
            _.each(ops, (op, i) => {
                if (op['create']) {
                    // content = _.clone(op['data']);
                }
                else {
                    content = jsonType.apply(content, op.op);
                }
            });
            _.each(content, (editorInfo) => {
                editorValues.set(editorInfo.id, editorInfo);
            });
            return editorValues;
        });
    }
    getEditorOps(fromVersion, toVersion, opts = {}) {
        return new Promise((resolve, reject) => {
            this.sharedb.db.getOps(this.getShareDBNamespace(), 'editors', fromVersion, toVersion, opts, (err, data) => {
                if (err) {
                    reject(err);
                }
                else {
                    resolve(data);
                }
            });
        });
    }
    ;
    selfDestruct() {
        this.emit('self-destruct');
    }
    ;
    startSelfDestructTimer() {
        if (this.selfDestructTimeout === null) {
            this.selfDestructTimeout = setTimeout(() => {
                this.selfDestruct();
            }, this.selfDestructDelay);
        }
    }
    ;
    stopSelfDestructTimer() {
        clearTimeout(this.selfDestructTimeout);
        this.selfDestructTimeout = null;
    }
    isEmpty() {
        return this.members.size === 0;
    }
    destroy() {
        Logger.info(`Channel ${this.getChannelName()} (${this.getChannelID()}) was destroyed`);
    }
}
ChatCodesChannelServer.NUM_COLORS = 4;
exports.ChatCodesChannelServer = ChatCodesChannelServer;
class ChatCodesServer {
    constructor(shareDBPort, shareDBURL) {
        this.shareDBPort = shareDBPort;
        this.shareDBURL = shareDBURL;
        this.members = {};
        this.app = express();
        this.channels = new Map();
        this.app.use('/:channelName', (req, res, next) => {
            next();
        }, express.static(path.join(__dirname, '..', 'cc_web')));
        this.app.use(express.static(path.join(__dirname, '..', 'cc_web')));
        // this.app.get('*', (req, res) => {
        // 	console.log(req);
        // })
        this.server = http.createServer(this.app);
        this.wss = new WebSocket.Server({ server: this.server });
        this.setupShareDB();
    }
    setupShareDB() {
        if (this.shareDBURL) {
            this.db = ShareDBMongo(this.shareDBURL);
        }
        else {
            this.db = new ShareDBMingo();
        }
        this.sharedb = new ShareDB({ db: this.db });
        this.wss.on('connection', (ws, req) => {
            const stream = new WebSocketJSONStream(ws);
            this.sharedb.listen(stream);
            ws.on('message', (str) => {
                try {
                    const data = JSON.parse(str);
                    if (data.cc === 1) {
                        const { type } = data;
                        if (type === 'request-join-room') {
                            const { payload, messageID } = data;
                            const channel = payload['channel'];
                            const cs = this.createNamespace(channel);
                            cs.addMember(payload, ws).then(() => {
                                ws.send(JSON.stringify({
                                    channel,
                                    messageID,
                                    cc: 2,
                                    payload: {
                                        id: cs.getChannelID(),
                                        ns: cs.getShareDBNamespace()
                                    }
                                }));
                            });
                        }
                        else if (type === 'channel-available') {
                            const { payload, channel, messageID } = data;
                            this.nobodyThere(channel).then((isEmpty) => {
                                ws.send(JSON.stringify({
                                    channel,
                                    messageID,
                                    cc: 2,
                                    payload: isEmpty
                                }));
                            });
                        }
                    }
                }
                catch (e) {
                    console.error(e);
                }
            });
        });
        this.server.listen(this.shareDBPort);
        Logger.info(`Created ShareDB server on port ${this.shareDBPort}`);
    }
    createNamespace(channelName) {
        if (!this.channels.has(channelName)) {
            const channelServer = new ChatCodesChannelServer(this.sharedb, this.wss, channelName);
            channelServer.on('self-destruct', () => {
                this.destructNamespace(channelName);
            });
            this.channels.set(channelName, channelServer);
        }
        const channelServer = this.channels.get(channelName);
        return channelServer;
    }
    destructNamespace(channelName) {
        if (this.channels.has(channelName)) {
            const channelServer = this.channels.get(channelName);
            this.channels.delete(channelName);
            channelServer.destroy();
        }
    }
    nobodyThere(channelName) {
        return new Promise((resolve, reject) => {
            if (this.channels.has(channelName)) {
                resolve(false);
            }
            else {
                resolve(true);
            }
        });
    }
    ;
}
exports.ChatCodesServer = ChatCodesServer;
const optionDefinitions = [
    { name: 'usemongo', alias: 'u', type: Boolean, defaultValue: true },
    { name: 'mongocreds', alias: 'm', type: String, defaultValue: path.join(__dirname, '..', 'db_creds.json') },
    { name: 'wsport', alias: 'w', type: Number, defaultValue: 8000 },
];
const options = commandLineArgs(optionDefinitions);
function getCredentials(filename) {
    return new Promise((resolve, reject) => {
        fs.readFile(filename, 'utf-8', (err, contents) => {
            if (err) {
                reject(err);
            }
            resolve(contents);
        });
    }).then((contents) => {
        return JSON.parse(contents);
    });
}
getCredentials(options['mongocreds']).then((info) => {
    const mongoDBURL = options['usemongo'] ? info['url'] : null;
    return new ChatCodesServer(options.wsport, mongoDBURL);
});
function s4() {
    return Math.floor((1 + Math.random()) * 0x10000)
        .toString(16)
        .substring(1);
}
//# sourceMappingURL=cc_server.js.map