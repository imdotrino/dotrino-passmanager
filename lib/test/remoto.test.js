import { test } from 'node:test'
import assert from 'node:assert/strict'

import { LocalVault } from '../src/vault/local.js'
import { RemoteVault } from '../src/vault/remote.js'
import { VaultResponder } from '../src/vault/responder.js'
import { ProxyTransport } from '../src/transport/proxy.js'
import { makeVaultKey, fieldHasher } from '../src/crypto.js'
import { makeEncKeypair, isSealed, seal, open } from '../src/transport/sealed.js'
import { CODES } from '../src/vault/errors.js'

function memStore () {
  const m = new Map()
  return { async get (k) { return m.get(k) }, async set (k, v) { m.set(k, v) } }
}

/**
 * Dos clientes de mentira que se hablan como lo harían por el proxio.
 *
 * Imitan lo que hace el cliente de verdad desde 0.13.0: `sendSealed` sella, y al
 * entregar se abre el sobre y se marca `meta.sealed`. Lo que llega en claro se pasa
 * sin esa marca — que es justo lo que las dos puntas tienen que rechazar.
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
      encPrivate: null,
      on (ev, fn) { if (ev === 'message') handlers.push(fn) },
      off (ev, fn) { const i = handlers.indexOf(fn); if (i >= 0) handlers.splice(i, 1) },

      /** Lo que usa el código de verdad: sella y manda. */
      async sendSealed (dests, payload, { peerEncPub } = {}) {
        if (!peerEncPub) throw Object.assign(new Error('sin llave'), { code: CODES.UNSEALED })
        c.sendByPubkey(dests, await seal(payload, peerEncPub))
      },

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

      async _deliver (from, payload) {
        // El cliente del pilar abre el sobre y marca `meta.sealed`. Lo que viene en
        // claro se entrega sin la marca, para poder comprobar que se rechaza.
        if (isSealed(payload)) {
          if (!c.encPrivate) return
          let abierto
          try { abierto = await open(payload, c.encPrivate) } catch { return }
          for (const h of handlers) h(from, abierto, { fromPubkey: from, sealed: true })
          return
        }
        for (const h of handlers) h(from, payload, { fromPubkey: from, sealed: false })
      },
    }
    nodos.set(pubkey, c)
    return c
  }
  return { cliente, perdidos, visto }
}

/**
 * @param {object} opts
 *   `porDefecto`  no pasar `needsApproval`, para probar el criterio del propio responder
 *      (solo `get`, y solo si lo pedido incluye algo privado).
 */
