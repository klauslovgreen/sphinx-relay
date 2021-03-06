"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const models_1 = require("../models");
const jsonUtils = require("../utils/json");
const res_1 = require("../utils/res");
const helpers = require("../helpers");
const network = require("../network");
const socket = require("../utils/socket");
const hub_1 = require("../hub");
const md5 = require("md5");
const path = require("path");
const tribes = require("../utils/tribes");
const chatTribes_1 = require("./chatTribes");
const constants = require(path.join(__dirname, '../../config/constants.json'));
function getChats(req, res) {
    return __awaiter(this, void 0, void 0, function* () {
        const chats = yield models_1.models.Chat.findAll({ where: { deleted: false }, raw: true });
        const c = chats.map(chat => jsonUtils.chatToJson(chat));
        res_1.success(res, c);
    });
}
exports.getChats = getChats;
function mute(req, res) {
    return __awaiter(this, void 0, void 0, function* () {
        const chatId = req.params['chat_id'];
        const mute = req.params['mute_unmute'];
        if (!["mute", "unmute"].includes(mute)) {
            return res_1.failure(res, "invalid option for mute");
        }
        const chat = yield models_1.models.Chat.findOne({ where: { id: chatId } });
        if (!chat) {
            return res_1.failure(res, 'chat not found');
        }
        chat.update({ isMuted: (mute == "mute") });
        res_1.success(res, jsonUtils.chatToJson(chat));
    });
}
exports.mute = mute;
// just add self here if tribes
// or can u add contacts as members?
function createGroupChat(req, res) {
    return __awaiter(this, void 0, void 0, function* () {
        const { name, is_tribe, is_listed, price_per_message, price_to_join, img, description, tags, } = req.body;
        const contact_ids = req.body.contact_ids || [];
        const members = {}; //{pubkey:{key,alias}, ...}
        const owner = yield models_1.models.Contact.findOne({ where: { isOwner: true } });
        members[owner.publicKey] = {
            key: owner.contactKey, alias: owner.alias
        };
        yield asyncForEach(contact_ids, (cid) => __awaiter(this, void 0, void 0, function* () {
            const contact = yield models_1.models.Contact.findOne({ where: { id: cid } });
            members[contact.publicKey] = {
                key: contact.contactKey,
                alias: contact.alias || ''
            };
        }));
        let chatParams = null;
        let okToCreate = true;
        if (is_tribe) {
            chatParams = yield chatTribes_1.createTribeChatParams(owner, contact_ids, name, img, price_per_message, price_to_join);
            if (is_listed && chatParams.uuid) {
                // publish to tribe server
                try {
                    yield tribes.declare({
                        uuid: chatParams.uuid,
                        name: chatParams.name,
                        host: chatParams.host,
                        group_key: chatParams.groupKey,
                        price_per_message: price_per_message || 0,
                        price_to_join: price_to_join || 0,
                        description, tags, img,
                        owner_pubkey: owner.publicKey,
                        owner_alias: owner.alias,
                    });
                }
                catch (e) {
                    okToCreate = false;
                }
            }
            // make me owner when i create
            members[owner.publicKey].role = constants.chat_roles.owner;
        }
        else {
            chatParams = createGroupChatParams(owner, contact_ids, members, name);
        }
        if (!okToCreate) {
            return res_1.failure(res, 'could not create tribe');
        }
        network.sendMessage({
            chat: Object.assign(Object.assign({}, chatParams), { members }),
            sender: owner,
            type: constants.message_types.group_create,
            message: {},
            failure: function (e) {
                res_1.failure(res, e);
            },
            success: function () {
                return __awaiter(this, void 0, void 0, function* () {
                    const chat = yield models_1.models.Chat.create(chatParams);
                    if (chat.type === constants.chat_types.tribe) { // save me as owner when i create
                        yield models_1.models.ChatMember.create({
                            contactId: owner.id,
                            chatId: chat.id,
                            role: constants.chat_roles.owner,
                        });
                    }
                    res_1.success(res, jsonUtils.chatToJson(chat));
                });
            }
        });
    });
}
exports.createGroupChat = createGroupChat;
// only owner can do for tribe?
function addGroupMembers(req, res) {
    return __awaiter(this, void 0, void 0, function* () {
        const { contact_ids, } = req.body;
        const { id } = req.params;
        const members = {}; //{pubkey:{key,alias}, ...}
        const owner = yield models_1.models.Contact.findOne({ where: { isOwner: true } });
        let chat = yield models_1.models.Chat.findOne({ where: { id } });
        const contactIds = JSON.parse(chat.contactIds || '[]');
        // for all members (existing and new)
        members[owner.publicKey] = { key: owner.contactKey, alias: owner.alias };
        if (chat.type === constants.chat_types.tribe) {
            const me = yield models_1.models.ChatMember.findOne({ where: { contactId: owner.id, chatId: chat.id } });
            if (me)
                members[owner.publicKey].role = me.role;
        }
        const allContactIds = contactIds.concat(contact_ids);
        yield asyncForEach(allContactIds, (cid) => __awaiter(this, void 0, void 0, function* () {
            const contact = yield models_1.models.Contact.findOne({ where: { id: cid } });
            if (contact) {
                members[contact.publicKey] = {
                    key: contact.contactKey,
                    alias: contact.alias
                };
                const member = yield models_1.models.ChatMember.findOne({ where: { contactId: owner.id, chatId: chat.id } });
                if (member)
                    members[contact.publicKey].role = member.role;
            }
        }));
        res_1.success(res, jsonUtils.chatToJson(chat));
        network.sendMessage({
            chat: Object.assign(Object.assign({}, chat.dataValues), { contactIds: contact_ids, members }),
            sender: owner,
            type: constants.message_types.group_invite,
            message: {}
        });
    });
}
exports.addGroupMembers = addGroupMembers;
const deleteChat = (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { id } = req.params;
    const owner = yield models_1.models.Contact.findOne({ where: { isOwner: true } });
    const chat = yield models_1.models.Chat.findOne({ where: { id } });
    if (!chat) {
        return res_1.failure(res, "you are not in this group");
    }
    const tribeOwnerPubKey = chat.ownerPubkey;
    if (owner.publicKey === tribeOwnerPubKey) {
        return res_1.failure(res, "cannot leave your own tribe");
    }
    network.sendMessage({
        chat,
        sender: owner,
        message: {},
        type: constants.message_types.group_leave,
    });
    yield chat.update({
        deleted: true,
        uuid: '',
        groupKey: '',
        host: '',
        photoUrl: '',
        contactIds: '[]',
        name: ''
    });
    yield models_1.models.Message.destroy({ where: { chatId: id } });
    res_1.success(res, { chat_id: id });
});
exports.deleteChat = deleteChat;
function receiveGroupJoin(payload) {
    return __awaiter(this, void 0, void 0, function* () {
        console.log('=> receiveGroupJoin');
        const { sender_pub_key, sender_alias, chat_uuid, chat_members, chat_type, isTribeOwner, date_string } = yield helpers.parseReceiveParams(payload);
        const chat = yield models_1.models.Chat.findOne({ where: { uuid: chat_uuid } });
        if (!chat)
            return;
        const isTribe = chat_type === constants.chat_types.tribe;
        var date = new Date();
        date.setMilliseconds(0);
        if (date_string)
            date = new Date(date_string);
        let theSender = null;
        const member = chat_members[sender_pub_key];
        const senderAlias = sender_alias || (member && member.alias) || 'Unknown';
        if (!isTribe || isTribeOwner) { // dont need to create contacts for these
            const sender = yield models_1.models.Contact.findOne({ where: { publicKey: sender_pub_key } });
            const contactIds = JSON.parse(chat.contactIds || '[]');
            if (sender) {
                theSender = sender; // might already include??
                if (!contactIds.includes(sender.id))
                    contactIds.push(sender.id);
                // update sender contacT_key in case they reset?
                if (member && member.key) {
                    if (sender.contactKey !== member.key) {
                        yield sender.update({ contactKey: member.key });
                    }
                }
            }
            else {
                if (member && member.key) {
                    const createdContact = yield models_1.models.Contact.create({
                        publicKey: sender_pub_key,
                        contactKey: member.key,
                        alias: senderAlias,
                        status: 1,
                        fromGroup: true,
                    });
                    theSender = createdContact;
                    contactIds.push(createdContact.id);
                }
            }
            if (!theSender)
                return console.log('no sender'); // fail (no contact key?)
            yield chat.update({ contactIds: JSON.stringify(contactIds) });
            if (isTribeOwner) { // IF TRIBE, ADD TO XREF
                models_1.models.ChatMember.create({
                    contactId: theSender.id,
                    chatId: chat.id,
                    role: constants.chat_roles.reader,
                    lastActive: date,
                });
                chatTribes_1.replayChatHistory(chat, theSender);
                tribes.putstats({
                    uuid: chat.uuid,
                    host: chat.host,
                    member_count: contactIds.length,
                });
            }
        }
        const msg = {
            chatId: chat.id,
            type: constants.message_types.group_join,
            sender: (theSender && theSender.id) || 0,
            date: date,
            messageContent: '',
            remoteMessageContent: '',
            status: constants.statuses.confirmed,
            createdAt: date,
            updatedAt: date
        };
        if (isTribe) {
            msg.senderAlias = sender_alias;
        }
        const message = yield models_1.models.Message.create(msg);
        socket.sendJson({
            type: 'group_join',
            response: {
                contact: jsonUtils.contactToJson(theSender || {}),
                chat: jsonUtils.chatToJson(chat),
                message: jsonUtils.messageToJson(message, null)
            }
        });
    });
}
exports.receiveGroupJoin = receiveGroupJoin;
function receiveGroupLeave(payload) {
    return __awaiter(this, void 0, void 0, function* () {
        console.log('=> receiveGroupLeave');
        const { sender_pub_key, chat_uuid, chat_type, sender_alias, isTribeOwner, date_string } = yield helpers.parseReceiveParams(payload);
        const chat = yield models_1.models.Chat.findOne({ where: { uuid: chat_uuid } });
        if (!chat)
            return;
        const isTribe = chat_type === constants.chat_types.tribe;
        let sender;
        if (!isTribe || isTribeOwner) {
            sender = yield models_1.models.Contact.findOne({ where: { publicKey: sender_pub_key } });
            if (!sender)
                return;
            const oldContactIds = JSON.parse(chat.contactIds || '[]');
            const contactIds = oldContactIds.filter(cid => cid !== sender.id);
            yield chat.update({ contactIds: JSON.stringify(contactIds) });
            if (isTribeOwner) {
                if (chat_type === constants.chat_types.tribe) {
                    try {
                        yield models_1.models.ChatMember.destroy({ where: { chatId: chat.id, contactId: sender.id } });
                    }
                    catch (e) { }
                    tribes.putstats({
                        uuid: chat.uuid,
                        host: chat.host,
                        member_count: contactIds.length,
                    });
                }
            }
        }
        var date = new Date();
        date.setMilliseconds(0);
        if (date_string)
            date = new Date(date_string);
        const msg = {
            chatId: chat.id,
            type: constants.message_types.group_leave,
            sender: (sender && sender.id) || 0,
            date: date,
            messageContent: '',
            remoteMessageContent: '',
            status: constants.statuses.confirmed,
            createdAt: date,
            updatedAt: date
        };
        if (isTribe) {
            msg.senderAlias = sender_alias;
        }
        const message = yield models_1.models.Message.create(msg);
        socket.sendJson({
            type: 'group_leave',
            response: {
                contact: jsonUtils.contactToJson(sender),
                chat: jsonUtils.chatToJson(chat),
                message: jsonUtils.messageToJson(message, null)
            }
        });
    });
}
exports.receiveGroupLeave = receiveGroupLeave;
function validateTribeOwner(chat_uuid, pubkey) {
    return __awaiter(this, void 0, void 0, function* () {
        const verifiedOwnerPubkey = yield tribes.verifySignedTimestamp(chat_uuid);
        if (verifiedOwnerPubkey === pubkey) {
            return true;
        }
        return false;
    });
}
function receiveGroupCreateOrInvite(payload) {
    return __awaiter(this, void 0, void 0, function* () {
        const { sender_pub_key, chat_members, chat_name, chat_uuid, chat_type, chat_host, chat_key } = yield helpers.parseReceiveParams(payload);
        // maybe this just needs to move to adding tribe owner ChatMember?
        const isTribe = chat_type === constants.chat_types.tribe;
        if (isTribe) { // must be sent by tribe owner?????
            const validOwner = yield validateTribeOwner(chat_uuid, sender_pub_key);
            if (!validOwner)
                return console.log('[tribes] invalid uuid signature!');
        }
        const contacts = [];
        const newContacts = [];
        for (let [pubkey, member] of Object.entries(chat_members)) {
            const contact = yield models_1.models.Contact.findOne({ where: { publicKey: pubkey } });
            let addContact = false;
            if (chat_type === constants.chat_types.group && member && member.key) {
                addContact = true;
            }
            else if (isTribe && member && member.role) {
                if (member.role === constants.chat_roles.owner || member.role === constants.chat_roles.admin || member.role === constants.chat_roles.mod) {
                    addContact = true;
                }
            }
            if (addContact) {
                if (!contact) {
                    const createdContact = yield models_1.models.Contact.create({
                        publicKey: pubkey,
                        contactKey: member.key,
                        alias: member.alias || 'Unknown',
                        status: 1,
                        fromGroup: true,
                    });
                    contacts.push(Object.assign(Object.assign({}, createdContact.dataValues), { role: member.role }));
                    newContacts.push(createdContact.dataValues);
                }
                else {
                    contacts.push(Object.assign(Object.assign({}, contact.dataValues), { role: member.role }));
                }
            }
        }
        const owner = yield models_1.models.Contact.findOne({ where: { isOwner: true } });
        const contactIds = contacts.map(c => c.id);
        if (!contactIds.includes(owner.id))
            contactIds.push(owner.id);
        // make chat
        let date = new Date();
        date.setMilliseconds(0);
        const chat = yield models_1.models.Chat.create(Object.assign(Object.assign({ uuid: chat_uuid, contactIds: JSON.stringify(contactIds), createdAt: date, updatedAt: date, name: chat_name, type: chat_type || constants.chat_types.group }, chat_host && { host: chat_host }), chat_key && { groupKey: chat_key }));
        if (isTribe) { // IF TRIBE, ADD TO XREF
            contacts.forEach(c => {
                models_1.models.ChatMember.create({
                    contactId: c.id,
                    chatId: chat.id,
                    role: c.role || constants.chat_roles.reader,
                    lastActive: date,
                });
            });
        }
        socket.sendJson({
            type: 'group_create',
            response: jsonUtils.messageToJson({ newContacts }, chat)
        });
        hub_1.sendNotification(chat, chat_name, 'group');
        if (payload.type === constants.message_types.group_invite) {
            const owner = yield models_1.models.Contact.findOne({ where: { isOwner: true } });
            network.sendMessage({
                chat: Object.assign(Object.assign({}, chat.dataValues), { members: {
                        [owner.publicKey]: {
                            key: owner.contactKey,
                            alias: owner.alias || ''
                        }
                    } }),
                sender: owner,
                message: {},
                type: constants.message_types.group_join,
            });
        }
    });
}
exports.receiveGroupCreateOrInvite = receiveGroupCreateOrInvite;
function createGroupChatParams(owner, contactIds, members, name) {
    let date = new Date();
    date.setMilliseconds(0);
    if (!(owner && members && contactIds && Array.isArray(contactIds))) {
        return;
    }
    const pubkeys = [];
    for (let pubkey of Object.keys(members)) { // just the key
        pubkeys.push(String(pubkey));
    }
    if (!(pubkeys && pubkeys.length))
        return;
    const allkeys = pubkeys.includes(owner.publicKey) ? pubkeys : [owner.publicKey].concat(pubkeys);
    const hash = md5(allkeys.sort().join("-"));
    const theContactIds = contactIds.includes(owner.id) ? contactIds : [owner.id].concat(contactIds);
    return {
        uuid: `${new Date().valueOf()}-${hash}`,
        contactIds: JSON.stringify(theContactIds),
        createdAt: date,
        updatedAt: date,
        name: name,
        type: constants.chat_types.group
    };
}
function asyncForEach(array, callback) {
    return __awaiter(this, void 0, void 0, function* () {
        for (let index = 0; index < array.length; index++) {
            yield callback(array[index], index, array);
        }
    });
}
//# sourceMappingURL=chats.js.map