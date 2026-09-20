// CONTRASEÑAS SELLADAS POR APARATO (`docs/sealed-passwords.md`).
//
// Lo que se prueba aquí es el cambio de fondo: **la bóveda deja de poder leer**. Antes una
// sola llave suya cifraba todo, vivía en su propio archivo y por lo tanto una copia del
// disco —o el propio demonio con el perfil cerrado— abría todas las contraseñas.
//
// Las invariantes, en orden de importancia:
//
//   1. lo guardado no contiene ningún valor en claro, ni una llave con la que abrirlo;
//   2. un aparato solo abre lo que le envolvieron, y la passkey solo con su permiso;
//   3. los destinatarios son EXACTAMENTE los que dice el acta, con la recuperación siempre;
//   4. una entrada sin firma de un aparato que pueda escribir no entra.

import test from 'node:test'
import assert from 'node:assert/strict'
import { openWrap, decryptWithCek } from '@dotrino/identity/content'
import { SealedStore, SealedError, KEY, RECOVERY } from '../src/sealed/store.js'
import { buildSealedEntry, buildProfileKey, openSealedEntry, openSealedView, entryAuthorBody } from '../src/sealed/device.js'
import { profileKeys, siteIndex } from '../src/sealed/keys.js'
import { PASSKEY_FIELD } from '../src/sealed/entry.js'

const ECDH = { name: 'ECDH', namedCurve: 'P-256' }
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' }
const SIGN = { name: 'ECDSA', hash: { name: 'SHA-256' } }

/** El mismo `canonicalStringify` del ecosistema, en corto: claves ordenadas. */
function canon (v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']'
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}'
}

/** Un aparato: su llave de firma, su llave de cifrado, y con qué abre lo que le sellan. */
async function device (nombre) {
  const sig = await crypto.subtle.generateKey(ECDSA, true, ['sign', 'verify'])
  const enc = await crypto.subtle.generateKey(ECDH, true, ['deriveBits'])
  const pubJwk = await crypto.subtle.exportKey('jwk', sig.publicKey)
  const encJwk = await crypto.subtle.exportKey('jwk', enc.publicKey)
  const pub = JSON.stringify(pubJwk)
  return {
    nombre,
    pub,
    encPub: JSON.stringify({ kty: encJwk.kty, crv: encJwk.crv, x: encJwk.x, y: encJwk.y }),
    verifyKey: sig.publicKey,
    author: {
      publickey: pub,
      async sign (body) {
        const s = await crypto.subtle.sign(SIGN, sig.privateKey, new TextEncoder().encode(canon(body)))
        return { signature: Buffer.from(new Uint8Array(s)).toString('base64') }
      }
    },
    async openSealed ({ wrap, envelope }) {
      const cek = await openWrap({ wrap, myEncPrivateKey: enc.privateKey })
      return decryptWithCek({ cek, envelope })
    }
  }
}

/** La copia de recuperación: una llave de cifrado más, la que abre la frase del perfil. */
async function recovery () {
  const enc = await crypto.subtle.generateKey(ECDH, true, ['deriveBits'])
  const jwk = await crypto.subtle.exportKey('jwk', enc.publicKey)
  return {
    encPub: JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }),
    async openSealed ({ wrap, envelope }) {
      const cek = await openWrap({ wrap, myEncPrivateKey: enc.privateKey })
      return decryptWithCek({ cek, envelope })
    }
  }
}

