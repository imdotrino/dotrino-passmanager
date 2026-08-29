// Una bóveda con la puerta puesta: la misma de dentro, pero pidiendo autorización antes
// de soltar lo privado.
//
// Existe porque las tres bóvedas del ecosistema tienen que funcionar igual (dueño,
// 2026-08-29). Las dos de fuera —el daemon y la pestaña de `vault.dotrino.com/vault`—
// ya la tenían: se la pone `VaultResponder` al atender por el proxio. La de dentro de la
// extensión no pasaba por ahí, porque no hay transporte de por medio, y acababa siendo
// la única que entregaba una llave privada sin preguntar. Esto lo iguala sin duplicar la
// política: la misma `ApprovalGate`, el mismo criterio por defecto (`get` y nada más),
// puesto donde falta.
//
// **La política vive aquí, no en quien pide.** Un aparato que pide no decide nada, y en
// la extensión «quien pide» es el mismo proceso — razón de más para que la puerta esté
// delante de la bóveda y no repartida por cada pantalla que llama.

import { VaultError, CODES } from './errors.js'

export class GuardedVault {
  /**
   * @param {object} inner  la bóveda de verdad (normalmente un `LocalVault` abierto)
   * @param {object} opts
   *   `gate`  una `ApprovalGate`
   *   `needsApproval(op, payload)`  qué exige un dedo encima. Por defecto `get`, igual
   *      que el responder: lo que saca una llave privada de la bóveda.
   */
  constructor (inner, { gate, needsApproval } = {}) {
    this.inner = inner
    this.gate = gate
    this.needsApproval = needsApproval || (op => op === 'get')
  }

  /**
   * `needsApproval: true` no es cosmético: es lo que hace que el resto del gestor trate
   * a esta bóveda como a una de fuera —no abrir de golpe todo lo del sitio al cargar la
   * página, esperar a que el usuario pida ver un valor— sin una sola rama nueva.
   */
  get capabilities () {
    return { ...(this.inner.capabilities || {}), needsApproval: true }
  }

  async #guard (op, payload) {
    if (!this.needsApproval(op, payload)) return
    const ok = await this.gate.allow({ op, payload })
    if (!ok) throw new VaultError(CODES.NOT_APPROVED, 'no aprobado')
  }

  async find (url) {
    await this.#guard('find', { url })
    return this.inner.find(url)
  }

  async get (id) {
    await this.#guard('get', { id })
    return this.inner.get(id)
  }

  async put (entry) {
    await this.#guard('put', { entry })
    return this.inner.put(entry)
  }

  async search (q, opts) {
    await this.#guard('search', { q })
    return this.inner.search(q, opts)
  }

  async remove (id) {
    await this.#guard('remove', { id })
    return this.inner.remove(id)
  }

  async list () {
    await this.#guard('list', {})
    return this.inner.list()
  }
}
