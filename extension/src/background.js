// Service worker: la bóveda de esta extensión, y el aparato que pide a otra.
//
// **Por defecto la extensión ES su propia bóveda.** Se instala y funciona: guarda aquí,
// cifrado con una llave que ni este código puede sacar. Sin emparejar nada, sin abrir
// otra pestaña, sin instalar un daemon. Es la regla del ecosistema aplicada donde toca —
// el aparato cumple el rol cuando no hay pieza dedicada— y es lo que evita que el primer
// minuto del gestor sea pedirle al usuario un código que no tiene.
//
// Enlazar una bóveda de verdad (el daemon, o `vault.dotrino.com/vault`) es el UPGRADE:
// entonces esto no guarda nada, pide de a una por el transporte del ecosistema
// (@dotrino/proxy-client) y las contraseñas viven en un solo sitio para todos tus
// navegadores. Las dos vías hablan la misma interfaz, así que de aquí para abajo casi
// nada distingue una de otra.

import { WebSocketProxyClient, getPublicKeyJwk, signData } from './vendor/proxy-client/index.js'
import { RemoteVault } from './vendor/passmanager/vault/remote.js'
import { LocalVault } from './vendor/passmanager/vault/local.js'
import { ProxyTransport } from './vendor/passmanager/transport/proxy.js'
import { SessionCache } from './vendor/passmanager/session-cache.js'
import { makeEncKeypair, importEncPrivate, exportEncPrivate } from './vendor/passmanager/transport/sealed.js'
import { VaultError, CODES } from './vendor/passmanager/vault/errors.js'
import {
  createCredential, signAssertion, credentialMatches, b64urlDecode,
} from './vendor/passmanager/webauthn.js'

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
let localVault = null

/**
 * La llave de la bóveda propia: un `CryptoKey` NO EXTRAÍBLE en IndexedDB.
 *
 * En `chrome.storage.local` no cabe —serializa a JSON, y una llave serializada es una
 * llave que se puede copiar—. IndexedDB la CLONA sin exportarla, así que no existe en
 * ninguna forma legible: ni este código puede sacarla. Lo que implica y hay que decirlo:
 * si desinstalas la extensión, la bóveda se va con ella. Para eso está exportar, y para
 * eso el daemon es el sitio de lo que quieres conservar pase lo que pase.
 */
const KEYDB = 'dotrino-passmanager'

function keyStore (mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(KEYDB, 1)
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains('kv')) open.result.createObjectStore('kv')
    }
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const tx = db.transaction('kv', mode)
      const req = fn(tx.objectStore('kv'))
      req.onsuccess = () => { resolve(req.result); db.close() }
      req.onerror = () => { reject(req.error); db.close() }
    }
  })
}

async function ownKey () {
  const saved = await keyStore('readonly', s => s.get('cek'))
  // Se comprueba QUÉ hay guardado, no solo que haya algo: un valor de otra versión
  // revienta dentro de WebCrypto con un error que no dice de dónde viene.
  if (saved instanceof CryptoKey) return saved
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  await keyStore('readwrite', s => s.put(key, 'cek'))
  return key
}

/** La bóveda propia. Las entradas van cifradas, así que su sitio es el storage normal. */
async function ownVault () {
  if (localVault) return localVault
  const v = new LocalVault(store)
  v.unlock(await ownKey())
  localVault = v
  return v
}

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
  // Sin enlace no hay error: hay bóveda. La propia.
  if (!link) return ownVault()

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
  // `mode` es lo que el popup enseña: quien no enlazó nada no está «sin bóveda», está
  // usando la suya. Decirle lo contrario es empujarle a configurar lo que no necesita.
  let count = 0
  if (!link) { try { count = (await (await ownVault()).list()).length } catch { /* recién instalada */ } }
  return { mode: link ? 'linked' : 'own', linked: !!link, label: link?.label || null, code, count }
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
  // Desenlazar deja de nuevo la bóveda propia, que es de donde se venía.
  // Y el navegador sin recuerdos: si quedara el recuerdo de lo
  // entregado, «desenlazado» sería mentira hasta que caducara.
  await cache.forget()
  await store.del(LINK)
  return status()
}

