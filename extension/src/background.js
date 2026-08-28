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
import { ProxyTransport } from './vendor/passmanager/transport/proxy.js'
import { SessionCache } from './vendor/passmanager/session-cache.js'
import { VaultError, CODES } from './vendor/passmanager/vault/errors.js'
import {
  createCredential, signAssertion, credentialMatches, b64urlDecode,
} from './vendor/passmanager/webauthn.js'
import { parseInvite } from './vendor/vault/invite.js'
import { maskUsername } from './vendor/passmanager/model.js'
import { KINDS } from './vendor/passmanager/fields.js'
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

  // Perfil propio: la bóveda es esta extensión. Ni red, ni espera, ni aprobación.
  if (prof.kind === 'own') {
    vault = await ownVault(prof.id)
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

const hostOf = (url) => { try { return new URL(url).hostname } catch { return '' } }

/** Los campos de una entrada abierta, que viajan como JSON dentro de un criptograma. */
function parseFields (raw) {
  if (Array.isArray(raw)) return raw.slice()
  try { const a = JSON.parse(raw || '[]'); return Array.isArray(a) ? a : [] } catch { return [] }
}

/** Lo capturado, acotado: clases conocidas, una por clase y con tope de tamaño. */
function cleanFields (fields) {
  const out = []
  const vistos = new Set()
  for (const f of Array.isArray(fields) ? fields : []) {
    const kind = KINDS.includes(f?.kind) ? f.kind : null
    if (!kind || vistos.has(kind)) continue
    const value = String(f.value ?? '').trim().slice(0, MAX_VALUE)
    if (!value) continue
    vistos.add(kind)
    out.push({ kind, value })
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
async function capture ({ username, secret, url, fields }) {
  const limpios = cleanFields(fields)
  if (!secret && !limpios.length) return { ok: false }
  await chrome.storage.session.set({
    [PENDING]: {
      username: username || '',
      secret: secret || '',
      fields: limpios,
      url: url || '',
      host: hostOf(url),
      ts: Date.now(),
    },
  })
  return { ok: true }
}

/**
 * La entrada que este formulario ACTUALIZARÍA, si hay una. No se decide por el usuario:
 * si hay UNA que se le parece se le ofrecen las dos salidas, y si hay varias solo la de
 * guardar — actualizar la equivocada le pisa una contraseña que sí servía.
 *
 * Con cuenta, «parecerse» es tener el mismo usuario (la bóveda solo devuelve la pista
 * enmascarada, así que se compara pista con pista). Sin cuenta —un formulario de datos—
 * es la entrada de datos DE ESTE SITIO: una entrada sin sitios vale en cualquier parte
 * (§4.2) y no se toca desde el formulario de un sitio cualquiera.
 */
async function findDup (p) {
  try {
    const hits = await (await connect()).find(p.url)
    if (p.secret || p.username) {
      const mask = maskUsername(p.username)
      const iguales = hits.filter(h => h.hint && h.hint === mask)
      return iguales.length === 1 ? { id: iguales[0].id, hint: iguales[0].title || iguales[0].hint } : null
    }
    const suyas = hits.filter(h => h.type === 'data' && !h.hint && (h.sites || []).includes(p.host))
    return suyas.length === 1 ? { id: suyas[0].id, hint: suyas[0].title || p.host } : null
  } catch (_) {
    // Sin bóveda a mano: se ofrece guardar de todos modos.
    return null
  }
}

/**
 * ¿Hay algo que ofrecer en este sitio? Devuelve el sitio y el usuario, NUNCA la
 * contraseña ni lo que haya en la bóveda: quien pregunta es el content script, o sea la
 * página. El detalle campo a campo es de `pending-detail`, que la página no puede pedir.
 *
 * Se ofrece solo en el MISMO sitio donde se escribió. Entrar en un sitio y que el aviso
 * te salga en otro sería enseñarle a ese otro un usuario que no es suyo.
 */
async function pendingSave ({ host } = {}) {
  const p = await readPending()
  if (!p) return { has: false }
  if (host && p.host && host !== p.host) return { has: false }
  const dup = await findDup(p)
  return { has: true, host: p.host, username: p.username, ...(dup ? { dup: dup.id, dupHint: dup.hint } : {}) }
}

/**
 * QUÉ SE VA A ESCRIBIR, campo por campo: lo que el aviso enseña con una casilla por
 * fila para que el usuario elija (dueño, 2026-08-28). Cada fila dice si el dato es
 * NUEVO o si CAMBIA lo que ya había, porque no es lo mismo añadir el teléfono que
 * pisar el que estaba bien.
 *
 * **Esta operación no la puede pedir la página**, y esa es la razón de que exista
 * aparte de `pending-save`: comparar con lo guardado es leer la bóveda, y el resultado
 * de la comparación —«esto ya lo tenías igual»— cuenta algo de lo que hay dentro. Se
 * responde solo al origen de la extensión, que es donde vive el aviso.
 *
 * Las filas que no cambian nada no salen: no hay nada que decidir en ellas.
 */
async function pendingDetail () {
  const p = await readPending()
  if (!p) return { has: false }
  const dup = await findDup(p)

  // Lo que ya hay guardado, para poder decir «nuevo» o «cambia».
  const antes = new Map()
  if (dup) {
    try {
      const base = await getEntry(await connect(), dup.id)
      if (base.username) antes.set('username', base.username)
      if (base.secret) antes.set('secret', base.secret)
      for (const f of parseFields(base.fields)) if (f.kind) antes.set(f.kind, f.value)
    } catch (_) { /* si no se puede abrir, todo se ofrece como nuevo */ }
  }

  const rows = []
  const add = (key, value, secret = false) => {
    if (!value) return
    const viejo = antes.get(key) || ''
    if (viejo === value) return
    rows.push({
      key,
      // La contraseña NO viaja al aviso, ni la nueva ni la que había: se enseña
      // tapada. Lo demás sí, y tiene que verse — es lo que se está eligiendo.
      value: secret ? null : value,
      before: secret ? null : viejo,
      changed: !!viejo,
      secret,
    })
  }

  add('username', p.username)
  add('secret', p.secret, true)
  for (const f of p.fields || []) add(f.kind, f.value)

  return {
    has: true,
    host: p.host,
    username: p.username,
    login: !!p.secret,
    ...(dup ? { dup: dup.id, dupHint: dup.hint } : {}),
    rows,
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
async function savePending ({ id, pick } = {}) {
  const p = await readPending()
  if (!p) throw new VaultError(CODES.NOT_FOUND, 'ya no hay nada que guardar')
  const v = await connect()
  const marcadas = Array.isArray(pick) ? new Set(pick) : null
  const quiere = (k) => !marcadas || marcadas.has(k)

  // Actualizar es SUMAR sobre lo que ya había, no reemplazarlo: una entrada tiene notas,
  // TOTP y campos que este formulario ni ve, y perderlos por guardar un teléfono sería
  // el peor error posible aquí.
  let base = null
  if (id) { try { base = await getEntry(v, id) } catch (_) { base = null } }
  const lang = pickLang()

  const fields = parseFields(base?.fields)
  for (const f of p.fields || []) {
    if (!quiere(f.kind)) continue
    const i = fields.findIndex(x => x.kind === f.kind)
    const label = (i >= 0 && fields[i].label) || KIND_LABEL[lang]?.[f.kind] || f.kind
    const fila = { label, value: f.value, kind: f.kind }
    if (i >= 0) fields[i] = fila
    else fields.push(fila)
  }

  await v.put({
    ...(id ? { id } : {}),
    type: base?.type || (p.secret ? 'login' : 'data'),
    title: base?.title || p.host,
    sites: base?.sites?.length ? base.sites : [p.host],
    username: (quiere('username') && p.username) || base?.username || '',
    secret: (quiere('secret') && p.secret) || base?.secret || '',
    totp: base?.totp || '',
    notes: base?.notes || '',
    webauthn: base?.webauthn || null,
    fields,
    ...(base?.createdAt ? { createdAt: base.createdAt } : {}),
  })
  // Lo recordado de esa entrada ya no vale: acaba de cambiar.
  if (id) { try { await cache.forget(id) } catch (_) {} }
  await chrome.storage.session.remove(PENDING)
  return { ok: true }
}

async function dismissPending () {
  await chrome.storage.session.remove(PENDING)
  return { ok: true }
}

/**
 * UNA credencial abierta, pasando por lo ya entregado en esta sesión.
 *
 * La caché existe para no repetir aprobaciones en el teléfono. Con la bóveda propia no
 * hay aprobación que ahorrar, y guardar un secreto que no hace falta es peor.
 */
async function getEntry (v, id) {
  if ((await activeProfile()).kind === 'own') return v.get(id)
  const recordada = await cache.get(id)
  if (recordada) return recordada
  const entry = await v.get(id)
  await cache.put(id, entry)
  return entry
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
  find: async p => (await connect()).find(p.url),
  get: async p => getEntry(await connect(), p.id),
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
  //
  // `capture` y `pending-save` SÍ los puede disparar la página, y es a propósito: son
  // los dos lados del aviso de guardar. Ninguno escribe en la bóveda ni saca nada de
  // ella — uno apunta lo que el propio sitio acaba de recibir, y el otro devuelve el
  // sitio y el usuario, nunca la contraseña. Fuera de esta lista se quedan los dos que
  // sí tocan la bóveda: `save-pending`, que escribe, y `pending-detail`, que la lee
  // para decir qué cambia. Los dos se piden desde el iframe del aviso, que es de la
  // extensión.
  if (!deLaExtension && !['find', 'get', 'status', 'webauthn-create', 'webauthn-get', 'capture', 'pending-save'].includes(msg.op)) {
    sendResponse({ error: { code: CODES.DENIED } })
    return false
  }

  Promise.resolve(op(msg.payload || {}))
    .then(result => sendResponse({ result }))
    .catch(e => sendResponse({ error: { code: e?.code || 'error', message: e?.message } }))
  return true
})
