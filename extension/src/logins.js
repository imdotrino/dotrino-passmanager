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
import { loginWithPassword as entrarConContrasena, closeLogin as cerrarEnLaBoveda } from './vendor/vault/loginClient.js'
import { vaultChannel } from './vendor/vault/passwordLogins.js'
import { startDeviceVault } from './vendor/vault/index.js'
import { WebSocketProxyClient } from './vendor/proxy-client/index.js'
import { client as opaque, server as opaqueServer } from './opaque-bridge.js'
import { makeDeviceKey, makeDeviceEncKey } from './vendor/identity/capabilities.js'
import { identitySealing } from './vendor/passmanager/transport/sealed.js'
import { isRequest } from './vendor/passmanager/transport/protocol.js'

const KEY = (pid) => `logins/${pid}`

/**
 * El proxio del ecosistema. Uno solo para las dos mitades —atender y entrar—, porque son
 * la misma conversación vista desde cada punta: con dos constantes, cambiar una dejaba a la
 * otra hablando sola y eso se ve como que nadie contesta.
 */
const PROXY_URL = 'wss://proxy.dotrino.com'

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
let atendiendo = null    // { vault: el handle de `startDeviceVault`, client, onMessage }

/**
 * EL SELLADO del socket de esta pestaña, con la llave de cifrado del PERFIL. La llave vive
 * en el worker: aquí se le pide que selle o que abra, y la privada no cruza.
 *
 * Es el dialecto del núcleo (`encryptionPubkey`/`decrypt` → cadena) que ya entiende
 * `identitySealing`, así que el sobre es el MISMO de las otras bóvedas.
 */
const sellador = {
  encryptionPubkey: () => alWorker('id.encPub'),
  encrypt: (recipients, plaintext) => alWorker('id.encrypt', { recipients, plaintext }),
  decrypt: (from, envelope) => alWorker('id.decrypt', { from, envelope })
}

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
  stopServing()
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
    // Los PERMISOS del acta, cualquiera de ellos y tal cual: los traduce el pilar.
    caps
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
/**
 * HACER DE BÓVEDA: atender a los aparatos de la cuenta mientras esta pestaña esté abierta.
 *
 * Son dos cosas por el MISMO socket, como en el demonio:
 *   · la identidad (`startDeviceVault`): entrar con usuario y contraseña, firmar, el acta;
 *   · las CONTRASEÑAS de la bóveda propia. No hay otra copia: lo que se atiende es lo mismo
 *     que rellena esta extensión, y lo decide y lo escribe el worker. Aquí solo se sostiene
 *     la conexión, que es lo que un worker no puede (se duerme a los 30 s).
 *
 * Sin `requireSealed` en el cliente, y no es un olvido: entrar con contraseña viaja en claro
 * a propósito (quien entra todavía no tiene llave). Lo que corta es el responder, que no
 * atiende una petición de contraseñas que no llegue sellada — igual que en el demonio.
 *
 * Que las contraseñas no se puedan atender (falta convertir) no apaga lo demás: se enciende
 * igual y se dice qué falta.
 */
export async function serveLogins ({ proxyUrl = null } = {}) {
  const { pid, desk } = await escritorio()
  if (atendiendo) return { ok: true, already: true, logins: desk.list().length, passwords: atendiendo.passwords }
  const client = new WebSocketProxyClient({
    url: proxyUrl || PROXY_URL,
    // El camino es el proxio: aquí no se negocia WebRTC con nadie.
    enableWebRTC: false,
    autoReconnect: true,
    sealing: identitySealing(sellador)
  })
  await client.connect()
  const vault = await startDeviceVault(identidad, { client, logins: desk })

  // LAS CONTRASEÑAS. La petición llega aquí ya abierta (la abrió el cliente, con `sealing`)
  // y se la pasa al worker tal cual; lo que él conteste sale SELLADO para quien preguntó.
  const onMessage = async (from, msg, meta) => {
    const p = typeof msg === 'string' ? (() => { try { return JSON.parse(msg) } catch (_) { return null } })() : msg
    if (!isRequest(p)) return
    // Quién pregunta lo dice el proxio (la llave con la que se identificó). Sin eso no hay a
    // quién sellarle la respuesta, y el token no es una llave.
    const pubkey = meta?.fromPubkey || client.pubkeyOfToken?.(from) || null
    if (!pubkey) return
    try {
      const r = await alWorker('pm.serve', { pid, from, pubkey, msg: p, sealed: meta?.sealed === true })
      if (r) await client.sendSealedTo(r.to, r.msg, { peerEncPub: r.peerEncPub })
    } catch (e) {
      console.error('[vault-tab] password request failed:', e?.code || e?.message || e)
    }
  }
  client.on('message', onMessage)

  let passwords
  try { passwords = { ok: true, ...(await alWorker('pm.serve-start', { pid })) } }
  catch (e) { passwords = { ok: false, code: e?.code || null, message: e?.message || String(e) } }

  atendiendo = { vault, client, onMessage, passwords }
  return { ok: true, logins: desk.list().length, passwords }
}

