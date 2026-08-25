import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makeVaultKey, sealValue, openValue, fieldTag } from '../src/crypto.js'
import { sealEntry, openEntry, publicView, maskUsername } from '../src/model.js'
import { matchSite, hostOf, registrableDomain, findForUrl, MATCH } from '../src/match.js'
import { totpNow, parseOtpauth, normalizeOtpauth, base32Decode } from '../src/totp.js'
import { importAuto, parseCsv } from '../src/import.js'
import { LocalVault } from '../src/vault/local.js'
import { RemoteVault } from '../src/vault/remote.js'
import { CODES } from '../src/vault/errors.js'

function memStore () {
  const m = new Map()
  return { async get (k) { return m.get(k) }, async set (k, v) { m.set(k, v) } }
}

test('cifrado: el AAD ata el criptograma a su entrada y a su campo', async () => {
  const k = await makeVaultKey()
  const sealed = await sealValue(k, 'hunter2', fieldTag('a', 'secret'))
  assert.equal(await openValue(k, sealed, fieldTag('a', 'secret')), 'hunter2')
  await assert.rejects(() => openValue(k, sealed, fieldTag('b', 'secret')))
  await assert.rejects(() => openValue(k, sealed, fieldTag('a', 'totp')))
})

test('modelo: lo sensible no queda en claro en lo que se guarda', async () => {
  const k = await makeVaultKey()
  const sealed = await sealEntry(k, {
    title: 'Salesforce', sites: ['salesforce.com'],
    username: 'sandrade@dotrino.com', secret: 'hunter2', notes: 'nota privada',
  })
  const enDisco = JSON.stringify(sealed)
  for (const secreto of ['hunter2', 'sandrade@dotrino.com', 'nota privada']) {
    assert.ok(!enDisco.includes(secreto), `${secreto} quedó en claro`)
  }
  // Los sitios sí van en claro, y es deliberado (DISENO §5).
  assert.ok(enDisco.includes('salesforce.com'))

  const abierta = await openEntry(k, sealed)
  assert.equal(abierta.secret, 'hunter2')
  assert.equal(abierta.username, 'sandrade@dotrino.com')
})

test('modelo: la vista pública no lleva secretos', async () => {
  const k = await makeVaultKey()
  const sealed = await sealEntry(k, { title: 'X', sites: ['x.com'], secret: 'hunter2' })
  const v = JSON.stringify(publicView(sealed, maskUsername('sandrade@dotrino.com')))
  assert.ok(!v.includes('hunter2'))
  assert.ok(!v.includes('sandrade@dotrino.com'))
  assert.ok(v.includes('s•••e@dotrino.com'))
})

test('emparejamiento: no entrega credenciales a un sitio que solo se PARECE', () => {
  assert.equal(matchSite('salesforce.com', hostOf('https://salesforce.com/')), MATCH.EXACT)
  assert.equal(matchSite('salesforce.com', hostOf('https://login.salesforce.com/')), MATCH.SUBDOMAIN)
  // Los dos clásicos de suplantación: prefijo y sufijo.
  assert.equal(matchSite('salesforce.com', hostOf('https://evil-salesforce.com/')), MATCH.NONE)
  assert.equal(matchSite('salesforce.com', hostOf('https://salesforce.com.evil.io/')), MATCH.NONE)
  assert.equal(matchSite('*.force.com', hostOf('https://force.com.evil.io/')), MATCH.NONE)
  // Esquemas que no son web no emparejan con nada.
  assert.equal(hostOf('javascript:alert(1)'), '')
  assert.equal(hostOf('file:///etc/passwd'), '')
})

test('emparejamiento: sufijos de dos etiquetas no juntan a dos empresas distintas', () => {
  assert.equal(registrableDomain('banco.com.ec'), 'banco.com.ec')
  assert.equal(registrableDomain('www.banco.com.ec'), 'banco.com.ec')
  assert.equal(matchSite('banco.com.ec', hostOf('https://otro.com.ec/')), MATCH.NONE)
})

test('emparejamiento: ordena el exacto por delante del laxo', () => {
  const entries = [
    { id: 'laxo', sites: ['empresa.com'], updatedAt: 2 },
    { id: 'exacto', sites: ['login.empresa.com'], updatedAt: 1 },
  ]
  assert.deepEqual(findForUrl(entries, 'https://login.empresa.com/').map(x => x.entry.id),
    ['exacto', 'laxo'])
})

test('TOTP: vectores del RFC 6238', async () => {
  const uri = 'otpauth://totp/t?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=8&algorithm=SHA1'
  for (const [t, esperado] of [[59, '94287082'], [1111111109, '07081804'], [1234567890, '89005924']]) {
    assert.equal((await totpNow(uri, t * 1000)).code, esperado)
  }
})

