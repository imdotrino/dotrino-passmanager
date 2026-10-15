// LAS PASSKEYS DE UN SITIO QUE NO ESTÁ EN DOTRINO SON DEL NAVEGADOR (dueño, 2026-10-15:
// «si no tiene no debería interferir»).
//
// Antes el gestor se quedaba con toda passkey que un sitio pidiera crear, y el gestor de
// Google no llegaba a verla. Esta prueba pone un autenticador virtual en Chrome —el lugar
// del gestor del navegador— y mira quién se queda con la llave:
//
//   · sitio sin nada en Dotrino → el autenticador virtual
//   · sitio que ya está en Dotrino → Dotrino, y el virtual no cambia
//
//   node test/passkey-paso.e2e.mjs
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { convertirBoveda } from './_boveda.mjs'
const _pw = await import(process.env.PLAYWRIGHT || 'playwright')
const chromium = _pw.chromium || _pw.default?.chromium

const EXT = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = createServer((_, res) => {
  res.setHeader('content-type', 'text/html')
  res.end('<!doctype html><title>passkey</title><p>passkey</p>')
}).listen(0)
const SITE = `http://localhost:${server.address().port}/`

const perfil = await mkdtemp(join(tmpdir(), 'pm-passkey-'))
const ctx = await chromium.launchPersistentContext(perfil, {
  headless: false,
  args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
})
const fallos = []
const ok = (c, m) => { console.log((c ? '  ok    ' : '  FALLA ') + m); if (!c) fallos.push(m) }

try {
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 })
  const id = new URL(sw.url()).host
  const ext = await ctx.newPage()
  await ext.goto(`chrome-extension://${id}/src/popup.html`)
  const pedir = (op, payload) => ext.evaluate(([op, payload]) => new Promise((r) =>
    chrome.runtime.sendMessage({ op, payload }, r)), [op, payload])
  await convertirBoveda(pedir)

  const page = await ctx.newPage()
  await page.goto(SITE)
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
    },
  })
  const delNavegador = async () =>
    (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials.length

  const crear = (user) => page.evaluate(async (user) => {
    const c = await navigator.credentials.create({ publicKey: {
      rp: { name: 'Prueba', id: 'localhost' },
      user: { id: new TextEncoder().encode(user), name: user, displayName: user },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    } })
    return c?.id || null
  }, user)

  const passkeysDotrino = async () =>
    ((await pedir('find', { url: 'https://localhost/' }))?.result || []).filter(e => e.hasWebauthn).length

  // 1. Nada de localhost en Dotrino: la passkey es del navegador.
  ok(!!(await crear('ana')), 'sin nada en Dotrino, crear la passkey funciona')
  ok(await delNavegador() === 1, 'y se la queda el autenticador del navegador')
  ok(await passkeysDotrino() === 0, 'Dotrino no guarda nada')

  // 2. El usuario ya guarda localhost en Dotrino: la passkey va a Dotrino.
  const puesto = await pedir('put', { entry: {
    type: 'login', title: 'localhost', sites: ['localhost'], username: 'ana', secret: 'x',
  } })
  ok(!puesto?.error, 'guardar un acceso de localhost en Dotrino')
  await page.reload()
  ok(!!(await crear('ana2')), 'con el sitio en Dotrino, crear la passkey funciona')
  ok(await passkeysDotrino() === 1, 'y se la queda Dotrino')
  ok(await delNavegador() === 1, 'el autenticador del navegador no cambia')
} finally {
  await ctx.close()
  server.close()
  await rm(perfil, { recursive: true, force: true })
}

if (fallos.length) { console.log(`\n${fallos.length} fallo(s)`); process.exit(1) }
console.log('\ntodo bien')
