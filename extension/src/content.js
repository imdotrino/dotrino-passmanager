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
  import(chrome.runtime.getURL('src/i18n.js')),
]).then(([detect, ui, i18n]) => ({ detect, ui, i18n }))

// El idioma sale del navegador y NO de `localStorage`: aquí ese almacén es el de la
// PÁGINA, no el nuestro, y no se lee lo que es del sitio ni para esto.
const lang = (navigator.language || 'es').toLowerCase().startsWith('en') ? 'en' : 'es'
const t = (key, ...args) => (cache.i18n ? cache.i18n.t(lang, key, ...args) : '')

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

/**
 * LO PÚBLICO de lo que hay guardado para este sitio. Se pregunta una vez por página.
 *
 * `find` no abre nada: devuelve la mitad pública (§4.0.2) —qué entradas hay, con qué
 * usuario y qué guardan—, sin llave y sin aprobación. Hace falta para saber si el campo
 * merece un marcador, y es lo único que se pide sin que el usuario haya pulsado nada.
 */
let vaultFor = { host: null, entries: [], error: null }

async function entriesForHost () {
  if (vaultFor.host === location.host) return vaultFor
  const r = await ask('find', { url: location.href })
  vaultFor = { host: location.host, entries: r?.error ? [] : (r.result || []), error: r?.error?.code || null }
  return vaultFor
}

/** Lo guardado ya no vale: se acaba de escribir algo. */
function forgetEntries () {
  vaultFor = { host: null, entries: [], error: null }
}

/**
 * Los campos donde el gestor PUEDE hacer algo, que no son todos.
 *
 * Un marcador en cada casilla de cada formulario de la web es un adorno: la mitad de las
 * veces no hay nada que poner ahí. Se marca cuando hay algo guardado que quepa, o cuando
 * el campo ya tiene algo escrito y se puede ofrecer guardarlo (dueño, 2026-08-28).
 */
let shownKey = ''

