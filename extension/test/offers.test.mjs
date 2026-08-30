// La regla del semicírculo, campo a campo.
//
// Es la decisión que hace que el gestor no ponga un botón en cada casilla de la web, y
// se prueba aquí y no en el navegador porque es pura: entra qué hay escrito y si hay algo
// guardado de ese campo; sale qué se puede ofrecer.
//
//   npm run test:offers      (necesita el vendor: npm --prefix extension run build)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fieldOffers, fieldKey } from '../src/detect.js'
// La gemela de la librería: la bóveda la usa para decir QUÉ campos lleva una entrada.
import { fieldKey as fieldKeyLib, entryFieldKeys } from '../../lib/src/fields.js'

// La tabla del §4.1, fila por fila. Desde el 2026-08-29 son cuatro filas: *«el botón solo
// se esconde si el field está vacío y no existe un record con su valor»*.
const casos = [
  { que: 'vacío y sin nada guardado', f: { value: '', stored: false }, fill: false, save: false },
  { que: 'con algo escrito y sin nada guardado', f: { value: 'a', stored: false }, fill: false, save: true },
  { que: 'vacío y con algo guardado', f: { value: '', stored: true }, fill: true, save: false },
  { que: 'con algo escrito y algo guardado', f: { value: 'otra', stored: true }, fill: false, save: true },
]

for (const c of casos) {
  test(`${c.que} → ${c.fill ? 'rellenar' : ''}${c.save ? 'guardar' : ''}${!c.fill && !c.save ? 'sin botón' : ''}`, () => {
    assert.deepEqual(fieldOffers(c.f), { fill: c.fill, save: c.save, gen: false })
  })
}

// --- y la casilla de las contraseñas (§4.1.1) ---------------------------------------
//
// La misma tabla, pero en un campo de contraseña: uno vacío SIEMPRE ofrece generar una,
// haya algo guardado o no. Es la fila que faltaba, y es la que pone el generador donde
// hace falta — al registrarse, que es cuando se inventa una contraseña.
const conSecreto = [
  { que: 'contraseña vacía y sin nada guardado', f: { value: '', stored: false, secret: true }, fill: false, save: false, gen: true },
  { que: 'contraseña vacía y con algo guardado', f: { value: '', stored: true, secret: true }, fill: true, save: false, gen: true },
  { que: 'contraseña escrita', f: { value: 'abc', stored: false, secret: true }, fill: false, save: true, gen: false },
  { que: 'contraseña escrita y con algo guardado', f: { value: 'abc', stored: true, secret: true }, fill: false, save: true, gen: false },
]

for (const c of conSecreto) {
  test(c.que, () => {
    assert.deepEqual(fieldOffers(c.f), { fill: c.fill, save: c.save, gen: c.gen })
  })
}

// Lo que hacía falta arreglar: registrarse en un sitio nuevo no sacaba ningún botón, así
// que el generador no aparecía justo donde tenía que aparecer.
test('registrarse en un sitio nuevo: la contraseña vacía ya tiene botón', () => {
  const antes = fieldOffers({ value: '', stored: false })
  assert.equal(antes.fill || antes.save || antes.gen, false, 'un campo normal vacío sigue sin botón')
  const ahora = fieldOffers({ value: '', stored: false, secret: true })
  assert.equal(ahora.gen, true)
})

// Generar no puede depender de la bóveda: si dependiera, la página sabría si hay algo
// guardado con solo mirar el botón. Depende del `type=password`, que la escribió ella.
test('generar no mira lo que hay guardado', () => {
  const sin = fieldOffers({ value: '', stored: false, secret: true })
  const con = fieldOffers({ value: '', stored: true, secret: true })
  assert.equal(sin.gen, con.gen)
})

test('los espacios tampoco son contraseña', () => {
  assert.equal(fieldOffers({ value: '   ', stored: false, secret: true }).gen, true)
})

test('UNA letra ya basta: el botón es por campo, no por formulario', () => {
  assert.equal(fieldOffers({ value: 'a', stored: false }).save, true)
})

test('los espacios no son contenido', () => {
  assert.deepEqual(fieldOffers({ value: '   ', stored: true }), { fill: true, save: false, gen: false })
})

// Lo que el dueño vio el 2026-08-29: guardó un campo en un registro y el botón se apagó,
// con los demás registros sin ese valor. El botón escondía trabajo de verdad —guardarlo
// también en el otro—, así que ya no se apaga por eso.
test('guardarlo en un registro no apaga el botón: los demás siguen sin tenerlo', () => {
  assert.equal(fieldOffers({ value: 'Quito', stored: true }).save, true)
})

// Y la regla completa, dicha como la dijo el dueño.
test('solo se esconde si está vacío y no hay nada guardado suyo', () => {
  for (const value of ['', '   ']) {
    assert.deepEqual(fieldOffers({ value, stored: false }), { fill: false, save: false, gen: false })
  }
  for (const f of [{ value: 'algo', stored: false }, { value: 'algo', stored: true }, { value: '', stored: true }]) {
    const { fill, save } = fieldOffers(f)
    assert.equal(fill || save, true, JSON.stringify(f) + ' se escondió y no debía')
  }
})

// Lo escrito NO se compara con lo guardado para decidir esto, y es a propósito: si el
// botón dependiera del valor, la página podría proponer uno y leer en el botón si acertó.
test('el marcador no depende de lo que haya guardado', () => {
  const a = fieldOffers({ value: 'la misma', stored: true })
  const b = fieldOffers({ value: 'otra distinta', stored: true })
  assert.deepEqual(a, b)
})

test('sin decirle nada, no ofrece nada', () => {
  assert.deepEqual(fieldOffers(), { fill: false, save: false, gen: false })
  assert.deepEqual(fieldOffers({}), { fill: false, save: false, gen: false })
})

test('la clave de un campo es su clase, y si no la tiene, su etiqueta', () => {
  assert.equal(fieldKey({ kind: 'email', label: 'Tu correo' }), 'email')
  assert.equal(fieldKey({ label: 'Número de socio' }), 'label:Número de socio')
  assert.equal(fieldKey({ label: '  ' }), 'other')
  assert.equal(fieldKey({}), 'other')
})

test('la clave del campo dice lo mismo en las dos puntas', () => {
  // Una en la página y otra en la bóveda: si dijeran cosas distintas, cada guardado
  // crearía un campo duplicado y el relleno nunca encontraría lo que hay guardado.
  for (const f of [
    { kind: 'email', label: 'Tu correo' },
    { label: 'Número de socio' },
    { label: '  ' },
    {},
  ]) assert.equal(fieldKey(f), fieldKeyLib(f), JSON.stringify(f))
})

test('los nombres de los campos salen, los valores no', () => {
  const keys = entryFieldKeys({
    username: 'ana@ejemplo.com',
    secret: 'clave-buena',
    fields: JSON.stringify([
      { label: 'Número de socio', value: 'SOC-4471' },
      { kind: 'city', label: 'Ciudad', value: 'Quito' },
      { label: 'Vacío', value: '' },
    ]),
  })
  assert.deepEqual(keys, ['username', 'secret', 'label:Número de socio', 'city'])
  // Lo que NO puede pasar: que un valor se cuele en la vista pública.
  assert.equal(JSON.stringify(keys).includes('SOC-4471'), false)
  assert.equal(JSON.stringify(keys).includes('clave-buena'), false)
})
