// LA CONTRASEÑA DE RECUPERACIÓN DESDE LA PANTALLA, como un usuario.
//
// Desde el 2026-09-24 es un AVISO, no una puerta (dueño): la bóveda guarda y busca sin
// ella, y la lista enseña el aviso con su botón. Esta prueba comprueba las dos mitades: que
// no bloquea, y que al ponerla lo guardado antes queda cubierto.
//
// Desde la 0.16.0 todo mandaba a `#view=convert` —el gestor al abrirse, el botón «Ponerla
// ahora» del popup y del modal de la página— y la pantalla no existía: caía en la lista y no
// había forma de convertir. Las demás pruebas no lo veían porque convierten llamando a
// `sealed-convert` directamente (`_boveda.mjs`). Esta no: usa la pantalla.
//
//   npm run test:convertir
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CLAVE_BOVEDA } from './_boveda.mjs'

const _pw = await import(process.env.PLAYWRIGHT || 'playwright')
const chromium = _pw.chromium || _pw.default?.chromium

const EXT = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = await mkdtemp(join(tmpdir(), 'pm-convertir-'))
const ctx = await chromium.launchPersistentContext(dir, {
  headless: false,
  args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
  viewport: { width: 900, height: 820 },
})
const fallos = []
const ok = (c, m) => { console.log((c ? '  ok    ' : '  FALLA ') + m); if (!c) fallos.push(m) }

try {
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 })
  const id = new URL(sw.url()).host
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.log('   [error de página]', e.message))
  const pedir = (op, payload) => page.evaluate(([op, payload]) => new Promise((r) =>
    chrome.runtime.sendMessage({ op, payload }, r)), [op, payload])

  console.log('\nel botón «Ponerla ahora» lleva a la pantalla')
  await page.goto(`chrome-extension://${id}/src/popup.html`)
  const abierta = ctx.waitForEvent('page', { timeout: 8000 }).catch(() => null)
  await pedir('open-convert')
  const nueva = await abierta
  if (nueva) await nueva.waitForLoadState()
  ok(!!nueva && nueva.url().endsWith('/src/manager.html#view=convert'), `abre el gestor en #view=convert (${nueva?.url() || 'nada'})`)
  const pw1 = nueva?.locator('[data-testid=convert-pw1]')
  ok(!!pw1 && await pw1.isVisible().catch(() => false), 'y ahí está la pantalla de convertir, no la lista')
  await nueva?.close()

  console.log('\nsin contraseña de recuperación NO bloquea')
  const antes = await pedir('put', { entry: { type: 'login', title: 'Antes', sites: ['antes.example'], username: 'ana', secret: 'y' } })
  ok(!antes?.error, 'guarda sin ella' + (antes?.error ? ` — ${antes.error.code}` : ''))
  await page.goto(`chrome-extension://${id}/src/manager.html`)
  const aviso = page.locator('[data-testid=recovery-notice]')
  await aviso.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {})
  ok(await aviso.isVisible(), 'el gestor enseña el aviso')
  ok(await page.evaluate(() => location.hash) === '', 'y se queda en la lista, sin desviar')
  ok(await page.locator('[data-testid=manager-search]').isVisible(), 'la lista se puede usar')

  await aviso.locator('[data-testid=open-convert]').click()
  const campo = page.locator('[data-testid=convert-pw1]')
  await campo.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {})
  ok(await campo.isVisible(), 'el botón del aviso lleva a ponerla')

  const msg = page.locator('[data-testid=convert-msg]')
  await campo.fill('corta')
  await page.locator('[data-testid=convert-pw2]').fill('corta')
  await page.locator('[data-testid=convert-go]').click()
  ok(/12/.test(await msg.textContent()), `una contraseña corta se para: «${await msg.textContent()}»`)

  await campo.fill(CLAVE_BOVEDA)
  await page.locator('[data-testid=convert-pw2]').fill(CLAVE_BOVEDA + ' otra')
  await page.locator('[data-testid=convert-go]').click()
  ok((await pedir('sealed-needs'))?.result?.needs === true, 'si no coinciden, no la pone')

  await page.locator('[data-testid=convert-pw2]').fill(CLAVE_BOVEDA)
  await page.locator('[data-testid=convert-go]').click()
  await page.waitForFunction(() => location.hash === '', null, { timeout: 15000 }).catch(() => {})
  ok((await pedir('sealed-needs'))?.result?.needs === false, 'con las dos iguales, la copia queda puesta')
  ok(await page.evaluate(() => location.hash) === '', 'y vuelve a la lista')

  const puesta = await pedir('put', { entry: { type: 'login', title: 'Prueba', sites: ['prueba.example'], username: 'ana', secret: 'x' } })
  ok(!puesta?.error, 'y sigue guardando' + (puesta?.error ? ` — ${puesta.error.code}` : ''))
  const vistas = await pedir('find', { url: 'https://antes.example/' })
  ok(vistas?.result?.length === 1, 'lo guardado antes de ponerla sigue ahí')
  ok(!(await aviso.isVisible().catch(() => false)), 'y el aviso ya no sale')

  await page.goto(`chrome-extension://${id}/src/manager.html#view=convert`)
  await page.waitForFunction(() => location.hash === '', null, { timeout: 8000 }).catch(() => {})
  ok(await page.evaluate(() => location.hash) === '', 'ya puesta, #view=convert lleva a la lista')
} finally {
  await ctx.close()
  await rm(dir, { recursive: true, force: true })
}

console.log(fallos.length ? `\nFALLARON ${fallos.length}` : '\nTODO BIEN')
process.exit(fallos.length ? 1 : 0)
