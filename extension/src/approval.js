// LA PREGUNTA DE LA BÓVEDA, dibujada donde el usuario está mirando.
//
// La bóveda de dentro de la extensión pide autorización antes de soltar una contraseña,
// igual que el daemon o la pestaña del vault (DISENO §2.0 y §3.3.1). Ahí la pregunta
// sale en la consola o en el teléfono; aquí no hay «ahí», así que sale en la pantalla de
// la extensión que esté abierta: el popup, el modal de un campo o el aviso de guardar.
//
// **Siempre en el origen `chrome-extension://`**, nunca en la página. Es la misma regla
// que el botón que escribe en la bóveda: si la página pudiera dibujar esta pregunta,
// podría dibujarla cuando quisiera y contestarse que sí.
//
// El que decide sigue siendo el service worker: esto solo dibuja y devuelve el clic.

import { t, pickLang } from './i18n.js'

export const APPROVAL_PORT = 'pm-approval'

const CSS = `
.pm-ask-back {
  position: fixed; inset: 0; z-index: 2147483647;
  background: rgba(8,10,14,.72); backdrop-filter: blur(2px);
  display: flex; align-items: center; justify-content: center; padding: 12px;
  font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
.pm-ask {
  width: 100%; max-width: 300px; background: #14161c; color: #e9edf2;
  border: 1px solid rgba(255,255,255,.14); border-radius: 12px; padding: 12px 13px;
  box-shadow: 0 12px 34px rgba(0,0,0,.5);
}
.pm-ask .pm-brand { display: flex; align-items: center; gap: 7px; margin-bottom: 9px; }
.pm-ask .pm-brand img { width: 16px; height: 16px; display: block; }
.pm-ask .pm-brand b { font-size: .86rem; }
.pm-ask h3 { margin: 0 0 6px; font-size: .92rem; font-weight: 600; }
.pm-ask .pm-who {
  font-size: .84rem; background: rgba(255,255,255,.06); border-radius: 8px;
  padding: 7px 9px; margin-bottom: 8px; overflow: hidden; text-overflow: ellipsis;
}
.pm-ask .pm-who span { display: block; font-size: .72rem; opacity: .6; margin-top: 2px; }
.pm-ask p { margin: 0 0 11px; font-size: .78rem; opacity: .7; }
.pm-ask .pm-acts { display: flex; gap: 8px; }
.pm-ask button {
  flex: 1; padding: 8px 10px; border-radius: 8px; font: inherit; font-size: .82rem;
  cursor: pointer; border: 1px solid rgba(255,255,255,.16);
  background: rgba(255,255,255,.06); color: inherit;
}
.pm-ask button.pm-yes { background: #00658c; border-color: #00658c; color: #fff; font-weight: 600; }
.pm-ask button:focus-visible { outline: 2px solid #4cc2ff; outline-offset: 1px; }
`

/**
 * Enchufa esta pantalla como sitio donde la bóveda puede preguntar.
 *
 * @param {object} opts
 *   `resize()`  opcional — la llaman las pantallas que viven en un iframe y se miden
 *      solas, para que la pregunta quepa.
 */
export function hostApprovals ({ resize, standalone, onAnswer } = {}) {
  const lang = pickLang()
  let port = null
  let abierta = null   // { rid, back }
  let latido = null

  const style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)

  const connect = () => {
    try { port = chrome.runtime.connect({ name: APPROVAL_PORT }) } catch (_) { return }
    port.postMessage({
      t: 'hello',
      visible: document.visibilityState !== 'hidden',
      // La ventana propia es el último recurso: mientras haya una pantalla de verdad
      // abierta, la pregunta sale ahí y no se abre nada.
      standalone: !!standalone,
    })
    port.onMessage.addListener(m => {
      if (m?.t === 'ask') draw(m.rid, m.q || {})
      // La misma pregunta contestada en otra pantalla: esta se quita sin decir nada.
      if (m?.t === 'done' && abierta?.rid === m.rid) drop()
    })
    // Si el worker se duerme y el puerto cae, se vuelve a enchufar: una pantalla abierta
    // que ya no puede recibir la pregunta deja la bóveda esperando a nadie.
    port.onDisconnect.addListener(() => { port = null; drop(); setTimeout(connect, 400) })
  }

  document.addEventListener('visibilitychange', () => {
    try { port?.postMessage({ t: 'visible', visible: document.visibilityState !== 'hidden' }) } catch (_) {}
  })

  function drop () {
    if (latido) clearInterval(latido)
    latido = null
    abierta?.back?.remove()
    abierta = null
    if (document.body) document.body.style.minHeight = ''
    resize?.()
  }

  function answer (rid, ok) {
    try { port?.postMessage({ t: 'answer', rid, ok }) } catch (_) {}
    drop()
    onAnswer?.(ok)
  }

  function draw (rid, q) {
    drop()
    const back = document.createElement('div')
    back.className = 'pm-ask-back'
    back.setAttribute('data-testid', 'approval')

    const caja = document.createElement('div')
    caja.className = 'pm-ask'
    caja.setAttribute('role', 'dialog')
    caja.setAttribute('aria-modal', 'true')

    const marca = document.createElement('div')
    marca.className = 'pm-brand'
    const logo = document.createElement('img')
    logo.src = chrome.runtime.getURL('icons/icon-32.png')
    logo.alt = ''
    const nombre = document.createElement('b')
    nombre.textContent = 'Dotrino'
    marca.append(logo, nombre)

    const h = document.createElement('h3')
    h.textContent = t(lang, 'askTitle')

    const quien = document.createElement('div')
    quien.className = 'pm-who'
    quien.textContent = q.who || q.title || t(lang, 'askOther')
    if (q.site || q.title) {
      const sub = document.createElement('span')
      sub.textContent = q.site || q.title
      quien.appendChild(sub)
    }

    const p = document.createElement('p')
    p.textContent = t(lang, 'askBody')

    const acts = document.createElement('div')
    acts.className = 'pm-acts'
    const no = document.createElement('button')
    no.type = 'button'
    no.textContent = t(lang, 'askNo')
    no.setAttribute('data-testid', 'approval-no')
    const si = document.createElement('button')
    si.type = 'button'
    si.className = 'pm-yes'
    si.textContent = t(lang, 'askYes')
    si.setAttribute('data-testid', 'approval-yes')
    no.onclick = () => answer(rid, false)
    si.onclick = () => answer(rid, true)
    acts.append(no, si)

    caja.append(marca, h, quien, p, acts)
    back.appendChild(caja)
    document.body.appendChild(back)
    // Un iframe pequeño recorta la pregunta: se le pide sitio antes de medirse.
    document.body.style.minHeight = '215px'
    abierta = { rid, back }
    resize?.()
    si.focus()

    // Un puerto con tráfico mantiene despierto al worker: si se duerme con la pregunta
    // en pantalla, la respuesta no llega a ninguna parte.
    latido = setInterval(() => { try { port?.postMessage({ t: 'ping' }) } catch (_) {} }, 20000)
  }

  connect()
}
