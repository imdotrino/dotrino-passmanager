// LA BÓVEDA DE LA EXTENSIÓN (`docs/temporary-access.md`, `dotrino-vault/docs/three-versions.md`).
//
// Corre el MISMO núcleo que el binario (`@dotrino/vault/browser`): emparejar, firmar, el
// almacén, los cajones, las aprobaciones, la consola remota, los incidentes y entrar con
// usuario y contraseña. Lo que pone la extensión es lo de su contexto:
//
//   · corre en la PESTAÑA de bóveda, no en el service worker: el WASM de OPAQUE vive en
//     una página sandbox (`opaque-bridge.js`) y un worker se duerme a los 30 s;
//   · la identidad vive en el worker y no puede haber dos núcleos sobre el mismo almacén,
//     así que aquí se le pide por mensaje cada cosa (firmar, el acta) — **ninguna llave
//     privada cruza**;
//   · las CONTRASEÑAS las atiende el worker, que es el único que escribe su almacén, pero
//     con la política del binario (quién pide aprobación y a quién).
//
// UNA bóveda escribe, como en el binario: lo que se administra desde el gestor (los inicios
// de sesión) se le pide a la pestaña de bóveda por un canal entre páginas. Sin la pestaña
// abierta no hay a quién pedírselo, y se dice (`not-the-vault`).
import { loginAddress, accountFingerprint, sealDeviceKeys, openDeviceKeys, vaultChannel } from './vendor/vault/passwordLogins.js'
import { loginWithPassword as entrarConContrasena, closeLogin as cerrarEnLaBoveda } from './vendor/vault/loginClient.js'
import { startBrowserVault } from './vendor/vault/browser.js'
import { WebSocketProxyClient } from './vendor/proxy-client/index.js'
import { client as opaque, server as opaqueServer } from './opaque-bridge.js'
import { makeDeviceKey, makeDeviceEncKey } from './vendor/identity/capabilities.js'
import { identitySealing } from './vendor/passmanager/transport/sealed.js'
import { isRequest } from './vendor/passmanager/transport/protocol.js'
import { askWorker as alWorker } from './page.js'

const LEGACY_KEY = (pid) => `logins/${pid}`

/**
 * El proxio del ecosistema. Uno solo para las dos mitades —atender y entrar—, porque son
 * la misma conversación vista desde cada punta: con dos constantes, cambiar una dejaba a la
 * otra hablando sola y eso se ve como que nadie contesta.
 */
const PROXY_URL = 'wss://proxy.dotrino.com'

/** Lo que hace falta de la identidad, preguntándoselo al worker. Una llamada, una respuesta. */

/**
 * EL NÚCLEO DE IDENTIDAD VISTO DESDE AQUÍ. Tiene la forma del de verdad (`handlers`, `me`,
 * `masterLocked`) y cada llamada es un viaje al worker, donde vive la llave.
 */
async function nucleoRemoto () {
  let estado = await alWorker('id.state')
  const refresco = setInterval(() => { alWorker('id.state').then((e) => { estado = e }).catch(() => {}) }, 15000)
  return {
    handlers: new Proxy({}, {
      get: (_, name) => {
        // LA LLAVE DE SELLADO vive en el disco de esta pestaña y el acta la sella el worker:
        // el proveedor no puede cruzar un mensaje (es una función), así que el worker se
        // queda con uno que le pregunta a esta pestaña (`vault.mintSealKey`).
        if (name === 'setSealKeyProvider') {
          return ({ provider } = {}) => {
            selladoras = typeof provider === 'function' ? provider : null
            return alWorker('id.sealKeysFromTab', { on: !!selladoras })
          }
        }
        return (params) => alWorker('id.handler', { name, params: params ?? {} })
      }
    }),
    get me () { return estado?.me || null },
    get masterLocked () { return !!estado?.masterLocked },
    stop: () => clearInterval(refresco)
  }
}

/** Lo que `accountFingerprint` necesita: el acta de la cuenta. */
const identidad = { profileActa: () => alWorker('id.profileActa') }

/**
 * EL SELLADO del socket de esta pestaña, con la llave de cifrado del PERFIL. La llave vive
 * en el worker: aquí se le pide que selle o que abra, y la privada no cruza.
 */
const sellador = {
  encryptionPubkey: () => alWorker('id.encPub'),
  encrypt: (recipients, plaintext) => alWorker('id.encrypt', { recipients, plaintext }),
  decrypt: (from, envelope) => alWorker('id.decrypt', { from, envelope })
}

let atendiendo = null    // { vault, client, onMessage, passwords, canal, nucleo }
let selladoras = null    // el proveedor de llaves de sellado de la bóveda de esta pestaña

