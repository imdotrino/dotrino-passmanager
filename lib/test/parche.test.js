// CAMBIAR UN CAMPO SIN PERDER EL RESTO, y sin sacar nada de la bóveda.
//
// Es la prueba del fallo del 2026-08-29: reemplazar un dato público de una entrada que
// tenía datos privados pedía autorización y dejaba la entrada a medias. La causa era que
// guardar se hacía leyendo la entrada entera, fusionando fuera y volviendo a escribirla:
// si la lectura no salía, el `put` de detrás escribía lo que había podido leer, que era
// nada.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { LocalVault } from '../src/vault/local.js'
import { GuardedVault } from '../src/vault/guard.js'
import { ApprovalGate } from '../src/vault/approval.js'
import { makeVaultKey } from '../src/crypto.js'
import { CODES } from '../src/vault/errors.js'

async function boveda () {
  const mem = new Map()
  const v = new LocalVault({
    async get (k) { return mem.get(k) },
    async set (k, val) { mem.set(k, val) },
  })
  v.unlock(await makeVaultKey())
  const { id } = await v.put({
    title: 'Mi sitio',
    sites: ['sitio.com'],
    username: 'ana@ejemplo.com',
    secret: 'hunter2',
    totp: 'JBSWY3DPEHPK3PXP',
    notes: 'la de la tarjeta azul',
    fields: [
      { label: 'Nombre', value: 'Ana' },
      { kind: 'tel', label: 'Teléfono', value: '0999111222' },
      { label: 'Cédula', value: '1700123456', private: true },
    ],
  })
  return { v, id }
}

const campos = (open) => JSON.parse(open.fields || '[]')
const campo = (open, label) => campos(open).find(f => f.label === label)

test('parche: cambiar un campo público deja TODO lo demás intacto', async () => {
  const { v, id } = await boveda()
  await v.patch(id, { fields: [{ label: 'Nombre', value: 'Ana María' }] })

  const open = await v.get(id)
  assert.equal(campo(open, 'Nombre').value, 'Ana María')
  // Lo que no se tocó, entero. Esto es lo que se perdía.
  assert.equal(open.username, 'ana@ejemplo.com')
  assert.equal(open.secret, 'hunter2')
  assert.equal(open.totp, 'JBSWY3DPEHPK3PXP')
  assert.equal(open.notes, 'la de la tarjeta azul')
  assert.equal(campo(open, 'Teléfono').value, '0999111222')
  assert.equal(campo(open, 'Cédula').value, '1700123456')
  assert.equal(campo(open, 'Cédula').private, true, 'la marca de privado se perdió')
  assert.equal(open.title, 'Mi sitio')
  assert.deepEqual(open.sites, ['sitio.com'])
})

test('parche: no duplica el campo ni le cambia el nombre', async () => {
  const { v, id } = await boveda()
  // La página lo llama de otra forma: la etiqueta que ya tenía manda, o sería otro campo.
  await v.patch(id, { fields: [{ label: 'nombre completo', kind: undefined, value: 'Ana Ruiz' }] })
  const open = await v.get(id)
  const conNombre = campos(open).filter(f => /nombre/i.test(f.label))
  assert.equal(conNombre.length, 2, 'una etiqueta distinta es un campo distinto')
  assert.equal(campo(open, 'Nombre').value, 'Ana', 'y el que ya estaba no se toca')
})

test('parche: reemplazar un campo privado NO le quita la marca', async () => {
  const { v, id } = await boveda()
  await v.patch(id, { fields: [{ label: 'Cédula', value: '1700999888' }] })
  const open = await v.get(id)
  assert.equal(campo(open, 'Cédula').value, '1700999888')
  assert.equal(campo(open, 'Cédula').private, true,
    'quitar lo privado tiene que ser un acto, no un descuido al guardar encima')
})

test('parche: la entrada mantiene su id y su fecha de creación', async () => {
  const { v, id } = await boveda()
  const antes = await v.get(id)
  await new Promise(r => setTimeout(r, 5))
  await v.patch(id, { fields: [{ label: 'Nombre', value: 'Otra' }] })
  const open = await v.get(id)
  assert.equal(open.id, id)
  assert.equal(open.createdAt, antes.createdAt)
  assert.ok(open.updatedAt >= antes.updatedAt)
})

