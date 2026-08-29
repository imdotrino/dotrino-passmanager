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

import { WebSocketProxyClient } from './vendor/proxy-client/index.js'
import { RemoteVault } from './vendor/passmanager/vault/remote.js'
import { LocalVault } from './vendor/passmanager/vault/local.js'
import { GuardedVault } from './vendor/passmanager/vault/guard.js'
import { ApprovalGate } from './vendor/passmanager/vault/approval.js'
import { ProxyTransport } from './vendor/passmanager/transport/proxy.js'
import { SessionCache } from './vendor/passmanager/session-cache.js'
import { VaultError, CODES } from './vendor/passmanager/vault/errors.js'
import {
  createCredential, signAssertion, credentialMatches, b64urlDecode,
} from './vendor/passmanager/webauthn.js'
import { parseInvite } from './vendor/vault/invite.js'
import { entryWho } from './vendor/passmanager/model.js'
import { fieldHasher } from './vendor/passmanager/crypto.js'
import { KINDS } from './vendor/passmanager/fields.js'
// La misma regla de identidad que usa la página: la clase si se reconoce, y si no la
// etiqueta. Dos ideas distintas de qué es «el mismo campo» sería un campo duplicado.
import { fieldKey, fieldOffers } from './detect.js'
import { t, pickLang, KIND_LABEL } from './i18n.js'
// Estático a propósito: un service worker no admite `import()` dinámico.
import { identity } from './identity-core.js'

const PROXY_URL = 'wss://proxy.dotrino.com'

/** Cada perfil guarda lo suyo aparte: sin esto, dos bóvedas propias se pisarían. */
const keyFor = (id, name) => `${name}/${id}`

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
 * La propia CON LA PUERTA PUESTA, que es la única forma en que el gestor la ve.
 *
 * Las tres bóvedas del ecosistema tienen que funcionar igual (dueño, 2026-08-29), y esta
 * era la excepción: entregaba una contraseña sin preguntarle a nadie, porque no hay
 * transporte de por medio y por tanto no pasaba por `VaultResponder`, que es donde vive
 * la política. Ahora pasa por la misma `ApprovalGate` y con el mismo criterio: `get` —lo
 * que saca de la bóveda algo privado— pide autorización; buscar y guardar, no.
 *
 * **Se pregunta CADA VEZ, y es temporal.** El modelo del ecosistema es una aprobación
 * por aparato (§2.0), pero aquí el aparato que pide es este mismo navegador: recordarla
 * sería un solo clic que apaga la pregunta para siempre. Mientras el proceso no esté
 * asentado, se ve; automatizarlo viene después, y cuando venga es en los permisos del
 * aparato, no en una regla nueva de aquí.
 */
async function ownGuarded (id) {
  const inner = await ownVault(id)
  const gate = new ApprovalGate({
    ask: ({ op, payload }) => askApproval({ op, payload, vault: inner }),
    remember: false,
  })
  return new GuardedVault(inner, { gate })
}

// --- la pregunta de la bóveda -------------------------------------------------
//
// El daemon la hace en su consola y la pestaña del vault en su propia página. Aquí la
// bóveda no tiene página propia, así que la pregunta sale en la pantalla de la extensión
// que el usuario tenga delante —el popup, el modal de un campo, el aviso de guardar— y,
// si no hay ninguna, en una ventana de la extensión abierta para eso.
//
// **Nunca en la página.** Todas esas pantallas son del origen `chrome-extension://`: si
// la pregunta la pudiera dibujar el sitio, podría dibujarla cuando quisiera y
// contestarse que sí solo.
//
// Quien decide sigue siendo esto: las pantallas dibujan y devuelven el clic.

const APPROVAL_PORT = 'pm-approval'
// Sin respuesta no se entrega nada. El tope existe para no dejar una petición colgada
// para siempre si la pantalla que preguntaba se fue sin decir nada.
const APPROVAL_TIMEOUT_MS = 3 * 60 * 1000

const askHosts = []            // pantallas enchufadas que pueden dibujar la pregunta
const askOpen = new Map()      // rid → { q, done, at, timer }
let askSeq = 0
let askWindow = null

/** A quién se le pide que la dibuje: lo que el usuario está mirando, y la ventana al final. */
function pickHost () {
  const vivos = askHosts.filter(h => h.visible)
  const pantallas = vivos.filter(h => !h.standalone)
  return pantallas[pantallas.length - 1] || vivos[vivos.length - 1] || null
}

function offerAsk (rid) {
  const p = askOpen.get(rid)
  if (!p) return
  const h = pickHost()
  p.at = h || null
  if (h) {
    try { h.port.postMessage({ t: 'ask', rid, q: p.q }); return } catch (_) { p.at = null }
  }
  openAskWindow()
}

function settleAsk (rid, ok) {
  const p = askOpen.get(rid)
  if (!p) return
  askOpen.delete(rid)
  clearTimeout(p.timer)
  // Las demás pantallas quitan la pregunta: contestada en una, contestada en todas.
  for (const h of askHosts) { try { h.port.postMessage({ t: 'done', rid }) } catch (_) {} }
  p.done(!!ok)
}

async function openAskWindow () {
  if (askWindow != null) {
    try { await chrome.windows.update(askWindow, { focused: true }); return } catch (_) { askWindow = null }
  }
  try {
    const w = await chrome.windows.create({
      url: chrome.runtime.getURL('src/approve.html'),
      type: 'popup', width: 380, height: 300, focused: true,
    })
    askWindow = w.id
  } catch (_) { /* sin ventana no hay a quién preguntar: caduca y se toma como un no */ }
}

