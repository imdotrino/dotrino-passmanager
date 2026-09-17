// ETIQUETAS QUE SE VEN PERO NO ESTÁN ATADAS al campo (caso 16 del banco).
//
// Lo que el dueño vio el 2026-09-16 en el editor de un panel hecho con Next.js: la casilla
// decía «Usuario» encima, el gestor la llamaba «Otro dato», y de las varias casillas del
// formulario solo marcaba una. Las dos cosas tenían la misma causa: sin `<label for>`,
// sin `name` y sin `placeholder`, todas se quedaban sin nombre, todas con la clave `other`,
// y dos campos con la misma clave son uno.
//
// Se comprueba en dos alturas:
//   1. `detect.js` a pelo, en un Chromium de verdad: qué nombre sale para cada casilla, y
//      que la que no tiene nada a la vista NO se lleva el título de la sección;
//   2. la extensión entera: cada casilla tiene su marcador, y el modal la llama por su
//      nombre.
//
//   npm run test:web &
//   npm run test:labels
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const _pw = await import(process.env.PLAYWRIGHT || 'playwright')
const chromium = _pw.chromium || _pw.default?.chromium

const EXT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SITE = process.env.SITE || 'http://localhost:8099'
const profileDir = await mkdtemp(join(tmpdir(), 'pm-labels-'))
const ctx = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
  viewport: { width: 900, height: 900 },
})
const failures = []
const ok = (c, m) => { console.log((c ? '  ok    ' : '  FAIL  ') + m); if (!c) failures.push(m) }

// `detect.js` servido desde la carpeta de la extensión, bajo el mismo origen que la página:
// así se importa como módulo sin montar otro servidor.
await ctx.route(`${SITE}/__src/**`, async (route) => {
  const file = new URL(route.request().url()).pathname.replace('/__src/', '')
  try {
    route.fulfill({ contentType: 'text/javascript', body: await readFile(join(EXT, 'src', file), 'utf8') })
  } catch (_) { route.fulfill({ status: 404, body: '' }) }
})

try {
  await ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.log('   [page error]', e.message))
  await page.goto(`${SITE}/labels.html`)
  await page.waitForTimeout(800)

  console.log('\nthe name detect.js gives each input')
  const seen = await page.evaluate(async () => {
    const d = await import('/__src/detect.js')
    const inputs = [...document.querySelectorAll('#f1 input[data-expect]')]
    return {
      rows: inputs.map((el) => ({ expected: el.dataset.expect, got: d.fieldLabel(el) })),
      markable: d.findDataFields(document, { free: true }).map((f) => d.fieldKey(f)),
    }
  })
  for (const { expected, got } of seen.rows) {
    ok(got === expected, expected
      ? `"${expected}" → ${JSON.stringify(got)}`
      : `nothing visible names it, so no name → ${JSON.stringify(got)}`)
  }
  const named = seen.rows.filter((r) => r.expected).length
  ok(seen.markable.filter((k) => k !== 'other').length === named,
    `the ${named} named inputs are distinct fields: ${seen.markable.join(' · ')}`)

  console.log('\neach input gets its marker, and the modal uses its name')
  const inputs = page.locator('#f1 input[data-expect]')
  for (let i = 0; i < await inputs.count(); i++) await inputs.nth(i).fill(`value ${i + 1}`)
  await page.waitForTimeout(1200)

  for (let i = 0; i < await inputs.count(); i++) {
    const expected = await inputs.nth(i).getAttribute('data-expect')
    if (!expected) continue
    const box = await inputs.nth(i).boundingBox()
    await page.mouse.click(box.x + box.width - 10, box.y + 8)
    let name = null
    for (let n = 0; n < 30 && name !== expected; n++) {
      await page.waitForTimeout(150)
      const frame = page.frames().find((x) => x.url().includes('field-modal.html'))
      name = frame ? new URL(frame.url()).searchParams.get('name') : null
    }
    ok(name === expected, `the "${expected}" marker opens its modal: ${JSON.stringify(name)}`)
    await page.mouse.click(10, 10)   // fuera: se cierra
    await page.waitForTimeout(300)
  }
} finally {
  await ctx.close()
  await rm(profileDir, { recursive: true, force: true })
}
console.log(failures.length ? `\n${failures.length} FAILURE(S)` : '\nALL GOOD')
process.exit(failures.length ? 1 : 0)
