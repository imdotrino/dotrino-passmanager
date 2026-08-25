// Bóveda remota: la que usa la extensión de Chrome por defecto (DISENO §2).
//
// No tiene la CEK y no guarda nada. Pregunta por un dominio, recibe metadatos, y
// pide UNA credencial cuando el usuario elige. Quién responde al otro lado del
// transporte —el vault del PC o el teléfono— le da igual.

import { VaultError, CODES } from './errors.js'

export class RemoteVault {
  /**
   * @param {object} transport `{ request(op, payload) }` — proxy, WebSocket o
   *   `chrome.runtime` según dónde corra. Devuelve la respuesta ya deserializada.
   */
  constructor (transport, opts = {}) {
    this.transport = transport
    this.needsApproval = opts.needsApproval !== false
  }

  get capabilities () {
    return { canWrite: true, canList: false, needsApproval: this.needsApproval }
  }

  async find (url) {
    return this.#request('find', { url })
  }

  /** UNA credencial. Al otro lado puede pedir la huella antes de responder. */
  async get (id) {
    return this.#request('get', { id })
  }

  async put (entry) {
    return this.#request('put', { entry })
  }

  /**
   * No se puede, y no es una limitación técnica: si la extensión pudiera listar la
   * bóveda entera, el "pide de a una" no significaría nada (DISENO §2).
   */
  async list () {
    throw new VaultError(CODES.NO_KEY, 'una bóveda remota no lista: pide de a una')
  }

  async #request (op, payload) {
    try {
      return await this.transport.request(op, payload)
    } catch (e) {
      // El transporte puede fallar de muchas formas; hacia arriba solo hay códigos.
      if (e instanceof VaultError) throw e
      throw new VaultError(e?.code || CODES.UNREACHABLE, e?.message || 'no hay bóveda al otro lado')
    }
  }
}
