// Lo que el usuario ve en la página: un botón por campo, y un modal al pulsarlo.
//
// **El gestor NO autocompleta.** Nunca escribe en un formulario por su cuenta: marca
// los campos donde puede ayudar y espera. Rellenar es siempre una decisión del
// usuario, tomada en ese momento y sobre ese campo.
//
// Todo vive en un Shadow DOM propio: ni hereda los estilos del sitio ni se los toca.
// Nada de `alert`/`confirm`/`prompt` (CONVENCIONES §5).

const BRAND = '#00658c'
const HOST_ID = 'dotrino-passmanager-ui'

let host = null
let shadow = null
let markers = []   // { el, kind, node }
let onPick = null
let modal = null

function ensureHost () {
  if (host?.isConnected) return shadow
  host = document.createElement('div')
  host.id = HOST_ID
  // El host no debe estorbar: no ocupa, no captura, y está por encima de todo.
  host.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;z-index:2147483647'
  shadow = host.attachShadow({ mode: 'closed' })
  shadow.append(styles())
  document.documentElement.append(host)
  return shadow
}

function styles () {
  const s = document.createElement('style')
  s.textContent = `
    .marker {
      position: absolute;
      width: 15px; height: 15px;
      padding: 0; border: 0; margin: 0;
      background: ${BRAND};
      /* Un cuarto de circunferencia: recto arriba y a la derecha, curvo abajo a la
         izquierda. Se apoya en la esquina superior derecha del campo. */
      border-radius: 0 0 0 100%;
      cursor: pointer;
      opacity: .75;
      transition: opacity .12s ease;
      pointer-events: auto;
      box-shadow: 0 0 0 1px rgba(255,255,255,.55);
    }
    /* El aviso de guardar: abajo a la derecha, por encima de todo y sin heredar nada
       del sitio. Fijo, para que no se vaya con el scroll de la página. */
    .save-prompt {
      position: fixed;
      right: 16px; bottom: 16px;
      width: 320px; height: 168px;
      border: 0; border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0,0,0,.28);
      pointer-events: auto;
      color-scheme: normal;
    }
    .marker:hover, .marker:focus-visible { opacity: 1; outline: none; }
    .marker:focus-visible { box-shadow: 0 0 0 2px #fff, 0 0 0 4px ${BRAND}; }

    .backdrop {
      position: fixed; inset: 0;
      background: rgba(10,14,18,.38);
      display: flex; align-items: center; justify-content: center;
      padding: 16px;
    }
    .sheet {
      width: min(340px, 100%);
      max-height: 70vh; overflow: auto;
      background: #fff; color: #181c1e;
      border-radius: 14px;
      box-shadow: 0 18px 48px rgba(0,0,0,.3);
      font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
      padding: 14px;
    }
    @media (prefers-color-scheme: dark) {
      .sheet { background: #181d23; color: #e8eaf0; }
      .opt { border-color: #262e36 !important; }
      .opt:hover { background: #202832 !important; }
    }
    .head {
      display: flex; align-items: baseline; justify-content: space-between;
      gap: 10px; margin: 0 0 10px;
    }
    .title { font-weight: 650; font-size: 13px; }
    .what { font-size: 11px; opacity: .6; }
    .opts { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
    .opt {
      display: block; width: 100%; text-align: left;
      padding: 9px 11px; border-radius: 9px;
      border: 1px solid #e3e9ed; background: none; color: inherit;
      font: inherit; cursor: pointer;
    }
    .opt:hover { background: #f4f7f9; }
    .opt .name { font-weight: 600; display: block; }
    .opt .hint { font-size: 11px; opacity: .65; }
    .empty { margin: 0; font-size: 12px; opacity: .7; }
    .close {
      margin-top: 10px; width: 100%; padding: 8px;
      border: 0; border-radius: 9px; background: none; color: inherit;
      font: inherit; opacity: .6; cursor: pointer;
    }
    .close:hover { opacity: 1; }
  `
  return s
}

/** Coloca el botón en la esquina superior derecha de su campo. */
function place (node, el) {
  const r = el.getBoundingClientRect()
  if (!r.width || !r.height) { node.style.display = 'none'; return }
  node.style.display = ''
  node.style.left = `${r.right + window.scrollX - 15}px`
  node.style.top = `${r.top + window.scrollY}px`
}

export function reposition () {
  for (const m of markers) place(m.node, m.el)
}

/** Quita todos los botones. Se llama antes de volver a escanear. */
export function clearMarkers () {
  for (const m of markers) m.node.remove()
  markers = []
}

