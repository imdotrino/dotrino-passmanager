// EL WASM DE OPAQUE, EN UN CHROME DE VERDAD.
//
// Esto prueba la decisión del 2026-09-19: la extensión NO declara `wasm-unsafe-eval` para
// todas sus páginas ni pide el permiso `offscreen`. El WASM vive en UNA página sandbox, que
// tiene su propia CSP (`content_security_policy.sandbox`), y el resto de la extensión le
// habla por `postMessage`.
//
// Es exactamente lo que no se puede comprobar leyendo el manifiesto: si Chrome acepta
// `'wasm-unsafe-eval'` dentro de la CSP del sandbox. Si no lo aceptara, entrar con usuario y
// contraseña fallaría en silencio —un iframe oculto que no arranca no se ve—, así que la
// prueba es el único sitio donde eso salta.
//
// Y de paso hace la vuelta entera de OPAQUE (registrar + entrar) a través del puente: lo que
// sale del registro y lo que sale de entrar tiene que ser la MISMA `exportKey`, porque es la
// que cierra el paquete de llaves del aparato.
//
//   npm run test:opaque
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const _pw = await import(process.env.PLAYWRIGHT || 'playwright')
const chromium = _pw.chromium || _pw.default?.chromium

const EXT = join(dirname(fileURLToPath(import.meta.url)), '..')
const perfil = await mkdtemp(join(tmpdir(), 'pm-opaque-'))
const ctx = await chromium.launchPersistentContext(perfil, {
  headless: false,
  args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
  viewport: { width: 900, height: 820 },
})
const fallos = []
const ok = (c, m) => { console.log((c ? '  ok    ' : '  FALLA ') + m); if (!c) fallos.push(m) }

const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 })
const extId = new URL(sw.url()).host

// La pestaña que ES la bóveda: además de ser donde vive el puente, es la página que el
// dueño pidió que se abriera al levantar una bóveda desde la extensión.
const page = await ctx.newPage()
const violaciones = []
page.on('console', (m) => { if (/Content Security Policy|wasm/i.test(m.text())) violaciones.push(m.text()) })
page.on('pageerror', (e) => violaciones.push('error de página: ' + e.message))
await page.goto(`chrome-extension://${extId}/src/vault-tab.html`)
await page.waitForTimeout(1200)

ok(await page.locator('h2').first().isVisible(), 'la pestaña-bóveda se pinta')

// La vuelta entera, por el puente. Se importa por URL absoluta porque `evaluate` no cuelga
// de ningún módulo.
const r = await page.evaluate(async (id) => {
  const { client, server, suiteId } = await import(`chrome-extension://${id}/src/opaque-bridge.js`)
  const password = 'una contraseña larga de verdad'
  const credentialId = 'ana'
  const suite = await suiteId()
  const setup = await server.createSetup()

  const reg = await client.registrationStart({ password })
  const response = await server.registrationResponse({ setup, request: reg.request, credentialId })
  const fin = await client.registrationFinish({ state: reg.state, response, password })
  const record = await server.registrationFinish({ upload: fin.upload })

  const ini = await client.loginStart({ password })
  const s1 = await server.loginStart({ setup, record, request: ini.request, credentialId })
  const s2 = await client.loginFinish({ state: ini.state, response: s1.response, password })
  await server.loginFinish({ state: s1.state, finalization: s2.finalization })

  // Y con la contraseña equivocada NO sale: es lo que hace que esto sirva de algo.
  const mala = await client.loginStart({ password: 'no es esa' })
  const m1 = await server.loginStart({ setup, record, request: mala.request, credentialId })
  let rechazada = false
  try { await client.loginFinish({ state: mala.state, response: m1.response, password: 'no es esa' }) }
  catch (_) { rechazada = true }

  return { suite, misma: fin.exportKey === s2.exportKey, tieneClave: !!fin.exportKey, rechazada }
}, extId).catch((e) => ({ error: e.message }))

ok(!r.error, 'el WASM arranca dentro del sandbox' + (r.error ? ` — ${r.error}` : ''))
ok(!!r.suite, `la suite se lee del WASM (${r.suite || '—'})`)
ok(r.tieneClave && r.misma, 'registrar y entrar dan la MISMA exportKey')
ok(r.rechazada, 'con la contraseña equivocada no sale ninguna llave')
ok(!violaciones.length, 'ni una violación de CSP' + (violaciones.length ? `: ${violaciones[0]}` : ''))

await ctx.close()
await rm(perfil, { recursive: true, force: true })
console.log(fallos.length ? `\nFALLARON ${fallos.length}` : '\nTODO BIEN')
process.exit(fallos.length ? 1 : 0)
