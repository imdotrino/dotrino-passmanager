// EL GESTOR DE REGISTROS: administrar lo guardado, en su propia pestaña (DISENO §4.3).
//
// Es una página de la extensión (`chrome-extension://…/src/manager.html`), no un sitio
// web, y eso es lo que le permite pedir cualquier operación: la lista recortada de
// operaciones es para las páginas ajenas. Se abre desde el popup, con `chrome.tabs.create`.
//
// **Por qué existe aparte del popup.** El popup es lo rápido del sitio que tienes
// delante: rellenar, copiar, cuál es la predeterminada. Editar un registro no tiene nada
// que ver con la página en la que estás (dueño, 2026-08-29) y no cabe en 360 px.
//
// **NO trae valores privados, ni aquí ni en ningún sitio.** Un campo privado se enseña
// tapado y se puede REEMPLAZAR escribiendo encima; para saber si lo escrito cambia algo
// se comparan resúmenes (§4.0.2), que es lo mismo que hacen el aviso y el modal del campo
// — un método de comparación, no dos.
//
// **Un botón para todo**: los cambios de la ficha entera se guardan de una vez, o se
// cancelan de una vez (dueño, 2026-08-29). Nada de guardar campo a campo.
//
// Sin `alert`/`confirm`/`prompt` (CONVENCIONES §5).

import { pickLang, t, kindLabel } from './i18n.js'
import { KINDS } from './vendor/passmanager/fields.js'
// La bóveda puede preguntar mientras esta pestaña está delante (no por editar —que no
// saca nada—, pero sí si el usuario copia algo desde aquí más adelante): la pregunta sale
// en esta misma página, como en el resto de pantallas de la extensión.
import { hostApprovals } from './approval.js'

hostApprovals()

let lang = pickLang()
const view = document.getElementById('view')
const toastEl = document.getElementById('toast')
const sectionEl = document.getElementById('section')

// Los cuatro de siempre. No son campos libres: no se pueden borrar de la entrada, se
// vacían; y tres de ellos son privados por lo que son, no por una marca (§4.2).
const BUILTIN = ['username', 'secret', 'totp', 'notes']
const SIEMPRE_PRIVADOS = ['secret', 'totp', 'notes']

function ask (op, payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ op, payload }, r => {
      if (chrome.runtime.lastError) return reject(new Error('unreachable'))
      if (r?.error) return reject(Object.assign(new Error(r.error.message || r.error.code), { code: r.error.code }))
      resolve(r?.result)
    })
  })
}

let toastTimer
function toast (text, kind) {
  toastEl.textContent = text
  toastEl.dataset.kind = kind || 'ok'
  toastEl.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toastEl.hidden = true }, 2600)
}

/** Los errores se comparan por código: el texto está traducido (memoria del proyecto). */
function humanError (e) {
  if (e.code === 'unknown-op') return t(lang, 'staleWorker')
  if (e.code === 'not-approved') return t(lang, 'askDenied')
  if (e.code === 'denied') return t(lang, 'denied')
  if (e.code === 'approval-timeout') return t(lang, 'noAnswer')
  if (e.code === 'unreachable' || e.code === 'no-link') return t(lang, 'noLink')
  if (e.code === 'not-found') return t(lang, 'notFound')
  return e.message
}

function el (tag, props = {}, children = []) {
  const n = Object.assign(document.createElement(tag), props)
  for (const c of [].concat(children)) if (c) n.append(c)
  return n
}

const hostOf = (u) => { try { return new URL(u).hostname } catch { return '' } }

// --- la dirección: qué se está mirando ---------------------------------------
//
// Va en el `#fragment` para que un refresco no pierda la ficha abierta, y porque una
// pestaña de la extensión no tiene ruta propia que gastar.

function ruta () {
  const p = new URLSearchParams(location.hash.slice(1))
  return { site: p.get('site') || '', id: p.get('id') || '' }
}

function ir ({ site, id }) {
  const p = new URLSearchParams()
  if (site) p.set('site', site)
  if (id) p.set('id', id)
  location.hash = p.toString()
}

