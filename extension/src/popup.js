// Popup: qué hay para este sitio, y rellenar.
//
// Se abre y funciona: la extensión ES su propia bóveda mientras no enlaces otra, así que
// aquí no hay puerta de entrada que pase por configurar nada. Enlazar el daemon o la
// pestaña está al pie, para quien quiere sus contraseñas en un solo sitio.
//
// No hay contraseña maestra ni lista completa de golpe: cada credencial es una petición.
// Sin `alert`/`confirm`/`prompt` (CONVENCIONES §5).

import { pickLang, t } from './i18n.js'
import { entryCard, byName } from './entry-card.js'
import { profileBar } from './profiles.js'
// La bóveda puede pedir autorización mientras el popup está abierto (una contraseña que
// se copia o se rellena desde aquí): la pregunta sale AQUÍ, no en una ventana suelta, que
// cerraría el popup y con él lo que estabas haciendo.
import { hostApprovals } from './approval.js'

hostApprovals()


let lang = pickLang()
const view = document.getElementById('view')
const toastEl = document.getElementById('toast')

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
  // «No lo autoricé» y «esta bóveda no me deja pedir» son dos cosas distintas: una se
  // arregla volviendo a pulsar, la otra dando permiso al aparato (§2.0).
  if (e.code === 'not-approved') return t(lang, 'askDenied')
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

/**
 * ABRIR EL GESTOR (§4.3), en su propia pestaña.
 *
 * Es una página de la extensión, así que puede pedir cualquier operación; el popup no le
 * pasa nada más que dónde estaba y, si se viene de una tarjeta, cuál. Con `id` entra
 * directo a esa ficha, que es lo que hace el botón «Editar».
 */
function openManager ({ url, id } = {}) {
  const p = new URLSearchParams()
  if (url) p.set('site', url)
  if (id) p.set('id', id)
  chrome.tabs.create({ url: chrome.runtime.getURL('src/manager.html') + '#' + p.toString() })
  window.close()
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
 * La tarjeta la dibuja la pieza compartida: la misma que usa el gestor (§4.3). Aquí solo
 * se dice qué acciones tiene, y el popup es el único que tiene `onFill` — rellenar es de
 * la página que tienes delante.
 */
const cardCtx = () => ({ lang, ask, toast, humanError, pre: 'popup', onChanged: render })

async function renderSite (estado0) {
  const propia = estado0.profile.kind === 'own'

  const url = await currentUrl()
  const list = el('ul', { className: 'entries' })
  const estado = el('p', { className: 'hint', textContent: t(lang, 'waiting') })

  // Cada credencial sale de una petición aparte, Y SOLO LOS CAMPOS QUE SE VAN A USAR: un
  // `get` a secas se trae la entrada entera, que era lo que hacía copiar antes.
  const askForOne = async (e, keys) => ask('get', { id: e.id, keys })

  // Aquí había un «guardar la contraseña de esta página». Se quitó el 2026-08-28, dicho
  // por el dueño: *«no le encuentro sentido»*. Y no lo tiene desde que el botón del propio
  // campo guarda lo que hay escrito (§4.1) y el aviso pregunta solo al entrar (§4.0.1):
  // era un tercer camino para lo mismo, más escondido y con su propio formulario.

  const onFill = async (e) => {
    try {
      const full = await askForOne(e, ['username', 'secret'])
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

  // El pie dice DÓNDE están tus contraseñas, y es lo único que distingue las dos vías
  // a ojos del usuario. Quien no enlazó nada no está a medio configurar: está usando la
  // suya, y se le dice así.
  // El segundo botón, al lado del de editar de cada tarjeta (dueño, 2026-08-29): este no
  // es de ningún registro, es la puerta al gestor entero — buscar, y ver en qué sitios
  // tienes algo. Va debajo de la lista y no en el pie: en el pie no se ve.
  const abrirGestor = el('button', { className: 'ghost wide', textContent: t(lang, 'openManager') })
  abrirGestor.dataset.testid = 'popup-manager'
  abrirGestor.onclick = () => openManager({ url })
  // El perfil propio no se «desconecta»: es la bóveda de esta extensión. El de una
  // conectada sí, y el botón vive junto a la frase que dice dónde están guardadas — antes
  // estaba en la barra, que ahora es la del ecosistema y no admite piezas de una app.
  const pie = el('p', { className: 'hint foot' }, [
    el('span', { textContent: (propia ? t(lang, 'ownVault') : t(lang, 'linkedVault')) + ' ' }),
  ])
  if (!propia) {
    const soltar = el('button', { className: 'link', textContent: t(lang, 'unlink') })
    soltar.dataset.testid = 'popup-unlink'
    soltar.onclick = async () => { await ask('unlink'); render() }
    pie.append(soltar)
  }

  // El gestor va ARRIBA, entre los perfiles y lo de este sitio (dueño, 2026-08-29): es
  // de la bóveda entera, como los perfiles, y no una acción más de la última tarjeta.
  view.replaceChildren(
    profileBar(cardCtx(), estado0, { onAdd: renderAdd }),
    abrirGestor,
    el('h2', { textContent: t(lang, 'onThisSite') }),
    list, estado, pie,
  )

  try {
    const items = await ask('find', { url })
    const porDefecto = await ask('default-get', { url }).catch(() => null)
    list.replaceChildren(...[...items].sort(byName).map(e => entryCard(cardCtx(), e, {
      onFill, onDelete, onDefault, isDefault: e.id === porDefecto,
      onEdit: (x) => openManager({ url, id: x.id }),
      // Renombrar cambia lo que dice la lista entera —el nombre visible sale de dentro—,
      // así que se vuelve a pintar en vez de parchear la fila.
      onRenamed: (cambió) => { if (cambió) render(); else renderSite(estado0) },
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

// El idioma lo lleva la barra del ecosistema (§9): las dos opciones a la vista, la
// preferencia persistida y el `lang` del documento puestos por ella. Aquí solo se escucha
// para volver a pintar lo nuestro.
document.addEventListener('dotrino-lang', (ev) => {
  lang = ev.detail?.lang || lang
  render()
})

render()
