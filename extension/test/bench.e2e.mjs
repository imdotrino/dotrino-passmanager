// EL BANCO DE PRUEBAS, recorrido solo: los casos de `index.html` en un Chrome de verdad.
//
// Existe para que la página de pruebas no prometa cosas que el gestor no hace. Ya pilló
// dos: en un acceso de dos pantallas el usuario llega en un campo de SOLO LECTURA y se
// perdía, y el aviso no se puede localizar por selector porque el shadow root es cerrado.
//
//   npm run test:web &                 # sirve extension/test en :8099
//   npm run test:banco
//
// `PLAYWRIGHT` apunta al paquete si no está instalado aquí (p. ej. el de dotrino-test).
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright')

const EXT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SITE = process.env.SITE || 'http://localhost:8099'
const perfil = await mkdtemp(join(tmpdir(), 'pm-banco-'))
const ctx = await chromium.launchPersistentContext(perfil, {
  headless: false,
  args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
})
const fallos = []
const ok = (c, m) => { console.log((c ? '  ok    ' : '  FALLA ') + m); if (!c) fallos.push(m) }

const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 })
const id = new URL(sw.url()).host
const ext = await ctx.newPage()
await ext.goto(`chrome-extension://${id}/src/popup.html`)
const pedir = (op, payload) => ext.evaluate(([op, payload]) => new Promise((r) =>
  chrome.runtime.sendMessage({ op, payload }, r)), [op, payload])

const page = await ctx.newPage()
page.on('pageerror', (e) => console.log('   [error de página]', e.message))

/**
 * ABRIR una entrada desde la pantalla de la extensión, diciendo que sí.
 *
 * La bóveda pide autorización antes de soltar nada (DISENO §3.3.2) y la pregunta se
 * dibuja donde el usuario está mirando: hay que traer la pantalla de la extensión al
 * frente para que le toque a ella y no se abra la ventana suelta.
 */
async function abrir (entryId) {
  await ext.bringToFront()
  await ext.waitForTimeout(250)
  const p = pedir('get', { id: entryId })
  try { await ext.locator('[data-testid=approval-yes]').click({ timeout: 10000 }) } catch (_) {}
  const r = await p
  await page.bringToFront()
  await page.waitForTimeout(150)
  return r
}

/**
 * El aviso, YA PINTADO.
 *
 * Se espera a que haya una fila de campo, no a que exista el botón: el botón viene en el
 * HTML y está ahí antes de que el aviso sepa qué va a escribir ni dónde. Pulsarlo en ese
 * hueco elegía el destino de antes, y fallaba una vez de cada tantas.
 */
async function aviso (ms = 10000) {
  for (let i = 0; i < ms / 250; i++) {
    const f = page.frames().find((x) => x.url().includes('/src/save-prompt.html'))
    if (f) {
      await f.locator('[data-testid=save-prompt-field]').first().waitFor({ timeout: 8000 })
      return f
    }
    await page.waitForTimeout(250)
  }
  return null
}