async function scan () {
  const { detect, ui } = await mods
  try {
    lastForms = detect.findLoginForms(document)
    // `free`: también los campos que no se reconocen, para poder guardar lo que el
    // usuario escriba en ellos (§4.1). Solo se marcan cuando tienen algo.
    lastData = detect.findDataFields(document, { free: true })
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

  // Sin campos no se le pregunta nada a la bóveda: una página que no tiene formularios
  // no tiene por qué despertar a nadie.
  if (!markable.length) {
    if (shownKey) { ui.mountMarkers([], onPick); shownKey = '' }
    return []
  }

  const { entries } = await entriesForHost()
  const shown = []
  for (const f of markable) {
    const offers = detect.fieldOffers(
      { kind: f.kind, free: f.free, value: f.el.value, formSecret: f.form?.password?.value },
      entries)
    if (offers.fill || offers.save) shown.push({ ...f, offers, title: titleFor(offers) })
  }

  // Volver a montarlos en cada tecla haría parpadear el que tienes debajo del cursor: se
  // rehacen solo cuando cambia QUÉ se marca o QUÉ ofrece.
  const key = shown
    .map(f => `${markable.findIndex(m => m.el === f.el)}:${f.offers.fill ? 'f' : ''}${f.offers.save ? 's' : ''}`)
    .join('|')
  if (key !== shownKey) {
    ui.mountMarkers(shown, onPick)
    shownKey = key
  } else {
    ui.reposition()
  }
  return shown
}

const titleFor = (offers) => offers.fill ? t('fill') : t('saveThis')

/**
 * El usuario pulsó el botón de un campo: se le enseña qué se puede hacer ahí.
 *
 * Dos cosas, y pueden estar las dos a la vez: **poner** algo guardado, y **guardar** lo
 * que ya está escrito. La segunda va abajo, separada, porque no es una opción más de
 * «qué pongo aquí».
 */
async function onPick (field) {
  const { ui } = await mods
  const { entries, error } = await entriesForHost()

  const esDato = !!field.kind || !!field.free
  const options = field.offers?.fill
    ? entries
      .filter(e => esDato ? e.hasFields : (e.hasSecret || e.type === 'login'))
      .map(e => ({ id: e.id, name: e.title || e.sites?.[0] || '—', hint: e.hint || e.sites?.[0] || '' }))
    : []

  ui.showModal({
    title: 'Dotrino',
    what: esDato ? nameOf(field) : t('fieldLogin'),
    options,
    empty: error ? messageFor(error) : t('nothingForField'),
    closeLabel: t('close'),
    action: field.offers?.save ? { label: t('saveThis'), onAction: () => saveFromField(field) } : null,
    onChoose: async (opt) => {
      // Aquí, y solo aquí, se pide UNA credencial: al elegirla el usuario.
      const got = await ask('get', { id: opt.id })
      if (got.error) return ui.showModal({ title: 'Dotrino', empty: messageFor(got.error.code), closeLabel: t('close') })
      await fill(field, got.result)
    },
  })
}

/** El nombre del campo tal como se le enseña al usuario. */
function nameOf (field) {
  if (field.kind) return cache.i18n ? cache.i18n.kindLabel(lang, field.kind) : field.kind
  return field.label || t('otherField')
}

/**
 * GUARDAR lo que hay escrito, sin esperar a enviar el formulario.
 *
 * Es el mismo camino que el aviso de después de entrar (§4.0.1): se apunta lo escrito y
 * se abre el aviso, con su lista de campos y su elección de dónde va. Lo que cambia es
 * solo el disparador — aquí lo pulsa el usuario en el campo, en vez de salir solo en la
 * página siguiente—, y quien escribe en la bóveda sigue siendo el iframe de la
 * extensión, nunca la página.
 */
async function saveFromField (field) {
  const { detect, ui } = await mods
  const noHay = () => ui.showModal({ title: 'Dotrino', empty: t('nothingToSave'), closeLabel: t('close') })

  // Se guarda ESE campo: es el que se pulsó. Los demás del mismo formulario van también,
  // pero SIN marcar — así una pulsación guarda una cosa, y si querías más están ahí sin
  // volver a empezar.
  let payload = null
  if (!field.kind && !field.free) {
    // Un acceso: la credencial entera, que es una sola cosa aunque sean dos campos.
    const f = field.form
    if (!f?.password?.value) return noHay()
    payload = {
      username: detect.readUsername(f),
      secret: f.password.value,
      fields: detect.readDataFields(f.form || document, { skip: [f.username, f.password] }),
      focus: ['username', 'secret'],
      url: location.href,
    }
  } else {
    const scope = field.el.form || document
    const fields = detect.readDataFields(scope)
    const key = detect.fieldKey({ kind: field.kind, label: field.label })
    if (!fields.some(x => detect.fieldKey(x) === key)) return noHay()
    payload = { username: '', secret: '', fields, focus: [key], url: location.href }
  }

  await capture(payload)
  await offerSave([0, 300, 800])
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

  // Se busca por CLAVE, que para un campo libre es su etiqueta: es su única identidad.
  const campos = parseFields(entry.fields)
  const key = detect.fieldKey({ kind: field.kind, label: field.label })
  const campo = campos.find(f => detect.fieldKey(f) === key)
  if (campo) detect.fillField(field.el, campo.value)
  ui.reposition()
}

function parseFields (raw) {
  if (Array.isArray(raw)) return raw
  try { return JSON.parse(raw || '[]') } catch { return [] }
}

function messageFor (code) {
  if (code === 'no-link' || code === 'unreachable') return t('noVault')
  if (code === 'denied') return t('denied')
  if (code === 'approval-timeout') return t('noAnswer')
  return t('noTalk')
}

// --- lo que puede pedir el POPUP -------------------------------------------
//
// El popup es UI de la extensión, con el usuario delante; la página no. Por eso estas
// dos operaciones existen aquí y nada de esto lo puede disparar el sitio.

/** Rellena el primer formulario de acceso con una credencial que el usuario eligió. */
async function fillLogin ({ username, secret }) {
  const { detect, ui } = await mods
  if (!lastForms.length) await scan()
  const f = lastForms[0]
  if (!f) return false
  let done = false
  if (f.username && username) done = detect.fillField(f.username, username) || done
  if (f.password && secret) done = detect.fillField(f.password, secret) || done
  ui.reposition()
  return done
}

/** Lo que hay escrito en el formulario, para poder guardarlo en la bóveda. */
async function readForm () {
  if (!lastForms.length) await scan()
  for (const f of lastForms) {
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
  if (!cred) return Promise.resolve()
  // Devuelve promesa para quien pueda esperarla (el botón del campo); en `pagehide` no
  // hay tiempo de esperar nada, pero el mensaje sale igual — se despacha al llamar.
  try { return ask('capture', cred) } catch (_) { return Promise.resolve() }
}

/**
 * ¿Vale la pena preguntar por un formulario SIN contraseña?
 *
 * Un formulario de datos —el perfil, la dirección de envío, el alta de una cuenta— es
 * tan guardable como un acceso, y por eso se captura también. Pero un solo campo
 * reconocido no basta: la caja de «suscríbete a nuestro boletín» al pie de un blog es
 * exactamente eso, y preguntar ahí convierte el aviso en algo que se cierra sin leer.
 * Con dos clases distintas ya es un formulario que habla del usuario.
 *
 * Cuentan solo los RECONOCIDOS. Los campos libres viajan en la captura pero no la
 * provocan: si contaran, cualquier formulario de dos casillas sacaría el aviso.
 */
const enoughData = (fields) => fields.filter(f => f.kind).length >= 2

/**
 * Lo mismo pero sin esperar a nadie: en `pagehide` no hay tiempo para un `await`.
 * Con `force` se salta el mínimo de dos datos: es para cuando el usuario lo pide.
 */
function captureFrom (form, { force = false } = {}) {
  const { detect } = cache
  if (!detect) return false
  const secret = form?.password?.value || ''
  // El ámbito es el formulario enviado, no la página: en una pantalla con dos
  // formularios, lo que se guarda es lo del que se envió.
  const scope = form?.form || document
  const fields = detect.readDataFields(scope, { skip: [form?.username, form?.password] })
  if (!secret && !(force ? fields.length : enoughData(fields))) return false
  return capture({
    username: secret ? detect.readUsername(form) : '',
    secret,
    fields,
    // Marcado viene lo que el gestor reconoce; los campos libres van sin marcar. Enviar
    // un formulario no es pedir que se guarde el código de un cupón, pero tenerlo ahí
    // a un clic sí ahorra volver a escribirlo.
    focus: ['username', 'secret', ...fields.filter(f => f.kind).map(f => detect.fieldKey(f))],
    url: location.href,
  })
}

// El usuario ESCRIBIÓ algo. Se apunta porque `pagehide` no sabe distinguir entre salir
// de un formulario que acabas de llenar y salir de una página que solo lo enseñaba: sin
// esto, abrir tus ajustes y volver atrás pediría guardar lo que ya estaba ahí.
let touched = false
let typingT = null
addEventListener('input', () => {
  touched = true
  // Escribir cambia lo que el gestor puede ofrecer: un campo vacío no tiene nada que
  // guardar, y en cuanto tiene algo, sí. Con freno, que esto corre por cada tecla.
  clearTimeout(typingT)
  typingT = setTimeout(() => { scan().catch(() => {}) }, 250)
}, { capture: true, passive: true })

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
async function offerSave (waits = [0, 400, 1000, 2000]) {
  for (const wait of waits) {
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
  if (op === 'close-save-prompt') {
    ui.closeSavePrompt()
    // Puede que se acabe de guardar algo: lo que se sabía de la bóveda ya no vale, y los
    // marcadores de la página tienen que enterarse.
    forgetEntries()
    scan().catch(() => {})
  } else ui.sizeSavePrompt(e.data.h)
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
let scanT = null
const observer = new MutationObserver(() => {
  clearTimeout(scanT)
  scanT = setTimeout(() => { scan().catch(() => {}) }, 300)
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

scan().catch(() => {})
offerSave().catch(() => {})
