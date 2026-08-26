import { test } from 'node:test'
import assert from 'node:assert/strict'

import { LocalVault } from '../src/vault/local.js'
import { RemoteVault } from '../src/vault/remote.js'
import { VaultResponder } from '../src/vault/responder.js'
import { ProxyTransport } from '../src/transport/proxy.js'
import { makeVaultKey } from '../src/crypto.js'
import { makeEncKeypair, isSealed } from '../src/transport/sealed.js'
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
  // Todo lo que pasa por aquí es lo que vería el proxio.
  const visto = []
  function cliente (pubkey) {
    const handlers = []
    const c = {
      pubkey,
      on (ev, fn) { if (ev === 'message') handlers.push(fn) },
      off (ev, fn) { const i = handlers.indexOf(fn); if (i >= 0) handlers.splice(i, 1) },
      sendByPubkey (dests, payload) {
        visto.push(payload)
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
  return { cliente, perdidos, visto }
}

async function montar ({ isAllowed, needsApproval, approve, onRequest } = {}) {
  const net = red()
  const boveda = net.cliente('PUB-VAULT')
  const aparato = net.cliente('PUB-EXT')

  // Cada punta con su par de cifrado, como en el enlace real.
  const encBoveda = await makeEncKeypair()
  const encAparato = await makeEncKeypair()

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
    myEncPrivateKey: encBoveda.privateKey,
    encPubOf: pub => (pub === 'PUB-EXT' ? encAparato.encPub : null),
  })
  responder.start()

  const transporte = new ProxyTransport({
    client: aparato,
    peerPubkey: 'PUB-VAULT',
    peerEncPub: encBoveda.encPub,
    myEncPrivateKey: encAparato.privateKey,
    timeoutMs: 500,
  })
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

// --- Cómo conviven la aprobación y la caché ---------------------------------
//
// Son cosas distintas y no se condicionan:
//   la aprobación decide si el USUARIO tiene que decir que sí
//   la caché decide si hace falta IR a la bóveda
//
// Este test recorre la secuencia entera tal y como la vive la extensión.

test('aprobación y caché son independientes: la secuencia completa', async () => {
  const { SessionCache } = await import('../src/session-cache.js')

  let aprobaciones = 0
  const { remota, local } = await montar({
    needsApproval: op => op === 'get',
    approve: async () => { aprobaciones++; return true },
  })

  const m = new Map()
  const cache = new SessionCache({ async get (k) { return m.get(k) }, async set (k, v) { m.set(k, v) } })

  // Lo que hace la extensión en cada `get`: mirar el recuerdo, y si no, preguntar.
  let viajes = 0
  const pedir = async (id) => {
    const recordada = await cache.get(id)
    if (recordada) return recordada
    viajes++
    const entry = await remota.get(id)
    await cache.put(id, entry)
    return entry
  }

  await local.put({ title: 'Correo', sites: ['correo.com'], username: 'yo', secret: 'c0rre0' })
  const sales = (await remota.find('https://salesforce.com/'))[0]
  const banco = (await remota.find('https://banco.com.ec/'))[0]
  const correo = (await remota.find('https://correo.com/'))[0]

  // 1. La primera contraseña: hay que aprobar, y hay que ir a por ella.
  assert.equal((await pedir(sales.id)).secret, 'hunter2')
  assert.equal(aprobaciones, 1)
  assert.equal(viajes, 1)

  // 2. La MISMA otra vez, en la misma sesión: ni aprobación ni viaje. Está recordada.
  assert.equal((await pedir(sales.id)).secret, 'hunter2')
  assert.equal(aprobaciones, 1)
  assert.equal(viajes, 1)

  // 3. Una DISTINTA: hay que ir a por ella (no está recordada), pero el aparato ya
  //    está aprobado, así que al usuario no se le molesta.
  assert.equal((await pedir(banco.id)).secret, 's3cr3t')
  assert.equal(aprobaciones, 1, 'volvió a pedir permiso para una credencial distinta')
  assert.equal(viajes, 2, 'se inventó una credencial que nunca había pedido')

  // 4. Y otra más: lo mismo. La aprobación es del aparato, de una vez y para todas.
  assert.equal((await pedir(correo.id)).secret, 'c0rre0')
  assert.equal(aprobaciones, 1)
  assert.equal(viajes, 3)

  // Y al revés: vaciar el recuerdo obliga a viajar, pero NO a volver a aprobar.
  await cache.forget()
  assert.equal((await pedir(sales.id)).secret, 'hunter2')
  assert.equal(viajes, 4)
  assert.equal(aprobaciones, 1, 'olvidar la caché no puede costar una aprobación')
})

// --- Lo que el proxio NO puede ver ------------------------------------------
//
// El proxio enruta por pubkey pero no cifra el contenido: sin sellar, vería a qué
// sitios se pide credencial y cuáles se devuelven. Es la promesa que sostiene todo lo
// demás — lo del usuario no llega a los servidores de Dotrino, ni de paso.

test('el proxio no ve ni el sitio, ni la operación, ni la credencial', async () => {
  const { remota, net } = await montar()
  const [hit] = await remota.find('https://banco.com.ec/')
  await remota.get(hit.id)

  const porElCable = JSON.stringify(net.visto)
  for (const filtracion of ['banco.com.ec', 's3cr3t', 'seyacat', 'find', 'get', 'Banco']) {
    assert.ok(!porElCable.includes(filtracion), `el proxio vería «${filtracion}»`)
  }
  // Y lo que sí pasa por el cable está sellado, no es que no haya pasado nada.
  assert.ok(net.visto.length >= 4, 'no viajó nada: el test no probaría nada')
  assert.ok(net.visto.every(isSealed), 'algo salió sin sellar')
})

test('un sobre para otro aparato no se abre, y no se contesta a medias', async () => {
  const { remota, net, bitacora } = await montar()
  const antes = bitacora.length

  // Alguien manda a la bóveda un sobre sellado a OTRA llave.
  const ajeno = await makeEncKeypair()
  const { seal } = await import('../src/transport/sealed.js')
  net.cliente('PUB-INTRUSO').sendByPubkey(['PUB-VAULT'],
    await seal({ type: 'dotrino.passmanager/1', rid: 'x', op: 'find', payload: {} }, ajeno.encPub))
  await new Promise(r => setTimeout(r, 40))

  assert.equal(bitacora.length, antes, 'la bóveda reaccionó a algo que no podía leer')
  // Y lo normal sigue funcionando.
  assert.equal((await remota.find('https://salesforce.com/')).length, 1)
})

test('sin llave de cifrado del otro lado no se manda NADA', async () => {
  const { RemoteVault } = await import('../src/vault/remote.js')
  const net = red()
  const solo = net.cliente('PUB-SOLO')
  const t = new ProxyTransport({ client: solo, peerPubkey: 'PUB-VAULT', timeoutMs: 200 })
  const v = new RemoteVault(t)
  await assert.rejects(() => v.find('https://x.com/'), e => e.code === CODES.UNSEALED)
  assert.equal(net.visto.length, 0, 'salió algo en claro')
})

// --- El cifrado no es opcional ------------------------------------------------
//
// Sellar de salida no basta: si la otra punta acepta un mensaje EN CLARO, basta con
// mandarlo así para saltarse el sellado entero. Estas dos pruebas son las que
// convierten «va cifrado» en «tiene que ir cifrado».

test('la bóveda NO atiende una petición en claro, y la anota', async () => {
  const { remota, net, bitacora } = await montar()
  const intruso = net.cliente('PUB-CLARO')

  // Exactamente la misma petición que funciona sellada, pero sin sellar.
  intruso.sendByPubkey(['PUB-VAULT'], {
    type: 'dotrino.passmanager/1', rid: 'r1', op: 'find', payload: { url: 'https://salesforce.com/' },
  })
  await new Promise(r => setTimeout(r, 60))

  assert.ok(!bitacora.some(r => r.outcome === 'served'), 'atendió algo sin cifrar')
  assert.equal(bitacora.at(-1)?.outcome, 'unsealed', 'no quedó anotado')

  // Y lo normal sigue funcionando: no se ha roto nada por cerrar la puerta.
  assert.equal((await remota.find('https://salesforce.com/')).length, 1)
})

test('el aparato NO acepta una respuesta en claro (nadie contesta por la bóveda)', async () => {
  const { RemoteVault } = await import('../src/vault/remote.js')

  // Bóveda MUDA a propósito: así la única respuesta que llega es la del impostor, y
  // el test no depende de quién gane la carrera. Con una bóveda de verdad esto pasaba
  // o fallaba según la carga de la máquina, que es la peor clase de test.
  const net = red()
  const aparato = net.cliente('PUB-EXT')
  net.cliente('PUB-MUDA')
  const impostor = net.cliente('PUB-IMPOSTOR')

  const encAparato = await makeEncKeypair()
  const encMuda = await makeEncKeypair()
  const t = new ProxyTransport({
    client: aparato,
    peerPubkey: 'PUB-MUDA',
    peerEncPub: encMuda.encPub,
    myEncPrivateKey: encAparato.privateKey,
    timeoutMs: 3000,
  })
  const remota = new RemoteVault(t)

  const enVuelo = remota.find('https://salesforce.com/')
  await new Promise(r => setTimeout(r, 5))

  // Peor caso posible: el impostor CONOCE el rid (no puede, va sellado, pero se le
  // regala) e intenta colar una credencial falsa contestando sin sellar. No podría
  // leer lo que se pidió, pero sí querría que se rellenara lo suyo.
  const rid = [...t.pending.keys()][0]
  assert.ok(rid, 'la petición no llegó a estar en vuelo')
  impostor.sendByPubkey(['PUB-EXT'], {
    type: 'dotrino.passmanager.reply/1',
    rid,
    result: [{ id: 'falsa', title: 'Banco', hint: 'no soy tu bóveda' }],
  })

  // Se tumba con un código claro en vez de colarse, y sin esperar al plazo.
  await assert.rejects(() => enVuelo, e => e.code === CODES.UNSEALED,
    'aceptó una respuesta sin cifrar')
})
