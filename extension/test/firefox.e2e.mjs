// EL MISMO PAQUETE EN FIREFOX. Carga la extensión en un Firefox de verdad (el de Playwright)
// por WebDriver BiDi y comprueba lo que en Chrome se da por hecho y en Firefox no:
//
//   - el fondo arranca como `background.scripts` (Firefox no tiene service worker de extensión)
//   - el WASM de OPAQUE compila (Firefox no tiene páginas sandbox: hace falta `wasm-unsafe-eval`)
//   - el content script ve el formulario y el parche de passkeys entra en la página (world MAIN)
//
// Firefox para Android es el mismo Gecko; lo que allí cambia (no hay `chrome.windows`) lo cubre
// `openAskWindow` en `background.js`, que abre una pestaña.
//
//   npm run test:firefox

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { firefox } from 'playwright'

const ext = join(dirname(fileURLToPath(import.meta.url)), '..')
const UUID = '11111111-2222-3333-4444-555555555555'
const PORT = 9333

// Firefox 149+ no deja que WebDriver BiDi navegue a una página `moz-extension://`, así que
// el popup y el WASM solo se prueban con un Firefox anterior: `FIREFOX_BIN=<ruta> npm run
// test:firefox` (p. ej. el de Playwright firefox-1511, que es Firefox 148). Con uno nuevo esa
// parte sale como SKIPPED, dicho, nunca como aprobada.
const FIREFOX_BIN = process.env.FIREFOX_BIN || firefox.executablePath()
if (!existsSync(FIREFOX_BIN)) {
  console.error('Firefox not found at %s: npx playwright install firefox, or set FIREFOX_BIN', FIREFOX_BIN)
  process.exit(1)
}

const prof = await mkdtemp(join(tmpdir(), 'pm-ff-'))
await writeFile(join(prof, 'user.js'),
  `user_pref("extensions.webextensions.uuids", ${JSON.stringify(JSON.stringify({ 'passmanager@dotrino.com': UUID }))});\n`)

const site = createServer((_, res) => {
  res.setHeader('content-type', 'text/html')
  res.end('<!doctype html><form><input type="email" name="email" autocomplete="username">' +
    '<input type="password" name="password" autocomplete="current-password"><button>Entrar</button></form>')
}).listen(0)
const sitePort = site.address().port

const ff = spawn(FIREFOX_BIN, ['-headless', '-no-remote', '-profile', prof, '--remote-debugging-port', String(PORT)],
  { stdio: 'ignore' })
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

let fallos = 0
let skipped = 0
const ok = (cond, msg) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}`); if (!cond) fallos++ }

try {
  let ws
  for (let i = 0; i < 60 && !ws; i++) {
    try {
      const w = new WebSocket(`ws://127.0.0.1:${PORT}/session`)
      await new Promise((resolve, reject) => { w.onopen = resolve; w.onerror = reject })
      ws = w
    } catch { await sleep(500) }
  }
  if (!ws) throw new Error('firefox: no WebDriver BiDi endpoint')
  let n = 0
  const pend = new Map()
  ws.onmessage = (e) => { const m = JSON.parse(e.data); pend.get(m.id)?.(m); pend.delete(m.id) }
  const cmd = (method, params) => new Promise((resolve, reject) => {
    const id = ++n
    pend.set(id, (m) => m.type === 'success' ? resolve(m.result) : reject(new Error(`${method}: ${m.error} ${m.message}`)))
    ws.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (ctx, expression) => {
    const r = await cmd('script.evaluate', { target: { context: ctx }, awaitPromise: true, expression })
    if (r.type !== 'success') throw new Error('evaluate: ' + JSON.stringify(r.exceptionDetails?.text))
    return JSON.parse(r.result.value)
  }

  await cmd('session.new', { capabilities: {} })
  const inst = await cmd('webExtension.install', { extensionData: { type: 'path', path: ext } })
  ok(inst.extension === 'passmanager@dotrino.com', 'se instala con su id de Firefox')
  const ctx = (await cmd('browsingContext.getTree', {})).contexts[0].context
  await sleep(1500)

  console.log('\nel popup')
  let enPopup = true
  try {
    await cmd('browsingContext.navigate', { context: ctx, url: `moz-extension://${UUID}/src/popup.html`, wait: 'complete' })
  } catch (e) {
    if (!/not allowed/.test(e.message)) throw e
    enPopup = false
    skipped++
    console.log('  SKIPPED  this Firefox does not let BiDi open extension pages (use FIREFOX_BIN=<Firefox 148>)')
  }
  if (enPopup) {
    await sleep(2000)
    const p = await evaluate(ctx, `(async () => {
      const bg = await new Promise(res => chrome.runtime.sendMessage({ t: 'status' }, x => res(x)))
      const profiles = await new Promise(res => chrome.runtime.sendMessage({ op: 'profiles' }, x => res(x)))
      const m = await import('./opaque-bridge.js')
      const suite = await Promise.race([m.suiteId(), new Promise(z => setTimeout(() => z('timeout'), 8000))])
      return JSON.stringify({ bg, profiles, suite, painted: document.getElementById('view').children.length > 0 })
    })()`)
    ok(p.bg != null, 'el fondo contesta')
    ok(p.painted, 'y el popup se pinta')
    ok(Array.isArray(p.profiles?.result), `el popup puede pedir sus perfiles (moz-extension:// es la extensión): ${JSON.stringify(p.profiles?.error || '')}`)
    ok(/^opaque-/.test(p.suite), `el WASM de OPAQUE compila (${p.suite})`)
  }

  console.log('\nuna página con login')
  await cmd('browsingContext.navigate', { context: ctx, url: `http://localhost:${sitePort}/`, wait: 'complete' })
  await sleep(3000)
  const s = await evaluate(ctx, `JSON.stringify({
    host: !!document.getElementById('dotrino-passmanager-ui'),
    patched: !String(navigator.credentials.create).includes('[native code]') })`)
  ok(s.host, 'el content script ve el formulario')
  ok(s.patched, 'y el parche de passkeys entra en la página')
} finally {
  ff.kill()
  site.close()
  await rm(prof, { recursive: true, force: true })
}

console.log(fallos ? `\n${fallos} FAILED` : skipped ? `\nGOOD, ${skipped} part SKIPPED` : '\nALL GOOD')
process.exit(fallos ? 1 : 0)
