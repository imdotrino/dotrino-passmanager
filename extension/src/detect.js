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

// «Repite la contraseña». Solo sirven para RECONOCER la segunda casilla de un registro,
// nunca para adivinar: si no coincide ninguna, no hay campo de confirmar y no se toca.
const CONFIRM_HINTS = ['confirm', 'repeat', 'repet', 'repit', 'again', 'retype', 'verify', 'verific']

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
  // Un `Set` y no una lista: **el mismo texto por dos vías es una etiqueta, no dos**. La
  // consola de AWS pone `<label for>` y `aria-labelledby` apuntando al mismo elemento, y
  // sumándolos la etiqueta salía repetida y recortada a 60 — «Account ID or alias(Don't
  // have?) Account ID or alias(Don't h». Y esa etiqueta no es cosmética: un campo libre
  // se identifica POR ella (§4.2), así que repetida es otra clave.
  const partes = new Set()
  const doc = el.ownerDocument
  const root = el.getRootNode?.() || doc

  // 1. `<label for="...">`. `labels` ya resuelve esto en el navegador, pero no cruza
  //    shadow roots, así que se busca también a mano dentro de la raíz del campo.
  if (el.labels?.length) {
    for (const l of el.labels) partes.add(norm(l.textContent))
  } else if (el.id) {
    const escaped = (globalThis.CSS?.escape ? CSS.escape(el.id) : el.id.replace(/["\\]/g, '\\$&'))
    for (const l of root.querySelectorAll?.(`label[for="${escaped}"]`) || []) partes.add(norm(l.textContent))
  }

  // 2. `<label>Correo <input></label>` — el campo va dentro de su etiqueta. Solo si
  //    no vino ya por `labels`, que también la incluye: si no, el texto sale doble.
  const envolvente = el.closest?.('label')
  if (envolvente && !(el.labels && [...el.labels].includes(envolvente))) {
    partes.add(norm(envolvente.textContent))
  }

  // 3. `aria-labelledby`, que apunta a cualquier otro elemento.
  const by = el.getAttribute('aria-labelledby')
  if (by) {
    for (const id of by.split(/\s+/)) {
      const ref = root.getElementById?.(id) || doc.getElementById(id)
      if (ref) partes.add(norm(ref.textContent))
    }
  }

  partes.delete('')
  return [...partes].join(' ')
}

/** El texto de un nodo en una sola línea, que es como se compara y como se enseña. */
const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim()

// Lo que puede llevar un dato. Los botones no cuentan: el ojo de «ver contraseña» vive en
// el mismo grupo que su casilla, y contarlo partiría el grupo en dos.
const CONTROL = 'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]), select, textarea'
// Texto que está al lado de un campo y NO lo nombra: el título de la sección, un botón,
// un enlace de «¿la olvidaste?», o lo que no se pinta.
const NOT_LABEL = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LEGEND', 'BUTTON', 'A',
  'SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'SVG'])
// Una etiqueta es corta. Un párrafo al lado de un campo es ayuda, no su nombre.
const MAX_LABEL = 60
// Hasta dónde se sube buscando el grupo del campo.
const MAX_UP = 5

const hasControl = (n) => n.nodeType === 1 && (n.matches(CONTROL) || !!n.querySelector(CONTROL))

/**
 * El texto de un vecino, si puede ser una etiqueta: corto y sin el asterisco de obligatorio.
 * Sin lo que llevan dentro sus botones y enlaces — el «?» de la ayuda no es parte del nombre.
 */
function labelTextFrom (n) {
  const parts = []
  const collect = (x) => {
    if (x.nodeType === 3) { parts.push(x.nodeValue); return }
    if (x.nodeType !== 1 || NOT_LABEL.has(x.tagName.toUpperCase())) return
    for (const child of x.childNodes) collect(child)
  }
  collect(n)
  const t = norm(parts.join('')).replace(/\s*[*:]+$/, '').trim()
  return t.length <= MAX_LABEL ? t : ''
}

/**
 * LA ETIQUETA QUE SE VE pero que el sitio no ATÓ al campo: un `<label>` sin `for`, un
 * `<span>` o un `<p>` encima de la casilla. Es lo más corriente en las apps hechas con React
 * y Tailwind, y sin esto todos sus campos se quedaban sin nombre — y como un campo libre se
 * identifica por su nombre (§4.2), acababan todos con la clave `other` y solo se marcaba el
 * primero (dueño, 2026-09-16, en el editor de un panel hecho con Next.js).
 *
 * Es lo mismo que hace el autocompletado de Chrome cuando no hay `<label for>`: mirar lo que
 * hay justo antes del campo. Y es **estrecho a propósito**, porque un nombre equivocado es
 * peor que ninguno —con él se rellena—:
 *
 *   · se mira el vecino MÁS CERCANO hacia atrás, nunca todo el texto de alrededor;
 *   · se sube de level solo mientras el contenedor tenga UN solo campo: en cuanto hay dos,
 *     el texto de más arriba ya no es de este;
 *   · un vecino que contiene otro campo corta la búsqueda: lo que venga antes es suyo;
 *   · los títulos de sección, botones y enlaces no son etiquetas, y un texto largo tampoco.
 *
 * Si no aparece nada así, no se inventa: sale vacío.
 */
export function inferredLabelOf (el) {
  let node = el
  for (let level = 0; level < MAX_UP && node; level++) {
    for (let sib = node.previousSibling; sib; sib = sib.previousSibling) {
      if (sib.nodeType === 3) {
        const t = labelTextFrom(sib)
        if (t) return t
        continue
      }
      if (sib.nodeType !== 1) continue
      if (hasControl(sib)) return ''
      const t = labelTextFrom(sib)
      if (t) return t
    }
    // La etiqueta flotante va DESPUÉS del campo (`<input><label>Usuario</label>`), pero
    // solo como `<label>`: cualquier otro texto de detrás suele ser la ayuda o el error.
    for (let sib = node.nextElementSibling; sib; sib = sib.nextElementSibling) {
      if (hasControl(sib)) break
      if (sib.tagName.toUpperCase() !== 'LABEL') continue
      const t = labelTextFrom(sib)
      if (t) return t
    }
    const parent = node.parentElement
    if (!parent || parent.tagName.toUpperCase() === 'FORM' || parent === el.ownerDocument.body) return ''
    if (parent.querySelectorAll(CONTROL).length > 1) return ''
    node = parent
  }
  return ''
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

/**
 * CÓMO SE LLAMA un campo, para poder guardarlo con un nombre que signifique algo.
 *
 * Los campos libres del modelo son `{ label, value }` (§4.2): sin `kind`, la etiqueta es
 * su única identidad — es lo que se enseña, y es por lo que se empareja con lo guardado.
 * Se coge lo que lee una persona antes que lo que lee la máquina.
 */
export function fieldLabel (el) {
  const visto = labelTextOf(el)
  // Lo que el sitio DECLARA va antes que lo que se deduce de la posición, y lo deducido
  // antes que `name` e `id`, que son para la máquina (`field_2847`).
  const texto = visto ||
    el.getAttribute('aria-label') || el.placeholder || inferredLabelOf(el) ||
    el.name || el.id || ''
  return String(texto).replace(/\s+/g, ' ').trim().slice(0, 60)
}

/**
 * La CLAVE de un campo: su clase si se reconoce, y si no, su etiqueta.
 *
 * Es lo que empareja el campo de la página con lo guardado, y lo que viaja en el aviso
 * como «esta fila». Un campo libre no tiene más identidad que su nombre.
 */
export function fieldKey ({ kind, label } = {}) {
  if (kind) return kind
  const l = String(label || '').trim()
  return l ? `label:${l}` : 'other'
}

function haystack (el) {
  return [
    // La etiqueta primero: es lo que el usuario lee, y suele ser lo único fiable
    // cuando el formulario está generado.
    labelTextOf(el) || inferredLabelOf(el),
    el.name, el.id, el.getAttribute('autocomplete'), el.getAttribute('aria-label'),
    el.placeholder, el.getAttribute('data-testid'), el.getAttribute('data-test'),
  ].filter(Boolean).join(' ').toLowerCase()
}

/** ¿Es una caja de búsqueda? Lo que se escribe ahí no es un dato de nadie. */
export function looksLikeSearch (el) {
  const h = haystack(el)
  const { tokens, compacto } = tokenize(h)
  if (el.type === 'search') return true
  return SEARCH_HINTS.some(s => matchesHint(h, tokens, compacto, s))
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

    forms.push({ form: password.form || null, password, username, confirm: confirmFor(password, sameScope) })
  }
  return forms
}

/**
 * EL CAMPO DE «repite la contraseña», si es que lo hay — y solo si se reconoce.
 *
 * Existe por el generador (§4.1.1): una contraseña nueva se escribe en las DOS casillas de
 * un registro, y dejar la segunda vacía obliga a copiarla a mano, que es exactamente la
 * fricción por la que la gente acaba escribiendo la de siempre.
 *
 * Es deliberadamente estrecho, porque equivocarse aquí es caro: en un cambio de
 * contraseña las tres casillas son «actual», «nueva» y «repite la nueva», y escribir la
 * misma en la actual y en otra dejaría al usuario fuera de su cuenta. Así que se pide:
 *
 *   · que sea la SIGUIENTE del mismo ámbito (no una cualquiera más abajo), y
 *   · que se reconozca como confirmación — por su texto, o porque las dos declaran
 *     `autocomplete="new-password"`, que es lo que pone un registro bien hecho.
 *
 * En un cambio de contraseña la siguiente de «actual» es «nueva», que no es ninguna de
 * las dos cosas: sale `null` y no se toca nada, que es lo correcto.
 */
export function confirmFor (password, sameScope = []) {
  const next = sameScope[sameScope.indexOf(password) + 1]
  if (!next || !isVisible(next)) return null
  const h = haystack(next)
  const { tokens, compacto } = tokenize(h)
  if (CONFIRM_HINTS.some(x => matchesHint(h, tokens, compacto, x))) return next
  const nueva = (el) =>
    (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/).includes('new-password')
  return nueva(password) && nueva(next) ? next : null
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
  const declarado = !!declared && declared !== 'off' && declared !== 'on'
  if (declarado) {
    for (const token of declared.split(/\s+/).reverse()) {
      if (AUTOCOMPLETE_TO_KIND[token]) return AUTOCOMPLETE_TO_KIND[token]
    }
  }

  // 2. El tipo del input, que también es una declaración.
  if (el.type === 'email') return 'email'
  if (el.type === 'tel') return 'tel'

  // 2b. DECLARÓ, y no es ninguna de nuestras clases: se acabó. No se adivina por encima
  //     de lo que el sitio dijo — sería inventarse un dato distinto del que hay.
  //
  //     El caso que lo puso aquí: `autocomplete="nickname"` en el nombre visible del
  //     perfil. `nickname` no es una clase del modelo, así que se seguía a las pistas, y
  //     ahí la etiqueta en español —«Tu nombre visible»— lleva la palabra «nombre» y lo
  //     convertía en `given-name`, robándole la clase al campo Nombres. Un campo sin
  //     clase no se pierde: es un campo libre y se identifica por su etiqueta (§4.2).
  if (declarado) return null

  // 3. Y si no, las pistas. Un buscador nunca es un dato personal.
  const h = haystack(el)
  const { tokens, compacto } = tokenize(h)
  if (SEARCH_HINTS.some(x => matchesHint(h, tokens, compacto, x))) return null
  for (const [kind, hints] of Object.entries(HINTS_BY_KIND)) {
    if (hints.some(x => matchesHint(h, tokens, compacto, x))) return kind
  }
  return null
}

// Tipos de `input` que no contienen un dato del usuario por mucho que tengan `value`:
// una casilla marcada vale «on», y un botón vale su rótulo.
const NOT_DATA = ['password', 'hidden', 'checkbox', 'radio', 'submit', 'button', 'reset', 'file', 'image']

/**
 * Campos de la página que NO son usuario ni contraseña.
 *
 * Devuelve `[{ el, kind, free, label }]`, sin repetir: si hay dos casillas de correo, se
 * usa la primera visible y no se inventa nada con la otra.
 *
 * Con `free` entran también **los que no se reconocen** —el código del portal, el número
 * de socio, lo que sea—, que no tienen `kind` y se identifican por su etiqueta. Solo
 * sirven para GUARDAR lo que el usuario escribió: para rellenarlos habría que saber qué
 * etiqueta guarda cada entrada, y eso está dentro (§4.0.2), así que no se ofrece.
 */
export function findDataFields (doc = document, { free = false } = {}) {
  const out = []
  const vistos = new Set()
  for (const el of collectInputs(doc).filter(isVisible)) {
    if (NOT_DATA.includes(el.type)) continue
    if (looksLikeSearch(el)) continue
    const kind = kindOf(el)
    if (kind) {
      // DOS campos de la misma clase se marcan LOS DOS. Antes el segundo se descartaba,
      // y era un descarte mudo: en profile.dotrino.com la etiqueta del nombre visible
      // lleva la palabra «nombre», que en español es pista de `given-name`, se quedaba
      // con la clase, y el campo Nombres —con dato dentro— se quedaba sin marcador
      // (dueño, 2026-09-11). El mismo formulario se comportaba distinto según el idioma.
      //
      // Enseñar un botón NO es guardar, así que aquí no hay nada que deduplicar: en una
      // segunda casilla de correo lo útil es poder poner el correo que ya tienes. Quien
      // sí deduplica es `readDataFields`, al capturar, y por eso se deja la clase puesta
      // en vez de bajar el campo a libre: si no, las dos mitades se contarían distinto.
      out.push({ el, kind })
      continue
    }
    if (!free) continue
    const label = fieldLabel(el)
    const key = fieldKey({ label })
    if (vistos.has(key)) continue
    vistos.add(key)
    out.push({ el, kind: null, free: true, label })
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
    if (NOT_DATA.includes(el.type) || el.disabled || !onScreen(el)) continue
    if (looksLikeSearch(el)) continue
    const value = String(el.value || '').trim()
    if (!value) continue
    const kind = kindOf(el)
    const label = fieldLabel(el)
    const key = fieldKey({ kind, label })
    if (vistos.has(key)) continue
    vistos.add(key)
    // Sin clase reconocida, el campo se guarda por su etiqueta: es libre (§4.2), no es
    // un dato de segunda. Lo que no tiene ni etiqueta ni nombre se guarda como «otro».
    out.push(kind ? { kind, label, value } : { label, value })
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

/**
 * QUÉ puede hacer el gestor en ESTE campo. De aquí sale si se marca o no (§4.1).
 *
 * **La regla es por CAMPO, no por formulario**, y desde el 2026-08-29 es UNA sola frase
 * del dueño: *«el botón solo se esconde si el field está vacío y no existe un record con
 * su valor»*.
 *
 * | | el campo está vacío | tiene algo escrito |
 * |---|---|---|
 * | **nada guardado suyo** | sin botón | **guardar** |
 * | **algo guardado suyo** | **rellenar** | **guardar** |
 *
 * **Y una casilla más, para las contraseñas (§4.1.1): una contraseña vacía SIEMPRE ofrece
 * generar una**, haya algo guardado o no. Es la única forma de que el generador esté
 * donde de verdad hace falta —al registrarse, que es cuando se inventa una contraseña—,
 * y hasta ahora vivía solo en la CLI, donde no se registra nadie. Un gestor que no genera
 * obliga a inventárselas, y ahí es donde se repite la de siempre (DISENO §4.0).
 *
 * Esto **no reabre el rastro** que cerró la regla de arriba: `gen` depende solo de que el
 * campo sea de contraseña y esté vacío, y las dos cosas las sabe ya la página —el
 * `type="password"` lo escribió ella—. No se consulta la bóveda, así que no hay nada que
 * leer mirando si el botón aparece.
 *
 * Lo que cambió, y por qué: antes el botón desaparecía cuando lo escrito ya estaba
 * guardado igual. Con varias entradas eso escondía trabajo de verdad —**la otra entrada
 * podría querer ese mismo dato y no tenerlo**—, así que el botón se iba justo cuando
 * quedaba algo que hacer. Es lo que el dueño vio: guardó un campo en un registro y el
 * botón se apagó, con los demás registros sin ese valor.
 *
 * Y de paso desaparece un rastro: comparar lo escrito con lo guardado dejaba que la
 * página propusiera un valor y mirara si el botón se apagaba. Ahora lo que se marca no
 * depende de ningún valor guardado, así que no hay nada que leer ahí. La comparación
 * sigue existiendo, pero **dentro** —en el modal y en el aviso, que son pantallas de la
 * extensión (§4.0.2)—, que es donde de verdad hace falta.
 *
 * Dos cosas más que se leen en la tabla:
 *
 * - Con **una sola letra** escrita ya hay botón. Antes el de un acceso miraba la
 *   contraseña del formulario, así que escribir el usuario no encendía nada y parecía
 *   que había que llenarlo todo.
 * - **Rellenar solo en un campo vacío**: escribir encima de lo que puso el usuario sería
 *   decidir por él, y lo que quiere ahí es guardar lo suyo.
 *
 * Pura a propósito: `stored` lo calcula el service worker, que es el único que puede
 * mirar la bóveda. Aquí está la regla y nada más.
 *
 * @param {object} f `{ value, stored, secret }` — `secret` = es un campo de contraseña
 */
export function fieldOffers ({ value, stored, secret } = {}) {
  const lleno = !!String(value ?? '').trim()
  return { fill: !lleno && !!stored, save: lleno, gen: !lleno && !!secret }
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
