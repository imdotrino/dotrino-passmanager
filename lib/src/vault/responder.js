// El lado que RESPONDE: la bóveda de verdad (el vault del PC, la app nativa).
//
// Es donde vive la política, y por eso está aquí y no repartida por cada aparato:
// quién puede pedir, qué puede pedir, qué exige aprobación y qué queda anotado. Un
// aparato que pide no decide nada.

import { isRequest, reply, replyError, REMOTE_OPS } from '../transport/protocol.js'
import { CODES } from './errors.js'

export class VaultResponder {
  /**
   * @param {object} opts
   *   `client`   cliente de @dotrino/proxy-client conectado e identificado
   *   `vault`    una bóveda con la CEK (LocalVault desbloqueada)
   *   `isAllowed(pubkey) -> boolean`  qué aparatos pueden pedir. Por defecto NADIE:
   *              una bóveda que responde a cualquiera no es una bóveda.
   *   `needsApproval(op, entry, pubkey) -> boolean`  qué exige un dedo encima
   *   `approve({ op, entry, pubkey }) -> Promise<boolean>`  cómo se pide ese dedo
   *   `onRequest(record)`  la bitácora
   */
  constructor ({ client, vault, isAllowed, needsApproval, approve, onRequest } = {}) {
    this.client = client
    this.vault = vault
    this.isAllowed = isAllowed || (() => false)
    this.needsApproval = needsApproval || (op => op === 'get')
    this.approve = approve || (async () => false)
    this.onRequest = onRequest || (() => {})
    this._handler = null
  }

  start () {
    if (this._handler) return
    this._handler = (from, payload, meta) => {
      this.#handle(payload, meta?.fromPubkey || from).catch(() => {})
    }
    this.client.on('message', this._handler)
  }

  stop () {
    if (this._handler && this.client.off) this.client.off('message', this._handler)
    this._handler = null
  }

  async #send (pubkey, msg) {
    try { this.client.sendByPubkey([pubkey], msg) } catch { /* el que pidió reintentará */ }
  }

  async #handle (msg, fromPubkey) {
    if (!isRequest(msg)) return

    const record = { op: msg.op, from: fromPubkey, ts: Date.now() }

    // 1. ¿Es un aparato que conozco? Si no, ni se le contesta qué falló.
    if (!fromPubkey || !this.isAllowed(fromPubkey)) {
      this.onRequest({ ...record, outcome: 'denied' })
      return this.#send(fromPubkey, replyError(msg.rid, CODES.DENIED, 'aparato no autorizado'))
    }

    // 2. `list` no está en la lista, y esa ausencia es el diseño: si un aparato
    //    pudiera pedir la bóveda entera, el "de a una" no significaría nada.
    if (!REMOTE_OPS.includes(msg.op)) {
      this.onRequest({ ...record, outcome: 'denied' })
      return this.#send(fromPubkey, replyError(msg.rid, CODES.DENIED, 'operación no permitida en remoto'))
    }

    try {
      const payload = msg.payload || {}

      if (this.needsApproval(msg.op, payload, fromPubkey)) {
        const ok = await this.approve({ op: msg.op, payload, pubkey: fromPubkey })
        if (!ok) {
          this.onRequest({ ...record, outcome: 'refused' })
          return this.#send(fromPubkey, replyError(msg.rid, CODES.DENIED, 'no aprobado'))
        }
      }

      let result
      switch (msg.op) {
        case 'find': result = await this.vault.find(payload.url); break
        case 'get': result = await this.vault.get(payload.id); break
        case 'put': result = await this.vault.put(payload.entry); break
        case 'remove': result = await this.vault.remove(payload.id); break
      }

      this.onRequest({ ...record, outcome: 'served', id: payload.id })
      await this.#send(fromPubkey, reply(msg.rid, result ?? null))
    } catch (e) {
      this.onRequest({ ...record, outcome: 'error', code: e?.code })
      await this.#send(fromPubkey, replyError(msg.rid, e?.code || 'error', e?.message))
    }
  }
}
