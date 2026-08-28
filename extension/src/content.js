// Content script: marca los campos donde el gestor puede ayudar, y wait.
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
// Los módulos YA resueltos: `submit` y `pagehide` no admiten esperar a un `import()`.
const cache = {}
mods.then((m) => Object.assign(cache, m))

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

// --- guardar lo que acabas de escribir --------------------------------------
//
// Los gestores que la gente ya usa preguntan DESPUÉS de entrar, en la página siguiente,
// y tienen razón: al enviar el formulario ya no hay nada que leer, y pedirlo antes es
// pedirle al usuario que se acuerde. Así que se captura al enviar y se pregunta luego.
//
// **Capturar no es guardar.** Lo escrito va al service worker y se queda ahí, en la
// memoria de la sesión y con fecha de caducidad; en la bóveda no entra nada hasta que
// el usuario lo diga, y ese «sí» se pulsa en un iframe de la EXTENSIÓN, no en la
// página. La regla de siempre sigue en pie: el sitio no puede escribir en tu bóveda.

function capture (cred) {
  if (!cred) return
  try { chrome.runtime.sendMessage({ op: 'capture', payload: cred }, () => void chrome.runtime.lastError) } catch (_) {}
}

/**
 * ¿Vale la pena preguntar por un formulario SIN contraseña?
 *
 * Un formulario de datos —el perfil, la dirección de envío, el alta de una cuenta— es
 * tan guardable como un acceso, y por eso se captura también. Pero un solo campo
 * reconocido no basta: la caja de «suscríbete a nuestro boletín» al pie de un blog es
 * exactamente eso, y preguntar ahí convierte el aviso en algo que se cierra sin leer.
 * Con dos clases distintas ya es un formulario que habla del usuario.
 */
const enoughData = (fields) => fields.length >= 2

/** Lo mismo pero sin esperar a nadie: en `pagehide` no hay tiempo para un `await`. */
function captureFrom (form) {
  const { detect } = cache
  if (!detect) return false
  const secret = form?.password?.value || ''
  // El ámbito es el formulario enviado, no la página: en una pantalla con dos
  // formularios, lo que se guarda es lo del que se envió.
  const scope = form?.form || document
  const fields = detect.readDataFields(scope, { skip: [form?.username, form?.password] })
  if (!secret && !enoughData(fields)) return false
  capture({
    username: secret ? detect.readUsername(form) : '',
    secret,
    fields,
    url: location.href,
  })
  return true
}

// El usuario ESCRIBIÓ algo. Se apunta porque `pagehide` no sabe distinguir entre salir
// de un formulario que acabas de llenar y salir de una página que solo lo enseñaba: sin
// esto, abrir tus ajustes y volver atrás pediría guardar lo que ya estaba ahí.
let touched = false
addEventListener('input', () => { touched = true }, { capture: true, passive: true })

// 1. El envío del formulario, que es el caso normal. En captura para que llegue aunque
//    la página cancele el evento después.
addEventListener('submit', (e) => {
  const el = e.target
  const f = lastForms.find(x => x.form && x.form === el)
  if (f && captureFrom(f)) return
  // Sin nada detectado todavía (una SPA que acaba de montar el formulario): se mira el
  // propio formulario que se envía, que es síncrono y no depende de la última pasada.
  const pass = el?.querySelector?.('input[type=password]')
  if (pass?.value && captureFrom({ form: el, password: pass, username: null })) return
  // Y sin contraseña ninguna: un formulario de datos. El freno está en `captureFrom`.
  if (captureFrom({ form: el, password: null, username: null })) return
  for (const x of lastForms) if (captureFrom(x)) return
}, true)

// 2. Y la salida de la página, porque media web entra sin disparar `submit`: un botón
//    que llama a `fetch` y navega a mano. Sin esto el gestor solo aprendería de los
//    formularios de siempre, que son cada vez menos.
addEventListener('pagehide', () => {
  for (const f of lastForms) if (captureFrom(f)) return
  // Un formulario de datos no aparece en `lastForms` (ahí solo van los accesos), así que
  // se mira la página entera — pero solo si el usuario escribió: ver una pantalla no es
  // llenarla.
  if (touched) captureFrom({ form: null, password: null, username: null })
}, { capture: true })

/**
 * ¿Quedó algo por preguntar de la página anterior? Se pregunta aquí, ya cargada.
 *
 * Y se pregunta VARIAS VECES durante unos segundos, no una sola: entre enviar el
 * formulario y cargar la página siguiente hay una carrera de verdad —el service worker
 * puede estar dormido y tardar en anotar lo capturado, y la página nueva suele llegar
 * antes—. Preguntando una vez el aviso no salía casi nunca; costó verlo porque no falla,
 * simplemente no aparece.
 */
async function offerSave () {
  for (const wait of [0, 400, 1000, 2000]) {
    if (wait) await new Promise(r => setTimeout(r, wait))
    const r = await ask('pending-save', { host: location.hostname })
    const p = r?.result
    if (!p?.has) continue
    const { ui } = await mods
    // Solo el sitio y el usuario, que es lo que la página ya sabe. Lo que hay guardado
    // —qué entradas existen, qué cambiaría— se lo pregunta el aviso al service worker
    // desde el origen de la extensión: por aquí no pasa.
    ui.mountSavePrompt({ host: p.host || '', user: p.username || '' })
    return
  }
}

// El aviso se cierra y se dimensiona solo: es un iframe de la extensión y no alcanza al
// DOM de aquí, así que lo pide por `postMessage`.
//
// Y se comprueba de DÓNDE viene: en esta ventana cualquiera puede hacer `postMessage`, y
// sin el filtro la página podría cerrar el aviso —o estirarlo hasta taparlo todo— con
// una línea. Vale el origen de la extensión o la ventana del propio iframe.
const EXT_ORIGIN = new URL(chrome.runtime.getURL('')).origin
addEventListener('message', async (e) => {
  const op = e.data?._dotrino
  if (op !== 'close-save-prompt' && op !== 'size-save-prompt') return
  const { ui } = await mods
  if (e.origin !== EXT_ORIGIN && e.source !== ui.promptWindow()) return
  if (op === 'close-save-prompt') ui.closeSavePrompt()
  else ui.sizeSavePrompt(e.data.h)
})

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
offerSave().catch(() => {})
