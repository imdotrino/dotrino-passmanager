// Cifrado de las entradas de la bóveda.
//
// Una CEK (AES-GCM 256) por bóveda, con la que se cifra cada entrada por separado.
// Quién tiene la CEK es lo que define la confianza de cada aparato (DISENO §3): al
// vault y a la app nativa se les envuelve; a la extensión, no.
//
// El envoltorio de la CEK a cada miembro NO se hace aquí: eso es `wrapForMember` de
// @dotrino/identity/content, que ya está escrito y probado. Este módulo es solo el
// tramo simétrico.

const enc = new TextEncoder()
const dec = new TextDecoder()

/** WebCrypto del entorno (navegador, service worker o Node ≥ 20). */
function subtle () {
  const c = globalThis.crypto
  if (!c?.subtle) throw new Error('webcrypto unavailable')
  return c.subtle
}

function randomBytes (n) {
  const b = new Uint8Array(n)
  globalThis.crypto.getRandomValues(b)
  return b
}

export function toBase64 (bytes) {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

export function fromBase64 (b64) {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

/** Genera una CEK nueva. Extraíble: hay que poder envolverla para cada aparato. */
export async function makeVaultKey () {
  return subtle().generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
}

export async function exportVaultKey (key) {
  return new Uint8Array(await subtle().exportKey('raw', key))
}

export async function importVaultKey (raw) {
  return subtle().importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt'])
}

/**
 * Cifra un valor con la CEK. Devuelve `{ iv, ct }` en base64, para que una entrada
 * cifrada siga siendo JSON serializable tal cual.
 *
 * `aad` ata el criptograma a su sitio: se pasa el id de la entrada y el campo, así
 * que un criptograma movido de una entrada a otra (o de `secret` a `totp`) no abre.
 */
export async function sealValue (key, plaintext, aad) {
  const iv = randomBytes(12)
  const params = { name: 'AES-GCM', iv }
  if (aad) params.additionalData = enc.encode(aad)
  const ct = await subtle().encrypt(params, key, enc.encode(plaintext))
  return { iv: toBase64(iv), ct: toBase64(new Uint8Array(ct)) }
}

export async function openValue (key, sealed, aad) {
  if (!sealed || typeof sealed.iv !== 'string' || typeof sealed.ct !== 'string') {
    throw new Error('sealed value malformed')
  }
  const params = { name: 'AES-GCM', iv: fromBase64(sealed.iv) }
  if (aad) params.additionalData = enc.encode(aad)
  const pt = await subtle().decrypt(params, key, fromBase64(sealed.ct))
  return dec.decode(pt)
}

/** Etiqueta AAD de un campo. Un solo sitio para que sellar y abrir no se desalineen. */
export function fieldTag (entryId, field) {
  return `dotrino-passmanager/v1/${entryId}/${field}`
}