chrome.windows.onRemoved.addListener(id => { if (id === askWindow) askWindow = null })

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== APPROVAL_PORT) return
  const h = { port, visible: true, standalone: false }
  askHosts.push(h)

  port.onMessage.addListener(m => {
    if (m?.t === 'hello' || m?.t === 'visible') {
      h.visible = m.visible !== false
      if (m.t === 'hello') h.standalone = !!m.standalone
      // Solo recoge lo que NO tiene dónde dibujarse: es cómo llega la pregunta a la
      // ventana recién abierta. Lo que ya está en pantalla se queda donde está — moverlo
      // dejaría la pregunta pintada en un sitio y contestándose en otro.
      for (const [rid, p] of askOpen) if (!p.at) offerAsk(rid)
    }
    if (m?.t === 'answer') settleAsk(m.rid, m.ok)
    // `ping` no hace nada aquí a propósito: el tráfico por el puerto es lo que mantiene
    // despierto al worker mientras la pregunta está en pantalla.
  })

  port.onDisconnect.addListener(() => {
    const i = askHosts.indexOf(h)
    if (i >= 0) askHosts.splice(i, 1)
    // Irse sin contestar es decir que no. La pregunta NO persigue al usuario a la
    // siguiente pantalla: aparecer sola en un modal que se abre después, preguntando por
    // algo que se pidió hace rato, es la mejor forma de que la gente apruebe sin mirar.
    for (const [rid, p] of askOpen) if (p.at === h) settleAsk(rid, false)
  })
})

/**
 * PREGUNTAR. Devuelve `true` solo si alguien pulsó que sí.
 *
 * La bóveda se lee a sí misma para saber CÓMO se llama lo que se le pide: sin un nombre,
 * la pregunta es «¿autorizas algo?», que no es una pregunta. Lo que viaja a la pantalla
 * es la mitad pública de la entrada (§4.0.2) — nunca el valor guardado.
 */
async function askApproval ({ op, payload, vault }) {
  const q = { op, who: '', title: '', site: '' }
  try {
    const e = await vault.get(payload?.id)
    q.who = entryWho(e)
    q.title = e.title || ''
    q.site = (e.sites || [])[0] || ''
  } catch (_) { /* si no se puede nombrar, se pregunta igual */ }

  const rid = `a${++askSeq}`
  return new Promise(resolve => {
    let listo = false
    const done = (ok) => { if (!listo) { listo = true; resolve(ok) } }
    const timer = setTimeout(() => settleAsk(rid, false), APPROVAL_TIMEOUT_MS)
    askOpen.set(rid, { q, done, at: null, timer })
    offerAsk(rid)
  })
}

/**
 * EL SELLADO de lo que sale y entra: la llave de cifrado del PERFIL, la misma que la
 * bóveda conoce por el acta. Antes había aquí un par aparte, inventado por el gestor y
 * repartido a mano en un código; con el emparejamiento del ecosistema no hace falta —
 * la llave de cifrado viaja en el enrolamiento como la de cualquier otro aparato.
 *
 * Es un adaptador y no una llave suelta porque la privada NO SALE de la identidad: se
 * le pide que abra, no que la entregue.
 */
const sealing = {
  async seal (msg, peerEncPub) {
    if (!peerEncPub) throw new VaultError(CODES.UNSEALED, 'no tengo la llave de cifrado de la bóveda')
    return {
      app: 'passmanager',
      // Destinatarios como OBJETOS: `encrypt` expande cada uno a todos los aparatos de
      // esa persona; una llave suelta se le cae sin envolver nada y el sobre sale vacío.
      sealed: await identity.encrypt([{ encryptionPubkey: peerEncPub }], JSON.stringify(msg)),
      from: await identity.encryptionPubkey(),
    }
  },
  async open (env) { return JSON.parse(await identity.decrypt(env.from, env.sealed)) },
  isSealed: (m) => !!m && m.app === 'passmanager' && !!m.sealed,
}

/**
 * Recuerdo de lo que la bóveda YA entregó, en memoria de sesión: entrar tres veces al
 * mismo sitio en una tarde no debería ser tres aprobaciones en el teléfono.
 *
 * `chrome.storage.session` nunca toca el disco y se vacía al cerrar el navegador. No es
 * la caché descartada del diseño (§3.1): aquí no hay llave ni copia de la bóveda, solo
 * lo poco que ya pasó por delante.
 */
const cache = new SessionCache({
  async get (k) { return (await chrome.storage.session.get(k))[k] },
  async set (k, v) { await chrome.storage.session.set({ [k]: v }) },
})

// --- perfiles: los del ECOSISTEMA, no unos inventados aquí ---------------------
//
// La lista, cuál está activo y la llave de cada uno son de `@dotrino/identity`: el mismo
// multi-perfil que el resto del ecosistema, con su acta y sus delegaciones, corriendo
// dentro del service worker (`identity-core.js`). Lo que el gestor añade encima es una
// sola cosa por perfil: DÓNDE guarda — en su propia bóveda aquí, o en una conectada.

/** Lo que el gestor sabe de un perfil. Sin registro, es de los que guardan aquí. */
async function pmOf (id) {
  return (await store.get(`passmanager/profile/${id}`)) || { kind: 'own' }
}

const setPmOf = (id, v) => store.set(`passmanager/profile/${id}`, v)

async function activeProfile () {
  const cur = await identity.current()
  const pm = await pmOf(cur.id)
  return { id: cur.id, label: cur.name || null, ...pm }
}

/** Cerrar lo abierto: era del perfil de antes y no se reutiliza con otra identidad. */
function dropOpen () {
  forgetFinds()
  transport = null
  vault = null
  vaultOf = null
  try { client?.close?.() } catch (_) {}
  client = null
}

async function listProfiles () {
  const list = await identity.profiles()
  return Promise.all(list.map(async p => ({
    id: p.id,
    label: p.name || null,
    avatar: p.avatar || null,
    current: !!p.current,
    kind: (await pmOf(p.id)).kind,
  })))
}

/**
 * Otro perfil con su bóveda en esta misma extensión. La personal y la del trabajo sin
 * mezclarse, sin que ninguna de las dos necesite nada fuera del navegador.
 */
async function addProfile ({ label } = {}) {
  const p = await identity.create(label)
  await setPmOf(p.id, { kind: 'own' })
  dropOpen()
  await cache.forget()
  return status()
}

async function useProfile ({ id }) {
  await identity.use(id)
  dropOpen()
  await cache.forget()
  return status()
}

async function renameProfile ({ id, label }) {
  await identity.rename(id, label)
  return status()
}

/**
 * Quitar un perfil. Se lleva TODO lo suyo —la identidad la borra el núcleo, la bóveda la
 * borramos aquí—: si quedara algo, «lo quité» sería mentira.
 */
