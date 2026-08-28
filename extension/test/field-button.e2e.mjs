// LA TABLA DEL BOTÓN, en un Chrome de verdad (DISENO §4.1).
//
// El semicírculo es por campo, y cuándo sale no es una impresión: es una tabla que el
// dueño fijó el 2026-08-28. Esta prueba la recorre fila por fila contra la bóveda propia
// de la extensión, que es la que puede responder exacto.
//
//   npm run test:web &
//   npm run test:field-button
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright')

const EXT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SITE = process.env.SITE || 'http://localhost:8099'
const perfil = await mkdtemp(join(tmpdir(), 'pm-campo-'))
const ctx = await chromium.launchPersistentContext(perfil, {
  headless: false,
  args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
  viewport: { width: 720, height: 700 },
})
const fallos = []
const ok = (c, m) => { console.log((c ? '  ok    ' : '  FALLA ') + m); if (!c) fallos.push(m) }

const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 })
const id = new URL(sw.url()).host
const ext = await ctx.newPage()
await ext.goto(`chrome-extension://${id}/src/popup.html`)
const pedir = (op, payload) => ext.evaluate(([op, payload]) => new Promise((r) =>
  chrome.runtime.sendMessage({ op, payload }, r)), [op, payload])

const page = await ctx.newPage()
page.on('pageerror', (e) => console.log('   [error de página]', e.message))

/** Lo que el gestor ofrece en unos campos, preguntado como lo hace la página. */
const que = async (campos) => (await pedir('offers', { url: page.url(), fields: campos }))?.result || []

/** El aviso de guardar, ya pintado. */
async function aviso () {
  for (let i = 0; i < 40; i++) {
    const f = page.frames().find((x) => x.url().includes('save-prompt.html'))
    if (f) { await f.locator('[data-testid=save-prompt-field]').first().waitFor({ timeout: 8000 }); return f }
    await page.waitForTimeout(250)
  }
  return null
}

try {
  console.log('\nla tabla, con la bóveda vacía')
  await page.goto(`${SITE}/login.html`)
  await page.waitForTimeout(1000)
  let r = await que([{ id: 0, key: 'login', value: '', username: '', secret: '' }])
  ok(!r[0].fill && !r[0].save, 'fila 1 · vacío y sin nada guardado → sin botón')

  await page.fill('input[name=user]', 'a')
  await page.waitForTimeout(600)
  r = await que([{ id: 0, key: 'login', value: 'a', username: 'a', secret: '' }])
  ok(!r[0].fill && r[0].save, 'fila 2 · UNA letra y sin nada guardado → guardar')

  // Se guarda una credencial para poder mirar las filas de abajo.
  await page.fill('input[name=user]', 'ana@ejemplo.com')
  await page.fill('input[name=password]', 'clave-buena')
  await Promise.all([page.waitForURL(/inside/), page.click('button[type=submit]')])
  let f = await aviso()
  if (f) { await f.locator('[data-testid=save-prompt-save]').click(); await page.waitForTimeout(1200) }

  console.log('\nla tabla, con una credencial guardada')
  await page.goto(`${SITE}/login.html`)
  await page.waitForTimeout(1200)
  r = await que([{ id: 0, key: 'login', value: '', username: '', secret: '' }])
  ok(r[0].fill && !r[0].save, 'fila 5 · vacío con algo guardado → rellenar')
  ok(r[0].ids.length === 1, 'y dice de qué entrada sale')

  r = await que([{ id: 0, key: 'login', value: 'clave-buena', username: 'ana@ejemplo.com', secret: 'clave-buena' }])
  ok(!r[0].fill && !r[0].save, 'fila 6 · escrito IGUAL a lo guardado → sin botón')

  r = await que([{ id: 0, key: 'login', value: 'otra', username: 'ana@ejemplo.com', secret: 'otra' }])
  ok(!r[0].fill && r[0].save, 'fila 7 · escrito distinto → guardar')

  console.log('\nun campo que ninguna entrada tiene')
  await page.goto(`${SITE}/profile.html`)
  await page.waitForTimeout(1200)
  r = await que([
    { id: 0, key: 'email', value: '' },
    { id: 1, key: 'label:Número de socio', value: '' },
  ])
  ok(!r[0].fill && !r[0].save, 'fila 3 · hay entradas, pero ninguna tiene el correo → sin botón')
  ok(!r[1].fill, 'ni el campo libre, que tampoco lo tiene nadie')
  r = await que([{ id: 0, key: 'email', value: 'ana@datos.com' }])
  ok(r[0].save && !r[0].fill, 'fila 4 · escrito y ninguna lo tiene → guardar')

  console.log('\nrellenar todos los valores')
  for (const [n, v] of Object.entries({
    'given-name': 'Ana', 'family-name': 'Ruiz', email: 'ana@datos.com',
    tel: '0999111222', 'street-address': 'Calle 1 y Av. 2', member: 'SOC-4471',
  })) await page.fill(`input[name="${n}"]`, v)
  await Promise.all([page.waitForURL(/inside/), page.click('button[type=submit]')])
  f = await aviso()
  ok(!!f, 'el aviso sale con los datos')
  if (f) {
    // Los campos libres llegan sin marcar: se marcan a mano.
    for (const c of await f.locator('[data-testid=save-prompt-field] input[type=checkbox]').all()) await c.check()
    await page.waitForTimeout(300)
    await f.locator('[data-testid=save-prompt-save]').click()
    await page.waitForTimeout(1500)
  }

  await page.goto(`${SITE}/profile.html`)
  await page.waitForTimeout(1500)
  // El marcador del correo: esquina superior derecha de su casilla. Se pulsa por
  // coordenadas porque vive en un shadow root CERRADO, que es justo lo que se quiere.
  const caja = await page.locator('input[name=email]').boundingBox()
  await page.mouse.click(caja.x + caja.width - 10, caja.y + 8)
  await page.waitForTimeout(700)
  // Y en el modal, el botón de rellenarlo todo: va debajo de la lista, antes de «Cerrar».
  await page.mouse.click(360, 396)
  await page.waitForTimeout(1200)
  const puesto = await page.evaluate(() =>
    Object.fromEntries([...document.querySelectorAll('input')].map(i => [i.name, i.value])))
  ok(puesto.email === 'ana@datos.com', 'rellena el campo que se pulsó')
  ok(puesto.tel === '0999111222' && puesto['given-name'] === 'Ana', 'y todos los demás')
  ok(puesto.member === 'SOC-4471', 'incluido el que el gestor no reconoce')
  ok(puesto.city === '', 'y no se inventa el que no estaba guardado')

  // Y con todo puesto, ya no queda nada que ofrecer: es la fila 6.
  r = await que([{ id: 0, key: 'email', value: 'ana@datos.com' }])
  ok(!r[0].fill && !r[0].save, 'después de rellenar, el botón desaparece')
} finally {
  await ctx.close()
  await rm(perfil, { recursive: true, force: true })
}
console.log(fallos.length ? `\n${fallos.length} FALLO(S)` : '\nTODO BIEN')
process.exit(fallos.length ? 1 : 0)
