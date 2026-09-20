// EL LADO DEL APARATO: construir los sobres y abrirlos.
//
// La bóveda ya no puede hacer nada de esto —no tiene ninguna llave— así que lo hace quien
// pide: cifra lo que guarda, lo envuelve a cada destinatario y firma el conjunto; y al
// leer, abre su envoltura y con ella el sobre. Es lo mismo que `buildSealedVar` hace con
// una variable de un cajón (`@dotrino/vault/admin`), con una diferencia: una entrada tiene
// muchos campos y **dos juegos de destinatarios** (§2.8), no uno.
//
// QUIÉN FIRMA VA COMO FUNCIÓN, no como llave, por el mismo motivo que allí: en un navegador
// la privada del aparato vive dentro del iframe de identidad y no sale. Aquí se pide la
// firma, no la llave.

import { makeContentKey, wrapForMember } from '@dotrino/identity/content'
import { sealEntry, openView, openFields, PASSKEY_FIELD } from './entry.js'
import { RECOVERY } from './store.js'
import { makePasswordKey, profileKeys } from './keys.js'

/**
 * LO QUE FIRMA EL AUTOR. Un solo sitio: quien firma y quien comprueba miran exactamente lo
 * mismo, o la comprobación pasa a ser decorativa.
 *
 * Va lo que identifica el contenido —los criptogramas, no los valores— y las huellas: si la
 * bóveda cambiara un sobre por otro, o el índice de sitios de una entrada, la firma deja de
 * cuadrar. Lo que NO va es la generación, que la pone el almacén después.
 */
export function entryAuthorBody (entry, ts) {
  return {
    op: 'pm.entry',
    id: entry.id,
    idx: [...(entry.idx || [])].sort(),
    wa: entry.wa || null,
    view: entry.view.iv + '.' + entry.view.ct,
    fields: Object.keys(entry.fields).sort().map((k) => k + ':' + entry.fields[k].iv + '.' + entry.fields[k].ct),
    digests: entry.digests || {},
    ts
  }
}

const wrapAll = async (cek, { recoveryPub, members }) => {
  if (!recoveryPub) throw new Error('sealed: ask the vault for the recipients first')
  const wraps = { [RECOVERY]: await wrapForMember({ cek, memberEncPub: recoveryPub }) }
  for (const m of members || []) wraps[m.pub] = await wrapForMember({ cek, memberEncPub: m.encPub })
  return wraps
}

/**
 * UNA ENTRADA LISTA PARA GUARDAR: cifrada, envuelta a quien toca y firmada.
 *
 * @param {object} o
 *   `plain`       la entrada en claro
 *   `keys`        las llaves del perfil (`profileKeys`)
 *   `recipients`  `{ recoveryPub, main: [{pub,encPub}], passkeys: [{pub,encPub}] }`, tal
 *                 como las contesta la bóveda: la lista sale del acta y la sabe ella.
 *   `author`      `{ publickey, sign(body) }`
 */
export async function buildSealedEntry ({ plain, keys, recipients, author } = {}) {
  if (typeof author?.sign !== 'function' || typeof author?.publickey !== 'string') {
    throw new Error('buildSealedEntry: author needs { publickey, sign(body) }')
  }
  const cek = await makeContentKey()
  // La privada de la passkey va con SU llave y sus destinatarios. Se estrena solo si la
  // entrada lleva una: repartir una llave que nadie va a usar es ruido en el llavero.
  const llevaPasskey = !!plain?.webauthn?.privateKey
  const cekPk = llevaPasskey ? await makeContentKey() : null

  // `gen: 0` a propósito: la generación DE VERDAD la pone el almacén al guardar, como en
  // los cajones. Aquí solo hace falta un número para que el sobre tenga forma.
  const entry = await sealEntry({
    plain,
    main: { gen: 0, cek },
    ...(cekPk ? { passkeys: { gen: 0, cek: cekPk } } : {}),
    keys
  })
  const ts = Date.now()
  const { signature } = await author.sign(entryAuthorBody(entry, ts))
  return {
    entry: { ...entry, author: { pub: author.publickey, sig: signature, ts } },
    main: { wraps: await wrapAll(cek, { recoveryPub: recipients?.recoveryPub, members: recipients?.main }) },
    ...(cekPk
      ? { passkeys: { wraps: await wrapAll(cekPk, { recoveryPub: recipients?.recoveryPub, members: recipients?.passkeys }) } }
      : {})
  }
}

/** La llave del perfil, estrenada y envuelta. Se hace una vez, al convertir. */
export async function buildProfileKey ({ recipients } = {}) {
  const base = await makePasswordKey()
  const cek = await makeContentKey()
  const { encryptWithCek } = await import('@dotrino/identity/content')
  return {
    base,
    envelope: await encryptWithCek({ cek, gen: 0, plaintext: base }),
    wraps: await wrapAll(cek, { recoveryPub: recipients?.recoveryPub, members: recipients?.main })
  }
}

/**
 * EL ABRIDOR de este aparato: con su envoltura saca la llave y con ella el sobre.
 *
 * `openSealed({ wrap, envelope })` es `identity.openSealedValue`: la privada de cifrado no
 * sale del iframe (ni del núcleo, en la extensión). Aquí solo se empareja cada sobre con la
 * envoltura de su generación.
 */
export function makeOpener ({ wraps, openSealed }) {
  if (typeof openSealed !== 'function') throw new Error('makeOpener: missing openSealed({ wrap, envelope })')
  return async ({ envelope }) => {
    const wrap = wraps?.[envelope?.gen]
    if (!wrap) {
      throw Object.assign(new Error('this device has no key for that content generation'), { code: 'no-wrap' })
    }
    return openSealed({ wrap, envelope })
  }
}

/** La vista de una entrada, abierta con las envolturas que vinieron con ella. */
export async function openSealedView ({ view, wrap, id, updatedAt, digests, openSealed }) {
  const open = makeOpener({ wraps: { [view.gen]: wrap }, openSealed })
  return openView({ id, updatedAt, view, digests }, open)
}

/** Los campos que vinieron de `get`, con la forma de siempre. */
export async function openSealedEntry ({ got, openSealed, view = null }) {
  const open = makeOpener({ wraps: got.wraps, openSealed })
  const vista = view || await openView({ id: got.id, updatedAt: got.updatedAt, view: got.view, digests: got.digests }, open)
  const abierta = await openFields({
    sealed: { id: got.id, updatedAt: got.updatedAt },
    envelopes: got.envelopes,
    open,
    view: vista
  })
  return { ...abierta, withheld: got.withheld || [] }
}

export { PASSKEY_FIELD, profileKeys }
export default { buildSealedEntry, buildProfileKey, openSealedEntry, openSealedView, makeOpener, entryAuthorBody }
