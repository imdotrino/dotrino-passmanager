// El modal de UN campo: qué se puede poner ahí y cómo se guarda lo que hay escrito.
//
// Sale pegado al marcador, a su derecha (o a su izquierda si no cabe), y tiene la forma
// que pidió el dueño el 2026-08-28: arriba **de qué entrada hablamos**, con flechas para
// cambiarla; en medio **rellenar**, con una casilla por dato y un botón por fila; abajo
// **guardar** lo escrito, con la marca de privado.
//
// Es un **iframe de la extensión**, igual que el aviso de después de entrar (§4.0.1), y
// por la misma razón: el botón que escribe en la bóveda tiene que pulsarse en el origen
// `chrome-extension://`. La página no puede pulsarlo ni fingirlo.
//
// **No tiene botón de cerrar**: se cierra al pulsar fuera, como cualquier menú (y con
// Escape). Un botón que solo cierra ocupa el sitio del que sí hace algo.
//
// Lo que llega DESDE la página (los nombres de sus campos) es cosmético y se trata como
// tal: el content script y el sitio comparten ventana, así que nada de lo que venga por
// ahí decide nada. Los valores salen de la bóveda, y lo que se guarda es lo que el
// service worker tenga apuntado.

import { t, pickLang, kindLabel } from './i18n.js'
import { hostApprovals } from './approval.js'

const lang = pickLang()
const p = new URLSearchParams(location.search)
const key = p.get('key') || ''
const name = p.get('name') || ''
// El campo del que se habla, para quien lea la pestaña con un lector de pantalla.
if (name) document.title = `Dotrino · ${name}`

const $ = (id) => document.getElementById(id)
const post = (msg) => { try { window.parent.postMessage({ _dotrino: msg.op, ...msg }, '*') } catch (_) {} }
const close = () => post({ op: 'close-field-modal' })
const resize = () => requestAnimationFrame(() =>
  post({ op: 'size-field-modal', h: Math.ceil(document.documentElement.getBoundingClientRect().height) + 2 }))

const ask = (op, payload) => new Promise((resolve, reject) => {
  chrome.runtime.sendMessage({ op, payload }, (r) => {
    if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message))
    if (r?.error) return reject(Object.assign(new Error(r.error.message || r.error.code), { code: r.error.code }))
    resolve(r?.result)
  })
})

// Rellenar un campo saca algo de la bóveda, y la bóveda pregunta antes (§3.3.1). Se
// dibuja DENTRO de este iframe a propósito: una ventana aparte quitaría el foco, el modal
// se cerraría solo (se cierra al pulsar fuera) y el relleno se perdería a medio camino.
hostApprovals({ resize })

document.documentElement.lang = lang
$('save').textContent = t(lang, 'save')
$('whereTitle').textContent = t(lang, 'saveWhere')
$('fillTitle').textContent = t(lang, 'fillSection')
$('saveTitle').textContent = t(lang, 'saveSection')
$('fillAll').textContent = t(lang, 'fillAllChecked')


function fail (e) {
  $('err').textContent = e?.code === 'unknown-op'
    ? t(lang, 'staleWorker')
    : e?.code === 'not-approved'
      ? t(lang, 'askDenied')
      : e?.code === 'denied'
        ? t(lang, 'denied')
        : (e?.code === 'no-link' || e?.code === 'unreachable') ? t(lang, 'noLink') : (e?.message || String(e))
  $('err').hidden = false
  for (const b of document.querySelectorAll('button')) b.disabled = false
  resize()
}

// --- el contexto de la página ------------------------------------------------------
//
// Qué campos hay delante y cuáles puede rellenar cada entrada. Lo manda el content
// script en cuanto este marco dice que está listo.

let ctx = { page: [], canSave: false }
let records = []      // [{ id, name, when }] y al final, la entrada nueva
let at = 0
let detail = null     // lo que hay apuntado por guardar, campo a campo

