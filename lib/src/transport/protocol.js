// El protocolo entre quien pide una credencial y quien la custodia.
//
// Viaja por @dotrino/proxy-client (`sendByPubkey`), que es el transporte del
// ecosistema — no se abre un socket propio ni se reimplementa nada de esto.
//
// El contenido NO se cifra aquí: los sobres ya van sellados al destinatario por el
// pilar de identidad. Esto solo define qué se pide y cómo se contesta.

export const TYPE = 'dotrino.passmanager/1'
export const REPLY = 'dotrino.passmanager.reply/1'

/** Lo que un aparato puede pedir. `list` NO está: nadie lista en remoto (DISENO §2). */
export const REMOTE_OPS = ['find', 'get', 'put', 'remove']

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
