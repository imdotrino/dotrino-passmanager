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
