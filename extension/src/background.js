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
async function capture ({ username, secret, url, fields, focus }) {
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
  const mask = maskUsername(p.username)
  const hits = await v.find(p.url)
  return hits
    .filter(h => login ? (h.hasSecret || h.type === 'login') : (h.hasFields || h.type === 'data'))
    .map(h => ({
      id: h.id,
      title: h.title || (h.sites || [])[0] || '',
      hint: h.hint || '',
      updatedAt: h.updatedAt || 0,
      // Sin sitios sirve en cualquier parte (§4.2). Se ofrece, pero al final y dicho:
      // pisar tu dirección de siempre desde el formulario de una tienda cualquiera
      // tiene que ser una decisión, no un descuido.
      anywhere: !(h.sites || []).length,
      similar: login
        ? (!!mask && h.hint === mask)
        : (!h.hint && (h.sites || []).includes(p.host)),
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
async function diffAgainst (v, id, p) {
  const base = await getEntry(v, id)
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
 *     anterior. Con la bóveda propia no cuesta nada y va de una; con una conectada
 *     cuesta una confirmación, así que se espera a que el usuario la pida (`reveal`).
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
  const typed = []
  if (p.username) typed.push({ key: 'username', value: p.username, secret: false, pick: marca('username') })
  if (p.secret) typed.push({ key: 'secret', value: null, secret: true, pick: marca('secret') })
  for (const f of p.fields || []) {
    const key = fieldKey(f)
    typed.push({
      key,
      // Los campos con clase los nombra el aviso en su idioma; los libres se llaman como
      // los llama el sitio, que es todo lo que se sabe de ellos.
      ...(f.kind ? {} : { label: f.label || '' }),
      value: f.value,
      secret: false,
      pick: marca(key),
    })
  }

  const diffs = {}
  const mirar = ask ? (reveal && id ? [id] : []) : candidates.map(c => c.id)
  for (const t of mirar) {
    try { diffs[t] = await diffAgainst(v, t, p) } catch (_) { /* si no abre, sin diff */ }
  }

  return { has: true, host: p.host, username: p.username, login: !!p.secret, typed, candidates, ask, diffs }
}

/**
 * El «sí». Llega del iframe del aviso, que corre en el origen de la EXTENSIÓN: por eso
 * pasa la misma puerta que el popup y la página no puede dispararlo.
 *
 * `pick` son las casillas marcadas. Lo que no está marcado NO se escribe: si la entrada
 * ya existía se queda como estaba, y si es nueva simplemente no entra. Sin lista se
 * guarda todo, que es lo que hacía el aviso antes de tener casillas.
 */
async function savePending ({ id, pick, privateKeys } = {}) {
  const p = await readPending()
  if (!p) throw new VaultError(CODES.NOT_FOUND, 'ya no hay nada que guardar')
  const v = await connect()
  const marcadas = Array.isArray(pick) ? new Set(pick) : null
  const quiere = (k) => !marcadas || marcadas.has(k)
  // Lo PRIVADO de una entrada: lo que solo sale de la bóveda con confirmación. Se marca
  // al guardar, campo a campo (§4.2).
  const privadas = new Set(Array.isArray(privateKeys) ? privateKeys : [])

  // Actualizar es SUMAR sobre lo que ya había, no reemplazarlo: una entrada tiene notas,
  // TOTP y campos que este formulario ni ve, y perderlos por guardar un teléfono sería
  // el peor error posible aquí.
  let base = null
  if (id) { try { base = await getEntry(v, id) } catch (_) { base = null } }
  const lang = pickLang()

  const fields = parseFields(base?.fields)
  for (const f of p.fields || []) {
    const key = fieldKey(f)
    if (!quiere(key)) continue
    const i = fields.findIndex(x => fieldKey(x) === key)
    // La etiqueta que ya tenía manda: es la identidad del campo libre, y cambiarla sería
    // crear otro. Si no había, la del sitio; y si el campo tiene clase, su nombre.
    const label = (i >= 0 && fields[i].label) || f.label || KIND_LABEL[lang]?.[f.kind] || f.kind || ''
    const fila = {
      label,
      value: f.value,
      ...(f.kind ? { kind: f.kind } : {}),
      // Si ya era privado, sigue siéndolo: quitarlo tiene que ser un acto, no un
      // descuido de haber guardado encima desde un formulario.
      ...((privadas.has(key) || (i >= 0 && fields[i].private)) ? { private: true } : {}),
    }
    if (i >= 0) fields[i] = fila
    else fields.push(fila)
  }

  await v.put({
    ...(id ? { id } : {}),
    type: base?.type || ((p.secret || p.username) ? 'login' : 'data'),
    title: base?.title || p.host,
    // Los de la entrada que se actualiza, tal cual: una entrada SIN sitios sirve en
    // cualquier parte (§4.2), y ponerle el host aquí la convertiría en la de este sitio
    // sin que nadie lo pidiera.
    sites: base ? (base.sites || []) : [p.host],
    username: (quiere('username') && p.username) || base?.username || '',
    secret: (quiere('secret') && p.secret) || base?.secret || '',
    totp: base?.totp || '',
    notes: base?.notes || '',
    webauthn: base?.webauthn || null,
    fields,
    ...(base?.createdAt ? { createdAt: base.createdAt } : {}),
  })
  // Lo recordado de esa entrada ya no vale: acaba de cambiar. Y la lista pública del
  // sitio tampoco, que es de donde salen los marcadores.
  if (id) { try { await cache.forget(id) } catch (_) {} }
  forgetFinds()
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
// Y lo mismo abierto, cuando abrir no cuesta nada (ver `openedFor`).
const openMemo = new Map()

const forgetFinds = () => { findMemo.clear(); openMemo.clear() }

async function findFor (url) {
  const host = hostOf(url)
  const hit = findMemo.get(host)
  if (hit && Date.now() - hit.ts < FIND_TTL_MS) return hit.result
  const result = await (await connect()).find(url)
  if (host) findMemo.set(host, { ts: Date.now(), result })
  return result
}

/**
 * Lo guardado del sitio, ABIERTO, para poder decidir campo a campo.
 *
 * La tabla del §4.1 pregunta dos cosas que solo se saben mirando dentro: si alguna
 * entrada tiene ESTE campo, y si lo tiene con ESTE mismo valor. Con la bóveda propia
 * —la de la extensión— abrir no cuesta nada ni sale de aquí, así que se hace y la
 * respuesta es exacta.
 *
 * Con una bóveda **conectada** abrir cuesta una aprobación en el teléfono, y pedirla al
 * cargar cada página sería insoportable: ahí se devuelve `null` y quien pregunta se
 * queda con lo público (§4.0.2), que dice si hay entradas con campos pero no cuáles. El
 * botón sale de más en vez de faltar — de más es un aviso que dirá que no cambia nada;
 * de menos es un gestor que parece roto.
 */
async function openedFor (url) {
  const v = await connect()
  if (v.capabilities?.needsApproval !== false) return null
  const host = hostOf(url)
  const hit = openMemo.get(host)
  if (hit && Date.now() - hit.ts < FIND_TTL_MS) return hit.list
  const list = []
  for (const meta of await findFor(url)) {
    try {
      const e = await v.get(meta.id)
      const keys = new Map()
      for (const f of parseFields(e.fields)) keys.set(fieldKey(f), f.value)
      list.push({ id: e.id, type: e.type, username: e.username || '', secret: e.secret || '', keys })
    } catch (_) { /* una que no abre no cuenta */ }
  }
  openMemo.set(host, { ts: Date.now(), list })
  return list
}

/**
 * QUÉ OFRECER en cada campo de la página, y desde qué entradas.
 *
 * Lo pregunta el content script en cada pasada. Devuelve **dos booleanos y una lista de
 * ids** por campo: nada de la bóveda cruza al proceso de la página, y la comparación
 * —que necesita el valor guardado— se hace aquí, que es donde vive.
 *
 * Lo escrito sí viaja hacia aquí, pero es del propio formulario: la página ya lo tiene.
 */
async function offersFor ({ url, fields } = {}) {
  let metas = []
  try { metas = await findFor(url) } catch (_) { metas = [] }
  let abiertas = null
  try { abiertas = await openedFor(url) } catch (_) { abiertas = null }

  const out = []
  for (const f of Array.isArray(fields) ? fields : []) {
    const acceso = f.key === 'login'
    const libre = !acceso && !KINDS.includes(f.key)
    // Lo escrito en ESTA casilla, también en un acceso: el usuario y la contraseña son
    // dos botones distintos, y el de la contraseña no se enciende porque haya usuario.
    const value = f.value || ''

    let ids = []
    let same = false
    if (abiertas) {
      const suyas = abiertas.filter(e => acceso ? !!e.secret || !!e.username : e.keys.has(f.key))
      ids = suyas.map(e => e.id)
      same = acceso
        // La credencial es una cosa: es la misma si coinciden las dos mitades que haya.
        ? suyas.some(e => e.secret === (f.secret || '') && e.username === (f.username || ''))
        : suyas.some(e => e.keys.get(f.key) === (f.value || ''))
    } else if (!libre) {
      // Sin abrir solo se puede ir por lo grueso, y un campo que no se reconoce no tiene
      // ni eso: su identidad es la etiqueta, y las etiquetas están dentro.
      ids = metas.filter(m => acceso ? (m.hasSecret || m.type === 'login') : m.hasFields).map(m => m.id)
    }

    out.push({ id: f.id, ids, ...fieldOffers({ value, stored: ids.length > 0, same }) })
  }
  return out
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
  find: p => findFor(p.url),
  offers: p => offersFor(p),
  get: async p => getEntry(await connect(), p.id),
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
