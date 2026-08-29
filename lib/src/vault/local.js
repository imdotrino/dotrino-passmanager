// Bóveda local: la que corre donde SÍ está la CEK — el vault del PC, la app nativa,
// y la caché opt-in de solo lectura de la extensión (DISENO §3).
//
// El almacén se inyecta para no atar la librería a nada: en la app es
// `@dotrino/store`, en la extensión `chrome.storage.local`, en las pruebas un Map.
// Solo tiene que cumplir `{ get(k), set(k, v) }`.

import { openEntry, sealEntry, publicView, entryWho } from '../model.js'
import { findForUrl } from '../match.js'
import { VaultError, CODES } from './errors.js'

const KEY = 'passmanager/entries/v1'

export class LocalVault {
  /**
   * @param {object} store almacén `{ get(k), set(k, v) }`
   * @param {object} opts  `{ readOnly }` — la caché de la extensión va en `true`
   */
  constructor (store, opts = {}) {
    this.store = store
    this.readOnly = !!opts.readOnly
    this.key = null
  }

  get capabilities () {
    return { canWrite: !this.readOnly, canList: true, needsApproval: false }
  }

  /** Entrega la CEK. Sin esto, todo lo demás falla con `locked`. */
  unlock (cek) {
    this.key = cek
  }

  lock () {
    this.key = null
  }

  #requireKey () {
    if (!this.key) throw new VaultError(CODES.LOCKED, 'la bóveda está cerrada')
  }

  async #all () {
    return (await this.store.get(KEY)) || []
  }

  async find (url) {
    this.#requireKey()
    const hits = findForUrl(await this.#all(), url)
    // El nombre visible obliga a abrir la entrada: por eso lo calcula quien tiene la CEK,
    // y no quien pregunta.
    return Promise.all(hits.map(async ({ entry }) => {
      const open = await openEntry(this.key, entry)
      return publicView(entry, entryWho(open), open)
    }))
  }

  async get (id) {
    this.#requireKey()
    const entry = (await this.#all()).find(e => e.id === id)
    if (!entry) throw new VaultError(CODES.NOT_FOUND, 'no hay ninguna entrada con ese id')
    return openEntry(this.key, entry)
  }

  async put (plain) {
    this.#requireKey()
    if (this.readOnly) throw new VaultError(CODES.READ_ONLY, 'esta copia solo puede leer')
    const sealed = await sealEntry(this.key, plain)
    const all = await this.#all()
    const i = all.findIndex(e => e.id === sealed.id)
    if (i >= 0) {
      sealed.createdAt = all[i].createdAt
      all[i] = sealed
    } else {
      all.push(sealed)
    }
    await this.store.set(KEY, all)
    return publicView(sealed)
  }

  /**
   * BUSCAR por texto en toda la bóveda. Devuelve lo público, y como mucho `limit`.
   *
   * No es `list` con otro nombre, y la diferencia importa (DISENO §2): `list` lo puede
   * pedir el código en cualquier momento y devuelve todo; esto exige un término que
   * **escribe una persona** y devuelve un puñado. Existe porque a veces la cuenta que
   * sirve está guardada en otro dominio —el subdominio cambió y la clave es la misma— y
   * sin buscarla no hay forma de llegar a ella.
   *
   * Se busca en lo que identifica a la entrada: su título, sus sitios y su nombre
   * visible. **Nunca en los valores de los campos**: buscar «1700» y que aparezca tu
   * documento es exactamente lo que no puede pasar.
   */
  async search (q, { limit = 20 } = {}) {
    this.#requireKey()
    const texto = String(q || '').trim().toLowerCase()
    if (texto.length < 2) return []
    const out = []
    for (const entry of await this.#all()) {
      if (out.length >= limit) break
      const open = await openEntry(this.key, entry)
      const quien = entryWho(open)
      const heno = [entry.title, quien, ...(entry.sites || [])].filter(Boolean).join(' ').toLowerCase()
      if (heno.includes(texto)) out.push(publicView(entry, quien, open))
    }
    return out
  }

  async remove (id) {
    this.#requireKey()
    if (this.readOnly) throw new VaultError(CODES.READ_ONLY, 'esta copia solo puede leer')
    const all = await this.#all()
    const rest = all.filter(e => e.id !== id)
    if (rest.length === all.length) throw new VaultError(CODES.NOT_FOUND, 'no hay ninguna entrada con ese id')
    await this.store.set(KEY, rest)
  }

  async list () {
    this.#requireKey()
    return (await this.#all()).map(e => publicView(e))
  }
}
