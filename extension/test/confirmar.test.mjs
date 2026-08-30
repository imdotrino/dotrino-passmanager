// «Repite la contraseña»: cuándo SÍ y cuándo NO.
//
// Es la regla más cara de equivocar de toda la extensión. Si se confunde la casilla de
// confirmar con la de «contraseña actual», generar una contraseña la escribiría en las
// dos y el usuario se quedaría fuera de su cuenta. Por eso `confirmFor` es estrecha a
// propósito y por eso se prueba aquí, caso por caso.
//
// Se prueba con campos de mentira en vez de un navegador porque la regla es pura: entra
// cómo se llama cada casilla y sale cuál es la de confirmar, si es que hay alguna.
//
//   npm run test:offers      (necesita el vendor: npm --prefix extension run build)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { confirmFor, findLoginForms } from '../src/detect.js'

/** Una casilla de contraseña de mentira, con lo justo que mira `detect.js`. */
function input (attrs = {}) {
  const { name = '', id = '', placeholder = '', autocomplete = '', label = '' } = attrs
  const el = {
    tagName: 'INPUT',
    type: 'password',
    name,
    id,
    placeholder,
    disabled: false,
    readOnly: false,
    labels: label ? [{ textContent: label }] : [],
    value: '',
    getAttribute: (k) => (k === 'autocomplete' ? autocomplete : null),
    getClientRects: () => [{ width: 120, height: 24 }],
    getRootNode: () => ({ querySelectorAll: () => [], getElementById: () => null }),
    closest: () => null,
    ownerDocument: { defaultView: null, getElementById: () => null },
  }
  return el
}

test('registro: «repite la contraseña» se reconoce por su etiqueta', () => {
  const pass = input({ name: 'password' })
  const rep = input({ name: 'password2', label: 'Repite la contraseña' })
  assert.equal(confirmFor(pass, [pass, rep]), rep)
})

test('y en inglés, y por el nombre del campo', () => {
  for (const attrs of [
    { name: 'confirm_password' },
    { name: 'passwordConfirmation' },
    { placeholder: 'Repeat password' },
    { label: 'Confirmar contraseña' },
    { label: 'Verify your password' },
    { placeholder: 'Type it again' },
  ]) {
    const pass = input({ name: 'password' })
    const rep = input(attrs)
    assert.equal(confirmFor(pass, [pass, rep]), rep, JSON.stringify(attrs))
  }
})

test('sin nada que la delate, vale que las DOS se declaren nuevas', () => {
  // Un registro bien hecho pone `autocomplete="new-password"` en las dos casillas.
  const pass = input({ name: 'p1', autocomplete: 'new-password' })
  const rep = input({ name: 'p2', autocomplete: 'new-password' })
  assert.equal(confirmFor(pass, [pass, rep]), rep)
})

// LO QUE NO PUEDE PASAR, que es el motivo de que esto exista.
test('cambiar la contraseña: la de al lado NO es la de confirmar', () => {
  // actual · nueva · repite la nueva. `findLoginForms` se queda con la primera («actual»),
  // y la siguiente es «nueva»: escribir la misma en las dos dejaría al usuario fuera.
  const actual = input({ name: 'current_password', autocomplete: 'current-password' })
  const nueva = input({ name: 'new_password', autocomplete: 'new-password' })
  const repite = input({ name: 'confirm_new_password', autocomplete: 'new-password' })
  assert.equal(confirmFor(actual, [actual, nueva, repite]), null)
})

test('tampoco se salta una casilla para buscar la de confirmar más abajo', () => {
  const pass = input({ name: 'password' })
  const otra = input({ name: 'pin' })
  const rep = input({ name: 'confirm_password' })
  assert.equal(confirmFor(pass, [pass, otra, rep]), null)
})

test('un acceso normal no tiene casilla de confirmar', () => {
  const pass = input({ name: 'password' })
  assert.equal(confirmFor(pass, [pass]), null)
})

test('una casilla escondida o bloqueada no se rellena', () => {
  const pass = input({ name: 'password' })
  const rep = input({ name: 'confirm_password' })
  rep.disabled = true
  assert.equal(confirmFor(pass, [pass, rep]), null)
  const rep2 = input({ name: 'confirm_password' })
  rep2.getClientRects = () => []
  assert.equal(confirmFor(pass, [pass, rep2]), null)
})

test('sin decirle nada no devuelve nada', () => {
  assert.equal(confirmFor(input()), null)
  assert.equal(confirmFor(input(), []), null)
})

test('findLoginForms devuelve la casilla de confirmar con el formulario', () => {
  // El documento de mentira: `collectInputs` recorre `*` y `findLoginForms` filtra.
  const pass = input({ name: 'password', autocomplete: 'new-password' })
  const rep = input({ name: 'confirm_password', autocomplete: 'new-password' })
  const user = { ...input({ name: 'email' }), type: 'email' }
  for (const el of [user, pass, rep]) el.form = null
  const doc = { querySelectorAll: () => [user, pass, rep] }
  const forms = findLoginForms(doc)
  assert.equal(forms.length, 1)
  assert.equal(forms[0].password, pass)
  assert.equal(forms[0].username, user)
  assert.equal(forms[0].confirm, rep)
})