// --- EL CANAL ENTRE PÁGINAS ---------------------------------------------------
//
// La pestaña de bóveda contesta; las demás páginas de la extensión preguntan. Solo lo que
// la pantalla de inicios de sesión necesita, y nada más.
const CANAL = 'dotrino-vault-tab'
const METODOS = new Set(['listLogins', 'loginRegisterBegin', 'loginRegisterFinish', 'loginBegin', 'loginEnd', 'closeLogin', 'clearLoginBlock', 'removeLogin'])

function servirCanal (vault) {
  const bc = new BroadcastChannel(CANAL)
  bc.onmessage = async ({ data }) => {
    if (!data || data.t !== 'req' || !METODOS.has(data.method)) return
    try {
      bc.postMessage({ t: 'res', id: data.id, result: await vault[data.method](...(data.args || [])) })
    } catch (e) {
      bc.postMessage({ t: 'res', id: data.id, error: { message: e?.message || String(e), code: e?.code || null } })
    }
  }
  return bc
}

/** La bóveda a la que pedirle: la de esta página, o la de la pestaña de bóveda. */
async function boveda () {
  if (atendiendo) return atendiendo.vault
  return new Proxy({}, {
    // `then` no: sin esto, `await boveda()` tomaría el proxy por una promesa.
    get: (_, method) => method === 'then' ? undefined : (...args) => new Promise((resolve, reject) => {
      const bc = new BroadcastChannel(CANAL)
      const id = Math.random().toString(36).slice(2)
      const fin = (fn) => { clearTimeout(t); bc.close(); fn() }
      // Sin respuesta en un rato, no hay pestaña de bóveda: se dice, con su código.
      const t = setTimeout(() => fin(() => reject(Object.assign(new Error('the vault tab is not open: open it to manage password logins'), { code: 'not-the-vault' }))), 2000)
      bc.onmessage = ({ data }) => {
        if (data?.t !== 'res' || data.id !== id) return
        if (data.error) fin(() => reject(Object.assign(new Error(data.error.message), { code: data.error.code })))
        else fin(() => resolve(data.result))
      }
      bc.postMessage({ t: 'req', id, method, args })
    })
  })
}

/** Los aparatos de usuario y contraseña de este perfil, con sus sesiones abiertas. */
export async function listLogins () {
  const filas = await (await boveda()).listLogins()
  if (!filas.length) return []
  const huella = await accountFingerprint(identidad)
  return filas.map((l) => ({ ...l, address: loginAddress(l.user, huella) }))
}

/**
 * ALTA. Las llaves del aparato NACEN aquí y salen ya cerradas con lo que deriva de la
 * contraseña: lo que guarda la bóveda es un paquete que no puede abrir. Es el mismo camino
 * que `logins add` del binario y que la pestaña de `vault.dotrino.com`.
 */
export async function addLogin ({ user, password, label = '', caps = ['sign', 'read', 'store'] } = {}) {
  if (typeof password !== 'string' || password.length < 12) {
    throw Object.assign(new Error('la contraseña tiene que tener al menos 12 caracteres'), { code: 'weak-password' })
  }
  const v = await boveda()
  const nombre = String(label || 'equipo prestado')
  const reg = await opaque.registrationStart({ password })
  const { response } = await v.loginRegisterBegin({ user, request: reg.request })
  const fin = await opaque.registrationFinish({ state: reg.state, response, password })
  const device = await makeDeviceKey({ label: nombre })
  const enc = await makeDeviceEncKey()
  const blob = await sealDeviceKeys(fin.exportKey, { sign: device.privateJwk, enc: enc.encPrivateJwk })
  const r = await v.loginRegisterFinish({
    user, upload: fin.upload, pub: device.publickey, encPub: enc.encPublickey, label: nombre, blob,
    // Los PERMISOS del acta, cualquiera de ellos y tal cual: los traduce el pilar.
    caps
  })
  return { ...r, address: loginAddress(user, await accountFingerprint(identidad)) }
}

