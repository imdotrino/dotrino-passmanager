/**
 * LAS DOS PUNTAS DEL MISMO SOBRE.
 *
 * `identitySealing` existe porque el sobre estaba escrito dos veces —en la extensión y en
 * la bóveda-en-pestaña de `vault.dotrino.com/vault`— con dos dialectos distintos de
 * `@dotrino/identity`. Dos copias es una que se queda atrás, y esa clase de fallo no hace
 * ruido: la petición sale, al otro lado «no es para mí», y desde fuera se ve como que
 * nadie respondió.
 *
 * Lo que se prueba aquí es la ADAPTACIÓN y la forma del sobre, con un cifrado de mentira:
 * que lo que sella un dialecto lo abre el otro. La cripto de verdad es del pilar
 * (`@dotrino/identity/content`) y se prueba en su repo.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { identitySealing } from '../src/transport/sealed.js'

/** Un "cifrado" que solo envuelve: basta para comprobar quién abre qué. */
const cerrar = (para, texto) => JSON.stringify({ para, texto })
const abrir = (sobre) => JSON.parse(sobre).texto

/** El dialecto de la clase `Identity` (la que habla con el iframe). */
const comoIframe = (encPub) => ({
  async getEncryptionPubkey () { return encPub },
  async encrypt (recipients, plaintext) { return cerrar(recipients[0].encryptionPubkey, plaintext) },
  async decrypt (_from, _myToken, envelope) { return { plaintext: abrir(envelope) } },
})

/** El dialecto del núcleo que corre en el service worker de la extensión. */
const comoExtension = (encPub) => ({
  async encryptionPubkey () { return encPub },
  async encrypt (recipients, plaintext) { return cerrar(recipients[0].encryptionPubkey, plaintext) },
  async decrypt (_from, envelope) { return abrir(envelope) },
})

test('lo que sella la pestaña lo abre la extensión, y al revés', async () => {
  const pestana = identitySealing(comoIframe('ENC-PESTAÑA'))
  const extension = identitySealing(comoExtension('ENC-EXTENSION'))

  const ida = await pestana.seal({ op: 'get', id: 'x' }, 'ENC-EXTENSION')
  assert.equal(ida.from, 'ENC-PESTAÑA')
  assert.ok(extension.isSealed(ida))
  assert.deepEqual(await extension.open(ida), { op: 'get', id: 'x' })

  const vuelta = await extension.seal({ rid: '1', result: null }, 'ENC-PESTAÑA')
  assert.equal(vuelta.from, 'ENC-EXTENSION')
  assert.ok(pestana.isSealed(vuelta))
  assert.deepEqual(await pestana.open(vuelta), { rid: '1', result: null })
})

test('sin la llave del otro lado no sale nada, y el código es `unsealed`', async () => {
  const s = identitySealing(comoIframe('ENC-PESTAÑA'))
  await assert.rejects(() => s.seal({ op: 'find' }, null), (e) => e.code === 'unsealed')
})

test('un sobre de otra app no es mío', () => {
  const s = identitySealing(comoExtension('ENC-EXTENSION'))
  assert.equal(s.isSealed({ app: 'otra-cosa', sealed: 'x' }), false)
  assert.equal(s.isSealed({ app: 'passmanager' }), false)
  assert.equal(s.isSealed(null), false)
})

/**
 * Una identidad que no es ninguno de los dos dialectos REVIENTA al construir, no al usar.
 * Sin esto se armaban sobres con `from: undefined` que el otro lado descartaba en
 * silencio: el fallo aparecía a tres saltos de distancia, como «nadie respondió».
 */
test('una identidad desconocida se rechaza al construir', () => {
  assert.throws(() => identitySealing({ encrypt () {}, decrypt () {} }), /getEncryptionPubkey/)
})

test('la marca del sobre se puede cambiar, y entonces solo se abre entre iguales', async () => {
  const a = identitySealing(comoIframe('A'), { app: 'otra' })
  const b = identitySealing(comoExtension('B'))
  const sobre = await a.seal({ hola: 1 }, 'B')
  assert.equal(sobre.app, 'otra')
  assert.equal(b.isSealed(sobre), false)
})