/** Una bóveda de mentira con su acta: quién tiene `passwords` y quién además `passkeys`. */
async function boveda ({ conPasskeys = [], soloPasswords = [] } = {}) {
  const rec = await recovery()
  const mem = new Map()
  const store = { async get (k) { return mem.get(k) }, async set (k, v) { mem.set(k, v) } }
  const todos = [...conPasskeys, ...soloPasswords]
  const sealed = new SealedStore(store, {
    recipients: (kind) => (kind === 'passkeys' ? conPasskeys : todos).map((d) => ({ pub: d.pub, encPub: d.encPub })),
    // Quien tiene el acta comprueba la firma y que ese aparato pueda escribir.
    verifyAuthor: async ({ body, author }) => {
      const quien = todos.find((d) => d.pub === author.pub)
      if (!quien) return false
      return crypto.subtle.verify(SIGN, quien.verifyKey,
        Uint8Array.from(Buffer.from(author.sig, 'base64')), new TextEncoder().encode(canon(body)))
    }
  })
  const recipients = {
    recoveryPub: rec.encPub,
    main: todos.map((d) => ({ pub: d.pub, encPub: d.encPub })),
    passkeys: conPasskeys.map((d) => ({ pub: d.pub, encPub: d.encPub }))
  }
  return { sealed, store, mem, recipients, rec }
}

/** Una cuenta cualquiera, con su passkey. */
const CUENTA = {
  id: 'e1',
  type: 'login',
  title: 'Correo',
  sites: ['mail.example.com'],
  username: 'ana@example.com',
  secret: 'una contraseña larga de verdad',
  totp: 'JBSWY3DPEHPK3PXP',
  notes: 'la de siempre',
  fields: [{ label: 'socio', value: '12345', kind: 'id-number', private: false }]
}

async function conEntrada (v, dispositivo, plain = CUENTA) {
  const pk = await buildProfileKey({ recipients: v.recipients })
  await v.sealed.setProfile({ envelope: pk.envelope, wraps: pk.wraps })
  const keys = await profileKeys(pk.base)
  const sobre = await buildSealedEntry({ plain, keys, recipients: v.recipients, author: dispositivo.author })
  await v.sealed.putSealed(sobre)
  return { keys, sobre }
}

test('vuelta entera: lo que guarda un aparato lo abre otro, y con los mismos valores', async () => {
  const uno = await device('extensión'); const dos = await device('teléfono')
  const v = await boveda({ conPasskeys: [uno, dos] })
  const { keys } = await conEntrada(v, uno)

  const huella = await siteIndex(keys.kidx, 'mail.example.com')
  const hits = await v.sealed.find({ pub: dos.pub, idx: [huella] })
  assert.equal(hits.length, 1, 'la otra punta no encontró la entrada por su huella')

  const vista = await openSealedView({ ...hits[0], openSealed: dos.openSealed })
  assert.equal(vista.title, 'Correo')
  assert.equal(vista.hint, 'ana@example.com', 'el nombre visible lo escribe quien guarda')
  assert.deepEqual(vista.fieldKeys.sort(), ['id-number', 'secret', 'totp', 'username'])

  const got = await v.sealed.get('e1', { pub: dos.pub })
  const abierta = await openSealedEntry({ got, openSealed: dos.openSealed, view: vista })
  assert.equal(abierta.secret, CUENTA.secret)
  assert.equal(abierta.username, CUENTA.username)
  assert.equal(abierta.totp, CUENTA.totp)
  // `private: false` no se guarda: la marca solo existe cuando está puesta (`normalizeFields`).
  assert.deepEqual(JSON.parse(abierta.fields), [{ label: 'socio', value: '12345', kind: 'id-number' }])
})

test('LA BÓVEDA NO PUEDE LEER: en lo guardado no hay ni un valor ni una llave', async () => {
  const uno = await device('extensión')
  const v = await boveda({ conPasskeys: [uno] })
  await conEntrada(v, uno)

  const crudo = JSON.stringify(v.mem.get(KEY))
  for (const secreto of [CUENTA.secret, CUENTA.username, CUENTA.totp, CUENTA.notes, '12345', 'mail.example.com', 'Correo']) {
    assert.ok(!crudo.includes(secreto), `«${secreto}» está en claro en el disco de la bóveda`)
  }
  // Y lo que sí hay son sobres y envolturas: nada que se abra sin una privada de aparato.
  const s = v.mem.get(KEY)
  assert.ok(s.keyring.length >= 1 && s.entries.length === 1)
  for (const g of s.keyring) {
    assert.ok(g.wraps[RECOVERY], 'una generación sin copia de recuperación nace ilegible')
    for (const w of Object.values(g.wraps)) assert.ok(w.epk && w.iv && w.ct)
  }
})

