// Popup: qué hay para este sitio, y rellenar.
//
// Se abre y funciona: la extensión ES su propia bóveda mientras no enlaces otra, así que
// aquí no hay puerta de entrada que pase por configurar nada. Enlazar el daemon o la
// pestaña está al pie, para quien quiere sus contraseñas en un solo sitio.
//
// No hay contraseña maestra ni lista completa de golpe: cada credencial es una petición.
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
function humanError (e) {
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

/**
 * Enlazar OTRA bóveda. No es la puerta de entrada de nada: la extensión ya tiene la suya
 * y se llega aquí desde «usar otra bóveda».
 *
 * Sirve para lo que la propia no puede: que tus contraseñas estén en un solo sitio para
 * todos tus navegadores, y que sobrevivan a desinstalar esto.
 */
function renderLink (myCode) {
  const openVaultBtn = el('button', { className: 'primary', textContent: t(lang, 'openVault') })
  openVaultBtn.onclick = () => {
    chrome.tabs.create({ url: 'https://vault.dotrino.com/vault' })
    window.close()
  }

  const name = el('input', { type: 'text', placeholder: t(lang, 'vaultName') })
  const code = el('input', { type: 'text', placeholder: t(lang, 'linkCode') })
  const err = el('p', { className: 'error', hidden: true })
  const go = el('button', { className: 'primary', textContent: t(lang, 'linkGo') })

  const submit = async () => {
    if (!code.value.trim()) return
    try {
      await ask('link', { code: code.value.trim(), label: name.value.trim() || null })
      render()
    } catch (e) {
      err.textContent = humanError(e)
      err.hidden = false
    }
  }
  go.onclick = submit
  code.onkeydown = e => { if (e.key === 'Enter') submit() }

  const mine = el('code', { className: 'mycode', textContent: myCode || '—' })
  mine.onclick = () => {
    navigator.clipboard.writeText(myCode || '').then(() => toast(t(lang, 'copied')))
  }

  const backBtn = el('button', { className: 'ghost', textContent: t(lang, 'back') })
  backBtn.onclick = render

  view.replaceChildren(
    el('h2', { textContent: t(lang, 'linkTitle') }),
    el('p', { className: 'hint', textContent: t(lang, 'linkHint') }),
    openVaultBtn,
    el('p', { className: 'hint', textContent: t(lang, 'openVaultHint') }),
    el('p', { className: 'hint', style: 'margin-top:14px', textContent: t(lang, 'orPaste') }),
    name, code, err, go,
    el('p', { className: 'hint', textContent: t(lang, 'myCode') }),
    mine,
    backBtn,
  )
}

/**
 * El selector de perfiles. Igual que en el resto del ecosistema: los perfiles no se ven
 * entre ellos, se elige uno y lo que ves es lo suyo. Cambiar no es reactivo en ninguna
 * otra app; aquí sí, porque el popup se vuelve a dibujar entero.
 */
function profileBar (s) {
  const bar = el('div', { className: 'profiles' })

  for (const p of s.profiles) {
    const activo = p.id === s.active
    const b = el('button', {
      className: 'profile' + (activo ? ' on' : ''),
      title: p.kind === 'own' ? t(lang, 'ownVault') : t(lang, 'linkedTo'),
    })
    if (p.avatar) b.append(el('img', { className: 'face', src: p.avatar, alt: '' }))
    b.append(el('span', { textContent: p.label || (p.kind === 'own' ? t(lang, 'thisBrowser') : t(lang, 'aVault')) }))
    b.setAttribute('aria-pressed', String(activo))
    b.onclick = async () => {
      if (activo) return
      try { await ask('profile-use', { id: p.id }); render() } catch (e) { toast(humanError(e), 'error') }
    }
    bar.append(b)
  }

  const add = el('button', { className: 'profile add', textContent: '+', title: t(lang, 'addProfile') })
  add.onclick = () => renderAdd(s)
  bar.append(add)
  return bar
}

/** Un perfil más: con su bóveda aquí, o conectando una que ya tienes. */
function renderAdd (s) {
  const name = el('input', { type: 'text', placeholder: t(lang, 'profileName') })

  const here = el('button', { className: 'primary', textContent: t(lang, 'addHere') })
  here.onclick = async () => {
    try { await ask('profile-add', { label: name.value.trim() || null }); render() } catch (e) { toast(humanError(e), 'error') }
  }

  const connect = el('button', { className: 'ghost', textContent: t(lang, 'addLinked') })
  connect.onclick = () => renderLink(s.code)

  const backBtn = el('button', { className: 'ghost', textContent: t(lang, 'back') })
  backBtn.onclick = render

  view.replaceChildren(
    el('h2', { textContent: t(lang, 'addProfile') }),
    name,
    here,
    el('p', { className: 'hint', textContent: t(lang, 'addHereHint') }),
    connect,
    el('p', { className: 'hint', textContent: t(lang, 'addLinkedHint') }),
    backBtn,
  )
  name.focus()
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

async function renderSite (estado0) {
  const propia = estado0.profile.kind === 'own'
  // El perfil propio no se «desconecta»: es la bóveda de esta extensión.
  lockBtn.hidden = propia
  lockBtn.textContent = t(lang, 'unlink')

  const url = await currentUrl()
  const list = el('ul', { className: 'entries' })
  const estado = el('p', { className: 'hint', textContent: t(lang, 'waiting') })

  // Cada credencial sale de una petición aparte: la lista de arriba nunca las llevó.
  const askForOne = async (e) => ask('get', { id: e.id })

  /**
   * Guardar lo que hay escrito en la página. La acción nace AQUÍ, en la UI de la
   * extensión y con el usuario delante — nunca en la página, que si pudiera saveHere
   * por su cuenta llenaría la bóveda de entradas inventadas.
   */
  const saveHere = el('button', { className: 'ghost file', textContent: t(lang, 'saveHere'), hidden: true })
  saveHere.onclick = async () => {
    const cred = await tellPage('page-credentials')
    if (!cred?.secret) return toast(t(lang, 'nothingToSave'), 'error')

    const host = (() => { try { return new URL(url).hostname } catch { return '' } })()
    const nameInput = el('input', { type: 'text', value: host, placeholder: t(lang, 'saveName') })
    const ok = el('button', { className: 'primary', textContent: t(lang, 'save') })
    const cancelBtn = el('button', { className: 'ghost', textContent: t(lang, 'cancel') })

    ok.onclick = async () => {
      try {
        await ask('put', {
          entry: {
            type: 'login',
            title: nameInput.value.trim() || host,
            sites: host ? [host] : [],
            username: cred.username,
            secret: cred.secret,
          },
        })
        toast(t(lang, 'saved'))
        render()
      } catch (e) { toast(humanError(e), 'error') }
    }
    cancelBtn.onclick = render

    view.replaceChildren(
      el('h2', { textContent: t(lang, 'saveHere') }),
      el('p', { className: 'hint', textContent: cred.username || host }),
      nameInput, ok, cancelBtn,
    )
    nameInput.focus()
  }

  const onFill = async (e) => {
    try {
      const full = await askForOne(e)
      const r = await tellPage('page-fill', { username: full.username, secret: full.secret })
      if (r?.filled) window.close()
      else toast(t(lang, 'noForm'), 'error')
    } catch (err) { toast(humanError(err), 'error') }
  }

  const onCopy = async (e) => {
    try {
      const full = await askForOne(e)
      await navigator.clipboard.writeText(full.secret)
      toast(t(lang, 'copied'))
    } catch (err) { toast(humanError(err), 'error') }
  }

  // El pie dice DÓNDE están tus contraseñas, y es lo único que distingue las dos vías
  // a ojos del usuario. Quien no enlazó nada no está a medio configurar: está usando la
  // suya, y se le dice así.
  const pie = el('p', { className: 'hint foot', textContent: propia ? t(lang, 'ownVault') : t(lang, 'linkedVault') })

  view.replaceChildren(profileBar(estado0), el('h2', { textContent: t(lang, 'onThisSite') }), list, estado, saveHere, pie)

  try {
    const items = await ask('find', { url })
    list.replaceChildren(...items.map(e => entryRow(e, { onFill, onCopy })))
    estado.textContent = items.length ? '' : t(lang, 'noneHere')

    // El botón de saveHere solo aparece si hay algo escrito que saveHere.
    const cred = await tellPage('page-credentials')
    saveHere.hidden = !cred?.secret
  } catch (e) {
    estado.className = 'error'
    estado.textContent = humanError(e)
  }
}

async function render () {
  try {
    const s = await ask('status')
    // Siempre la vista del sitio: hay bóveda desde el primer segundo, sea la propia o
    // la enlazada. Antes se abría pidiendo un código, que es lo mismo que no abrir.
    return renderSite(s)
  } catch (e) {
    view.replaceChildren(el('p', { className: 'error', textContent: humanError(e) }))
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