// --- passkeys ----------------------------------------------------------------
//
// La llave se genera aquí y se manda a la bóveda para que la CUSTODIE; firmar exige
// pedírsela, igual que cualquier otra credencial. El aparato no se queda con nada.

async function webauthnCreate (p) {
  const v = await connect()
  const { entry, response } = await createCredential({
    rpId: p.rpId,
    origin: p.origin,
    challenge: p.challenge,
    userHandle: p.userHandle ? b64urlDecode(p.userHandle) : null,
    userName: p.userName,
  })

  // Se guarda ANTES de devolverla: si el sitio la registra y nosotros no la tenemos,
  // el usuario se queda fuera de su cuenta sin saber por qué.
  await v.put({
    type: 'webauthn',
    title: p.rpName || p.rpId,
    sites: [p.rpId],
    username: p.userName || '',
    webauthn: entry,
  })
  return response
}

async function webauthnGet (p) {
  const v = await connect()
  const candidatas = await v.find(`https://${p.rpId}/`)

  // Solo las passkeys de ESTE sitio, y solo las que el sitio admite.
  const suyas = candidatas.filter(e => e.hasWebauthn)
  if (!suyas.length) throw new VaultError(CODES.NOT_FOUND, 'no hay passkey para este sitio')

  for (const meta of suyas) {
    const entrada = await v.get(meta.id)
    if (!credentialMatches(entrada, p.rpId, p.allowCredentials)) continue

    const { signCount, response } = await signAssertion({
      entry: entrada.webauthn,
      origin: p.origin,
      challenge: p.challenge,
    })
    // El contador tiene que subir en la bóveda: si se queda quieto, el servidor
    // sospecha que la credencial está clonada.
    await v.put({ ...entrada, webauthn: { ...entrada.webauthn, signCount } })
    return response
  }
  throw new VaultError(CODES.NOT_FOUND, 'ninguna passkey sirve para lo que pide el sitio')
}

const OPS = {
  status,
  'webauthn-create': webauthnCreate,
  'webauthn-get': webauthnGet,
  link: p => link(p),
  unlink,
  find: async p => (await connect()).find(p.url),
  get: async p => {
    const v = await connect()
    // La caché existe para no repetir aprobaciones en el teléfono. Con la bóveda propia
    // no hay aprobación que ahorrar, y guardar un secreto que no hace falta es peor.
    if (v === localVault) return v.get(p.id)
    const recordada = await cache.get(p.id)
    if (recordada) return recordada
    const entry = await v.get(p.id)
    await cache.put(p.id, entry)
    return entry
  },
  put: async p => (await connect()).put(p.entry),
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const op = OPS[msg?.op]
  if (!op) { sendResponse({ error: { code: 'unknown-op' } }); return false }

  // Una PÁGINA solo puede preguntar qué hay para su sitio y pedir una credencial;
  // nunca enlazar, desenlazar ni escribir. Si la página que tienes delante pudiera
  // cambiar a qué bóveda se le pide, podría apuntar la extensión a la suya.
  //
  // La señal NO es `sender.tab`: las páginas de la propia extensión también corren en
  // una pestaña cuando se abren así (`chrome-extension://<id>/src/popup.html`), y con
  // esa comprobación el popup abierto en pestaña no podía ni enlazar. Lo que distingue
  // a una página ajena es su ORIGEN.
  const deLaExtension = (sender.origin || sender.url || '').startsWith(`chrome-extension://${chrome.runtime.id}`)
  if (!deLaExtension && !['find', 'get', 'status', 'webauthn-create', 'webauthn-get'].includes(msg.op)) {
    sendResponse({ error: { code: CODES.DENIED } })
    return false
  }

  Promise.resolve(op(msg.payload || {}))
    .then(result => sendResponse({ result }))
    .catch(e => sendResponse({ error: { code: e?.code || 'error', message: e?.message } }))
  return true
})
