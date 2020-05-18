import * as path from 'path'
import * as lndService from '../grpc'
import {getInfo} from '../utils/lightning'
import {controllers} from '../controllers'
import * as tribes from '../utils/tribes'
import {SPHINX_CUSTOM_RECORD_KEY, verifyAscii} from '../utils/lightning'
import { models } from '../models'
import {sendMessage} from './send'
import {modifyPayload} from './modify'

const constants = require(path.join(__dirname,'../../config/constants.json'))
const msgtypes = constants.message_types

const typesToForward=[
	msgtypes.message, msgtypes.group_join, msgtypes.group_leave, msgtypes.attachment
]
const typesToModify=[
	msgtypes.attachment
]
async function onReceive(payload){
	console.log("=>>> onReceive",payload)
	// if tribe, owner must forward to MQTT
	let doAction = true
	const toAddIn:{[k:string]:any} = {}
	const isTribe = payload.chat && payload.chat.type===constants.chat_types.tribe
	if(isTribe && typesToForward.includes(payload.type)){
		const tribeOwnerPubKey = await tribes.verifySignedTimestamp(payload.chat.uuid)
		const owner = await models.Contact.findOne({where: {isOwner:true}})
		if(owner.publicKey===tribeOwnerPubKey){
			// CHECK PRICES
			toAddIn.isTribeOwner = true
			const chat = await models.Chat.findOne({where:{uuid:payload.chat.uuid}})
			if(payload.type===msgtypes.group_join) {
				if(payload.message.amount<chat.priceToJoin) doAction=false
			}
			if(payload.type===msgtypes.message) {
				if(payload.message.amount<chat.pricePerMessage) doAction=false
			}
			if(doAction) forwardMessageToTribe(payload)
			else console.log('insufficient payment for this action')
		}
	}
	if(doAction) {
		if(ACTIONS[payload.type]) {
			ACTIONS[payload.type]({...payload, ...toAddIn})
		} else {
			console.log('Incorrect payload type:', payload.type)
		}
	}
}

async function forwardMessageToTribe(ogpayload){
	const chat = await models.Chat.findOne({where:{uuid:ogpayload.chat.uuid}})

	let payload
	if(typesToModify.includes(ogpayload.type)){
		payload = await modifyPayload(ogpayload, chat)
	} else {
		payload = ogpayload
	}
	console.log("FORWARD TO TRIBE",payload) // filter out the sender?
	
	//const sender = await models.Contact.findOne({where:{publicKey:payload.sender.pub_key}})
	const owner = await models.Contact.findOne({where:{isOwner:true}})
	const type = payload.type
	const message = payload.message
	// HERE: NEED TO MAKE SURE ALIAS IS UNIQUE
	// ASK xref TABLE and put alias there too?
	sendMessage({
		sender: {
			...owner.dataValues, // ADD IN REAL ALIAS HERE??!
			...payload.sender&&payload.sender.alias && {alias:payload.sender.alias}
		},
		chat, type, message,
		skipPubKey: payload.sender.pub_key, 
		success: ()=>{},
		receive: ()=>{}
	})
}

const ACTIONS = {
    [msgtypes.contact_key]: controllers.contacts.receiveContactKey,
    [msgtypes.contact_key_confirmation]: controllers.contacts.receiveConfirmContactKey,
    [msgtypes.message]: controllers.messages.receiveMessage,
    [msgtypes.invoice]: controllers.invoices.receiveInvoice,
    [msgtypes.direct_payment]: controllers.payments.receivePayment,
    [msgtypes.confirmation]: controllers.confirmations.receiveConfirmation,
    [msgtypes.attachment]: controllers.media.receiveAttachment,
    [msgtypes.purchase]: controllers.media.receivePurchase,
    [msgtypes.purchase_accept]: controllers.media.receivePurchaseAccept,
    [msgtypes.purchase_deny]: controllers.media.receivePurchaseDeny,
    [msgtypes.group_create]: controllers.chats.receiveGroupCreateOrInvite,
    [msgtypes.group_invite]: controllers.chats.receiveGroupCreateOrInvite,
    [msgtypes.group_join]: controllers.chats.receiveGroupJoin,
    [msgtypes.group_leave]: controllers.chats.receiveGroupLeave,
}

export async function initGrpcSubscriptions() {
	try{
		await getInfo()
		await lndService.subscribeInvoices(parseKeysendInvoice)
	} catch(e) {
		throw e
	}
}

export async function initTribesSubscriptions(){
	tribes.connect(async(topic, message)=>{ // onMessage callback
		try{
			const msg = message.toString()
			console.log("=====> msg received! TOPIC", topic, "MESSAGE", msg)
			// check topic is signed by sender?
			const payload = await parseAndVerifyPayload(msg)
			onReceive(payload)
		} catch(e){}
    })
}

// VERIFY PUBKEY OF SENDER from sig
async function parseAndVerifyPayload(data){
	let payload
	const li = data.lastIndexOf('}')
	const msg = data.substring(0,li+1)
	const sig = data.substring(li+1)
	try {
		payload = JSON.parse(msg)
		if(payload) {
			const v = await verifyAscii(msg, sig)
			if(v && v.valid && v.pubkey) {
				payload.sender = payload.sender||{}
				payload.sender.pub_key=v.pubkey
				return payload
			}
		}
	} catch(e) {
		return null
	}
}

export async function parseKeysendInvoice(i){
	const recs = i.htlcs && i.htlcs[0] && i.htlcs[0].custom_records
	const buf = recs && recs[SPHINX_CUSTOM_RECORD_KEY]
	const data = buf && buf.toString()
	const value = i && i.value && parseInt(i.value)
	if(!data) return

	let payload
	if(data[0]==='{'){
		try {
			payload = await parseAndVerifyPayload(data)
		} catch(e){}
	} else {
		const threads = weave(data)
		if(threads) payload = await parseAndVerifyPayload(threads)
	}
	if(payload){
		const dat = payload
		if(value && dat && dat.message){
			dat.message.amount = value // ADD IN TRUE VALUE
        }
		onReceive(dat)
	}
}

const chunks = {}
function weave(p){
	const pa = p.split('_')
	if(pa.length<4) return
	const ts = pa[0]
	const i = pa[1]
	const n = pa[2]
	const m = pa.filter((u,i)=>i>2).join('_')
	chunks[ts] = chunks[ts] ? [...chunks[ts], {i,n,m}] : [{i,n,m}]
	if(chunks[ts].length===parseInt(n)){
		// got em all!
		const all = chunks[ts]
		let payload = ''
		all.slice().sort((a,b)=>a.i-b.i).forEach(obj=>{
			payload += obj.m
		})
		delete chunks[ts]
		return payload
	}
}