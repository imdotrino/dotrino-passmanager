// Lo que repiten las páginas de la extensión (popup, gestor, perfil, avisos). Antes cada
// una traía su copia, y las copias ya decían cosas distintas: una perdía el código del
// error y otra no sabía poner un `data-*`.

/**
 * Pregunta al service worker. Lo que no contesta es la EXTENSIÓN (`no-worker`), no la
 * bóveda: con otro código la pantalla culparía a quien no es.
 */
export function askWorker (op, payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ op, payload }, (r) => {
      if (chrome.runtime.lastError) return reject(Object.assign(new Error(chrome.runtime.lastError.message), { code: 'no-worker' }))
      if (r?.error) return reject(Object.assign(new Error(r.error.message || r.error.code), { code: r.error.code }))
      resolve(r?.result)
    })
  })
}

/** Crea un elemento. Lo que lleva guion (`data-*`, `aria-*`) va como atributo; lo demás, como propiedad. */
export function el (tag, props = {}, children = []) {
  const n = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (k.includes('-')) n.setAttribute(k, v)
    else n[k] = v
  }
  for (const c of [].concat(children)) if (c) n.append(c)
  return n
}

/** Un aviso breve en `toastEl`, que se esconde solo. */
export function makeToast (toastEl, ms = 2600) {
  let timer
  return (text, kind) => {
    toastEl.textContent = text
    toastEl.dataset.kind = kind || 'ok'
    toastEl.hidden = false
    clearTimeout(timer)
    timer = setTimeout(() => { toastEl.hidden = true }, ms)
  }
}