addEventListener('message', (e) => {
  if (e.data?._dotrino !== 'field-modal-context') return
  ctx = {
    page: Array.isArray(e.data.page) ? e.data.page : [],
    canSave: !!e.data.canSave,
    // La URL de la PÁGINA. Sin ella se preguntaría por la del propio marco, que es
    // `chrome-extension://…`, y la bóveda no tiene nada guardado de ahí.
    url: typeof e.data.url === 'string' ? e.data.url : '',
  }
  start().catch(fail)
})
post({ op: 'field-modal-ready' })

/** «hace 3 días»: es lo que distingue dos entradas que por fuera se ven iguales. */
function ago (ts) {
  if (!ts) return ''
  const s = Math.round((ts - Date.now()) / 1000)
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' })
  for (const [u, secs] of [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]]) {
    if (Math.abs(s) >= secs) return rtf.format(Math.round(s / secs), u)
  }
  return rtf.format(Math.round(s), 'second')
}

async function start () {
  await loadRecords()
  if (ctx.canSave) {
    try { detail = await ask('pending-detail') } catch (_) { detail = null }
  }
  // Sin predeterminada, se abre en una entrada donde haya algo que hacer: la primera
  // puede ser justo la que ya tiene ese dato igual, y el modal saldría en blanco.
  if (!(await porDefecto())) {
    for (let i = 0; i < records.length; i++) {
      at = i
      if (rowsToSave().length || puedeRellenar().length) break
    }
  }
  render()
}

/**
 * DÓNDE: la lista de entradas, con la nueva al final.
 *
 * Con una sola opción —«una entrada nueva», porque el sitio no tiene nada— no se enseña:
 * elegir entre una cosa no es elegir. Igual que en el aviso de después de entrar.
 */
function renderTargets () {
  const ul = $('targets')
  ul.textContent = ''
  // El buscador está SIEMPRE a mano, detrás de su lupa (dueño, 2026-08-28).
  const abierto = buscadorAbierto()
  $('q').hidden = !abierto
  $('q').placeholder = t(lang, 'searchRecords')
  $('qBtn').setAttribute('aria-expanded', String(abierto))
  $('qBtn').title = t(lang, 'searchRecords')
  $('whereBox').hidden = false

  for (const [i, o] of records.entries()) {
    const li = document.createElement('li')
    li.dataset.testid = 'field-modal-target'
    li.dataset.id = o.id

    const label = document.createElement('label')
    label.className = 't'

    const radio = document.createElement('input')
    radio.type = 'radio'
    radio.name = 'target'
    radio.value = o.id
    radio.checked = i === at
    radio.dataset.testid = o.id ? `field-modal-target-${o.id}` : 'field-modal-target-new'
    radio.addEventListener('change', () => { at = i; render() })

    const who = document.createElement('span')
    who.className = 'who2'
    who.textContent = o.name
    who.title = o.name

    const when = document.createElement('span')
    when.className = 'when'
    when.textContent = o.when || ''

    label.append(radio, who, when)
    li.append(label)
    ul.append(li)
  }

}

/** Los campos de la página que la entrada elegida puede rellenar. */
function puedeRellenar () {
  const r = actual()
  if (!r.id) return []
  if (r.keys) return ctx.page.filter(f => r.keys.includes(f.key))
  return r.fuera ? ctx.page : ctx.page.filter(f => (f.ids || []).includes(r.id))
}

/**
 * La entrada PREDETERMINADA del sitio, la que el usuario marcó en el popup.
 *
 * Sustituye a recordar la última elegida (dueño, 2026-08-28): recordar adivina, y con
 * tres cuentas del mismo sitio adivina mal la mitad de las veces. Marcarla es decirlo.
 */
async function porDefecto () {
  try { return await ask('default-get', { url: ctx.url }) } catch (_) { return null }
}

