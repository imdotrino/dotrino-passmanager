// Prueba E2E contra el proxio DE VERDAD: una bóveda que responde y un aparato que
// pide, en procesos distintos y con identidades distintas.
//
// No sustituye a `lib/test` (que prueba la lógica con una red de mentira): esto
// comprueba el camino real — proxy-client, identify, cola por pubkey y el protocolo
// entre las dos puntas. Se corre a mano porque necesita red:
//
//   node test/e2e.mjs aparato                     # imprime su código y sale
//   APARATO_PUBKEY=<json> node test/e2e.mjs boveda &
//   BOVEDA_PUBKEY=<código> node test/e2e.mjs aparato
//
// Tiene que salir: find con metadatos y SIN secretos, get con la credencial, list
// rechazado, y las dos peticiones en la bitácora del lado que responde.
import { WebSocketProxyClient, setKeypairStore, getPublicKeyJwk, signData } from '@dotrino/proxy-client'
import { LocalVault } from '../lib/src/vault/local.js'
import { RemoteVault } from '../lib/src/vault/remote.js'
import { VaultResponder } from '../lib/src/vault/responder.js'
import { ProxyTransport } from '../lib/src/transport/proxy.js'
import { makeEncKeypair, importEncPrivate, exportEncPrivate } from '../lib/src/transport/sealed.js'
import { makeVaultKey } from '../lib/src/crypto.js'

const URL = 'wss://proxy.dotrino.com'
const rol = process.argv[2]

// Cada rol conserva su llave entre pasadas: si cambiara, el otro lado lo vería como
// un aparato distinto — que es exactamente el fallo que se arregló en 0.12.0.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
const KEYFILE = `/tmp/e2e-${rol}.json`
const ALG = { name: 'ECDSA', namedCurve: 'P-256' }
setKeypairStore({
  async get () {
    if (!existsSync(KEYFILE)) return null
    const { privateJwk, publicJwk } = JSON.parse(readFileSync(KEYFILE, 'utf8'))
    return {
      privateKey: await crypto.subtle.importKey('jwk', privateJwk, ALG, true, ['sign']),
      publicKey: await crypto.subtle.importKey('jwk', publicJwk, ALG, true, ['verify']),
      publicJwk,
    }
  },
  async set ({ privateKey, publicKey, publicJwk }) {
    writeFileSync(KEYFILE, JSON.stringify({
      privateJwk: await crypto.subtle.exportKey('jwk', privateKey),
      publicJwk: publicJwk || await crypto.subtle.exportKey('jwk', publicKey),
    }))
  },
}, { extractable: true })

/** El par de cifrado de cada rol, persistido igual que el de firma. */
async function encKeypair () {
  const F = `/tmp/e2e-${rol}-enc.json`
  if (existsSync(F)) {
    const { privateJwk, encPub } = JSON.parse(readFileSync(F, 'utf8'))
    return { privateKey: await importEncPrivate(privateJwk), encPub }
  }
  const nuevo = await makeEncKeypair()
  writeFileSync(F, JSON.stringify({
    privateJwk: await exportEncPrivate(nuevo.privateKey),
    encPub: nuevo.encPub,
  }))
  return { privateKey: nuevo.privateKey, encPub: nuevo.encPub }
}

async function conectar () {
  const c = new WebSocketProxyClient({ url: URL, enableWebRTC: false })
  await c.connect()
  const publickey = await getPublicKeyJwk()
  const data = { op: 'identify', publickey, token: c.token, ts: Date.now() }
  const r = await c.identify({ data, signature: await signData(data) })
  return { c, publickey, identify: r }
}

if (rol === 'boveda') {
  const { c, publickey, identify } = await conectar()
  const vault = new LocalVault({ _m: new Map(), async get (k) { return this._m.get(k) }, async set (k, v) { this._m.set(k, v) } })
  vault.unlock(await makeVaultKey())
  await vault.put({ title: 'Salesforce', sites: ['salesforce.com'], username: 'sandrade@dotrino.com', secret: 'hunter2' })
  await vault.put({ title: 'Banco', sites: ['banco.com.ec'], username: 'seyacat', secret: 's3cr3t' })

  const permitido = process.env.APARATO_PUBKEY
  const permitidoEnc = process.env.APARATO_ENCPUB
  const enc = await encKeypair()
  const responder = new VaultResponder({
    client: c,
    vault,
    myEncPrivateKey: enc.privateKey,
    encPubOf: pub => (pub === permitido ? permitidoEnc : null),
    isAllowed: pub => pub === permitido,
    needsApproval: () => false,
    onRequest: r => console.log('BOVEDA log:', r.op, r.outcome),
  })
  responder.start()
  console.log('BOVEDA_LISTA', Buffer.from(publickey).toString('base64url'))
  console.log('BOVEDA_ENCPUB', Buffer.from(enc.encPub).toString('base64url'))
  console.log('BOVEDA identify:', JSON.stringify(identify))
  setTimeout(() => process.exit(0), 40000)
}

if (rol === 'aparato') {
  const { c, publickey } = await conectar()
  const enc = await encKeypair()
  console.log('APARATO_PUBKEY', Buffer.from(publickey).toString('base64url'))
  console.log('APARATO_ENCPUB', Buffer.from(enc.encPub).toString('base64url'))
  if (!process.env.BOVEDA_PUBKEY) process.exit(0)

  const peer = Buffer.from(process.env.BOVEDA_PUBKEY, 'base64url').toString('utf8')
  const peerEnc = Buffer.from(process.env.BOVEDA_ENCPUB, 'base64url').toString('utf8')

  // Espiamos el cable: esto es exactamente lo que el proxio llega a ver.
  const porElCable = []
  const enviarOriginal = c.sendByPubkey.bind(c)
  c.sendByPubkey = (to, payload) => { porElCable.push(payload); return enviarOriginal(to, payload) }

  const remota = new RemoteVault(new ProxyTransport({
    client: c, peerPubkey: peer, peerEncPub: peerEnc,
    myEncPrivateKey: enc.privateKey, timeoutMs: 20000,
  }))

  const hits = await remota.find('https://login.salesforce.com/')
  console.log('APARATO find →', JSON.stringify(hits))
  if (hits.length !== 1) { console.log('RESULTADO FALLO: find no devolvió 1'); process.exit(1) }
  if (JSON.stringify(hits).includes('hunter2')) { console.log('RESULTADO FALLO: viajó el secreto'); process.exit(1) }

  const cred = await remota.get(hits[0].id)
  console.log('APARATO get →', cred.username, '/', cred.secret)

  try {
    await remota.list()
    console.log('RESULTADO FALLO: pudo listar')
    process.exit(1)
  } catch (e) { console.log('APARATO list → rechazado:', e.code) }

  const cable = JSON.stringify(porElCable)
  const filtrado = ['salesforce.com', 'hunter2', 'sandrade@dotrino.com', '"find"', '"get"']
    .filter(x => cable.includes(x))
  console.log('APARATO cable →', filtrado.length ? 'FILTRA: ' + filtrado.join(', ') : 'nada legible')

  const ok = cred.secret === 'hunter2' && !filtrado.length
  console.log(ok ? 'RESULTADO OK' : 'RESULTADO FALLO')
  process.exit(ok ? 0 : 1)
}
