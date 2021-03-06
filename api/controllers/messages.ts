import {models} from '../models'
import { Op } from 'sequelize' 
import { indexBy } from 'underscore'
import { sendNotification } from '../hub'
import * as socket from '../utils/socket'
import * as jsonUtils from '../utils/json'
import * as helpers from '../helpers'
import { success } from '../utils/res'
import {sendConfirmation} from './confirmations'
import * as path from 'path'
import * as network from '../network'
import * as short from 'short-uuid'

const constants = require(path.join(__dirname,'../../config/constants.json'))

const getMessages = async (req, res) => {
	const dateToReturn = req.query.date;

	if (!dateToReturn) {
		return getAllMessages(req, res)
	}
	console.log(dateToReturn)
	const owner = await models.Contact.findOne({ where: { isOwner: true } })
	// const chatId = req.query.chat_id

	let newMessagesWhere = {
		date: { [Op.gte]: dateToReturn },
		[Op.or]: [
			{receiver: owner.id}, 
			{receiver: null}
		]
	}
	
	let confirmedMessagesWhere = {
		updated_at: { [Op.gte]: dateToReturn },
		status: constants.statuses.received,
		sender: owner.id
	}

	// if (chatId) {
	// 	newMessagesWhere.chat_id = chatId
	// 	confirmedMessagesWhere.chat_id = chatId
	// }

	const newMessages = await models.Message.findAll({ where: newMessagesWhere })
	const confirmedMessages = await models.Message.findAll({ where: confirmedMessagesWhere })

	const chatIds: number[] = []
	newMessages.forEach(m => {
		if(!chatIds.includes(m.chatId)) chatIds.push(m.chatId)
	})
	confirmedMessages.forEach(m => {
		if(!chatIds.includes(m.chatId)) chatIds.push(m.chatId)
	})

	let chats = chatIds.length > 0 ? await models.Chat.findAll({ where: {deleted:false, id: chatIds} }) : []
	const chatsById = indexBy(chats, 'id')

	res.json({
		success: true,
		response: {
			new_messages: newMessages.map(message => 
				jsonUtils.messageToJson(message, chatsById[parseInt(message.chatId)])
			),
			confirmed_messages: confirmedMessages.map(message => 
				jsonUtils.messageToJson(message, chatsById[parseInt(message.chatId)])
			)
		}
	});
	res.status(200)
	res.end()
}

const getAllMessages = async (req, res) => {
	const limit = (req.query.limit && parseInt(req.query.limit)) || 1000
	const offset = (req.query.offset && parseInt(req.query.offset)) || 0

	const messages = await models.Message.findAll({ order: [['id', 'asc']], limit, offset })
	const chatIds = messages.map(m => m.chatId)
	console.log(`=> getAllMessages, limit: ${limit}, offset: ${offset}`)
	let chats = chatIds.length > 0 ? await models.Chat.findAll({ where: {deleted:false, id: chatIds} }) : []
	const chatsById = indexBy(chats, 'id')

	success(res, {
		new_messages: messages.map(
			message => jsonUtils.messageToJson(message, chatsById[parseInt(message.chatId)])
		),
		confirmed_messages: []
	})
};

async function deleteMessage(req, res){
	const id = req.params.id
	await models.Message.destroy({ where: {id} })
	success(res, {id})
}

const sendMessage = async (req, res) => {
	// try {
	// 	schemas.message.validateSync(req.body)
	// } catch(e) {
	// 	return failure(res, e.message)
	// }
	const {
		contact_id,
		text,
		remote_text,
		chat_id,
		remote_text_map,
		amount,
		reply_uuid,
	} = req.body

	var date = new Date();
	date.setMilliseconds(0)

  	const owner = await models.Contact.findOne({ where: { isOwner: true }})
  	const chat = await helpers.findOrCreateChat({
		chat_id,
		owner_id: owner.id,
		recipient_id: contact_id,
	})

	const remoteMessageContent = remote_text_map?JSON.stringify(remote_text_map) : remote_text
	const msg:{[k:string]:any}={
		chatId: chat.id,
		uuid: short.generate(),
		type: constants.message_types.message,
		sender: owner.id,
		amount: amount||0,
		date: date,
		messageContent: text,
		remoteMessageContent,
		status: constants.statuses.pending,
		createdAt: date,
		updatedAt: date,
	}
	if(reply_uuid) msg.replyUuid=reply_uuid
	// console.log(msg)
	const message = await models.Message.create(msg)

	success(res, jsonUtils.messageToJson(message, chat))

	const msgToSend:{[k:string]:any} = {
		id: message.id,
		uuid: message.uuid,
		content: remote_text_map || remote_text || text
	}
	if(reply_uuid) msgToSend.replyUuid=reply_uuid
	network.sendMessage({
		chat: chat,
		sender: owner,
		amount: amount||0,
		type: constants.message_types.message,
		message: msgToSend,
	})
}

const receiveMessage = async (payload) => {
	// console.log('received message', { payload })

	var date = new Date();
	date.setMilliseconds(0)

	const total_spent = 1
	const {owner, sender, chat, content, remote_content, msg_id, chat_type, sender_alias, msg_uuid, date_string, reply_uuid} = await helpers.parseReceiveParams(payload)
	if(!owner || !sender || !chat) {
		return console.log('=> no group chat!')
	}
	const text = content

	if(date_string) date=new Date(date_string)

	const msg:{[k:string]:any} = {
		chatId: chat.id,
		uuid: msg_uuid,
		type: constants.message_types.message,
		asciiEncodedTotal: total_spent,
		sender: sender.id,
		date: date,
		messageContent: text,
		createdAt: date,
		updatedAt: date,
		status: constants.statuses.received
	}
	if(chat_type===constants.chat_types.tribe) {
		msg.senderAlias = sender_alias
		if(remote_content) msg.remoteMessageContent=remote_content
	}
	if(reply_uuid) msg.replyUuid = reply_uuid
	const message = await models.Message.create(msg)

	// console.log('saved message', message.dataValues)

	socket.sendJson({
		type: 'message',
		response: jsonUtils.messageToJson(message, chat, sender)
	})

	sendNotification(chat, msg.senderAlias||sender.alias, 'message')

	const theChat = {...chat.dataValues, contactIds:[sender.id]}
	sendConfirmation({ chat:theChat, sender: owner, msg_id })
}

const readMessages = async (req, res) => {
	const chat_id = req.params.chat_id;
	
	const owner = await models.Contact.findOne({ where: { isOwner: true }})

	models.Message.update({ seen: true }, {
		where: {
		  sender: {
			[Op.ne]: owner.id
		  },
		  chatId: chat_id
		}
	});

	success(res, {})
}

const clearMessages = (req, res) => {
	models.Message.destroy({ where: {}, truncate: true })

	success(res, {})
}

export {
  getMessages,
  sendMessage,
  receiveMessage,
  clearMessages,
  readMessages,
  deleteMessage,
  getAllMessages,
}