/** Lo que hay escrito en el buscador. Con texto, la lista es el resultado. */
let buscando = ''
/**
 * ¿Está desplegado el buscador? **Cerrado al abrir el modal, siempre.**
 *
 * Lo abría solo en algunos casos —muchas entradas, o ninguna— y el dueño lo cortó el
 * 2026-08-28: un modal que se abre con una caja de texto ya escrita pide teclear, y lo
 * que se quiere casi siempre está en la lista de debajo. Se abre pulsando la lupa.
 */
let abierto = false
const buscadorAbierto = () => abierto || !!buscando

/** Las entradas del sitio —o las que casen con la búsqueda—, y la nueva al final. */
async function loadRecords (elegir) {
  const marcada = await porDefecto()
  let hay = []
  if (buscando) {
    // Buscar mira TODA la bóveda: es para traerse la cuenta de otro dominio.
    try { hay = await ask('search', { q: buscando, limit: 12 }) } catch (_) { hay = [] }
  } else {
    try { hay = await ask('find', { url: ctx.url }) } catch (_) { hay = [] }
  }

  // Solo las entradas que pintan algo aquí: las que pueden rellenar alguno de los campos
  // de esta página, o —si se va a guardar— cualquiera del sitio.
  const utiles = new Set(ctx.page.flatMap(f => f.ids || []))
  records = hay
    // Buscando, valen todas: si la pediste por su nombre es que la quieres.
    .filter(e => buscando || utiles.has(e.id) || ctx.canSave)
    .map(e => ({
      id: e.id,
      name: e.hint || e.title || t(lang, 'noUser'),
      when: ago(e.updatedAt),
      // LOS NOMBRES de lo que lleva dentro, sin un solo valor: la bóveda los manda en la
      // vista pública (§4.0.2), así que la lista es exacta sin abrir nada ni pedir
      // autorización — también para la que se trae de otro dominio.
      keys: Array.isArray(e.fieldKeys) ? e.fieldKeys : null,
      // De fuera: la que se trae BUSCANDO y no es de este sitio — la del dominio que
      // cambió. Sin nombres no hay forma de saber qué lleva, así que con ella se ofrece
      // rellenar todo; es el respaldo para una bóveda que aún no los manda.
      //
      // Ojo con lo que NO es: una entrada de este sitio que no puede rellenar nada (una
      // credencial en un formulario de datos, por ejemplo) no es «de fuera», es una que
      // no sirve para eso. Marcarla así ofrecía rellenar cinco campos que no tiene.
      fuera: !!buscando && !utiles.has(e.id),
    }))
  // La entrada nueva es una opción más, y va al final: guardar es lo de abajo.
  if (ctx.canSave) records.push({ id: '', name: t(lang, 'newEntry'), when: '' })
  if (!records.length) records = [{ id: '', name: t(lang, 'newEntry'), when: '' }]
  // La predeterminada va PRIMERA, y elegida. Es lo que el usuario pidió que pasara al
  // abrir un campo, y ponerla arriba es la mitad de eso.
  if (marcada) {
    const j = records.findIndex(r => r.id === marcada)
    if (j > 0) records.unshift(records.splice(j, 1)[0])
  }
  const quiero = elegir !== undefined ? elegir : marcada
  const i = quiero ? records.findIndex(r => r.id === quiero) : -1
  at = i >= 0 ? i : Math.min(at, records.length - 1)
}

function actual () { return records[at] || { id: '' } }

