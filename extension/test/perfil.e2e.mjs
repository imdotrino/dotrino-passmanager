// LA TARJETA DE PERFIL del ecosistema, dentro del gestor de la extensión (§6.1).
//
// Lo que se comprueba no es que «se vea»: que el componente compartido está cableado de
// verdad —que el editor escribe en el perfil del núcleo— y que no arrastra los paneles de
// reputación, que en un gestor de contraseñas no pintan nada.
//
// Antes de esto, `profile-rename` y `profile-remove` existían en el service worker y no
// los llamaba nadie: se podía crear un perfil y cambiarse a él, pero no ponerle nombre ni
// borrarlo.
// Se corre a mano, como sus hermanas:  node extension/test/perfil.e2e.mjs
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { chromium } = await import('playwright')
const EXT = '/mnt/sda1/Dotrino/dotrino-passmanager/extension'
const perfil = await mkdtemp(join(tmpdir(), 'pm-perfil-'))
const ctx = await chromium.launchPersistentContext(perfil, {
  headless: false,
  args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
  viewport: { width: 900, height: 900 },
})
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 })
const id = new URL(sw.url()).host
const page = await ctx.newPage()
page.on('pageerror', (e) => console.log('  [pageerror]', e.message))
page.on('console', (m) => { if (m.type() === 'error') console.log('  [error]', m.text().slice(0, 200)) })
await page.goto(`chrome-extension://${id}/src/manager.html`)
await page.waitForTimeout(3000)

const fallos = []
const ok = (c, m) => { console.log((c ? '  ok    ' : '  FALLA ') + m); if (!c) fallos.push(m) }

const card = page.locator('[data-testid=profile-card]')
ok(await card.count() === 1, 'la tarjeta está en el gestor')
// El Shadow DOM del componente es abierto: Playwright lo atraviesa.
ok(await card.locator('.nick-input').count() >= 1, 'con el campo del nombre (editor)')
ok(await card.locator('[data-photo], input[type=file]').count() >= 1, 'y con la foto')
const dice = await page.evaluate(async () => {
  const c = document.querySelector('[data-testid=profile-card]')
  try { return { lista: await c.provider.listProfiles(), tiene: !!c.provider } }
  catch (e) { return { error: String(e) } }
})
const filas = await card.locator('.prof-row').count()
ok(filas >= 1, 'y la lista de perfiles (' + filas + ')')

// Escribir el nombre y que llegue al service worker.
const input = card.locator('.nick-input').first()
await input.fill('Perfil de prueba')
await input.press('Enter')
await page.waitForTimeout(1500)
const ext = await ctx.newPage()
await ext.goto(`chrome-extension://${id}/src/popup.html`)
const me = await ext.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ op: 'profile-get', payload: {} }, r)))
ok(me?.result?.nickname === 'Perfil de prueba', 'el nombre se guardó en el perfil: ' + JSON.stringify(me?.result?.nickname))

ok(await card.locator('.panel-title').count() === 0, 'y SIN los paneles de reputación')
await page.screenshot({ fullPage: true, path: '/tmp/claude-1000/-mnt-sda1-Dotrino/07b04585-15e7-481e-9e17-69baa9a969a3/scratchpad/perfil.png' })
await ctx.close(); await rm(perfil, { recursive: true, force: true })
console.log(fallos.length ? `\n${fallos.length} FALLO(S)` : '\nTODO BIEN')
process.exit(fallos.length ? 1 : 0)