async function removeProfile ({ id }) {
  await store.del(keyFor(id, 'passmanager/entries/v1'))
  await store.del(`passmanager/profile/${id}`)
  try { await keyStore('readwrite', s => s.delete(keyFor(id, 'cek'))) } catch (_) {}
  await identity.remove(id)
  dropOpen()
  await cache.forget()
  return status()
}

async function connect () {
  const prof = await activeProfile()
  if (vault && vaultOf === prof.id && (prof.kind === 'own' || client?._connected)) return vault

  // Perfil propio: la bóveda es esta extensión. Ni red ni espera — pero sí aprobación,
  // como cualquier otra bóveda del ecosistema.
  if (prof.kind === 'own') {
    vault = await ownGuarded(prof.id)
    vaultOf = prof.id
    return vault
  }

  // A DÓNDE se pide: a la bóveda con la que este perfil está emparejado, y eso lo dice
  // el pilar de identidad —no una nota que se guardara aquí—. La maestra `iss` es la
  // dirección en el proxio; su llave de cifrado sale del acta, como la de cualquier
  // miembro. Si no hay emparejamiento no hay a quién pedirle: se dice y se para.
  const v = await identity.vaultStatus()
  if (!v?.paired) throw new VaultError(CODES.NO_LINK, 'este perfil no está conectado a ninguna bóveda')
  const peerEncPub = await identity.vaultEncPub()
  if (!peerEncPub) throw new VaultError(CODES.UNSEALED, 'tu bóveda todavía no publicó su llave de cifrado')

  client = new WebSocketProxyClient({
    url: v.proxy || PROXY_URL,
    // RTCPeerConnection no existe en un service worker: con WebRTC activo la
    // negociación revienta. Y tampoco haría falta aquí.
    enableWebRTC: false,
    // La garantía: nada en claro sale ni entra. Sin esto el proxio vería a qué sitio
    // se le pide credencial y cuál se devuelve.
    requireSealed: true,
    sealing,
  })
  await client.connect()

  // Identificarse con la llave del PERFIL: la identidad de red y la de firma son la
  // misma, que es lo que hace que la bóveda reconozca al aparato que ya conoce.
  const publickey = await identity.publickey()
  const data = { op: 'identify', publickey, token: client.token, ts: Date.now() }
  const { signature } = await identity.sign(data)
  await client.identify({ data, signature })

  transport = new ProxyTransport({
    client,
    peerPubkey: v.master,
    peerEncPub,
  })
  vault = new RemoteVault(transport)
  vaultOf = prof.id
  return vault
}

async function status () {
  const prof = await activeProfile()

  // Cuántas hay guardadas, solo para la bóveda propia: preguntárselo a una remota sería
  // pedirle la lista entera, que es exactamente lo que un aparato no puede hacer (§2).
  let count = 0
  if (prof.kind === 'own') {
    try { count = (await (await ownVault(prof.id)).list()).length } catch { count = 0 }
  }

  return {
    profile: { id: prof.id, kind: prof.kind, label: prof.label },
    profiles: await listProfiles(),
    active: prof.id,
    mode: prof.kind,
    linked: prof.kind === 'linked',
    label: prof.label || null,
    // El código de SEIS que hay que teclear en la bóveda, mientras dura un
    // emparejamiento. No es un código de enlace que se pegue: es el que prueba que este
    // aparato está delante, y no viaja — la bóveda lo aprende porque lo escribes tú.
    pairing: pairing.code ? { code: pairing.code, deviceId: pairing.deviceId } : null,
    count,
  }
}

/**
 * El código de seis del emparejamiento en curso, para que el popup lo enseñe. Vive en
 * memoria y muere con él: no es un secreto que se guarde, es lo que estás mirando.
 */
const pairing = { code: null, deviceId: null }

/**
 * CONECTAR UNA BÓVEDA — el emparejamiento del ecosistema, el mismo que cualquier otro
 * aparato: se pega la invitación que muestra la bóveda, este aparato genera una llave,
 * enseña SEIS caracteres y la bóveda firma su certificado cuando los tecleas allí. El
 * aparato entra en el acta del perfil y su permiso es `passwords`.
 *
 * Conectar AÑADE una cuenta: la que había sigue estando, con lo suyo dentro.
 * Reemplazarla sería lo peor que puede hacer un gestor de contraseñas — dejar de ver lo
 * que ya guardaste porque conectaste otra cosa. Aquí conviven, y eliges cuál miras.
 */
async function link ({ invite, label }) {
  const qr = parseInvite(String(invite || '').trim())
  if (!qr?.sn || !(qr.iss || qr.conn)) {
    throw new VaultError(CODES.BAD_INVITE, 'eso no es una invitación de bóveda')
  }
  try {
    // `join: 'new'` — la cuenta de la bóveda entra COMO OTRA cuenta de este navegador,
    // sin tocar la que ya usabas. El pilar además evita duplicarla si esa bóveda ya
    // tiene una cuenta aquí.
    const r = await identity.pairWithVault({ qr, label, onCode: (c) => {
      pairing.code = c.code
      pairing.deviceId = c.deviceId
    } })
    await setPmOf(r.profileId, { kind: 'linked' })
    return r
  } finally {
    pairing.code = null
    pairing.deviceId = null
    dropOpen()
    await cache.forget()
  }
}

/** Desconectar = quitar ESTE perfil, con todo lo suyo. */
async function unlink () {
  const prof = await activeProfile()
  return removeProfile({ id: prof.id })
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
  forgetFinds()
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
    forgetFinds()
    await v.put({ ...entrada, webauthn: { ...entrada.webauthn, signCount } })
    return response
  }
  throw new VaultError(CODES.NOT_FOUND, 'ninguna passkey sirve para lo que pide el sitio')
}

// --- lo capturado, a la espera de que el usuario diga que sí ------------------
//
// Guardar se pregunta DESPUÉS de entrar, en la página siguiente, que es cuando la
// persona sabe si la contraseña era buena. Entre una página y otra hay que sostener lo
// escrito, y eso es un secreto en claro: se sostiene lo mínimo y se dice dónde.
//
//   · en `chrome.storage.session`, que NUNCA toca el disco y muere con el navegador
//   · UNO a la vez, y con caducidad — un «ahora no» no deja nada esperando
//   · nunca vuelve a la página: el aviso que lo enseña es un iframe de la extensión y
//     solo recibe el sitio y el usuario, jamás la contraseña
const PENDING = 'passmanager/pending-save'
const PENDING_TTL_MS = 5 * 60 * 1000
// Topes de lo capturado. Lo manda la PÁGINA: sin freno, un sitio podría dejar apuntado
// medio megabyte en la memoria de sesión del navegador.
const MAX_FIELDS = 24
const MAX_VALUE = 512
const MAX_LABEL = 60

