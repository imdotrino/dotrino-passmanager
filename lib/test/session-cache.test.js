import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionCache } from '../src/session-cache.js'

function memStore () {
  const m = new Map()
  return { async get (k) { return m.get(k) }, async set (k, v) { m.set(k, v) }, _m: m }
}

const CRED = { id: 'a', title: 'Salesforce', username: 'sandrade@dotrino.com', secret: 'hunter2' }

test('caché de sesión: lo entregado se recuerda, lo no pedido no está', async () => {
  const c = new SessionCache(memStore())
  assert.equal(await c.get('a'), null)
  await c.put('a', CRED)
  assert.equal((await c.get('a')).secret, 'hunter2')
  assert.equal(await c.get('otra'), null)
})

test('caché de sesión: caduca, y la caducada se tira al pasar por ella', async () => {
  let ahora = 1_000_000
  const store = memStore()
  const c = new SessionCache(store, { ttlMs: 60_000, now: () => ahora })
  await c.put('a', CRED)

  ahora += 59_000
  assert.ok(await c.get('a'), 'caducó antes de tiempo')

  ahora += 2_000
  assert.equal(await c.get('a'), null, 'no caducó')
  assert.equal(await c.size(), 0, 'la caducada se quedó ocupando sitio')
})

test('caché de sesión: lo que la bóveda marca alwaysAsk NO se guarda', async () => {
  const c = new SessionCache(memStore())
  assert.equal(await c.put('banco', { ...CRED, alwaysAsk: true }), false)
  assert.equal(await c.get('banco'), null)
})

test('caché de sesión: olvidar una, y olvidarlo todo', async () => {
  const c = new SessionCache(memStore())
  await c.put('a', CRED)
  await c.put('b', { ...CRED, id: 'b' })

  await c.forget('a')
  assert.equal(await c.get('a'), null)
  assert.ok(await c.get('b'))

  await c.forget()
  assert.equal(await c.size(), 0)
})

test('caché de sesión: no guarda nada si la bóveda no entregó nada', async () => {
  const c = new SessionCache(memStore())
  assert.equal(await c.put('a', null), false)
  assert.equal(await c.size(), 0)
})

test('alwaysAsk viaja desde la bóveda hasta la caché sin perderse por el camino', async () => {
  const { LocalVault } = await import('../src/vault/local.js')
  const { makeVaultKey } = await import('../src/crypto.js')

  const m = new Map()
  const v = new LocalVault({ async get (k) { return m.get(k) }, async set (k, x) { m.set(k, x) } })
  v.unlock(await makeVaultKey())
  const { id } = await v.put({ title: 'Banco', sites: ['banco.com.ec'], secret: 's3cr3t', alwaysAsk: true })

  // Sobrevive al sellado y al descifrado...
  assert.equal((await v.get(id)).alwaysAsk, true)
  // ...y también al viaje por `find`, que es lo que ve quien no tiene la llave.
  assert.equal((await v.find('https://banco.com.ec/'))[0].alwaysAsk, true)

  // Y por lo tanto la caché lo respeta con lo que la bóveda entregó de verdad.
  const c = new SessionCache(memStore())
  assert.equal(await c.put(id, await v.get(id)), false)
})
