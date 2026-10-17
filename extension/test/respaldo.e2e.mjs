// EL RESPALDO DE LA BÓVEDA, desde la pestaña que ES la bóveda en la extensión.
//
// De punta a punta y con piezas de verdad: un proxio levantado aquí, la extensión en un
// Chrome, la bóveda de la pestaña (`startBrowserVault`) y los archivos cerrados con la misma
// pieza que usa el binario (`@dotrino/vault/backup`).
//
// Lo que prueba:
//   · un respaldo hecho fuera entra, y sale igual al exportarlo de aquí;
//   · un choque sin decidir no escribe nada, y «reemplazar» lo pisa;
//   · las contraseñas de un respaldo NO entran aquí (viven en el worker) y se dice cuántas.
//
//   node extension/test/respaldo.e2e.mjs
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const EXT = join(here, '..')
const req = createRequire(join(here, '../../../dotrino-vault/test/x.mjs'))
process.env.NODE_ENV = 'test'
process.env.PROXY_DB_FILE = ':memory:'
process.env.PORT = '0'
const proxy = req('../../dotrino-proxy/server.js')
const puerto = await proxy.start(0)
const PROXY_URL = `ws://127.0.0.1:${puerto}`
const { sealBackup, openBackup } = await import(join(here, '../../../dotrino-vault/lib/src/core/backup.js'))

const _pw = await import(process.env.PLAYWRIGHT || 'playwright')
const chromium = _pw.chromium || _pw.default?.chromium
const perfil = await mkdtemp(join(tmpdir(), 'pm-respaldo-'))
const ctx = await chromium.launchPersistentContext(perfil, {
  headless: false,
  args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
  viewport: { width: 900, height: 820 },
})
const fallos = []
const ok = (c, m) => { console.log((c ? '  ok    ' : '  FALLA ') + m); if (!c) fallos.push(m) }
const PWD = 'contraseña del respaldo de prueba'

try {
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 })
  const extId = new URL(sw.url()).host
  const page = await ctx.newPage()
  const errores = []
  page.on('pageerror', (e) => errores.push(e.message))
  await page.goto(`chrome-extension://${extId}/src/vault-tab.html`)
  await page.waitForTimeout(1500)
  ok(await page.locator('[data-testid="vt-backup"]').isVisible(), 'la pestaña-bóveda enseña el respaldo')

  // La misma instancia del módulo que usa la página (la CSP no deja evaluar código, así que
  // se llama a cada función por su nombre).
  const llama = (method, arg) => page.evaluate(async ([id, m, a]) => {
    const logins = await import(`chrome-extension://${id}/src/logins.js`)
    try { return await logins[m](a) } catch (e) { return { error: e.message, code: e.code || null } }
  }, [extId, method, arg])

  await llama('stopServing')
  const serving = await llama('serveLogins', { proxyUrl: PROXY_URL })
  ok(!serving?.error, 'la bóveda de la pestaña se enciende' + (serving?.error ? ` — ${serving.error}` : ''))

  const payload = (token) => ({
    v: 1, createdAt: 1, drawers: [
      { owner: 'ns:proxy', vars: { TOKEN: { value: token, public: false }, URL: { value: 'https://x', public: true } } },
      { owner: 'passwords', entries: [{ id: 'e1', title: 'Correo', sites: ['correo.ejemplo'], username: 'yo', secret: 's' }] }
    ]
  })
  const archivo1 = await sealBackup(payload('uno'), PWD)

  const plan = await llama('backupPlan', { file: archivo1, password: PWD })
  ok(!plan.error && plan.counts?.new === 2, `el plan ve 2 nuevos (${JSON.stringify(plan.counts || plan)})`)
  ok(plan.passwordsLeftOut === 1, 'y dice que deja fuera 1 contraseña')
  ok(!plan.drawers?.some((d) => d.from === 'passwords'), 'las contraseñas no entran en el plan')

  const imp = await llama('backupImport', { file: archivo1, password: PWD })
  ok(imp.written === 2, `importa 2 valores (${JSON.stringify(imp)})`)

  const mala = await llama('backupPlan', { file: archivo1, password: 'otra contraseña larga' })
  ok(mala.code === 'WRONG_PASSWORD', 'con otra contraseña no se abre')

  const archivo2 = await sealBackup(payload('dos'), PWD)
  const sinDecidir = await llama('backupImport', { file: archivo2, password: PWD })
  ok(sinDecidir.code === 'BACKUP_CONFLICTS', 'un choque sin decidir no se importa')

  const conDecision = await llama('backupImport', { file: archivo2, password: PWD, decisions: { 'ns:proxy TOKEN': 'replace' } })
  ok(conDecision.written === 1, `«reemplazar» lo pisa (${JSON.stringify(conDecision)})`)

  const exp = await llama('backupExport', { password: PWD })
  ok(!exp.error, 'exporta' + (exp.error ? ` — ${exp.error}` : ''))
  const abierto = exp.file ? await openBackup(exp.file, PWD) : null
  const proxyDrawer = abierto?.drawers.find((d) => d.owner === 'ns:proxy')
  ok(proxyDrawer?.vars.TOKEN.value === 'dos' && proxyDrawer?.vars.URL.value === 'https://x', 'lo exportado trae los valores de ahora')
  ok(!abierto?.drawers.some((d) => d.owner === 'passwords'), 'y no lleva contraseñas')
  ok(!errores.length, 'sin errores de página' + (errores.length ? `: ${errores[0]}` : ''))
} finally {
  await ctx.close()
  await rm(perfil, { recursive: true, force: true })
  try { await proxy.stop() } catch (_) {}
}
console.log(fallos.length ? `\nFALLARON ${fallos.length}` : '\nTODO BIEN')
process.exit(fallos.length ? 1 : 0)
