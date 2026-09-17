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
//   npm run test:etiquetas
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const _pw = await import(process.env.PLAYWRIGHT || 'playwright')
const chromium = _pw.chromium || _pw.default?.chromium

const EXT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SITE = process.env.SITE || 'http://localhost:8099'
const perfil = await mkdtemp(join(tmpdir(), 'pm-etiquetas-'))
const ctx = await chromium.launchPersistentContext(perfil, {
  headless: false,
  args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
  viewport: { width: 900, height: 900 },
})
const fallos = []
const ok = (c, m) => { console.log((c ? '  ok    ' : '  FALLA ') + m); if (!c) fallos.push(m) }

// `detect.js` servido desde la carpeta de la extensión, bajo el mismo origen que la página:
// así se importa como módulo sin montar otro servidor.
await ctx.route(`${SITE}/__src/**`, async (route) => {
  const ruta = new URL(route.request().url()).pathname.replace('/__src/', '')
  try {
    route.fulfill({ contentType: 'text/javascript', body: await readFile(join(EXT, 'src', ruta), 'utf8') })
  } catch (_) { route.fulfill({ status: 404, body: '' }) }
})

try {
  await ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.log('   [error de página]', e.message))
  await page.goto(`${SITE}/etiquetas.html`)
  await page.waitForTimeout(800)

  console.log('\nel nombre de cada casilla, según detect.js')
  const vistos = await page.evaluate(async () => {
    const d = await import('/__src/detect.js')
    const inputs = [...document.querySelectorAll('#f1 input[data-expect]')]
    return {
      filas: inputs.map((el) => ({ espera: el.dataset.expect, sale: d.fieldLabel(el) })),
      marcables: d.findDataFields(document, { free: true }).map((f) => d.fieldKey(f)),
    }
  })
  for (const { espera, sale } of vistos.filas) {
    ok(sale === espera, espera ? `«${espera}» → ${JSON.stringify(sale)}` : `sin nada a la vista, sin nombre → ${JSON.stringify(sale)}`)
  }
  const conNombre = vistos.filas.filter((f) => f.espera).length
  ok(vistos.marcables.filter((k) => k !== 'other').length === conNombre,
    `las ${conNombre} con nombre son campos distintos: ${vistos.marcables.join(' · ')}`)

  console.log('\ncada casilla tiene su marcador, y el modal la llama por su nombre')
  const casillas = page.locator('#f1 input[data-expect]')
  for (let i = 0; i < await casillas.count(); i++) await casillas.nth(i).fill(`valor ${i + 1}`)
  await page.waitForTimeout(1200)

  for (let i = 0; i < await casillas.count(); i++) {
    const espera = await casillas.nth(i).getAttribute('data-expect')
    if (!espera) continue
    const caja = await casillas.nth(i).boundingBox()
    await page.mouse.click(caja.x + caja.width - 10, caja.y + 8)
    let nombre = null
    for (let n = 0; n < 30 && nombre !== espera; n++) {
      await page.waitForTimeout(150)
      const f = page.frames().find((x) => x.url().includes('field-modal.html'))
      nombre = f ? new URL(f.url()).searchParams.get('name') : null
    }
    ok(nombre === espera, `el marcador de «${espera}» abre su modal: ${JSON.stringify(nombre)}`)
    await page.mouse.click(10, 10)   // fuera: se cierra
    await page.waitForTimeout(300)
  }
} finally {
  await ctx.close()
  await rm(perfil, { recursive: true, force: true })
}
console.log(fallos.length ? `\n${fallos.length} FALLO(S)` : '\nTODO BIEN')
process.exit(fallos.length ? 1 : 0)
