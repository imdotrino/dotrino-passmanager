// LOS RESÚMENES: comparar sin abrir, y sin dos métodos.
//
// Es lo que permite decir «esto que escribiste ya está guardado igual» sin sacar el valor
// de la bóveda y sin pedir una autorización. Lo que se prueba aquí es lo que lo hace
// seguro: que sea el mismo camino para un campo público y para uno privado, que el nonce
// cambie en cada respuesta, y que un resumen no valga para nada más.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { LocalVault } from '../src/vault/local.js'
import { makeVaultKey, makeNonce, fieldHasher } from '../src/crypto.js'
import { entryFieldValues } from '../src/fields.js'

async function boveda () {
  const mem = new Map()
  const v = new LocalVault({
    async get (k) { return mem.get(k) },
    async set (k, val) { mem.set(k, val) },
  })
  v.unlock(await makeVaultKey())
  await v.put({
    title: 'Salesforce',
    sites: ['salesforce.com'],
    username: 'ana@ejemplo.com',
    secret: 'hunter2',
    fields: [
      { kind: 'tel', label: 'Teléfono', value: '0999111222' },
      { label: 'Número de socio', value: 'SOC-4471', private: true },
    ],
  })
  return v
}

test('resumen: la vista pública trae un resumen por campo, y ningún valor', async () => {
  const [hit] = await (await boveda()).find('https://salesforce.com/')
  assert.ok(hit.nonce, 'sin nonce no hay con qué comparar')
  assert.deepEqual(
    Object.keys(hit.fieldHashes).sort(),
    ['label:Número de socio', 'secret', 'tel', 'username'],
  )
  // Lo que NO puede pasar: que un valor viaje en la vista pública.
  const bulto = JSON.stringify(hit)
  for (const valor of ['hunter2', '0999111222', 'SOC-4471']) {
    assert.equal(bulto.includes(valor), false, `se coló ${valor}`)
  }
  // El usuario sí va, y es a propósito: es el nombre visible de la entrada (§5).
  assert.equal(hit.hint, 'ana@ejemplo.com')
})

test('resumen: UN método para lo público y lo privado', async () => {
  const [hit] = await (await boveda()).find('https://salesforce.com/')
  const hash = await fieldHasher(hit.nonce)
  // El teléfono es público, el número de socio privado y la contraseña ni se enseña: los
  // tres se comprueban igual.
  assert.equal(await hash('tel', '0999111222'), hit.fieldHashes.tel)
  assert.equal(await hash('label:Número de socio', 'SOC-4471'), hit.fieldHashes['label:Número de socio'])
  assert.equal(await hash('secret', 'hunter2'), hit.fieldHashes.secret)
  // Y uno distinto no coincide.
  assert.notEqual(await hash('secret', 'hunter3'), hit.fieldHashes.secret)
})

test('resumen: el nonce cambia en cada respuesta', async () => {
  const v = await boveda()
  const [a] = await v.find('https://salesforce.com/')
  const [b] = await v.find('https://salesforce.com/')
  assert.notEqual(a.nonce, b.nonce, 'el nonce se repitió: los resúmenes serían una huella')
  assert.notEqual(a.fieldHashes.secret, b.fieldHashes.secret,
    'el mismo valor dio el mismo resumen dos veces: sirve para reconocerlo entre respuestas')
})

test('resumen: no sirve para comparar contra otro campo', async () => {
  const v = new LocalVault({
    async get () { return this._x }, async set (_, val) { this._x = val },
  })
  v.unlock(await makeVaultKey())
  // Dos campos con EL MISMO valor: sus resúmenes tienen que ser distintos, o uno serviría
  // para probar el otro.
  await v.put({ title: 'x', sites: ['x.com'], username: 'repetido', secret: 'repetido' })
  const [hit] = await v.find('https://x.com/')
  assert.notEqual(hit.fieldHashes.username, hit.fieldHashes.secret)
})

test('resumen: buscar también los trae, y con su nonce', async () => {
  const [hit] = await (await boveda()).search('salesforce')
  const hash = await fieldHasher(hit.nonce)
  assert.equal(await hash('username', 'ana@ejemplo.com'), hit.fieldHashes.username)
})

test('los campos de una entrada salen todos, públicos y privados', async () => {
  const campos = entryFieldValues({
    username: 'ana',
    secret: 'clave',
    totp: '',
    fields: JSON.stringify([
      { kind: 'tel', label: 'Teléfono', value: '099' },
      { label: 'Socio', value: 'SOC', private: true },
      { label: 'Vacío', value: '' },
    ]),
  })
  assert.deepEqual(campos.map(f => f.key), ['username', 'secret', 'tel', 'label:Socio'])
  // Lo privado NO se queda fuera: privado decide qué se ENSEÑA (§4.2), no qué existe.
  assert.equal(campos.find(f => f.key === 'label:Socio').value, 'SOC')
})

test('un nonce distinto no valida nada', async () => {
  const [hit] = await (await boveda()).find('https://salesforce.com/')
  const otro = await fieldHasher(makeNonce())
  assert.notEqual(await otro('secret', 'hunter2'), hit.fieldHashes.secret)
})
