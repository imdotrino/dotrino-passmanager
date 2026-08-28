// El aviso de «¿la guardo?» que sale DESPUÉS de entrar, en la página siguiente.
//
// Corre en el origen de la extensión (es un iframe suyo, incrustado en la página), y de
// ahí sale toda su seguridad: el clic que escribe en la bóveda nace aquí, no en el
// sitio, así que llega al service worker con origen `chrome-extension://` y pasa por la
// misma puerta que el popup. La página no puede pulsarlo, ni leerlo, ni fingirlo.
//
// **La contraseña no pasa por aquí.** Lo capturado vive en el service worker; esta
// pantalla enseña de qué sitio y de qué usuario se trata, y QUÉ SE VA A ESCRIBIR campo
// por campo — la contraseña, tapada.

import { t, pickLang, kindLabel } from './i18n.js'

const lang = pickLang()
const p = new URLSearchParams(location.search)
const host = p.get('host') || ''
const user = p.get('user') || ''
const dup = p.get('dup') || ''          // id de la entrada parecida, si la hay
const dupHint = p.get('dupHint') || ''

const $ = (id) => document.getElementById(id)

$('user').textContent = user || t(lang, 'noUser')
$('host').textContent = host
document.querySelector('[data-t="title"]').textContent = t(lang, 'askSave')
$('save').textContent = dup ? t(lang, 'saveAsNew') : t(lang, 'save')
$('no').textContent = t(lang, 'notNow')
document.documentElement.lang = lang

// Ya hay una cuenta que se le parece en este sitio. No se decide por el usuario cuál
// es: se le enseñan las dos salidas, porque actualizar la equivocada le pisa una
// contraseña que sí servía.
if (dup) {
  $('note').textContent = t(lang, 'dupNote', dupHint)
  $('note').hidden = false
  $('update').textContent = t(lang, 'update')
  $('update').hidden = false
}

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
 * de su propio CSS: sin esto la lista de campos se corta por abajo o deja un hueco.
 */
const resize = () => requestAnimationFrame(() => {
  // En el fotograma siguiente, con la lista ya colocada: medida antes, sale corta y el
  // aviso aparece con barra de scroll. Los 2 px son el borde del cuerpo.
  const alto = Math.ceil(document.documentElement.getBoundingClientRect().height) + 2
  post({ op: 'size-save-prompt', h: alto })
})

function fail (e) {
  $('err').textContent = e?.code === 'denied'
    ? t(lang, 'denied')
    : (e?.code === 'no-link' || e?.code === 'unreachable') ? t(lang, 'noLink')
        : (e?.message || String(e))
  $('err').hidden = false
  for (const b of document.querySelectorAll('button')) b.disabled = false
  resize()
}

// --- lo que se va a escribir, campo por campo ---------------------------------
//
// Con una casilla por fila (dueño, 2026-08-28). Guardar un formulario no es un sí o un
// no: casi siempre hay un dato que quieres y otro que no —el teléfono sí, la cédula
// no—, y sin las casillas la única salida era «ahora no» y volver a escribirlo todo en
// la bóveda.
//
// Solo salen las filas que hacen algo: lo que se AÑADE y lo que CAMBIA. Un dato que ya
// estaba igual no se enseña, porque no hay nada que decidir en él.

let picked = null      // las claves marcadas; null hasta que llega el detalle

function renderFields (detail) {
  const ul = $('fields')
  ul.textContent = ''
  picked = new Set(detail.rows.map(r => r.key))

  for (const row of detail.rows) {
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

    const tag = document.createElement('span')
    tag.className = 'tag' + (row.changed ? ' changed' : '')
    tag.textContent = t(lang, row.changed ? 'fieldChanged' : 'fieldNew')

    label.append(box, k, v, tag)
    li.append(label)

    // Qué había antes, para que «cambia» diga QUÉ cambia. De la contraseña, nada.
    if (row.changed && row.before) {
      const old = document.createElement('span')
      old.className = 'old'
      old.textContent = row.before
      old.title = row.before
      li.append(old)
    }
    ul.append(li)
  }
  syncButtons()
  resize()
}

function syncButtons () {
  const nada = picked && picked.size === 0
  for (const b of [$('save'), $('update')]) {
    b.disabled = !!nada
    b.title = nada ? t(lang, 'pickNothing') : ''
  }
}

async function load () {
  const d = await ask('pending-detail')
  if (!d?.has) return close()
  // Sin contraseña no se está guardando una cuenta, sino datos: cambia el título y la
  // nota de «ya tienes algo parecido», que hablaban de una contraseña.
  if (!d.login) {
    document.querySelector('[data-t="title"]').textContent = t(lang, 'askSaveData')
    if (dup) $('note').textContent = t(lang, 'dupNoteData')
    // Un formulario de datos no tiene cuenta: «sin usuario ·» delante del sitio sobra,
    // y además suena a que falta algo.
    if (!user) document.querySelector('.who').textContent = host
  }
  if (!d.rows.length) {
    // Nada que añadir ni que cambiar: no se molesta al usuario con un aviso que solo
    // puede contestar que sí a lo que ya tenía igual.
    try { await ask('dismiss-pending') } catch (_) {}
    return close()
  }
  renderFields(d)
}

async function save (id) {
  for (const b of document.querySelectorAll('button')) b.disabled = true
  try {
    await ask('save-pending', { ...(id ? { id } : {}), ...(picked ? { pick: [...picked] } : {}) })
    close()
  } catch (e) { fail(e) }
}

$('save').onclick = () => save(null)
$('update').onclick = () => save(dup)
$('no').onclick = async () => {
  // Descartar BORRA lo capturado. Si se quedara ahí, un «ahora no» dejaría una
  // contraseña en claro esperando en la memoria del navegador sin que nadie la pidiera.
  try { await ask('dismiss-pending') } catch (_) {}
  close()
}

$('save').focus()
resize()
load().catch(fail)
