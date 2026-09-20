// ENTRAR CON USUARIO Y CONTRASEÑA, desde el service worker: la puerta al documento offscreen.
//
// `dotrino-passmanager/docs/temporary-access.md`. Aquí no hay ni criptografía ni socket —
// están en `offscreen.js`, y el motivo es el que cuenta: **un service worker MV3 se duerme**
// a los ~30 s y se lleva la conexión con él. Atender a alguien que entra desde otro equipo
// funcionaba entonces a ratos, que es la peor forma de funcionar.
//
// Un documento offscreen es una página: no se duerme como el worker, así que el socket
// aguanta mientras exista. Y el WASM del OPAQUE (268 KB) se carga UNA vez allí, en vez de en
// cada arranque de este worker.
//
// Lo que sí se queda aquí es la IDENTIDAD, que es de este worker (`identity-core.js`): dos
// núcleos sobre el mismo almacén se pisarían las llaves. El offscreen le pide lo que
// necesita —firmar, emitir el papel, meter al aparato en el acta— y nunca ve una privada.

const DOC = 'src/offscreen.html'

/**
 * El documento, creándolo si no está. Chrome solo admite UNO por extensión, así que se
 * comprueba antes: crearlo dos veces es un error, y encima uno que aparece «a veces».
 */
let creando = null
async function asegurarDocumento () {
  if (await hayDocumento()) return
  // Dos peticiones a la vez no pueden crear dos documentos: se comparte la promesa.
  creando ||= chrome.offscreen.createDocument({
    url: DOC,
    // `WORKERS` es el motivo honesto: lo que corre ahí es trabajo de fondo que el service
    // worker no puede sostener —una conexión que tiene que seguir abierta—. La
    // justificación se lee tal cual en la revisión de la tienda.
    reasons: ['WORKERS'],
    justification: 'Mantiene la conexión de la bóveda y el cálculo de OPAQUE, que un service worker no puede sostener porque se suspende.'
  }).catch((e) => {
    // Chrome solo admite UNO. Si otra llamada lo creó entre la comprobación y esto, no es
    // un fallo: es la carrera, y el documento que hace falta ya está.
    if (/single offscreen/i.test(e?.message || '')) return
    throw e
  }).finally(() => { creando = null })
  await creando
}

/**
 * ¿Existe ya? `hasDocument()` es de Chrome 116; antes hay que mirar los contextos. Sin una
 * de las dos, crear dos veces revienta con un error que solo aparece «a veces».
 */
async function hayDocumento () {
  if (typeof chrome.offscreen?.hasDocument === 'function') return chrome.offscreen.hasDocument()
  if (typeof chrome.runtime?.getContexts === 'function') {
    const c = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })
    return !!c.length
  }
  return false
}

/** Una llamada al documento. Si no está, se crea; si contesta un error, se propaga con su `code`. */
async function alOffscreen (op, payload = {}) {
  await asegurarDocumento()
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ target: 'offscreen', op, payload }, (r) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message))
      if (r?.error) return reject(Object.assign(new Error(r.error.message || r.error.code), { code: r.error.code }))
      resolve(r?.result)
    })
  })
}

export const listLogins = () => alOffscreen('list')
export const addLogin = (p) => alOffscreen('add', p)
export const passwdLogin = (p) => alOffscreen('passwd', p)
export const closeLogin = (p) => alOffscreen('close', p)
export const unblockLogin = (p) => alOffscreen('unblock', p)
export const removeLogin = (p) => alOffscreen('remove', p)
export const serveLogins = (p) => alOffscreen('serve', p)

/**
 * Dejar de atender **y cerrar el documento**. Lo segundo importa: mientras exista, la
 * extensión mantiene una página abierta, y dejarla ahí sin nada que hacer es gastar memoria
 * y batería por costumbre.
 */
export async function stopServing () {
  if (!(await hayDocumento())) return { ok: false }
  const r = await alOffscreen('stop')
  try { await chrome.offscreen.closeDocument() } catch (_) {}
  return r
}

/** Sin documento no se atiende: se contesta sin crearlo, que preguntarlo no es usarlo. */
export async function serving () {
  if (!(await hayDocumento())) return false
  const r = await alOffscreen('serving')
  return !!r?.serving
}
