// AL CREAR UNA PASSKEY, LA EXTENSIÓN PREGUNTA DÓNDE (dueño, 2026-10-16: «el problema no era
// que asomara, sino que bloqueaba silenciosamente»). Antes decidía sola: primero todo a
// Dotrino, después solo los sitios ya guardados en Dotrino. Ahora sale un aviso con
// «Guardar en Dotrino» y «Ahora no», y «Ahora no» se la deja al navegador.
//
// La prueba pone un autenticador virtual en Chrome —el lugar del gestor del navegador— y
// mira quién se queda con la llave en cada salida. Y una más: un sitio no puede pedir una
// passkey de OTRO sitio diciendo que es él (el origen sale del remitente, no del mensaje).
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

  const aviso = async () => {
    for (let i = 0; i < 100; i++) {
      const f = page.frames().find(f => f.url().includes('/src/passkey-prompt.html'))
      if (f) { await f.waitForSelector('[data-testid=passkey-prompt-save]:not([disabled])', { timeout: 10000 }); return f }
      await page.waitForTimeout(100)
    }
    throw new Error('the passkey prompt never showed up')
  }

  // 1. «Ahora no»: la passkey es del navegador, y Dotrino no guarda nada.
  let creando = crear('ana')
  let f = await aviso()
  ok((await f.textContent('[data-testid=passkey-prompt-who]')).includes('localhost'), 'el aviso dice de qué sitio es')
  await f.click('[data-testid=passkey-prompt-dismiss]')
  ok(!!(await creando), 'con «Ahora no», crear la passkey funciona')
  ok(await delNavegador() === 1, 'y se la queda el autenticador del navegador')
  ok(await passkeysDotrino() === 0, 'Dotrino no guarda nada')

  // 2. «Guardar en Dotrino»: aunque el sitio no esté guardado en Dotrino, se puede elegir.
  creando = crear('ana2')
  f = await aviso()
  await f.click('[data-testid=passkey-prompt-save]')
  ok(!!(await creando), 'con «Guardar en Dotrino», crear la passkey funciona')
  ok(await passkeysDotrino() === 1, 'y se la queda Dotrino')
  ok(await delNavegador() === 1, 'el autenticador del navegador no cambia')
  ok(!page.frames().some(f => f.url().includes('/src/passkey-prompt.html')), 'el aviso se cierra solo')

  // 3. Un sitio no puede pedir la passkey de otro: localhost diciendo «soy example.com».
  const ajeno = await page.evaluate(() => new Promise((resolve) => {
    addEventListener('message', (e) => { if (e.data?.channel === 'dotrino-passmanager:webauthn:res' && e.data.id === 'x1') resolve(e.data) })
    postMessage({ channel: 'dotrino-passmanager:webauthn:req', id: 'x1', op: 'webauthn-get',
      payload: { rpId: 'example.com', origin: 'https://example.com', challenge: 'YWJj', allowCredentials: [] } }, location.origin)
  }))
  ok(ajeno.fallback === true && !ajeno.result, 'pedir la passkey de otro sitio se rechaza')
} finally {
  await ctx.close()
  server.close()
  await rm(perfil, { recursive: true, force: true })
}

if (fallos.length) { console.log(`\n${fallos.length} fallo(s)`); process.exit(1) }
console.log('\ntodo bien')
