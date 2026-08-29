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
  // Pasa al actualizar la extensión sin recargarla: el popup ya es el nuevo y el service
  // worker que le contesta sigue siendo el de antes, sin las operaciones que le pide. El
  // código a secas («unknown-op») no le dice nada a nadie.
  if (e.code === 'unknown-op') return t(lang, 'staleWorker')
  if (e.code === 'denied') return t(lang, 'denied')
  if (e.code === 'approval-timeout') return t(lang, 'noAnswer')
  if (e.code === 'unreachable' || e.code === 'no-link') return t(lang, 'noLink')
  if (e.code === 'bad-invite') return t(lang, 'badInvite')
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
 * CONECTAR OTRA BÓVEDA. No es la puerta de entrada de nada: la extensión ya tiene la
 * suya y se llega aquí desde «usar otra bóveda».
 *
 * Sirve para lo que la propia no puede: que tus contraseñas estén en un solo sitio para
 * todos tus navegadores, y que sobrevivan a desinstalar esto.
 *
 * Es el emparejamiento del ecosistema, el mismo de cualquier aparato: se pega la
 * invitación que muestra la bóveda y este navegador enseña SEIS caracteres que se
 * teclean allí. Ese código NO viaja — la bóveda solo lo aprende porque lo escribes tú,
 * y por eso aprobar exige tener esta pantalla delante.
 */
