// RELLENAR AL ABRIR LA PÁGINA, el ajuste opcional (dueño, 2026-10-26). Apagado no rellena
// nada; encendido rellena el acceso con la única entrada del sitio, y con dos solo si una
// es la predeterminada.
//
//   python3 -m http.server 8099 --directory web/test &
//   node extension/test/autofill-on-open.e2e.mjs
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

  const una = (await pedir('put', { entry: { type: 'login', title: 'Local', sites: ['localhost'], username: 'ana@ejemplo.com', secret: 'clave-local-1' } })).result
  ok(!!una?.id, 'la entrada se guarda')
  ok((await pedir('autofill-get')).result === false, 'el ajuste nace apagado')

  const page = await ctx.newPage()
  const valores = () => page.evaluate(() => [
    document.querySelector('input[name=user]').value,
    document.querySelector('input[name=password]').value,
  ])

  /** Abre el login; la bóveda de la extensión pide autorización y se le dice que sí. */
  const abrirLogin = async ({ autorizar }) => {
    await page.goto(`${SITE}/login.html`)
    if (autorizar) {
      // La pregunta sale en la pantalla de la extensión que esté viva: el popup.
      try { await ext.locator('[data-testid=approval-yes]').click({ timeout: 8000 }) } catch (_) {}
    }
    await page.waitForTimeout(1500)
    return valores()
  }

  const [u0, s0] = await abrirLogin({ autorizar: false })
  ok(u0 === '' && s0 === '', 'apagado: no rellena nada')

  ok((await pedir('autofill-set', { on: true })).result?.on === true, 'se enciende')
  const [u1, s1] = await abrirLogin({ autorizar: true })
  ok(u1 === 'ana@ejemplo.com' && s1 === 'clave-local-1', `encendido: rellena la única entrada (${u1})`)

  const otra = (await pedir('put', { entry: { type: 'login', title: 'Local 2', sites: ['localhost'], username: 'beto', secret: 'clave-local-2' } })).result
  const [u2, s2] = await abrirLogin({ autorizar: false })
  ok(u2 === '' && s2 === '', 'con dos y sin predeterminada: no elige por ti')

  await pedir('default-set', { url: `${SITE}/login.html`, id: otra.id })
  const [u3, s3] = await abrirLogin({ autorizar: true })
  ok(u3 === 'beto' && s3 === 'clave-local-2', 'con predeterminada: usa esa')

  await pedir('autofill-set', { on: false })
  const [u4] = await abrirLogin({ autorizar: false })
  ok(u4 === '', 'apagado otra vez: no rellena')

} finally {
  await ctx.close()
  await rm(perfil, { recursive: true, force: true })
}

console.log(fallos.length ? `\n${fallos.length} FAILURE(S)` : '\nALL GOOD')
process.exit(fallos.length ? 1 : 0)