const hostOf = (url) => { try { return new URL(url).hostname } catch { return '' } }

/** Los campos de una entrada abierta, que viajan como JSON dentro de un criptograma. */
function parseFields (raw) {
  if (Array.isArray(raw)) return raw.slice()
  try { const a = JSON.parse(raw || '[]'); return Array.isArray(a) ? a : [] } catch { return [] }
}

/**
 * Lo capturado, acotado: uno por campo y con tope de tamaño.
 *
 * Entran también los campos que la página no supo clasificar. Son los **campos libres**
 * del modelo (§4.2) —`{ label, value }` sin clase— y no valen menos: el código del
 * portal o el número de socio se rellenan tanto como un correo. Su etiqueta es su
 * identidad, así que se guarda y se acota como todo lo demás.
 */
function cleanFields (fields) {
  const out = []
  const vistos = new Set()
  for (const f of Array.isArray(fields) ? fields : []) {
    const kind = KINDS.includes(f?.kind) ? f.kind : null
    const label = String(f?.label ?? '').trim().slice(0, MAX_LABEL)
    const value = String(f?.value ?? '').trim().slice(0, MAX_VALUE)
    if (!value) continue
    const key = fieldKey({ kind, label })
    if (vistos.has(key)) continue
    vistos.add(key)
    out.push({ ...(kind ? { kind } : {}), ...(label ? { label } : {}), value })
    if (out.length >= MAX_FIELDS) break
  }
  return out
}

async function readPending () {
  const p = (await chrome.storage.session.get(PENDING))[PENDING]
  if (!p) return null
  if (Date.now() - p.ts > PENDING_TTL_MS) { await chrome.storage.session.remove(PENDING); return null }
  return p
}

/**
 * La página avisa de lo que se acaba de escribir. NO escribe en la bóveda: solo lo deja
 * apuntado. Es la única operación que un sitio puede disparar y que toca algo nuestro, y
 * por eso no toca nada que importe — como mucho pisa una captura anterior suya.
 *
 * Lo capturado ya no es solo usuario+contraseña: un formulario de datos (el perfil, la
 * dirección de envío) es igual de guardable, y llega sin contraseña ninguna.
 */
async function capture ({ username, secret, url, fields, focus, from }) {
  const limpios = cleanFields(fields)
  // Un usuario suelto también se guarda: es media credencial, y la otra media se suma
  // luego a la misma entrada. Lo que no se guarda es nada.
  if (!secret && !username && !limpios.length) return { ok: false }
  await chrome.storage.session.set({
    [PENDING]: {
      username: username || '',
      secret: secret || '',
      fields: limpios,
      // QUÉ se pulsó: lo que viene marcado en el aviso. Al enviar un formulario no hay
      // nada pulsado y va todo marcado; al pulsar el botón de un campo, ese campo — que
      // es lo que el usuario pidió guardar, ni más ni menos.
      focus: Array.isArray(focus) ? focus.slice(0, MAX_FIELDS + 2).map(String) : [],
      // DE DÓNDE viene. Lo que se apunta al pulsar el botón de un campo es para el modal
      // que se está abriendo, no para el aviso de la página siguiente: sin esto, la
      // pasada de «¿quedó algo pendiente?» del arranque lo pescaba y salían los dos.
      from: from === 'field' ? 'field' : 'submit',
      url: url || '',
      host: hostOf(url),
      ts: Date.now(),
    },
  })
  return { ok: true }
}

/**
 * LO QUE YA HAY para este sitio, y solo su mitad PÚBLICA.
 *
 * Una página no tiene un ancla única: puedes tener dos contraseñas del mismo correo y
 * que una ya no sirva (dueño, 2026-08-28). Así que el gestor no elige por el usuario
 * cuál se pisa — le enseña los candidatos y elige él, o crea una entrada nueva.
 *
 * **De cada candidato sale solo lo público**: el título, la pista del usuario
 * (enmascarada), cuándo se tocó y qué guarda. Es exactamente lo que devuelve `find`
 * (`publicView`), o sea lo que se puede ver SIN la llave. Los valores de dentro son la
 * mitad privada y no salen de aquí para pintar una lista.
 *
 * «El que más se parece» es el del mismo usuario; sin usuario, la entrada de datos de
 * este mismo sitio. Va primero, y es el que queda preseleccionado.
 */
async function candidatesFor (p, v) {
  // Con usuario pero sin contraseña también se está guardando una cuenta: los candidatos
  // son las cuentas del sitio, no las entradas de datos.
  const login = !!p.secret || !!p.username
  const hits = await v.find(p.url)
  return hits
    .filter(h => login ? (h.hasSecret || h.type === 'login') : (h.hasFields || h.type === 'data'))
    .map(h => ({
      id: h.id,
      title: h.title || (h.sites || [])[0] || '',
      hint: h.hint || '',
      updatedAt: h.updatedAt || 0,
      // QUÉ campos lleva, por su nombre y sin un solo valor: es lo que deja decir «este
      // dato ya está ahí» sin abrirla (§4.0.2). Sin esto el aviso no sabe si una fila es
      // nueva o reemplaza, y lo dice todo como «no se sabe».
      ...(Array.isArray(h.fieldKeys) ? { fieldKeys: h.fieldKeys } : {}),
      // Y el resumen de cada uno, para comparar SIN abrir. Se queda dentro del service
      // worker: `pendingDetail` lo usa y lo quita antes de contestar (`stripDigest`).
      ...(h.nonce && h.fieldHashes ? { nonce: h.nonce, fieldHashes: h.fieldHashes } : {}),
      // Sin sitios sirve en cualquier parte (§4.2). Se ofrece, pero al final y dicho:
      // pisar tu dirección de siempre desde el formulario de una tienda cualquiera
      // tiene que ser una decisión, no un descuido.
      anywhere: !(h.sites || []).length,
      similar: login
        // Ahora el nombre visible es el usuario tal cual (§5), así que «parecerse» es
        // tenerlo igual, sin comparar máscaras contra máscaras.
        ? (!!p.username && h.hint === p.username)
        // Ojo: el nombre visible de una entrada de datos ya NO es vacío —lleva su correo
        // o su primer campo público (§5)—, así que «es la de datos de este sitio» se
        // pregunta por el tipo, no por si tiene nombre.
        : (h.type === 'data' && (h.sites || []).includes(p.host)),
    }))
    .sort((a, b) =>
      (b.similar - a.similar) || (a.anywhere - b.anywhere) || (b.updatedAt - a.updatedAt))
}

