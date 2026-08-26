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
import { normalizeFields } from './fields.js'

export const TYPES = ['login', 'note', 'card', 'webauthn', 'data']

// `fields` es la lista de campos libres del usuario, y va cifrada como todo lo
// demás: un correo o una cédula identifican a una persona igual que una contraseña
// da acceso. Se sella como JSON, en un solo criptograma.
const SEALED_FIELDS = ['username', 'secret', 'totp', 'notes', 'fields']

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
 */
export function publicView (entry, hint) {
  return {
    id: entry.id,
    type: entry.type,
    title: entry.title,
    sites: entry.sites || [],
    hasSecret: !!entry.secret,
    hasTotp: !!entry.totp,
    hasFields: !!entry.fields,
    hasWebauthn: !!entry.webauthn,
    updatedAt: entry.updatedAt,
    ...(hint ? { hint } : {}),
  }
}

/** `sandrade@dotrino.com` → `s•••e@dotrino.com`. Suficiente para elegir, inútil para usar. */
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
