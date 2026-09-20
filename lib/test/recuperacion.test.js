// LA COPIA DE RECUPERACIÓN BAJO CONTRASEÑA (`src/sealed/recovery.js`).
//
// `SealedStore` exige la envoltura `#recovery` en toda entrada, y de dónde sale su llave
// es lo que distinguía a cada bóveda: el binario tenía la contraseña del perfil,
// `passmanager serve` la suya, y la pestaña y la bóveda de la extensión no tenían ninguna.
// El dueño lo cerró el 2026-09-20: **una contraseña, en las cuatro**, y una sola pieza.
//
// Lo que se fija aquí, en orden de importancia:
//
//   1. el sobre que hace una bóveda lo ABRE la copia — que es para lo único que existe;
//   2. lo guardado no lleva la privada en claro ni nada con qué sacarla sin la contraseña;
//   3. una contraseña equivocada se distingue de un archivo roto (se arreglan distinto);
//   4. cambiarla NO cambia el par, así que los sobres que ya existen siguen valiendo;
//   5. una contraseña corta no se acepta, porque es lo único que aguanta aquí.

import test from 'node:test'
import assert from 'node:assert/strict'
import { wrapForMember, openWrap, makeContentKey, encryptWithCek, decryptWithCek } from '@dotrino/identity/content'
import { makeRecovery, openRecovery, changeRecoveryPassword, hasRecovery, recoveryPubOf } from '../src/sealed/recovery.js'

const CLAVE = 'una contraseña larga de verdad'

test('el sobre que se envuelve a la copia, la copia lo abre', async () => {
  const { pub, record } = await makeRecovery({ password: CLAVE })
  const cek = await makeContentKey()
  const wrap = await wrapForMember({ cek, memberEncPub: pub })
  const sobre = await encryptWithCek({ cek, gen: 1, plaintext: 'la contraseña del banco' })

  const myEncPrivateKey = await openRecovery({ record, password: CLAVE })
  const recuperada = await openWrap({ wrap, myEncPrivateKey })

  assert.equal(await decryptWithCek({ cek: recuperada, envelope: sobre }), 'la contraseña del banco')
})

test('lo guardado NO lleva la privada en claro', async () => {
  const { record } = await makeRecovery({ password: CLAVE })
  const crudo = JSON.stringify(record)
  // La privada de una ECDH P-256 en JWK lleva `"d"`: si asomara, la copia no protegería nada.
  assert.ok(!/"d"\s*:/.test(crudo), 'la privada está en claro dentro del archivo')
  assert.ok(!crudo.includes(CLAVE), 'la contraseña no puede quedar guardada')
  assert.ok(record.salt && record.verifier && record.priv, 'faltan las piezas para poder abrirla')
})

test('la contraseña equivocada se distingue de un archivo roto', async () => {
  const { record } = await makeRecovery({ password: CLAVE })

  const mala = await openRecovery({ record, password: 'no es esa tampoco' }).catch((e) => e)
  assert.equal(mala.code, 'wrong-password', 'escribir mal se arregla escribiendo bien')

  // El verificador pasa (la contraseña es la buena) pero el sobre está corrupto.
  const roto = { ...record, priv: { ...record.priv, ct: 'AAAA' } }
  const e = await openRecovery({ record: roto, password: CLAVE }).catch((x) => x)
  assert.equal(e.code, 'bad-recovery', 'esto no se arregla intentándolo otra vez')

  const sin = await openRecovery({ record: null, password: CLAVE }).catch((x) => x)
  assert.equal(sin.code, 'no-recovery')
})

test('cambiar la contraseña NO cambia el par: los sobres de antes siguen valiendo', async () => {
  const { pub, record } = await makeRecovery({ password: CLAVE })
  const cek = await makeContentKey()
  const wrap = await wrapForMember({ cek, memberEncPub: pub })
  const sobre = await encryptWithCek({ cek, gen: 1, plaintext: 'lo de antes' })

  const nuevo = await changeRecoveryPassword({ record, oldPassword: CLAVE, newPassword: 'la nueva, también larga' })
  assert.equal(recoveryPubOf(nuevo), pub, 'si cambiara la pública habría que reescribirlo TODO')
  assert.notEqual(nuevo.salt, record.salt, 'sal nueva en cada cambio')

  const myEncPrivateKey = await openRecovery({ record: nuevo, password: 'la nueva, también larga' })
  const recuperada = await openWrap({ wrap, myEncPrivateKey })
  assert.equal(await decryptWithCek({ cek: recuperada, envelope: sobre }), 'lo de antes')

  const vieja = await openRecovery({ record: nuevo, password: CLAVE }).catch((e) => e)
  assert.equal(vieja.code, 'wrong-password', 'la vieja tiene que dejar de abrir')
})

