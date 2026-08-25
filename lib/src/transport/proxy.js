// Transporte del lado que PIDE (la extensión, la app).
//
// Cumple `{ request(op, payload) }`, que es lo único que `RemoteVault` necesita. El
// cliente del proxio se recibe ya construido y conectado: así esta pieza se prueba
// con un cliente falso y no arrastra la librería entera a los tests.

import { TYPE, REPLY, request as mkRequest, isReply } from './protocol.js'
import { VaultError, CODES } from '../vault/errors.js'

let counter = 0

function newRid () {
  const r = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : String(++counter) + '-' + Math.floor(performance.now())
  return r
}

export class ProxyTransport {
  /**
   * @param {object} opts
   *   `client`      cliente de @dotrino/proxy-client ya conectado e identificado
   *   `peerPubkey`  pubkey (JWK) de la bóveda que responde
   *   `timeoutMs`   cuánto se espera. Generoso a propósito: al otro lado puede
   *                 haber alguien poniendo el dedo en el teléfono.
   */
  constructor ({ client, peerPubkey, timeoutMs = 90_000 }) {
    this.client = client
    this.peerPubkey = peerPubkey
    this.timeoutMs = timeoutMs
    this.pending = new Map()

    this.client.on('message', (_from, payload) => {
      if (!isReply(payload)) return
      const p = this.pending.get(payload.rid)
      if (!p) return // respuesta a algo que ya venció; se ignora
      this.pending.delete(payload.rid)
      clearTimeout(p.timer)
      if (payload.error) {
        p.reject(new VaultError(payload.error.code || 'error', payload.error.message))
      } else {
        p.resolve(payload.result)
      }
    })
  }

  request (op, payload) {
    const rid = newRid()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid)
        // No es "no hay nadie": es que nadie contestó. Suele ser el teléfono sin
        // que nadie lo mire, y el código lo distingue para poder decirlo bien.
        reject(new VaultError(CODES.APPROVAL_TIMEOUT, 'nadie respondió a tiempo'))
      }, this.timeoutMs)

      this.pending.set(rid, { resolve, reject, timer })

      try {
        // Por pubkey, no por token: así entra la cola offline del proxio y la
        // petición sobrevive a que la bóveda esté reconectando.
        this.client.sendByPubkey([this.peerPubkey], mkRequest(rid, op, payload))
      } catch (e) {
        this.pending.delete(rid)
        clearTimeout(timer)
        reject(new VaultError(CODES.UNREACHABLE, e?.message || 'no se pudo enviar'))
      }
    })
  }

  /** Cancela lo que esté esperando. Se llama al cerrar el popup o al desenlazar. */
  close (code = CODES.UNREACHABLE) {
    for (const [rid, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new VaultError(code, 'transporte cerrado'))
      this.pending.delete(rid)
    }
  }
}

export { TYPE, REPLY }