test('la passkey solo se le envuelve a quien tiene el permiso', async () => {
  const conLlaves = await device('la mía'); const sinLlaves = await device('la prestada')
  const v = await boveda({ conPasskeys: [conLlaves], soloPasswords: [sinLlaves] })
  const plain = {
    ...CUENTA,
    id: 'e2',
    webauthn: { rpId: 'example.com', credentialId: 'cred-1', userHandle: 'u1', privateKey: 'LA-PRIVADA' }
  }
  await conEntrada(v, conLlaves, plain)

  // Quien tiene `passkeys` la abre.
  const mio = await v.sealed.get('e2', { pub: conLlaves.pub })
  assert.deepEqual(mio.withheld, [])
  const abierta = await openSealedEntry({ got: mio, openSealed: conLlaves.openSealed })
  assert.equal(abierta.webauthn.privateKey, 'LA-PRIVADA')

  // Quien no, recibe todo lo demás y se le DICE que la privada se quedó fuera.
  const otro = await v.sealed.get('e2', { pub: sinLlaves.pub })
  assert.deepEqual(otro.withheld, [PASSKEY_FIELD], 'se le entregó la privada de la passkey')
  const suya = await openSealedEntry({ got: otro, openSealed: sinLlaves.openSealed })
  assert.equal(suya.secret, CUENTA.secret, 'la contraseña sí es suya')
  assert.equal(suya.webauthn.privateKey, '', 'abrió una llave que no le tocaba')
})

test('los destinatarios son los del acta: ni de más, ni de menos, y siempre la recuperación', async () => {
  const uno = await device('uno'); const dos = await device('dos')
  const v = await boveda({ conPasskeys: [uno, dos] })
  const pk = await buildProfileKey({ recipients: v.recipients })
  await v.sealed.setProfile({ envelope: pk.envelope, wraps: pk.wraps })
  const keys = await profileKeys(pk.base)

  // De MENOS: se deja fuera al otro aparato.
  const cojo = await buildSealedEntry({
    plain: CUENTA, keys, author: uno.author,
    recipients: { recoveryPub: v.recipients.recoveryPub, main: [{ pub: uno.pub, encPub: uno.encPub }], passkeys: [] }
  })
  await assert.rejects(() => v.sealed.putSealed(cojo), (e) => e.code === 'wrong-recipients')

  // De MÁS: se cuela una llave que el acta no nombra.
  const intruso = await device('intruso')
  const conIntruso = await buildSealedEntry({
    plain: CUENTA, keys, author: uno.author,
    recipients: { ...v.recipients, main: [...v.recipients.main, { pub: intruso.pub, encPub: intruso.encPub }] }
  })
  await assert.rejects(() => v.sealed.putSealed(conIntruso), (e) => e.code === 'wrong-recipients')

  // SIN recuperación: la entrada nacería imposible de volver a repartir.
  const sinRec = await buildSealedEntry({ plain: CUENTA, keys, recipients: v.recipients, author: uno.author })
  delete sinRec.main.wraps[RECOVERY]
  await assert.rejects(() => v.sealed.putSealed(sinRec), (e) => e.code === 'recovery-missing')
})

