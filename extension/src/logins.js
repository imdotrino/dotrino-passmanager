// ENTRAR CON USUARIO Y CONTRASEÑA, dentro de la extensión.
//
// `dotrino-passmanager/docs/temporary-access.md`. El binario y la bóveda-pestaña ya sabían
// crear y atender estos aparatos; esta era la tercera versión y no sabía ninguna de las dos
// cosas — y las tres tienen que hacer lo mismo salvo por las limitaciones de su contexto
// (`sealed-passwords.md` §2.7).
//
// LA LIMITACIÓN DE ESTE CONTEXTO, dicha antes que nada: **un service worker MV3 se duerme**
// (unos 30 s sin trabajo). Crear y administrar funciona siempre, porque es local; ATENDER a
// alguien que entra desde otro equipo solo funciona mientras el worker esté despierto, o sea
// en la práctica mientras tengas el gestor abierto. La bóveda que está encendida de verdad
// es el binario.
//
// El OPAQUE es WASM y MV3 lo bloquea con su CSP por defecto: el manifiesto declara
// `'wasm-unsafe-eval'`, que NO habilita `eval()` de JavaScript ni código remoto — solo deja
// instanciar el módulo que ya viaja dentro del paquete. Se instancia perezosamente, en la
// primera operación, así que arrancar el worker no lo paga.

import { createLoginDesk, registerLogin, loginAddress, accountFingerprint, sealDeviceKeys, openDeviceKeys } from './vendor/vault/passwordLogins.js'
import { WebSocketProxyClient } from './vendor/proxy-client/index.js'
import { startDeviceVault } from './vendor/vault/index.js'
import { client as opaque } from './vendor/opaque/index.js'
import { makeDeviceKey, makeDeviceEncKey } from './vendor/identity/capabilities.js'
import { capScope } from './vendor/identity/acta.js'
import { identityCore } from './identity-core.js'

const KEY = (pid) => `logins/${pid}`

/**
 * El escritorio quiere `load`/`save` SÍNCRONOS y `chrome.storage` es asíncrono: se hidrata
 * entero al abrirlo y se escribe detrás. Es el mismo trato que hace `identity-core.js` con
 * el kv, y se puede por lo mismo — lo que guarda son registros cortos, no la bóveda.
 */
async function abrirEscritorio (pid) {
  const clave = KEY(pid)
  const guardado = (await chrome.storage.local.get(clave))[clave] || null
  let estado = guardado
  let cola = Promise.resolve()
  const desk = createLoginDesk({
    load: () => estado,
    save: (s) => {
      estado = s
      cola = cola.then(() => chrome.storage.local.set({ [clave]: s }))
      cola.catch((e) => console.error('[logins] no se pudo guardar: %s', e?.message || e))
    }
  })
  return { desk, flushed: () => cola }
}

/** El perfil activo. Los inicios de sesión son de UNA cuenta, no del navegador. */
async function perfilActivo () {
  const { handlers } = await identityCore()
  const { id } = await handlers.currentProfile()
  if (!id) throw Object.assign(new Error('no hay perfil abierto'), { code: 'no-profile' })
  return id
}

/** El adaptador que `startDeviceVault` espera: el mismo que usa el iframe de identidad. */
async function comoBoveda () {
  const { handlers, me } = await identityCore()
  return {
    get me () { return me },
    signData: (data) => handlers.signData({ data }),
    signDelegation: (sub, scope, opts) => handlers.signDelegation({ sub, scope, ...(opts || {}) }),
    listDelegations: () => handlers.listDelegations({}),
    revokeDelegation: (nonce) => handlers.revokeDelegation({ nonce }),
    revokeDevice: (sub) => handlers.revokeDevice({ sub }),
    admitMember: (m) => handlers.admitMember(m),
    profileActa: () => handlers.profileActa({}),
    joinProfile: (acta) => handlers.joinProfile({ acta })
  }
}

let mostrador = null       // { pid, desk, flushed, vault }
let atendiendo = null      // el handle de `startDeviceVault`, si se está atendiendo

