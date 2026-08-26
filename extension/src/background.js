// Service worker: los PERFILES de esta extensión y la bóveda de cada uno.
//
// **Un perfil es una bóveda.** Igual que en el resto del ecosistema, este navegador
// puede tener varios y no se ven entre ellos: la personal y la del trabajo conviven sin
// mezclarse, y lo que ves en un sitio es lo del perfil ACTIVO.
//
// El primero nace solo, al instalar: su bóveda es esta extensión. Guarda aquí, cifrado
// con una llave que ni este código puede sacar — sin emparejar nada, sin abrir otra
// pestaña, sin daemon. Es la regla del ecosistema aplicada donde se nota: el aparato
// cumple el rol cuando no hay pieza dedicada, y el primer minuto de un gestor no puede
// ser pedirle al usuario un código que no tiene.
//
// Conectar una bóveda de verdad (el daemon, o `vault.dotrino.com/vault`) AÑADE un perfil,
// no reemplaza el que había: sigues teniendo el propio, y encima el nuevo. Ese es el
// upgrade — las contraseñas en un solo sitio para todos tus navegadores, y sobreviven a
// desinstalar esto.
//
// Cada perfil lleva lo suyo de punta a punta: su llave de la bóveda, su identidad de
// aparato y su par de cifrado. Dos bóvedas no ven el mismo aparato, y por tanto no
// pueden cruzar lo que hace uno con lo que hace el otro.

import { WebSocketProxyClient, getPublicKeyJwk, signData, setKeypairStore } from './vendor/proxy-client/index.js'
import { RemoteVault } from './vendor/passmanager/vault/remote.js'
import { LocalVault } from './vendor/passmanager/vault/local.js'
import { ProxyTransport } from './vendor/passmanager/transport/proxy.js'
import { SessionCache } from './vendor/passmanager/session-cache.js'
import { makeEncKeypair, importEncPrivate, exportEncPrivate } from './vendor/passmanager/transport/sealed.js'
import { VaultError, CODES } from './vendor/passmanager/vault/errors.js'
import {
  createCredential, signAssertion, credentialMatches, b64urlDecode,
} from './vendor/passmanager/webauthn.js'

const PROFILES = 'passmanager/profiles/v1'
const LINK = 'passmanager/link/v1'
const ENC = 'passmanager/enc/v1'
const PROXY_URL = 'wss://proxy.dotrino.com'

/** El perfil que nace con la extensión. Su nombre de clave es el de siempre, sin sufijo. */
const OWN = 'own'

/**
 * Las claves del perfil por defecto NO llevan sufijo. Así lo que ya estaba guardado
 * sigue siendo suyo sin migrar nada, y solo los perfiles nuevos añaden el suyo.
 */
const keyFor = (id, name) => (id === OWN ? name : `${name}/${id}`)

const store = {
  async get (k) { return (await chrome.storage.local.get(k))[k] },
  async set (k, v) { await chrome.storage.local.set({ [k]: v }) },
  async del (k) { await chrome.storage.local.remove(k) },
}

// Lo abierto del perfil ACTIVO. Cambiar de perfil lo tira todo: nada de un cliente
// conectado con la identidad de otro.
let client = null
let transport = null
let vault = null
let vaultOf = null      // el id de perfil al que corresponde `vault`

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

async function ownKey (id) {
  const k = keyFor(id, 'cek')
  const saved = await keyStore('readonly', s => s.get(k))
  // Se comprueba QUÉ hay guardado, no solo que haya algo: un valor de otra versión
  // revienta dentro de WebCrypto con un error que no dice de dónde viene.
  if (saved instanceof CryptoKey) return saved
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  await keyStore('readwrite', s => s.put(key, k))
  return key
}

/**
 * El almacén de UN perfil. Es el mismo `chrome.storage.local` con las claves
 * separadas: sin esto, dos perfiles propios escribirían sus entradas encima.
 */
function storeFor (id) {
  return {
    async get (k) { return store.get(keyFor(id, k)) },
    async set (k, v) { return store.set(keyFor(id, k), v) },
    async del (k) { return store.del(keyFor(id, k)) },
  }
}

/** La bóveda propia de un perfil. Las entradas van cifradas: su sitio es el storage. */
async function ownVault (id) {
  const v = new LocalVault(storeFor(id))
  v.unlock(await ownKey(id))
  return v
}

