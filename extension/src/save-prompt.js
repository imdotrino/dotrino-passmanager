// El aviso de «¿la guardo?» que sale DESPUÉS de entrar, en la página siguiente.
//
// Corre en el origen de la extensión (es un iframe suyo, incrustado en la página), y de
// ahí sale toda su seguridad: el clic que escribe en la bóveda nace aquí, no en el
// sitio, así que llega al service worker con origen `chrome-extension://` y pasa por la
// misma puerta que el popup. La página no puede pulsarlo, ni leerlo, ni fingirlo.
//
// **La contraseña no pasa por aquí.** Lo capturado vive en el service worker; esta
// pantalla solo enseña de qué sitio y de qué usuario se trata, y le dice «guárdalo».

import { t, pickLang } from './i18n.js'

const lang = pickLang()
const p = new URLSearchParams(location.search)
const host = p.get('host') || ''
const user = p.get('user') || ''
const dup = p.get('dup') || ''          // id de la entrada parecida, si la hay
const dupHint = p.get('dupHint') || ''

const $ = (id) => document.getElementById(id)

$('user').textContent = user || t(lang, 'noUser')
$('host').textContent = host
document.querySelector('[data-t="title"]').textContent = t(lang, 'askSave')
$('save').textContent = dup ? t(lang, 'saveAsNew') : t(lang, 'save')
$('no').textContent = t(lang, 'notNow')
document.documentElement.lang = lang

// Ya hay una cuenta que se le parece en este sitio. No se decide por el usuario cuál
// es: se le enseñan las dos salidas, porque actualizar la equivocada le pisa una
// contraseña que sí servía.
if (dup) {
  $('note').textContent = t(lang, 'dupNote', dupHint)
  $('note').hidden = false
  $('update').textContent = t(lang, 'update')
  $('update').hidden = false
}

const ask = (op, payload) => new Promise((resolve, reject) => {
  chrome.runtime.sendMessage({ op, payload }, (r) => {
    if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message))
    if (r?.error) return reject(Object.assign(new Error(r.error.message || r.error.code), { code: r.error.code }))
    resolve(r?.result)
  })
})

/** Cerrarse es pedirle al content script que quite el iframe: él es quien lo montó. */
const close = () => { try { window.parent.postMessage({ _dotrino: 'close-save-prompt' }, '*') } catch (_) {} }

function fail (e) {
  $('err').textContent = e?.code === 'denied'
    ? t(lang, 'denied')
    : (e?.code === 'no-link' || e?.code === 'unreachable') ? t(lang, 'noLink')
        : (e?.message || String(e))
  $('err').hidden = false
  for (const b of document.querySelectorAll('button')) b.disabled = false
}

async function save (id) {
  for (const b of document.querySelectorAll('button')) b.disabled = true
  try {
    await ask('save-pending', id ? { id } : {})
    close()
  } catch (e) { fail(e) }
}

$('save').onclick = () => save(null)
$('update').onclick = () => save(dup)
$('no').onclick = async () => {
  // Descartar BORRA lo capturado. Si se quedara ahí, un «ahora no» dejaría una
  // contraseña en claro esperando en la memoria del navegador sin que nadie la pidiera.
  try { await ask('dismiss-pending') } catch (_) {}
  close()
}

$('save').focus()
