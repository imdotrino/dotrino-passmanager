// El protocolo entre quien pide una credencial y quien la custodia.
//
// Viaja por @dotrino/proxy-client (`sendByPubkey`), que es el transporte del
// ecosistema — no se abre un socket propio ni se reimplementa nada de esto.
//
// El contenido lo sella el TRANSPORTE (`@dotrino/proxy-client` ≥ 0.13.0), no esto:
// aquí solo se define qué se pide y cómo se contesta. Ojo con la suposición fácil —
// el proxio enruta pero NO cifra, y darlo por hecho fue el agujero del §2.2.

export const TYPE = 'dotrino.passmanager/1'
export const REPLY = 'dotrino.passmanager.reply/1'

/**
 * Lo que un aparato puede pedir. `list` NO está, y esa ausencia es el diseño: si un
 * aparato pudiera pedir la bóveda entera, el «de a una» no significaría nada.
 *
 * Y no lo puede una consola tampoco. Fue la tentación al diseñar `pass.dotrino.com`:
 * darle `list` «porque es la consola» habría abierto el mismo agujero con otro nombre
 * — bastaría con llamarse consola. Listar es de quien tiene la llave.
 */
export const REMOTE_OPS = ['find', 'get', 'put', 'patch', 'search', 'remove', 'sites']

// `sites` entró el 2026-08-29, decidido por el dueño para que el gestor abra con los
// dominios en vez de con un buscador vacío. NO es `list` con otro nombre —de ahí no sale
// ni un id ni un nombre, solo el dominio, que ya va en claro (§5)—, pero sí contesta de
// una vez lo que antes había que preguntar sitio por sitio. Queda dicho a propósito.

// `search` estaba implementado en las dos puntas y NO en esta lista, así que por el
// proxio se contestaba «operación no permitida»: traerse la cuenta de otro dominio
// funcionaba con la bóveda de dentro y no con una conectada. Corregido el 2026-08-29.

/**
 * Administración de APARATOS: qué aparatos hay y retirar uno. No toca credenciales.
 * Va aparte porque exige aprobación siempre — quitar un aparato es tan delicado como
 * entregar una contraseña, y en el otro sentido.
 */
export const ADMIN_OPS = ['devices', 'unlink']

export function isRequest (msg) {
  return !!msg && msg.type === TYPE && typeof msg.rid === 'string' && typeof msg.op === 'string'
}

export function isReply (msg) {
  return !!msg && msg.type === REPLY && typeof msg.rid === 'string'
}

export function request (rid, op, payload) {
  return { type: TYPE, rid, op, payload: payload || {} }
}

export function reply (rid, result) {
  return { type: REPLY, rid, result }
}

export function replyError (rid, code, message) {
  return { type: REPLY, rid, error: { code, message } }
}