export function stopServing () {
  if (!atendiendo) return { ok: false }
  try { atendiendo.client.off?.('message', atendiendo.onMessage) } catch (_) {}
  try { atendiendo.vault.close() } catch (_) {}
  try { atendiendo.client.close?.() } catch (_) {}
  atendiendo = null
  return { ok: true }
}

export const serving = () => !!atendiendo

// --- ENTRAR desde este navegador (la otra mitad) ------------------------------

/**
 * ENTRAR con `nombre@AB12-CD34-EF56` y una contraseña: este navegador pasa a SER un
 * aparato de esa cuenta.
 *
 * Corre aquí, en la página, por lo mismo que lo demás: el OPAQUE está al otro lado del
 * sandbox y un service worker no puede embeber un iframe ni sostener un socket. Lo que la
 * página hace es hablar con la bóveda; **instalar** la identidad es del núcleo, que vive en
 * el worker, así que lo que sale de aquí se le manda para que lo adopte él.
 *
 * Sí, la llave privada del aparato cruza ese mensaje. No hay forma de evitarlo y tampoco
 * hace falta esconderlo: las dos puntas son esta extensión —`chrome.runtime` no sale de
 * ella— y la alternativa sería meter el WASM en el worker, que es justo lo que la CSP
 * impide. Lo que NO cruza nunca es la contraseña: de ella solo salen los mensajes de OPAQUE.
 *
 * `remember: false` es lo normal en un equipo prestado: la cuenta se va al cerrar.
 */
export async function enterWithPassword ({ address, password, remember = false, label = '', proxyUrl = null } = {}) {
  if (typeof password !== 'string' || !password) {
    throw Object.assign(new Error('hace falta la contraseña'), { code: 'no-password' })
  }
  const url = proxyUrl || PROXY_URL
  const client = new WebSocketProxyClient({ url, enableWebRTC: false, autoReconnect: false })
  await client.connect()
  let entrada
  try {
    entrada = await entrarConContrasena({
      transport: client,
      address,
      password,
      label: label || 'el gestor',
      // El de la página sandbox: asíncrono, y por eso el pilar lo acepta inyectado.
      opaque
    })
  } finally { try { client.close() } catch (_) {} }
  const r = await alWorker('id.adoptLogin', { entrada, remember, proxy: url })
  // El perfil cambió: lo que haya pintado con el anterior ya no vale (no es reactivo).
  mostrador = null
  return { ...r, address: entrada.address, user: entrada.user, caps: entrada.caps }
}

/**
 * SALIR del inicio de sesión: se le AVISA a la bóveda y la cuenta se va de este navegador.
 *
 * Las dos mitades están repartidas y no por gusto: el socket lo tiene esta página y la
 * llave la tiene el worker, así que la página habla y el worker firma (`id.signData`). La
 * privada no cruza. Sin esto, salir dejaba la plaza ocupada en la bóveda para siempre —el
 * núcleo lo intenta por su cuenta con un `import()` dinámico, que en un service worker no
 * existe, y el fallo se lo tragaba un `catch`.
 *
 * El aviso es MEJOR ESFUERZO: si la bóveda está apagada, salir de este equipo no se puede
 * quedar esperándola. Lo que no es mejor esfuerzo es borrar la cuenta de aquí, que pasa
 * siempre.
 */
export async function leaveLogin ({ proxyUrl = null } = {}) {
  let told = false
  try {
    const meta = await alWorker('id.loginMeta')
    if (meta?.sid && meta.publickey) {
      const client = new WebSocketProxyClient({
        url: proxyUrl || meta.proxy || PROXY_URL, enableWebRTC: false, autoReconnect: false
      })
      await client.connect()
      try {
        // El token de la bóveda cambia con cada reconexión suya: se vuelve a mirar el canal
        // en vez de guardarlo.
        for (const token of await client.list(vaultChannel(meta.code))) {
          const r = await cerrarEnLaBoveda({
            transport: client, token, user: meta.user, sid: meta.sid, publickey: meta.publickey,
            sign: (data) => alWorker('id.signData', { data })
          })
          if (r.ok) { told = true; break }
        }
      } finally { try { client.close() } catch (_) {} }
    }
  } catch (_) { /* la bóveda apagada no puede impedir salir de aquí */ }

  const r = await alWorker('id.logoutLogin', {})
  mostrador = null
  return { ...r, told }
}