test('TOTP: acepta el secreto pelado que exporta Bitwarden', async () => {
  const conUri = await totpNow('otpauth://totp/x?secret=JBSWY3DPEHPK3PXP', 0)
  const pelado = await totpNow('JBSWY3DPEHPK3PXP', 0)
  assert.equal(pelado.code, conUri.code)
  assert.ok(normalizeOtpauth('JBSWY3DPEHPK3PXP').startsWith('otpauth://totp/'))
})

test('TOTP: rechaza lo que no entiende en vez de dar un código cualquiera', () => {
  assert.throws(() => parseOtpauth('otpauth://totp/x'), /secret/)
  assert.throws(() => base32Decode('no-es-base32!'))
})

test('CSV: comas, comillas y saltos de línea dentro de un campo', () => {
  const rows = parseCsv('a,b\n"con, coma","con ""comillas"" y\nsalto"\n')
  assert.deepEqual(rows[1], ['con, coma', 'con "comillas" y\nsalto'])
})

test('importar: detecta Chrome, 1Password y Bitwarden', () => {
  const chrome = importAuto('name,url,username,password,note\nX,https://x.com/,u,p,\n')
  assert.equal(chrome.format, 'chrome-csv')
  assert.deepEqual(chrome.entries[0].sites, ['x.com'])

  const onep = importAuto('Title,Url,Username,Password,OTPAuth,Notes\nB,https://b.com/,u,p,otpauth://totp/x?secret=JBSWY3DPEHPK3PXP,\n')
  assert.equal(onep.format, '1password-csv')
  assert.ok(onep.entries[0].totp.startsWith('otpauth://'))

  const bw = importAuto(JSON.stringify({ items: [{ type: 1, name: 'G', login: { username: 'u', password: 'p', uris: [{ uri: 'https://g.com' }] } }] }))
  assert.equal(bw.format, 'bitwarden-json')
  assert.deepEqual(bw.entries[0].sites, ['g.com'])
})

test('importar: un export cifrado se dice, no se importa a medias', () => {
  assert.throws(() => importAuto(JSON.stringify({ encrypted: true })), e => e.code === 'encrypted-export')
  assert.throws(() => importAuto('foo,bar\n1,2'), e => e.code === 'unknown-format')
})

test('bóveda local: cerrada no responde nada', async () => {
  const v = new LocalVault(memStore())
  await assert.rejects(() => v.list(), e => e.code === CODES.LOCKED)
  await assert.rejects(() => v.find('https://x.com'), e => e.code === CODES.LOCKED)
})

test('bóveda local: guardar, emparejar y abrir una sola', async () => {
  const v = new LocalVault(memStore())
  v.unlock(await makeVaultKey())
  await v.put({ title: 'Salesforce', sites: ['salesforce.com'], username: 'sandrade@dotrino.com', secret: 'hunter2' })
  await v.put({ title: 'Otro', sites: ['otro.com'], username: 'u', secret: 'x' })

  const hits = await v.find('https://login.salesforce.com/')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].hint, 's•••e@dotrino.com')
  assert.ok(!JSON.stringify(hits).includes('hunter2'))

  assert.equal((await v.get(hits[0].id)).secret, 'hunter2')
  await assert.rejects(() => v.get('no-existe'), e => e.code === CODES.NOT_FOUND)
})

test('bóveda local: actualizar conserva la fecha de creación', async () => {
  const v = new LocalVault(memStore())
  v.unlock(await makeVaultKey())
  const { id } = await v.put({ title: 'X', sites: ['x.com'], secret: 'a' })
  const creada = (await v.get(id)).createdAt
  await v.put({ id, title: 'X', sites: ['x.com'], secret: 'b' })
  const tras = await v.get(id)
  assert.equal(tras.secret, 'b')
  assert.equal(tras.createdAt, creada)
  assert.equal((await v.list()).length, 1)
})

test('caché de la extensión: lee pero no escribe', async () => {
  const v = new LocalVault(memStore(), { readOnly: true })
  v.unlock(await makeVaultKey())
  await assert.rejects(() => v.put({ title: 'X', sites: ['x.com'] }), e => e.code === CODES.READ_ONLY)
  await assert.rejects(() => v.remove('x'), e => e.code === CODES.READ_ONLY)
  assert.equal(v.capabilities.canWrite, false)
})

test('bóveda remota: pide de a una y NO puede listar', async () => {
  const pedidos = []
  const v = new RemoteVault({ async request (op, payload) { pedidos.push(op); return { op, payload } } })
  await v.find('https://x.com/')
  await v.get('id-1')
  assert.deepEqual(pedidos, ['find', 'get'])
  // Si pudiera listar, el "pide de a una" sería decorativo.
  await assert.rejects(() => v.list(), e => e.code === CODES.NO_KEY)
  assert.equal(v.capabilities.canList, false)
})

test('bóveda remota: sin bóveda al otro lado, un código, no un texto', async () => {
  const v = new RemoteVault({ async request () { throw new Error('socket muerto') } })
  await assert.rejects(() => v.get('x'), e => e.code === CODES.UNREACHABLE)
})