function render () {
  renderTargets()

  // Rellenar: los campos de la página que ESTA entrada puede poner.
  const puede = puedeRellenar()
  $('fillBox').hidden = !puede.length
  const ul = $('fillList')
  ul.textContent = ''
  for (const f of puede) {
    const li = document.createElement('li')
    li.dataset.testid = 'field-modal-fill-row'
    li.dataset.field = f.key
    const row = document.createElement('div')
    row.className = 'row'
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = true
    box.dataset.testid = `field-modal-check-${f.key}`
    const n = document.createElement('span')
    n.className = 'name'
    n.textContent = f.name || kindLabel(lang, f.key)
    const b = document.createElement('button')
    b.className = 'mini'
    b.type = 'button'
    b.dataset.testid = `field-modal-fill-${f.key}`
    b.textContent = t(lang, 'fillOne')
    b.addEventListener('click', () => fill([f.key]))
    row.append(box, n, b)
    li.append(row)
    ul.append(li)
  }

  // Guardar: todos los campos escritos que hagan algo en ESTA entrada. El que se pulsó
  // viene marcado; los demás, a un clic.
  // Guardar: cada campo escrito con su botón. Dice **guardar** si ese dato es nuevo en la
  // entrada elegida y **reemplazar** si ya estaba con otro valor — que no es lo mismo, y
  // el usuario tiene que saber cuál de las dos está pulsando.
  const filas = rowsToSave()
  $('saveBox').hidden = !filas.length
  $('save').hidden = !filas.length
  const sl = $('saveList')
  sl.textContent = ''
  for (const row of filas) {
    const li = document.createElement('li')
    li.dataset.testid = 'field-modal-save-row'
    li.dataset.field = row.key
    const d = document.createElement('div')
    d.className = 'row save'

    const n = document.createElement('span')
    n.className = 'name'
    n.textContent = row.label || kindLabel(lang, row.key)
    n.title = n.textContent

    const priv = document.createElement('label')
    priv.className = 'priv'
    const pb = document.createElement('input')
    pb.type = 'checkbox'
    pb.dataset.testid = `field-modal-private-${row.key}`
    // La contraseña es privada por naturaleza: no se pregunta.
    if (row.secret) { pb.checked = true; pb.disabled = true }
    const pt = document.createElement('span')
    pt.textContent = t(lang, 'private')
    priv.append(pb, pt)

    const b = document.createElement('button')
    b.className = 'mini'
    b.type = 'button'
    b.dataset.testid = `field-modal-save-${row.key}`
    b.textContent = t(lang, row.status === 'changed' ? 'replace' : 'save')
    b.addEventListener('click', () => guardar([row.key]))

    d.append(n, priv, b)
    li.append(d)
    sl.append(li)
  }
  // Y el de abajo, los de todas las filas de una vez.
  $('save').textContent = t(lang, filas.some(r => r.status === 'changed') ? 'replaceAll' : 'saveAll')
  $('save').disabled = false
  // Para las pruebas: ya está pintado, con su lista y sus secciones.
  document.body.dataset.ready = '1'
  resize()
}

/**
 * Lo que se escribiría en la entrada elegida: lo apuntado, menos lo que ya está igual.
 * Cada fila sabe si **añade** o si **reemplaza**, que es lo que dice su botón.
 */
function rowsToSave () {
  if (!detail?.has) return []
  const r = actual()
  const target = r.id
  const diff = target ? detail.diffs?.[target] : null
  const out = []
  for (const f of detail.typed || []) {
    if (!target) { out.push({ ...f, status: 'new' }); continue }
    const d = diff?.find(x => x.key === f.key)
    if (d?.status === 'same') continue
    // Con los nombres de los campos ya se sabe si ese dato EXISTE en la entrada, que es
    // lo que separa «guardar» de «reemplazar». Lo que no se sabe sin abrirla es si vale
    // lo mismo; ahí se dice «reemplazar» y reemplazar por lo mismo no rompe nada.
    const existe = r.keys ? r.keys.includes(f.key) : false
    out.push({ ...f, status: (d?.status === 'changed' || existe) ? 'changed' : 'new' })
  }
  return out
}

const privadas = () => [...document.querySelectorAll('#saveList input[type=checkbox]')]
  .filter(b => b.checked)
  .map(b => b.dataset.testid.replace('field-modal-private-', ''))



$('fillAll').onclick = () => {
  const marcados = [...document.querySelectorAll('#fillList input[type=checkbox]')]
    .filter(b => b.checked)
    .map(b => b.dataset.testid.replace('field-modal-check-', ''))
  fill(marcados)
}