/**
 * Qué le pasaría a UNA entrada concreta: por cada dato capturado, si es nuevo, si
 * cambia lo que había, o si es lo mismo.
 *
 * **Esto SÍ abre la entrada**, o sea saca del vault información privada, y por eso no
 * se hace para pintar el aviso: solo cuando no cuesta nada (la bóveda es esta
 * extensión) o cuando el usuario lo pide. Con una bóveda conectada, pedirlo es la
 * aprobación de siempre.
 */
/**
 * QUÉ CAMBIA de lo escrito, comparando RESÚMENES.
 *
 * Dice `same`, `changed` o `new` por campo sin abrir una sola entrada: la bóveda mandó el
 * resumen de cada campo con su nonce (§4.0.2) y aquí se hashea lo que el usuario acaba de
 * escribir. Lo que NO sale de aquí es **el valor anterior**: para enseñarlo hay que abrir
 * la entrada, y eso es una autorización — `diffAgainst`.
 */
async function diffByDigest (candidates, p) {
  // Los valores salen del PENDIENTE, no de `typed`: ahí la contraseña viaja en `null` a
  // propósito, y sin ella no hay nada que comparar de la mitad que más importa.
  const pares = typedPairs(p)
  const iguales = await sameAs(candidates, pares)
  const out = {}
  for (const c of candidates) {
    if (!c.nonce || !c.fieldHashes) continue
    out[c.id] = pares.map(({ key }) => ({
      key,
      status: iguales.has(`${c.id}|${key}`) ? 'same' : (c.fieldHashes[key] ? 'changed' : 'new'),
      // Lo de antes NO está aquí: un resumen dice si es igual, no qué era. Para eso hay
      // que abrir la entrada, y eso es «Ver qué cambia».
      before: '',
    }))
  }
  return out
}

/** Lo que el usuario acaba de escribir, como pares `{ key, value }`. */
function typedPairs (p) {
  const out = []
  if (p.username) out.push({ key: 'username', value: p.username })
  if (p.secret) out.push({ key: 'secret', value: p.secret })
  for (const f of p.fields || []) out.push({ key: fieldKey(f), value: f.value || '' })
  return out
}

/**
 * LOS RESÚMENES NO SALEN DEL SERVICE WORKER.
 *
 * Comparar se hace aquí y hacia fuera van conclusiones —`same`/`changed`/`new`, o dos
 * booleanos—, nunca el material con el que se compara. Un resumen no es el valor, pero un
 * valor corto y con forma conocida (un teléfono, un documento) se adivina a partir de él
 * si se tiene delante; que no salga de aquí es lo que hace que eso no importe.
 */
function stripDigest (list) {
  return (Array.isArray(list) ? list : []).map(({ nonce, fieldHashes, ...resto }) => resto)
}

async function diffAgainst (v, id, p) {
  // Solo los campos que se escribieron: para decir qué había antes en el teléfono no hace
  // falta sacar también la contraseña. Si alguno de ellos es privado, ahí sí se pregunta.
  const base = await getEntry(v, id, typedPairs(p).map(x => x.key))
  const antes = new Map()
  if (base.username) antes.set('username', base.username)
  if (base.secret) antes.set('secret', base.secret)
  for (const f of parseFields(base.fields)) antes.set(fieldKey(f), f.value)

  const fila = (key, value, secret) => {
    const viejo = antes.get(key) || ''
    return {
      key,
      status: viejo === value ? 'same' : viejo ? 'changed' : 'new',
      // De la contraseña no viaja nada, ni la nueva ni la que había.
      before: secret ? null : viejo,
    }
  }
  const out = []
  if (p.username) out.push(fila('username', p.username, false))
  if (p.secret) out.push(fila('secret', p.secret, true))
  for (const f of p.fields || []) out.push(fila(fieldKey(f), f.value, false))
  return out
}

/**
 * ¿Hay algo que ofrecer en este sitio? Devuelve el sitio y el usuario, NUNCA la
 * contraseña ni nada de la bóveda: quien pregunta es el content script, o sea la
 * página. Todo lo demás —qué hay guardado, qué cambia— es de `pending-detail`, que la
 * página no puede pedir.
 *
 * Se ofrece solo en el MISMO sitio donde se escribió. Entrar en un sitio y que el aviso
 * te salga en otro sería enseñarle a ese otro un usuario que no es suyo.
 */
async function pendingSave ({ host } = {}) {
  const p = await readPending()
  if (!p) return { has: false }
  if (p.from === 'field') return { has: false }
  if (host && p.host && host !== p.host) return { has: false }
  return { has: true, host: p.host, username: p.username }
}

/**
 * QUÉ SE VA A ESCRIBIR y DÓNDE: lo que el aviso enseña con una casilla por dato y la
 * lista de entradas que podría reemplazar (dueño, 2026-08-28).
 *
 * **La página no puede pedir esto**, y esa es la razón de que exista aparte de
 * `pending-save`: aquí se mira lo que hay en la bóveda. Se responde solo al origen de
 * la extensión, que es donde vive el aviso.
 *
 * La frontera privado/público la marca `ask`:
 *
 *   · **público** — la lista de candidatos, que es lo que `find` devuelve sin llave.
 *     Sale siempre, porque sin ella el usuario no puede elegir qué reemplaza.
 *   · **privado** — los valores guardados, o sea poder decir «esto cambia» y enseñar lo
 *     anterior. Cuesta una autorización en CUALQUIER bóveda —también en la propia, desde
 *     que pregunta (§3.3.1)—, así que se espera a que el usuario la pida (`reveal`).
 */
