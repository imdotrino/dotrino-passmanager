// Puente entre el parche de la página (world MAIN, sin `chrome.runtime`) y el service
// worker. Vive en el mundo aislado, que sí tiene acceso a la extensión.
//
// Lo único que hace es pasar mensajes. No decide, no guarda y no abre nada: quien
// decide es la bóveda del usuario, al otro lado del proxio.

const PIDE = 'dotrino-passmanager:webauthn:req'
const RESPONDE = 'dotrino-passmanager:webauthn:res'
const OPS = ['webauthn-create', 'webauthn-get']

window.addEventListener('message', (e) => {
  // Solo mensajes de ESTA ventana y con una operación conocida. Lo que llegue de un
  // iframe ajeno o con otra forma se ignora sin contestar.
  if (e.source !== window || e.data?.channel !== PIDE) return
  if (!OPS.includes(e.data.op)) return

  chrome.runtime.sendMessage({ op: e.data.op, payload: e.data.payload }, (r) => {
    const fallo = chrome.runtime.lastError || r?.error
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