// --- la lista ----------------------------------------------------------------

/**
 * DÓNDE HAY ALGO GUARDADO, y un buscador para llegar a un registro concreto.
 *
 * **Sigue sin haber «verlos todos»**, y no es un descuido: la bóveda no entrega su lista
 * entera a nadie (`REMOTE_OPS` no lleva `list`). Lo que sí entrega son los DOMINIOS
 * (`sites`, 2026-08-29): el dominio ya viaja en claro y con él se abre cada sitio como si
 * se viniera de su página, que es lo que evita un buscador en blanco donde hay que
 * adivinar qué escribir.
 */
async function renderList () {
  const { site } = ruta()
  sectionEl.textContent = t(lang, 'managerTitle')

  const buscador = el('input', {
    type: 'search',
    placeholder: t(lang, 'searchRecords'),
    autocomplete: 'off',
  })
  buscador.dataset.testid = 'manager-search'

  const lista = el('ul', { className: 'records' })
  const titulo = el('h2')
  const nota = el('p', { className: 'hint' })
  const tituloSitios = el('h2', { textContent: t(lang, 'whereLabel'), hidden: true })
  const sitios = el('div', { className: 'domains' })

  const fila = (e) => {
    const b = el('button', { className: 'record', type: 'button' })
    b.dataset.testid = `manager-record-${e.id}`
    b.append(
      el('span', { className: 'who' }, [
        el('div', { className: 'name', textContent: e.hint || e.title || '—' }),
        el('div', { className: 'site', textContent: e.sites?.[0] || t(lang, 'noSite') }),
      ]),
      el('span', { className: 'go', textContent: '›' }),
    )
    b.onclick = () => ir({ site, id: e.id })
    return b
  }

  const pintar = (items, cabecera, vacio) => {
    titulo.textContent = cabecera
    lista.replaceChildren(...items.map(e => el('li', {}, [fila(e)])))
    nota.textContent = items.length ? '' : vacio
    nota.hidden = !!items.length
  }

  view.replaceChildren(buscador, tituloSitios, sitios, titulo, lista, nota)

  /**
   * Los dominios donde hay algo. Pulsar uno es lo mismo que abrir el gestor desde esa
   * página: se listan sus registros — y, con ellos, los que sirven en cualquier sitio,
   * porque en esa página también servirían.
   */
  const pintarSitios = async () => {
    let hay = []
    try { hay = await ask('sites') } catch (_) { return }
    if (!hay.length) return
    tituloSitios.hidden = false
    sitios.replaceChildren(...hay.map(({ site: d, count }) => {
      const b = el('button', {
        className: 'domain' + (d && site && hostOf(site) === d ? ' on' : ''),
        type: 'button',
      })
      b.dataset.testid = `manager-site-${d || 'anywhere'}`
      b.append(
        el('span', { textContent: d || t(lang, 'noSite') }),
        el('span', { className: 'n', textContent: String(count) }),
      )
      // Sin dominio propio no hay página a la que ir: esas entradas salen en cualquiera,
      // así que se enseñan con el sitio que ya se estaba mirando.
      b.onclick = () => ir({ site: d ? `https://${d}/` : site })
      return b
    }))
  }

  const delSitio = async () => {
    if (!site) {
      // Sin sitio de partida no hay nada que listar: se elige un dominio de arriba, o se
      // busca. Una sección de registros vacía solo estorbaría.
      titulo.hidden = true
      lista.hidden = true
      nota.hidden = false
      nota.textContent = t(lang, 'searchRest')
      return
    }
    titulo.hidden = false
    lista.hidden = false
    try {
      pintar(await ask('find', { url: site }), `${t(lang, 'onThisSite')} · ${hostOf(site)}`, t(lang, 'noneHere'))
      if (!nota.hidden) return
      nota.hidden = false
      nota.textContent = t(lang, 'searchRest')
    } catch (e) { nota.hidden = false; nota.textContent = humanError(e) }
  }

  // Buscar es de la bóveda entera y exige dos letras (§2): no es la lista disfrazada.
  let timer
  buscador.oninput = () => {
    clearTimeout(timer)
    const q = buscador.value.trim()
    timer = setTimeout(async () => {
      if (q.length < 2) { sitios.hidden = false; tituloSitios.hidden = !sitios.children.length; return delSitio() }
      sitios.hidden = true
      tituloSitios.hidden = true
      try {
        pintar(await ask('search', { q }), t(lang, 'all'), t(lang, 'noneFound'))
      } catch (e) { nota.hidden = false; nota.textContent = humanError(e) }
    }, 250)
  }

  await delSitio()
  buscador.focus()
  await pintarSitios()
}

