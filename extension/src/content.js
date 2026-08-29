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
// TODOS los campos detectados con lo que se puede hacer en cada uno; `lastShown` son los
// que además llevan marcador. Rellenar necesita los primeros: una contraseña vacía de un
// sitio sin nada guardado no tiene botón, y aun así hay que poder escribir en ella cuando
// el usuario trae una cuenta de otro dominio.
let lastFields = []
let lastShown = []

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

  // Qué ofrecer en cada campo lo decide el service worker: comparar con lo guardado
  // necesita el valor guardado, y eso no cruza al proceso de la página. De aquí sale lo
  // escrito —que la página ya tiene— y vuelven dos booleanos y de qué entradas.
  const r = await ask('offers', {
    url: location.href,
    fields: markable.map((f, i) => descFor(f, i)),
  })
  const dicho = r?.error ? [] : (r.result || [])
  const todos = []
  const shown = []
  for (let i = 0; i < markable.length; i++) {
    const offers = dicho[i] || { fill: false, save: false, ids: [] }
    const campo = { ...markable[i], offers, title: titleFor(offers) }
    todos.push(campo)
    if (offers.fill || offers.save) shown.push(campo)
  }

  // Volver a montarlos en cada tecla haría parpadear el que tienes debajo del cursor: se
  // rehacen solo cuando cambia QUÉ se marca o QUÉ ofrece.
  const key = shown
    .map(f => `${markable.findIndex(m => m.el === f.el)}:${f.offers.fill ? 'f' : ''}${f.offers.save ? 's' : ''}`)
    .join('|')
  lastFields = todos
  lastShown = shown
  if (key !== shownKey) {
    ui.mountMarkers(shown, onPick)
    shownKey = key
  } else {
    ui.reposition()
  }
  return shown
}

const titleFor = (offers) => offers.fill ? t('fill') : t('saveThis')

/** Lo que se le cuenta al service worker de un campo para que decida. */
function descFor (f, i) {
  const { detect } = cache
  if (f.kind || f.free) {
    return {
      id: i,
      key: detect.fieldKey({ kind: f.kind, label: f.label }),
      value: String(f.el.value || '').trim(),
    }
  }
  // Un acceso: cada casilla responde por sí sola, pero se manda el formulario entero
  // porque «ya está guardado igual» se decide con la credencial completa.
  return {
    id: i,
    key: keyOf(f),
    value: String(f.el.value || '').trim(),
    username: f.form?.username?.value || '',
    secret: f.form?.password?.value || '',
  }
}

/**
 * El usuario pulsó el botón de un campo. Se abre el modal, pegado a él.
 *
 * El modal es un **iframe de la extensión** (§4.1): dentro se elige la entrada, se
 * rellena y se guarda, y ese último botón tiene que nacer fuera de la página. Aquí solo
 * se apunta antes lo que hay escrito —para que el modal tenga qué guardar— y se le
 * cuenta qué campos hay delante.
 */
async function onPick (field) {
  const { ui } = await mods
  const { error } = await entriesForHost()
  if (error) {
    return ui.showModal({ title: 'Dotrino', empty: messageFor(error), closeLabel: t('close') })
  }
  // Apuntar no es guardar: queda en la memoria de sesión del service worker y solo entra
  // en la bóveda si se pulsa «Guardar», que se pulsa dentro del marco.
  const puedeGuardar = field.offers?.save ? !!(await captureField(field)) : false
  abierto = { field, puedeGuardar }
  ui.mountFieldModal({
    key: keyOf(field),
    name: nameOf(field),
    anchor: field.node,
  })
}

/** El campo que tiene el modal abierto, para saber a quién contestarle. */
let abierto = null

/**
 * La CLAVE de un campo, la misma con la que viaja en el aviso y en la bóveda.
 *
 * El usuario y la contraseña de un acceso son **dos claves distintas** (`username` y
 * `secret`), no una sola: el dueño quiere verlas por separado en la lista de rellenar
 * —«Usuario» y «Contraseña»—, y juntarlas hacía que la contraseña no apareciera por
 * ninguna parte aunque se rellenara.
 */
const keyOf = (f) => {
  if (f.kind || f.free) {
    return cache.detect ? cache.detect.fieldKey({ kind: f.kind, label: f.label }) : 'other'
  }
  return f.el === f.form?.password ? 'secret' : 'username'
}

/**
 * El nombre del campo, que es **la etiqueta con la que se va a guardar**.
 *
 * Nada de «este campo»: lo que el modal enseña tiene que ser exactamente lo que quedará
 * escrito en la entrada, o el usuario está aceptando una cosa distinta de la que ve.
 */
