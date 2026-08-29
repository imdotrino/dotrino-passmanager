// Una entrada de la bóveda: cómo se sella, cómo se abre y qué se puede enseñar sin
// abrirla. Ver DISENO §5.
//
// Qué va en claro y por qué: `sites` y `title`. Los `sites` hacen falta para
// emparejar con la página SIN tener la CEK — es lo que permite que la extensión
// pregunte "¿tienes algo para salesforce.com?" sin poder abrir nada. Es una decisión
// consciente: revela EN QUÉ SITIOS tienes cuenta, que es bastante menos que la
// credencial. Todo lo demás (usuario, contraseña, TOTP, notas, llave WebAuthn) va
// cifrado.

import { sealValue, openValue, fieldTag } from './crypto.js'
import { normalizeFields, entryFieldKeys, privateKeysOf, fieldKey } from './fields.js'

export const TYPES = ['login', 'note', 'card', 'webauthn', 'data']

// `fields` es la lista de campos libres del usuario, y va cifrada como todo lo
// demás: un correo o una cédula identifican a una persona igual que una contraseña
// da acceso. Se sella como JSON, en un solo criptograma.
//
// `name` —el nombre que el usuario le pone a la entrada— va SELLADO y no en claro como
// `title`: «la cuenta de mi mamá» dice bastante más de una persona que el dominio donde
// la usa. Quien puede abrir la entrada lo pone en la vista pública (§4.0.2), igual que
// el nombre visible de siempre.
const SEALED_FIELDS = ['name', 'username', 'secret', 'totp', 'notes', 'fields']

