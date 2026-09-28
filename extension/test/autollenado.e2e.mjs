// LO QUE RELLENA OTRO: el gestor de Chrome u otra extensión (dueño, 2026-09-28: «Dotrino
// no detecta los fields autollenados por otras extensiones o el password manager de
// Chrome»).
//
// Quien rellena desde fuera escribe `value` y a veces no dispara `input`: dispara solo
// `change`, o nada. El marcador de guardar tiene que salir igual, porque lo que hay en la
// casilla es lo mismo que si lo hubiera tecleado el usuario.
//
//   python3 -m http.server 8099 --directory web/test &
//   node extension/test/autollenado.e2e.mjs
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
  await convertirBoveda(pedir)

  const page = await ctx.newPage()

  /** ¿Hay marcador en ese campo? Se pulsa donde vive (arriba a la derecha) y se mira si abre su modal. */
  const hayMarcador = async (selector) => {
    const caja = await page.locator(selector).boundingBox()
    await page.mouse.click(caja.x + caja.width - 10, caja.y + 8)
    for (let i = 0; i < 15; i++) {
      if (page.frames().some(x => x.url().includes('field-modal.html'))) return true
      await page.waitForTimeout(200)
    }
    return false
  }

  const casos = [
    ['sin ningún evento', (el, v) => { el.value = v }],
    ['solo con change', (el, v) => { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })) }],
  ]
  for (const [que, rellenar] of casos) {
    await page.goto(`${SITE}/login.html`)
    await page.waitForTimeout(1200)
    await page.evaluate(([src]) => {
      const fill = new Function('return ' + src)()
      fill(document.querySelector('input[name=user]'), 'ana@ejemplo.com')
      fill(document.querySelector('input[name=password]'), 'clave-de-otro-gestor')
    }, [rellenar.toString()])
    await page.waitForTimeout(2000)
    ok(await hayMarcador('input[name=user]'), `relleno ${que}: el usuario tiene marcador`)
  }
} finally {
  await ctx.close()
  await rm(perfil, { recursive: true, force: true })
}

console.log(fallos.length ? `\n${fallos.length} FALLO(S)` : '\nTODO BIEN')
process.exit(fallos.length ? 1 : 0)
