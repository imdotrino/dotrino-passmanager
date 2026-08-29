// La puerta, y la bóveda que la lleva puesta.
//
// Importa que estas dos cosas se prueben juntas: la razón de que `GuardedVault` exista es
// que la bóveda de dentro de la extensión se comporte como la de fuera, y eso solo es
// cierto mientras las dos usen la misma `ApprovalGate` con el mismo criterio.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ApprovalGate } from '../src/vault/approval.js'
import { GuardedVault } from '../src/vault/guard.js'
import { LocalVault } from '../src/vault/local.js'
import { CODES } from '../src/vault/errors.js'
import { makeVaultKey } from '../src/crypto.js'

async function boveda () {
  const mem = new Map()
  const v = new LocalVault({
    async get (k) { return mem.get(k) },
    async set (k, val) { mem.set(k, val) },
  })
  v.unlock(await makeVaultKey())
  await v.put({ title: 'Salesforce', sites: ['salesforce.com'], username: 'ana', secret: 'hunter2' })
  return v
}

function conPuerta (inner, opts = {}) {
  const pedidas = []
  const gate = new ApprovalGate({
    ask: (req) => { pedidas.push(req); return opts.di !== false },
    remember: !!opts.remember,
    scope: opts.scope,
  })
  return { v: new GuardedVault(inner, { gate }), pedidas, gate }
}

test('puerta: sin el sí, la credencial no sale', async () => {
  const { v, pedidas } = conPuerta(await boveda(), { di: false })
  const [hit] = await v.find('https://salesforce.com/')
  await assert.rejects(() => v.get(hit.id), e => e.code === CODES.NOT_APPROVED)
  assert.equal(pedidas.length, 1)
  assert.equal(pedidas[0].op, 'get')
})

test('puerta: con el sí, sale entera', async () => {
  const { v } = conPuerta(await boveda())
  const [hit] = await v.find('https://salesforce.com/')
  assert.equal((await v.get(hit.id)).secret, 'hunter2')
})

test('puerta: buscar y guardar NO preguntan — solo lo que saca lo privado', async () => {
  const { v, pedidas } = conPuerta(await boveda())
  await v.find('https://salesforce.com/')
  await v.search('sales')
  await v.put({ title: 'Otra', sites: ['otra.com'], secret: 'x' })
  assert.deepEqual(pedidas, [], 'preguntó por algo que no saca una contraseña')
})

test('puerta: la bóveda se anuncia como una que pide permiso', async () => {
  const inner = await boveda()
  assert.equal(inner.capabilities.needsApproval, false)
  const { v } = conPuerta(inner)
  assert.equal(v.capabilities.needsApproval, true)
  // Lo demás de la bóveda de dentro sigue siendo verdad.
  assert.equal(v.capabilities.canWrite, true)
})

test('puerta: dos peticiones a la vez producen UN aviso', async () => {
  const inner = await boveda()
  const [hit] = await inner.find('https://salesforce.com/')
  let sueltan = null
  const espera = new Promise(r => { sueltan = r })
  let veces = 0
  const gate = new ApprovalGate({ ask: async () => { veces++; await espera; return true } })
  const v = new GuardedVault(inner, { gate })

  const dos = Promise.all([v.get(hit.id), v.get(hit.id)])
  await new Promise(r => setTimeout(r, 5))
  assert.equal(veces, 1, 'preguntó dos veces por lo mismo')
  sueltan()
  const [a, b] = await dos
  assert.equal(a.secret, 'hunter2')
  assert.equal(b.secret, 'hunter2')
})

test('puerta: un NO no queda recordado como un SÍ', async () => {
  const inner = await boveda()
  const [hit] = await inner.find('https://salesforce.com/')
  let veces = 0
  const gate = new ApprovalGate({ ask: async () => { veces++; return false }, scope: () => 'este', remember: true })
  const v = new GuardedVault(inner, { gate })
  await assert.rejects(() => v.get(hit.id), e => e.code === CODES.NOT_APPROVED)
  await assert.rejects(() => v.get(hit.id), e => e.code === CODES.NOT_APPROVED)
  assert.equal(veces, 2, 'la negativa quedó recordada')
})

test('puerta: `remember` es lo único que separa el aparato de la extensión', async () => {
  const inner = await boveda()
  const [hit] = await inner.find('https://salesforce.com/')

  // Como el daemon: se recuerda por aparato, así que la segunda no pregunta.
  let comoDaemon = 0
  const g1 = new ApprovalGate({ ask: async () => { comoDaemon++; return true }, scope: () => 'PUB-EXT' })
  const v1 = new GuardedVault(inner, { gate: g1 })
  await v1.get(hit.id); await v1.get(hit.id)
  assert.equal(comoDaemon, 1)

  // Como la extensión: aquí el que pide es este mismo navegador, así que se pregunta
  // cada vez mientras el proceso no esté asentado (dueño, 2026-08-29).
  let comoExtension = 0
  const g2 = new ApprovalGate({ ask: async () => { comoExtension++; return true }, remember: false })
  const v2 = new GuardedVault(inner, { gate: g2 })
  await v2.get(hit.id); await v2.get(hit.id)
  assert.equal(comoExtension, 2)
})

test('puerta: retirar lo aprobado sin apagar la bóveda', async () => {
  const inner = await boveda()
  const [hit] = await inner.find('https://salesforce.com/')
  let veces = 0
  const gate = new ApprovalGate({ ask: async () => { veces++; return true }, scope: () => 'PUB-EXT' })
  const v = new GuardedVault(inner, { gate })
  await v.get(hit.id)
  assert.equal(gate.granted('PUB-EXT'), true)
  gate.revoke('PUB-EXT')
  await v.get(hit.id)
  assert.equal(veces, 2)
})