/**
 * Rellenar es pedirle a la página que escriba: este marco no alcanza su DOM.
 *
 * El valor sale de la bóveda aquí y cruza a la página solo para los campos que se
 * rellenan — que es literalmente lo que rellenar significa.
 */
async function fill (keys) {
  if (!keys.length) return
  const r = actual()
  if (!r.id) return
  for (const b of document.querySelectorAll('button')) b.disabled = true
  try {
    // SOLO los campos que se van a rellenar: pedir la entrada entera para poner un
    // nombre sacaba también la contraseña, y era lo que hacía que rellenar un dato
    // público pidiera autorización (§4.2).
    const entry = await ask('get', { id: r.id, keys })
    const campos = (() => {
      if (Array.isArray(entry.fields)) return entry.fields
      try { return JSON.parse(entry.fields || '[]') } catch { return [] }
    })()
    const values = []
    for (const k of keys) {
      // El usuario y la contraseña viven en la entrada, no en su lista de campos.
      if (k === 'username') { if (entry.username) values.push({ key: k, value: entry.username }); continue }
      if (k === 'secret') { if (entry.secret) values.push({ key: k, value: entry.secret }); continue }
      const c = campos.find(x => (x.kind || (x.label ? `label:${x.label}` : 'other')) === k)
      if (c) values.push({ key: k, value: c.value })
    }
    if (!values.length) {
      // Se ofreció porque no se sabía qué llevaba dentro (una traída de otro dominio) y
      // resulta que no lleva eso. Se dice, en vez de cerrarse como si hubiera hecho algo.
      $('err').textContent = t(lang, 'nothingForField')
      $('err').hidden = false
      for (const b of document.querySelectorAll('button')) b.disabled = false
      return resize()
    }
    post({ op: 'fill-field-modal', values })
    close()
  } catch (e) { fail(e) }
}

/**
 * Guardar unos campos en la entrada elegida.
 *
 * Lo que NO se guarda **sigue apuntado** (`keepRest`): aquí se guarda de a uno, y tirar
 * lo demás dejaría media lista de botones muertos. Al terminar se vuelve a mirar qué
 * queda, y si ya no queda nada que hacer el modal se va.
 */
$('qBtn').onclick = async () => {
  abierto = !buscadorAbierto()
  if (!abierto && buscando) {
    // Cerrarlo con algo escrito vuelve a lo de este sitio: dejar el resultado de una
    // búsqueda con la caja escondida sería enseñar una lista que no se sabe de dónde sale.
    buscando = ''
    $('q').value = ''
    await loadRecords('')
  }
  render()
  if (abierto) $('q').focus()
}

// El buscador, con freno: cada tecla no puede ser un viaje a la bóveda.
let tecleando = null
$('q').addEventListener('input', () => {
  clearTimeout(tecleando)
  tecleando = setTimeout(async () => {
    buscando = $('q').value.trim()
    await loadRecords('')
    render()
    $('q').focus()
  }, 220)
})

async function guardar (pick) {
  if (!pick.length) return
  const priv = privadas().filter(k => pick.includes(k))
  for (const b of document.querySelectorAll('button')) b.disabled = false
  for (const b of document.querySelectorAll('#saveList button, #save')) b.disabled = true
  try {
    const r = actual()
    const res = await ask('save-pending', {
      ...(r.id ? { id: r.id } : {}),
      pick,
      keepRest: true,
      ...(priv.length ? { privateKeys: priv } : {}),
    })
    // Los marcadores de la página tienen que enterarse: lo guardado ya no se ofrece.
    post({ op: 'saved-field-modal' })
    // Si la entrada acaba de nacer, el siguiente campo va A ESA, no a otra nueva.
    await loadRecords(r.id || res?.id || '')
    try { detail = await ask('pending-detail') } catch (_) { detail = null }
    if (!rowsToSave().length && !ctx.page.some(f => (f.ids || []).includes(actual().id))) return close()
    render()
  } catch (e) { fail(e) }
}

$('save').onclick = () => guardar(rowsToSave().map(r => r.key))