test('una contraseña corta no se acepta, ni al crear ni al cambiar', async () => {
  const corta = await makeRecovery({ password: 'corta' }).catch((e) => e)
  assert.equal(corta.code, 'weak-password')

  const { record } = await makeRecovery({ password: CLAVE })
  const e = await changeRecoveryPassword({ record, oldPassword: CLAVE, newPassword: '1234' }).catch((x) => x)
  assert.equal(e.code, 'weak-password')
})

test('hasRecovery dice si hay que crearla, que es lo que pregunta quien convierte', async () => {
  assert.equal(hasRecovery(null), false)
  assert.equal(hasRecovery({ pub: 'x' }), false, 'sin la privada no hay copia: hay media')
  const { record } = await makeRecovery({ password: CLAVE })
  assert.equal(hasRecovery(record), true)
})

/**
 * Y LA QUE SOSTIENE LA REGLA DE LAS CUATRO BÓVEDAS: dos copias creadas por separado usan
 * la misma curva y el mismo formato de sobre, así que lo que envuelve una lo abre la otra.
 * Si alguien cambiara la curva «solo aquí», esto es lo que lo cazaría.
 */
test('lo que envuelve una bóveda lo abre la copia de otra con la misma llave', async () => {
  const a = await makeRecovery({ password: CLAVE })
  const cek = await makeContentKey()
  // La bóveda B envuelve a la pública que publicó A (es lo que pasa al repartir de nuevo).
  const wrap = await wrapForMember({ cek, memberEncPub: a.pub })
  const sobre = await encryptWithCek({ cek, gen: 3, plaintext: 'cruzado' })
  const priv = await openRecovery({ record: a.record, password: CLAVE })
  assert.equal(await decryptWithCek({ cek: await openWrap({ wrap, myEncPrivateKey: priv }), envelope: sobre }), 'cruzado')
})

/**
 * Y LA VUELTA QUE HACE UNA BÓVEDA DE NAVEGADOR AL CONVERTIR (`convertToSealed`).
 *
 * Es el camino exacto de la pestaña y de la bóveda de dentro de la extensión: no tenían
 * ninguna contraseña, así que la piden, crean con ella la copia de recuperación y
 * reescriben lo que hubiera. Lo que se prueba es lo que hace que eso sirva de algo:
 *
 *   · después de convertir, la bóveda guarda sobres y NO queda ni un valor en claro;
 *   · la llave vieja —la que la bóveda podía usar para leerlo todo— se va;
 *   · y con la contraseña se vuelve a entrar: se abre la llave del perfil por la
 *     envoltura `#recovery`, que es como el dueño guarda una entrada nueva o repara.
 */
