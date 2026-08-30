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
// El generador de la librería, el MISMO que usa la CLI: aleatoriedad de
// `crypto.getRandomValues` y elección sin sesgo. Escribir otro aquí sería tener dos ideas
// distintas de qué es una contraseña generada (CLAUDE.md, «si falta una característica»).
import { generatePassword } from './vendor/passmanager/generate.js'

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
$('genTitle').textContent = t(lang, 'genSection')
$('genUse').textContent = t(lang, 'genUse')
$('genHint').textContent = t(lang, 'genHint')
$('genAgain').title = t(lang, 'genAgain')
$('genAgain').setAttribute('aria-label', t(lang, 'genAgain'))


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

let ctx = { page: [], canSave: false, gen: false }
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
    // El campo que se pulsó es una contraseña vacía: se ofrece generar una (§4.1.1).
    gen: !!e.data.gen,
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
  //
  // **La entrada nueva no entra en ese concurso**, y desde que va primera (2026-08-29) hay
  // que decirlo: en ella siempre «hay algo que hacer» —todo es nuevo—, así que ganaba
  // siempre y el modal se abría creando una entrada en vez de usando la que ya está. Solo
  // se cae en ella si ninguna de las que hay sirve para nada aquí.
  if (!(await porDefecto())) {
    const nueva = records.findIndex(r => !r.id)
    let elegida = -1
    for (let i = 0; i < records.length; i++) {
      if (!records[i].id) continue
      at = i
      if (rowsToSave().length || puedeRellenar().length) { elegida = i; break }
    }
    at = elegida >= 0 ? elegida : Math.max(0, nueva)
  }
  render()
}

/**
 * DÓNDE: la lista de entradas, con la nueva al final.
 *
 * Con una sola opción —«una entrada nueva», porque el sitio no tiene nada— no se enseña:
 * elegir entre una cosa no es elegir. Igual que en el aviso de después de entrar.
 */
/**
 * EL LÁPIZ que deja renombrar una entrada, al lado de su nombre.
 *
 * Al pulsarlo la fila se convierte en un campo de texto con el nombre actual. Se guarda
 * al salir del campo o con Enter; con Escape se deja como estaba. Vacío quita el nombre
 * puesto y vuelve el que se calcula del contenido — una fila nunca se queda en blanco.
 */
function pencil (o) {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'pencil'
  b.dataset.testid = `field-modal-rename-${o.id}`
  b.title = t(lang, 'renameEntry')
  b.setAttribute('aria-label', t(lang, 'renameEntry'))
  b.textContent = '✎'
  b.addEventListener('click', (ev) => {
    ev.preventDefault()
    ev.stopPropagation()
    editando = o.id
    paint()
  })
  return b
}

/** Qué entrada se está renombrando ahora mismo. */
let editando = ''

/**
 * EL VISTO que confirma el nombre.
 *
 * Enter y salir del campo ya guardaban, y siguen guardando; lo que no hacían era
 * **decirse** (dueño, 2026-08-29: *«no se sabe dónde presionar para confirmar»*). Un
 * atajo que solo conoce quien lo escribió no es un atajo, es un secreto.
 *
 * Pulsarlo dispara antes el `blur` del campo, que guarda lo mismo: el botón acaba siendo
 * el sitio donde mirar más que el que hace el trabajo, y da igual cuál de los dos gane.
 */
