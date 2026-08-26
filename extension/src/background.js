// Service worker: el aparato que PIDE. No tiene la bóveda ni la llave.
//
// Cuando hace falta una credencial, se la pide a la bóveda del usuario por el
// transporte del ecosistema (@dotrino/proxy-client) y recibe esa sola. Aquí no hay
// nada que descifrar, nada que guardar entre siestas del worker y nada que perder si
// alguien se hace con la extensión: sin bóveda al otro lado, esto no sabe nada.

import { WebSocketProxyClient, getPublicKeyJwk, signData } from './vendor/proxy-client/index.js'
import { RemoteVault } from './vendor/passmanager/vault/remote.js'
import { ProxyTransport } from './vendor/passmanager/transport/proxy.js'
import { SessionCache } from './vendor/passmanager/session-cache.js'
import { makeEncKeypair, importEncPrivate, exportEncPrivate } from './vendor/passmanager/transport/sealed.js'
import { VaultError, CODES } from './vendor/passmanager/vault/errors.js'

const LINK = 'passmanager/link/v1'
const ENC = 'passmanager/enc/v1'
const PROXY_URL = 'wss://proxy.dotrino.com'

const store = {
  async get (k) { return (await chrome.storage.local.get(k))[k] },
  async set (k, v) { await chrome.storage.local.set({ [k]: v }) },
  async del (k) { await chrome.storage.local.remove(k) },
}

let client = null
let transport = null
let vault = null

/**
 * Par de CIFRADO de este aparato, aparte del de firma que lleva proxy-client. El de
 * firma dice quién soy al proxio; a este se le sella el contenido, para que el proxio
 * no vea a qué sitio se pide credencial ni cuál se devuelve.
 */
async function encKeypair () {
  const guardado = await store.get(ENC)
  if (guardado) {
    return { privateKey: await importEncPrivate(guardado.privateJwk), encPub: guardado.encPub }
  }
  const nuevo = await makeEncKeypair()
  await store.set(ENC, {
    privateJwk: await exportEncPrivate(nuevo.privateKey),
    encPub: nuevo.encPub,
  })
  return { privateKey: nuevo.privateKey, encPub: nuevo.encPub }
}

/** El código de enlace lleva las DOS públicas: por una se enruta, a la otra se sella. */
function encodeCode ({ sign, enc }) {
  return btoa(JSON.stringify({ v: 1, sign, enc })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function decodeCode (codigo) {
  const b64 = String(codigo || '').trim().replace(/-/g, '+').replace(/_/g, '/')
  const c = JSON.parse(atob(b64))
  if (c?.v !== 1 || !c.sign || !c.enc) throw new Error('código inválido')
  return c
}

/**
 * Recuerdo de lo que la bóveda YA entregó, en memoria de sesión: entrar tres veces al
 * mismo sitio en una tarde no debería ser tres aprobaciones en el teléfono.
 *
 * `chrome.storage.session` nunca toca el disco y se vacía al cerrar el navegador. No
 * es la caché descartada del diseño (§3.1): aquí no hay llave ni copia de la bóveda,
 * solo lo poco que ya pasó por delante.
 */
const cache = new SessionCache({
  async get (k) { return (await chrome.storage.session.get(k))[k] },
  async set (k, v) { await chrome.storage.session.set({ [k]: v }) },
})

/**
 * La identidad de la extensión la lleva proxy-client, que desde 0.12.0 la persiste en
 * IndexedDB cuando no hay localStorage — que es el caso de un service worker. Sin
 * eso el aparato cambiaría de llave cada vez que el worker se duerme, y la bóveda lo
 * vería como un desconocido en cada petición.
 */
async function connect () {
  const link = await store.get(LINK)
  if (!link) throw new VaultError('no-link', 'esta extensión no está enlazada a ninguna bóveda')

  if (vault && client?._connected) return vault

  const enc = await encKeypair()
  client = new WebSocketProxyClient({
    url: link.proxy || PROXY_URL,
    // RTCPeerConnection no existe en un service worker: con WebRTC activo la
    // negociación revienta. Y tampoco haría falta aquí.
    enableWebRTC: false,
    // La garantía: nada en claro sale ni entra. Sin esto el proxio vería a qué sitio
    // se le pide credencial y cuál se devuelve.
    requireSealed: true,
    myEncPrivateKey: enc.privateKey,
  })
  await client.connect()

  const publickey = await getPublicKeyJwk()
  const data = { op: 'identify', publickey, token: client.token, ts: Date.now() }
  await client.identify({ data, signature: await signData(data) })

  transport = new ProxyTransport({
    client,
    peerPubkey: link.peerPubkey,
    peerEncPub: link.peerEncPub,
  })
  vault = new RemoteVault(transport)
  return vault
}

async function status () {
  const link = await store.get(LINK)
  let code = null
  try {
    const enc = await encKeypair()
    code = encodeCode({ sign: await getPublicKeyJwk(), enc: enc.encPub })
  } catch { /* sin código: la vista de enlace lo dirá */ }
  return { linked: !!link, label: link?.label || null, code }
}

/** Enlazar es apuntar a QUIÉN se le pide. La bóveda tiene que autorizar por su lado. */
async function link ({ code, label }) {
  let c
  try { c = decodeCode(code) } catch { throw new VaultError('bad-code', 'ese código no es válido') }
  await store.set(LINK, {
    peerPubkey: c.sign,
    peerEncPub: c.enc,
    label: label || 'mi bóveda',
    ts: Date.now(),
  })
  vault = null
  return status()
}

async function unlink () {
  transport?.close()
  transport = null
  vault = null
  client = null
  // Desenlazar tiene que dejar el navegador sin nada: si quedara el recuerdo de lo
  // entregado, «desenlazado» sería mentira hasta que caducara.
  await cache.forget()
  await store.del(LINK)
  return status()
}

const OPS = {
  status,
  link: p => link(p),
  unlink,
  find: async p => (await connect()).find(p.url),
  get: async p => {
    const recordada = await cache.get(p.id)
    if (recordada) return recordada
    const entry = await (await connect()).get(p.id)
    await cache.put(p.id, entry)
    return entry
  },
  put: async p => (await connect()).put(p.entry),
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const op = OPS[msg?.op]
  if (!op) { sendResponse({ error: { code: 'unknown-op' } }); return false }

  // Una página solo puede preguntar qué hay para su sitio y pedir una credencial.
  // Nunca enlazar, desenlazar ni escribir: si la página que tienes delante pudiera
  // cambiar a qué bóveda se le pide, podría apuntar la extensión a la suya.
  if (sender.tab && !['find', 'get', 'status'].includes(msg.op)) {
    sendResponse({ error: { code: CODES.DENIED } })
    return false
  }

  Promise.resolve(op(msg.payload || {}))
    .then(result => sendResponse({ result }))
    .catch(e => sendResponse({ error: { code: e?.code || 'error', message: e?.message } }))
  return true
})
