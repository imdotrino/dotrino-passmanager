// EL DOCUMENTO OFFSCREEN: donde viven el OPAQUE y la conexión de la bóveda.
//
// Por qué aquí y no en el service worker, que es donde estaba: **un worker MV3 se duerme**
// (unos 30 s sin trabajo) y con él se cae la conexión al proxio. Eso dejaba «atender a
// alguien que entra desde otro equipo» funcionando a ratos, que es la peor forma de
// funcionar — parece que va y un día no va, sin que nadie pueda decir por qué.
//
// Un documento offscreen es una PÁGINA: no se duerme como el worker, así que el socket
// aguanta mientras el navegador esté abierto y el documento exista. Y de paso el worker
// deja de cargar el WASM del OPAQUE (268 KB) en cada arranque: aquí se carga una vez.
//
// LO QUE NO ESTÁ AQUÍ, a propósito: la IDENTIDAD. El núcleo (`identity-core.js`) vive en el
// service worker y no puede haber dos sobre el mismo almacén — dos núcleos se pisarían las
// llaves, y eso ya está avisado allí. Así que lo que hace falta de ella (firmar, emitir el
// papel, meter al aparato en el acta) se le PIDE al worker por mensajes. Aquí solo vive lo
// que el worker no puede tener: el WASM y el socket.

import { createLoginDesk, registerLogin, loginAddress, accountFingerprint, sealDeviceKeys, openDeviceKeys } from './vendor/vault/passwordLogins.js'
import { startDeviceVault } from './vendor/vault/index.js'
import { WebSocketProxyClient } from './vendor/proxy-client/index.js'
import { client as opaque } from './vendor/opaque/index.js'
import { makeDeviceKey, makeDeviceEncKey } from './vendor/identity/capabilities.js'
import { capScope } from './vendor/identity/acta.js'

const KEY = (pid) => `logins/${pid}`

/** Lo que necesita de la identidad, preguntándoselo al worker. Una llamada, una respuesta. */
function alWorker (op, payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ target: 'worker', op, payload }, (r) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message))
      if (r?.error) return reject(Object.assign(new Error(r.error.message || r.error.code), { code: r.error.code }))
      resolve(r?.result)
    })
  })
}

/**
 * La identidad, vista desde aquí. Cumple lo que `startDeviceVault` y `registerLogin` piden,
 * y cada método es un viaje al worker: la llave privada no sale de allí ni en un mensaje.
 */
const identidad = {
  me: null,   // se rellena al abrir (`me` es un getter en el original)
  signData: (data) => alWorker('id.signData', { data }),
  signDelegation: (sub, scope, opts) => alWorker('id.signDelegation', { sub, scope, opts }),
  listDelegations: () => alWorker('id.listDelegations', {}),
  revokeDelegation: (nonce) => alWorker('id.revokeDelegation', { nonce }),
  revokeDevice: (sub) => alWorker('id.revokeDevice', { sub }),
  admitMember: (m) => alWorker('id.admitMember', m),
  profileActa: () => alWorker('id.profileActa', {}),
  joinProfile: (acta) => alWorker('id.joinProfile', { acta })
}

let mostrador = null      // { pid, desk, flushed }
let atendiendo = null     // el handle de `startDeviceVault`

/**
 * El escritorio de los inicios de sesión de ESTE perfil. Quiere `load`/`save` síncronos y
 * `chrome.storage` es asíncrono: se hidrata al abrirlo y se escribe detrás.
 */
async function escritorio () {
  const { id: pid, publickey } = await alWorker('id.whoami', {})
  identidad.me = { publickey }
  if (mostrador?.pid === pid) return mostrador
  if (atendiendo) { try { atendiendo.close() } catch (_) {} atendiendo = null }
  const clave = KEY(pid)
  let estado = (await chrome.storage.local.get(clave))[clave] || null
  let cola = Promise.resolve()
  const desk = createLoginDesk({
    load: () => estado,
    save: (s) => {
      estado = s
      cola = cola.then(() => chrome.storage.local.set({ [clave]: s }))
      cola.catch((e) => console.error('[logins] no se pudo guardar: %s', e?.message || e))
    }
  })
  mostrador = { pid, desk, flushed: () => cola }
  return mostrador
}

