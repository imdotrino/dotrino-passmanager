// EL AVISO DE «¿DÓNDE GUARDO LA PASSKEY?», cuando un sitio pide crear una.
//
// Corre en el origen de la extensión (un iframe suyo incrustado en la página): el clic que
// escribe en la bóveda nace aquí, no en el sitio, y el sitio no puede pulsarlo ni fingirlo.
// Dos salidas, y ninguna en silencio: «Guardar en Dotrino», o «Ahora no», que se la deja
// al navegador como siempre (dueño, 2026-10-16).

import { t, pickLang, errorText } from './i18n.js'

const lang = pickLang()
const $ = (id) => document.getElementById(id)
const req = decodeURIComponent(location.hash.slice(1))

document.documentElement.lang = lang
$('title').textContent = t(lang, 'pkTitle')
$('why').textContent = t(lang, 'pkWhy')
$('save').textContent = t(lang, 'pkSave')
$('no').textContent = t(lang, 'notNow')

const ask = (op, payload) => new Promise((resolve, reject) => {
  chrome.runtime.sendMessage({ op, payload }, (r) => {
    if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message))
    if (r?.error) return reject(Object.assign(new Error(r.error.message || r.error.code), { code: r.error.code }))
    resolve(r?.result)
  })
})

const post = (msg) => { try { window.parent.postMessage(msg, '*') } catch (_) {} }
const close = () => post({ _dotrino: 'close-passkey-prompt' })
const resize = () => requestAnimationFrame(() =>
  post({ _dotrino: 'size-passkey-prompt', h: Math.ceil(document.documentElement.getBoundingClientRect().height) + 2 }))

function fail (e) {
  $('err').textContent = errorText(lang, e)
  $('err').hidden = false
  // El sitio ya siguió con el navegador: aquí solo queda cerrar.
  $('save').hidden = true
  $('no').textContent = t(lang, 'close')
  $('no').disabled = false
  $('no').onclick = close
  resize()
}

$('no').onclick = async () => {
  $('save').disabled = true; $('no').disabled = true
  try { await ask('passkey-choose', { req, choice: 'browser' }) } catch (_) {}
  close()
}

$('save').onclick = async () => {
  $('save').disabled = true; $('no').disabled = true
  $('why').textContent = t(lang, 'pkSaving')
  try {
    await ask('passkey-choose', { req, choice: 'dotrino' })
    close()
  } catch (e) { fail(e) }
}

try {
  const o = await ask('passkey-offer', { req })
  $('who').textContent = t(lang, 'pkFor', o.rpName && o.rpName !== o.rpId ? `${o.rpName} (${o.rpId})` : o.rpId, o.userName)
  $('save').disabled = false
  $('save').focus()
} catch (e) { fail(e) }
resize()
