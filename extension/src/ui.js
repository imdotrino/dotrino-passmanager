// Lo que el usuario ve en la página: un botón por campo, y un modal al pulsarlo.
//
// **El gestor NO autocompleta.** Nunca escribe en un formulario por su cuenta: marca
// los campos donde puede ayudar y espera. Rellenar es siempre una decisión del
// usuario, tomada en ese momento y sobre ese campo.
//
// Todo vive en un Shadow DOM propio: ni hereda los estilos del sitio ni se los toca.
// Nada de `alert`/`confirm`/`prompt` (CONVENCIONES §5).

const BRAND = '#00658c'
export const HOST_ID = 'dotrino-passmanager-ui'

/**
 * DOS medidas, y son distintas a propósito:
 *
 *   · `DISC` — el cuarto de circunferencia azul, que NO crece: se apoya sobre el extremo
 *     derecho del campo, así que agrandarlo es tapar lo que el usuario escribe.
 *   · `BIRD` — el pájaro, que sí crece. Es lo único que hay que poder distinguir ahí, y
 *     atado al tamaño del disco no se reconoce.
 *
 * Del ave sale el tamaño del botón (es su caja), así que también su zona de pulsación:
 * se pulsa el pájaro entero, no solo el trozo azul.
 */
const DISC = 20
const BIRD = 34
const BIRD_H = +(BIRD * 203.17926 / 188.39659).toFixed(2)

/**
 * El pájaro de la marca, en blanco, para ir dentro del marcador.
 *
 * Es el mismo trazo de `icons/icon.svg` recortado a su caja: a 15 px el candado entero
 * no se lee, y el pájaro sí — es lo que hace que el botón se reconozca como de Dotrino y
 * no como un adorno del sitio. Va traslúcido a propósito: acompaña al campo, no compite
 * con él — y el marcador ya va al 75 %, así que las dos opacidades se multiplican. Como data URI porque el marcador vive en un Shadow DOM del content script y
 * pedirle un archivo a la extensión desde ahí obliga a exponerlo en el manifiesto.
 */