test('convertir una bóveda de navegador: sobres dentro, llave vieja fuera, contraseña para volver', async () => {
  const { openEntry, sealEntry } = await import('../src/model.js')
  const { makeVaultKey } = await import('../src/crypto.js')
  const { SealedStore, RECOVERY, KEY } = await import('../src/sealed/store.js')
  const { convertToSealed } = await import('../src/sealed/convert.js')
  const { buildSealedEntry, openSealedEntry } = await import('../src/sealed/device.js')
  const { profileKeys } = await import('../src/sealed/keys.js')

  const ECDH = { name: 'ECDH', namedCurve: 'P-256' }
  const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' }
  const SIGN = { name: 'ECDSA', hash: { name: 'SHA-256' } }
  const canon = (v) => (v === null || typeof v !== 'object')
    ? JSON.stringify(v)
    : Array.isArray(v) ? '[' + v.map(canon).join(',') + ']'
      : '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}'

  // Un aparato del acta: el que SÍ podrá leer. La bóveda no está en la lista.
  const sig = await crypto.subtle.generateKey(ECDSA, true, ['sign', 'verify'])
  const enc = await crypto.subtle.generateKey(ECDH, true, ['deriveBits'])
  const encJwk = await crypto.subtle.exportKey('jwk', enc.publicKey)
  const pub = JSON.stringify(await crypto.subtle.exportKey('jwk', sig.publicKey))
  const encPub = JSON.stringify({ kty: encJwk.kty, crv: encJwk.crv, x: encJwk.x, y: encJwk.y })
  const author = {
    publickey: pub,
    async sign (body) {
      const s = await crypto.subtle.sign(SIGN, sig.privateKey, new TextEncoder().encode(canon(body)))
      return { signature: Buffer.from(new Uint8Array(s)).toString('base64') }
    }
  }

  // La bóveda de ANTES: su llave y sus entradas cifradas con ella.
  const mem = new Map()
  const store = { async get (k) { return mem.get(k) }, async set (k, v) { mem.set(k, v) } }
  const cekVieja = await makeVaultKey()
  const LEGACY = 'passmanager/entries/v1'
  await store.set(LEGACY, [
    await sealEntry(cekVieja, { id: 'e1', title: 'El banco', sites: ['banco.example'], username: 'ana', secret: 'la-de-verdad' })
  ])
  let llaveVieja = cekVieja
  assert.ok(await openEntry(llaveVieja, (await store.get(LEGACY))[0]), 'la bóveda de antes SÍ podía leer');

  // Convertir, con la contraseña que el usuario acaba de elegir.
  const { record } = await makeRecovery({ password: CLAVE })
  const sealed = new SealedStore(store, {
    recipients: () => [{ pub, encPub }],
    verifyAuthor: async ({ body, author: a }) => crypto.subtle.verify(
      SIGN, sig.publicKey, Uint8Array.from(Buffer.from(a.sig, 'base64')), new TextEncoder().encode(canon(body)))
  })
  const r = await convertToSealed({
    store,
    sealed,
    cek: cekVieja,
    recipients: { recoveryPub: recoveryPubOf(record), main: [{ pub, encPub }], passkeys: [] },
    author,
    dropOldKey: async () => { llaveVieja = null }
  })
  assert.equal(r.entries, 1)
  assert.equal(llaveVieja, null, 'mientras la llave vieja siga ahí, el agujero sigue abierto')
  assert.deepEqual(await store.get(LEGACY), [], 'las entradas de antes no se quedan al lado')

  // 1. Lo guardado no lleva ni un valor en claro.
  const crudo = JSON.stringify(await store.get(KEY))
  assert.ok(!crudo.includes('la-de-verdad'), 'la contraseña quedó en claro')
  assert.ok(!crudo.includes('banco.example'), 'el sitio va por huella, no en claro')

  // 2. El APARATO la abre, que es para quien se guardó.
  const suya = await sealed.get('e1', { pub })
  const abierta = await openSealedEntry({
    got: suya,
    openSealed: async ({ wrap, envelope }) => decryptWithCek({ cek: await openWrap({ wrap, myEncPrivateKey: enc.privateKey }), envelope })
  })
  assert.equal(abierta.secret, 'la-de-verdad')

  // 3. Y el DUEÑO vuelve a entrar con su contraseña: abre la llave del perfil por
  //    `#recovery`, que es lo que hace falta para guardar una entrada nueva desde aquí.
  const priv = await openRecovery({ record, password: CLAVE })
  const { envelope, wrap } = await sealed.profile({ pub: RECOVERY })
  const base = await decryptWithCek({ cek: await openWrap({ wrap, myEncPrivateKey: priv }), envelope })
  const keys = await profileKeys(base)
  const nueva = await buildSealedEntry({
    plain: { id: 'e2', title: 'Otra', sites: ['otro.example'], secret: 'x' },
    keys,
    recipients: { recoveryPub: recoveryPubOf(record), main: [{ pub, encPub }], passkeys: [] },
    author
  })
  await sealed.putSealed(nueva)
  assert.equal((await sealed.stats()).entries, 2, 'con la contraseña se puede seguir guardando')
})