function uuid () {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  const b = new Uint8Array(16)
  globalThis.crypto.getRandomValues(b)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** Entrada nueva en claro, lista para `sealEntry`. */
export function newEntry (fields = {}) {
  const now = Date.now()
  const type = TYPES.includes(fields.type) ? fields.type : 'login'
  return {
    id: fields.id || uuid(),
    type,
    title: String(fields.title || '').trim(),
    // El nombre que le puso el usuario. Vacío = el que se calcula solo (`entryWho`).
    name: String(fields.name || '').trim(),
    sites: normalizeSites(fields.sites),
    username: fields.username || '',
    secret: fields.secret || '',
    // Los campos libres viajan como JSON dentro de un único criptograma. Una lista
    // vacía es NADA, no un criptograma vacío: si no, la entrada se anuncia con campos
    // que no tiene y la UI ofrece rellenar lo que no existe.
    fields: (() => {
      if (!Array.isArray(fields.fields)) return fields.fields || ''
      const limpios = normalizeFields(fields.fields)
      return limpios.length ? JSON.stringify(limpios) : ''
    })(),
    totp: fields.totp || '',
    notes: fields.notes || '',
    webauthn: fields.webauthn || null,
    createdAt: fields.createdAt || now,
    updatedAt: now,
  }
}

export function normalizeSites (sites) {
  const out = []
  for (const s of Array.isArray(sites) ? sites : [sites]) {
    const v = String(s || '').trim().toLowerCase()
    if (v && !out.includes(v)) out.push(v)
  }
  return out
}

/** Cifra los campos sensibles. Devuelve lo que se guarda de verdad. */
export async function sealEntry (key, plain) {
  const e = newEntry(plain)
  const out = {
    id: e.id,
    type: e.type,
    title: e.title,
    sites: e.sites,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  }
  for (const f of SEALED_FIELDS) {
    out[f] = e[f] ? await sealValue(key, String(e[f]), fieldTag(e.id, f)) : null
  }
  if (e.webauthn) {
    // `rpId` y `credentialId` quedan en claro: el navegador los necesita para saber
    // qué credencial ofrecer antes de que nadie desbloquee nada.
    out.webauthn = {
      credentialId: e.webauthn.credentialId,
      rpId: e.webauthn.rpId,
      signCount: e.webauthn.signCount || 0,
      userHandle: e.webauthn.userHandle
        ? await sealValue(key, String(e.webauthn.userHandle), fieldTag(e.id, 'wa.userHandle'))
        : null,
      privateKey: e.webauthn.privateKey
        ? await sealValue(key, String(e.webauthn.privateKey), fieldTag(e.id, 'wa.privateKey'))
        : null,
    }
  } else {
    out.webauthn = null
  }
  return out
}

/** Abre una entrada sellada. Exige la CEK, o sea: no lo hace la extensión. */
export async function openEntry (key, entry) {
  const out = {
    id: entry.id,
    type: entry.type,
    title: entry.title,
    sites: entry.sites || [],
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    webauthn: null,
  }
  for (const f of SEALED_FIELDS) {
    out[f] = entry[f] ? await openValue(key, entry[f], fieldTag(entry.id, f)) : ''
  }
  if (entry.webauthn) {
    out.webauthn = {
      credentialId: entry.webauthn.credentialId,
      rpId: entry.webauthn.rpId,
      signCount: entry.webauthn.signCount || 0,
      userHandle: entry.webauthn.userHandle
        ? await openValue(key, entry.webauthn.userHandle, fieldTag(entry.id, 'wa.userHandle'))
        : '',
      privateKey: entry.webauthn.privateKey
        ? await openValue(key, entry.webauthn.privateKey, fieldTag(entry.id, 'wa.privateKey'))
        : '',
    }
  }
  return out
}

/**
 * Lo que puede ver quien NO tiene la CEK: para elegir entre varias cuentas del mismo
 * sitio, no para usarlas. El `hint` lo calcula quien sí puede abrir (§2).
 *
 * `open` es la entrada abierta, y solo la tiene quien puede abrirla. Con ella salen los
 * NOMBRES de los campos que lleva —nunca sus valores—, que es lo que permite ofrecer
 * «rellenar el número de socio» sin sacar nada de la bóveda.
 *
 * `digest` son los RESÚMENES de esos campos (`{ nonce, fields }`, ver `fieldHasher`):
 * con ellos, quien pregunta puede decir si lo que tiene delante ya está guardado igual
 * sin abrir nada y sin pedir una autorización. Van para todos los campos, públicos y
 * privados: un solo método de comparación (dueño, 2026-08-29).
 *
 * `privateKeys` dice **cuáles de esos campos son privados**. No es lo mismo que el valor:
 * es lo que permite pedir los públicos —y solo los públicos— sin disparar una
 * autorización, que es lo que hace falta para enseñar en una lista con qué se va a
 * rellenar cada casilla.
 */
export function publicView (entry, hint, open, digest) {
  return {
    id: entry.id,
    type: entry.type,
    title: entry.title,
    sites: entry.sites || [],
    hasSecret: !!entry.secret,
    hasTotp: !!entry.totp,
    hasNotes: !!entry.notes,
    hasFields: !!entry.fields,
    hasWebauthn: !!entry.webauthn,
    updatedAt: entry.updatedAt,
    ...(hint ? { hint } : {}),
    ...(open ? { fieldKeys: entryFieldKeys(open), privateKeys: [...privateKeysOf(open)] } : {}),
    ...(digest ? { nonce: digest.nonce, fieldHashes: digest.fields } : {}),
  }
}

/**
 * CÓMO SE LLAMA una entrada para quien tiene que elegir entre varias.
 *
 * **El que le puso el usuario**, si le puso alguno. Y si no, su dato público más claro,
 * **sin esconder caracteres** (dueño, 2026-08-28): el usuario; si no tiene, el correo; y
 * si tampoco, el primer campo que lleve. Un `d•••g` no le dice nada a nadie — hay que
 * poder reconocer la cuenta de un vistazo.
 *
 * **Los campos privados no salen aquí.** Para eso está la marca (§4.2): lo privado solo
 * sale con confirmación, así que nunca es el nombre visible de una entrada.
 */
export function entryWho (open) {
  // Lo que el usuario escribió MANDA. Lo de abajo es solo el nombre que se calcula cuando
  // no ha escrito ninguno: útil para no dejar filas en blanco, pero es una suposición, y
  // una suposición no le gana a una decisión (dueño, 2026-08-29).
  if (open?.name) return String(open.name)
  if (open?.username) return String(open.username)
  const campos = (() => {
    if (Array.isArray(open?.fields)) return open.fields
    try { return JSON.parse(open?.fields || '[]') } catch { return [] }
  })()
  const publicos = campos.filter(f => f && !f.private && f.value)
  const correo = publicos.find(f => f.kind === 'email')
  return String((correo || publicos[0])?.value || '')
}

/**
 * LA ENTRADA RECORTADA a los campos que se pidieron.
 *
 * Pedir «el nombre» no puede devolver también la contraseña. Sin esto, `get` era todo o
 * nada y cualquier relleno de un dato público sacaba de la bóveda la credencial entera —
 * que además es lo que obligaba a pedir autorización para rellenar un nombre.
 *
 * Sin `keys` devuelve la entrada tal cual: hay quien necesita todo (una passkey al
 * firmar), y eso sí se autoriza.
 */
export function projectEntry (open, keys) {
  if (!Array.isArray(keys)) return open
  const quiere = new Set(keys)
  const campos = (() => {
    if (Array.isArray(open.fields)) return open.fields
    try { return JSON.parse(open.fields || '[]') } catch { return [] }
  })()
  return {
    ...open,
    username: quiere.has('username') ? open.username : '',
    secret: quiere.has('secret') ? open.secret : '',
    totp: quiere.has('totp') ? open.totp : '',
    notes: quiere.has('notes') ? open.notes : '',
    webauthn: quiere.has('webauthn') ? open.webauthn : null,
    fields: JSON.stringify(campos.filter(f => quiere.has(fieldKey(f)))),
  }
}

/** `sandrade@dotrino.com` → `s•••e@dotrino.com`. Sigue para la CLI; la extensión ya no. */
export function maskUsername (username) {
  const u = String(username || '')
  if (!u) return ''
  const at = u.indexOf('@')
  if (at > 0) return mask(u.slice(0, at)) + u.slice(at)
  return mask(u)
}

function mask (s) {
  if (s.length <= 2) return s[0] + '•'
  return s[0] + '•••' + s[s.length - 1]
}