try {
  // --- caso 2: SPA sin submit ---
  console.log('\ncaso 2 · acceso sin submit (SPA)')
  await page.goto(`${SITE}/spa.html`)
  await page.waitForTimeout(600)
  await page.fill('#u', 'ana@ejemplo.com')
  await page.fill('#p', 'clave-spa')
  await Promise.all([page.waitForURL(/inside/), page.click('#go')])
  let f = await aviso()
  ok(!!f, 'el aviso sale aunque no haya submit')
  if (f) ok((await f.locator('#who').textContent()).startsWith('ana@ejemplo.com'), 'con el usuario correcto')
  if (f) {
    await f.locator('[data-testid=save-prompt-save]').click()
    await page.waitForTimeout(1000)
  }

  // --- caso 3: dos pasos ---
  console.log('\ncaso 3 · acceso en dos pasos')
  await page.goto(`${SITE}/step1.html`)
  await page.waitForTimeout(500)
  await page.fill('input[name=user]', 'beto@ejemplo.com')
  await Promise.all([page.waitForURL(/step2/), page.click('button[type=submit]')])
  await page.waitForTimeout(500)
  await page.fill('input[name=password]', 'clave-dos-pasos')
  await Promise.all([page.waitForURL(/inside/), page.click('button[type=submit]')])
  f = await aviso()
  ok(!!f, 'el aviso sale en el segundo paso')
  if (f) ok((await f.locator('#who').textContent()).startsWith('beto@ejemplo.com'),
    'lleva el usuario del PRIMER paso: ' + (f ? await f.locator('#who').textContent() : '—'))
  if (f) {
    await f.locator('[data-testid=save-prompt-save]').click()
    await page.waitForTimeout(1000)
  }

  // --- caso 6: registro con confirmación ---
  console.log('\ncaso 6 · registro con confirmación')
  await page.goto(`${SITE}/signup.html`)
  await page.waitForTimeout(500)
  await page.fill('input[name=email]', 'caro@ejemplo.com')
  await page.fill('input[name=pass1]', 'la-buena')
  await page.fill('input[name=pass2]', 'la-buena')
  await Promise.all([page.waitForURL(/inside/), page.click('button[type=submit]')])
  f = await aviso()
  ok(!!f, 'el aviso sale al registrarse')
  if (f) {
    await f.locator('[data-testid=save-prompt-save]').click()
    await page.waitForTimeout(1000)
  }
  const reg = (await pedir('find', { url: `${SITE}/inside.html` }))?.result || []
  const suya = reg.find((e) => e.hint === 'caro@ejemplo.com')
  const full = suya ? (await abrir(suya.id))?.result : null
  ok(full?.secret === 'la-buena', 'guarda la PRIMERA contraseña, no la de confirmar')

  // --- caso 4: la misma cuenta con otra contraseña ---
  console.log('\ncaso 4 · misma cuenta, otra contraseña')
  await page.goto(`${SITE}/login.html`)
  await page.waitForTimeout(500)
  await page.fill('input[name=user]', 'ana@ejemplo.com')
  await page.fill('input[name=password]', 'clave-nueva')
  await Promise.all([page.waitForURL(/inside/), page.click('button[type=submit]')])
  f = await aviso()
  ok(!!f, 'el aviso vuelve a salir')
  let anaId = null
  if (f) {
    const destinos = f.locator('[data-testid=save-prompt-target]')
    // Los candidatos son TODAS las cuentas guardadas de este sitio (aquí ya hay varias
    // de los casos anteriores), con la que se parece la primera y preseleccionada.
    ok(await destinos.count() >= 2, 'ofrece dónde guardar: nueva + las que hay')
    ok(!(await f.locator('[data-testid=save-prompt-target-new]').isChecked()),
      'y NO viene preseleccionada la nueva')
    anaId = await destinos.nth(1).getAttribute('data-id')
    ok(await f.locator(`[data-testid=save-prompt-target-${anaId}]`).isChecked(),
      'sino la que más se parece')
    ok(/parece|closest/i.test(await destinos.nth(1).locator('.tag').textContent()),
      'marcada como la que se parece')
    // El Chrome de prueba corre en inglés: se acepta cualquiera de los dos idiomas.
    const boton = await f.locator('[data-testid=save-prompt-save]').textContent()
    ok(/actualizar|update/i.test(boton), 'y el botón dice actualizar: ' + boton)
    await f.locator('[data-testid=save-prompt-save]').click()
    await page.waitForTimeout(1200)
  }
  const tras = (await pedir('find', { url: `${SITE}/inside.html` }))?.result || []
  const deAna = tras.filter((e) => e.hint === 'ana@ejemplo.com')
  ok(deAna.length === 1, 'actualizar NO duplica la cuenta (hay ' + deAna.length + ')')
  const anaFull = deAna[0] ? (await abrir(deAna[0].id))?.result : null
  ok(anaFull?.secret === 'clave-nueva', 'y se quedó la contraseña nueva')

  // --- caso 5: dos contraseñas del mismo correo, y elegir cuál se pisa ---
  //
  // Una página no tiene un ancla única: la misma cuenta puede estar guardada dos veces y
  // una de las dos ya no servir. El gestor no puede saber cuál es cuál, así que las
  // enseña y elige el usuario.
  console.log('\ncaso 5 · dos contraseñas del mismo correo')
  await page.goto(`${SITE}/login.html`)
  await page.waitForTimeout(500)
  await page.fill('input[name=user]', 'ana@ejemplo.com')
  await page.fill('input[name=password]', 'clave-segunda')
  await Promise.all([page.waitForURL(/inside/), page.click('button[type=submit]')])
  f = await aviso()
  ok(!!f, 'el aviso sale')
  if (f) {
    // Esta vez NO se actualiza: se crea otra entrada para la misma cuenta.
    await f.locator('[data-testid=save-prompt-target-new]').check()
    // Cambiar de destino cambia las filas y con ellas el ALTO del aviso, que lo fija la
    // página DESDE FUERA del iframe: Playwright mira la estabilidad dentro del marco y
    // no ve ese movimiento, así que sin esta pausa el clic puede caer en otro botón.
    await page.waitForTimeout(400)
    await f.locator('[data-testid=save-prompt-save]').click()
    await page.waitForTimeout(1200)
  }
  let deAna2 = ((await pedir('find', { url: `${SITE}/inside.html` }))?.result || [])
    .filter((e) => e.hint === 'ana@ejemplo.com')
  ok(deAna2.length === 2, 'quedan DOS entradas del mismo correo (hay ' + deAna2.length + ')')

  // Y ahora, con dos iguales por fuera, el aviso deja elegir cuál se reemplaza.
  const otraId = deAna2.map((e) => e.id).find((x) => x !== anaId)
  await page.goto(`${SITE}/login.html`)
  await page.waitForTimeout(500)
  await page.fill('input[name=user]', 'ana@ejemplo.com')
  await page.fill('input[name=password]', 'clave-tercera')
  await Promise.all([page.waitForURL(/inside/), page.click('button[type=submit]')])
  f = await aviso()
  ok(!!f, 'el aviso vuelve a salir')
  if (f) {
    const destinos = f.locator('[data-testid=save-prompt-target]')
    const ids = await destinos.evaluateAll((li) => li.map((x) => x.dataset.id))
    ok(ids.includes(anaId) && ids.includes(otraId) && ids.includes(''),
      'lista las dos entradas del mismo correo y la salida de crear otra')
    const fecha = await destinos.nth(1).locator('.when').textContent()
    ok(!!fecha.trim(), 'con la fecha de cada una, que es lo que las distingue: ' + fecha)
    ok(!/clave-/.test(await destinos.nth(1).textContent()), 'y sin enseñar ninguna contraseña')
    await f.locator(`[data-testid=save-prompt-target-${otraId}]`).check()
    await page.waitForTimeout(400)
    await f.locator('[data-testid=save-prompt-save]').click()
    await page.waitForTimeout(1200)
  }
  deAna2 = ((await pedir('find', { url: `${SITE}/inside.html` }))?.result || [])
    .filter((e) => e.hint === 'ana@ejemplo.com')
  ok(deAna2.length === 2, 'sigue habiendo dos: se reemplazó, no se sumó')
  const laElegida = (await abrir(otraId))?.result
  const laOtra = (await abrir(anaId))?.result
  ok(laElegida?.secret === 'clave-tercera', 'la elegida se actualizó')
  ok(laOtra?.secret === 'clave-nueva', 'y la otra se quedó como estaba: ' + laOtra?.secret)

  // --- caso 7: un formulario que NO es un acceso ---
  //
  // Sin contraseña por ninguna parte, y con una casilla por dato: se desmarca la ciudad
  // y tiene que quedarse fuera. Es lo que hace que guardar un formulario no sea un sí o
  // un no a todo.
  console.log('\ncaso 7 · formulario de datos, con casillas')
  await page.goto(`${SITE}/profile.html`)
  await page.waitForTimeout(500)
  const datos = {
    'given-name': 'Ana', 'family-name': 'Ruiz', email: 'ana@datos.com',
    tel: '0999111222', 'street-address': 'Calle 1 y Av. 2', city: 'Quito',
  }
  for (const [n, v] of Object.entries(datos)) await page.fill(`input[name="${n}"]`, v)
  await Promise.all([page.waitForURL(/inside/), page.click('button[type=submit]')])
  f = await aviso()
  ok(!!f, 'el aviso sale sin contraseña ninguna')
  if (f) {
    ok(/Dotrino/.test(await f.locator('[data-t=title]').textContent()), 'con la marca arriba')
    ok((await f.locator('[data-testid=save-prompt-who]').textContent()).includes('localhost'),
      'y debajo, dónde va a parar')
    ok(await f.locator('[data-testid=save-prompt-field]').count() === 6, 'una fila por dato')
    ok(await f.locator('[data-testid=save-prompt-pick-city]').isChecked(), 'todas marcadas de entrada')
    await f.locator('[data-testid=save-prompt-pick-city]').uncheck()
    await page.waitForTimeout(300)
    await f.locator('[data-testid=save-prompt-save]').click()
    await page.waitForTimeout(1200)
  }
  const guardados = ((await pedir('find', { url: `${SITE}/inside.html` }))?.result || [])
    .filter((e) => e.type === 'data')
  ok(guardados.length === 1, 'queda UNA entrada de datos (hay ' + guardados.length + ')')
  const abierta = guardados[0] ? (await abrir(guardados[0].id))?.result : null
  const campos = JSON.parse(abierta?.fields || '[]')
  ok(campos.length === 5, 'guarda solo lo marcado (5 de 6): ' + campos.length)
  ok(!campos.some((c) => c.kind === 'city'), 'la ciudad desmarcada NO entra')
  ok(campos.find((c) => c.kind === 'tel')?.value === '0999111222', 'y el teléfono sí')

  // --- caso 8: lo mismo con un dato cambiado ---
  console.log('\ncaso 8 · lo mismo, con un dato cambiado')
  await page.goto(`${SITE}/profile.html`)
  await page.waitForTimeout(500)
  for (const [n, v] of Object.entries({ ...datos, tel: '0988000111', city: '' })) {
    await page.fill(`input[name="${n}"]`, v)
  }
  await Promise.all([page.waitForURL(/inside/), page.click('button[type=submit]')])
  f = await aviso()
  ok(!!f, 'el aviso vuelve a salir')
  if (f) {
    // Qué cambia se sabe por RESÚMENES, sin abrir nada ni pedir autorización.
    const filas = f.locator('[data-testid=save-prompt-field]')
    ok(await filas.count() === 1, 'solo sale lo que cambia (hay ' + (await filas.count()) + ')')
    ok(await filas.first().getAttribute('data-field') === 'tel', 'y es el teléfono')
    ok(/cambia|change/i.test(await filas.first().locator('.tag').textContent()), 'marcado como «cambia»')

    // Lo que había ANTES no se enseña, y no hay botón que lo ofrezca: para eso habría que
    // abrir la entrada, y un aviso de guardar no es sitio para sacar de la bóveda un dato
    // privado que nadie pidió (dueño, 2026-08-29). Hubo un «Ver qué cambia» y se quitó.
    ok(!(await filas.first().locator('.old').count()), 'lo de antes no se enseña')
    ok(!(await f.locator('[data-testid=save-prompt-reveal]').count()), 'y no hay botón que lo ofrezca')
    const destinos = f.locator('[data-testid=save-prompt-target]')
    ok(await destinos.count() === 2, 'ofrece los datos que ya había, y crear otra entrada')
    const datosId = await destinos.nth(1).getAttribute('data-id')
    ok(await f.locator(`[data-testid=save-prompt-target-${datosId}]`).isChecked(),
      'con los de este sitio preseleccionados')
    await f.locator('[data-testid=save-prompt-save]').click()
    await page.waitForTimeout(1200)
  }
  const tras7 = ((await pedir('find', { url: `${SITE}/inside.html` }))?.result || [])
    .filter((e) => e.type === 'data')
  ok(tras7.length === 1, 'actualizar NO duplica la entrada de datos (hay ' + tras7.length + ')')
  const abierta7 = tras7[0] ? (await abrir(tras7[0].id))?.result : null
  const campos7 = JSON.parse(abierta7?.fields || '[]')
  ok(campos7.find((c) => c.kind === 'tel')?.value === '0988000111', 'el teléfono nuevo entra')
  ok(campos7.find((c) => c.kind === 'email')?.value === 'ana@datos.com', 'y lo que no cambió sigue ahí')
  ok(campos7.length === 5, 'sin sumar campos de la nada: ' + campos7.length)

  // --- caso 15: un campo que el gestor NO conoce ---
  //
  // «Número de socio» no es un correo ni un teléfono: no hay clase que le corresponda.
  // Se guarda igual, por su etiqueta, que es su única identidad. Y al enviar el
  // formulario viaja SIN marcar: enviar no es pedir que se guarde.
  console.log('\ncaso 15 · un campo que el gestor no conoce')
  await page.goto(`${SITE}/profile.html`)
  await page.waitForTimeout(500)
  for (const [n, v] of Object.entries({ ...datos, city: '', member: 'SOC-4471' })) {
    await page.fill(`input[name="${n}"]`, v)
  }
  await Promise.all([page.waitForURL(/inside/), page.click('button[type=submit]')])
  f = await aviso()
  ok(!!f, 'el aviso sale')
  if (f) {
    const libre = f.locator('[data-testid="save-prompt-field"][data-field="label:Número de socio"]')
    ok(await libre.count() === 1, 'el campo libre sale en el aviso')
    ok((await libre.locator('.k').textContent()) === 'Número de socio',
      'con el nombre que le pone la página')
    ok((await libre.locator('.v').textContent()) === 'SOC-4471', 'y su valor')
    const marcada = await libre.locator('input[type=checkbox]').isChecked()
    ok(!marcada, 'pero SIN marcar: enviar no es pedir que se guarde')
    // Se marca a mano y se guarda en la entrada de datos que ya había.
    await libre.locator('input[type=checkbox]').check()
    await page.waitForTimeout(300)
    await f.locator('[data-testid=save-prompt-save]').click()
    await page.waitForTimeout(1200)
  }
  const conSocio = ((await pedir('find', { url: `${SITE}/inside.html` }))?.result || [])
    .filter((e) => e.type === 'data')
  const abiertaSocio = conSocio[0] ? (await abrir(conSocio[0].id))?.result : null
  const socio = JSON.parse(abiertaSocio?.fields || '[]').find((c) => c.label === 'Número de socio')
  ok(!!socio, 'y queda guardado por su etiqueta')
  ok(socio?.value === 'SOC-4471', 'con su valor: ' + socio?.value)
  ok(socio?.kind === undefined, 'sin inventarle una clase que no tiene')

  // --- caso 10: «ahora no» ---
  console.log('\ncaso 10 · ahora no')
  await page.goto(`${SITE}/login.html`)
  await page.waitForTimeout(500)
  await page.fill('input[name=user]', 'dani@ejemplo.com')
  await page.fill('input[name=password]', 'no-la-guardes')
  await Promise.all([page.waitForURL(/inside/), page.click('button[type=submit]')])
  f = await aviso()
  ok(!!f, 'sale el aviso')
  if (f) { await f.locator('[data-testid=save-prompt-dismiss]').click(); await page.waitForTimeout(800) }
  const pend = await sw.evaluate(() => chrome.storage.session.get('passmanager/pending-save'))
  ok(!pend['passmanager/pending-save'], 'descartar BORRA lo capturado')
  const nada = ((await pedir('find', { url: `${SITE}/inside.html` }))?.result || [])
    .some((e) => e.hint === 'dani@ejemplo.com')
  ok(!nada, 'y no guarda nada')

  // --- caso 11: los marcadores para rellenar ---
  console.log('\ncaso 11 · marcadores en los campos')
  await page.goto(`${SITE}/login.html`)
  await page.waitForTimeout(1200)
  const marcadores = await page.evaluate(() => {
    // El shadow root es cerrado: se cuenta por lo que se ve, no por el DOM.
    const h = document.getElementById('dotrino-passmanager-ui')
    return { existe: !!h, alcanzable: !!h?.shadowRoot }
  })
  ok(marcadores.existe, 'el gestor monta su UI en la página')
  ok(!marcadores.alcanzable, 'y la página no la alcanza (shadow root cerrado)')
} finally {
  await ctx.close()
  await rm(perfil, { recursive: true, force: true })
}
console.log(fallos.length ? `\n${fallos.length} FALLO(S)` : '\nTODO BIEN')
process.exit(fallos.length ? 1 : 0)