/**
 * Marca los campos donde el gestor puede ayudar.
 * @param {Array} fields  `[{ el, kind }]` — `kind` null para usuario/contraseña
 * @param {Function} pick  se llama con el campo elegido al pulsar el botón
 */
export function mountMarkers (fields, pick) {
  const sr = ensureHost()
  clearMarkers()
  onPick = pick

  for (const f of fields) {
    const node = document.createElement('button')
    node.className = 'marker'
    node.type = 'button'
    node.tabIndex = 0
    node.setAttribute('aria-label', 'Dotrino')
    node.title = 'Dotrino'
    node.dataset.kind = f.kind || 'login'
    node.addEventListener('mousedown', e => e.preventDefault()) // no robar el foco
    node.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      onPick?.(f)
    })
    sr.append(node)
    markers.push({ ...f, node })
    place(node, f.el)
  }
  return markers.length
}

/**
 * El modal con lo que se puede poner en ESE campo.
 * @param {object} opts  `{ title, what, options: [{ id, name, hint }], onChoose, onClose }`
 */
export function showModal ({ title, what, options = [], empty, onChoose, onClose }) {
  const sr = ensureHost()
  closeModal()

  const backdrop = document.createElement('div')
  backdrop.className = 'backdrop'

  const sheet = document.createElement('div')
  sheet.className = 'sheet'
  sheet.setAttribute('role', 'dialog')
  sheet.setAttribute('aria-modal', 'true')

  const head = document.createElement('div')
  head.className = 'head'
  const t = document.createElement('span')
  t.className = 'title'
  t.textContent = title || 'Dotrino'
  const w = document.createElement('span')
  w.className = 'what'
  w.textContent = what || ''
  head.append(t, w)
  sheet.append(head)

  if (options.length) {
    const ul = document.createElement('ul')
    ul.className = 'opts'
    for (const o of options) {
      const li = document.createElement('li')
      const b = document.createElement('button')
      b.className = 'opt'
      b.type = 'button'
      b.dataset.id = o.id
      const name = document.createElement('span')
      name.className = 'name'
      name.textContent = o.name
      b.append(name)
      if (o.hint) {
        const hint = document.createElement('span')
        hint.className = 'hint'
        hint.textContent = o.hint
        b.append(hint)
      }
      b.addEventListener('click', () => { closeModal(); onChoose?.(o) })
      li.append(b)
      ul.append(li)
    }
    sheet.append(ul)
  } else {
    const p = document.createElement('p')
    p.className = 'empty'
    p.textContent = empty || 'Nada guardado para este campo.'
    sheet.append(p)
  }

  const close = document.createElement('button')
  close.className = 'close'
  close.type = 'button'
  close.textContent = 'Cerrar'
  close.addEventListener('click', () => { closeModal(); onClose?.() })
  sheet.append(close)

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) { closeModal(); onClose?.() }
  })

  backdrop.append(sheet)
  sr.append(backdrop)
  modal = backdrop
  sheet.querySelector('.opt, .close')?.focus()
  return backdrop
}

export function closeModal () {
  modal?.remove()
  modal = null
}

/** Para las pruebas: el shadow root, que es cerrado y no se alcanza desde fuera. */
export function _shadow () { return shadow }

/**
 * EL AVISO DE «¿la guardo?», después de entrar.
 *
 * Es un IFRAME DE LA EXTENSIÓN, no HTML nuestro dentro de la página, y esa diferencia
 * es toda la seguridad de esto: el botón que acaba escribiendo en la bóveda se pulsa en
 * el origen `chrome-extension://`, así que la petición llega con ese origen y pasa por
 * la misma puerta que el popup. La página no puede pulsarlo, ni leerlo, ni fingirlo —
 * y no ve nada de lo que hay dentro.
 *
 * Aquí no viaja ninguna contraseña. Lo que se capturó vive en el service worker; el
 * aviso solo enseña de qué sitio y de qué usuario se trata.
 */
let prompt = null

export function mountSavePrompt (params) {
  const sr = ensureHost()
  closeSavePrompt()
  const frame = document.createElement('iframe')
  frame.className = 'save-prompt'
  frame.setAttribute('title', 'Dotrino')
  frame.src = chrome.runtime.getURL('src/save-prompt.html') + '?' + new URLSearchParams(params)
  sr.append(frame)
  prompt = frame
  return frame
}

export function closeSavePrompt () {
  prompt?.remove()
  prompt = null
}