/** Cambiar la contraseña es abrir y volver a cerrar: hace falta la vieja. */
export async function passwdLogin ({ user, oldPassword, newPassword } = {}) {
  if (typeof newPassword !== 'string' || newPassword.length < 12) {
    throw Object.assign(new Error('la contraseña tiene que tener al menos 12 caracteres'), { code: 'weak-password' })
  }
  const v = await boveda()
  const start = await opaque.loginStart({ password: oldPassword })
  const begun = await v.loginBegin({ user, request: start.request })
  let fin
  try { fin = await opaque.loginFinish({ state: start.state, response: begun.response, password: oldPassword }) }
  catch (_) { throw Object.assign(new Error('contraseña incorrecta'), { code: 'login-failed' }) }
  const entrada = await v.loginEnd({ lid: begun.lid, finalization: fin.finalization, label: 'gestor' })
  const keys = await openDeviceKeys(fin.exportKey, entrada.blob)

  const reg = await opaque.registrationStart({ password: newPassword })
  const { response } = await v.loginRegisterBegin({ user, request: reg.request, replace: true })
  const nueva = await opaque.registrationFinish({ state: reg.state, response, password: newPassword })
  await v.loginRegisterFinish({ user, upload: nueva.upload, blob: await sealDeviceKeys(nueva.exportKey, keys), replace: true })
  return { ok: true, user }
}

/** Cerrar lo que quedó abierto (sin `sid`, todo lo de ese usuario). */
export async function closeLogin ({ user, sid = null } = {}) {
  const v = await boveda()
  if (sid) return v.closeLogin({ user, sid })
  const fila = (await v.listLogins()).find((x) => x.user === user)
  for (const s of fila?.sessions || []) await v.closeLogin({ user, sid: s.sid })
  return { ok: true, closed: (fila?.sessions || []).length }
}

/** Quitar la espera que dejan los intentos fallidos. */
export async function unblockLogin ({ user } = {}) {
  return (await boveda()).clearLoginBlock({ user })
}

/** Quitarlo lo saca de aquí **y su llave del acta**: las dos cosas, o ninguna. */
export async function removeLogin ({ user } = {}) {
  const v = await boveda()
  const fila = (await v.listLogins()).find((x) => x.user === user)
  if (!fila) return { ok: false }
  const r = await v.removeLogin({ user })
  await alWorker('id.revokeDevice', { sub: fila.pub })
  return { ...r, deviceId: fila.deviceId }
}

/**
 * HACER DE BÓVEDA: el núcleo entero, mientras esta pestaña esté abierta.
 *
 * Las contraseñas van por el MISMO socket, como en el demonio, pero las atiende el worker:
 * la petición llega aquí ya abierta (la abrió el cliente, con `sealing`) y se le pasa tal
 * cual; lo que él conteste sale SELLADO para quien preguntó. Cuándo pedir aprobación y a
 * quién lo decide el núcleo, con la regla del binario (`vault.needs` / `vault.approve`).
 *
 * Sin `requireSealed` en el cliente, y no es un olvido: entrar con contraseña viaja en claro
 * a propósito (quien entra todavía no tiene llave). Lo que corta es el responder, que no
 * atiende una petición de contraseñas que no llegue sellada — igual que en el demonio.
 */
export async function serveLogins ({ proxyUrl = null } = {}) {
  if (atendiendo) return { ok: true, already: true, logins: atendiendo.vault.listLogins().length, passwords: atendiendo.passwords }
  const { id: pid } = await alWorker('id.whoami')
  const nucleo = await nucleoRemoto()
  // LA POLÍTICA, para el worker: cuándo se pide aprobación y la espera del sí. Y la llave
  // de sellado, que el worker pide ya DURANTE el arranque: por eso se escucha antes.
  let enMarcha = null
  const pedirA = () => { if (!enMarcha) throw new Error('the vault is still starting'); return enMarcha }
  const politica = (m, _sender, reply) => {
    if (m?.op === 'vault.needs') { pedirA().passwordsNeedApproval(m.pubkey).then((v) => reply({ result: v }), (e) => reply({ error: { message: e.message } })); return true }
    if (m?.op === 'vault.approve') { pedirA().approvePasswordRequest(m.req).then((v) => reply({ result: v }), (e) => reply({ error: { message: e.message } })); return true }
    if (m?.op === 'vault.mintSealKey') {
      if (!selladoras) { reply({ error: { message: 'this vault tab has no sealing keys' } }); return false }
      Promise.resolve(selladoras()).then((v) => reply({ result: v }), (e) => reply({ error: { message: e.message } }))
      return true
    }
    return false
  }
  chrome.runtime.onMessage.addListener(politica)

  let client = null
  let vault
  try {
  vault = await startBrowserVault({
    core: nucleo,
    proxyUrl: proxyUrl || PROXY_URL,
    // El cliente lo crea esta página (un service worker no podría sostenerlo) y con el
    // sellado del perfil, que es el sobre de las contraseñas.
    makeClient: ({ url, acceptDirectFrom }) => {
      client = new WebSocketProxyClient({ url, enableWebRTC: false, autoReconnect: true, sealing: identitySealing(sellador), acceptDirectFrom })
      return client
    },
    opaque: opaqueServer,
    servePasswords: false,
    // Lo que el gestor guardaba antes en `chrome.storage`, una vez.
    legacyLogins: async () => {
      const k = LEGACY_KEY(pid)
      const state = (await chrome.storage.local.get(k))[k] || null
      return state ? { state, drop: () => chrome.storage.local.remove(k) } : null
    },
    log: (...a) => console.log(...a)
  })
  } catch (e) {
    chrome.runtime.onMessage.removeListener(politica)
    nucleo.stop()
    throw e
  }
  enMarcha = vault

  // LAS CONTRASEÑAS, al worker.
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

  atendiendo = { vault, client, onMessage, passwords, canal: servirCanal(vault), politica, nucleo }
  return { ok: true, logins: vault.listLogins().length, passwords }
}