async function pendingDetail ({ id, reveal } = {}) {
  const p = await readPending()
  if (!p) return { has: false }

  let v = null
  try { v = await connect() } catch (_) { /* sin bóveda a mano: se ofrece guardar igual */ }
  const candidates = v ? await candidatesFor(p, v).catch(() => []) : []
  const ask = v ? v.capabilities?.needsApproval !== false : true

  // Lo que se va a escribir es lo que el usuario ACABA de teclear: no sale de la bóveda
  // y por eso viaja siempre. La contraseña es la excepción de siempre — va en `null` y
  // el aviso la enseña tapada.
  // `pick`: si viene marcado de entrada. Lo decide `focus` — lo que el usuario pulsó.
  const marca = (key) => !p.focus?.length || p.focus.includes(key)
  const lang = pickLang()
  const typed = []
  if (p.username) {
    typed.push({ key: 'username', label: KIND_LABEL[lang]?.username, value: p.username, secret: false, pick: marca('username') })
  }
  if (p.secret) {
    typed.push({ key: 'secret', label: KIND_LABEL[lang]?.secret, value: null, secret: true, pick: marca('secret') })
  }
  for (const f of p.fields || []) {
    const key = fieldKey(f)
    typed.push({
      key,
      // La etiqueta con la que se va a GUARDAR, no una descripción: lo que se enseña
      // tiene que ser lo que quede escrito en la entrada.
      label: f.label || KIND_LABEL[lang]?.[f.kind || key] || key,
      value: f.value,
      secret: false,
      pick: marca(key),
    })
  }

  // QUÉ CAMBIA, por resúmenes: sin abrir nada y sin pedir autorización. Sale para TODOS
  // los candidatos, porque comparar ya no cuesta una aprobación.
  const diffs = {}
  const porResumen = await diffByDigest(candidates, p).catch(() => ({}))
  Object.assign(diffs, porResumen)

  // Y con lo de ANTES a la vista, que sí exige abrir la entrada: eso es «Ver qué cambia»
  // y lo pide el usuario (§3.3.2). Solo entonces las filas llevan el valor anterior.
  if (reveal && id) {
    try { diffs[id] = await diffAgainst(v, id, p) } catch (_) { /* si no abre, el de arriba */ }
  }

  return {
    has: true,
    host: p.host,
    username: p.username,
    login: !!p.secret,
    typed,
    candidates: stripDigest(candidates),
    ask,
    diffs,
  }
}

/**
 * El «sí». Llega del iframe del aviso, que corre en el origen de la EXTENSIÓN: por eso
 * pasa la misma puerta que el popup y la página no puede dispararlo.
 *
 * `pick` son las casillas marcadas. Lo que no está marcado NO se escribe: si la entrada
 * ya existía se queda como estaba, y si es nueva simplemente no entra. Sin lista se
 * guarda todo, que es lo que hacía el aviso antes de tener casillas.
 */
async function savePending ({ id, pick, privateKeys, keepRest, name } = {}) {
  const p = await readPending()
  if (!p) throw new VaultError(CODES.NOT_FOUND, 'ya no hay nada que guardar')
  const v = await connect()
  const marcadas = Array.isArray(pick) ? new Set(pick) : null
  const quiere = (k) => !marcadas || marcadas.has(k)
  // Lo PRIVADO de una entrada: lo que solo sale de la bóveda con confirmación. Se marca
  // al guardar, campo a campo (§4.2).
  const privadas = new Set(Array.isArray(privateKeys) ? privateKeys : [])
  const lang = pickLang()

  const fields = []
  for (const f of p.fields || []) {
    const key = fieldKey(f)
    if (!quiere(key)) continue
    fields.push({
      // La etiqueta con la que se guarda: la del sitio, o el nombre de su clase. Si la
      // entrada ya tenía una para ese campo, manda la suya y esto se ignora — eso lo
      // resuelve la bóveda, que es quien sabe lo que hay dentro.
      label: f.label || KIND_LABEL[lang]?.[f.kind || key] || f.kind || key,
      value: f.value,
      ...(f.kind ? { kind: f.kind } : {}),
      ...(privadas.has(key) ? { private: true } : {}),
    })
  }

  // ACTUALIZAR es un `patch`: la bóveda fusiona sobre lo que ya había y no sale de ahí ni
  // un valor. Antes esto era leer la entrada entera, fusionar aquí y volver a escribirla,
  // y tenía dos costes que no se veían: sacaba la contraseña de la bóveda para guardar un
  // teléfono —lo que además obligaba a pedir autorización para reemplazar un nombre— y,
  // si esa lectura fallaba, el `put` de detrás escribía la entrada SIN lo que no pudo
  // leer. Perder la mitad de una entrada por una autorización denegada no es un fallo
  // raro: es lo que pasaba (dueño, 2026-08-29).
  let escrita = null
  if (id) {
    escrita = await v.patch(id, {
      ...(quiere('username') && p.username ? { username: p.username } : {}),
      ...(quiere('secret') && p.secret ? { secret: p.secret } : {}),
      fields,
      // Guardar en una entrada de OTRO dominio —la que se trae buscando, porque el
      // subdominio cambió— suma este sitio; una entrada SIN sitios sirve en cualquier
      // parte (§4.2) y se queda como está.
      ...(p.host ? { addSite: p.host } : {}),
    })
  } else {
    escrita = await v.put({
      type: (p.secret || p.username) ? 'login' : 'data',
      title: p.host,
      // El nombre que el usuario escribió al elegir «una entrada nueva». Sin él, la
      // entrada se llama como su contenido y ya se podrá cambiar después.
      ...(name ? { name: String(name).trim().slice(0, 80) } : {}),
      sites: [p.host],
      username: (quiere('username') && p.username) || '',
      secret: (quiere('secret') && p.secret) || '',
      fields,
    })
  }

  // Lo recordado de esa entrada ya no vale: acaba de cambiar. Y la lista pública del
  // sitio tampoco, que es de donde salen los marcadores.
  if (id) { try { await cache.forget(id) } catch (_) {} }
  forgetFinds()

  // Con `keepRest`, lo que NO se guardó sigue apuntado: en el modal de un campo se
  // guarda de a uno, y tirar lo demás dejaría media pantalla de botones muertos. Sin él
  // —el aviso de después de entrar— se borra todo: lo que se dejó sin marcar allí es un
  // «esto no», no un «todavía no».
  const quedan = keepRest ? (p.fields || []).filter(f => !quiere(fieldKey(f))) : []
  const quedaUser = keepRest && p.username && !quiere('username')
  const quedaClave = keepRest && p.secret && !quiere('secret')
  if (quedan.length || quedaUser || quedaClave) {
    await chrome.storage.session.set({
      // El `ts` es el de la captura, no el de ahora: guardar de a uno no puede alargar
      // para siempre lo que hay en claro en la memoria de sesión.
      [PENDING]: { ...p, fields: quedan, username: quedaUser ? p.username : '', secret: quedaClave ? p.secret : '' },
    })
  } else {
    await chrome.storage.session.remove(PENDING)
  }
  // El id de la entrada escrita: guardando de a uno, el segundo campo tiene que ir a la
  // MISMA entrada que acaba de nacer, no a otra nueva.
  return { ok: true, id: escrita?.id || id || null }
}

