// Sellado extremo a extremo entre el aparato y la bóveda.
//
// **Por qué existe:** el proxio enruta por pubkey, pero NO cifra el contenido — el
// payload viaja como JSON tal cual. Sin esto, el proxio de Dotrino vería a qué sitios
// se le pide credencial y qué credencial se devuelve. Eso rompe la promesa que sostiene
// todo lo demás: lo tuyo no llega a los servidores de Dotrino, ni siquiera de paso.
//
// **No es criptografía nueva.** Es `wrapForMember`/`openWrap` de
// `@dotrino/identity/content`, la misma que usa el vault para los secretos sellados:
// ECDH P-256 efímero contra la pública del destinatario + AES-GCM. Quien abre solo
// necesita su privada, y cada mensaje lleva su propia efímera.

import { wrapForMember, openWrap } from '@dotrino/identity/content'

const ECDH = { name: 'ECDH', namedCurve: 'P-256' }

/** Par de cifrado del aparato. Duradero: su pública va en el código de enlace. */
export async function makeEncKeypair () {
  const pair = await globalThis.crypto.subtle.generateKey(ECDH, true, ['deriveBits'])
  const pub = await globalThis.crypto.subtle.exportKey('jwk', pair.publicKey)
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    encPub: JSON.stringify({ kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y }),
  }
}

export async function importEncPrivate (jwk) {
  return globalThis.crypto.subtle.importKey('jwk', jwk, ECDH, true, ['deriveBits'])
}

export async function exportEncPrivate (privateKey) {
  return globalThis.crypto.subtle.exportKey('jwk', privateKey)
}

/** Sella un mensaje hacia la pública de cifrado del otro lado. */
export async function seal (message, peerEncPub) {
  const wrap = await wrapForMember({ cek: JSON.stringify(message), memberEncPub: peerEncPub })
  // `v` para poder cambiar de sobre algún día sin adivinar qué es lo que llegó.
  return { v: 1, sealed: wrap }
}

/** Abre un mensaje sellado a mí. Lanza si no es para mí o si viene tocado. */
export async function open (envelope, myEncPrivateKey) {
  if (envelope?.v !== 1 || !envelope.sealed) throw new Error('sobre desconocido')
  return JSON.parse(await openWrap({ wrap: envelope.sealed, myEncPrivateKey }))
}

export function isSealed (msg) {
  return !!msg && msg.v === 1 && !!msg.sealed?.ct
}
