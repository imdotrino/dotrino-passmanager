// ACCESO POR PASOS SIN RECARGAR (el de Google): correo → contraseña → segundo paso, todo en
// la misma página, sin <form>. Lo que se comprueba:
//
//   · el paso del correo NO saca aviso (se recuerda, nada más);
//   · con la contraseña mala la casilla se queda y NO sale aviso;
//   · con la buena, la casilla desaparece y sale UN aviso con correo y contraseña.
//
//   python3 -m http.server 8099 --directory web/test &
//   node extension/test/login-steps.e2e.mjs
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { convertVault } from './_vault.mjs'

const _pw = await import(process.env.PLAYWRIGHT || 'playwright')
const chromium = _pw.chromium || _pw.default?.chromium

const EXT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SITE = process.env.SITE || 'http://localhost:8099'

const perfil = await mkdtemp(join(tmpdir(), 'pm-chrome-'))
const ctx = await chromium.launchPersistentContext(perfil, {
  headless: false,
  args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
})

const fallos = []
const ok = (cond, msg) => { console.log((cond ? '  ok   ' : '  FAIL  ') + msg); if (!cond) fallos.push(msg) }

try {
  let sw = ctx.serviceWorkers()[0]
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 })
  const id = new URL(sw.url()).host

  const ext = await ctx.newPage()
  await ext.goto(`chrome-extension://${id}/src/popup.html`)
  const pedir = (op, payload) => ext.evaluate(([op, payload]) => new Promise((r) =>
    chrome.runtime.sendMessage({ op, payload }, r)), [op, payload])
  await convertVault(pedir)

  const page = await ctx.newPage()
  page.on('console', (m) => { if (m.type() === 'error') console.log('   [console]', m.text()) })
  const aviso = () => page.frames().find(x => x.url().includes('/src/save-prompt.html'))
  const esperarAviso = async (ms) => {
    for (let t = 0; t < ms; t += 250) {
      if (aviso()) return aviso()
      await page.waitForTimeout(250)
    }
    return null
  }

  await page.goto(`${SITE}/login-steps.html`)
  await page.waitForTimeout(600)

  // --- 1. el correo, y «Siguiente» ---
  await page.fill('#identifierId', 'beto@dotrino.com')
  await page.click('#next1')
  await page.waitForSelector('input[name=Passwd]')
  ok(!(await esperarAviso(2500)), 'el paso del correo no saca aviso')

  // --- 2. contraseña mala: la casilla se queda ---
  await page.fill('input[name=Passwd]', 'mala-de-prueba')
  await page.click('#next2')
  await page.waitForSelector('#err:has-text("incorrecta")')
  ok(!(await esperarAviso(2500)), 'con la contraseña mala no sale aviso')

  // --- 3. la buena: la casilla desaparece y sale el aviso, con los dos ---
  await page.fill('input[name=Passwd]', 'buena-de-prueba')
  await page.click('#next2')
  await page.waitForSelector('#done')
  const frame = await esperarAviso(8000)
  ok(!!frame, 'al pasar al segundo paso sale el aviso de guardar')
  if (frame) {
    await frame.locator('[data-testid=save-prompt-field]').first().waitFor({ timeout: 8000 })
    const donde = await frame.locator('[data-testid=save-prompt-who]').textContent()
    ok(donde === 'beto@dotrino.com · localhost', 'con el correo del primer paso: ' + donde)
    const filas = await frame.locator('[data-testid=save-prompt-field]').count()
    ok(filas === 2, `dos filas, usuario y contraseña (${filas})`)
    const inner = await frame.locator('body').innerHTML()
    ok(!inner.includes('buena-de-prueba'), 'la contraseña no viaja al aviso')
  }
} catch (e) {
  console.error(e)
  fallos.push(String(e?.message || e))
} finally {
  await ctx.close()
  await rm(perfil, { recursive: true, force: true })
}

console.log(fallos.length ? `\n${fallos.length} FAILED` : '\nALL GOOD')
process.exit(fallos.length ? 1 : 0)