test('sin firma de un aparato que pueda escribir, no entra', async () => {
  const uno = await device('uno'); const fuera = await device('el que no está')
  const v = await boveda({ conPasskeys: [uno] })
  const pk = await buildProfileKey({ recipients: v.recipients })
  await v.sealed.setProfile({ envelope: pk.envelope, wraps: pk.wraps })
  const keys = await profileKeys(pk.base)

  // Firmada por alguien que no está en el acta.
  const ajena = await buildSealedEntry({ plain: CUENTA, keys, recipients: v.recipients, author: fuera.author })
  await assert.rejects(() => v.sealed.putSealed(ajena), (e) => e.code === 'bad-author')

  // Firmada por uno, pero con el contenido cambiado después.
  const buena = await buildSealedEntry({ plain: CUENTA, keys, recipients: v.recipients, author: uno.author })
  buena.entry.digests.secret = 'otro-resumen'
  await assert.rejects(() => v.sealed.putSealed(buena), (e) => e.code === 'bad-author')

  // Y sin firma ninguna.
  const muda = await buildSealedEntry({ plain: CUENTA, keys, recipients: v.recipients, author: uno.author })
  delete muda.entry.author
  await assert.rejects(() => v.sealed.putSealed(muda), (e) => e.code === 'unsigned')
})

test('a quien no le envolvieron nada, la bóveda no le cuenta ni que existe', async () => {
  const uno = await device('uno'); const nuevo = await device('recién llegado')
  const v = await boveda({ conPasskeys: [uno] })
  await conEntrada(v, uno)

  assert.deepEqual(await v.sealed.views({ pub: nuevo.pub }), [], 'le listó entradas que no puede abrir')
  await assert.rejects(() => v.sealed.get('e1', { pub: nuevo.pub }), (e) => e.code === 'not-yours')
})

test('buscar va por huellas: otro sitio no casa, y sin sitios sirve en cualquiera', async () => {
  const uno = await device('uno')
  const v = await boveda({ conPasskeys: [uno] })
  const { keys } = await conEntrada(v, uno)
  const libre = await buildSealedEntry({
    plain: { ...CUENTA, id: 'e3', sites: [] }, keys, recipients: v.recipients, author: uno.author
  })
  await v.sealed.putSealed(libre)

  const otra = await siteIndex(keys.kidx, 'otrositio.com')
  const hits = await v.sealed.find({ pub: uno.pub, idx: [otra] })
  assert.deepEqual(hits.map((h) => h.id), ['e3'], 'sin sitios sirve en cualquier parte; con otros, no')

  const suya = await siteIndex(keys.kidx, 'mail.example.com')
  assert.deepEqual((await v.sealed.find({ pub: uno.pub, idx: [suya] })).map((h) => h.id).sort(), ['e1', 'e3'])
})

test('el mismo valor en dos entradas da resúmenes distintos', async () => {
  const uno = await device('uno')
  const v = await boveda({ conPasskeys: [uno] })
  const { keys } = await conEntrada(v, uno)
  const gemela = await buildSealedEntry({
    plain: { ...CUENTA, id: 'e4' }, keys, recipients: v.recipients, author: uno.author
  })
  await v.sealed.putSealed(gemela)

  const a = (await v.sealed.views({ pub: uno.pub })).find((x) => x.id === 'e1')
  const b = (await v.sealed.views({ pub: uno.pub })).find((x) => x.id === 'e4')
  assert.equal(typeof a.digests.secret, 'string')
  assert.notEqual(a.digests.secret, b.digests.secret, 'un resumen delataría la contraseña repetida')
})

test('el llavero no crece para siempre: lo que ya no abre nada se barre', async () => {
  const uno = await device('uno')
  const v = await boveda({ conPasskeys: [uno] })
  const { keys } = await conEntrada(v, uno)
  for (let i = 0; i < 5; i++) {
    const otra = await buildSealedEntry({
      plain: { ...CUENTA, secret: 'cambiada ' + i }, keys, recipients: v.recipients, author: uno.author
    })
    await v.sealed.putSealed(otra)
  }
  const s = v.mem.get(KEY)
  assert.equal(s.entries.length, 1)
  assert.equal(s.keyring.length, 2, 'quedaron generaciones que ya no abren nada: ' + s.keyring.length)
  // Y la última escritura es la que se lee.
  const got = await v.sealed.get('e1', { pub: uno.pub, keys: ['secret'] })
  const abierta = await openSealedEntry({ got, openSealed: uno.openSealed })
  assert.equal(abierta.secret, 'cambiada 4')
})

