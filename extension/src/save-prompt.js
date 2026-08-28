// El aviso de «¿la guardo?» que sale DESPUÉS de entrar, en la página siguiente.
//
// Corre en el origen de la extensión (es un iframe suyo, incrustado en la página), y de
// ahí sale toda su seguridad: el clic que escribe en la bóveda nace aquí, no en el
// sitio, así que llega al service worker con origen `chrome-extension://` y pasa por la
// misma puerta que el popup. La página no puede pulsarlo, ni leerlo, ni fingirlo.
//
// Tres preguntas, y en este orden: **dónde** se guarda (una entrada nueva o una de las
// que ya hay), **qué** se escribe (una casilla por dato) y entonces sí, guardar.
//
// **La contraseña no pasa por aquí.** Lo capturado vive en el service worker; esta
// pantalla enseña de qué sitio y de qué usuario se trata, y qué se va a escribir — la
// contraseña, tapada.

import { t, pickLang, kindLabel } from './i18n.js'

const lang = pickLang()
const p = new URLSearchParams(location.search)
const host = p.get('host') || ''
const user = p.get('user') || ''

const $ = (id) => document.getElementById(id)

$('user').textContent = user || t(lang, 'noUser')
$('host').textContent = host
document.querySelector('[data-t="title"]').textContent = t(lang, 'askSave')
$('save').textContent = t(lang, 'save')
$('no').textContent = t(lang, 'notNow')
document.documentElement.lang = lang

const ask = (op, payload) => new Promise((resolve, reject) => {
  chrome.runtime.sendMessage({ op, payload }, (r) => {
    if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message))
    if (r?.error) return reject(Object.assign(new Error(r.error.message || r.error.code), { code: r.error.code }))
    resolve(r?.result)
  })
})

const post = (msg) => { try { window.parent.postMessage({ _dotrino: msg.op, ...msg }, '*') } catch (_) {} }

/** Cerrarse es pedirle al content script que quite el iframe: él es quien lo montó. */
const close = () => post({ op: 'close-save-prompt' })

/**
 * Y decirle cuánto ocupa. El iframe lo dibuja la página, así que su alto no puede salir
 * de su propio CSS: sin esto la lista de campos se corta por abajo.
 */
const resize = () => requestAnimationFrame(() => {
  // En el fotograma siguiente, con la lista ya colocada: medida antes, sale corta y el
  // aviso aparece con barra de scroll. Los 2 px son el borde del cuerpo.
  post({ op: 'size-save-prompt', h: Math.ceil(document.documentElement.getBoundingClientRect().height) + 2 })
})

/** «hace 3 días». Para distinguir dos entradas que por fuera se ven iguales. */
function ago (ts) {
  if (!ts) return ''
  const s = Math.round((ts - Date.now()) / 1000)
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' })
  for (const [unit, secs] of [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]]) {
    if (Math.abs(s) >= secs) return rtf.format(Math.round(s / secs), unit)
  }
  return rtf.format(Math.round(s), 'second')
}

function fail (e) {
  $('err').textContent = e?.code === 'denied'
    ? t(lang, 'denied')
    : (e?.code === 'no-link' || e?.code === 'unreachable') ? t(lang, 'noLink')
        : (e?.message || String(e))
  $('err').hidden = false
  for (const b of document.querySelectorAll('button')) b.disabled = false
  resize()
}

// --- dónde y qué ---------------------------------------------------------------
//
// DÓNDE, porque una página no tiene un ancla única: puedes tener dos contraseñas del
// mismo correo y que una ya no sirva. El gestor no elige por el usuario cuál se pisa —
// enseña las que hay, con la que más se parece primero, y también la salida de crear
// una nueva.
//
// QUÉ, con una casilla por dato: casi siempre hay uno que quieres y otro que no, y sin
// las casillas la única salida era «ahora no» y volver a escribirlo todo en la bóveda.
//
// La frontera de lo privado está en el medio: la LISTA de candidatas es pública (es lo
// que se ve sin la llave), pero saber si un dato *cambia* obliga a abrir lo guardado.
// Con la bóveda propia eso no cuesta nada; con una conectada cuesta una aprobación, y
// entonces no se hace solo — se ofrece «Ver qué cambia».

let detail = null
let target = ''        // '' = una entrada nueva
let picked = new Set()

/** Las filas de lo que se escribiría en el destino elegido. */
function rowsFor (id) {
  const diff = id ? detail.diffs?.[id] : null
  return detail.typed
    .map((f) => {
      const d = diff?.find((x) => x.key === f.key)
      // Sin destino, todo es nuevo. Con destino y sin diff (no se ha abierto lo
      // guardado), no se sabe: no se dice nada en vez de decir algo falso.
      const status = !id ? 'new' : (d ? d.status : 'unknown')
      return { ...f, status, before: d?.before || '' }
    })
    .filter((r) => r.status !== 'same')
}

