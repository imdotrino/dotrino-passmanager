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