function renderLink () {
  const openVaultBtn = el('button', { className: 'primary', textContent: t(lang, 'openVault') })
  openVaultBtn.onclick = () => {
    chrome.tabs.create({ url: 'https://vault.dotrino.com/vault' })
    window.close()
  }

  const name = el('input', { type: 'text', placeholder: t(lang, 'vaultName') })
  const invite = el('input', { type: 'text', placeholder: t(lang, 'inviteHint'), 'data-testid': 'invite' })
  const err = el('p', { className: 'error', hidden: true })
  const go = el('button', { className: 'primary', textContent: t(lang, 'linkGo'), 'data-testid': 'pair' })
  const waiting = el('div', { className: 'pairing', hidden: true })

  /**
   * El código aparece cuando la bóveda contesta, no antes: mientras tanto lo que hay es
   * una espera, y decirlo es más honesto que dejar un hueco.
   */
  const mostrarCodigo = (p) => {
    waiting.hidden = false
    waiting.replaceChildren(
      el('p', { className: 'hint', textContent: t(lang, 'pairCode') }),
      el('code', { className: 'mycode', textContent: p.code, 'data-testid': 'pair-code' }),
      el('p', { className: 'hint', textContent: t(lang, 'pairCodeHint') }),
    )
  }

  let poll = null
  const submit = async () => {
    if (!invite.value.trim()) return
    err.hidden = true
    go.disabled = true
    invite.disabled = true
    waiting.hidden = false
    waiting.replaceChildren(el('p', { className: 'hint', textContent: t(lang, 'pairWait') }))
    // El código lo genera el service worker durante el emparejamiento y vive solo
    // mientras dura: se le pregunta, no se le manda un canal aparte para esto.
    poll = setInterval(async () => {
      try {
        const s = await ask('status')
        if (s?.pairing?.code) mostrarCodigo(s.pairing)
      } catch (_) { /* el worker se durmió: la siguiente vuelta */ }
    }, 700)
    try {
      await ask('link', { invite: invite.value.trim(), label: name.value.trim() || null })
      render()
    } catch (e) {
      err.textContent = humanError(e)
      err.hidden = false
      waiting.hidden = true
      go.disabled = false
      invite.disabled = false
    } finally { clearInterval(poll) }
  }
  go.onclick = submit
  invite.onkeydown = e => { if (e.key === 'Enter') submit() }

  const backBtn = el('button', { className: 'ghost', textContent: t(lang, 'back') })
  backBtn.onclick = () => { clearInterval(poll); render() }

  view.replaceChildren(
    el('h2', { textContent: t(lang, 'linkTitle') }),
    el('p', { className: 'hint', textContent: t(lang, 'linkHint') }),
    openVaultBtn,
    el('p', { className: 'hint', textContent: t(lang, 'openVaultHint') }),
    el('p', { className: 'hint', style: 'margin-top:14px', textContent: t(lang, 'pasteInvite') }),
    name, invite, err, go, waiting,
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
  connect.onclick = () => renderLink()

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

/**
 * Una entrada de la lista: quién es, y qué se puede hacer con ella.
 *
 * La casilla **predeterminada** no es un adorno: marca cuál sale elegida al abrir el
 * botón de un campo en la página (§4.1), que con tres cuentas del mismo sitio es la
 * diferencia entre elegir siempre o no elegir nunca. Solo puede haber una por sitio, así
 * que marcar una desmarca la anterior.
 */
function entryRow (e, { onFill, onCopy, onDelete, onDefault, isDefault }) {
  const fill = el('button', { className: 'ghost', textContent: t(lang, 'fill') })
  const copy = el('button', { className: 'ghost', textContent: t(lang, 'copy') })
  const del = el('button', { className: 'ghost danger', textContent: t(lang, 'del') })
  fill.onclick = () => onFill(e)
  copy.onclick = () => onCopy(e)
  del.onclick = () => onDelete(e)

  const marca = el('input', { type: 'checkbox', checked: !!isDefault })
  marca.onchange = () => onDefault(e, marca.checked)

  // La confirmación sale AQUÍ, debajo de su tarjeta, no en otra pantalla (dueño,
  // 2026-08-28): irse a una ventana nueva para contestar «sí» hace perder de vista cuál
  // de las tres entradas se estaba borrando, que es justo el dato que importa.
  const si = el('button', { className: 'danger', textContent: t(lang, 'del') })
  const no = el('button', { className: 'ghost', textContent: t(lang, 'cancel') })
  const confirmar = el('div', { className: 'confirm', hidden: true }, [
    el('span', { className: 'hint', textContent: t(lang, 'delConfirm') }),
    si, no,
  ])
  del.onclick = () => { confirmar.hidden = false; si.focus() }
  no.onclick = () => { confirmar.hidden = true; del.focus() }
  si.onclick = () => onDelete(e)

  return el('li', { className: 'entry' }, [
    el('div', { className: 'who' }, [
      el('div', { className: 'name', textContent: e.title || e.sites?.[0] || '—' }),
      el('div', { className: 'hint', textContent: e.hint || e.sites?.[0] || '' }),
    ]),
    el('div', { className: 'acts' }, [
      el('label', { className: 'def' }, [marca, el('span', { textContent: t(lang, 'byDefault') })]),
      el('span', { className: 'sp' }),
      fill, copy, del,
    ]),
    confirmar,
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

  // Aquí había un «guardar la contraseña de esta página». Se quitó el 2026-08-28, dicho
  // por el dueño: *«no le encuentro sentido»*. Y no lo tiene desde que el botón del propio
  // campo guarda lo que hay escrito (§4.1) y el aviso pregunta solo al entrar (§4.0.1):
  // era un tercer camino para lo mismo, más escondido y con su propio formulario.

  const onFill = async (e) => {
    try {
      const full = await askForOne(e)
      const r = await tellPage('page-fill', { username: full.username, secret: full.secret })
      if (r?.filled) window.close()
      else toast(t(lang, 'noForm'), 'error')
    } catch (err) { toast(humanError(err), 'error') }
  }

  /**
   * Borrar de verdad, ya confirmado en la propia tarjeta. Nada de `confirm()` del
   * navegador (CONVENCIONES §5): el aviso es UI nuestra y vive donde vive la entrada.
   */
  const onDelete = async (e) => {
    try {
      await ask('remove', { id: e.id, url })
      toast(t(lang, 'deleted'))
      render()
    } catch (err) { toast(humanError(err), 'error') }
  }

  /** Cuál sale elegida al abrir un campo. Una por sitio: marcar una suelta la otra. */
  const onDefault = async (e, marcada) => {
    try {
      await ask('default-set', { url, id: marcada ? e.id : null })
      render()
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

  view.replaceChildren(profileBar(estado0), el('h2', { textContent: t(lang, 'onThisSite') }), list, estado, pie)

  try {
    const items = await ask('find', { url })
    const porDefecto = await ask('default-get', { url }).catch(() => null)
    list.replaceChildren(...items.map(e => entryRow(e, {
      onFill, onCopy, onDelete, onDefault, isDefault: e.id === porDefecto,
    })))
    estado.textContent = items.length ? '' : t(lang, 'noneHere')
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
