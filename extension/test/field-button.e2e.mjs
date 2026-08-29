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

/** El modal de un campo, ya pintado. */
async function modal () {
  for (let i = 0; i < 40; i++) {
    const f = page.frames().find((x) => x.url().includes('field-modal.html'))
    // Pintado = ya sabe de qué entrada habla. No hay botón de cerrar por el que esperar.
    if (f) { await f.locator('#recName').filter({ hasNotText: /^$/ }).waitFor({ timeout: 8000 }); return f }
    await page.waitForTimeout(200)
  }
  return null
}

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
  // Sin nada guardado, el modal de un campo escrito no tiene entre qué elegir.
  await page.fill('input[name=user]', 'ana@ejemplo.com')
  await page.waitForTimeout(800)
  const cajaUser = await page.locator('input[name=user]').boundingBox()
  await page.mouse.click(cajaUser.x + cajaUser.width - 10, cajaUser.y + 8)
  const m0 = await modal()
  ok(!!m0, 'el modal sale con solo el usuario escrito')
  if (m0) {
    ok((await m0.locator('#recName').textContent()).match(/nueva|new/i), 'y dice «una entrada nueva»')
    ok(!(await m0.locator('[data-testid=field-modal-next]').isVisible()), 'sin flechas: no hay a dónde ir')
    await page.mouse.click(200, 120)     // fuera: así se cierra
    await page.waitForTimeout(400)
    ok(!page.frames().find((x) => x.url().includes('field-modal.html')), 'y se cierra al pulsar fuera')
  }
  await page.fill('input[name=user]', '')
  await page.waitForTimeout(600)
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

  // El modal SÍ es alcanzable: es un iframe de la extensión, como el aviso.
  const m = await modal()
  ok(!!m, 'el modal del campo sale al pulsar el marcador')
  ok((await m.locator('#recName').textContent()) !== '', 'con una entrada en la cabecera')
  const filas = m.locator('[data-testid=field-modal-fill-row]')
  ok(await filas.count() >= 2, 'y la lista de lo que puede rellenar (' + (await filas.count()) + ')')
  ok(await m.locator('[data-testid=field-modal-check-email]').isChecked(), 'con las casillas marcadas')
  await m.locator('[data-testid=field-modal-fill-all]').click()
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

  console.log('\nguardar un campo desde su modal, y marcarlo privado')
  await page.goto(`${SITE}/profile.html`)
  await page.waitForTimeout(1200)
  await page.fill('input[name=city]', 'Quito')
  await page.waitForTimeout(800)
  const cajaCity = await page.locator('input[name=city]').boundingBox()
  await page.mouse.click(cajaCity.x + cajaCity.width - 10, cajaCity.y + 8)
  const m2 = await modal()
  ok(!!m2, 'el modal sale en un campo con algo escrito')
  if (m2) {
    // Hay una entrada de datos del sitio, así que la nueva es la ÚLTIMA de la cabecera y
    // las flechas están a la vista.
    ok(await m2.locator('[data-testid=field-modal-next]').isVisible(), 'con flechas, que hay más de una')
    // Hasta el final de la lista: la entrada nueva es la última, nunca la primera.
    const next = m2.locator('[data-testid=field-modal-next]')
    for (let i = 0; i < 8 && !(await next.isDisabled()); i++) await next.click()
    ok((await m2.locator('#recName').textContent()).match(/nueva|new/i),
      'y la entrada nueva es la última: ' + (await m2.locator('#recName').textContent()))
    const prev = m2.locator('[data-testid=field-modal-prev]')
    for (let i = 0; i < 8 && !(await prev.isDisabled()); i++) await prev.click()
    ok(!(await m2.locator('#saveBox').isHidden()), 'con su sección de guardar')
    const fila = m2.locator('[data-testid=field-modal-save-row][data-field=city]')
    const nombre = await fila.locator('.name').textContent()
    ok(nombre === 'City' || nombre === 'Ciudad', 'con la etiqueta con la que se guardará: ' + nombre)
    const boton = await m2.locator('[data-testid=field-modal-save-city]').textContent()
    ok(/guardar|save/i.test(boton), 'y su botón dice guardar, que es un dato nuevo: ' + boton)
    const abajo = await m2.locator('[data-testid=field-modal-save]').textContent()
    ok(/todos|all/i.test(abajo), 'y el de abajo, todos: ' + abajo)
    await m2.locator('[data-testid=field-modal-private-city]').check()
    await m2.locator('[data-testid=field-modal-save-city]').click()
    await page.waitForTimeout(1500)
  }
  console.log('\ny cuando ya existe, el botón dice reemplazar')
  await page.goto(`${SITE}/profile.html`)
  await page.waitForTimeout(1200)
  await page.fill('input[name=city]', 'Cuenca')
  await page.waitForTimeout(800)
  const cajaCity2 = await page.locator('input[name=city]').boundingBox()
  await page.mouse.click(cajaCity2.x + cajaCity2.width - 10, cajaCity2.y + 8)
  const mr = await modal()
  if (mr) {
    const b = await mr.locator('[data-testid=field-modal-save-city]').textContent()
    ok(/reemplazar|replace/i.test(b), 'la fila dice reemplazar: ' + b)
    const ba = await mr.locator('[data-testid=field-modal-save]').textContent()
    ok(/reemplazar|replace/i.test(ba), 'y el de abajo también: ' + ba)
    await page.mouse.click(200, 120)
    await page.waitForTimeout(400)
  }
  await page.fill('input[name=city]', '')
  await page.waitForTimeout(500)

  console.log('\ncon dos entradas, coincidir con una no apaga el botón')
  // Se guarda la ciudad en una entrada NUEVA, para tener dos con ese campo distinto.
  await page.goto(`${SITE}/profile.html`)
  await page.waitForTimeout(1200)
  await page.fill('input[name=city]', 'Cuenca')
  await page.waitForTimeout(800)
  const cajaCity3 = await page.locator('input[name=city]').boundingBox()
  await page.mouse.click(cajaCity3.x + cajaCity3.width - 10, cajaCity3.y + 8)
  const mn = await modal()
  if (mn) {
    const next2 = mn.locator('[data-testid=field-modal-next]')
    for (let i = 0; i < 8 && !(await next2.isDisabled()); i++) await next2.click()
    await mn.locator('[data-testid=field-modal-save-city]').click()
    await page.waitForTimeout(1500)
    await page.mouse.click(200, 120)
    await page.waitForTimeout(400)
  }
  // Ahora una entrada tiene «Quito» y otra «Cuenca». Escribir cualquiera de las dos deja
  // algo que hacer con la otra, así que el botón se queda.
  r = await que([{ id: 0, key: 'city', value: 'Quito' }])
  ok(r[0].save, 'con «Quito» sigue habiendo qué hacer (reemplazar el de la otra)')
  r = await que([{ id: 0, key: 'city', value: 'Cuenca' }])
  ok(r[0].save, 'y con «Cuenca», lo mismo')
  await page.fill('input[name=city]', '')
  await page.waitForTimeout(500)

  console.log('\ny se cierra al pulsar fuera')
  await page.fill('input[name=member]', 'SOC-1')
  await page.waitForTimeout(700)
  const cajaSocio = await page.locator('input[name=member]').boundingBox()
  await page.mouse.click(cajaSocio.x + cajaSocio.width - 10, cajaSocio.y + 8)
  const m3 = await modal()
  ok(!!m3, 'el modal está abierto')
  const suNombre = await m3.locator('[data-testid=field-modal-save-row][data-field="label:Número de socio"] .name').textContent()
  ok(suNombre === 'Número de socio', 'y dice la etiqueta con la que se va a guardar: ' + suNombre)
  await page.mouse.click(200, 120)   // en cualquier sitio de la página
  await page.waitForTimeout(500)
  ok(!page.frames().find((x) => x.url().includes('field-modal.html')), 'y se cierra al pulsar fuera')

  // Hay varias entradas de datos a estas alturas: se busca la ciudad en todas.
  const guardadas = ((await pedir('find', { url: `${SITE}/profile.html` }))?.result || [])
    .filter((e) => e.type === 'data')
  const ciudades = []
  for (const g of guardadas) {
    const abierta = (await pedir('get', { id: g.id }))?.result
    const c = JSON.parse(abierta?.fields || '[]').find((x) => x.kind === 'city')
    if (c) ciudades.push(c)
  }
  ok(ciudades.some((c) => c.value === 'Quito'), 'el campo queda guardado')
  ok(ciudades.find((c) => c.value === 'Quito')?.private === true, 'y marcado como privado')
} finally {
  await ctx.close()
  await rm(perfil, { recursive: true, force: true })
}
console.log(fallos.length ? `\n${fallos.length} FALLO(S)` : '\nTODO BIEN')
process.exit(fallos.length ? 1 : 0)
