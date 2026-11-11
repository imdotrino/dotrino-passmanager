// RELLENAR AL ABRIR LA PÁGINA, el ajuste opcional (dueño, 2026-10-26). Apagado no rellena
// nada; encendido rellena el acceso con la única entrada del sitio, y con dos solo si una
// es la predeterminada. Los dos ajustes son POR SITIO (2026-11-11), y el segundo, ENVIAR
// AL RELLENAR, pulsa una sola vez por formulario.
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
  const URL_LOGIN = `${SITE}/login.html`
  const a0 = (await pedir('autofill-get', { url: URL_LOGIN })).result
  ok(a0?.on === false && a0?.submit === false, 'los dos ajustes nacen apagados')
  ok(!!(await pedir('autofill-set', { url: URL_LOGIN, submit: true })).error, 'enviar sin rellenar: no se deja')

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

  /** Espera a que la casilla `sel` se rellene, contestando que sí si la bóveda pregunta. */
  const esperarRelleno = async (sel, ms = 12000) => {
    const fin = Date.now() + ms
    while (Date.now() < fin) {
      const si = ext.locator('[data-testid=approval-yes]')
      if (await si.isVisible().catch(() => false)) await si.click().catch(() => {})
      if (await page.evaluate((s) => !!document.querySelector(s)?.value, sel).catch(() => false)) return true
      await page.waitForTimeout(250)
    }
    return false
  }

  const [u0, s0] = await abrirLogin({ autorizar: false })
  ok(u0 === '' && s0 === '', 'apagado: no rellena nada')

  ok((await pedir('autofill-set', { url: URL_LOGIN, on: true })).result?.on === true, 'se enciende')
  ok((await pedir('autofill-get', { url: 'https://otro.example/' })).result?.on === false, 'solo para este sitio')
  const [u1, s1] = await abrirLogin({ autorizar: true })
  ok(u1 === 'ana@ejemplo.com' && s1 === 'clave-local-1', `encendido: rellena la única entrada (${u1})`)

  const otra = (await pedir('put', { entry: { type: 'login', title: 'Local 2', sites: ['localhost'], username: 'beto', secret: 'clave-local-2' } })).result
  const [u2, s2] = await abrirLogin({ autorizar: false })
  ok(u2 === '' && s2 === '', 'con dos y sin predeterminada: no elige por ti')

  await pedir('default-set', { url: `${SITE}/login.html`, id: otra.id })
  const [u3, s3] = await abrirLogin({ autorizar: true })
  ok(u3 === 'beto' && s3 === 'clave-local-2', 'con predeterminada: usa esa')

  // ENVIAR AL RELLENAR.
  ok((await pedir('autofill-set', { url: URL_LOGIN, submit: true })).result?.submit === true, 'enviar se enciende')
  // Cancelar: la cuenta atrás sale, se pulsa Cancelar, y no se envía. En una página sin
  // <form> (el botón se busca en el contenedor), que también hay que cubrir.
  const URL_PLAIN = `${SITE}/login-plain.html`
  await pedir('autofill-set', { url: URL_PLAIN, on: true })
  await pedir('autofill-set', { url: URL_PLAIN, submit: true })
  await page.goto(URL_PLAIN)
  ok(await esperarRelleno('#username'), 'enviar: rellena (página sin <form>)')
  await page.waitForTimeout(1500)
  ok(!(await page.evaluate(() => document.body.dataset.sent)), 'enviar: no envía antes de tiempo')
  // La cuenta atrás vive en un shadow root CERRADO (la página no la alcanza), así que se
  // pulsa por coordenadas: píldora de 300 px centrada abajo, Cancelar a la derecha.
  const vp = page.viewportSize()
  await page.mouse.click(vp.width / 2 + 102, vp.height - 47)
  await page.waitForTimeout(11000)
  ok(!(await page.evaluate(() => document.body.dataset.sent)), 'cancelar: no envía')

  await page.goto(URL_LOGIN)
  await esperarRelleno('input[name=password]')
  const tRelleno = Date.now()
  await page.waitForURL(/inside\.html/, { timeout: 20000 }).catch(() => {})
  const tarda = Date.now() - tRelleno
  ok(page.url().includes('inside.html') && tarda > 9000, `enviar: rellena y entra a los 10 s (${Math.round(tarda / 1000)} s)`)

  // Un acceso que falla y vuelve con el mismo formulario: una sola vez, nada de bucle.
  await page.goto(`${SITE}/login-fail.html`)
  await page.evaluate(() => { sessionStorage.envios = '0' })
  await page.reload()
  await esperarRelleno('input[name=password]')
  await page.waitForTimeout(26000)
  const envios = await page.evaluate(() => sessionStorage.envios)
  ok(envios === '1', `con clave mala: envía una vez y para (${envios})`)

  // Un formulario DISTINTO en la misma pestaña (el segundo paso) sí se envía.
  await page.goto(`${SITE}/step2.html?user=beto`)
  await esperarRelleno('input[name=password]')
  await page.waitForURL(/inside\.html/, { timeout: 20000 }).catch(() => {})
  ok(page.url().includes('inside.html'), `otro formulario: también se envía (${page.url()})`)

  // Apagar el relleno apaga el envío.
  const a5 = (await pedir('autofill-set', { url: URL_LOGIN, on: false })).result
  ok(a5?.on === false && a5?.submit === false, 'apagar rellenar apaga enviar')
  const [u4] = await abrirLogin({ autorizar: false })
  ok(u4 === '', 'apagado otra vez: no rellena')

} finally {
  await ctx.close()
  await rm(perfil, { recursive: true, force: true })
}

console.log(fallos.length ? `\n${fallos.length} FAILURE(S)` : '\nALL GOOD')
process.exit(fallos.length ? 1 : 0)