function renderTargets () {
  const ul = $('targets')
  ul.textContent = ''
  if (!detail.candidates.length) { $('where').hidden = true; return }
  $('where').hidden = false
  $('whereLabel').textContent = t(lang, 'saveWhere')

  // La etiqueta «se parece» va SOLO en la primera: cuando dos entradas tienen el mismo
  // usuario se parecen las dos, y marcarlas todas no dice nada. Lo que las distingue es
  // la fecha, y esa sí va en cada una.
  let yaMarcada = false
  const opciones = [
    { id: '', label: t(lang, 'newEntry'), when: '', tag: '' },
    ...detail.candidates.map((c) => {
      const marca = c.similar && !yaMarcada
      if (marca) yaMarcada = true
      return {
        id: c.id,
        label: c.hint || c.title || t(lang, 'noUser'),
        // El título solo si dice algo que no esté ya arriba: casi siempre es el propio
        // sitio, y repetirlo se comía el espacio de la fecha, que es lo que distingue
        // dos entradas iguales por fuera.
        when: [c.title && c.title !== host ? c.title : '', ago(c.updatedAt)].filter(Boolean).join(' · '),
        tag: marca ? t(lang, 'mostSimilar') : (c.anywhere ? t(lang, 'anywhereEntry') : ''),
      }
    }),
  ]

  for (const o of opciones) {
    const li = document.createElement('li')
    li.dataset.testid = 'save-prompt-target'
    li.dataset.id = o.id

    const label = document.createElement('label')
    label.className = 't'

    const radio = document.createElement('input')
    radio.type = 'radio'
    radio.name = 'target'
    radio.value = o.id
    radio.checked = o.id === target
    radio.dataset.testid = o.id ? `save-prompt-target-${o.id}` : 'save-prompt-target-new'
    radio.addEventListener('change', () => { target = o.id; renderFields() })

    const who = document.createElement('span')
    who.className = 'who2'
    who.textContent = o.label

    const when = document.createElement('span')
    when.className = 'when'
    when.textContent = o.when

    label.append(radio, who, when)
    if (o.tag) {
      const tag = document.createElement('span')
      tag.className = 'tag'
      tag.textContent = o.tag
      label.append(tag)
    }
    li.append(label)
    ul.append(li)
  }
}

function renderFields () {
  const ul = $('fields')
  ul.textContent = ''
  const rows = rowsFor(target)
  picked = new Set(rows.map((r) => r.key))

  for (const row of rows) {
    const li = document.createElement('li')
    li.dataset.testid = 'save-prompt-field'
    li.dataset.field = row.key

    const label = document.createElement('label')
    label.className = 'f'

    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = true
    box.dataset.testid = `save-prompt-pick-${row.key}`
    box.addEventListener('change', () => {
      if (box.checked) picked.add(row.key)
      else picked.delete(row.key)
      syncButtons()
    })

    const k = document.createElement('span')
    k.className = 'k'
    k.textContent = kindLabel(lang, row.key)

    const v = document.createElement('span')
    v.className = 'v'
    // La contraseña llega en `null` a propósito: no sale del service worker.
    v.textContent = row.secret ? t(lang, 'hidden') : row.value
    if (!row.secret) v.title = row.value

    label.append(box, k, v)
    if (row.status !== 'unknown') {
      const tag = document.createElement('span')
      tag.className = 'tag' + (row.status === 'changed' ? ' changed' : '')
      tag.textContent = t(lang, row.status === 'changed' ? 'fieldChanged' : 'fieldNew')
      label.append(tag)
    }
    li.append(label)

    // Qué había antes, para que «cambia» diga QUÉ cambia. De la contraseña, nada.
    if (row.status === 'changed' && row.before) {
      const old = document.createElement('span')
      old.className = 'old'
      old.textContent = row.before
      old.title = row.before
      li.append(old)
    }
    ul.append(li)
  }

  // Abrir lo guardado para saber qué cambia es sacar información privada de la bóveda:
  // se pide, no se hace solo.
  const puedePedir = detail.ask && target && !detail.diffs[target]
  $('reveal').hidden = !puedePedir
  $('reveal').textContent = t(lang, 'seeChanges')
  $('reveal').title = t(lang, 'seeChangesHint')

  syncButtons()
  resize()
}

function syncButtons () {
  $('save').textContent = target
    ? t(lang, 'updateInto')
    : (detail?.candidates?.length ? t(lang, 'saveAsNew') : t(lang, 'save'))
  const nada = picked.size === 0
  $('save').disabled = nada
  $('save').title = nada ? t(lang, 'pickNothing') : ''
}

$('reveal').onclick = async () => {
  $('reveal').disabled = true
  try {
    const d = await ask('pending-detail', { id: target, reveal: true })
    if (d?.diffs) Object.assign(detail.diffs, d.diffs)
  } catch (e) { fail(e) } finally { $('reveal').disabled = false }
  renderFields()
}

async function load () {
  detail = await ask('pending-detail')
  if (!detail?.has) return close()
  if (!detail.login) {
    document.querySelector('[data-t="title"]').textContent = t(lang, 'askSaveData')
    // Un formulario de datos no tiene cuenta: «sin usuario ·» delante del sitio sobra,
    // y además suena a que falta algo.
    if (!user) document.querySelector('.who').textContent = host
  }

  // Preseleccionada, la que más se parece — que es la que el usuario querría pisar el
  // 90 % de las veces. Si ninguna se parece, una entrada nueva: no se pisa por defecto
  // algo que no se sabe si es lo mismo.
  target = detail.candidates.find((c) => c.similar)?.id || ''

  // Nada que añadir ni que cambiar: no se molesta al usuario con un aviso que solo
  // puede contestar que sí a lo que ya tenía igual. Solo se sabe cuando abrir lo
  // guardado no cuesta una aprobación.
  if (!detail.ask && !rowsFor(target).length) {
    try { await ask('dismiss-pending') } catch (_) {}
    return close()
  }

  renderTargets()
  renderFields()
}

async function save () {
  for (const b of document.querySelectorAll('button')) b.disabled = true
  try {
    await ask('save-pending', { ...(target ? { id: target } : {}), pick: [...picked] })
    close()
  } catch (e) { fail(e) }
}

$('save').onclick = save
$('no').onclick = async () => {
  // Descartar BORRA lo capturado. Si se quedara ahí, un «ahora no» dejaría una
  // contraseña en claro esperando en la memoria del navegador sin que nadie la pidiera.
  try { await ask('dismiss-pending') } catch (_) {}
  close()
}

$('save').focus()
resize()
load().catch(fail)