async function dismissPending () {
  await chrome.storage.session.remove(PENDING)
  return { ok: true }
}

/**
 * UNA credencial abierta, y **solo los campos que se piden**.
 *
 * `keys` es lo que hace que rellenar un nombre no saque de la bóveda la contraseña, y por
 * tanto lo que hace que rellenar un nombre no pida autorización (§4.2). Sin `keys` se pide
 * todo, y eso sí se autoriza: es lo que necesita copiar una contraseña o firmar una
 * passkey.
 *
 * La caché existe para no repetir aprobaciones en el TELÉFONO, que es donde repetirlas
 * cuesta de verdad, y solo guarda lo que se pidió ENTERO: una entrada recortada no puede
 * responder por la siguiente petición, que quizá pida otra cosa.
 */
async function getEntry (v, id, keys) {
  const opts = Array.isArray(keys) ? { keys } : {}
  if (Array.isArray(keys)) return v.get(id, opts)
  if ((await activeProfile()).kind === 'own') return v.get(id, opts)
  const recordada = await cache.get(id)
  if (recordada) return recordada
  const entry = await v.get(id, opts)
  await cache.put(id, entry)
  return entry
}

/**
 * Lo PÚBLICO de un sitio, recordado un minuto.
 *
 * Desde que el marcador solo sale si sirve de algo, cada página con un formulario
 * pregunta `find` al cargar. Con la bóveda propia eso es gratis; con una conectada es un
 * viaje por el proxio, y navegar dentro de un sitio no puede ser un viaje por página.
 * Solo se recuerda lo público —lo mismo que `find` devuelve a cualquiera—, y cualquier
 * escritura lo tira.
 */
const FIND_TTL_MS = 60 * 1000
const findMemo = new Map()

const forgetFinds = () => { findMemo.clear() }

async function findFor (url) {
  const host = hostOf(url)
  const hit = findMemo.get(host)
  if (hit && Date.now() - hit.ts < FIND_TTL_MS) return hit.result
  const result = await (await connect()).find(url)
  if (host) findMemo.set(host, { ts: Date.now(), result })
  return result
}

/**
 * ¿YA ESTÁ GUARDADO IGUAL? Se contesta con los RESÚMENES, sin abrir nada.
 *
 * La bóveda manda un resumen por campo junto con un nonce nuevo en cada respuesta
 * (§4.0.2). Aquí se hashea lo que el usuario tiene delante con ese mismo nonce y se
 * comparan resúmenes: ni la contraseña guardada sale de la bóveda, ni hace falta una
 * autorización para saber que no cambia nada.
 *
 * **Un solo método, para todos los campos** (dueño, 2026-08-29). Antes lo público se
 * comparaba mirando el valor y lo privado no se comparaba: dos caminos que acababan
 * diciendo cosas distintas del mismo formulario.
 *
 * **Solo lo usan las pantallas de la extensión** —el modal y el aviso, por
 * `pendingDetail`—, nunca lo que se le contesta a la página. El marcador ya no compara
 * nada (ver `fieldOffers`), así que la página no puede proponer un valor y leer en el
 * botón si acertó.
 *
 * Devuelve un `Set` con las claves `id|key` que coinciden.
 */
async function sameAs (metas, pares) {
  const out = new Set()
  const conNonce = metas.filter(m => m.nonce && m.fieldHashes)
  if (!conNonce.length || !pares.length) return out
  // Un hasheador por nonce: todas las entradas de una misma respuesta lo comparten, así
  // que en la práctica es uno.
  const hashers = new Map()
  for (const m of conNonce) {
    if (!hashers.has(m.nonce)) hashers.set(m.nonce, await fieldHasher(m.nonce))
  }
  const cache = new Map()
  for (const m of conNonce) {
    for (const { key, value } of pares) {
      const guardado = m.fieldHashes[key]
      if (!guardado) continue
      const memo = `${m.nonce}|${key}|${value}`
      if (!cache.has(memo)) cache.set(memo, await hashers.get(m.nonce)(key, value))
      if (cache.get(memo) === guardado) out.add(`${m.id}|${key}`)
    }
  }
  return out
}

/**
 * QUÉ OFRECER en cada campo de la página, y desde qué entradas.
 *
 * Lo pregunta el content script en cada pasada. Devuelve **dos booleanos y una lista de
 * ids** por campo, y ninguno de los dos depende de un valor guardado: la regla del
 * marcador es «hay algo escrito» o «hay algo que poner aquí» (`fieldOffers`).
 *
 * Lo escrito ni siquiera hace falta mirarlo contra la bóveda, así que de aquí no sale
 * nada que la página no supiera ya.
 */
