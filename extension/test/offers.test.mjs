// La regla del semicírculo, campo a campo.
//
// Es la decisión que hace que el gestor no ponga un botón en cada casilla de la web, y
// se prueba aquí y no en el navegador porque es pura: entra qué hay escrito, si hay algo
// guardado de ese campo y si es lo mismo; sale qué se puede ofrecer.
//
//   npm run test:offers      (necesita el vendor: npm --prefix extension run build)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fieldOffers, fieldKey } from '../src/detect.js'

// La tabla del §4.1, fila por fila.
const casos = [
  { que: 'vacío y sin nada guardado', f: { value: '', stored: false }, fill: false, save: false },
  { que: 'con algo escrito y sin nada guardado', f: { value: 'a', stored: false }, fill: false, save: true },
  { que: 'vacío y con algo guardado', f: { value: '', stored: true }, fill: true, save: false },
  { que: 'escrito distinto de lo guardado', f: { value: 'otra', stored: true, same: false }, fill: false, save: true },
  { que: 'escrito IGUAL a lo guardado', f: { value: 'la misma', stored: true, same: true }, fill: false, save: false },
]

for (const c of casos) {
  test(`${c.que} → ${c.fill ? 'rellenar' : ''}${c.save ? 'guardar' : ''}${!c.fill && !c.save ? 'sin botón' : ''}`, () => {
    assert.deepEqual(fieldOffers(c.f), { fill: c.fill, save: c.save })
  })
}

test('UNA letra ya basta: el botón es por campo, no por formulario', () => {
  assert.equal(fieldOffers({ value: 'a', stored: false }).save, true)
})

test('los espacios no son contenido', () => {
  assert.deepEqual(fieldOffers({ value: '   ', stored: true }), { fill: true, save: false })
})

// El «ya está guardado igual» lo decide el service worker mirando TODAS las entradas que
// tienen ese campo: con dos, coincidir con una y diferir de la otra deja algo que hacer.
test('con dos entradas, coincidir con una no apaga el botón', () => {
  const conEsteCampo = [{ valor: 'x' }, { valor: 'y' }]
  const igualEnTodas = (v) => conEsteCampo.length > 0 && conEsteCampo.every(e => e.valor === v)
  assert.equal(fieldOffers({ value: 'x', stored: true, same: igualEnTodas('x') }).save, true)
  assert.equal(fieldOffers({ value: 'z', stored: true, same: igualEnTodas('z') }).save, true)
  // Y si las dos tienen lo mismo que hay escrito, ahí sí no queda nada que hacer.
  const iguales = [{ valor: 'x' }, { valor: 'x' }]
  const todasX = iguales.every(e => e.valor === 'x')
  assert.equal(fieldOffers({ value: 'x', stored: true, same: todasX }).save, false)
})

test('sin decirle nada, no ofrece nada', () => {
  assert.deepEqual(fieldOffers(), { fill: false, save: false })
  assert.deepEqual(fieldOffers({}), { fill: false, save: false })
})

test('la clave de un campo es su clase, y si no la tiene, su etiqueta', () => {
  assert.equal(fieldKey({ kind: 'email', label: 'Tu correo' }), 'email')
  assert.equal(fieldKey({ label: 'Número de socio' }), 'label:Número de socio')
  assert.equal(fieldKey({ label: '  ' }), 'other')
  assert.equal(fieldKey({}), 'other')
})