test('la frase del perfil abre lo de todos: es la copia de recuperación', async () => {
  const uno = await device('uno')
  const v = await boveda({ conPasskeys: [uno] })
  await conEntrada(v, uno)

  // La recuperación no es un aparato del acta, así que se sirve ella misma del llavero.
  const s = v.mem.get(KEY)
  const entrada = s.entries[0]
  const gen = s.keyring.find((g) => g.gen === entrada.fields.secret.gen)
  const secreto = await v.rec.openSealed({ wrap: gen.wraps[RECOVERY], envelope: entrada.fields.secret })
  assert.equal(secreto, CUENTA.secret)
})

test('pedir solo un campo devuelve solo ese campo', async () => {
  const uno = await device('uno')
  const v = await boveda({ conPasskeys: [uno] })
  await conEntrada(v, uno)
  const got = await v.sealed.get('e1', { pub: uno.pub, keys: ['username'] })
  assert.deepEqual(Object.keys(got.envelopes), ['username'])
  const abierta = await openSealedEntry({ got, openSealed: uno.openSealed })
  assert.equal(abierta.username, CUENTA.username)
  assert.equal(abierta.secret, '', 'se coló la contraseña en una petición del usuario')
})

test('cambiar un campo no obliga a leer la entrada, y no pierde lo que no se tocó', async () => {
  const uno = await device('uno')
  const v = await boveda({ conPasskeys: [uno] })
  const { keys } = await conEntrada(v, uno)

  // La vista la rehace quien cambia: ya la tenía abierta, y no es un valor.
  const hits = await v.sealed.views({ pub: uno.pub })
  const vista = await openSealedView({ ...hits[0], openSealed: uno.openSealed })
  const { buildSealedPatch } = await import('../src/sealed/device.js')
  const parche = await buildSealedPatch({
    id: 'e1',
    view: { type: vista.type, title: vista.title, sites: vista.sites, hint: vista.hint, fieldKeys: vista.fieldKeys, privateKeys: vista.privateKeys, has: { secret: true, totp: true, notes: true, fields: true, webauthn: false } },
    values: { username: 'otra@example.com' },
    keys,
    recipients: v.recipients,
    author: uno.author
  })
  await v.sealed.patchSealed({ ...parche, main: parche.main })

  const got = await v.sealed.get('e1', { pub: uno.pub })
  const abierta = await openSealedEntry({ got, openSealed: uno.openSealed })
  assert.equal(abierta.username, 'otra@example.com', 'no se cambió lo que se pedía')
  assert.equal(abierta.secret, CUENTA.secret, 'se perdió la contraseña al cambiar el usuario')
  assert.equal(abierta.notes, CUENTA.notes, 'se perdieron las notas')
})

test('un parche también va firmado, y quitar un campo lo quita del resumen', async () => {
  const uno = await device('uno'); const fuera = await device('ajeno')
  const v = await boveda({ conPasskeys: [uno] })
  const { keys } = await conEntrada(v, uno)
  const { buildSealedPatch } = await import('../src/sealed/device.js')
  const vista = { type: 'login', title: 'Correo', sites: ['mail.example.com'], hint: 'ana@example.com', fieldKeys: ['username'], privateKeys: [], has: {} }

  const ajeno = await buildSealedPatch({ id: 'e1', view: vista, values: { username: 'x@y.z' }, keys, recipients: v.recipients, author: fuera.author })
  await assert.rejects(() => v.sealed.patchSealed(ajeno), (e) => e.code === 'bad-author')

  const quita = await buildSealedPatch({ id: 'e1', view: vista, drop: ['notes'], keys, recipients: v.recipients, author: uno.author })
  await v.sealed.patchSealed(quita)
  const got = await v.sealed.get('e1', { pub: uno.pub })
  assert.ok(!('notes' in got.envelopes), 'la nota sigue guardada')
  assert.ok(!('notes' in got.digests), 'quedó el resumen de algo que ya no está')
})
