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

async function aviso (ms = 10000) {
  for (let i = 0; i < ms / 250; i++) {
    const f = page.frames().find((x) => x.url().includes('/src/save-prompt.html'))
    if (f) { await f.locator('[data-testid=save-prompt-save]').waitFor({ timeout: 5000 }); return f }
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
  await Promise.all([page.waitForURL(/dentro/), page.click('#go')])
  let f = await aviso()
  ok(!!f, 'el aviso sale aunque no haya submit')
  if (f) ok((await f.locator('#user').textContent()) === 'ana@ejemplo.com', 'con el usuario correcto')
  if (f) { await f.locator('[data-testid=save-prompt-save]').click(); await page.waitForTimeout(1000) }

  // --- caso 3: dos pasos ---
  console.log('\ncaso 3 · acceso en dos pasos')
  await page.goto(`${SITE}/paso1.html`)
  await page.waitForTimeout(500)
  await page.fill('input[name=user]', 'beto@ejemplo.com')
  await Promise.all([page.waitForURL(/paso2/), page.click('button[type=submit]')])
  await page.waitForTimeout(500)
  await page.fill('input[name=password]', 'clave-dos-pasos')
  await Promise.all([page.waitForURL(/dentro/), page.click('button[type=submit]')])
  f = await aviso()
  ok(!!f, 'el aviso sale en el segundo paso')
  if (f) ok((await f.locator('#user').textContent()) === 'beto@ejemplo.com',
    'lleva el usuario del PRIMER paso: ' + (f ? await f.locator('#user').textContent() : '—'))
  if (f) { await f.locator('[data-testid=save-prompt-save]').click(); await page.waitForTimeout(1000) }

  // --- caso 5: registro con confirmación ---
  console.log('\ncaso 5 · registro con confirmación')
  await page.goto(`${SITE}/registro.html`)
  await page.waitForTimeout(500)
  await page.fill('input[name=email]', 'caro@ejemplo.com')
  await page.fill('input[name=pass1]', 'la-buena')
  await page.fill('input[name=pass2]', 'la-buena')
  await Promise.all([page.waitForURL(/dentro/), page.click('button[type=submit]')])
  f = await aviso()
  ok(!!f, 'el aviso sale al registrarse')
  if (f) { await f.locator('[data-testid=save-prompt-save]').click(); await page.waitForTimeout(1000) }
  const reg = (await pedir('find', { url: `${SITE}/dentro.html` }))?.result || []
  const suya = reg.find((e) => e.hint === 'c•••o@ejemplo.com')
  const full = suya ? (await pedir('get', { id: suya.id }))?.result : null
  ok(full?.secret === 'la-buena', 'guarda la PRIMERA contraseña, no la de confirmar')

  // --- caso 4: la misma cuenta con otra contraseña ---
  console.log('\ncaso 4 · misma cuenta, otra contraseña')
  await page.goto(`${SITE}/entrar.html`)
  await page.waitForTimeout(500)
  await page.fill('input[name=user]', 'ana@ejemplo.com')
  await page.fill('input[name=password]', 'clave-nueva')
  await Promise.all([page.waitForURL(/dentro/), page.click('button[type=submit]')])
  f = await aviso()
  ok(!!f, 'el aviso vuelve a salir')
  if (f) {
    const actualizar = f.locator('[data-testid=save-prompt-update]')
    ok(await actualizar.isVisible(), 'ofrece «Actualizar la que hay»')
    // El Chrome de prueba corre en inglés: se acepta cualquiera de los dos idiomas.
    const otra = await f.locator('[data-testid=save-prompt-save]').textContent()
    ok(/nueva|new/i.test(otra), 'y la otra salida dice «Guardar como nueva»: ' + otra)
    await actualizar.click()
    await page.waitForTimeout(1200)
  }
  const tras = (await pedir('find', { url: `${SITE}/dentro.html` }))?.result || []
  const deAna = tras.filter((e) => e.hint === 'a•••a@ejemplo.com')
  ok(deAna.length === 1, 'actualizar NO duplica la cuenta (hay ' + deAna.length + ')')
  const anaFull = deAna[0] ? (await pedir('get', { id: deAna[0].id }))?.result : null
  ok(anaFull?.secret === 'clave-nueva', 'y se quedó la contraseña nueva')

  // --- caso 6: «ahora no» ---
  console.log('\ncaso 6 · ahora no')
  await page.goto(`${SITE}/entrar.html`)
  await page.waitForTimeout(500)
  await page.fill('input[name=user]', 'dani@ejemplo.com')
  await page.fill('input[name=password]', 'no-la-guardes')
  await Promise.all([page.waitForURL(/dentro/), page.click('button[type=submit]')])
  f = await aviso()
  ok(!!f, 'sale el aviso')
  if (f) { await f.locator('[data-testid=save-prompt-dismiss]').click(); await page.waitForTimeout(800) }
  const pend = await sw.evaluate(() => chrome.storage.session.get('passmanager/pending-save'))
  ok(!pend['passmanager/pending-save'], 'descartar BORRA lo capturado')
  const nada = ((await pedir('find', { url: `${SITE}/dentro.html` }))?.result || [])
    .some((e) => e.hint === 'd•••i@ejemplo.com')
  ok(!nada, 'y no guarda nada')

  // --- caso 7: los marcadores para rellenar ---
  console.log('\ncaso 7 · marcadores en los campos')
  await page.goto(`${SITE}/entrar.html`)
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
