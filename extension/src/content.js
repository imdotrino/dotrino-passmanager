// Content script: marca los campos donde el gestor puede ayudar, y espera.
//
// **No autocompleta nada.** No tiene la bóveda ni la llave: le pregunta al service
// worker qué hay para ESTE sitio y solo pide una credencial cuando el usuario elige
// una en el modal. Rellenar es siempre un acto suyo, sobre un campo concreto.

// Un content script MV3 no se carga como módulo: la detección y la UI entran por
// import dinámico desde `web_accessible_resources`.
const mods = Promise.all([
  import(chrome.runtime.getURL('src/detect.js')),
  import(chrome.runtime.getURL('src/ui.js')),
]).then(([detect, ui]) => ({ detect, ui }))

let lastForms = []
let lastData = []

function ask (op, payload) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ op, payload }, r => {
      if (chrome.runtime.lastError) resolve({ error: { code: 'unreachable' } })
      else resolve(r || { error: { code: 'empty' } })
    })
  })
}

/** Los campos markable: el usuario/contraseña de cada acceso, y los datos sueltos. */
async function scan () {
  const { detect, ui } = await mods
  try {
    lastForms = detect.findLoginForms(document)
    lastData = detect.findDataFields(document)
  } catch { lastForms = []; lastData = [] }

  const markable = []
  for (const f of lastForms) {
    if (f.username) markable.push({ el: f.username, kind: null, form: f })
    if (f.password) markable.push({ el: f.password, kind: null, form: f })
  }
  for (const d of lastData) {
    // Un campo ya marcado como parte de un acceso no se marca dos veces.
    if (!markable.some(m => m.el === d.el)) markable.push(d)
  }

  ui.mountMarkers(markable, onPick)
  return markable
}

/** El usuario pulsó el botón de un campo: se le enseña qué puede poner ahí. */
async function onPick (field) {
  const { ui } = await mods
  const r = await ask('find', { url: location.href })

  if (r.error) {
    ui.showModal({ title: 'Dotrino', empty: messageFor(r.error.code) })
    return
  }

  const entries = r.result || []
  const esDato = !!field.kind
  const options = entries
    .filter(e => esDato ? e.hasFields : (e.hasSecret || e.type === 'login'))
    .map(e => ({ id: e.id, name: e.title || e.sites?.[0] || '—', hint: e.hint || e.sites?.[0] || '' }))

  ui.showModal({
    title: 'Dotrino',
    what: esDato ? field.kind : 'acceso',
    options,
    empty: 'Nada guardado para este campo.',
    onChoose: async (opt) => {
      // Aquí, y solo aquí, se pide UNA credencial: al elegirla el usuario.
      const got = await ask('get', { id: opt.id })
      if (got.error) return ui.showModal({ title: 'Dotrino', empty: messageFor(got.error.code) })
      await fill(field, got.result)
    },
  })
}

async function fill (field, entry) {
  const { detect, ui } = await mods

  if (!field.kind) {
    // Un acceso: usuario y contraseña de su formulario, no de toda la página.
    const form = field.form
    if (form?.username && entry.username) detect.fillField(form.username, entry.username)
    if (form?.password && entry.secret) detect.fillField(form.password, entry.secret)
    ui.reposition()
    return
  }

  const campos = parseFields(entry.fields)
  const campo = campos.find(f => f.kind === field.kind)
  if (campo) detect.fillField(field.el, campo.value)
  ui.reposition()
}

function parseFields (raw) {
  if (Array.isArray(raw)) return raw
  try { return JSON.parse(raw || '[]') } catch { return [] }
}

function messageFor (code) {
  if (code === 'no-link' || code === 'unreachable') return 'Esta extensión no está enlazada a ninguna bóveda.'
  if (code === 'denied') return 'Tu bóveda no autoriza a esta extensión todavía.'
  if (code === 'approval-timeout') return 'Tu bóveda no respondió. ¿Está encendida?'
  return 'No se pudo hablar con tu bóveda.'
}

// --- lo que puede pedir el POPUP -------------------------------------------
//
// El popup es UI de la extensión, con el usuario delante; la página no. Por eso estas
// dos operaciones existen aquí y nada de esto lo puede disparar el sitio.

/** Rellena el primer formulario de acceso con una credencial que el usuario eligió. */
async function fillLogin ({ username, secret }) {
  const { detect, ui } = await mods
  const forms = lastForms.length ? lastForms : await scan()
  const f = forms[0]
  if (!f) return false
  let done = false
  if (f.username && username) done = detect.fillField(f.username, username) || done
  if (f.password && secret) done = detect.fillField(f.password, secret) || done
  ui.reposition()
  return done
}

/** Lo que hay escrito en el formulario, para poder guardarlo en la bóveda. */
async function readForm () {
  const forms = lastForms.length ? lastForms : await scan()
  for (const f of forms) {
    const secret = f.password?.value || ''
    if (!secret) continue
    return { username: f.username?.value || '', secret, url: location.href }
  }
  return null
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Solo del propio popup: un messageFor con `sender.tab` viene de una página.
  if (sender.tab) { sendResponse({ error: { code: 'denied' } }); return false }

  if (msg?.op === 'page-fill') {
    fillLogin(msg.payload || {}).then(filled => sendResponse({ result: { filled } }))
    return true
  }
  if (msg?.op === 'page-credentials') {
    readForm().then(r => sendResponse({ result: r }))
    return true
  }
  return false
})

// Las SPA remontan el formulario después de cargar; sin esto el gestor funciona en la
// primera visita y deja de funcionar al navegar dentro del sitio.
let t = null
const observer = new MutationObserver(() => {
  clearTimeout(t)
  t = setTimeout(scan, 300)
})
observer.observe(document.documentElement, { childList: true, subtree: true })

// Los botones van pegados a sus campos: si la página se mueve, ellos también.
let raf = null
const seguir = () => {
  if (raf) return
  raf = requestAnimationFrame(async () => { raf = null; (await mods).ui.reposition() })
}
addEventListener('scroll', seguir, { passive: true, capture: true })
addEventListener('resize', seguir, { passive: true })

scan()
