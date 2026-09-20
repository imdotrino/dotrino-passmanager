// ENTRAR CON USUARIO Y CONTRASEÑA, en la extensión (`docs/temporary-access.md`).
//
// Esto corre en la PÁGINA del gestor, no en el service worker, y las dos cosas tienen
// motivo:
//
//   · el WASM de OPAQUE vive en una página sandbox (`opaque-bridge.js`), y un service
//     worker no puede embeber un iframe;
//   · el socket con el proxio aguanta lo que aguante esta pestaña, y una pestaña abierta
//     dura mucho más que un worker, que se duerme a los 30 s.
//
// Lo que NO está aquí es la identidad: su núcleo vive en el worker y no puede haber dos
// sobre el mismo almacén. Se le pide por mensaje lo que hace falta —firmar, emitir el
// papel, meter al aparato en el acta— y **ninguna llave privada cruza**.
//
// LA LIMITACIÓN, y se dice en pantalla: atender a alguien que entra desde otro equipo
// funciona mientras esta pestaña esté abierta. Es la misma regla que la bóveda-pestaña del
// ecosistema («atiende mientras esta página esté abierta»); la que está encendida de verdad
// es la del binario.

import { createLoginDesk, registerLogin, loginAddress, accountFingerprint, sealDeviceKeys, openDeviceKeys } from './vendor/vault/passwordLogins.js'
import { startDeviceVault } from './vendor/vault/index.js'
import { WebSocketProxyClient } from './vendor/proxy-client/index.js'
import { client as opaque, server as opaqueServer } from './opaque-bridge.js'
import { makeDeviceKey, makeDeviceEncKey } from './vendor/identity/capabilities.js'
import { capScope } from './vendor/identity/acta.js'

const KEY = (pid) => `logins/${pid}`

/** Lo que hace falta de la identidad, preguntándoselo al worker. Una llamada, una respuesta. */
function alWorker (op, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ op, payload }, (r) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message))
      if (r?.error) return reject(Object.assign(new Error(r.error.message || r.error.code), { code: r.error.code }))
      resolve(r?.result)
    })
  })
}

/** La identidad vista desde aquí: cada método es un viaje al worker, donde vive su llave. */
const identidad = {
  me: null,
  signData: (data) => alWorker('id.signData', { data }),
  signDelegation: (sub, scope, opts) => alWorker('id.signDelegation', { sub, scope, opts }),
  listDelegations: () => alWorker('id.listDelegations'),
  revokeDelegation: (nonce) => alWorker('id.revokeDelegation', { nonce }),
  revokeDevice: (sub) => alWorker('id.revokeDevice', { sub }),
  admitMember: (m) => alWorker('id.admitMember', m),
  profileActa: () => alWorker('id.profileActa'),
  joinProfile: (acta) => alWorker('id.joinProfile', { acta })
}

let mostrador = null     // { pid, desk, flushed }
let atendiendo = null    // el handle de `startDeviceVault`

/**
 * El escritorio de ESTE perfil. Quiere `load`/`save` síncronos y `chrome.storage` es
 * asíncrono: se hidrata al abrirlo y se escribe detrás.
 *
 * Y se le inyecta el OPAQUE del puente: aquí el WASM está al otro lado de la frontera del
 * sandbox, así que el mostrador contesta promesas.
 */
async function escritorio () {
  const { id: pid, publickey } = await alWorker('id.whoami')
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
    },
    opaque: opaqueServer
  })
  mostrador = { pid, desk, flushed: () => cola }
  return mostrador
}

/** Los aparatos de usuario y contraseña de este perfil, con sus sesiones abiertas. */
export async function listLogins () {
  const { desk } = await escritorio()
  const filas = desk.list()
  if (!filas.length) return []
  const huella = await accountFingerprint(identidad)
  return filas.map((l) => ({ ...l, address: loginAddress(l.user, huella) }))
}

/**
 * ALTA. Las llaves del aparato NACEN aquí y salen ya cerradas con lo que deriva de la
 * contraseña: lo que queda guardado es un paquete que esta extensión no puede abrir.
 *
 * Se pueden tener VARIOS por perfil y cada uno con sus permisos: son miembros del acta como
 * cualquier otro aparato.
 */
