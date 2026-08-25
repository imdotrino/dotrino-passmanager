// Content script: encuentra el formulario de acceso y rellena cuando se lo piden.
//
// No tiene la bóveda ni la CEK: le pregunta al service worker qué hay para ESTE sitio
// y solo pide una credencial cuando el usuario elige (DISENO §2). Por eso ni siquiera
// puede llamar a `list` — el propio worker se lo niega.

// Un content script MV3 no se carga como módulo, así que la detección entra por
// import dinámico desde `web_accessible_resources`. Es el patrón estándar, y evita
// tener que meter un empaquetador solo para esto.
const detect = import(chrome.runtime.getURL('src/detect.js'))

let lastForms = []

async function scan () {
  try {
    const { findLoginForms } = await detect
    lastForms = findLoginForms(document)
  } catch { lastForms = [] }
  return lastForms
}

function ask (op, payload) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ op, payload }, r => {
      if (chrome.runtime.lastError) resolve({ error: { code: 'unreachable' } })
      else resolve(r || { error: { code: 'empty' } })
    })
  })
}

async function fillInto (target, { username, secret }) {
  if (!target) return false
  const { fillField } = await detect
  let done = false
  if (target.username && username) done = fillField(target.username, username) || done
  if (target.password && secret) done = fillField(target.password, secret) || done
  return done
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.op === 'page-forms') {
    scan().then(forms => sendResponse({
      result: { count: forms.length, hasUsername: forms.some(f => f.username) },
    }))
    return true
  }
  if (msg?.op === 'page-fill') {
    (lastForms.length ? Promise.resolve(lastForms) : scan())
      .then(forms => fillInto(forms[0], msg.payload || {}))
      .then(filled => sendResponse({ result: { filled } }))
    return true
  }
  return false
})

// Las SPA remontan el formulario después de cargar la página; sin esto el gestor
// funciona en la primera visita y deja de funcionar al navegar dentro del sitio.
const observer = new MutationObserver(() => {
  clearTimeout(observer._t)
  observer._t = setTimeout(scan, 300)
})
observer.observe(document.documentElement, { childList: true, subtree: true })
scan().then(forms => {
  // Aviso al worker de que aquí hay un formulario, para que la extensión pueda
  // señalarlo sin que el usuario abra el popup a ciegas.
  if (forms.length) ask('status')
})
