// El lado que RESPONDE: la bóveda de verdad (el vault del PC, la app nativa).
//
// Es donde vive la política, y por eso está aquí y no repartida por cada aparato:
// quién puede pedir, qué puede pedir, qué exige aprobación y qué queda anotado. Un
// aparato que pide no decide nada.

import { isRequest, reply, replyError, REMOTE_OPS } from '../transport/protocol.js'
import { seal, open, isSealed } from '../transport/sealed.js'
import { CODES } from './errors.js'

export class VaultResponder {
  /**
   * @param {object} opts
   *   `client`   cliente de @dotrino/proxy-client conectado e identificado
   *   `vault`    una bóveda con la CEK (LocalVault desbloqueada)
   *   `isAllowed(pubkey) -> boolean`  qué aparatos pueden pedir. Por defecto NADIE:
   *              una bóveda que responde a cualquiera no es una bóveda.
   *   `needsApproval(op, payload, pubkey) -> boolean`  qué exige un dedo encima
   *   `approve({ op, payload, pubkey }) -> Promise<boolean>`  cómo se pide ese dedo
   *   `onRequest(record)`  la bitácora
   *
   * **La aprobación es del APARATO, no de cada credencial.** Se pide una vez y vale
   * mientras esta bóveda siga encendida; apagarla la retira. Es el mismo modelo que
   * `pair --approval` del vault: una por arranque, sin ventana de tiempo que vigilar.
   *
   * No se ata a la conexión a propósito: un service worker se duerme cada poco y
   * reconecta constantemente, así que «por conexión» sería pedir el dedo todo el rato.
   * Quien manda es la bóveda, que es la que el usuario apaga cuando quiere cortar.
   */
  constructor ({ client, vault, isAllowed, needsApproval, approve, onRequest, myEncPrivateKey, encPubOf } = {}) {
    this.client = client
    this.vault = vault
    // Mi privada de cifrado, para abrir lo que me sellan.
    this.myEncPrivateKey = myEncPrivateKey
    // Y la pública de cifrado de cada aparato, para sellarle la respuesta.
    this.encPubOf = encPubOf || (() => null)
    this.isAllowed = isAllowed || (() => false)
    this.needsApproval = needsApproval || (op => op === 'get')
    this.approve = approve || (async () => false)
    this.onRequest = onRequest || (() => {})
    this._handler = null
    // Aparatos aprobados en esta vida de la bóveda. No se persiste: eso es el diseño.
    this._approved = new Set()
    // Una petición a la vez por aparato: dos pestañas pidiendo a la vez no deben
    // producir dos avisos en el teléfono para lo mismo.
    this._asking = new Map()
  }

  /** Retira la aprobación de un aparato sin apagar la bóveda. */
  revokeApproval (pubkey) {
    if (pubkey) this._approved.delete(pubkey)
    else this._approved.clear()
  }

  isApproved (pubkey) {
    return this._approved.has(pubkey)
  }

  async #approveDevice (pubkey, op, payload) {
    if (this._approved.has(pubkey)) return true
    if (this._asking.has(pubkey)) return this._asking.get(pubkey)

    const p = Promise.resolve(this.approve({ op, payload, pubkey }))
      .then(ok => {
        if (ok) this._approved.add(pubkey)
        return ok
      })
      .finally(() => this._asking.delete(pubkey))

    this._asking.set(pubkey, p)
    return p
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
    try {
      // La respuesta lleva la credencial: se sella al aparato que la pidió, o no sale.
      const encPub = this.encPubOf(pubkey)
      if (!encPub) return
      this.client.sendByPubkey([pubkey], await seal(msg, encPub))
    } catch { /* el que pidió reintentará */ }
  }

  async #handle (payload, fromPubkey) {
    let msg = payload
    if (isSealed(payload)) {
      if (!this.myEncPrivateKey) return
      try { msg = await open(payload, this.myEncPrivateKey) } catch { return }
    }
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
        const ok = await this.#approveDevice(fromPubkey, msg.op, payload)
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
