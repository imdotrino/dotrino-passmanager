// Popup: desbloquear, ver lo que hay para este sitio, rellenar e importar.
//
// No toca la bóveda: todo pasa por el service worker. Sin `alert`/`confirm`/`prompt`
// (CONVENCIONES §5) — los mensajes van por el toast de abajo.

import { pickLang, t } from './i18n.js'

let lang = pickLang()
const view = document.getElementById('view')
const toastEl = document.getElementById('toast')
const lockBtn = document.getElementById('lock')

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
  toastTimer = setTimeout(() => { toastEl.hidden = true }, 2200)
}

function el (tag, props = {}, children = []) {
  const n = Object.assign(document.createElement(tag), props)
  for (const c of [].concat(children)) if (c) n.append(c)
  return n
}

async function currentUrl () {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab?.url || ''
}

async function tellPage (op, payload) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) return null
  return new Promise(resolve => {
    chrome.tabs.sendMessage(tab.id, { op, payload }, r => {
      if (chrome.runtime.lastError) resolve(null)
      else resolve(r?.result || null)
    })
  })
}

// --- vistas ------------------------------------------------------------------

function renderCreate () {
  const pass = el('input', { type: 'password', placeholder: t(lang, 'password'), autofocus: true })
  const err = el('p', { className: 'error', hidden: true })
  const go = el('button', { className: 'primary', textContent: t(lang, 'create') })

  const submit = async () => {
    if (!pass.value) return
    try {
      await ask('create', { password: pass.value })
      render()
    } catch (e) {
      err.textContent = e.message
      err.hidden = false
    }
  }
  go.onclick = submit
  pass.onkeydown = e => { if (e.key === 'Enter') submit() }

  view.replaceChildren(
    el('h2', { textContent: t(lang, 'create') }),
    el('p', { className: 'hint', textContent: t(lang, 'createHint') }),
    pass, err, go,
  )
}

function renderUnlock () {
  const pass = el('input', { type: 'password', placeholder: t(lang, 'password'), autofocus: true })
  const err = el('p', { className: 'error', hidden: true })
  const go = el('button', { className: 'primary', textContent: t(lang, 'unlock') })

  const submit = async () => {
    if (!pass.value) return
    try {
      await ask('unlock', { password: pass.value })
      render()
    } catch (e) {
      // Se compara por código, no por el texto: el mensaje está traducido.
      err.textContent = e.code === 'wrong-password' ? t(lang, 'wrongPassword') : e.message
      err.hidden = false
      pass.select()
    }
  }
  go.onclick = submit
  pass.onkeydown = e => { if (e.key === 'Enter') submit() }

  view.replaceChildren(el('h2', { textContent: t(lang, 'unlock') }), pass, err, go)
}

function entryRow (e, { onFill, onCopy }) {
  const fill = el('button', { className: 'ghost', textContent: t(lang, 'fill') })
  const copy = el('button', { className: 'ghost', textContent: t(lang, 'copy') })
  fill.onclick = () => onFill(e)
  copy.onclick = () => onCopy(e)
  return el('li', { className: 'entry' }, [
    el('div', { className: 'who' }, [
      el('div', { className: 'name', textContent: e.title || e.sites[0] || '—' }),
      el('div', { className: 'hint', textContent: e.hint || e.sites[0] || '' }),
    ]),
    fill, copy,
  ])
}

async function renderVault () {
  lockBtn.hidden = false
  lockBtn.textContent = t(lang, 'lock')

  const url = await currentUrl()
  let tab = 'site'

  const tabs = el('div', { className: 'tabs' })
  const bSite = el('button', { className: 'ghost', textContent: t(lang, 'onThisSite') })
  const bAll = el('button', { className: 'ghost', textContent: t(lang, 'all') })
  tabs.append(bSite, bAll)

  const search = el('input', { type: 'search', placeholder: t(lang, 'search') })
  const list = el('ul', { className: 'entries' })
  const empty = el('p', { className: 'hint' })

  const onFill = async (e) => {
    try {
      // Aquí es donde se pide UNA credencial: la lista de arriba nunca las llevó.
      const full = await ask('get', { id: e.id })
      const r = await tellPage('page-fill', { username: full.username, secret: full.secret })
      if (r?.filled) window.close()
      else toast(t(lang, 'noForm'), 'error')
    } catch (err) { toast(err.message, 'error') }
  }

  const onCopy = async (e) => {
    try {
      const full = await ask('get', { id: e.id })
      await navigator.clipboard.writeText(full.secret)
      toast(t(lang, 'copied'))
    } catch (err) { toast(err.message, 'error') }
  }

  async function refresh () {
    bSite.setAttribute('aria-pressed', String(tab === 'site'))
    bAll.setAttribute('aria-pressed', String(tab === 'all'))
    const items = tab === 'site' ? await ask('find', { url }) : await ask('list')
    const q = search.value.trim().toLowerCase()
    const shown = q
      ? items.filter(e => (e.title + ' ' + e.sites.join(' ')).toLowerCase().includes(q))
      : items
    list.replaceChildren(...shown.map(e => entryRow(e, { onFill, onCopy })))
    empty.textContent = shown.length ? '' : t(lang, tab === 'site' ? 'noneHere' : 'empty')
    empty.hidden = !!shown.length
  }

  bSite.onclick = () => { tab = 'site'; refresh() }
  bAll.onclick = () => { tab = 'all'; refresh() }
  search.oninput = refresh

  // Importar: la única operación que entra de a muchas (DISENO §10).
  const file = el('input', { type: 'file', accept: '.csv,.json,.txt', hidden: true })
  const importBtn = el('button', { className: 'ghost file', textContent: t(lang, 'importFrom') })
  importBtn.onclick = () => file.click()
  file.onchange = async () => {
    const f = file.files?.[0]
    if (!f) return
    try {
      const { count } = await ask('import', { text: await f.text() })
      toast(t(lang, 'imported', count))
      tab = 'all'
      await refresh()
    } catch (e) { toast(e.message, 'error') }
    file.value = ''
  }

  view.replaceChildren(tabs, search, list, empty, importBtn, file)
  await refresh()
}

async function render () {
  try {
    const s = await ask('status')
    lockBtn.hidden = !s.unlocked
    if (!s.exists) return renderCreate()
    if (!s.unlocked) { lockBtn.hidden = true; return renderUnlock() }
    return renderVault()
  } catch (e) {
    view.replaceChildren(el('p', { className: 'error', textContent: e.message }))
  }
}

// Toggle de idioma: SIEMPRE las dos opciones a la vista (CONVENCIONES §9).
for (const b of document.querySelectorAll('#lang button')) {
  b.onclick = () => {
    lang = b.dataset.lang
    try { localStorage.setItem('dotrino-lang', lang) } catch {}
    document.documentElement.lang = lang
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

lockBtn.onclick = async () => { await ask('lock'); render() }

paintLang()
render()