function nameInput (o) {
  const caja = document.createElement('input')
  caja.type = 'text'
  caja.className = 'newname'
  caja.value = o.name === t(lang, 'noUser') ? '' : o.name
  caja.placeholder = t(lang, 'entryName')
  caja.dataset.testid = `field-modal-name-${o.id}`
  let cerrado = false
  const guardar = async (aplicar) => {
    if (cerrado) return
    cerrado = true
    editando = ''
    if (aplicar) {
      try { await ask('rename', { id: o.id, name: caja.value }) } catch (e) { fail(e) }
      await loadRecords(o.id)
      valoresDe = null
    }
    paint()
  }
  caja.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); guardar(true) }
    if (ev.key === 'Escape') { ev.preventDefault(); guardar(false) }
  })
  caja.addEventListener('blur', () => guardar(true))

  const listo = document.createElement('button')
  listo.type = 'button'
  listo.className = 'ok'
  listo.dataset.testid = `field-modal-name-ok-${o.id}`
  listo.title = t(lang, 'confirmName')
  listo.setAttribute('aria-label', t(lang, 'confirmName'))
  listo.textContent = '✓'
  listo.addEventListener('click', (ev) => { ev.preventDefault(); guardar(true) })

  const fila = document.createElement('span')
  fila.className = 'editing'
  fila.append(caja, listo)
  return { fila, caja }
}

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

    // LA ENTRADA NUEVA, elegida: su nombre se escribe aquí, antes de crearla.
    if (!o.id && i === at) {
      const caja = document.createElement('input')
      caja.type = 'text'
      caja.className = 'newname'
      caja.value = nuevoNombre ?? sugerido()
      caja.placeholder = t(lang, 'entryName')
      caja.dataset.testid = 'field-modal-new-name'
      caja.addEventListener('input', () => { nuevoNombre = caja.value })
      // No se cierra el modal con Enter: aquí Enter es «ya está», nada más.
      caja.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') ev.preventDefault() })
      label.append(radio, caja)
      li.append(label)
      ul.append(li)
      continue
    }

    // Renombrando ESTA: el nombre se cambia por un campo de texto.
    if (o.id && o.id === editando) {
      const { fila, caja } = nameInput(o)
      label.append(radio, fila)
      li.append(label)
      ul.append(li)
      requestAnimationFrame(() => { caja.focus(); caja.select() })
      continue
    }

    const who = document.createElement('span')
    who.className = 'who2'
    who.textContent = o.name
    who.title = o.name

    // El lápiz: el nombre de una entrada lo pone el usuario, no el contenido (§5).
    const lapiz = o.id ? pencil(o) : null

    const when = document.createElement('span')
    when.className = 'when'
    when.textContent = o.when || ''

    label.append(radio, who, ...(lapiz ? [lapiz] : []), when)
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
      // Y cuáles de ellos son PRIVADOS, para poder pedir los públicos —y solo esos— sin
      // disparar una autorización (§4.2).
      privadas: Array.isArray(e.privateKeys) ? e.privateKeys : null,
      // De fuera: la que se trae BUSCANDO y no es de este sitio — la del dominio que
      // cambió. Sin nombres no hay forma de saber qué lleva, así que con ella se ofrece
      // rellenar todo; es el respaldo para una bóveda que aún no los manda.
      //
      // Ojo con lo que NO es: una entrada de este sitio que no puede rellenar nada (una
      // credencial en un formulario de datos, por ejemplo) no es «de fuera», es una que
      // no sirve para eso. Marcarla así ofrecía rellenar cinco campos que no tiene.
      fuera: !!buscando && !utiles.has(e.id),
    }))
  // LA ENTRADA NUEVA VA PRIMERA, como en el aviso de guardar (dueño, 2026-08-29). Antes
  // iba al final, con la idea de que «guardar es lo de abajo»; las dos pantallas hacían lo
  // mismo en dos órdenes distintos, y eso se paga cada vez que se pasa de una a la otra.
  //
  // Se llama por lo que se está guardando y ese nombre es editable ahí mismo: ponérselo
  // después es un paso más que casi nadie da. El nombre de partida NO se congela aquí —
  // esto corre antes de saber qué se está guardando, y saldría el sitio en vez del dato.
  const nueva = { id: '', name: t(lang, 'newEntry'), when: '' }
  if (ctx.canSave || !records.length) records.unshift(nueva)

  // La predeterminada va justo detrás, y ELEGIDA: es lo que el usuario pidió que pasara
  // al abrir un campo. Primera del todo no puede ir ya, y tampoco hace falta — lo que
  // importaba era que saliera marcada.
  if (marcada) {
    const j = records.findIndex(r => r.id === marcada)
    if (j > 1) records.splice(1, 0, records.splice(j, 1)[0])
  }
  const quiero = elegir !== undefined ? elegir : marcada
  const i = quiero ? records.findIndex(r => r.id === quiero) : -1
  // Sin nada marcado, la elegida es la primera entrada QUE YA EXISTE: abrir un campo es
  // casi siempre para usar lo que hay, y crear otra es una decisión que se toma.
  at = i >= 0 ? i : Math.max(0, records.findIndex(r => r.id))
}

function actual () { return records[at] || { id: '' } }

/** El nombre que llevará la entrada nueva. `null` = todavía no se ha decidido. */
let nuevoNombre = null

/**
 * EL NOMBRE DE PARTIDA de la entrada nueva: el mismo que se calcularía del contenido
 * (§5), para que lo que se ve en el campo sea lo que va a quedar si no se toca.
 *
 * Y por eso **solo se guarda si se cambia**: dejar la sugerencia escrita congelaría un
 * nombre que hasta ahora se calculaba solo. El nombre puesto es una decisión; esto es la
 * suposición de siempre, enseñada por adelantado para poder corregirla.
 */
function sugerido () {
  if (detail?.username) return detail.username
  const publicos = (detail?.typed || []).filter(f => !f.secret && f.value)
  const correo = publicos.find(f => f.key === 'email')
  if (correo || publicos[0]) return String((correo || publicos[0]).value)
  try { return new URL(ctx.url).hostname } catch (_) { return '' }
}

/** El nombre que se guardará, o nada si es la sugerencia sin tocar. */
function nombreElegido () {
  const puesto = (nuevoNombre ?? '').trim()
  return puesto && puesto !== sugerido().trim() ? puesto : ''
}

