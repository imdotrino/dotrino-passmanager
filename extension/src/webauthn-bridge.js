// Puente entre el parche de la página (world MAIN, sin `chrome.runtime`) y el service
// worker. Vive en el mundo aislado, que sí tiene acceso a la extensión.
//
// Lo único que hace es pasar mensajes. No decide, no guarda y no abre nada: quien
// decide es la bóveda del usuario, al otro lado del proxio.

const PIDE = 'dotrino-passmanager:webauthn:req'
const RESPONDE = 'dotrino-passmanager:webauthn:res'
const OPS = ['webauthn-has', 'webauthn-create', 'webauthn-get']

window.addEventListener('message', (e) => {
  // Solo mensajes de ESTA ventana y con una operación conocida. Lo que llegue de un
  // iframe ajeno o con otra forma se ignora sin contestar.
  if (e.source !== window || e.data?.channel !== PIDE) return
  if (!OPS.includes(e.data.op)) return

  chrome.runtime.sendMessage({ op: e.data.op, payload: e.data.payload }, (r) => {
    const fallo = chrome.runtime.lastError || r?.error
    // Crear terminó: el aviso sobra, salvo si se queda enseñando por qué falló el guardado.
    if ((e.data.op === 'webauthn-create' || e.data.op === 'webauthn-get') && (!fallo || r?.error?.code === 'use-browser')) { avisoPasskey?.host.remove(); avisoPasskey = null }
    window.postMessage({
      channel: RESPONDE,
      id: e.data.id,
      // `fallback` significa: sigue con el navegador. Que el gestor no pueda no es
      // motivo para dejar al usuario sin entrar en su sitio.
      fallback: !!fallo,
      result: fallo ? null : r?.result,
    }, location.origin)
  })
})

// EL AVISO DE «¿DÓNDE GUARDO LA PASSKEY?». Lo pide el service worker, solo en el marco de
// arriba, y es un iframe de la extensión: el clic nace ahí, fuera de la página, así que
// el sitio no puede elegir por la persona. Aquí solo se monta y se quita.
// Los content scripts comparten el ámbito global (content.js ya declara `EXT_ORIGIN`): lo
// de aquí va con nombres propios para no chocar.
let avisoPasskey = null
const PASSKEY_EXT_ORIGIN = new URL(chrome.runtime.getURL('')).origin

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (sender.id !== chrome.runtime.id || msg?.op !== 'dotrino-passkey-prompt' || window !== window.top) return
  avisoPasskey?.host.remove()
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647'
  const sr = host.attachShadow({ mode: 'closed' })
  const frame = document.createElement('iframe')
  frame.title = 'Dotrino'
  frame.src = chrome.runtime.getURL('src/passkey-prompt.html') + '#' + encodeURIComponent(msg.req)
  frame.style.cssText = 'width:340px;height:170px;border:0;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.28);color-scheme:normal'
  sr.append(frame)
  document.documentElement.append(host)
  avisoPasskey = { host, frame }
})

window.addEventListener('message', (e) => {
  // Solo el propio aviso puede cerrarse o medirse: la página no lo quita ni lo estira.
  if (!avisoPasskey || e.source !== avisoPasskey.frame.contentWindow || e.origin !== PASSKEY_EXT_ORIGIN) return
  if (e.data?._dotrino === 'close-passkey-prompt') { avisoPasskey.host.remove(); avisoPasskey = null }
  if (e.data?._dotrino === 'size-passkey-prompt' && Number.isFinite(e.data.h)) {
    avisoPasskey.frame.style.height = `${Math.max(96, Math.min(e.data.h, Math.round(innerHeight * 0.7)))}px`
  }
})