// --- la ficha de un registro --------------------------------------------------

/** El nombre visible de una clave: la etiqueta guardada si la hay, y si no su clase. */
function nombreDe (key, label) {
  if (label) return label
  if (key.startsWith('label:')) return key.slice(6)
  return kindLabel(lang, key)
}

/**
 * LAS FILAS de una ficha, a partir de lo público.
 *
 * De la vista pública salen los NOMBRES de lo que lleva dentro y cuáles son privados
 * (§4.0.2), que es todo lo que hace falta para dibujar la ficha. Los valores se piden
 * después, y **solo los públicos**.
 */
function filasDe (vista) {
  const keys = Array.isArray(vista.fieldKeys) ? vista.fieldKeys : []
  const privadas = new Set(Array.isArray(vista.privateKeys) ? vista.privateKeys : [])
  const filas = []

  for (const k of BUILTIN) {
    const hay = k === 'notes' ? vista.hasNotes : keys.includes(k)
    if (!hay) continue
    filas.push({
      key: k, label: kindLabel(lang, k), kind: null, builtin: true,
      priv: k === 'notes' ? true : privadas.has(k) || SIEMPRE_PRIVADOS.includes(k),
      fijoPriv: SIEMPRE_PRIVADOS.includes(k) || k === 'username',
      valor: '', quitada: false, nueva: false,
    })
  }
  for (const k of keys) {
    if (BUILTIN.includes(k)) continue
    filas.push({
      key: k, label: nombreDe(k), kind: k.startsWith('label:') ? null : k, builtin: false,
      priv: privadas.has(k), fijoPriv: false,
      valor: '', quitada: false, nueva: false,
    })
  }
  return filas
}

