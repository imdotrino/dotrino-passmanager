// LOS CÓDIGOS DEL RESPONDER SELLADO. Tres de sus errores salían con `code: undefined`
// —`CODES.NOT_ALLOWED` no existía—, y del otro lado eso no dice nada: la pantalla no puede
// distinguir «este aparato no tiene permiso» de «no contestó nadie». Los errores son un
// contrato y se comprueban por código (`errors.js`).

import test from 'node:test'
import assert from 'node:assert/strict'
import { SealedResponder } from '../src/vault/sealed-responder.js'
import { CODES } from '../src/vault/errors.js'
import { TYPE } from '../src/transport/protocol.js'

function responder (opts = {}) {
  const enviados = []
  const client = {
    on () {},
    sendSealedTo (to, msg) { enviados.push(msg) }
  }
  const r = new SealedResponder({
    client,
    store: { privateKeysOf: async () => [], views: async () => [] },
    encPubOf: () => 'enc',
    ...opts
  })
  return { r, enviados }
}

const pide = (op, payload = {}) => ({ type: TYPE, rid: 'r1', op, payload })

test('todos los códigos que usa el responder existen', () => {
  for (const k of ['NOT_ALLOWED', 'NOT_SEALED', 'UNKNOWN', 'DENIED', 'NOT_APPROVED', 'UNSEALED']) {
    assert.equal(typeof CODES[k], 'string', `CODES.${k} no existe: el error cruzaría sin código`)
  }
})

test('un aparato sin permiso recibe `denied`, no un error sin código', async () => {
  const { r, enviados } = responder({ isAllowed: () => false })
  await r.handle({ from: 't', pubkey: 'p', msg: pide('pm2.views') })
  assert.equal(enviados[0]?.error?.code, 'denied')
})

test('lo que llega en claro recibe `unsealed`', async () => {
  const { r, enviados } = responder({ isAllowed: () => true })
  await r.handle({ from: 't', pubkey: 'p', msg: pide('pm2.views'), sealed: false })
  assert.equal(enviados[0]?.error?.code, 'unsealed')
})

test('si el humano dice que no, `not-approved` — distinto de `denied`', async () => {
  const { r, enviados } = responder({ isAllowed: () => true, needsApproval: async () => true, approve: async () => false })
  await r.handle({ from: 't', pubkey: 'p', msg: pide('pm2.get', { id: 'e1' }) })
  assert.equal(enviados[0]?.error?.code, 'not-approved')
})

test('start() sabe QUIÉN pregunta por `meta.fromPubkey`, que es lo que da el proxio', async () => {
  // Se leía `meta.pubkey`, que el cliente no pone: la bóveda no sabía a quién sellarle la
  // respuesta y no contestaba. Las pruebas llamaban a `handle()` con la llave puesta, así
  // que nunca pasaban por aquí.
  let alLlegar = null
  const enviados = []
  const client = {
    on (ev, fn) { if (ev === 'message') alLlegar = fn },
    sendSealedTo (to, msg, opts) { enviados.push({ to, msg, opts }) }
  }
  const r = new SealedResponder({
    client,
    store: { views: async () => [] },
    isAllowed: (p) => p === 'PUB',
    encPubOf: (p) => (p === 'PUB' ? 'ENC' : null)
  })
  r.start()
  await alLlegar('tok', pide('pm2.views'), { fromPubkey: 'PUB', sealed: true })
  assert.equal(enviados.length, 1, 'contestó')
  assert.equal(enviados[0].to, 'tok', 'por el token por el que llegó')
  assert.equal(enviados[0].opts?.peerEncPub, 'ENC', 'sellado a la llave de quien preguntó')
  assert.ok(!enviados[0].msg.error, JSON.stringify(enviados[0].msg.error))

  // Sin saber quién es, no se contesta: el token no es una llave.
  await alLlegar('otro', pide('pm2.views'), { sealed: true })
  assert.equal(enviados.length, 1)
})

test('un aparato sin llave de cifrado en el acta no tumba la bóveda ni se le atiende', async () => {
  // 2026-10-26: un aparato de usuario y contraseña nació sin `encPub`; cada pedido suyo
  // hacía que #send lanzara `no-encpub` fuera del manejador del socket y Node cerraba la
  // bóveda. Ahora se anota y no se hace el trabajo.
  let alLlegar = null
  const vistos = []
  let tocado = false
  const r = new SealedResponder({
    client: { on (ev, fn) { if (ev === 'message') alLlegar = fn }, sendSealedTo () { throw new Error('should not send') } },
    store: { privateKeysOf: async () => [], views: async () => { tocado = true; return [] } },
    isAllowed: () => true,
    needsApproval: async () => false,
    encPubOf: () => null,
    onRequest: (x) => vistos.push(x),
  })
  r.start()
  await alLlegar('t', pide('pm2.views'), { fromPubkey: 'p', sealed: true })
  assert.equal(tocado, false, 'no abre nada que no podrá contar')
  assert.equal(vistos[0]?.outcome, 'no-encpub')
})

test('un fallo al contestar se anota en vez de escaparse del manejador', async () => {
  let alLlegar = null
  const vistos = []
  const r = new SealedResponder({
    client: { on (ev, fn) { if (ev === 'message') alLlegar = fn }, sendSealedTo () { throw Object.assign(new Error('boom'), { code: 'send-failed' }) } },
    store: { privateKeysOf: async () => [], views: async () => [] },
    isAllowed: () => true,
    needsApproval: async () => false,
    encPubOf: () => 'enc',
    onRequest: (x) => vistos.push(x),
  })
  r.start()
  await alLlegar('t', pide('pm2.views'), { fromPubkey: 'p', sealed: true })
  assert.equal(vistos.at(-1)?.outcome, 'unanswered')
  assert.equal(vistos.at(-1)?.code, 'send-failed')
})