async function montar ({ isAllowed, needsApproval, approve, onRequest, admin, porDefecto } = {}) {
  const net = red()
  const boveda = net.cliente('PUB-VAULT')
  const aparato = net.cliente('PUB-EXT')

  // Cada punta con su par de cifrado, como en el enlace real.
  const encBoveda = await makeEncKeypair()
  const encAparato = await makeEncKeypair()
  boveda.encPrivate = encBoveda.privateKey
  aparato.encPrivate = encAparato.privateKey

  const local = new LocalVault(memStore())
  local.unlock(await makeVaultKey())
  await local.put({ title: 'Salesforce', sites: ['salesforce.com'], username: 'sandrade@dotrino.com', secret: 'hunter2' })
  await local.put({ title: 'Banco', sites: ['banco.com.ec'], username: 'seyacat', secret: 's3cr3t' })
  // Una entrada de datos con las dos mitades: pública y privada (§4.2). En un sitio
  // aparte, para no cambiarle las cuentas a las pruebas de arriba.
  await local.put({
    type: 'data',
    title: 'Mis datos',
    sites: ['datos.ejemplo'],
    fields: [
      { kind: 'tel', label: 'Teléfono', value: '0999111222' },
      { label: 'Cédula', value: '1700123456', private: true },
    ],
  })

  const bitacora = []
  const responder = new VaultResponder({
    client: boveda,
    vault: local,
    isAllowed: isAllowed || (pub => pub === 'PUB-EXT'),
    ...(porDefecto ? {} : { needsApproval: needsApproval || (() => false) }),
    approve,
    onRequest: r => { bitacora.push(r); onRequest?.(r) },
    encPubOf: pub => (pub === 'PUB-EXT' ? encAparato.encPub : null),
    admin,
  })
  responder.start()

  const transporte = new ProxyTransport({
    client: aparato,
    peerPubkey: 'PUB-VAULT',
    peerEncPub: encBoveda.encPub,
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
  assert.equal(hits[0].hint, 'sandrade@dotrino.com')
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
  await assert.rejects(() => remota.get(hit.id), e => e.code === CODES.NOT_APPROVED)
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
  await assert.rejects(() => remota.get(hit.id), e => e.code === CODES.NOT_APPROVED)
  await assert.rejects(() => remota.get(hit.id), e => e.code === CODES.NOT_APPROVED)
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
  aparato.encPrivate = encAparato.privateKey
  const t = new ProxyTransport({
    client: aparato,
    peerPubkey: 'PUB-MUDA',
    peerEncPub: encMuda.encPub,
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

// --- Administrar aparatos ----------------------------------------------------
//
// Una consola necesita ver y retirar aparatos, pero NO puede listar credenciales: si
// pudiera, el «de a una» se saltaría con solo llamarse consola.

test('admin: sin `admin` configurado, un aparato no administra nada', async () => {
  const { transporte, bitacora } = await montar()
  await assert.rejects(() => transporte.request('devices', {}), e => e.code === CODES.DENIED)
  assert.equal(bitacora.at(-1).outcome, 'denied')
})

test('admin: ver y retirar aparatos, siempre con aprobación aparte', async () => {
  const retirados = []
  const aprobaciones = []
  const { remota, transporte } = await montar({
    needsApproval: op => op === 'get',
    approve: async (r) => { aprobaciones.push({ op: r.op, admin: !!r.admin }); return true },
    admin: {
      async devices () { return [{ pubkey: 'PUB-EXT', label: 'Chrome', ts: 1 }] },
      async unlink (pub) { retirados.push(pub); return { ok: true } },
    },
  })

  // Aprobar el aparato para pedir credenciales NO le da administrar.
  const [hit] = await remota.find('https://salesforce.com/')
  await remota.get(hit.id)
  assert.deepEqual(aprobaciones, [{ op: 'get', admin: false }])

  const lista = await transporte.request('devices', {})
  assert.equal(lista[0].label, 'Chrome')
  await transporte.request('unlink', { pubkey: 'PUB-OTRO' })
  assert.deepEqual(retirados, ['PUB-OTRO'])

  // Cada operación de administración pidió su propia aprobación.
  assert.deepEqual(aprobaciones.slice(1), [
    { op: 'devices', admin: true },
    { op: 'unlink', admin: true },
  ])
})

test('admin: negar la aprobación no retira nada', async () => {
  const retirados = []
  const { transporte } = await montar({
    approve: async () => false,
    admin: { async devices () { return [] }, async unlink (p) { retirados.push(p); return {} } },
  })
  await assert.rejects(() => transporte.request('unlink', { pubkey: 'X' }), e => e.code === CODES.NOT_APPROVED)
  assert.deepEqual(retirados, [], 'retiró un aparato sin aprobación')
})

test('admin: administrar NO abre la puerta a listar credenciales', async () => {
  const { transporte } = await montar({
    approve: async () => true,
    admin: { async devices () { return [] }, async unlink () { return {} } },
  })
  await transporte.request('devices', {})   // permitido
  await assert.rejects(() => transporte.request('list', {}), e => e.code === CODES.DENIED)
})


// --- las tres bóvedas funcionan igual, y esto lo prueba POR EL CABLE ------------
//
// El daemon y la pestaña del vault atienden por aquí. Si la regla de qué se autoriza o el
// `patch` solo estuvieran en la bóveda de dentro de la extensión, serían tres bóvedas
// distintas otra vez.

const campos = (open) => { try { return JSON.parse(open?.fields || '[]') } catch { return [] } }
const campo = (open, label) => campos(open).find(f => f.label === label)
const datosDe = async (remota) =>
  (await remota.find('https://datos.ejemplo/')).find(e => e.type === 'data')

test('por el cable: pedir un dato PÚBLICO no pide autorización', async () => {
  let veces = 0
  const { remota } = await montar({ porDefecto: true, approve: async () => { veces++; return true } })
  const datos = await datosDe(remota)
  const open = await remota.get(datos.id, { keys: ['tel'] })
  assert.equal(veces, 0, 'preguntó por un dato público')
  assert.equal(campo(open, 'Teléfono').value, '0999111222')
})

test('por el cable: y solo llega lo pedido', async () => {
  const { remota } = await montar({ porDefecto: true, approve: async () => true })
  const datos = await datosDe(remota)
  const open = await remota.get(datos.id, { keys: ['tel'] })
  assert.equal(campos(open).length, 1, 'llegó más de lo que se pidió')
  assert.equal(JSON.stringify(open).includes('1700123456'), false, 'se coló el dato privado')
})

test('por el cable: pedir un dato PRIVADO sí pide autorización', async () => {
  let veces = 0
  const { remota } = await montar({ porDefecto: true, approve: async () => { veces++; return true } })
  const datos = await datosDe(remota)
  const open = await remota.get(datos.id, { keys: ['label:Cédula'] })
  assert.equal(veces, 1)
  assert.equal(campo(open, 'Cédula').value, '1700123456')
})

test('por el cable: la contraseña es privada aunque nadie la marque', async () => {
  let veces = 0
  const { remota } = await montar({ porDefecto: true, approve: async () => { veces++; return true } })
  const [hit] = await remota.find('https://banco.com.ec/')
  await remota.get(hit.id, { keys: ['secret'] })
  assert.equal(veces, 1)
})

test('por el cable: `patch` no pide autorización y no pierde nada', async () => {
  let veces = 0
  const { remota, local } = await montar({ porDefecto: true, approve: async () => { veces++; return true } })
  const datos = await datosDe(remota)
  await remota.patch(datos.id, { fields: [{ kind: 'tel', label: 'Teléfono', value: '0988000111' }] })
  assert.equal(veces, 0, 'guardar pidió autorización')

  const open = await local.get(datos.id)
  assert.equal(campo(open, 'Teléfono').value, '0988000111')
  assert.equal(campo(open, 'Cédula').value, '1700123456', 'la entrada quedó a medias')
  assert.equal(campo(open, 'Cédula').private, true, 'se perdió la marca de privado')
})

test('por el cable: buscar en toda la bóveda YA se puede', async () => {
  // `search` estaba implementado en las dos puntas y NO en `REMOTE_OPS`, así que el
  // responder lo rechazaba: traerse la cuenta de otro dominio funcionaba con la bóveda de
  // dentro y no con una conectada.
  const { remota } = await montar({ approve: async () => true })
  const hay = await remota.search('banco')
  assert.equal(hay.length, 1)
  assert.equal(hay[0].hint, 'seyacat')
})

test('por el cable: los RESÚMENES llegan, para comparar sin abrir', async () => {
  const { remota } = await montar({ approve: async () => true })
  const datos = await datosDe(remota)
  assert.ok(datos.nonce, 'sin nonce no hay con qué comparar')
  const hash = await fieldHasher(datos.nonce)
  assert.equal(await hash('tel', '0999111222'), datos.fieldHashes.tel)
  assert.equal(await hash('label:Cédula', '1700123456'), datos.fieldHashes['label:Cédula'])
})

test('sitios: el dominio viaja por el proxio, pero ni un id ni un nombre', async () => {
  const { remota, net } = await montar()
  const sitios = await remota.sites()
  assert.deepEqual(sitios.map(s => s.site), ['banco.com.ec', 'datos.ejemplo', 'salesforce.com'])
  assert.equal(sitios.every(s => s.count === 1), true)
  for (const s of sitios) assert.deepEqual(Object.keys(s).sort(), ['count', 'site'])

  // Y lo que se le contesta al aparato no lleva nada más que eso.
  const crudo = JSON.stringify(sitios)
  assert.equal(crudo.includes('hunter2'), false, 'ni un valor guardado')
  assert.equal(crudo.includes('sandrade'), false, 'ni un nombre de usuario')
  assert.equal(/"id"/.test(crudo), false, 'ni un id')
  assert.equal(net.visto.every(m => !JSON.stringify(m).includes('hunter2')), true)
})

test('sitios: sin sitio propio, la entrada cuenta como «en cualquier sitio»', async () => {
  const { remota, local } = await montar()
  await local.put({ type: 'data', title: 'suelta', fields: [{ label: 'Alias', value: 'x' }] })
  const sitios = await remota.sites()
  assert.equal(sitios[sitios.length - 1].site, '', 'y va la última')
  assert.equal(sitios[sitios.length - 1].count, 1)
})

test('sitios: `list` sigue prohibido — esto no lo sustituye', async () => {
  const { remota } = await montar()
  await assert.rejects(() => remota.list())
})