async function offersFor ({ url, fields } = {}) {
  let metas = []
  try { metas = await findFor(url) } catch (_) { metas = [] }

  const out = []
  for (const f of Array.isArray(fields) ? fields : []) {
    const acceso = f.key === 'username' || f.key === 'secret'
    const libre = !acceso && !KINDS.includes(f.key)

    // La vista pública dice QUÉ campos lleva cada entrada, por su nombre y sin un solo
    // valor (§4.0.2): con eso se sabe si hay algo que poner aquí, también en un campo que
    // el gestor no reconoce —el número de socio del §4.2—, sin abrir nada.
    const conNombres = metas.filter(m => Array.isArray(m.fieldKeys))
    const ids = conNombres.length === metas.length
      ? metas.filter(m => m.fieldKeys.includes(f.key)).map(m => m.id)
      // Una bóveda que todavía no manda los nombres (un daemon sin actualizar): lo grueso
      // de antes, y un campo libre se queda sin oferta.
      : libre ? [] : metas.filter(m => acceso ? (m.hasSecret || m.type === 'login') : m.hasFields).map(m => m.id)

    // Y nada más: la regla del marcador no mira valores guardados (ver `fieldOffers`).
    // Si hay algo escrito, hay botón — aunque esa entrada ya lo tenga igual, porque las
    // otras pueden no tenerlo. Qué cambia de verdad lo dice el modal, que es de la
    // extensión y no lo lee la página.
    out.push({ id: f.id, ids, ...fieldOffers({ value: f.value || '', stored: ids.length > 0 }) })
  }
  return out
}

/**
 * LA ENTRADA PREDETERMINADA de un sitio: la que sale elegida al abrir el botón de un
 * campo (dueño, 2026-08-28).
 *
 * Es una preferencia del usuario, no contenido suyo: vive en el almacén de la extensión,
 * separada **por perfil** como todo lo demás. Si esa entrada ya no existe, el que
 * pregunta se encuentra un id que no está en la lista y sigue sin ella — no hace falta
 * limpiarla a mano.
 */
const defaultKey = async (url) => {
  const host = hostOf(url)
  if (!host) return ''
  return keyFor((await activeProfile()).id, `passmanager/default/${host}`)
}

async function getDefault ({ url } = {}) {
  const k = await defaultKey(url)
  return k ? ((await store.get(k)) || null) : null
}

async function setDefault ({ url, id } = {}) {
  const k = await defaultKey(url)
  if (!k) return { ok: false }
  if (id) await store.set(k, id)
  else await store.del(k)
  return { ok: true, id: id || null }
}

/**
 * BUSCAR una entrada por texto, en toda la bóveda y no solo en este sitio.
 *
 * Es para el caso que el dueño describió el 2026-08-28: *«a veces cambia el subdominio y
 * la clave es la misma»*. Sin esto, la cuenta que sirve existe pero no hay forma de
 * llegar a ella desde la página nueva.
 *
 * **No la puede pedir la página.** Y no es `list` disfrazado (DISENO §2): exige un
 * término que escribe una persona y devuelve un puñado de vistas públicas. La lista
 * entera sigue sin poder pedirse.
 */
async function searchEntries ({ q, limit } = {}) {
  const texto = String(q || '').trim()
  if (texto.length < 2) return []
  const v = await connect()
  if (typeof v.search !== 'function') return []
  return v.search(texto, { limit: Math.min(Number(limit) || 20, 50) })
}

/**
 * PONERLE NOMBRE a una entrada. Solo desde la UI de la extensión.
 *
 * Hasta el 2026-08-29 el nombre de una entrada se calculaba de su contenido —el usuario,
 * el correo, el primer campo— y no se podía tocar. Está bien para no dejar filas en
 * blanco, pero es una suposición, y con dos cuentas del mismo sitio la suposición dice lo
 * mismo de las dos. Con un nombre escrito, el usuario las distingue como quiera.
 *
 * Vacío lo quita, y vuelve el calculado: nunca se queda una fila sin nombre.
 */
async function renameEntry ({ id, name } = {}) {
  if (!id) throw new VaultError(CODES.NOT_FOUND, 'no dijiste cuál')
  const v = await connect()
  await v.patch(id, { name: String(name || '').trim().slice(0, 80) })
  try { await cache.forget(id) } catch (_) {}
  forgetFinds()
  return { ok: true }
}

/** Quitar una entrada de la bóveda. Solo desde la UI de la extensión, y con aviso. */
async function removeEntry ({ id, url }) {
  if (!id) throw new VaultError(CODES.NOT_FOUND, 'no dijiste cuál')
  const v = await connect()
  await v.remove(id)
  try { await cache.forget(id) } catch (_) {}
  // Si era la predeterminada, deja de serlo: un valor por defecto que apunta a lo que ya
  // no está deja el modal eligiendo una entrada fantasma.
  try {
    const k = await defaultKey(url)
    if (k && (await store.get(k)) === id) await store.del(k)
  } catch (_) {}
  forgetFinds()
  return { ok: true }
}

const OPS = {
  status,
  capture,
  'pending-save': pendingSave,
  'pending-detail': pendingDetail,
  'save-pending': savePending,
  'dismiss-pending': dismissPending,
  'webauthn-create': webauthnCreate,
  'webauthn-get': webauthnGet,
  link: p => link(p),
  unlink,
  profiles: listProfiles,
  'profile-add': addProfile,
  'profile-use': useProfile,
  'profile-rename': renameProfile,
  'profile-remove': removeProfile,
  find: async p => stripDigest(await findFor(p.url)),
  offers: p => offersFor(p),
  search: async p => stripDigest(await searchEntries(p)),
  remove: p => removeEntry(p),
  rename: p => renameEntry(p),
  'default-get': p => getDefault(p),
  'default-set': p => setDefault(p),
  get: async p => getEntry(await connect(), p.id, p.keys),
  put: async p => { forgetFinds(); return (await connect()).put(p.entry) },
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
  //
  // `capture` y `pending-save` SÍ los puede disparar la página, y es a propósito: son
  // los dos lados del aviso de guardar. Ninguno escribe en la bóveda ni saca nada de
  // ella — uno apunta lo que el propio sitio acaba de recibir, y el otro devuelve el
  // sitio y el usuario, nunca la contraseña. Fuera de esta lista se quedan los dos que
  // sí tocan la bóveda: `save-pending`, que escribe, y `pending-detail`, que la lee
  // para decir qué cambia. Los dos se piden desde el iframe del aviso, que es de la
  // extensión.
  if (!deLaExtension && !['find', 'get', 'status', 'webauthn-create', 'webauthn-get', 'capture', 'pending-save', 'offers'].includes(msg.op)) {
    sendResponse({ error: { code: CODES.DENIED } })
    return false
  }

  Promise.resolve(op(msg.payload || {}))
    .then(result => sendResponse({ result }))
    .catch(e => sendResponse({ error: { code: e?.code || 'error', message: e?.message } }))
  return true
})
