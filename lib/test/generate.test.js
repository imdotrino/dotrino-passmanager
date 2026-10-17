import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generatePassword, generatePassphrase } from '../src/generate.js'

test('generar: el largo y los grupos pedidos se cumplen de verdad', () => {
  const p = generatePassword({ length: 24 })
  assert.equal(p.length, 24)
  assert.match(p, /[a-z]/)
  assert.match(p, /[A-Z]/)
  assert.match(p, /[0-9]/)
  assert.match(p, /[!#$%&*+\-=?@_]/)

  // «Sin símbolos» tiene que significar sin símbolos, no «casi nunca».
  for (let i = 0; i < 200; i++) {
    assert.doesNotMatch(generatePassword({ symbols: false, length: 12 }), /[!#$%&*+\-=?@_]/)
  }
})

test('generar: sin ambiguos no salen l, I, O, 0 ni 1', () => {
  for (let i = 0; i < 300; i++) {
    assert.doesNotMatch(generatePassword({ length: 30 }), /[lIO01]/)
  }
})

test('generar: los obligatorios NO quedan siempre al principio', () => {
  // Sin barajar, el primer carácter sería siempre minúscula. Con 300 intentos, que
  // TODOS empiecen por minúscula sería una casualidad de 1 entre 10^36.
  const primeros = new Set(Array.from({ length: 300 }, () => generatePassword({ length: 16 })[0]))
  assert.ok(primeros.size > 3, 'el primer carácter apenas varía: ¿se barajó?')
})

test('generar: dos contraseñas seguidas no se repiten', () => {
  const vistas = new Set(Array.from({ length: 500 }, () => generatePassword({ length: 16 })))
  assert.equal(vistas.size, 500)
})

test('generar: el reparto de caracteres no está sesgado', () => {
  // UN SOLO grupo, a propósito. Mezclando alfabetos el test se vuelve intermitente sin
  // que haya nada roto: cada contraseña garantiza un carácter de cada grupo pedido, así
  // que con 25 minúsculas y 8 dígitos los dígitos salen legítimamente más. Ese sesgo es
  // el deseado; el que se busca aquí es el de `% alfabeto.length`, que repartiría de
  // más los primeros caracteres del alfabeto.
  const cuenta = new Map()
  for (let i = 0; i < 600; i++) {
    for (const c of generatePassword({ length: 16, upper: false, digits: false, symbols: false })) {
      cuenta.set(c, (cuenta.get(c) || 0) + 1)
    }
  }
  const valores = [...cuenta.values()]
  assert.equal(cuenta.size, 25, 'no salieron todas las letras')
  // ~384 esperados por letra: con sesgo de módulo la diferencia sería sistemática.
  assert.ok(Math.max(...valores) < Math.min(...valores) * 1.6, 'reparto sesgado')
})

test('generar: un largo absurdo no rompe nada', () => {
  assert.equal(generatePassword({ length: 1 }).length, 4, 'no cabe ni un carácter por grupo')
  assert.equal(generatePassword({ length: 999 }).length, 256)
  assert.equal(generatePassword({ length: NaN }).length, 20)
})

test('generar: frase de palabras', () => {
  const palabras = Array.from({ length: 64 }, (_, i) => 'palabra' + i)
  const f = generatePassphrase(palabras, { count: 5 })
  assert.equal(f.split('-').length, 5)
  assert.throws(() => generatePassphrase(['pocas']))
})
