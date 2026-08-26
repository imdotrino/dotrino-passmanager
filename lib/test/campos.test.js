import { test } from 'node:test'
import assert from 'node:assert/strict'

import { LocalVault } from '../src/vault/local.js'
import { makeVaultKey } from '../src/crypto.js'
import { matchEntry, MATCH } from '../src/match.js'
import { sealEntry, openEntry } from '../src/model.js'
import { normalizeFields, isCrossDomain, fieldOfKind, fieldValue } from '../src/fields.js'

function memStore () {
  const m = new Map()
  return { async get (k) { return m.get(k) }, async set (k, v) { m.set(k, v) } }
}

const MIS_DATOS = {
  type: 'data',
  title: 'Mis datos',
  // Sin `sites`: sirve en cualquier parte.
  fields: [
    { label: 'Correo', value: 'sandrade@dotrino.com', kind: 'email' },
    { label: 'Teléfono', value: '+593 99 000 0000', kind: 'tel' },
    { label: 'Cédula', value: '1700000000', kind: 'id-number' },
    { label: 'Código del portal', value: '4821' },   // sin kind: se guarda, no se rellena solo
  ],
}

test('campos: cross-domain es NO tener sitios, no un tipo aparte', () => {
  assert.ok(isCrossDomain(MIS_DATOS))
  assert.equal(matchEntry(MIS_DATOS, 'https://cualquier-cosa.com/'), MATCH.ANY)
  assert.equal(matchEntry(MIS_DATOS, 'https://otra.es/registro'), MATCH.ANY)

  // La misma regla vale para cualquier tipo: un login sin sitios también sirve en
  // todas partes, sin tratarlo distinto.
  assert.equal(matchEntry({ type: 'login', sites: [] }, 'https://x.com/'), MATCH.ANY)

  // Atarlo a un dominio es ponerle sitios, y entonces solo vale ahí.
  const soloAhi = { ...MIS_DATOS, sites: ['tramites.gob.ec'] }
  assert.equal(matchEntry(soloAhi, 'https://tramites.gob.ec/'), MATCH.EXACT)
  assert.equal(matchEntry(soloAhi, 'https://otra.com/'), MATCH.NONE)

  assert.equal(matchEntry(MIS_DATOS, 'javascript:alert(1)'), MATCH.NONE)
})

test('campos: lo del sitio va SIEMPRE por delante de lo que vale en cualquiera', async () => {
  const v = new LocalVault(memStore())
  v.unlock(await makeVaultKey())
  await v.put({ title: 'Salesforce', sites: ['salesforce.com'], username: 'u', secret: 'hunter2' })
  await v.put(MIS_DATOS)

  assert.deepEqual((await v.find('https://salesforce.com/')).map(e => e.title),
    ['Salesforce', 'Mis datos'])
  assert.deepEqual((await v.find('https://tienda-cualquiera.com/')).map(e => e.title),
    ['Mis datos'])
})

test('campos: van CIFRADOS, y no viajan en la lista', async () => {
  const k = await makeVaultKey()
  const sellada = await sealEntry(k, MIS_DATOS)
  const enDisco = JSON.stringify(sellada)
  for (const dato of ['sandrade@dotrino.com', '+593 99 000 0000', '1700000000', '4821']) {
    assert.ok(!enDisco.includes(dato), `${dato} quedó en claro`)
  }

  const v = new LocalVault(memStore())
  v.unlock(k)
  await v.put(MIS_DATOS)
  const lista = JSON.stringify(await v.find('https://x.com/'))
  assert.ok(!lista.includes('sandrade@dotrino.com'), 'el correo viajó sin pedirlo')
  assert.ok(lista.includes('"hasFields":true'), 'no se sabe que la entrada tiene campos')
})

test('campos: cualquier cosa, con o sin clase, y se abren enteros', async () => {
  const k = await makeVaultKey()
  const abierta = await openEntry(k, await sealEntry(k, MIS_DATOS))
  const campos = JSON.parse(abierta.fields)

  assert.equal(campos.length, 4)
  assert.equal(fieldOfKind({ fields: campos }, 'email').value, 'sandrade@dotrino.com')
  assert.equal(fieldOfKind({ fields: campos }, 'id-number').value, '1700000000')
  assert.equal(fieldValue({ fields: campos }, 'Código del portal'), '4821')
  assert.equal(campos[3].kind, undefined)
  assert.equal(fieldOfKind({ fields: campos }, 'no-existe'), null)
})

test('campos: normalizar tira la basura y no inventa clases', () => {
  const limpio = normalizeFields([
    { label: ' Correo ', value: 'a@b.com', kind: 'email' },
    { label: 'X', value: 1234 },
    { label: 'Raro', value: 'v', kind: 'no-es-una-clase' },
    null,
    { label: '', value: '' },
  ])
  assert.equal(limpio.length, 3)
  assert.equal(limpio[0].label, 'Correo')
  assert.equal(limpio[1].value, '1234')
  assert.equal(limpio[2].kind, undefined)
})

test('campos: un login también puede llevarlos (el PIN junto a la contraseña)', async () => {
  const v = new LocalVault(memStore())
  v.unlock(await makeVaultKey())
  const { id } = await v.put({
    title: 'Banco', sites: ['banco.com.ec'], username: 'seyacat', secret: 's3cr3t',
    fields: [{ label: 'PIN', value: '4821' }],
  })
  const abierta = await v.get(id)
  assert.equal(abierta.secret, 's3cr3t')
  assert.equal(fieldValue({ fields: JSON.parse(abierta.fields) }, 'PIN'), '4821')
})
