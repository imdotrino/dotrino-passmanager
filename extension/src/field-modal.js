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
// Lo que llega DESDE la página (los nombres de sus campos) es cosmético y se trata como
// tal: el content script y el sitio comparten ventana, así que nada de lo que venga por
// ahí decide nada. Los valores salen de la bóveda, y lo que se guarda es lo que el
// service worker tenga apuntado.

import { t, pickLang, kindLabel } from './i18n.js'

const lang = pickLang()
const p = new URLSearchParams(location.search)
const key = p.get('key') || ''
const name = p.get('name') || ''

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

document.documentElement.lang = lang
$('close').textContent = t(lang, 'close')
$('save').textContent = t(lang, 'save')
$('fillTitle').textContent = t(lang, 'fillSection')
$('saveTitle').textContent = t(lang, 'saveSection')
$('fillAll').textContent = t(lang, 'fillAllChecked')
$('privLabel').textContent = t(lang, 'private')
$('saveName').textContent = name || kindLabel(lang, key)

function fail (e) {
  $('err').textContent = e?.code === 'denied'
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
  let hay = []
  try { hay = await ask('find', { url: ctx.url }) } catch (_) { hay = [] }

  // Solo las entradas que pintan algo aquí: las que pueden rellenar alguno de los campos
  // de esta página, o —si se va a guardar— cualquiera del sitio.
  const utiles = new Set(ctx.page.flatMap(f => f.ids || []))
  records = hay
    .filter(e => utiles.has(e.id) || ctx.canSave)
    .map(e => ({ id: e.id, name: e.hint || e.title || t(lang, 'noUser'), when: ago(e.updatedAt) }))
  // La entrada nueva es una opción más, y va al final: guardar es lo de abajo.
  if (ctx.canSave) records.push({ id: '', name: t(lang, 'newEntry'), when: '' })
  if (!records.length) records = [{ id: '', name: t(lang, 'newEntry'), when: '' }]

  render()
}

function actual () { return records[at] || { id: '' } }

function render () {
  const r = actual()
  $('recName').textContent = r.name
  $('recWhen').textContent = r.when || ''
  $('prev').disabled = at <= 0
  $('next').disabled = at >= records.length - 1

  // Rellenar: los campos de la página que ESTA entrada puede poner.
  const puede = r.id ? ctx.page.filter(f => (f.ids || []).includes(r.id)) : []
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

  $('saveBox').hidden = !ctx.canSave
  $('save').hidden = !ctx.canSave
  resize()
}

$('prev').onclick = () => { if (at > 0) { at--; render() } }
$('next').onclick = () => { if (at < records.length - 1) { at++; render() } }
$('close').onclick = close

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
    const entry = await ask('get', { id: r.id })
    const campos = (() => {
      if (Array.isArray(entry.fields)) return entry.fields
      try { return JSON.parse(entry.fields || '[]') } catch { return [] }
    })()
    const values = []
    for (const k of keys) {
      if (k === 'login') {
        values.push({ key: 'login', username: entry.username || '', secret: entry.secret || '' })
        continue
      }
      const c = campos.find(x => (x.kind || (x.label ? `label:${x.label}` : 'other')) === k)
      if (c) values.push({ key: k, value: c.value })
    }
    post({ op: 'fill-field-modal', values })
    close()
  } catch (e) { fail(e) }
}

$('save').onclick = async () => {
  for (const b of document.querySelectorAll('button')) b.disabled = true
  try {
    const r = actual()
    await ask('save-pending', {
      ...(r.id ? { id: r.id } : {}),
      pick: [key],
      ...($('private').checked ? { privateKeys: [key] } : {}),
    })
    post({ op: 'saved-field-modal' })
    close()
  } catch (e) { fail(e) }
}