async function renderRecord (id) {
  const { site } = ruta()
  const volver = el('button', { type: 'button', textContent: `‹ ${t(lang, 'backToList')}` })
  volver.dataset.testid = 'manager-back'
  volver.onclick = () => ir({ site })
  const migas = el('div', { className: 'crumbs' }, [volver])

  view.replaceChildren(migas, el('p', { className: 'hint', textContent: t(lang, 'waiting') }))

  let vista
  try {
    vista = await ask('entry-view', { id, url: site })
  } catch (e) {
    view.replaceChildren(migas, el('p', { className: 'error', textContent: humanError(e) }))
    return
  }

  sectionEl.textContent = vista.hint || vista.title || t(lang, 'managerTitle')

  const filas = filasDe(vista)
  // Las filas nuevas se numeran solas. Por el índice del array no vale: quitar una fila de
  // arriba renumeraría a las de abajo, y con ellas su sitio en el DOM.
  let nuevas = 0
  const nombre0 = vista.hint || ''
  let nombre = nombre0
  // Lo que dice el resumen de cada fila: `same`, `changed` o `new`. Se rellena solo, en
  // cuanto el usuario escribe, y es lo único que sabemos de un valor privado.
  const estado = new Map()

  // --- los valores PÚBLICOS, que son los únicos que se piden ---------------------
  const publicas = filas.filter(f => !f.priv).map(f => f.key)
  if (publicas.length) {
    try {
      const abierta = await ask('get', { id, keys: publicas })
      const campos = (() => {
        if (Array.isArray(abierta.fields)) return abierta.fields
        try { return JSON.parse(abierta.fields || '[]') } catch { return [] }
      })()
      for (const f of filas) {
        if (f.priv) continue
        if (f.builtin) { f.valor = String(abierta[f.key] || ''); continue }
        const c = campos.find(x => (x.kind || (x.label ? `label:${x.label}` : 'other')) === f.key)
        if (c) { f.valor = String(c.value || ''); if (c.label) f.label = c.label }
      }
    } catch (e) { toast(humanError(e), 'error') }
  }
  const original = new Map(filas.map(f => [f.key, f.valor]))

  // --- pintar --------------------------------------------------------------------
  const lista = el('ul', { className: 'values' })
  const guardar = el('button', { className: 'primary', textContent: t(lang, 'saveChanges'), disabled: true })
  guardar.dataset.testid = 'manager-save'

  const cajaNombre = el('input', { type: 'text', value: nombre, placeholder: t(lang, 'entryName') })
  cajaNombre.dataset.testid = 'manager-name'
  cajaNombre.oninput = () => { nombre = cajaNombre.value; sync() }

  /** ¿Hay algo que guardar? Con un valor privado, lo dice el resumen y nada más. */
  function sucio () {
    if (nombre.trim() !== nombre0.trim()) return true
    return filas.some(f => {
      if (f.quitada) return true
      if (f.nueva) return !!(f.valor.trim() && (f.label.trim() || f.kind))
      if (f.priv !== f.priv0) return true
      if (!f.valor) return false
      if (f.priv) return estado.get(f.key) !== 'same'
      return f.valor !== original.get(f.key)
    })
  }
  for (const f of filas) f.priv0 = f.priv

  function sync () { guardar.disabled = !sucio() }

  /** Lo escrito contra lo guardado, por resúmenes. Sin abrir nada y sin autorizaciones. */
  let dTimer
  function pedirDiff () {
    clearTimeout(dTimer)
    dTimer = setTimeout(async () => {
      const pares = filas
        .filter(f => !f.nueva && !f.quitada && f.valor)
        .map(f => ({ key: f.key, value: f.valor }))
      if (!pares.length) return
      try {
        const r = await ask('entry-diff', { id, url: site, pairs: pares })
        for (const [k, v] of Object.entries(r || {})) estado.set(k, v)
        // Se repintan SOLO las etiquetas. Volver a dibujar las filas le quitaría el foco
        // al campo donde se está escribiendo, que es exactamente cuando esto ocurre.
        for (const r2 of refrescos) r2()
        sync()
      } catch (_) { /* sin resumen la fila se queda sin etiqueta, y no pasa nada */ }
    }, 300)
  }

  // Las etiquetas de cada fila, para poder refrescarlas sin volver a dibujarlo todo.
  const refrescos = []

  function filaValor (f) {
    const ref = f.key || `new-${f.nid}`
    const li = el('li', { className: 'value' + (f.quitada ? ' gone' : '') })
    li.dataset.testid = `manager-row-${ref}`

    const caja = el('input', {
      type: 'text',
      value: f.valor,
      placeholder: f.priv && !f.nueva ? t(lang, 'replaceHint') : t(lang, 'valuePh'),
      disabled: f.quitada,
    })
    caja.dataset.testid = `manager-value-${ref}`
    caja.oninput = () => {
      f.valor = caja.value
      f.tocada = true
      estado.delete(f.key)
      sync(); pedirDiff(); pintarEtiqueta()
    }

    const tag = el('span', { className: 'tag', hidden: true })
    tag.dataset.testid = `manager-tag-${ref}`
    function pintarEtiqueta () {
      // Solo en lo que se ha tocado. Una fila recién cargada dice «igual» por definición
      // —trae su propio valor—, y decirlo en las siete es ruido que tapa el que importa.
      const s = f.nueva
        ? (f.valor ? 'new' : null)
        : (f.tocada && f.valor ? estado.get(f.key) : null)
      tag.hidden = !s || s === 'same'
      if (s === 'same') { tag.hidden = false; tag.className = 'tag same'; tag.textContent = t(lang, 'fieldSame') }
      else if (s) { tag.className = 'tag' + (s === 'changed' ? ' changed' : ''); tag.textContent = t(lang, s === 'changed' ? 'fieldChanged' : 'fieldNew') }
    }
    pintarEtiqueta()
    refrescos.push(pintarEtiqueta)

    const marca = el('input', { type: 'checkbox', checked: f.priv, disabled: f.fijoPriv || f.quitada })
    marca.dataset.testid = `manager-private-${ref}`
    marca.onchange = () => { f.priv = marca.checked; sync() }
    const etiquetaMarca = el('label', { className: 'mark', title: t(lang, 'private') }, [
      marca, el('span', { textContent: t(lang, 'private') }),
    ])
    etiquetaMarca.hidden = f.fijoPriv

    const x = el('button', {
      className: 'x', type: 'button',
      textContent: f.quitada ? '↺' : '✕',
      title: f.quitada ? t(lang, 'undoRemove') : t(lang, 'removeField'),
    })
    x.setAttribute('aria-label', x.title)
    x.dataset.testid = `manager-remove-${ref}`
    x.onclick = () => {
      if (f.nueva && !f.quitada) { filas.splice(filas.indexOf(f), 1); paint(); sync(); return }
      f.quitada = !f.quitada
      paint(); sync()
    }

    if (f.nueva) {
      li.className = 'newrow'
      const tipo = el('select')
      tipo.dataset.testid = `manager-kind-new-${f.nid}`
      tipo.append(el('option', { value: '', textContent: t(lang, 'kindNone') }))
      // Los de siempre que este registro NO tiene: añadir una contraseña a una ficha de
      // datos es tan normal como añadirle un teléfono.
      for (const k of BUILTIN) {
        if (filas.some(o => o !== f && o.key === k)) continue
        tipo.append(el('option', { value: `!${k}`, textContent: kindLabel(lang, k) }))
      }
      for (const k of KINDS) tipo.append(el('option', { value: k, textContent: kindLabel(lang, k) }))
      tipo.value = f.builtin ? `!${f.key}` : (f.kind || '')
      tipo.onchange = () => {
        const v = tipo.value
        if (v.startsWith('!')) {
          f.builtin = true; f.key = v.slice(1); f.kind = null
          f.label = kindLabel(lang, f.key)
          f.fijoPriv = SIEMPRE_PRIVADOS.includes(f.key) || f.key === 'username'
          f.priv = SIEMPRE_PRIVADOS.includes(f.key)
        } else {
          f.builtin = false; f.key = ''; f.kind = v || null
          if (v) f.label = kindLabel(lang, v)
        }
        paint(); sync()
      }
      const etiqueta = el('input', {
        type: 'text', value: f.label, placeholder: t(lang, 'labelPh'), disabled: f.builtin,
      })
      etiqueta.dataset.testid = `manager-label-new-${f.nid}`
      etiqueta.oninput = () => { f.label = etiqueta.value; sync() }
      li.append(tipo, etiqueta, caja, etiquetaMarca, x)
      return li
    }

    li.append(el('span', { className: 'k', textContent: f.label, title: f.label }), caja, tag, etiquetaMarca, x)
    return li
  }

  const anadir = el('button', { className: 'ghost', textContent: `+ ${t(lang, 'addValue')}` })
  anadir.dataset.testid = 'manager-add'
  anadir.onclick = () => {
    filas.push({ key: '', label: '', kind: null, builtin: false, priv: false, priv0: false, fijoPriv: false, valor: '', quitada: false, nueva: true, nid: nuevas++ })
    paint()
    view.querySelector('.newrow input')?.focus()
  }

  function paint () {
    refrescos.length = 0
    lista.replaceChildren(...filas.map(f => filaValor(f)))
  }
  paint()

  const cancelar = el('button', { className: 'ghost', textContent: t(lang, 'cancel') })
  cancelar.dataset.testid = 'manager-cancel'
  cancelar.onclick = () => ir({ site })

  guardar.onclick = async () => {
    guardar.disabled = true
    try {
      await aplicar({ id, site, filas, original, estado, nombre, nombre0 })
      toast(t(lang, 'saved'))
      ir({ site })
    } catch (e) {
      toast(humanError(e), 'error')
      sync()
    }
  }

  view.replaceChildren(
    migas,
    el('div', { className: 'field-name' }, [
      el('label', { textContent: t(lang, 'entryName'), htmlFor: '' }),
      cajaNombre,
    ]),
    el('h2', { textContent: t(lang, 'values') }),
    lista,
    anadir,
    ...(vista.sites?.length
      ? [el('h2', { textContent: t(lang, 'sites') }),
         el('div', { className: 'sites' }, vista.sites.map(s => el('span', { textContent: s })))]
      : []),
    el('div', { className: 'actions' }, [guardar, cancelar, el('span', { className: 'sp' })]),
  )
  pedirDiff()
}

