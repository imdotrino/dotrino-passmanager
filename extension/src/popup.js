// Popup: enlazar con la bóveda, ver qué hay para este sitio y rellenar.
//
// No hay contraseña maestra ni lista completa: esta extensión no tiene la bóveda.
// Todo lo que se ve aquí lo contestó la bóveda del usuario, de a una petición.
// Sin `alert`/`confirm`/`prompt` (CONVENCIONES §5).

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
  toastTimer = setTimeout(() => { toastEl.hidden = true }, 2600)
}

/** Los errores se comparan por código: el texto está traducido (memoria del proyecto). */
function humano (e) {
  if (e.code === 'denied') return t(lang, 'denied')
  if (e.code === 'approval-timeout') return t(lang, 'noAnswer')
  if (e.code === 'unreachable' || e.code === 'no-link') return t(lang, 'noLink')
  if (e.code === 'bad-code') return t(lang, 'badCode')
  return e.message
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
      resolve(chrome.runtime.lastError ? null : (r?.result || null))
    })
  })
}

// --- vistas ------------------------------------------------------------------

function renderLink (myCode) {
  /**
   * Lo primero es ABRIR UNA BÓVEDA, no pegar un código.
   *
   * Sin esto, alguien que instala la extensión se encuentra pidiéndole un código que no
   * tiene y sin forma de saber de dónde sale: el gestor exigía levantar un daemon antes
   * de poder hacer nada. La pestaña ES una bóveda, así que se ofrece primero y lo de
   * pegar un código queda para quien ya tenga la suya.
   */
  const abrir = el('button', { className: 'primary', textContent: t(lang, 'abrirBoveda') })
  abrir.onclick = () => {
    chrome.tabs.create({ url: 'https://pass.dotrino.com/boveda.html' })
    window.close()
  }

  const code = el('input', { type: 'text', placeholder: t(lang, 'linkCode') })
  const err = el('p', { className: 'error', hidden: true })
  const go = el('button', { className: 'primary', textContent: t(lang, 'linkGo') })

  const submit = async () => {
    if (!code.value.trim()) return
    try {
      await ask('link', { code: code.value.trim() })
      render()
    } catch (e) {
      err.textContent = humano(e)
      err.hidden = false
    }
  }
  go.onclick = submit
  code.onkeydown = e => { if (e.key === 'Enter') submit() }

  const mine = el('code', { className: 'mycode', textContent: myCode || '—' })
  mine.onclick = () => {
    navigator.clipboard.writeText(myCode || '').then(() => toast(t(lang, 'copied')))
  }

  view.replaceChildren(
    el('h2', { textContent: t(lang, 'linkTitle') }),
    el('p', { className: 'hint', textContent: t(lang, 'linkHint') }),
    abrir,
    el('p', { className: 'hint', textContent: t(lang, 'abrirHint') }),
    el('p', { className: 'hint', style: 'margin-top:14px', textContent: t(lang, 'oPega') }),
    code, err, go,
    el('p', { className: 'hint', textContent: t(lang, 'myCode') }),
    mine,
  )
}

function entryRow (e, { onFill, onCopy }) {
  const fill = el('button', { className: 'ghost', textContent: t(lang, 'fill') })
  const copy = el('button', { className: 'ghost', textContent: t(lang, 'copy') })
  fill.onclick = () => onFill(e)
  copy.onclick = () => onCopy(e)
  return el('li', { className: 'entry' }, [
    el('div', { className: 'who' }, [
      el('div', { className: 'name', textContent: e.title || e.sites?.[0] || '—' }),
      el('div', { className: 'hint', textContent: e.hint || e.sites?.[0] || '' }),
    ]),
    fill, copy,
  ])
}

async function renderSite (link) {
  lockBtn.hidden = false
  lockBtn.textContent = t(lang, 'unlink')

  const url = await currentUrl()
  const list = el('ul', { className: 'entries' })
  const estado = el('p', { className: 'hint', textContent: t(lang, 'waiting') })

  // Cada credencial sale de una petición aparte: la lista de arriba nunca las llevó.
  const pedirUna = async (e) => ask('get', { id: e.id })

  /**
   * Guardar lo que hay escrito en la página. La acción nace AQUÍ, en la UI de la
   * extensión y con el usuario delante — nunca en la página, que si pudiera guardar
   * por su cuenta llenaría la bóveda de entradas inventadas.
   */
  const guardar = el('button', { className: 'ghost file', textContent: t(lang, 'saveHere'), hidden: true })
  guardar.onclick = async () => {
    const cred = await tellPage('page-credentials')
    if (!cred?.secret) return toast(t(lang, 'nothingToSave'), 'error')

    const host = (() => { try { return new URL(url).hostname } catch { return '' } })()
    const nombre = el('input', { type: 'text', value: host, placeholder: t(lang, 'saveName') })
    const ok = el('button', { className: 'primary', textContent: t(lang, 'save') })
    const cancelar = el('button', { className: 'ghost', textContent: t(lang, 'cancel') })

    ok.onclick = async () => {
      try {
        await ask('put', {
          entry: {
            type: 'login',
            title: nombre.value.trim() || host,
            sites: host ? [host] : [],
            username: cred.username,
            secret: cred.secret,
          },
        })
        toast(t(lang, 'saved'))
        render()
      } catch (e) { toast(humano(e), 'error') }
    }
    cancelar.onclick = render

    view.replaceChildren(
      el('h2', { textContent: t(lang, 'saveHere') }),
      el('p', { className: 'hint', textContent: cred.username || host }),
      nombre, ok, cancelar,
    )
    nombre.focus()
  }

  const onFill = async (e) => {
    try {
      const full = await pedirUna(e)
      const r = await tellPage('page-fill', { username: full.username, secret: full.secret })
      if (r?.filled) window.close()
      else toast(t(lang, 'noForm'), 'error')
    } catch (err) { toast(humano(err), 'error') }
  }

  const onCopy = async (e) => {
    try {
      const full = await pedirUna(e)
      await navigator.clipboard.writeText(full.secret)
      toast(t(lang, 'copied'))
    } catch (err) { toast(humano(err), 'error') }
  }

  view.replaceChildren(el('h2', { textContent: link.label || t(lang, 'onThisSite') }), list, estado, guardar)

  try {
    const items = await ask('find', { url })
    list.replaceChildren(...items.map(e => entryRow(e, { onFill, onCopy })))
    estado.textContent = items.length ? '' : t(lang, 'noneHere')

    // El botón de guardar solo aparece si hay algo escrito que guardar.
    const cred = await tellPage('page-credentials')
    guardar.hidden = !cred?.secret
  } catch (e) {
    estado.className = 'error'
    estado.textContent = humano(e)
  }
}

async function render () {
  try {
    const s = await ask('status')
    lockBtn.hidden = !s.linked
    return s.linked ? renderSite(s) : renderLink(s.code)
  } catch (e) {
    view.replaceChildren(el('p', { className: 'error', textContent: humano(e) }))
  }
}

// Toggle de idioma: SIEMPRE las dos opciones a la vista (CONVENCIONES §9).
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

lockBtn.onclick = async () => { await ask('unlink'); render() }

paintLang()
render()