/**
 * CON QUÉ se va a rellenar cada casilla: el valor, al lado de su nombre y en pequeño.
 *
 * Pedido por el dueño el 2026-08-29. Sin esto, «Correo» y «Correo» son dos filas iguales
 * cuando tienes dos cuentas, y elegir es adivinar.
 *
 * **Solo los PÚBLICOS.** La bóveda dice cuáles lo son (`privateKeys`), así que se piden
 * esos y nada más: enseñar una contraseña en una lista sería sacarla de la bóveda sin que
 * nadie lo pidiera, y además dispararía la autorización al abrir el modal. Los privados se
 * enseñan tapados y solo salen al pulsar «Completar», que es donde se autoriza.
 */
let valores = new Map()      // key → valor público, de la entrada elegida
let valoresDe = null         // de qué entrada son

async function loadValues () {
  const r = actual()
  if (!r.id || valoresDe === r.id) return
  valores = new Map()
  valoresDe = r.id
  // Sin la lista de privados no se pide nada: pedir a ciegas podría sacar un secreto.
  if (!r.keys || !r.privadas) return
  const privadas = new Set(r.privadas)
  const publicas = ctx.page
    .map(f => f.key)
    .filter(k => r.keys.includes(k) && !privadas.has(k))
  if (!publicas.length) return
  try {
    const entry = await ask('get', { id: r.id, keys: publicas })
    const campos = (() => {
      if (Array.isArray(entry.fields)) return entry.fields
      try { return JSON.parse(entry.fields || '[]') } catch { return [] }
    })()
    if (entry.username) valores.set('username', entry.username)
    for (const c of campos) {
      if (c?.value) valores.set(c.kind || (c.label ? `label:${c.label}` : 'other'), c.value)
    }
  } catch (_) { /* si no se puede, la lista se queda sin valores y no pasa nada */ }
}

/** Lo que se enseña de un valor: corto, porque va al lado del nombre y no en su lugar. */
const MAX_VISTA = 28
function vistaDe (key) {
  const r = actual()
  if (r.privadas && r.privadas.includes(key)) return '••••••'
  const v = valores.get(key)
  if (!v) return ''
  return v.length > MAX_VISTA ? v.slice(0, MAX_VISTA - 1) + '…' : v
}

/**
 * Pinta, y de paso pide los valores públicos de la entrada elegida para volver a pintar
 * con ellos. Va en dos tiempos porque pedirlos es una vuelta al service worker y el modal
 * no puede quedarse en blanco esperándola: sale con los nombres y los valores entran
 * detrás. Cuando ya están, `loadValues` no hace nada y esto es un solo repintado.
 */
function render () {
  loadValues().then(() => { if (valoresDe === actual().id) paint() })
  paint()
}

// --- la contraseña nueva (§4.1.1) -----------------------------------------------------
//
// Es lo ÚNICO de este modal que no sale de la bóveda: se crea aquí, en el origen de la
// extensión, y la página no la ve hasta que el usuario pulsa «Usar». Por eso no pide
// autorización ni depende de qué entrada esté elegida — no hay nada que sacar de ningún
// sitio.
//
// Se genera UNA vez y se queda: `paint()` corre en cada tecla del buscador y en cada
// cambio de entrada, y una contraseña que cambia sola mientras la lees no se puede
// apuntar en un papel ni comprobar contra lo que se acaba de escribir. Para cambiarla
// está el botón de al lado, que es una decisión.
let generada = ''

function paintGen () {
  const on = !!ctx.gen
  $('genBox').hidden = !on
  if (!on) return
  if (!generada) generada = generatePassword({ length: 20 })
  $('genVal').textContent = generada
}

$('genAgain').onclick = () => {
  generada = generatePassword({ length: 20 })
  paint()
}

/**
 * USARLA: se manda a la página, que es la única que alcanza el campo.
 *
 * Va marcada con `gen` para que el content script sepa que esto no estaba guardado y lo
 * apunte en el acto (§4.0): una contraseña generada que no se guarda deja al usuario
 * fuera de su cuenta, y eso es peor que no haberla generado.
 */
$('genUse').onclick = () => {
  if (!generada) return
  post({ op: 'fill-field-modal', values: [{ key: 'secret', value: generada, gen: true }] })
  close()
}

function paint () {
  renderTargets()
  paintGen()

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
    // Y con qué se va a rellenar, al lado y en pequeño: dos filas «Correo» no se
    // distinguen por el nombre.
    const v = document.createElement('span')
    v.className = 'val'
    v.dataset.testid = `field-modal-value-${f.key}`
    v.textContent = vistaDe(f.key)
    v.title = v.textContent
    const b = document.createElement('button')
    b.className = 'mini'
    b.type = 'button'
    b.dataset.testid = `field-modal-fill-${f.key}`
    b.textContent = t(lang, 'fillOne')
    b.addEventListener('click', () => fill([f.key]))
    row.append(box, n, v, b)
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
      // El nombre escrito en la fila de «una entrada nueva», si es ahí donde va y si de
      // verdad se escribió: la sugerencia sin tocar no se guarda (ver `sugerido`).
      ...(!r.id && nombreElegido() ? { name: nombreElegido() } : {}),
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
