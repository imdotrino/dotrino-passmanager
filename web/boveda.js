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

import { WebSocketProxyClient, getPublicKeyJwk, signData } from 'https://cdn.jsdelivr.net/npm/@dotrino/proxy-client@0.13/+esm'
import { Identity } from 'https://cdn.jsdelivr.net/npm/@dotrino/identity@latest/+esm'
import {
  LocalVault, VaultResponder, samePubkey, importVaultKey, exportVaultKey,
  makeVaultKey, toBase64, fromBase64, importAuto,
} from 'https://cdn.jsdelivr.net/npm/@dotrino/passmanager@0.1/+esm'

// --- almacén: IndexedDB de este origen ---------------------------------------
//
// Las entradas van cifradas con la CEK, así que lo que queda en el disco del navegador
// no se lee ni abriendo la base de datos.

const DB = 'dotrino-passmanager'
const TIENDA = 'kv'

function abrirDB () {
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
  const db = await abrirDB()
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
 * La CEK se guarda CIFRADA con tu identidad, no en claro.
 *
 * Podría pedirse una contraseña maestra, pero sería una segunda contraseña que recordar
 * para proteger lo mismo que ya protege tu perfil. Se sella al propio perfil: quien abra
 * esta página sin tu identidad no puede abrir la bóveda.
 */
async function llaveDeLaBoveda () {
  const id = await getIdentity()
  const guardada = await store.get('cek')
  if (guardada) {
    const raw = await id.decrypt(await id.getEncryptionPubkey(), null, guardada)
    return importVaultKey(fromBase64(raw))
  }
  const key = await makeVaultKey()
  const raw = toBase64(await exportVaultKey(key))
  await store.set('cek', await id.encrypt([await id.getEncryptionPubkey()], raw))
  return key
}

// --- aparatos autorizados -----------------------------------------------------

const aparatos = async () => (await store.get('devices')) || []

async function autorizar ({ sign, enc }, label) {
  const lista = await aparatos()
  const resto = lista.filter(d => !samePubkey(d.pubkey, sign))
  resto.push({ pubkey: sign, encPub: enc, label: label || 'aparato', ts: Date.now() })
  await store.set('devices', resto)
}

async function retirar (pubkey) {
  await store.set('devices', (await aparatos()).filter(d => !samePubkey(d.pubkey, pubkey)))
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

export async function arrancarBoveda ({ onPeticion, onAprobar } = {}) {
  const id = await getIdentity()
  const vault = new LocalVault(store)
  vault.unlock(await llaveDeLaBoveda())

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

  let conocidos = await aparatos()
  const refrescar = async () => { conocidos = await aparatos() }

  const responder = new VaultResponder({
    client,
    vault,
    isAllowed: (pub) => conocidos.some(d => samePubkey(d.pubkey, pub)),
    encPubOf: (pub) => conocidos.find(d => samePubkey(d.pubkey, pub))?.encPub || null,
    // Aprobar es del usuario, y aquí está delante: se le pregunta en la propia página.
    needsApproval: () => true,
    approve: async ({ pubkey }) => {
      const quien = conocidos.find(d => samePubkey(d.pubkey, pubkey))
      return onAprobar ? onAprobar(quien?.label || 'un aparato') : false
    },
    admin: {
      async devices () { return (await aparatos()).map(d => ({ pubkey: d.pubkey, label: d.label, ts: d.ts })) },
      async unlink (pub) { await retirar(pub); await refrescar(); return { ok: true } },
    },
    onRequest: (r) => { onPeticion?.(r); refrescar() },
  })
  responder.start()

  /** El código que se pega en la extensión. Las dos públicas: se enruta y se sella. */
  const codigo = btoa(JSON.stringify({
    v: 1, sign: publickey, enc: await id.getEncryptionPubkey(),
  })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

  return {
    codigo,
    vault,
    aparatos,
    autorizar: async (cod, label) => {
      const b64 = String(cod || '').trim().replace(/-/g, '+').replace(/_/g, '/')
      const c = JSON.parse(atob(b64))
      if (c?.v !== 1 || !c.sign || !c.enc) throw Object.assign(new Error('código inválido'), { code: 'bad-code' })
      await autorizar(c, label)
      await refrescar()
    },
    retirar: async (pub) => { await retirar(pub); await refrescar() },
    importar: async (texto) => {
      const { format, entries } = importAuto(texto)
      for (const e of entries) await vault.put(e)
      return { format, count: entries.length }
    },
    detener: () => responder.stop(),
  }
}