/**
 * DE LAS FILAS A UN `patch`, y de ahí a la bóveda. Una sola escritura para toda la ficha.
 *
 * Antes de escribir se vuelve a preguntar por resúmenes: lo que el usuario tecleó igual a
 * lo que ya había NO se escribe. Es lo que hace que reescribir una contraseña con la
 * misma no cuente como un cambio.
 */
async function aplicar ({ id, site, filas, original, estado, nombre, nombre0 }) {
  const escritas = filas.filter(f => !f.quitada && f.valor && !f.nueva).map(f => ({ key: f.key, value: f.valor }))
  let dice = estado
  if (escritas.length) {
    try {
      const r = await ask('entry-diff', { id, url: site, pairs: escritas })
      dice = new Map([...estado, ...Object.entries(r || {})])
    } catch (_) { /* sin resumen se escribe lo tecleado, que es lo que el usuario quiso */ }
  }

  const changes = {}
  const fields = []
  const removeFields = []

  if (nombre.trim() !== nombre0.trim()) changes.name = nombre.trim()

  for (const f of filas) {
    if (f.quitada) {
      if (!f.nueva && f.key) removeFields.push(f.key)
      continue
    }
    if (f.nueva) {
      const valor = f.valor.trim()
      if (!valor) continue
      if (f.builtin) { changes[f.key] = valor; continue }
      const label = (f.label || (f.kind ? kindLabel(lang, f.kind) : '')).trim()
      if (!label && !f.kind) continue
      fields.push({ label, value: valor, ...(f.kind ? { kind: f.kind } : {}), private: !!f.priv })
      continue
    }

    const cambiaValor = f.valor && dice.get(f.key) !== 'same' &&
      (f.priv || f.valor !== original.get(f.key))
    const cambiaMarca = f.priv !== f.priv0

    if (f.builtin) {
      if (cambiaValor) changes[f.key] = f.valor
      // Los de siempre no llevan marca que cambiar: o son privados por lo que son, o
      // —el usuario— es el nombre visible de la entrada y no se esconde.
      continue
    }
    if (!cambiaValor && !cambiaMarca) continue
    // Sin `value` la bóveda deja el valor como estaba: así se cambia la marca de un campo
    // privado sin tenerlo delante, que es justo lo que el gestor no puede pedir.
    fields.push({
      label: f.key.startsWith('label:') ? f.key.slice(6) : f.label,
      ...(f.kind ? { kind: f.kind } : {}),
      ...(cambiaValor ? { value: f.valor } : {}),
      private: !!f.priv,
    })
  }

  if (fields.length) changes.fields = fields
  if (removeFields.length) changes.removeFields = removeFields
  if (!Object.keys(changes).length) return
  await ask('patch', { id, changes })
}

// --- arranque -----------------------------------------------------------------

function render () {
  const { id } = ruta()
  return id ? renderRecord(id) : renderList()
}

window.addEventListener('hashchange', render)

for (const b of document.querySelectorAll('#lang button')) {
  b.onclick = () => {
    lang = b.dataset.lang
    try { localStorage.setItem('dotrino-lang', lang) } catch {}
    paintLang()
    render()
  }
}

function paintLang () {
  for (const b of document.querySelectorAll('#lang button')) {
    b.setAttribute('aria-pressed', String(b.dataset.lang === lang))
  }
  document.documentElement.lang = lang
}

paintLang()
render()