/** El escritorio de ESTE perfil, abierto una vez. Cambiar de perfil lo tira. */
async function escritorio () {
  const pid = await perfilActivo()
  if (mostrador?.pid === pid) return mostrador
  if (atendiendo) { try { atendiendo.close() } catch (_) {} atendiendo = null }
  mostrador = { pid, ...(await abrirEscritorio(pid)) }
  return mostrador
}

/** Los aparatos de usuario y contraseña de este perfil, con sus sesiones abiertas. */
export async function listLogins () {
  const { desk } = await escritorio()
  const lista = desk.list()
  if (!lista.length) return []
  const huella = await accountFingerprint(await comoBoveda())
  return lista.map((l) => ({ ...l, address: loginAddress(l.user, huella) }))
}

/**
 * DAR DE ALTA uno. Las llaves del aparato NACEN aquí y salen ya cerradas con lo que deriva
 * de la contraseña: lo que queda guardado es un paquete que esta extensión no puede abrir.
 *
 * Se pueden tener VARIOS por perfil y cada uno con sus permisos: son miembros del acta como
 * cualquier otro aparato.
 */
export async function addLogin ({ user, password, label = '', caps = ['sign', 'read', 'store'] } = {}) {
  if (typeof password !== 'string' || password.length < 12) {
    throw Object.assign(new Error('la contraseña tiene que tener al menos 12 caracteres'), { code: 'weak-password' })
  }
  const { desk, flushed } = await escritorio()
  const identidad = await comoBoveda()
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
}

/**
 * CAMBIAR LA CONTRASEÑA es abrir y volver a cerrar: el aparato, su llave y su papel siguen
 * siendo los mismos. Por eso hace falta la vieja, y por eso lo que estuviera abierto se cierra.
 */
export async function passwdLogin ({ user, oldPassword, newPassword } = {}) {
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

/**
 * QUITARLO: se va de aquí **y su llave sale del acta**. Borrar solo el inicio de sesión
 * dejaba un miembro que ya no puede entrar y sigue siendo de la cuenta.
 */
export async function removeLogin ({ user } = {}) {
  const { desk, flushed } = await escritorio()
  const fila = desk.list().find((x) => x.user === user)
  if (!fila) return { ok: false }
  desk.remove({ user })
  await flushed()
  // Su llave sale del acta. Si eso falla, se dice: un inicio de sesión borrado que deja al
  // miembro dentro es justo el fantasma que `logins rm` vino a evitar.
  const { handlers } = await identityCore()
  await handlers.revokeDevice({ sub: fila.pub })
  return { ok: true, deviceId: fila.deviceId }
}

/**
 * ATENDER desde otro equipo. Levanta el mostrador del ecosistema con este escritorio, y se
 * anuncia en el canal de la cuenta para que un equipo prestado la encuentre por su dirección.
 *
 * Se para solo cuando el worker se duerme, que es la limitación de este contexto y no un
 * fallo: mientras tanto, la bóveda del PC sigue siendo la que está encendida de verdad.
 */
export async function serveLogins ({ proxyUrl = null } = {}) {
  const { desk, pid } = await escritorio()
  if (atendiendo) return { ok: true, already: true }
  if (!desk.list().length) return { ok: false, reason: 'sin-inicios-de-sesion' }
  // EL CLIENTE SE PASA HECHO. `startDeviceVault` lo levantaría solo con un `import()`
  // dinámico, y eso un service worker no lo admite.
  const client = new WebSocketProxyClient({
    url: proxyUrl || 'wss://proxy.dotrino.com',
    // No hay `RTCPeerConnection` en un worker: con WebRTC encendido la negociación revienta.
    enableWebRTC: false,
    autoReconnect: true
  })
  await client.connect()
  atendiendo = await startDeviceVault(await comoBoveda(), { client, logins: desk })
  return { ok: true, pid }
}

export function stopServing () {
  if (!atendiendo) return { ok: false }
  try { atendiendo.close() } catch (_) {}
  atendiendo = null
  return { ok: true }
}

export const serving = () => !!atendiendo