export async function addLogin ({ user, password, label = '', caps = ['sign', 'read', 'store'] } = {}) {
  if (typeof password !== 'string' || password.length < 12) {
    throw Object.assign(new Error('la contraseña tiene que tener al menos 12 caracteres'), { code: 'weak-password' })
  }
  const { desk, flushed } = await escritorio()
  const nombre = String(label || 'equipo prestado')
  const reg = await opaque.registrationStart({ password })
  const { response } = await desk.registerBegin({ user, request: reg.request })
  const fin = await opaque.registrationFinish({ state: reg.state, response, password })
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
}

/** Cambiar la contraseña es abrir y volver a cerrar: hace falta la vieja. */
export async function passwdLogin ({ user, oldPassword, newPassword } = {}) {
  if (typeof newPassword !== 'string' || newPassword.length < 12) {
    throw Object.assign(new Error('la contraseña tiene que tener al menos 12 caracteres'), { code: 'weak-password' })
  }
  const { desk, flushed } = await escritorio()
  const start = await opaque.loginStart({ password: oldPassword })
  const begun = await desk.loginBegin({ user, request: start.request })
  let fin
  try { fin = await opaque.loginFinish({ state: start.state, response: begun.response, password: oldPassword }) }
  catch (_) { throw Object.assign(new Error('contraseña incorrecta'), { code: 'login-failed' }) }
  const entrada = await desk.loginEnd({ lid: begun.lid, finalization: fin.finalization, label: 'gestor' })
  const keys = await openDeviceKeys(fin.exportKey, entrada.blob)

  const reg = await opaque.registrationStart({ password: newPassword })
  const { response } = await desk.registerBegin({ user, request: reg.request, replace: true })
  const nueva = await opaque.registrationFinish({ state: reg.state, response, password: newPassword })
  await desk.registerFinish({ user, upload: nueva.upload, blob: await sealDeviceKeys(nueva.exportKey, keys), replace: true })
  await flushed()
  return { ok: true, user }
}

/** Cerrar lo que quedó abierto (sin `sid`, todo lo de ese usuario). */
export async function closeLogin ({ user, sid = null } = {}) {
  const { desk, flushed } = await escritorio()
  if (sid) { const r = desk.closeSession({ user, sid }); await flushed(); return r }
  const fila = desk.list().find((x) => x.user === user)
  for (const s of fila?.sessions || []) desk.closeSession({ user, sid: s.sid })
  await flushed()
  return { ok: true, closed: (fila?.sessions || []).length }
}

/** Quitar la espera que dejan los intentos fallidos. */
export async function unblockLogin ({ user } = {}) {
  const { desk, flushed } = await escritorio()
  const r = desk.clearBlock({ user })
  await flushed()
  return r
}

/** Quitarlo lo saca de aquí **y su llave del acta**: las dos cosas, o ninguna. */
export async function removeLogin ({ user } = {}) {
  const { desk, flushed } = await escritorio()
  const fila = desk.list().find((x) => x.user === user)
  if (!fila) return { ok: false }
  desk.remove({ user })
  await flushed()
  await identidad.revokeDevice(fila.pub)
  return { ok: true, deviceId: fila.deviceId }
}

/**
 * ATENDER a quien entra desde otro equipo. El socket vive en esta página: mientras la
 * pestaña esté abierta, un equipo prestado encuentra esta bóveda por su dirección.
 */
export async function serveLogins ({ proxyUrl = null } = {}) {
  const { desk } = await escritorio()
  if (atendiendo) return { ok: true, already: true }
  if (!desk.list().length) return { ok: false, reason: 'sin-inicios-de-sesion' }
  const client = new WebSocketProxyClient({
    url: proxyUrl || 'wss://proxy.dotrino.com',
    // El camino es el proxio: aquí no se negocia WebRTC con nadie.
    enableWebRTC: false,
    autoReconnect: true
  })
  await client.connect()
  atendiendo = await startDeviceVault(identidad, { client, logins: desk })
  return { ok: true }
}

export function stopServing () {
  if (!atendiendo) return { ok: false }
  try { atendiendo.close() } catch (_) {}
  atendiendo = null
  return { ok: true }
}

export const serving = () => !!atendiendo