const MARK = "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%20188.39659%20203.17926'%20fill='%2300658c'%20stroke='%23ffffff'%20stroke-width='7'%20stroke-linejoin='round'%20paint-order='stroke'%3E%3Cpath%20d='m%2054.19,78.56%20c%200.1,0%200.63,0.78%201.17,1.73%201.3,2.26%203.1,4.24%205.45,5.98%203.01,2.23%205.89,3.55%2012.08,5.51%206.5,2.06%209.28,4.38%2010.4,8.68%200.6,2.32%200.45,4.09%20-0.85,9.52%20-0.28,1.18%20-0.54,2.18%20-0.58,2.22%20-0.04,0.04%20-0.35,-0.52%20-0.7,-1.23%20-0.78,-1.59%20-2.37,-3.1%20-4.17,-3.94%20-1.2,-0.56%20-1.63,-0.63%20-3.75,-0.61%20-1.31,0.01%20-3.53,0.11%20-4.93,0.21%20-3.11,0.23%20-3.93,-0.03%20-2.46,-0.78%201.63,-0.83%204.09,-3.55%203.63,-4.01%20-0.05,-0.05%20-1.65,-0.14%20-3.55,-0.19%20-4.77,-0.13%20-7.26,-0.98%20-9.33,-3.18%20-0.85,-0.91%20-2.05,-2.71%20-1.8,-2.71%200.07,0%200.66,0.21%201.3,0.46%201.77,0.7%204.49,1%206.54,0.74%200.96,-0.12%201.87,-0.23%202.03,-0.23%200.34,-0.01%201.03,-0.67%201.03,-0.98%200,-0.12%20-0.99,-0.71%20-2.19,-1.32%20-2.73,-1.37%20-4.28,-2.51%20-5.98,-4.39%20-2.48,-2.74%20-3.53,-5.52%20-3.53,-9.31%200,-1.2%200.08,-2.18%200.18,-2.17%20z'/%3E%3Cpath%20d='m%2093.81,80.54%20c%20-0.51,0.01%20-1.01,0.06%20-1.51,0.16%20-4.55,0.88%20-7.43,3.69%20-8.97,8.75%20l%20-0.59,1.93%200.92,0.98%200.92,0.98%200.26,-1%20c%201.35,-5.18%202.72,-7.33%205.56,-8.73%201.33,-0.65%201.79,-0.76%203.39,-0.76%201.56,0%202.08,0.11%203.36,0.72%201.8,0.86%203.28,2.43%203.88,4.1%200.35,0.99%200.54,1.2%201.25,1.39%200.46,0.13%200.97,0.23%201.14,0.23%200.57,0%200.28,0.36%20-0.64,0.79%20-0.51,0.24%20-0.79,0.9%20-0.87,1.13%20-0.09,0.22%20-0.46,1.51%20-0.58,3.22%20-0.55,8.03%20-5.02,15.6%20-7.87,18.6%20-2.84,2.99%20-2.36,2.48%20-3.79,3.58%20-1.43,1.1%20-4.68,3.47%20-4.76,3.67%20-0.17,0.45%200.2,0.35%202.71,-0.68%203.27,-1.35%206.1,-3.32%208.57,-5.99%204.35,-4.7%206.54,-10.32%207.31,-18.74%20l%200.65,-2.82%201.81,-1.53%20c%201.2,-0.66%202.36,-1.27%202.59,-1.36%200.23,-0.09%200.42,-0.23%200.42,-0.32%200,-0.09%20-1.23,-0.47%20-2.73,-0.85%20-1.5,-0.38%20-2.82,-0.75%20-2.93,-0.83%20-0.11,-0.08%20-0.49,-0.74%20-0.85,-1.46%20-1.6,-3.2%20-5.11,-5.25%20-8.65,-5.19%20z'/%3E%3Cpath%20d='m%2095.47,86.76%20c%20-0.71,0%20-1.71,0.52%20-2.02,1.1%20-0.62,1.16%200.1,2.99%201.25,3.17%200.83,0.13%201.92,-0.23%202.39,-0.79%200.92,-1.11%200.16,-3.08%20-1.33,-3.45%20-0.09,-0.02%20-0.18,-0.03%20-0.29,-0.03%20z'/%3E%3Cpath%20d='m%2082.14,122.72%20c%201.2,-0.04%202.39,0.35%203.4,1.3%201.93,1.79%202.41,4.6%201.06,6.26%20-1.35,1.66%20-4,1.55%20-5.94,-0.24%20-1.93,-1.79%20-2.41,-4.59%20-1.06,-6.26%200.59,-0.72%201.54,-1.02%202.54,-1.05%20z'/%3E%3Cpath%20d='m%2054.41,72.95%20-0.71,1.54%20c%20-3.15,6.83%20-1.62,13.95%204,18.59%200.66,0.55%201.47,1.22%201.8,1.49%20l%200.6,0.5%20-0.96,-0.15%20c%20-1.41,-0.23%20-4.34,-1.47%20-5.94,-2.52%20-0.77,-0.51%20-1.43,-0.92%20-1.46,-0.92%20-0.12,0%200.39,2.8%200.69,3.85%201.38,4.66%205.03,7.59%2010.39,8.31%200.98,0.13%201.86,0.19%201.97,0.12%200.11,-0.07%200.19,-0.03%200.19,0.08%200,0.5%20-3.52,1.98%20-4.72,1.98%20-0.53,0%20-0.5,0.07%200.46,0.87%202.03,1.7%204.44,2.36%207.89,2.17%201.29,-0.07%202.35,-0.04%202.35,0.06%200,0.53%20-2.19,3.34%20-4.13,5.31%20-2.1,2.13%20-4.31,3.9%20-8.76,7.02%20-4.64,3.26%20-7.42,6.83%20-7.42,9.52%200,1.22%200.82,3.24%201.39,3.43%200.14,0.05%200.38,-0.38%200.53,-0.95%200.85,-3.18%202.99,-6.49%206.27,-9.69%202.09,-2.04%202.85,-2.55%201.76,-1.19%20-2.91,3.62%20-4.21,6.11%20-4.4,8.44%20-0.16,1.96%200.36,3.41%201.57,4.41%200.48,0.4%200.94,0.72%201.02,0.72%200.08,0%200.32,-1.26%200.53,-2.81%200.77,-5.7%202.86,-10.09%207,-14.71%204.7,-5.24%205.63,-6.37%206.59,-7.98%200.56,-0.95%201.13,-1.77%201.27,-1.82%200.52,-0.21%202.46,0.59%203.41,1.4%201.86,1.59%202.91,4.06%202.92,6.84%20-2.18,4.31%20-2,3.86%20-2.67,4.94%20-0.09,0.26%20-0.62,1.73%20-0.87,2.89%20-0.25,1.16%20-0.24,2.48%200.55,4.36%200.51,1.22%201.45,2.25%202.18,2.87%200.73,0.62%201.93,1.47%203.16,1.73%201.22,0.26%202.83,0.23%204.43,-1.09%201.39,-1.14%202.17,-3.35%201.83,-5.16%20-0.47,-2.53%20-1.42,-3.71%20-2.98,-4.64%20-4.65,-2.76%20-6.72,1.35%20-6.61,0.89%20l%201.67,-2.72%20c%200.96,-1.97%201.95,-4.37%202.79,-7.1%201.61,-7.45%201.74,-8.12%201.89,-9.68%200.42,-4.2%20-1.79,-8.95%20-5.34,-11.43%20-2.01,-1.4%20-3.05,-1.83%20-8.87,-3.62%20-4.18,-1.28%20-5.53,-1.88%20-8.32,-3.7%20-4.17,-2.71%20-6.91,-6.22%20-8.41,-10.76%20z'/%3E%3C/svg%3E"

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
    /* El botón es la caja del PÁJARO; el disco es una pieza suya, y más pequeña. */
    .marker {
      position: absolute;
      width: ${BIRD}px; height: ${BIRD_H}px;
      padding: 0; border: 0; margin: 0;
      background: none;
      overflow: visible;
      cursor: pointer;
      opacity: .75;
      transition: opacity .12s ease;
      pointer-events: auto;
    }
    /* El cuarto de circunferencia: recto arriba y a la derecha, curvo abajo a la
       izquierda. Se apoya en la esquina superior derecha del campo y NO crece. */
    .marker::before {
      content: '';
      position: absolute; top: 0; right: 0;
      width: ${DISC}px; height: ${DISC}px;
      background: ${BRAND};
      border-radius: 0 0 0 100%;
      box-shadow: 0 0 0 1px rgba(255,255,255,.55);
    }
    /* Y el pájaro encima, centrado sobre el disco y mayor que él: traslúcido, se apoya
       en el azul en vez de taparlo, y las dos piezas cuadran como una sola. Va relleno de azul
       con reborde blanco porque cruza dos fondos: el azul del disco y el del campo. Ni
       blanco ni azul a secas se ven en los dos. */
    .marker::after {
      content: '';
      position: absolute;
      /* Centrado sobre el disco, no en su propia caja: centrado en la caja se descolgaba
         y parecían dos cosas sueltas. Los valores son del dueño. */
      top: -10px; right: -12px;
      width: ${BIRD}px; height: ${BIRD_H}px;
      background: url("${MARK}") no-repeat center / contain;
    }
    /* El aviso de guardar: abajo a la derecha, por encima de todo y sin heredar nada
       del sitio. Fijo, para que no se vaya con el scroll de la página. */
    .save-prompt {
      position: fixed;
      right: 16px; bottom: 16px;
      /* El alto es provisional: lo fija el propio aviso cuando sabe cuánto ocupa
         con sizeSavePrompt, porque la lista de campos no mide siempre lo mismo. */
      width: 320px; height: 168px;
      max-height: 70vh;
      border: 0; border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0,0,0,.28);
      pointer-events: auto;
      color-scheme: normal;
    }
    /* El modal de un campo: pegado a su marcador, no en el centro de la pantalla. Va en
       coordenadas del documento para seguir a su campo al hacer scroll. */
    .field-modal {
      position: absolute;
      width: ${MODAL_W}px; height: 200px;
      border: 0; border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0,0,0,.34);
      pointer-events: auto;
      color-scheme: normal;
    }
    .marker:hover, .marker:focus-visible { opacity: 1; outline: none; }
    .marker:focus-visible::before { box-shadow: 0 0 0 2px #fff, 0 0 0 4px ${BRAND}; }

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
      .act.ghost { border-color: #2b333c !important; }
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
    .lead { margin: 0 0 8px; font-size: 12px; opacity: .75; }
    .act {
      margin-top: 8px; width: 100%; padding: 9px;
      border: 0; border-radius: 9px; background: ${BRAND}; color: #fff;
      font: inherit; font-weight: 600; cursor: pointer;
    }
    .act.ghost {
      background: none; color: inherit; border: 1px solid #d5dee4; font-weight: 500;
    }
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
  node.style.left = `${r.right + window.scrollX - BIRD}px`
  node.style.top = `${r.top + window.scrollY}px`
}

export function reposition () {
  for (const m of markers) place(m.node, m.el)
  placeFieldModal()
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
    node.setAttribute('aria-label', f.title || 'Dotrino')
    node.title = f.title || 'Dotrino'
    node.dataset.kind = f.kind || 'login'
    node.addEventListener('mousedown', e => e.preventDefault()) // no robar el foco
    // Se le pasa el marcador ENTERO, con su nodo: el modal sale pegado a él, así que
    // quien lo abre tiene que saber dónde está.
    const marker = { ...f, node }
    node.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      onPick?.(marker)
    })
    sr.append(node)
    markers.push(marker)
    place(node, f.el)
  }
  return markers.length
}