const OPS = {
  async list () {
    const { desk } = await escritorio()
    const filas = desk.list()
    if (!filas.length) return []
    const huella = await accountFingerprint(identidad)
    return filas.map((l) => ({ ...l, address: loginAddress(l.user, huella) }))
  },

  /**
   * ALTA. Las llaves del aparato NACEN aquí y salen ya cerradas con lo que deriva de la
   * contraseña: lo que queda guardado es un paquete que esta extensión no puede abrir.
   */
  async add ({ user, password, label = '', caps = ['sign', 'read', 'store'] } = {}) {
    if (typeof password !== 'string' || password.length < 12) {
      throw Object.assign(new Error('la contraseña tiene que tener al menos 12 caracteres'), { code: 'weak-password' })
    }
    const { desk, flushed } = await escritorio()
    const nombre = String(label || 'equipo prestado')
    const reg = opaque.registrationStart({ password })
    const { response } = desk.registerBegin({ user, request: reg.request })
    const fin = opaque.registrationFinish({ state: reg.state, response, password })
    const device = await makeDeviceKey({ label: nombre })
    const enc = await makeDeviceEncKey()
    const blob = await sealDeviceKeys(fin.exportKey, { sign: device.privateJwk, enc: enc.encPrivateJwk })
    const r = await registerLogin({
      identity: identidad,
      logins: desk,
      user,
      upload: fin.upload,
      pub: device.publickey,
      encPub: enc.encPublickey,
      label: nombre,
      blob,
      scope: caps.filter((c) => c !== 'unattended').map((c) => capScope(c)).filter(Boolean),
      unattended: caps.includes('unattended')
    })
    await flushed()
    return { ...r, address: loginAddress(user, await accountFingerprint(identidad)) }
  },

  /** Cambiar la contraseña es abrir y volver a cerrar: hace falta la vieja. */
  async passwd ({ user, oldPassword, newPassword } = {}) {
    if (typeof newPassword !== 'string' || newPassword.length < 12) {
      throw Object.assign(new Error('la contraseña tiene que tener al menos 12 caracteres'), { code: 'weak-password' })
    }
    const { desk, flushed } = await escritorio()
    const start = opaque.loginStart({ password: oldPassword })
    const begun = desk.loginBegin({ user, request: start.request })
    let fin
    try { fin = opaque.loginFinish({ state: start.state, response: begun.response, password: oldPassword }) }
    catch (_) { throw Object.assign(new Error('contraseña incorrecta'), { code: 'login-failed' }) }
    const entrada = desk.loginEnd({ lid: begun.lid, finalization: fin.finalization, label: 'gestor' })
    const keys = await openDeviceKeys(fin.exportKey, entrada.blob)

    const reg = opaque.registrationStart({ password: newPassword })
    const { response } = desk.registerBegin({ user, request: reg.request, replace: true })
    const nueva = opaque.registrationFinish({ state: reg.state, response, password: newPassword })
    desk.registerFinish({ user, upload: nueva.upload, blob: await sealDeviceKeys(nueva.exportKey, keys), replace: true })
    await flushed()
    return { ok: true, user }
  },

  async close ({ user, sid = null } = {}) {
    const { desk, flushed } = await escritorio()
    if (sid) { const r = desk.closeSession({ user, sid }); await flushed(); return r }
    const fila = desk.list().find((x) => x.user === user)
    for (const s of fila?.sessions || []) desk.closeSession({ user, sid: s.sid })
    await flushed()
    return { ok: true, closed: (fila?.sessions || []).length }
  },

  async unblock ({ user } = {}) {
    const { desk, flushed } = await escritorio()
    const r = desk.clearBlock({ user })
    await flushed()
    return r
  },

  /** Quitarlo lo saca de aquí **y su llave del acta**: las dos cosas, o ninguna. */
  async remove ({ user } = {}) {
    const { desk, flushed } = await escritorio()
    const fila = desk.list().find((x) => x.user === user)
    if (!fila) return { ok: false }
    desk.remove({ user })
    await flushed()
    await identidad.revokeDevice(fila.pub)
    return { ok: true, deviceId: fila.deviceId }
  },

  /**
   * ATENDER. El socket vive aquí, que es lo que hace que aguante: el worker se duerme y
   * esta página no. Mientras el documento exista y el navegador esté abierto, un equipo
   * prestado encuentra esta bóveda por su dirección y entra.
   */
  async serve ({ proxyUrl = null } = {}) {
    const { desk } = await escritorio()
    if (atendiendo) return { ok: true, already: true }
    if (!desk.list().length) return { ok: false, reason: 'sin-inicios-de-sesion' }
    const client = new WebSocketProxyClient({
      url: proxyUrl || 'wss://proxy.dotrino.com',
      // Un documento offscreen no pinta nada y no negocia WebRTC: el camino es el proxio.
      enableWebRTC: false,
      autoReconnect: true
    })
    await client.connect()
    atendiendo = await startDeviceVault(identidad, { client, logins: desk })
    return { ok: true }
  },

  async stop () {
    if (!atendiendo) return { ok: false }
    try { atendiendo.close() } catch (_) {}
    atendiendo = null
    return { ok: true }
  },

  async serving () { return { serving: !!atendiendo } }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Solo lo dirigido AQUÍ. Sin esta marca, este oyente contestaría también a lo que el
  // gestor le manda al worker y las dos respuestas competirían.
  if (msg?.target !== 'offscreen') return false
  const op = OPS[msg.op]
  if (!op) { sendResponse({ error: { code: 'unknown-op' } }); return false }
  Promise.resolve(op(msg.payload || {}))
    .then((result) => sendResponse({ result }))
    .catch((e) => sendResponse({ error: { code: e?.code || 'error', message: e?.message } }))
  return true
})