function nameOf (field) {
  const kl = (k) => cache.i18n ? cache.i18n.kindLabel(lang, k) : k
  // Un acceso son dos campos con su nombre cada uno: «Usuario» y «Contraseña».
  if (!field.kind && !field.free) return kl(keyOf(field))
  if (field.kind) return kl(field.kind)
  // Un campo libre sin etiqueta ninguna se guarda como «otro dato», y eso es lo que dice.
  return field.label || kl('other')
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
async function captureField (field) {
  const { detect } = await mods

  // Se guarda ESE campo: es el que se pulsó. Los demás del mismo formulario van también,
  // pero SIN marcar — así una pulsación guarda una cosa, y si querías más están ahí sin
  // volver a empezar.
  let payload = null
  if (!field.kind && !field.free) {
    // Un acceso. Se manda lo que haya en el formulario —usuario, contraseña o las dos—,
    // y viene marcado lo del campo que se pulsó: con el usuario escrito y la contraseña
    // todavía no, guardar el usuario es una cosa razonable de querer, y la contraseña se
    // suma después a esa misma entrada.
    const f = field.form
    const username = detect.readUsername(f)
    const secret = f?.password?.value || ''
    if (!username && !secret) return false
    const esPass = field.el === f?.password
    payload = {
      from: 'field',
      username,
      secret,
      fields: detect.readDataFields(f?.form || document, { skip: [f?.username, f?.password] }),
      // La contraseña sin usuario no sirve para volver a entrar: al pulsar en ella van
      // las dos. Al pulsar en el usuario, solo él.
      focus: esPass ? ['username', 'secret'] : ['username'],
      url: location.href,
    }
  } else {
    const scope = field.el.form || document
    const fields = detect.readDataFields(scope)
    const key = detect.fieldKey({ kind: field.kind, label: field.label })
    if (!fields.some(x => detect.fieldKey(x) === key)) return false
    payload = { from: 'field', username: '', secret: '', fields, focus: [key], url: location.href }
  }

  const r = await capture(payload)
  return !r?.error
}

/**
 * RELLENAR lo que el modal pidió. Los valores vienen de la bóveda, por dentro del marco;
 * aquí solo se escriben en los campos, que es lo único que el marco no puede hacer.
 */
async function fillFromModal (values) {
  const { detect, ui } = await mods
  for (const v of Array.isArray(values) ? values : []) {
    for (const f of lastFields) {
      if (keyOf(f) !== v.key) continue
      if (v.value) detect.fillField(f.el, v.value)
    }
  }
  ui.reposition()
  // Lo escrito cambia lo que se puede ofrecer: el marcador del campo recién rellenado
  // desaparece solo (§4.1, la fila del «ya está guardado igual»).
  scan().catch(() => {})
}

/** Qué campos hay delante y qué entrada puede rellenar cada uno. Es cosmético. */
async function sendModalContext () {
  const { ui } = await mods
  const w = ui.fieldModalWindow()
  if (!w) return
  const vistos = new Set()
  const page = []
  for (const f of lastFields) {
    const k = keyOf(f)
    if (vistos.has(k)) continue
    vistos.add(k)
    page.push({ key: k, name: nameOf(f), ids: f.offers?.ids || [] })
  }
  try {
    w.postMessage({
      _dotrino: 'field-modal-context',
      page,
      canSave: !!abierto?.puedeGuardar,
      url: location.href,
    }, EXT_ORIGIN)
  } catch (_) {}
}

function messageFor (code) {
  if (code === 'unknown-op') return t('staleWorker')
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
    from: 'submit',
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
const DE_LOS_MARCOS = new Set([
  'close-save-prompt', 'size-save-prompt',
  'field-modal-ready', 'close-field-modal', 'size-field-modal',
  'fill-field-modal', 'saved-field-modal',
])

addEventListener('message', async (e) => {
  const op = e.data?._dotrino
  if (!DE_LOS_MARCOS.has(op)) return
  const { ui } = await mods
  // De DÓNDE viene: en esta ventana cualquiera puede hacer `postMessage`, y sin el filtro
  // la página podría cerrar el aviso, estirarlo hasta taparlo todo o mandar a rellenar.
  const suyo = e.source === ui.promptWindow() || e.source === ui.fieldModalWindow()
  if (e.origin !== EXT_ORIGIN && !suyo) return

  switch (op) {
    case 'close-save-prompt':
      ui.closeSavePrompt()
      // Puede que se acabe de guardar algo: lo que se sabía de la bóveda ya no vale, y
      // los marcadores de la página tienen que enterarse.
      forgetEntries()
      scan().catch(() => {})
      break
    case 'size-save-prompt': ui.sizeSavePrompt(e.data.h); break
    case 'field-modal-ready': sendModalContext(); break
    case 'close-field-modal': ui.closeFieldModal(); abierto = null; break
    case 'size-field-modal': ui.sizeFieldModal(e.data.h); break
    case 'fill-field-modal': fillFromModal(e.data.values); break
    case 'saved-field-modal': forgetEntries(); scan().catch(() => {}); break
  }
})

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Solo del propio popup: un messageFor con `sender.tab` viene de una página.
  if (sender.tab) { sendResponse({ error: { code: 'denied' } }); return false }

  if (msg?.op === 'page-fill') {
    fillLogin(msg.payload || {}).then(filled => sendResponse({ result: { filled } }))
    return true
  }
  return false
})

// El modal se cierra al pulsar fuera, como cualquier menú: es de un campo, y en cuanto
// tocas otra cosa ya no habla de lo que estás mirando. Pulsar DENTRO no llega hasta aquí
// —es un iframe, y sus clics se quedan en él—, así que basta con mirar los de la página.
addEventListener('mousedown', async (e) => {
  const { ui } = cache
  if (!ui?.fieldModalOpen?.()) return
  // El anfitrión de nuestra UI no es «fuera»: ahí viven el marcador y el propio modal.
  if (e.target?.id === ui.HOST_ID) return
  ui.closeFieldModal()
  abierto = null
}, true)

// Y con Escape, que es lo que hace todo el mundo antes de buscar el botón de cerrar.
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  const { ui } = cache
  if (!ui?.fieldModalOpen?.()) return
  ui.closeFieldModal()
  abierto = null
}, true)

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
