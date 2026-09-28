// EN QUÉ CUENTA se guarda: el selector de los modales (dueño, 2026-09-28).
//
// Dos perfiles en la extensión, cada uno con su bóveda. Se entra en un sitio con el
// primero activo, en el aviso se elige el segundo y se guarda: la entrada tiene que caer
// en la bóveda del segundo y NO en la del primero.
//
//   python3 -m http.server 8099 --directory web/test &
//   node extension/test/cuentas.e2e.mjs
//
// `PLAYWRIGHT` apunta al paquete si no está instalado aquí (p. ej. el de dotrino-test).
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { convertirBoveda } from './_boveda.mjs'

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
const ok = (cond, msg) => { console.log((cond ? '  ok   ' : '  FALLA ') + msg); if (!cond) fallos.push(msg) }

try {
  let sw = ctx.serviceWorkers()[0]
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 })
  const id = new URL(sw.url()).host

  const ext = await ctx.newPage()
  await ext.goto(`chrome-extension://${id}/src/popup.html`)
  const pedir = (op, payload) => ext.evaluate(([op, payload]) => new Promise((r) =>
    chrome.runtime.sendMessage({ op, payload }, r)), [op, payload])

  // Dos cuentas, las dos convertidas. `profile-add` deja activa la nueva, así que se
  // vuelve a la primera antes de entrar en el sitio.
  await convertirBoveda(pedir)
  const primera = (await pedir('status')).result.active
  await pedir('profile-add', { label: 'Trabajo' })
  await convertirBoveda(pedir)
  const segunda = (await pedir('status')).result.active
  ok(primera !== segunda, 'hay dos cuentas')
  await pedir('profile-use', { id: primera })

  const page = await ctx.newPage()
  await page.goto(`${SITE}/login.html`)
  await page.waitForTimeout(600)
  await page.fill('input[name=user]', 'ana@trabajo.com')
  await page.fill('input[name=password]', 'clave-del-trabajo')
  await Promise.all([page.waitForURL(/inside\.html/), page.click('button[type=submit]')])

  let frame = null
  for (let i = 0; i < 40 && !frame; i++) {
    frame = page.frames().find(x => x.url().includes('/src/save-prompt.html')) || null
    if (!frame) await page.waitForTimeout(250)
  }
  ok(!!frame, 'sale el aviso')
  if (!frame) throw new Error('no salió el aviso')
  await frame.locator('[data-testid=save-prompt-field]').first().waitFor({ timeout: 8000 })

  const sel = frame.locator('[data-testid=save-prompt-account]')
  ok(await sel.isVisible(), 'el aviso lleva el selector de cuenta')
  ok(await sel.locator('option').count() === 2, 'con las dos cuentas')
  ok(await sel.inputValue() === primera, 'y marcada la activa')

  await sel.selectOption(segunda)
  await frame.waitForFunction((a) => !document.querySelector('[data-testid=save-prompt-account]').disabled, null)
  await frame.locator('[data-testid=save-prompt-field]').first().waitFor({ timeout: 8000 })
  ok((await pedir('status')).result.active === segunda, 'elegir otra cuenta la deja activa')

  await frame.locator('[data-testid=save-prompt-save]').click()
  await page.waitForTimeout(1500)

  const enSegunda = ((await pedir('find', { url: `${SITE}/login.html` }))?.result) || []
  ok(enSegunda.length === 1, `la entrada cae en la cuenta elegida (hay ${enSegunda.length})`)
  await pedir('profile-use', { id: primera })
  const enPrimera = ((await pedir('find', { url: `${SITE}/login.html` }))?.result) || []
  ok(enPrimera.length === 0, `y no en la otra (hay ${enPrimera.length})`)

  // --- el modal de un campo lleva el mismo selector ---
  await page.goto(`${SITE}/login.html`)
  await page.waitForTimeout(1200)
  const caja = await page.locator('input[name=password]').boundingBox()
  await page.mouse.click(caja.x + caja.width - 10, caja.y + 8)
  let modal = null
  for (let i = 0; i < 40 && !modal; i++) {
    modal = page.frames().find(x => x.url().includes('field-modal.html')) || null
    if (!modal) await page.waitForTimeout(200)
  }
  ok(!!modal, 'la contraseña vacía abre el modal')
  if (modal) {
    await modal.locator('body[data-ready]').waitFor({ timeout: 8000 })
    const s2 = modal.locator('[data-testid=field-modal-account]')
    ok(await s2.isVisible() && await s2.locator('option').count() === 2, 'el modal lleva el selector con las dos cuentas')
    ok(await s2.inputValue() === primera, 'y marcada la activa')
  }
} finally {
  await ctx.close()
  await rm(perfil, { recursive: true, force: true })
}

console.log(fallos.length ? `\n${fallos.length} FALLO(S)` : '\nTODO BIEN')
process.exit(fallos.length ? 1 : 0)
