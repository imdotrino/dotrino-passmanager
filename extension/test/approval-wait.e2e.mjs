// EL AVISO «Esperando tu aprobación» SE PUEDE CERRAR (dueño, 2026-10-22). Se quedaba tapando
// la pantalla, sin botón, aunque la aprobación ya se hubiera dado por otro lado. Cerrado a
// mano no vuelve hasta que la espera termine y empiece otra.
//
// Sin extensión: se carga `approval.js` en una página con un `chrome.runtime` de mentira que
// deja mandar los mensajes del worker a mano.
//
//   node extension/test/approval-wait.e2e.mjs
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = join(here, '../src')
const _pw = await import(process.env.PLAYWRIGHT || 'playwright')
const chromium = _pw.chromium || _pw.default?.chromium

const PAGE = `<!doctype html><meta charset="utf-8"><body>
<script>
  window.__send = null
  window.chrome = { runtime: {
    getURL: (p) => '/' + p,
    connect: () => {
      const on = []
      window.__send = (m) => on.forEach((f) => f(m))
      return { postMessage () {}, onMessage: { addListener: (f) => on.push(f) }, onDisconnect: { addListener () {} } }
    }
  } }
</script>
<script type="module">
  import { hostApprovals } from '/src/approval.js'
  hostApprovals({})
  window.__ready = true
</script>`

const server = createServer(async (req, res) => {
  if (req.url === '/') { res.setHeader('content-type', 'text/html'); return res.end(PAGE) }
  try {
    const body = await readFile(join(src, req.url.replace(/^\/src\//, '')))
    res.setHeader('content-type', extname(req.url) === '.js' ? 'text/javascript' : 'application/octet-stream')
    res.end(body)
  } catch { res.statusCode = 404; res.end() }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}/`

const browser = await chromium.launch()
let fallos = 0
const ok = (cond, msg) => { console.log(`${cond ? '✔' : '✖'} ${msg}`); if (!cond) fallos++ }
try {
  const page = await browser.newPage()
  await page.goto(url)
  await page.waitForFunction(() => window.__ready && window.__send)
  const aviso = page.getByTestId('approval-wait')
  const cerrar = page.getByTestId('approval-wait-close')

  await page.evaluate(() => window.__send({ t: 'remote-wait', on: true }))
  ok(await aviso.isVisible(), 'sale el aviso cuando la bóveda tarda')
  ok(await cerrar.isVisible(), 'y tiene botón para cerrarlo')
  ok(!!(await cerrar.getAttribute('aria-label')), 'con etiqueta accesible')

  await cerrar.click()
  ok(await aviso.count() === 0, 'cerrarlo lo quita')
  await page.evaluate(() => window.__send({ t: 'remote-wait', on: true }))
  ok(await aviso.count() === 0, 'y no vuelve mientras dure la misma espera')

  await page.evaluate(() => window.__send({ t: 'remote-wait', on: false }))
  await page.evaluate(() => window.__send({ t: 'remote-wait', on: true }))
  ok(await aviso.isVisible(), 'una espera nueva lo vuelve a enseñar')
} finally {
  await browser.close()
  server.close()
}
if (fallos) { console.error(`${fallos} fallo(s)`); process.exit(1) }
