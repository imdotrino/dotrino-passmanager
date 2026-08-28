// Cuándo se marca un campo y cuándo no.
//
// Es la decisión que hace que el gestor no ponga un botón en cada casilla de la web, y
// se prueba aquí y no en el navegador porque es pura: entra qué hay guardado (lo
// público) y qué hay escrito, y sale qué se puede ofrecer.
//
//   npm run test:offers      (necesita el vendor: npm --prefix extension run build)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fieldOffers, fieldKey } from '../src/detect.js'

const conClave = { id: '1', type: 'login', hasSecret: true, hasFields: false }
const conCampos = { id: '2', type: 'data', hasSecret: false, hasFields: true }

test('sin nada guardado y sin nada escrito, no hay marcador', () => {
  const o = fieldOffers({ kind: null, value: '', formSecret: '' }, [])
  assert.equal(o.fill, false)
  assert.equal(o.save, false)
})

test('con una credencial guardada se puede rellenar el acceso', () => {
  const o = fieldOffers({ kind: null, value: '', formSecret: '' }, [conClave])
  assert.equal(o.fill, true)
})

test('una entrada de datos NO sirve para rellenar un acceso', () => {
  assert.equal(fieldOffers({ kind: null, value: '' }, [conCampos]).fill, false)
})

test('y una credencial no sirve para un campo de datos', () => {
  assert.equal(fieldOffers({ kind: 'email', value: '' }, [conClave]).fill, false)
  assert.equal(fieldOffers({ kind: 'email', value: '' }, [conCampos]).fill, true)
})

test('un campo de datos con algo escrito se puede guardar', () => {
  assert.equal(fieldOffers({ kind: 'tel', value: '0999111222' }, []).save, true)
  assert.equal(fieldOffers({ kind: 'tel', value: '   ' }, []).save, false)
})

test('en un acceso, lo que se guarda es la CONTRASEÑA, no el usuario suelto', () => {
  // Usuario escrito pero sin contraseña: no hay credencial que guardar todavía.
  assert.equal(fieldOffers({ kind: null, value: 'ana@ejemplo.com', formSecret: '' }, []).save, false)
  assert.equal(fieldOffers({ kind: null, value: '', formSecret: 'hunter2' }, []).save, true)
})

test('las dos cosas a la vez: hay guardado y hay escrito', () => {
  const o = fieldOffers({ kind: null, value: 'ana', formSecret: 'nueva' }, [conClave])
  assert.equal(o.fill, true)
  assert.equal(o.save, true)
})

test('una lista rara no revienta', () => {
  assert.deepEqual(fieldOffers({ kind: 'email', value: '' }, null), { fill: false, save: false })
  assert.deepEqual(fieldOffers({}, undefined), { fill: false, save: false })
})

test('un campo que no se reconoce solo se puede guardar, y solo si tiene algo', () => {
  const vacio = fieldOffers({ free: true, label: 'Número de socio', value: '' }, [conCampos])
  assert.deepEqual(vacio, { fill: false, save: false })
  const lleno = fieldOffers({ free: true, label: 'Número de socio', value: 'SOC-4471' }, [])
  assert.deepEqual(lleno, { fill: false, save: true })
})

test('la clave de un campo es su clase, y si no la tiene, su etiqueta', () => {
  assert.equal(fieldKey({ kind: 'email', label: 'Tu correo' }), 'email')
  assert.equal(fieldKey({ label: 'Número de socio' }), 'label:Número de socio')
  assert.equal(fieldKey({ label: '  ' }), 'other')
  assert.equal(fieldKey({}), 'other')
})