/**
 * La identidad de APARATO del perfil: su llave de firma, en IndexedDB y no extraíble.
 *
 * Se le inyecta a proxy-client con `setKeypairStore`, que además tira su caché — es lo
 * que hace que cambiar de perfil cambie de verdad quién eres ante la bóveda. Sin esto,
 * dos bóvedas verían el mismo aparato y podrían cruzar lo que hace uno con lo del otro.
 */
function useIdentityOf (id) {
  const k = keyFor(id, 'signkey')
  setKeypairStore({
    async get () { return keyStore('readonly', s => s.get(k)) },
    async set (entry) { return keyStore('readwrite', s => s.put(entry, k)) },
  })
}

// --- perfiles -----------------------------------------------------------------

/**
 * La lista de perfiles y cuál está activo. Si no hay nada, nace el propio: la extensión
 * tiene bóveda desde el primer segundo y no hay estado «sin configurar».
 */
async function profiles () {
  const saved = await store.get(PROFILES)
  if (saved?.list?.length) return saved
  // Un enlace de la versión anterior a los perfiles pasa a ser un perfil más, y el
  // propio se queda con lo que ya tenía guardado.
  const viejo = await store.get(LINK)
  const list = [{ id: OWN, kind: 'own', label: null, createdAt: Date.now() }]
  if (viejo) list.push({ id: 'p1', kind: 'linked', label: viejo.label || null, link: viejo, createdAt: viejo.ts || Date.now() })
  const fresh = { active: viejo ? 'p1' : OWN, list }
  await store.set(PROFILES, fresh)
  return fresh
}

const findProfile = (p, id) => p.list.find(x => x.id === id) || p.list[0]

async function activeProfile () {
  const p = await profiles()
  return findProfile(p, p.active)
}

async function saveProfiles (p) {
  await store.set(PROFILES, p)
  // Lo abierto era del perfil de antes: se cierra, no se reutiliza.
  transport = null
  vault = null
  vaultOf = null
  try { client?.close?.() } catch (_) {}
  client = null
}

async function useProfile ({ id }) {
  const p = await profiles()
  if (!p.list.some(x => x.id === id)) throw new VaultError('not-found', 'no hay ningún perfil con ese id')
  await saveProfiles({ ...p, active: id })
  await cache.forget()
  return status()
}

/**
 * Otro perfil con su bóveda en esta misma extensión. La personal y la del trabajo sin
 * mezclarse, sin que ninguna de las dos necesite nada fuera del navegador.
 */
async function addProfile ({ label } = {}) {
  const p = await profiles()
  const id = 'p' + (Math.max(0, ...p.list.map(x => Number(String(x.id).slice(1)) || 0)) + 1)
  const list = [...p.list, { id, kind: 'own', label: String(label || '').trim() || null, createdAt: Date.now() }]
  await saveProfiles({ active: id, list })
  await cache.forget()
  return status()
}

async function renameProfile ({ id, label }) {
  const p = await profiles()
  const list = p.list.map(x => (x.id === id ? { ...x, label: String(label || '').trim() || null } : x))
  await saveProfiles({ ...p, list })
  return status()
}

/**
 * Quitar un perfil. Se lleva TODO lo suyo: si quedara algo, «lo quité» sería mentira.
 *
 * El propio no se puede quitar mientras sea el único, porque dejaría la extensión sin
 * bóveda — que es justo el estado que este diseño existe para que no ocurra.
 */
async function removeProfile ({ id }) {
  const p = await profiles()
  if (p.list.length <= 1) throw new VaultError('denied', 'es el único perfil que hay')
  const list = p.list.filter(x => x.id !== id)
  await store.del(keyFor(id, 'passmanager/entries/v1'))
  await store.del(keyFor(id, ENC))
  try { await keyStore('readwrite', s => s.delete(keyFor(id, 'cek'))) } catch (_) {}
  try { await keyStore('readwrite', s => s.delete(keyFor(id, 'signkey'))) } catch (_) {}
  await saveProfiles({ active: p.active === id ? list[0].id : p.active, list })
  await cache.forget()
  return status()
}

/**
 * Par de CIFRADO de este aparato, aparte del de firma que lleva proxy-client. El de
 * firma dice quién soy al proxio; a este se le sella el contenido, para que el proxio
 * no vea a qué sitio se pide credencial ni cuál se devuelve.
 */
