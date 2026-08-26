// Parche de `navigator.credentials` en el contexto de LA PÁGINA (world: MAIN).
//
// Chrome no expone API de proveedor de credenciales a las extensiones, así que esta es
// la única vía en el escritorio, y es la que usan todos los gestores. Como la llave la
// genera la bóveda del usuario y la firma la produce ella, la assertion es válida y el
// sitio no distingue.
//
// Este mundo NO tiene `chrome.runtime`: habla con el content script normal por
// `postMessage`. Y NO decide nada — solo pregunta y espera; quien decide es la bóveda.

(() => {
  const original = {
    create: navigator.credentials?.create?.bind(navigator.credentials),
    get: navigator.credentials?.get?.bind(navigator.credentials),
  }
  if (!original.create || !original.get) return

  const PIDE = 'dotrino-passmanager:webauthn:req'
  const RESPONDE = 'dotrino-passmanager:webauthn:res'
  const pendientes = new Map()
  let n = 0

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.channel !== RESPONDE) return
    const p = pendientes.get(e.data.id)
    if (!p) return
    pendientes.delete(e.data.id)
    p(e.data)
  })

  function preguntar (op, payload, timeoutMs = 120_000) {
    const id = `${Date.now()}-${++n}`
    return new Promise(resolve => {
      const t = setTimeout(() => { pendientes.delete(id); resolve({ fallback: true }) }, timeoutMs)
      pendientes.set(id, (r) => { clearTimeout(t); resolve(r) })
      window.postMessage({ channel: PIDE, id, op, payload }, location.origin)
    })
  }

  const b64url = (buf) => {
    let s = ''
    for (const b of new Uint8Array(buf)) s += String.fromCharCode(b)
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }
  const fromB64url = (str) => {
    const bin = atob(String(str).replace(/-/g, '+').replace(/_/g, '/'))
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }

  /** El sitio manda ArrayBuffers; por `postMessage` viajan como base64url. */
  function serializar (opts) {
    const p = opts?.publicKey
    if (!p) return null
    return {
      rpId: p.rp?.id || location.hostname,
      rpName: p.rp?.name || '',
      challenge: b64url(p.challenge),
      userHandle: p.user?.id ? b64url(p.user.id) : '',
      userName: p.user?.name || p.user?.displayName || '',
      allowCredentials: (p.allowCredentials || []).map(c => ({ id: b64url(c.id) })),
      userVerification: p.userVerification || 'preferred',
      origin: location.origin,
    }
  }

  /** Y de vuelta: la página espera ArrayBuffers y un objeto con la forma exacta. */
  function credencial (r) {
    const resp = {}
    for (const [k, v] of Object.entries(r.response)) {
      resp[k] = typeof v === 'string' && k !== 'userHandle'
        ? fromB64url(v).buffer
        : (k === 'userHandle' && v ? fromB64url(v).buffer : v)
    }
    const cred = {
      id: r.id,
      rawId: fromB64url(r.rawId).buffer,
      type: 'public-key',
      response: resp,
      authenticatorAttachment: 'platform',
      getClientExtensionResults: () => ({}),
    }
    // La página comprueba `instanceof PublicKeyCredential` en algunos sitios.
    try { Object.setPrototypeOf(cred, PublicKeyCredential.prototype) } catch {}
    return cred
  }

  navigator.credentials.create = async function (opts) {
    const datos = serializar(opts)
    if (!datos) return original.create(opts)
    const r = await preguntar('webauthn-create', datos)
    // Si el usuario no elige a Dotrino, o algo falla, manda el navegador. Nunca se
    // rompe el acceso al sitio por culpa nuestra.
    if (r?.fallback || !r?.result) return original.create(opts)
    return credencial(r.result)
  }

  navigator.credentials.get = async function (opts) {
    const datos = serializar(opts)
    if (!datos) return original.get(opts)
    const r = await preguntar('webauthn-get', datos)
    if (r?.fallback || !r?.result) return original.get(opts)
    return credencial(r.result)
  }
})()
