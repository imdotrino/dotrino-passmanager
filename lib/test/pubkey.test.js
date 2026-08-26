import { test } from 'node:test'
import assert from 'node:assert/strict'
import { samePubkey, pubkeyId } from '../src/pubkey.js'

/**
 * Esto salió de una prueba real: la bóveda denegaba a un aparato que SÍ estaba
 * autorizado, y los dos valores parecían idénticos al mirarlos. Eran la misma llave
 * escrita distinto.
 */
test('pubkey: la misma llave con otro orden de campos ES la misma', () => {
  const a = JSON.stringify({ crv: 'P-256', ext: true, key_ops: ['verify'], kty: 'EC', x: 'AAA', y: 'BBB' })
  const b = JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'AAA', y: 'BBB' })

  assert.notEqual(a, b, 'el test no prueba nada si las cadenas ya coinciden')
  assert.equal(samePubkey(a, b), true)
})

test('pubkey: llaves distintas siguen siendo distintas', () => {
  const base = { kty: 'EC', crv: 'P-256', x: 'AAA', y: 'BBB' }
  assert.equal(samePubkey(JSON.stringify(base), JSON.stringify({ ...base, x: 'OTRA' })), false)
  assert.equal(samePubkey(JSON.stringify(base), JSON.stringify({ ...base, y: 'OTRA' })), false)
  // Otra curva no es la misma llave aunque las coordenadas coincidan.
  assert.equal(samePubkey(JSON.stringify(base), JSON.stringify({ ...base, crv: 'P-384' })), false)
})

test('pubkey: lo que no es una llave no empareja con nada', () => {
  const buena = JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'AAA', y: 'BBB' })
  for (const basura of ['', 'no-es-json', '{}', null, undefined, '{"kty":"EC"}']) {
    assert.equal(samePubkey(basura, buena), false, `emparejó con ${JSON.stringify(basura)}`)
    assert.equal(samePubkey(basura, basura), false, 'dos basuras iguales no son una llave')
  }
})

test('pubkey: el id es estable, sirve como clave de un mapa', () => {
  const a = JSON.stringify({ crv: 'P-256', ext: true, kty: 'EC', x: 'AAA', y: 'BBB' })
  const b = JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'AAA', y: 'BBB', key_ops: ['verify'] })
  assert.equal(pubkeyId(a), pubkeyId(b))
  assert.equal(pubkeyId('basura'), null)
})

test('pubkey: acepta el JWK como objeto, no solo como cadena', () => {
  const obj = { kty: 'EC', crv: 'P-256', x: 'AAA', y: 'BBB' }
  assert.equal(samePubkey(obj, JSON.stringify(obj)), true)
})