/**
 * El modal con lo que se puede hacer en ESE campo: poner algo guardado, o guardar lo que
 * hay escrito.
 * @param {object} opts  `{ title, what, options: [{ id, name, hint }], empty, action,
 *   closeLabel, onChoose, onClose }` — `action` es `{ label, onAction }`
 */
export function showModal ({ title, what, lead, options = [], empty, actions = [], closeLabel, onChoose, onClose }) {
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

  // Qué significa pulsar una de las opciones. Sin esto la lista es ambigua: no se sabe
  // si eliges de dónde rellenar o qué reemplazar.
  if (lead) {
    const p = document.createElement('p')
    p.className = 'lead'
    p.textContent = lead
    sheet.append(p)
  }

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

  // Lo que se puede hacer además de elegir de la lista. Va abajo y separado: no son
  // opciones más de «qué pongo aquí», son las otras cosas que se pueden hacer.
  for (const a of actions.filter(Boolean)) {
    const b = document.createElement('button')
    b.className = a.ghost ? 'act ghost' : 'act'
    b.type = 'button'
    if (a.testid) b.dataset.testid = a.testid
    b.textContent = a.label
    b.addEventListener('click', () => { closeModal(); a.onAction?.() })
    sheet.append(b)
  }

  const close = document.createElement('button')
  close.className = 'close'
  close.type = 'button'
  close.textContent = closeLabel || 'Cerrar'
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

/**
 * El alto que el aviso pide. Lo dibuja la página, así que su propio CSS no puede
 * fijarlo: sin esto la lista de campos se corta por abajo.
 *
 * Se acota igual, y no por desconfianza del aviso —es nuestro— sino porque una lista
 * larga en una ventana pequeña taparía la página entera.
 */
export function sizeSavePrompt (h) {
  if (!prompt || !Number.isFinite(h)) return
  prompt.style.height = `${Math.max(96, Math.min(h, Math.round(window.innerHeight * 0.7)))}px`
}

/** La ventana del aviso, para reconocer sus mensajes y no los de la página. */
export function promptWindow () {
  return prompt?.contentWindow || null
}

// --- EL MODAL DE UN CAMPO ------------------------------------------------------
//
// Pegado a su marcador, a la derecha; a la izquierda si no cabe. Y es un iframe de la
// extensión por lo mismo que el aviso: ahí dentro se pulsa «Guardar», y eso tiene que
// nacer fuera de la página.

const MODAL_W = 288
let fieldModal = null
let fieldAnchor = null

export function mountFieldModal ({ key, name, anchor }) {
  const sr = ensureHost()
  closeFieldModal()
  const frame = document.createElement('iframe')
  frame.className = 'field-modal'
  frame.setAttribute('title', 'Dotrino')
  frame.src = chrome.runtime.getURL('src/field-modal.html') + '?' +
    new URLSearchParams({ key: key || '', name: name || '' })
  sr.append(frame)
  fieldModal = frame
  fieldAnchor = anchor || null
  placeFieldModal()
  return frame
}

export function closeFieldModal () {
  fieldModal?.remove()
  fieldModal = null
  fieldAnchor = null
}

export function fieldModalWindow () {
  return fieldModal?.contentWindow || null
}

export function fieldModalOpen () {
  return !!fieldModal
}

export function sizeFieldModal (h) {
  if (!fieldModal || !Number.isFinite(h)) return
  fieldModal.style.height = `${Math.max(80, Math.min(h, Math.round(window.innerHeight * 0.8)))}px`
  placeFieldModal()
}

/** A la derecha del marcador, o a su izquierda si ahí no cabe. Sin salirse abajo. */
function placeFieldModal () {
  if (!fieldModal || !fieldAnchor?.isConnected) return
  const r = fieldAnchor.getBoundingClientRect()
  const alto = parseInt(fieldModal.style.height, 10) || 200
  const cabeADerecha = r.right + 8 + MODAL_W <= window.innerWidth
  const x = cabeADerecha ? r.right + 8 : Math.max(8, r.left - 8 - MODAL_W)
  const y = Math.max(8, Math.min(r.top, window.innerHeight - alto - 8))
  fieldModal.style.left = `${x + window.scrollX}px`
  fieldModal.style.top = `${y + window.scrollY}px`
}