export function stopServing () {
  if (!atendiendo) return { ok: false }
  const a = atendiendo
  atendiendo = null
  try { a.client.off?.('message', a.onMessage) } catch (_) {}
  try { chrome.runtime.onMessage.removeListener(a.politica) } catch (_) {}
  try { a.canal.close() } catch (_) {}
  try { a.nucleo.stop() } catch (_) {}
  selladoras = null
  alWorker('id.sealKeysFromTab', { on: false }).catch(() => {})
  Promise.resolve(a.vault.close()).catch(() => {})
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
  return { ...r, told }
}

// --- EL RESPALDO (dotrino-vault/docs/respaldo.md) -----------------------------------
//
// Solo en la pestaña que ES la bóveda: no viaja por el canal entre páginas (no está en
// METODOS). El archivo se cierra aquí, con la contraseña del respaldo.
//
// LAS CONTRASEÑAS NO VAN POR AQUÍ. En la extensión las guarda el worker, con su propia copia
// de recuperación; la bóveda de esta pestaña ni las ve (`servePasswords: false`). Así que el
// respaldo de la extensión lleva los cajones (servicios, aparatos, `@me`), y al importar se
// aparta lo de contraseñas y se dice cuántas eran: escribirlas en el almacén de esta pestaña
// sería guardarlas donde nadie las lee.

const PASSWORDS = 'passwords'
function bovedaAqui () {
  if (!atendiendo) throw Object.assign(new Error('this tab is not serving the vault'), { code: 'not-the-vault' })
  return atendiendo.vault
}

/** Los cajones que hay: `[{ owner, count, device? }]`. */
export async function backupDrawers () {
  return (await bovedaAqui().backupDrawers()).filter((d) => d.owner !== PASSWORDS)
}

/** Exporta todo (`drawers: null`) o esos cajones, ya cifrado con `password`. */
export async function backupExport ({ drawers = null, password } = {}) {
  const { sealBackup } = await import('./vendor/vault/core/backup.js')
  const v = bovedaAqui()
  const todos = (await v.backupDrawers()).map((d) => d.owner).filter((o) => o !== PASSWORDS)
  const { payload, summary } = await v.exportBackup({ drawers: drawers || todos })
  return { file: await sealBackup(payload, password), summary }
}

/** Lo que trae un respaldo, sin sus contraseñas, y cuántas se apartaron. */
async function sinContrasenas (file, password) {
  const { openBackup } = await import('./vendor/vault/core/backup.js')
  const payload = await openBackup(file, password)
  const pwd = payload.drawers.find((d) => d.owner === PASSWORDS)
  return { payload, drawers: payload.drawers.map((d) => d.owner).filter((o) => o !== PASSWORDS), passwordsLeftOut: pwd?.entries?.length || 0 }
}

/** El plan de importar: qué es nuevo, igual o choca. No escribe nada. */
export async function backupPlan ({ file, password, map = {} } = {}) {
  const v = bovedaAqui()
  const { payload, drawers, passwordsLeftOut } = await sinContrasenas(file, password)
  if (!drawers.length) return { drawers: [], counts: { new: 0, same: 0, conflict: 0, skipped: 0 }, passwordsLeftOut }
  return { ...(await v.planBackupImport(payload, { drawers, map })), passwordsLeftOut }
}

/** Importa. Con un choque sin decidir lanza `BACKUP_CONFLICTS` y no escribe nada. */
export async function backupImport ({ file, password, map = {}, decisions = {} } = {}) {
  const v = bovedaAqui()
  const { payload, drawers } = await sinContrasenas(file, password)
  // Una lista vacía es «todos» para el núcleo: con un respaldo que solo trae contraseñas,
  // pasarla tal cual las metería en el almacén de esta pestaña.
  if (!drawers.length) return { written: 0, kept: 0, same: 0, skipped: [], keptPrivate: [] }
  return v.importBackup(payload, { drawers, map, decisions })
}
