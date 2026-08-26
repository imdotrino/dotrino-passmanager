import { test } from 'node:test'
import assert from 'node:assert/strict'

import { LocalVault } from '../src/vault/local.js'
import { RemoteVault } from '../src/vault/remote.js'
import { VaultResponder } from '../src/vault/responder.js'
import { ProxyTransport } from '../src/transport/proxy.js'
import { makeVaultKey } from '../src/crypto.js'
import { CODES } from '../src/vault/errors.js'

function memStore () {
  const m = new Map()
  return { async get (k) { return m.get(k) }, async set (k, v) { m.set(k, v) } }
}

/**
 * Dos clientes de mentira que se hablan como lo harían por el proxio: `sendByPubkey`
 * entrega al que tenga esa pubkey. No se prueba @dotrino/proxy-client (eso es suyo),
 * se prueba lo que montamos encima.
 */
function red () {
  const nodos = new Map()
  const perdidos = { on: false }
  function cliente (pubkey) {
    const handlers = []
    const c = {
      pubkey,
      on (ev, fn) { if (ev === 'message') handlers.push(fn) },
      off (ev, fn) { const i = handlers.indexOf(fn); if (i >= 0) handlers.splice(i, 1) },
      sendByPubkey (dests, payload) {
        if (perdidos.on) return
        for (const d of dests) {
          const destino = nodos.get(d)
          if (!destino) throw new Error('sin ruta')
          // Asíncrono, como la red de verdad.
          setTimeout(() => destino._deliver(pubkey, payload), 0)
        }
      },
      _deliver (from, payload) {
        for (const h of handlers) h(from, payload, { fromPubkey: from })
      },
    }
    nodos.set(pubkey, c)
    return c
  }
  return { cliente, perdidos }
}

async function montar ({ isAllowed, needsApproval, approve, onRequest } = {}) {
  const net = red()
  const boveda = net.cliente('PUB-VAULT')
  const aparato = net.cliente('PUB-EXT')

  const local = new LocalVault(memStore())
  local.unlock(await makeVaultKey())
  await local.put({ title: 'Salesforce', sites: ['salesforce.com'], username: 'sandrade@dotrino.com', secret: 'hunter2' })
  await local.put({ title: 'Banco', sites: ['banco.com.ec'], username: 'seyacat', secret: 's3cr3t' })

  const bitacora = []
  const responder = new VaultResponder({
    client: boveda,
    vault: local,
    isAllowed: isAllowed || (pub => pub === 'PUB-EXT'),
    needsApproval: needsApproval || (() => false),
    approve,
    onRequest: r => { bitacora.push(r); onRequest?.(r) },
  })
  responder.start()

  const transporte = new ProxyTransport({ client: aparato, peerPubkey: 'PUB-VAULT', timeoutMs: 500 })
  const remota = new RemoteVault(transporte)
  return { remota, local, transporte, bitacora, net, responder }
}

const montarConResponder = montar

test('remoto: la extensión pide por dominio y recibe metadatos SIN secretos', async () => {
  const { remota, bitacora } = await montar()
  const hits = await remota.find('https://login.salesforce.com/')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].hint, 's•••e@dotrino.com')
  assert.ok(!JSON.stringify(hits).includes('hunter2'))
  assert.equal(bitacora.at(-1).outcome, 'served')
})

test('remoto: pide UNA y recibe UNA', async () => {
  const { remota } = await montar()
  const [hit] = await remota.find('https://salesforce.com/')
  const cred = await remota.get(hit.id)
  assert.equal(cred.secret, 'hunter2')
  // La otra entrada no ha viajado en ningún momento.
  assert.equal(cred.title, 'Salesforce')
})

test('remoto: NO se puede listar la bóveda, ni pidiéndolo a mano', async () => {
  const { remota, transporte, bitacora } = await montar()
  // Por la interfaz: ni sale a la red.
  await assert.rejects(() => remota.list(), e => e.code === CODES.NO_KEY)
  // Y saltándose la interfaz, el que responde también lo niega.
  await assert.rejects(() => transporte.request('list', {}), e => e.code === CODES.DENIED)
  assert.equal(bitacora.at(-1).outcome, 'denied')
})

test('remoto: un aparato desconocido no recibe nada', async () => {
  const { remota, bitacora } = await montar({ isAllowed: () => false })
  await assert.rejects(() => remota.find('https://salesforce.com/'), e => e.code === CODES.DENIED)
  assert.equal(bitacora.at(-1).outcome, 'denied')
})

test('remoto: con aprobación, sin el dedo no hay credencial', async () => {
  let pedido = null
  const { remota } = await montar({
    needsApproval: op => op === 'get',
    approve: async (req) => { pedido = req; return false },
  })
  const [hit] = await remota.find('https://salesforce.com/')
  await assert.rejects(() => remota.get(hit.id), e => e.code === CODES.DENIED)
  assert.equal(pedido.op, 'get')
  assert.equal(pedido.pubkey, 'PUB-EXT')
})

