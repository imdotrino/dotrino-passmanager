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

/**
 * ¿El campo está a la vista? Solo la geometría: ni `disabled` ni `readOnly` entran aquí.
 *
 * Están separados porque las dos preguntas son distintas. Para RELLENAR hace falta poder
 * escribir; para LEER lo que el usuario ya envió, no — un campo de solo lectura con el
 * correo dentro es exactamente lo que hay que guardar.
 */
export function onScreen (el) {
  if (!el) return false
  if (el.type === 'hidden') return false
  const rects = el.getClientRects()
  if (!rects.length) return false
  const cs = el.ownerDocument.defaultView?.getComputedStyle(el)
  if (!cs) return true
  return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0'
}

/** ¿Se puede escribir en él? Un campo oculto o bloqueado no se rellena. */
export function isVisible (el) {
  if (!el || el.disabled || el.readOnly) return false
  return onScreen(el)
}

/**
 * La etiqueta visible de un campo, en las tres formas en que puede existir.
 *
 * Importa más que el `name`: los formularios generados ponen `name="field_2847"` y
 * dejan toda la información en la etiqueta, que es lo único que lee una persona.
 */
export function labelTextOf (el) {
  const partes = []
  const doc = el.ownerDocument
  const root = el.getRootNode?.() || doc

  // 1. `<label for="...">`. `labels` ya resuelve esto en el navegador, pero no cruza
  //    shadow roots, así que se busca también a mano dentro de la raíz del campo.
  if (el.labels?.length) {
    for (const l of el.labels) partes.push(l.textContent)
  } else if (el.id) {
    const escaped = (globalThis.CSS?.escape ? CSS.escape(el.id) : el.id.replace(/["\\]/g, '\\$&'))
    for (const l of root.querySelectorAll?.(`label[for="${escaped}"]`) || []) partes.push(l.textContent)
  }

  // 2. `<label>Correo <input></label>` — el campo va dentro de su etiqueta. Solo si
  //    no vino ya por `labels`, que también la incluye: si no, el texto sale doble.
  const envolvente = el.closest?.('label')
  if (envolvente && !(el.labels && [...el.labels].includes(envolvente))) {
    partes.push(envolvente.textContent)
  }

  // 3. `aria-labelledby`, que apunta a cualquier otro elemento.
  const by = el.getAttribute('aria-labelledby')
  if (by) {
    for (const id of by.split(/\s+/)) {
      const ref = root.getElementById?.(id) || doc.getElementById(id)
      if (ref) partes.push(ref.textContent)
    }
  }

  return partes.join(' ').replace(/\s+/g, ' ').trim()
}

/**
 * Compara una pista con el texto de un campo POR PALABRAS, no por subcadena.
 *
 * `includes` a secas es una trampa: la pista `q` del buscador coincidía con `q7`, con
 * `bloque` y con `izquierda`, así que descartaba campos buenos como si fueran cajas de
 * búsqueda. Las pistas cortas tienen que coincidir con una palabra entera; las largas
 * pueden coincidir dentro de una palabra compuesta (`firstName` → `firstname`).
 */
function matchesHint (texto, tokens, compacto, hint) {
  const h = hint.toLowerCase()
  if (tokens.includes(h)) return true
  const hc = h.replace(/[^a-z0-9áéíóúñü]/gi, '')
  return hc.length >= 4 && compacto.includes(hc)
}

function tokenize (texto) {
  return {
    tokens: texto.split(/[^a-z0-9áéíóúñü]+/i).filter(Boolean),
    compacto: texto.replace(/[^a-z0-9áéíóúñü]/gi, ''),
  }
}

function haystack (el) {
  return [
    // La etiqueta primero: es lo que el usuario lee, y suele ser lo único fiable
    // cuando el formulario está generado.
    labelTextOf(el),
    el.name, el.id, el.getAttribute('autocomplete'), el.getAttribute('aria-label'),
    el.placeholder, el.getAttribute('data-testid'), el.getAttribute('data-test'),
  ].filter(Boolean).join(' ').toLowerCase()
}

function looksLikeUser (el) {
  if (el.type === 'email' || el.type === 'tel') return true
  const h = haystack(el)
  const { tokens, compacto } = tokenize(h)
  if (SEARCH_HINTS.some(s => matchesHint(h, tokens, compacto, s))) return false
  return USER_HINTS.some(s => matchesHint(h, tokens, compacto, s))
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
  const { tokens, compacto } = tokenize(h)
  if (SEARCH_HINTS.some(x => matchesHint(h, tokens, compacto, x))) return null
  for (const [kind, hints] of Object.entries(HINTS_BY_KIND)) {
    if (hints.some(x => matchesHint(h, tokens, compacto, x))) return kind
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

/**
 * LO ESCRITO en un formulario que se acaba de enviar: `[{ kind, value }]`.
 *
 * Es la otra mitad de `findDataFields`, y son distintas a propósito: aquella busca
 * huecos donde ofrecer un dato guardado, y esta lee lo que el usuario ACABA de poner
 * para poder guardarlo. De ahí las dos diferencias:
 *
 *   · admite campos de **solo lectura** (una pantalla de confirmación los deja así, y
 *     el dato sigue siendo el suyo), pero nunca ocultos: ahí vive tanto el correo como
 *     el token de turno, y guardar basura con cara de dato es peor que no guardar;
 *   · se queda solo con los que tienen algo escrito.
 *
 * Una clase por captura: dos casillas de correo en la misma página son el mismo correo
 * repetido o el de otra persona, y ninguna de las dos cosas se resuelve adivinando.
 *
 * @param {Element|Document} scope  el formulario enviado, o el documento entero
 * @param {object} opts  `{ skip }` — campos ya contados por otra vía (usuario, contraseña)
 */
export function readDataFields (scope = document, { skip = [] } = {}) {
  const fuera = new Set(skip.filter(Boolean))
  const out = []
  const vistos = new Set()
  for (const el of collectInputs(scope)) {
    if (fuera.has(el)) continue
    if (el.type === 'password' || el.disabled || !onScreen(el)) continue
    const value = String(el.value || '').trim()
    if (!value) continue
    const kind = kindOf(el)
    if (!kind || vistos.has(kind)) continue
    vistos.add(kind)
    out.push({ kind, value })
  }
  return out
}

/**
 * DE QUIÉN es la contraseña que se acaba de escribir — que no es lo mismo que en qué
 * campo se podría rellenar el usuario.
 *
 * En un acceso de dos pantallas (Google, Microsoft y media web detrás) el usuario llega
 * a la segunda en un campo de **solo lectura**. Ahí no se puede escribir, así que no se
 * marca y `findLoginForms` no lo devuelve — pero es justo de donde hay que leer quién
 * es. Sin esto el aviso de guardar salía sin usuario, y una credencial sin usuario no
 * sirve para volver a entrar.
 *
 * Los `hidden` se quedan fuera a propósito: ahí vive tanto el usuario como el token de
 * turno, y confundirlos guardaría basura con cara de cuenta.
 */
export function readUsername ({ form, username, password } = {}) {
  if (username?.value) return username.value
  if (!password) return ''
  const scope = form || password.getRootNode?.() || password.ownerDocument
  const inputs = [...(scope.querySelectorAll?.('input') || [])]
  const i = inputs.indexOf(password)
  const before = i > 0 ? inputs.slice(0, i) : []
  // De atrás hacia delante: el más cercano a la contraseña que tenga algo escrito.
  for (let k = before.length - 1; k >= 0; k--) {
    const el = before[k]
    if (!['text', 'email', 'tel', ''].includes(el.type)) continue
    if (el.value) return el.value
  }
  return ''
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
