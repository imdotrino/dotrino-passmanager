// Popup: qué hay para este sitio, y rellenar.
//
// Se abre y funciona: la extensión ES su propia bóveda mientras no enlaces otra, así que
// aquí no hay puerta de entrada que pase por configurar nada. Enlazar el daemon o la
// pestaña está al pie, para quien quiere sus contraseñas en un solo sitio.
//
// No hay contraseña maestra ni lista completa de golpe: cada credencial es una petición.
// Sin `alert`/`confirm`/`prompt` (CONVENCIONES §5).

import { pickLang, t, errorText } from './i18n.js'
import { entryCard, byName } from './entry-card.js'
import { wireTopbar } from './profile-card.js'
// Las dos pantallas de añadir perfil viven fuera: las comparte la página del perfil.
import { renderAdd, renderLink } from './add-profile.js'
// La bóveda puede pedir autorización mientras el popup está abierto (una contraseña que
// se copia o se rellena desde aquí): la pregunta sale AQUÍ, no en una ventana suelta, que
// cerraría el popup y con él lo que estabas haciendo.
import { hostApprovals } from './approval.js'

hostApprovals()

// El popup crece mientras el modal de soporte está abierto (ver `body.support-open`).
document.addEventListener('cc-support-open', () => document.body.classList.add('support-open'))
document.addEventListener('cc-support-close', () => document.body.classList.remove('support-open'))

let lang = pickLang()
const view = document.getElementById('view')
const toastEl = document.getElementById('toast')

function ask (op, payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ op, payload }, r => {
      if (chrome.runtime.lastError) return reject(Object.assign(new Error(chrome.runtime.lastError.message), { code: 'no-worker' }))
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

/** Los errores se comparan por código: el texto está traducido (`errorText`). */
const humanError = (e) => errorText(lang, e)

/**
 * Un elemento con sus propiedades. Los `data-*` van por `setAttribute`, no por
 * `Object.assign`: asignarlos como propiedad crea una propiedad del objeto y **no un
 * atributo**, así que `[data-testid=…]` no encontraba nada. Los de la pantalla de
 * enlazar llevaban así desde el principio y no se notó porque nunca hubo una prueba que
 * llegara hasta ahí (2026-08-29).
 */
function el (tag, props = {}, children = []) {
  const n = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('data-') || k === 'aria-label') n.setAttribute(k, v)
    else n[k] = v
  }
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
 * LOS PEDIDOS QUE ESPERAN. Solo salen si este navegador lleva el permiso de aprobar.
 *
 * No es la puerta de la bóveda de dentro (esa es `hostApprovals`, para cuando la bóveda
 * ES la extensión): aquí la bóveda vive fuera, otro aparato le pidió una llave privada, y
 * este es uno de los que puede decir que sí.
 *
 * Se repregunta cada pocos segundos mientras el popup está abierto, porque un pedido
 * puede llegar con la pantalla ya pintada — y porque el mismo pedido puede estar en
 * varios aparatos a la vez y contestarse desde otro.
 */
async function pintarPedidos (caja) {
  // Una vez por apertura: la identidad se vuelve a abrir y con ella jala el acta, que es
  // donde dice si este aparato puede aprobar. Sin esto, un permiso recién dado no llegaba.
  try { await ask('identity-refresh') } catch (_) {}

  const dibujar = async () => {
    let r = null
    try { r = await ask('approvals') } catch (_) { return }
    if (!r?.can) { caja.replaceChildren(); return }
    if (!r.items.length) { caja.replaceChildren(); return }
    caja.replaceChildren(
      el('h2', { textContent: t(lang, 'apvTitle') }),
      ...r.items.map((p) => {
        const si = el('button', { className: 'primary', textContent: t(lang, 'apvYes') })
        si.dataset.testid = `popup-apv-yes-${p.id}`
        const no = el('button', { className: 'ghost', textContent: t(lang, 'apvNo') })
        no.dataset.testid = `popup-apv-no-${p.id}`
        const contestar = async (yes) => {
          si.disabled = no.disabled = true
          try { await ask('approvals-answer', { id: p.id, yes }) } catch (e) { toast(humanError(e), 'error') }
          await dibujar()
        }
        si.onclick = () => contestar(true)
        no.onclick = () => contestar(false)
        const fila = el('li', { className: 'entry' }, [
          el('div', { className: 'who' }, [
            el('div', { className: 'name' }, [el('span', { className: 'nametext', textContent: t(lang, 'apvAsks', p.label || p.deviceId || '?') })]),
            el('div', { className: 'hint', textContent: p.ns || '' }),
          ]),
          el('div', { className: 'acts' }, [el('div', { className: 'btns' }, [no, si])]),
        ])
        fila.dataset.testid = `popup-apv-${p.id}`
        return el('ul', { className: 'entries' }, [fila])
      }),
    )
  }
  await dibujar()
  clearInterval(pintarPedidos.timer)
  pintarPedidos.timer = setInterval(dibujar, 4000)
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
  // DÓNDE ESTÁN GUARDADAS. Es una frase y nada más: llegar al perfil ya es el botón de la
  // barra, y un enlace más aquí solo repite el mismo destino.
  const pie = el('p', { className: 'hint foot' }, [
    el('span', { textContent: (propia ? t(lang, 'ownVault') : t(lang, 'linkedVault')) + ' ' }),
  ])
  if (!propia) {
    const soltar = el('button', { className: 'link', textContent: t(lang, 'unlink') })
    soltar.dataset.testid = 'popup-unlink'
    soltar.onclick = async () => { await ask('unlink'); render() }
    pie.append(soltar)
  }

  // LOS PEDIDOS DE OTROS APARATOS, si este navegador puede aprobarlos (§2.0). Va lo
  // primero y a propósito: alguien está esperando, y lo demás puede esperar a que
  // conteste. Si no puede aprobar —lo normal—, no ocupa ni una línea.
  const pedidos = el('div')
  pintarPedidos(pedidos)

  // El gestor va ARRIBA, entre los perfiles y lo de este sitio (dueño, 2026-08-29): es
  // de la bóveda entera, como los perfiles, y no una acción más de la última tarjeta.
  view.replaceChildren(
    pedidos,
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
    // Sin convertir no atiende: el mensaje dice qué pasa y el botón lleva a donde se arregla.
    if (e.code === 'not-sealed') {
      const ir = el('button', { className: 'btn', textContent: t(lang, 'openConvert'), 'data-testid': 'open-convert' })
      ir.onclick = () => ask('open-convert')
      estado.after(ir)
    }
  }
}

/** Lo que las pantallas de añadir perfil necesitan para pintarse aquí. */
const addCtx = () => ({ view, lang, ask, toast, humanError, onDone: render })

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


// La barra, con su selector de perfiles y tu avatar: lo pinta el componente.
wireTopbar(ask)