test('parche: sumar el sitio solo si la entrada ya tenía alguno', async () => {
  const { v, id } = await boveda()
  await v.patch(id, { fields: [{ label: 'Nombre', value: 'Ana' }], addSite: 'otro.com' })
  assert.deepEqual((await v.get(id)).sites, ['sitio.com', 'otro.com'])

  // Una entrada SIN sitios sirve en cualquier parte (§4.2): guardar en ella desde un
  // formulario no puede atarla a ese sitio.
  const suelta = await v.put({ title: 'Datos', sites: [], fields: [{ label: 'Nombre', value: 'Ana' }] })
  await v.patch(suelta.id, { fields: [{ label: 'Nombre', value: 'Ana R.' }], addSite: 'tienda.com' })
  assert.deepEqual((await v.get(suelta.id)).sites, [])
})

test('parche: una entrada que no existe NO se crea', async () => {
  const { v } = await boveda()
  await assert.rejects(
    () => v.patch('no-existe', { fields: [{ label: 'x', value: 'y' }] }),
    e => e.code === CODES.NOT_FOUND,
  )
})

// --- la puerta: solo lo PRIVADO pregunta --------------------------------------

function conPuerta (inner, responde = true) {
  const pedidas = []
  const gate = new ApprovalGate({
    ask: (req) => { pedidas.push(req); return responde },
    remember: false,
  })
  return { v: new GuardedVault(inner, { gate }), pedidas }
}

test('puerta: rellenar un dato PÚBLICO no pregunta nada', async () => {
  const { v: inner, id } = await boveda()
  const { v, pedidas } = conPuerta(inner)
  const open = await v.get(id, { keys: ['Nombre'].map(() => 'label:Nombre') })
  assert.deepEqual(pedidas, [], 'preguntó por un dato público')
  assert.equal(campo(open, 'Nombre').value, 'Ana')
})

test('puerta: y lo que devuelve es SOLO lo pedido', async () => {
  const { v: inner, id } = await boveda()
  const { v } = conPuerta(inner)
  const open = await v.get(id, { keys: ['label:Nombre'] })
  assert.equal(open.secret, '', 'la contraseña salió sin que nadie la pidiera')
  assert.equal(open.totp, '')
  assert.equal(open.notes, '')
  assert.equal(open.username, '')
  assert.equal(campos(open).length, 1)
})

test('puerta: rellenar un dato PRIVADO sí pregunta', async () => {
  const { v: inner, id } = await boveda()
  const { v, pedidas } = conPuerta(inner)
  await v.get(id, { keys: ['label:Cédula'] })
  assert.equal(pedidas.length, 1)
  assert.deepEqual(pedidas[0].payload.keys, ['label:Cédula'])
})

test('puerta: la contraseña es privada aunque nadie la marque', async () => {
  const { v: inner, id } = await boveda()
  const { v, pedidas } = conPuerta(inner)
  await v.get(id, { keys: ['secret'] })
  assert.equal(pedidas.length, 1)
})

test('puerta: sin decir qué se quiere, se pide todo y se autoriza todo', async () => {
  const { v: inner, id } = await boveda()
  const { v, pedidas } = conPuerta(inner)
  const open = await v.get(id)
  assert.equal(pedidas.length, 1)
  assert.equal(open.secret, 'hunter2')
})

test('puerta: sin el sí, ni el dato privado ni ningún otro', async () => {
  const { v: inner, id } = await boveda()
  const { v } = conPuerta(inner, false)
  await assert.rejects(() => v.get(id, { keys: ['label:Cédula'] }), e => e.code === CODES.NOT_APPROVED)
})

test('puerta: guardar no pregunta, y por eso no puede perder nada', async () => {
  const { v: inner, id } = await boveda()
  // La puerta dice que NO a todo: aun así, reemplazar tiene que funcionar y conservar.
  const { v, pedidas } = conPuerta(inner, false)
  await v.patch(id, { fields: [{ label: 'Nombre', value: 'Ana María' }] })
  assert.deepEqual(pedidas, [], 'guardar pidió autorización')

  const open = await inner.get(id)
  assert.equal(campo(open, 'Nombre').value, 'Ana María')
  assert.equal(open.secret, 'hunter2', 'la entrada quedó a medias')
  assert.equal(campo(open, 'Cédula').value, '1700123456')
})
