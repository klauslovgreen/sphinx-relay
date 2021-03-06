
import * as moment from 'moment'
import * as zbase32 from './zbase32'
import * as LND from './lightning'
import * as path from 'path'
import * as mqtt from 'mqtt'
import * as fetch from 'node-fetch'
import { models } from '../models'

const env = process.env.NODE_ENV || 'development'
const config = require(path.join(__dirname, '../../config/app.json'))[env]

let client: any

export async function connect(onMessage) {
  try {
    const info = await LND.getInfo()

    async function reconnect() {
      client = null
      const pwd = await genSignedTimestamp()
      console.log('[tribes] try to connect:', `tls://${config.tribes_host}:8883`)
      client = mqtt.connect(`tls://${config.tribes_host}:8883`, {
        username: info.identity_pubkey,
        password: pwd,
        reconnectPeriod: 0, // dont auto reconnect
      })
      client.on('connect', function () {
        console.log("[tribes] connected!")
        client.subscribe(`${info.identity_pubkey}/#`)
        updateTribeStats(info.identity_pubkey)
      })
      client.on('close', function (e) {
        setTimeout(() => reconnect(), 2000)
      })
      client.on('error', function (e) {
        console.log('[tribes] error: ', e.message || e)
      })
      client.on('message', function (topic, message) {
        if (onMessage) onMessage(topic, message)
      })
    }
    reconnect()

  } catch (e) {
    console.log("TRIBES ERROR", e)
  }
}

async function updateTribeStats(myPubkey){
  const myTribes = await models.Chat.findAll({where:{
    ownerPubkey:myPubkey
  }})
  await asyncForEach(myTribes, async(tribe)=>{
    try {
      const contactIds = JSON.parse(tribe.contactIds)
      const member_count = (contactIds&&contactIds.length)||0
      await putstats({uuid:tribe.uuid, host:tribe.host, member_count})
    } catch(e) {}
  })
  console.log(`[tribes] updated stats for ${myTribes.length} tribes`)
}

export function subscribe(topic) {
  if (client) client.subscribe(topic)
}

export function publish(topic, msg) {
  if (client) client.publish(topic, msg)
}

export async function declare({ uuid, name, description, tags, img, group_key, host, price_per_message, price_to_join, owner_alias, owner_pubkey }) {
  try {
    await fetch('https://' + host + '/tribes', {
      method: 'POST',
      body: JSON.stringify({
        uuid, group_key,
        name, description, tags, img: img || '',
        price_per_message: price_per_message || 0,
        price_to_join: price_to_join || 0,
        owner_alias, owner_pubkey,
      }),
      headers: { 'Content-Type': 'application/json' }
    })
    // const j = await r.json()
  } catch (e) {
    console.log('[tribes] unauthorized to declare')
    throw e
  }
}

export async function edit({ uuid, host, name, description, tags, img, price_per_message, price_to_join, owner_alias }) {
  try {
    const token = await genSignedTimestamp()
    await fetch('https://' + host + '/tribe?token=' + token, {
      method: 'PUT',
      body: JSON.stringify({
        uuid,
        name, description, tags, img: img || '',
        price_per_message: price_per_message || 0,
        price_to_join: price_to_join || 0,
        owner_alias,
      }),
      headers: { 'Content-Type': 'application/json' }
    })
    // const j = await r.json()
  } catch(e) {
    console.log('[tribes] unauthorized to edit')
    throw e
  }
}

export async function putstats({ uuid, host, member_count }) {
  try {
    const token = await genSignedTimestamp()
    await fetch('https://' + host + '/tribestats?token=' + token, {
      method: 'PUT',
      body: JSON.stringify({uuid, member_count}),
      headers: { 'Content-Type': 'application/json' }
    })
  } catch(e) {
    console.log('[tribes] unauthorized to putstats')
    throw e
  }
}

export async function genSignedTimestamp() {
  const now = moment().unix()
  const tsBytes = Buffer.from(now.toString(16), 'hex')
  const sig = await LND.signBuffer(tsBytes)
  const sigBytes = zbase32.decode(sig)
  const totalLength = tsBytes.length + sigBytes.length
  const buf = Buffer.concat([tsBytes, sigBytes], totalLength)
  return urlBase64(buf)
}

export async function verifySignedTimestamp(stsBase64) {
  const stsBuf = Buffer.from(stsBase64, 'base64')
  const sig = stsBuf.subarray(4, 92)
  const sigZbase32 = zbase32.encode(sig)
  const r = await LND.verifyBytes(stsBuf.subarray(0, 4), sigZbase32) // sig needs to be zbase32 :(
  if (r.valid) {
    return r.pubkey
  } else {
    return false
  }
}

export function getHost() {
  return config.tribes_host || ''
}

function urlBase64(buf) {
  return buf.toString('base64').replace(/\//g, '_').replace(/\+/g, '-')
}

async function asyncForEach(array, callback) {
	for (let index = 0; index < array.length; index++) {
	  	await callback(array[index], index, array);
	}
}