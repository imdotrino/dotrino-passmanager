// BUSCAR POR SITIO DESDE LA CONSOLA (`SealedStore.inspect`). Lo que tiene que cumplir:
//   1. encuentra por dominio (y por subdominio) y por passkey;
//   2. dice quién debería poder abrirla y no puede;
//   3. NO ESCRIBE NADA: el almacén queda idéntico, byte a byte;
//   4. sin huellas no contesta: no es un `list` por otra puerta.

import test from 'node:test'
import assert from 'node:assert/strict'
import { openWrap, decryptWithCek } from '@dotrino/identity/content'
import { SealedStore, KEY, RECOVERY } from '../src/sealed/store.js'
import { buildSealedEntry, buildProfileKey, openSealedView } from '../src/sealed/device.js'
import { profileKeys, siteHashes, passkeyRpHashes } from '../src/sealed/keys.js'

const ECDH = { name: 'ECDH', namedCurve: 'P-256' }
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' }
const SIGN = { name: 'ECDSA', hash: { name: 'SHA-256' } }
function canon (v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']'
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}'
}
async function encPair () {
  const enc = await crypto.subtle.generateKey(ECDH, true, ['deriveBits'])
  const j = await crypto.subtle.exportKey('jwk', enc.publicKey)
  return {
    encPub: JSON.stringify({ kty: j.kty, crv: j.crv, x: j.x, y: j.y }),
    openSealed: async ({ wrap, envelope }) => decryptWithCek({ cek: await openWrap({ wrap, myEncPrivateKey: enc.privateKey }), envelope })
  }
}
async function device () {
  const sig = await crypto.subtle.generateKey(ECDSA, true, ['sign', 'verify'])
  const pub = JSON.stringify(await crypto.subtle.exportKey('jwk', sig.publicKey))
  const e = await encPair()
  return {
    pub, ...e, verifyKey: sig.publicKey,
    author: {
      publickey: pub,
      async sign (body) {
        const s = await crypto.subtle.sign(SIGN, sig.privateKey, new TextEncoder().encode(canon(body)))
        return { signature: Buffer.from(new Uint8Array(s)).toString('base64') }
      }
    }
  }
}

async function setup () {
  const uno = await device(); const tarde = await device()
  const rec = await encPair()
  const mem = new Map()
  const store = { async get (k) { return mem.get(k) }, async set (k, v) { mem.set(k, v) } }
  const miembros = [uno]
  const sealed = new SealedStore(store, {
    recipients: () => miembros.map((d) => ({ pub: d.pub, encPub: d.encPub })),
    verifyAuthor: async ({ body, author }) => author.pub === uno.pub && crypto.subtle.verify(SIGN, uno.verifyKey,
      Uint8Array.from(Buffer.from(author.sig, 'base64')), new TextEncoder().encode(canon(body)))
  })
  const recipients = { recoveryPub: rec.encPub, main: [{ pub: uno.pub, encPub: uno.encPub }], passkeys: [{ pub: uno.pub, encPub: uno.encPub }] }
  const pk = await buildProfileKey({ recipients })
  await sealed.setProfile({ envelope: pk.envelope, wraps: pk.wraps })
  const keys = await profileKeys(pk.base)
  await sealed.putSealed(await buildSealedEntry({
    plain: { id: 'a', type: 'login', title: 'Correo', sites: ['example.com'], username: 'ana', secret: 'secreto-largo' },
    keys, recipients, author: uno.author
  }))
  const conPasskey = await buildSealedEntry({
    plain: { id: 'b', type: 'login', title: 'Banco', sites: [], username: 'ana', webauthn: { rpId: 'banco.com', credentialId: 'c1', userHandle: 'u', privateKey: 'PRIV' } },
    keys, recipients, author: uno.author
  })
  await sealed.putSealed(conPasskey)
  return { sealed, mem, keys, uno, tarde, rec, miembros }
}

test('encuentra por dominio, por subdominio y por passkey, y abre solo la vista', async () => {
  const { sealed, keys, rec } = await setup()
  const porDominio = await sealed.inspect({ idx: await siteHashes(keys.kidx, 'example.com') })
  assert.deepEqual(porDominio.map((x) => x.id), ['a'])
  const porUrl = await sealed.inspect({ idx: await siteHashes(keys.kidx, 'https://login.example.com/x') })
  assert.deepEqual(porUrl.map((x) => x.id), ['a'], 'un subdominio debería encontrar la del dominio')
  const porPk = await sealed.inspect({ idx: await siteHashes(keys.kidx, 'banco.com'), rp: await passkeyRpHashes(keys.kidx, 'banco.com') })
  assert.deepEqual(porPk.map((x) => [x.id, x.match, x.passkey]), [['b', 'passkey', true]])
  assert.deepEqual(await sealed.inspect({ idx: await siteHashes(keys.kidx, 'otro.com') }), [])

  const hit = porDominio[0]
  assert.equal(hit.recovery, true)
  assert.deepEqual(hit.missing, [])
  const vista = await openSealedView({ view: hit.view, wrap: hit.recoveryWrap, id: hit.id, openSealed: rec.openSealed })
  assert.equal(vista.title, 'Correo')
  assert.equal(vista.hint, 'ana')
  assert.ok(!JSON.stringify(hit).includes('secreto-largo'))
  assert.ok(!('fields' in hit), 'de inspect no salen sobres de campos')
})

test('dice quién falta: un aparato que entró después y aún no tiene envoltura', async () => {
  const { sealed, keys, uno, tarde, miembros } = await setup()
  miembros.push(tarde)
  const [hit] = await sealed.inspect({ idx: await siteHashes(keys.kidx, 'example.com') })
  assert.deepEqual(hit.holders, [uno.pub])
  assert.deepEqual(hit.missing, [tarde.pub])
})

test('NO ESCRIBE NADA: el almacén queda idéntico', async () => {
  const { sealed, mem, keys, tarde, miembros } = await setup()
  miembros.push(tarde)
  const antes = JSON.stringify(mem.get(KEY))
  let escrituras = 0
  const espia = new SealedStore({ get: async (k) => mem.get(k), set: async () => { escrituras++ } }, {
    recipients: () => miembros.map((d) => ({ pub: d.pub, encPub: d.encPub })), verifyAuthor: async () => false
  })
  await espia.inspect({ idx: await siteHashes(keys.kidx, 'example.com'), rp: await passkeyRpHashes(keys.kidx, 'banco.com') })
  await sealed.inspect({ idx: await siteHashes(keys.kidx, 'example.com') })
  assert.equal(escrituras, 0)
  assert.equal(JSON.stringify(mem.get(KEY)), antes)
})

test('sin huellas no contesta nada', async () => {
  const { sealed } = await setup()
  assert.deepEqual(await sealed.inspect({}), [])
  assert.deepEqual(await sealed.inspect({ idx: [], rp: [] }), [])
})

test('una entrada sin #recovery se ve igual, y lo dice', async () => {
  const { sealed, mem, keys } = await setup()
  const s = mem.get(KEY)
  for (const g of s.keyring) delete g.wraps[RECOVERY]
  const [hit] = await sealed.inspect({ idx: await siteHashes(keys.kidx, 'example.com') })
  assert.equal(hit.recovery, false)
  assert.equal(hit.recoveryWrap, null)
})
