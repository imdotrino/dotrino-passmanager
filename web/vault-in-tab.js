// TU BÓVEDA, EN ESTA PESTAÑA.
//
// El gestor necesita una bóveda que custodie las contraseñas y responda de a una. Lo
// normal sería `npx dotrino-passmanager serve` en tu equipo, pero **exigir un daemon
// para empezar a usarlo es exactamente lo que el ecosistema no hace**: el aparato cumple
// el rol cuando no hay pieza dedicada, y lo dedicado solo añade disponibilidad.
//
// Así que esta página ES la bóveda mientras esté abierta. Se instala la extensión, se
// abre esto, y funciona. Cuando quieras que esté siempre disponible —también con el
// navegador cerrado— levantas el daemon y enlazas los aparatos a él; el protocolo es el
// mismo y no cambia nada más.
//
// Lo que NO cambia por estar en una pestaña: las contraseñas siguen cifradas, la
// extensión sigue pidiendo de a una, y nada viaja sin sellar.

import { WebSocketProxyClient, getPublicKeyJwk, signData } from 'https://cdn.jsdelivr.net/npm/@dotrino/proxy-client@0.13.1/+esm'
import { Identity } from 'https://cdn.jsdelivr.net/npm/@dotrino/identity@0.60.3/+esm'
import {
  LocalVault, VaultResponder, samePubkey, importAuto,
} from 'https://cdn.jsdelivr.net/npm/@dotrino/passmanager@0.1.1/+esm'

// --- almacén: IndexedDB de este origen ---------------------------------------
//
// Las entradas van cifradas con la CEK, así que lo que queda en el disco del navegador
// no se lee ni abriendo la base de datos.

const DB = 'dotrino-passmanager'
const TIENDA = 'kv'

function openDb () {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(TIENDA)) req.result.createObjectStore(TIENDA)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function idb (modo, fn) {
  const db = await openDb()
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(TIENDA, modo)
      const req = fn(tx.objectStore(TIENDA))
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  } finally { db.close() }
}

const store = {
  async get (k) { return idb('readonly', s => s.get(k)) },
  async set (k, v) { return idb('readwrite', s => s.put(v, k)) },
}

// --- la llave de la bóveda ----------------------------------------------------

let identity = null
const getIdentity = async () => (identity ||= await Identity.connect())

/**
 * La llave de la bóveda vive en IndexedDB como un `CryptoKey` NO EXTRAÍBLE.
 *
 * IndexedDB clona el CryptoKey en vez de serializarlo, así que la llave nunca existe en
 * forma exportable: ni el JS de esta página puede sacarla. Es más fuerte que guardarla
 * cifrada, porque no queda ningún texto que descifrar.
 *
 * Se intentó sellarla con `identity.encrypt` y NO vale: esa API es para mensajes entre
 * DOS partes (lleva la pubkey del emisor y un token efímero), así que cifrarse a uno
 * mismo devuelve «this device is not among the message recipients».
 *
 * Lo que esto implica, y hay que decirlo: si borras los datos de este sitio, la bóveda
 * se va con ellos. Para eso existe exportar, y para eso el daemon es el sitio de lo que
 * quieres conservar pase lo que pase.
 */
async function vaultKey () {
  const saved = await store.get('cek')
  // Se comprueba QUÉ hay guardado, no solo que haya algo: una versión anterior guardaba
  // aquí otra cosa, y devolverlo tal cual reventaba dentro de WebCrypto con un
  // «parameter 2 is not of type CryptoKey» que no dice nada de dónde viene.
  if (saved instanceof CryptoKey) return saved
  if (saved) console.warn('[vault] la llave guardada no es utilizable; se crea una nueva')
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  await store.set('cek', key)
  return key
}

// --- aparatos autorizados -----------------------------------------------------

const devices = async () => (await store.get('devices')) || []

async function authorise ({ sign, enc }, label) {
  const list = await devices()
  const resto = list.filter(d => !samePubkey(d.pubkey, sign))
  resto.push({ pubkey: sign, encPub: enc, label: label || 'aparato', ts: Date.now() })
  await store.set('devices', resto)
}

async function removeDevice (pubkey) {
  await store.set('devices', (await devices()).filter(d => !samePubkey(d.pubkey, pubkey)))
}

// --- el sellado, delegado al vault de identidad -------------------------------

const sealing = {
  async seal (msg, peerEncPub) {
    if (!peerEncPub) throw Object.assign(new Error('sin llave de cifrado'), { code: 'unsealed' })
    const id = await getIdentity()
    return { app: 'passmanager', sealed: await id.encrypt([peerEncPub], JSON.stringify(msg)), from: await id.getEncryptionPubkey() }
  },
  async open (sobre) {
    const id = await getIdentity()
    return JSON.parse(await id.decrypt(sobre.from, null, sobre.sealed))
  },
  isSealed: (m) => !!m && m.app === 'passmanager' && !!m.sealed,
}

// --- arranque -----------------------------------------------------------------

export async function startVault ({ onRequest, onApprove } = {}) {
  const id = await getIdentity()
  const vault = new LocalVault(store)
  vault.unlock(await vaultKey())

  const client = new WebSocketProxyClient({
    url: 'wss://proxy.dotrino.com',
    // Sin WebRTC: no aporta y añade una pila entera a la pieza que reparte credenciales.
    enableWebRTC: false,
    requireSealed: true,
    sealing,
  })
  await client.connect()
  const publickey = await getPublicKeyJwk()
  const data = { op: 'identify', publickey, token: client.token, ts: Date.now() }
  await client.identify({ data, signature: await signData(data) })

  let known = await devices()
  const refresh = async () => { known = await devices() }

  const responder = new VaultResponder({
    client,
    vault,
    isAllowed: (pub) => known.some(d => samePubkey(d.pubkey, pub)),
    encPubOf: (pub) => known.find(d => samePubkey(d.pubkey, pub))?.encPub || null,
    // Aprobar es del usuario, y aquí está delante: se le pregunta en la propia página.
    needsApproval: () => true,
    approve: async ({ pubkey }) => {
      const who = known.find(d => samePubkey(d.pubkey, pubkey))
      return onApprove ? onApprove(who?.label || 'un aparato') : false
    },
    admin: {
      async devices () { return (await devices()).map(d => ({ pubkey: d.pubkey, label: d.label, ts: d.ts })) },
      async unlink (pub) { await removeDevice(pub); await refresh(); return { ok: true } },
    },
    onRequest: (r) => { onRequest?.(r); refresh() },
  })
  responder.start()

  /** El código que se pega en la extensión. Las dos públicas: se enruta y se sella. */
  const code = btoa(JSON.stringify({
    v: 1, sign: publickey, enc: await id.getEncryptionPubkey(),
  })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

  return {
    code,
    vault,
    devices,
    authorise: async (cod, label) => {
      const b64 = String(cod || '').trim().replace(/-/g, '+').replace(/_/g, '/')
      const c = JSON.parse(atob(b64))
      if (c?.v !== 1 || !c.sign || !c.enc) throw Object.assign(new Error('código inválido'), { code: 'bad-code' })
      await authorise(c, label)
      await refresh()
    },
    removeDevice: async (pub) => { await removeDevice(pub); await refresh() },
    importEntries: async (texto) => {
      const { format, entries } = importAuto(texto)
      for (const e of entries) await vault.put(e)
      return { format, count: entries.length }
    },
    stop: () => responder.stop(),
  }
}