async function encKeypair (id) {
  const guardado = await store.get(keyFor(id, ENC))
  if (guardado) {
    return { privateKey: await importEncPrivate(guardado.privateJwk), encPub: guardado.encPub }
  }
  const nuevo = await makeEncKeypair()
  await store.set(keyFor(id, ENC), {
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
  const prof = await activeProfile()
  if (vault && vaultOf === prof.id && (prof.kind === 'own' || client?._connected)) return vault

  // Perfil propio: la bóveda es esta extensión. Ni red, ni espera, ni aprobación.
  if (prof.kind === 'own') {
    vault = await ownVault(prof.id)
    vaultOf = prof.id
    return vault
  }

  const link = prof.link
  useIdentityOf(prof.id)
  const enc = await encKeypair(prof.id)
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
  vaultOf = prof.id
  return vault
}

async function status () {
  const p = await profiles()
  const prof = findProfile(p, p.active)
  // El código de enlace es del PERFIL: es su llave la que la bóveda va a autorizar.
  let code = null
  try {
    useIdentityOf(prof.id)
    const enc = await encKeypair(prof.id)
    code = encodeCode({ sign: await getPublicKeyJwk(), enc: enc.encPub })
  } catch { /* sin código: la vista de enlace lo dirá */ }

  // Cuántas hay guardadas, solo para la bóveda propia: preguntárselo a una remota sería
  // pedirle la lista entera, que es exactamente lo que un aparato no puede hacer (§2).
  let count = 0
  if (prof.kind === 'own') {
    try { count = (await (await ownVault(prof.id)).list()).length } catch { count = 0 }
  }

  return {
    profile: { id: prof.id, kind: prof.kind, label: prof.label },
    profiles: p.list.map(x => ({ id: x.id, kind: x.kind, label: x.label })),
    active: p.active,
    mode: prof.kind === 'own' ? 'own' : 'linked',
    linked: prof.kind === 'linked',
    label: prof.label || null,
    code,
    count,
  }
}

/**
 * Conectar una bóveda AÑADE un perfil: el que había sigue estando, con lo suyo dentro.
 *
 * Reemplazarlo sería lo peor que puede hacer un gestor de contraseñas — dejar de ver lo
 * que ya guardaste porque conectaste otra cosa. Aquí conviven, y eliges cuál miras.
 */
async function link ({ code, label }) {
  let c
  try { c = decodeCode(code) } catch { throw new VaultError('bad-code', 'ese código no es válido') }
  const p = await profiles()
  const id = 'p' + (Math.max(0, ...p.list.map(x => Number(String(x.id).slice(1)) || 0)) + 1)
  const list = [...p.list, {
    id,
    kind: 'linked',
    label: label || null,
    link: { peerPubkey: c.sign, peerEncPub: c.enc, ts: Date.now() },
    createdAt: Date.now(),
  }]
  // Se queda activo: acabas de conectarlo, es lo que quieres ver.
  await saveProfiles({ active: id, list })
  await cache.forget()
  return status()
}

/** Desconectar = quitar ESTE perfil, con todo lo suyo. El propio no se toca. */
async function unlink () {
  const p = await profiles()
  return removeProfile({ id: p.active })
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
  profiles: async () => (await profiles()).list.map(x => ({ id: x.id, kind: x.kind, label: x.label })),
  'profile-add': addProfile,
  'profile-use': useProfile,
  'profile-rename': renameProfile,
  'profile-remove': removeProfile,
  find: async p => (await connect()).find(p.url),
  get: async p => {
    const v = await connect()
    // La caché existe para no repetir aprobaciones en el teléfono. Con la bóveda propia
    // no hay aprobación que ahorrar, y guardar un secreto que no hace falta es peor.
    if ((await activeProfile()).kind === 'own') return v.get(p.id)
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
  // Cambiar de perfil es cambiar de bóveda: si una página pudiera, te enseñaría las
  // credenciales de otro perfil o te las guardaría en el que ella eligiera.
  if (!deLaExtension && !['find', 'get', 'status', 'webauthn-create', 'webauthn-get'].includes(msg.op)) {
    sendResponse({ error: { code: CODES.DENIED } })
    return false
  }

  Promise.resolve(op(msg.payload || {}))
    .then(result => sendResponse({ result }))
    .catch(e => sendResponse({ error: { code: e?.code || 'error', message: e?.message } }))
  return true
})
