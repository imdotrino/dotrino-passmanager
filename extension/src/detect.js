// Detección de formularios de acceso.
//
// Es la parte que decide si el gestor sirve o no (DISENO §8): la web real tiene
// campos ocultos, formularios que se remontan enteros, accesos en dos pasos y sitios
// que renombran sus inputs en cada despliegue. Aquí no se adivina de más: si no se
// reconoce un campo, no se rellena nada — rellenar el campo equivocado es peor que no
// rellenar.

const USER_HINTS = [
  'user', 'usuario', 'login', 'email', 'correo', 'mail', 'account', 'cuenta',
  'identifier', 'identificador', 'nick', 'handle', 'phone', 'telefono',
]

const SEARCH_HINTS = ['search', 'buscar', 'query', 'q']

/** ¿El elemento está de verdad a la vista? Un campo oculto no se rellena. */
export function isVisible (el) {
  if (!el || el.disabled || el.readOnly) return false
  if (el.type === 'hidden') return false
  const rects = el.getClientRects()
  if (!rects.length) return false
  const cs = el.ownerDocument.defaultView?.getComputedStyle(el)
  if (!cs) return true
  return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0'
}

function haystack (el) {
  return [
    el.name, el.id, el.getAttribute('autocomplete'), el.getAttribute('aria-label'),
    el.placeholder, el.getAttribute('data-testid'),
  ].filter(Boolean).join(' ').toLowerCase()
}

function looksLikeUser (el) {
  if (el.type === 'email' || el.type === 'tel') return true
  const h = haystack(el)
  if (SEARCH_HINTS.some(s => h.includes(s))) return false
  return USER_HINTS.some(s => h.includes(s))
}

/**
 * Todos los `input` de un documento, entrando también en los shadow roots abiertos.
 *
 * Recorre `*` a propósito: cualquier elemento puede ser el host de un shadow root, y
 * filtrar por etiqueta o por clase deja fuera los componentes que no las usan — que
 * es justo lo que pasaba con `<div id="host">`. Es una pasada por el DOM, y el
 * observador que la dispara ya viene con freno.
 */
export function collectInputs (root = document, out = [], depth = 0) {
  if (depth > 10) return out
  for (const el of root.querySelectorAll('*')) {
    if (el.tagName === 'INPUT') out.push(el)
    if (el.shadowRoot) collectInputs(el.shadowRoot, out, depth + 1)
  }
  return out
}

/**
 * Encuentra los formularios de acceso de la página.
 * Devuelve `[{ form, password, username }]` — `username` puede ser null en un acceso
 * de dos pasos, donde la contraseña llega en una pantalla sin usuario.
 */
export function findLoginForms (doc = document) {
  const inputs = collectInputs(doc).filter(isVisible)
  const passwords = inputs.filter(el => el.type === 'password')
  const forms = []

  for (const password of passwords) {
    // Registrarse suele traer dos contraseñas seguidas (la de confirmar): no es acceso.
    const scope = password.form || doc
    const sameScope = passwords.filter(p => (p.form || doc) === scope)
    if (sameScope.length > 1 && sameScope.indexOf(password) > 0) continue

    const before = inputs.slice(0, inputs.indexOf(password))
    const candidates = before.filter(el =>
      ['text', 'email', 'tel', ''].includes(el.type) && (el.form || doc) === scope)

    // El más cercano hacia atrás que parezca un usuario; si ninguno lo parece pero hay
    // exactamente uno, se acepta — es el caso corriente de un formulario sin `name`.
    let username = null
    for (let i = candidates.length - 1; i >= 0; i--) {
      if (looksLikeUser(candidates[i])) { username = candidates[i]; break }
    }
    if (!username && candidates.length === 1) username = candidates[0]

    forms.push({ form: password.form || null, password, username })
  }
  return forms
}

// --- Campos que no son usuario ni contraseña ---------------------------------
//
// Correo, teléfono, dirección, cédula: lo que el usuario guardó con una `kind`. Se
// mira primero el `autocomplete` que declara el sitio —cuando está, no hay nada que
// adivinar— y solo si no lo declara se recurre a las pistas del nombre.

import { AUTOCOMPLETE_BY_KIND, HINTS_BY_KIND } from './vendor/passmanager/fields.js'

const AUTOCOMPLETE_TO_KIND = {}
for (const [kind, tokens] of Object.entries(AUTOCOMPLETE_BY_KIND)) {
  for (const t of tokens) AUTOCOMPLETE_TO_KIND[t] = kind
}

/** Qué clase de dato pide este input, o null si no se sabe. */
export function kindOf (el) {
  if (el.type === 'password') return null

  // 1. Lo que el sitio declara. `autocomplete` admite prefijos de sección y de tipo
  //    (`shipping email`, `section-a billing tel`): manda el último token conocido.
  const declared = (el.getAttribute('autocomplete') || '').toLowerCase().trim()
  if (declared && declared !== 'off' && declared !== 'on') {
    for (const token of declared.split(/\s+/).reverse()) {
      if (AUTOCOMPLETE_TO_KIND[token]) return AUTOCOMPLETE_TO_KIND[token]
    }
  }

  // 2. El tipo del input, que también es una declaración.
  if (el.type === 'email') return 'email'
  if (el.type === 'tel') return 'tel'

  // 3. Y si no, las pistas. Un buscador nunca es un dato personal.
  const h = haystack(el)
  if (SEARCH_HINTS.some(x => h.includes(x))) return null
  for (const [kind, hints] of Object.entries(HINTS_BY_KIND)) {
    if (hints.some(x => h.includes(x))) return kind
  }
  return null
}

/**
 * Campos rellenables de la página que NO son usuario ni contraseña.
 * Devuelve `[{ el, kind }]`, sin repetir clase: si hay dos casillas de correo, se
 * rellena la primera visible y no se inventa nada con la otra.
 */
export function findDataFields (doc = document) {
  const out = []
  const vistos = new Set()
  for (const el of collectInputs(doc).filter(isVisible)) {
    if (el.type === 'password' || el.type === 'hidden') continue
    const kind = kindOf(el)
    if (!kind || vistos.has(kind)) continue
    vistos.add(kind)
    out.push({ el, kind })
  }
  return out
}

/** Rellena como si lo escribiera una persona: los frameworks escuchan estos eventos. */
export function fillField (el, value) {
  if (!el) return false
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  el.focus()
  if (setter) setter.call(el, value)
  else el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  el.blur()
  return true
}
