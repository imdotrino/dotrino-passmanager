// La identidad del ecosistema DENTRO del service worker.
//
// El multi-perfil de Dotrino ya está escrito y probado en `@dotrino/identity`; lo que no
// entra aquí es la clase `Identity`, que habla con `id.dotrino.com` montando un iframe —
// y un service worker MV3 no tiene DOM. Lo reutilizable es el núcleo:
// `createIdentityCore({ kv, peers, keyStore })` no toca DOM, y con él cada perfil tiene
// su llave de verdad (acta, delegaciones, certificados) en vez de una inventada aquí.
//
// Este archivo es solo el adaptador: le da al núcleo las tres piezas que pide, hechas
// con lo que un worker sí tiene.

import { createIdentityCore } from './vendor/identity/core.js'
import { avatarDataUri } from './vendor/identity/avatar.js'

/**
 * El núcleo quiere un `kv` SÍNCRONO estilo `localStorage`, y `chrome.storage.local` es
 * asíncrono. Se hidrata entero en memoria al arrancar y se escribe detrás.
 *
 * Se puede porque lo que guarda son claves de identidad y listas cortas, no la bóveda:
 * las contraseñas nunca pasan por aquí. Y el arranque es el único punto donde esperar,
 * que es exactamente lo que un worker que se duerme necesita — al despertar, rehidrata.
 */
async function hydratedKv (prefix = 'identity/') {
  const all = await chrome.storage.local.get(null)
  const mem = new Map()
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith(prefix)) mem.set(k.slice(prefix.length), v)
  }
  let pending = Promise.resolve()
  const flush = (k, v) => {
    pending = pending.then(() => (v === undefined
      ? chrome.storage.local.remove(prefix + k)
      : chrome.storage.local.set({ [prefix + k]: v })))
    // Un fallo al escribir la identidad no se traga: sin esto, la llave se regenera y
    // toda bóveda que conocía este aparato deja de reconocerlo, días después y sin
    // ninguna pista de por qué.
    pending.catch(e => console.error('[identity] no se pudo guardar «%s»: %s', k, e?.message || e))
  }
  return {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); flush(k, String(v)) },
    removeItem: (k) => { mem.delete(k); flush(k, undefined) },
    /** Para cuando el worker despierta y la memoria se fue con él. */
    async rehydrate () {
      const fresh = await chrome.storage.local.get(null)
      mem.clear()
      for (const [k, v] of Object.entries(fresh)) if (k.startsWith(prefix)) mem.set(k.slice(prefix.length), v)
    },
    get flushed () { return pending },
  }
}

/** Las CryptoKeys no extraíbles: IndexedDB las clona sin exportarlas. */
function makeKeyStore (dbName = 'dotrino-identity-keys') {
  const idb = (mode, fn) => new Promise((resolve, reject) => {
    const open = indexedDB.open(dbName, 1)
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains('keys')) open.result.createObjectStore('keys')
    }
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const tx = db.transaction('keys', mode)
      const req = fn(tx.objectStore('keys'))
      req.onsuccess = () => { resolve(req.result); db.close() }
      req.onerror = () => { reject(req.error); db.close() }
    }
  })
  return {
    get: (k) => idb('readonly', s => s.get(k)),
    set: (k, v) => idb('readwrite', s => s.put(v, k)),
    remove: (k) => idb('readwrite', s => s.delete(k)),
  }
}

/**
 * Los contactos. El núcleo los pide siempre, aunque el gestor de contraseñas no tenga
 * ninguno: aquí viven en el mismo kv y ya está.
 */
function makePeers (kv) {
  const KEY = 'dotrino.identity.peers'
  let dirty = () => {}
  const load = () => { try { return JSON.parse(kv.getItem(KEY) || '{}') || {} } catch { return {} } }
  const save = (m) => { kv.setItem(KEY, JSON.stringify(m)); dirty() }
  return {
    async initPeerStorage () {},
    loadPeers: load,
    savePeers: save,
    setPeersDirect: (m) => { kv.setItem(KEY, JSON.stringify(m || {})) },
    upsertPeer: (publickey, patch) => {
      const m = load()
      m[publickey] = { ...(m[publickey] || {}), ...patch, publickey }
      save(m)
      return m[publickey]
    },
    onDirty: (fn) => { dirty = fn || (() => {}) },
  }
}

let core = null
let kv = null
let booting = null

/** El núcleo de identidad de esta extensión, uno solo, con el perfil activo abierto. */
export async function identityCore () {
  if (core) return core
  // Una sola arrancada aunque lleguen tres peticiones a la vez: dos núcleos sobre el
  // mismo almacén se pisarían las llaves.
  booting ||= (async () => {
    kv = await hydratedKv()
    core = await createIdentityCore({
      kv,
      peers: makePeers(kv),
      keyStore: makeKeyStore(),
      // Sin sincronización con Drive: el gestor no la usa y arrastraría DOM.
      makeSync: null,
    })
    return core
  })()
  return booting
}

/**
 * Cambiar de perfil obliga a REARRANCAR el núcleo.
 *
 * En una app del ecosistema eso lo hace recargar la página — el multi-perfil no es
 * reactivo por diseño. Aquí no hay página que recargar, así que se tira el núcleo y se
 * levanta otro: es la misma decisión, cumplida donde no hay recarga.
 */
async function restart () {
  // Antes de rehacerlo hay que esperar a que lo escrito EXISTA en el disco: el kv vive en
  // memoria y vuelca detrás, así que un núcleo nuevo leería el estado de antes y el perfil
  // recién creado se esfumaría. Costó una vuelta encontrarlo.
  await kv?.flushed
  core = null
  booting = null
  return identityCore()
}

/** La identidad del ecosistema, en lo que el gestor necesita de ella. */
export const identity = {
  async profiles () {
    const { handlers } = await identityCore()
    const list = await handlers.listProfiles()
    // Cada perfil nace con imagen: el identicon se deriva de su pública, así que no hay
    // que pedirle nada al usuario ni dejar un hueco gris hasta que suba una foto.
    return list.map(p => ({ ...p, avatar: p.avatar || (p.pubkey ? avatarDataUri(p.pubkey, { size: 40 }) : null) }))
  },
  async current () {
    const { handlers } = await identityCore()
    return handlers.currentProfile()
  },
  async create (name) {
    const { handlers } = await identityCore()
    const p = await handlers.createProfile({ name: name || '' })
    // `createProfile` lo crea y lo abre en memoria, pero no lo deja como ACTIVO: eso es
    // `switchProfile`, y sin él la extensión seguiría enseñando el perfil de antes.
    await handlers.switchProfile({ id: p.id })
    await restart()
    return p
  },
  async use (id) {
    const { handlers } = await identityCore()
    await handlers.switchProfile({ id })
    await restart()
  },
  async rename (id, name) {
    const { handlers } = await identityCore()
    return handlers.renameProfile({ id, name: name || '' })
  },
  async remove (id) {
    const { handlers } = await identityCore()
    await handlers.deleteProfile({ id })
    await restart()
  },
  /** La pública del perfil activo: con ella lo conoce la bóveda. */
  async publickey () {
    const c = await identityCore()
    return c.me?.publickey || null
  },
  /**
   * Firma con la llave del PERFIL, no con una llave suelta del transporte.
   *
   * Es la regla del ecosistema: la identidad de red es la misma que la de firma, así el
   * aparato que se identifica en el proxio y el que la bóveda conoce son uno solo.
   */
  async sign (data) {
    const { handlers } = await identityCore()
    return handlers.signData({ data })
  },
}