test('remoto: con aprobación concedida, la credencial llega', async () => {
  const { remota } = await montar({
    needsApproval: op => op === 'get',
    approve: async () => true,
  })
  const [hit] = await remota.find('https://salesforce.com/')
  assert.equal((await remota.get(hit.id)).secret, 'hunter2')
})

test('remoto: si nadie contesta, se dice que nadie contestó', async () => {
  const { remota, net } = await montar()
  net.perdidos.on = true
  await assert.rejects(
    () => remota.find('https://salesforce.com/'),
    e => e.code === CODES.APPROVAL_TIMEOUT,
  )
})

test('remoto: cerrar el transporte no deja peticiones colgadas', async () => {
  const { remota, transporte, net } = await montar()
  net.perdidos.on = true
  const p = remota.find('https://salesforce.com/')
  transporte.close()
  await assert.rejects(() => p, e => e.code === CODES.UNREACHABLE)
})

test('remoto: la bitácora anota cada petición, servida o no', async () => {
  const { remota, bitacora } = await montar()
  const [hit] = await remota.find('https://salesforce.com/')
  await remota.get(hit.id)
  assert.deepEqual(bitacora.map(r => r.op + ':' + r.outcome), ['find:served', 'get:served'])
  assert.ok(bitacora.every(r => r.from === 'PUB-EXT' && r.ts > 0))
})

// --- La aprobación es del APARATO, no de cada credencial ---------------------

test('aprobación: se pide UNA vez y vale para lo que venga después', async () => {
  let veces = 0
  const { remota } = await montar({
    needsApproval: op => op === 'get',
    approve: async () => { veces++; return true },
  })
  const hits = await remota.find('https://salesforce.com/')
  const banco = await remota.find('https://banco.com.ec/')

  await remota.get(hits[0].id)
  await remota.get(banco[0].id)
  await remota.get(hits[0].id)

  assert.equal(veces, 1, 'volvió a pedir el dedo')
})

test('aprobación: negarla no aprueba al aparato para la siguiente', async () => {
  let veces = 0
  const { remota } = await montar({
    needsApproval: op => op === 'get',
    approve: async () => { veces++; return false },
  })
  const [hit] = await remota.find('https://salesforce.com/')
  await assert.rejects(() => remota.get(hit.id), e => e.code === CODES.DENIED)
  await assert.rejects(() => remota.get(hit.id), e => e.code === CODES.DENIED)
  assert.equal(veces, 2, 'una negativa no puede quedar recordada como aprobación')
})

test('aprobación: dos peticiones a la vez no producen dos avisos', async () => {
  let veces = 0
  let soltar
  const espera = new Promise(r => { soltar = r })
  const { remota } = await montar({
    needsApproval: op => op === 'get',
    approve: async () => { veces++; await espera; return true },
  })
  const [hit] = await remota.find('https://salesforce.com/')
  const a = remota.get(hit.id)
  const b = remota.get(hit.id)
  await new Promise(r => setTimeout(r, 30))
  soltar()
  await Promise.all([a, b])
  assert.equal(veces, 1, 'dos pestañas a la vez hicieron sonar el teléfono dos veces')
})

test('aprobación: alwaysAsk se pregunta SIEMPRE, aunque el aparato esté aprobado', async () => {
  const pedidas = []
  const { remota, local } = await montar({
    needsApproval: op => op === 'get',
    approve: async ({ entry }) => { pedidas.push(entry?.title || '?'); return true },
  })
  await local.put({ title: 'Banco', sites: ['banco.com.ec'], secret: 's3cr3t', alwaysAsk: true })

  const [normal] = await remota.find('https://salesforce.com/')
  const banco = (await remota.find('https://banco.com.ec/')).find(e => e.alwaysAsk)

  await remota.get(normal.id)   // aprueba el aparato
  await remota.get(banco.id)    // marcada: pregunta igual
  await remota.get(banco.id)    // y otra vez
  await remota.get(normal.id)   // esta ya no

  assert.equal(pedidas.length, 3)
  assert.deepEqual(pedidas.slice(1), ['Banco', 'Banco'])
})

test('aprobación: se puede retirar sin apagar la bóveda', async () => {
  let veces = 0
  const net = []
  const { remota, responder } = await montarConResponder({
    needsApproval: op => op === 'get',
    approve: async () => { veces++; return true },
  })
  const [hit] = await remota.find('https://salesforce.com/')
  await remota.get(hit.id)
  await remota.get(hit.id)
  assert.equal(veces, 1)

  responder.revokeApproval('PUB-EXT')
  await remota.get(hit.id)
  assert.equal(veces, 2, 'retirar la aprobación no volvió a pedir el dedo')
})
