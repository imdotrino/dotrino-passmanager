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
    // Pintado = ya sabe de qué entrada habla y ha dibujado sus secciones.
    if (f) { await f.locator('body[data-ready]').waitFor({ timeout: 8000 }); return f }
    await page.waitForTimeout(200)
  }
  return null
}

/**
 * ABRIR una entrada desde la pantalla de la extensión, diciendo que sí.
 *
 * La bóveda pide autorización antes de soltar nada (DISENO §3.3.2) y la pregunta se
 * dibuja donde el usuario está mirando: hay que traer la pantalla de la extensión al
 * frente para que le toque a ella y no se abra la ventana suelta.
 */
async function abrir (entryId) {
  await ext.bringToFront()
  await ext.waitForTimeout(250)
  const p = pedir('get', { id: entryId })
  try { await ext.locator('[data-testid=approval-yes]').click({ timeout: 10000 }) } catch (_) {}
  const r = await p
  await page.bringToFront()
  await page.waitForTimeout(150)
  return r
}

/**
 * DECIR QUE SÍ. La bóveda de la extensión pide autorización antes de soltar nada
 * (DISENO §3.3.1), y la pregunta se dibuja en la misma pantalla que la pidió. Sin esto,
 * rellenar y reemplazar se quedan a medias — que es exactamente lo que tiene que pasar.
 */
async function autorizar (f, ms = 6000) {
  const si = f.locator('[data-testid=approval-yes]')
  try { await si.waitFor({ state: 'visible', timeout: ms }) } catch (_) { return false }
  await si.click()
  await f.page().waitForTimeout(400)
  return true
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
    // El buscador viene recogido, pero su lupa está: es como se trae la cuenta de otro
    // dominio cuando cambia el subdominio.
    ok(!(await m0.locator('[data-testid=field-modal-search]').isVisible()), 'el buscador, recogido')
    ok(await m0.locator('[data-testid=field-modal-search-toggle]').isVisible(), 'y su lupa, a la vista')
    await page.mouse.click(200, 120)     // fuera: así se cierra
    await page.waitForTimeout(400)
    ok(!page.frames().find((x) => x.url().includes('field-modal.html')), 'y se cierra al pulsar fuera')
  }
  await page.fill('input[name=user]', '')
  await page.waitForTimeout(600)
  let r = await que([{ id: 0, key: 'username', value: '', username: '', secret: '' }])
  ok(!r[0].fill && !r[0].save, 'fila 1 · vacío y sin nada guardado → sin botón')

  await page.fill('input[name=user]', 'a')
  await page.waitForTimeout(600)
  r = await que([{ id: 0, key: 'username', value: 'a', username: 'a', secret: '' }])
  ok(!r[0].fill && r[0].save, 'fila 2 · UNA letra y sin nada guardado → guardar')

  // Se guarda una credencial para poder mirar las filas de abajo.
  await page.fill('input[name=user]', 'ana@ejemplo.com')
  await page.fill('input[name=password]', 'clave-buena')
  await Promise.all([page.waitForURL(/inside/), page.click('button[type=submit]')])
  let f = await aviso()
  if (f) {
    await f.locator('[data-testid=save-prompt-save]').click()
    await page.waitForTimeout(1200)
  }

  console.log('\nla tabla, con una credencial guardada')
  await page.goto(`${SITE}/login.html`)
  await page.waitForTimeout(1200)
  r = await que([{ id: 0, key: 'username', value: '', username: '', secret: '' }])
  ok(r[0].fill && !r[0].save, 'fila 5 · vacío con algo guardado → rellenar')
  ok(r[0].ids.length === 1, 'y dice de qué entrada sale')

  // El marcador NO mira lo guardado (dueño, 2026-08-29): con algo escrito hay botón,
  // valga lo mismo o no, porque otra entrada puede querer ese dato y no tenerlo.
  r = await que([{ id: 0, key: 'username', value: 'ana@ejemplo.com', username: 'ana@ejemplo.com', secret: 'clave-buena' }])
  ok(!r[0].fill && r[0].save, 'escrito igual a lo guardado → sigue habiendo botón')
  r = await que([{ id: 0, key: 'secret', value: 'clave-buena', username: 'ana@ejemplo.com', secret: 'clave-buena' }])
  ok(!r[0].fill && r[0].save, 'y en la contraseña, igual')

  r = await que([{ id: 0, key: 'username', value: 'ana@ejemplo.com', username: 'ana@ejemplo.com', secret: 'otra' }])
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
  ok(await m.locator('[data-testid=field-modal-target]').count() >= 1, 'con la entrada que la puede rellenar')
  const filas = m.locator('[data-testid=field-modal-fill-row]')
  ok(await filas.count() >= 2, 'y la lista de lo que puede rellenar (' + (await filas.count()) + ')')
  ok(await m.locator('[data-testid=field-modal-check-email]').isChecked(), 'con las casillas marcadas')
  await m.locator('[data-testid=field-modal-fill-all]').click()
  // Son datos PÚBLICOS: no se pide permiso para escribir tu nombre en el formulario donde
  // lo acabas de teclear (dueño, 2026-08-29). Lo privado sí — ver `reemplazos.e2e.mjs`.
  ok(!(await autorizar(m, 2000)), 'rellenar datos públicos no pide autorización')
  await page.waitForTimeout(1200)
  const puesto = await page.evaluate(() =>
    Object.fromEntries([...document.querySelectorAll('input')].map(i => [i.name, i.value])))
  ok(puesto.email === 'ana@datos.com', 'rellena el campo que se pulsó')
  ok(puesto.tel === '0999111222' && puesto['given-name'] === 'Ana', 'y todos los demás')
  ok(puesto.member === 'SOC-4471', 'incluido el que el gestor no reconoce')
  ok(puesto.city === '', 'y no se inventa el que no estaba guardado')

  // Con el campo lleno ya no se ofrece RELLENAR —hay algo escrito—, pero sí guardar: el
  // marcador solo se esconde con el campo vacío y sin nada guardado suyo.
  r = await que([{ id: 0, key: 'email', value: 'ana@datos.com' }])
  ok(!r[0].fill && r[0].save, 'después de rellenar ya no se ofrece rellenar, pero sí guardar')
  r = await que([{ id: 0, key: 'label:Nada de nada', value: '' }])
  ok(!r[0].fill && !r[0].save, 'y el botón se esconde solo si está vacío y no hay nada suyo')

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
    const destinos = m2.locator('[data-testid=field-modal-target]')
    ok(await destinos.count() >= 2, 'con la lista de a dónde va (' + (await destinos.count()) + ')')
    ok((await destinos.last().textContent()).match(/nueva|new/i),
      'y la entrada nueva es la última: ' + (await destinos.last().textContent()))
    ok(!(await m2.locator('#saveBox').isHidden()), 'con su sección de guardar')
    const fila = m2.locator('[data-testid=field-modal-save-row][data-field=city]')
    const nombre = await fila.locator('.name').textContent()
    ok(nombre === 'City' || nombre === 'Ciudad', 'con la etiqueta con la que se guardará: ' + nombre)
    // La lupa está siempre, aunque el buscador esté recogido.
    const lupa = m2.locator('[data-testid=field-modal-search-toggle]')
    ok(await lupa.isVisible(), 'la lupa está siempre a mano')
    const antes = await m2.locator('[data-testid=field-modal-search]').isVisible()
    await lupa.click()
    await page.waitForTimeout(300)
    ok(await m2.locator('[data-testid=field-modal-search]').isVisible() !== antes,
      'y al pulsarla se abre o se recoge')
    await lupa.click()
    await page.waitForTimeout(300)

    const boton = await m2.locator('[data-testid=field-modal-save-city]').textContent()
    ok(/guardar|save/i.test(boton), 'y su botón dice guardar, que es un dato nuevo: ' + boton)
    const abajo = await m2.locator('[data-testid=field-modal-save]').textContent()
    ok(/todos|all/i.test(abajo), 'y el de abajo, todos: ' + abajo)
    await m2.locator('[data-testid=field-modal-private-city]').check()
    await m2.locator('[data-testid=field-modal-save-city]').click()
    // Guardar NO pide autorización: la bóveda fusiona sobre lo suyo (`patch`) y no sale
    // ni un valor. Lo comprueba de cerca `reemplazos.e2e.mjs`.
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
    await mn.locator('[data-testid=field-modal-target-new]').check()
    await page.waitForTimeout(300)
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
  ok(r[0].ids.length >= 2, 'y el modal ofrece las dos entradas (' + r[0].ids.length + ')')

  // Y EN EL MODAL, entrada por entrada: con «Quito» escrito, la que ya tiene Quito no
  // ofrece nada que guardar y la que tiene Cuenca ofrece reemplazar. Es lo que el dueño
  // vio mal el 2026-08-29 —salía «replace» en las dos—, y lo que arreglan los resúmenes.
  await page.fill('input[name=city]', 'Quito')
  await page.waitForTimeout(900)
  const cajaCity4 = await page.locator('input[name=city]').boundingBox()
  await page.mouse.click(cajaCity4.x + cajaCity4.width - 10, cajaCity4.y + 8)
  const mi = await modal()
  ok(!!mi, 'el modal sale con «Quito» escrito')
  if (mi) {
    const opciones = mi.locator('[data-testid=field-modal-target]')
    const n = await opciones.count()
    const vistos = []
    for (let i = 0; i < n; i++) {
      const id = await opciones.nth(i).getAttribute('data-id')
      if (!id) continue
      await mi.locator(`[data-testid=field-modal-target-${id}]`).check()
      await page.waitForTimeout(350)
      const fila = mi.locator('[data-testid=field-modal-save-row][data-field=city]')
      vistos.push(await fila.count() ? 'ofrece' : 'nada')
    }
    ok(vistos.includes('nada'), 'en la entrada que ya tiene «Quito» no ofrece guardar nada')
    ok(vistos.includes('ofrece'), 'y en la otra sí, porque ahí sí cambia')
    // Que es justo lo que el marcador ya no intenta decidir: el botón está para que se
    // pueda abrir esto y ver dónde cambia algo.
    await page.mouse.click(200, 120)
    await page.waitForTimeout(400)
  }

  await page.fill('input[name=city]', '')
  await page.waitForTimeout(500)

  console.log('\ncon muchas entradas: la lista se desplaza')
  // Se guardan unas cuantas más para pasar de cinco.
  for (const n of [1, 2, 3, 4, 5]) {
    await page.goto(`${SITE}/login.html`)
    await page.waitForTimeout(500)
    await page.fill('input[name=user]', `cuenta${n}@ejemplo.com`)
    await page.fill('input[name=password]', `clave-${n}`)
    await Promise.all([page.waitForURL(/inside/), page.click('button[type=submit]')])
    const p2 = await aviso()
    if (p2) {
      const nueva = p2.locator('[data-testid=save-prompt-target-new]')
      if (await nueva.count()) { await nueva.check(); await page.waitForTimeout(300) }
      await p2.locator('[data-testid=save-prompt-save]').click()
      await page.waitForTimeout(1000)
    }
  }
  await page.goto(`${SITE}/login.html`)
  await page.waitForTimeout(1400)
  const cajaU = await page.locator('input[name=user]').boundingBox()
  await page.mouse.click(cajaU.x + cajaU.width - 10, cajaU.y + 8)
  const mm = await modal()
  if (mm) {
    const filas = mm.locator('[data-testid=field-modal-target]')
    ok(await filas.count() > 5, 'salen todas (' + (await filas.count()) + ')')
    ok(await mm.locator('#targets').evaluate(el => el.scrollHeight > el.clientHeight),
      'y la lista se desplaza en vez de crecer sin fin')
    ok(!(await mm.locator('[data-testid=field-modal-search]').isVisible()),
      'y el buscador viene recogido')
    // Usuario y contraseña son DOS filas, cada una con su nombre y su botón.
    const nombres = await mm.locator('[data-testid=field-modal-fill-row] .name').allTextContents()
    ok(nombres.some(n => /usuario|username/i.test(n)), 'sale la fila del usuario: ' + nombres.join(' / '))
    ok(nombres.some(n => /contraseña|password/i.test(n)), 'y la de la contraseña, aparte')
    // Y cada una rellena lo suyo.
    await mm.locator('[data-testid=field-modal-fill-secret]').click()
    ok(await autorizar(mm), 'y la contraseña sí pide autorización, siempre')
    await page.waitForTimeout(900)
    const soloClave = await page.evaluate(() =>
      Object.fromEntries([...document.querySelectorAll('input')].map(i => [i.name, i.value])))
    ok(!!soloClave.password && !soloClave.user, 'la de contraseña rellena SOLO la contraseña')
  }

  console.log('\nbuscar la cuenta de OTRO dominio (el subdominio que cambió)')
  // 127.0.0.1 es otro sitio que localhost, aunque sirvan lo mismo: sirve de subdominio
  // nuevo sin montar otro servidor.
  const OTRO = SITE.replace('localhost', '127.0.0.1')
  await page.goto(`${OTRO}/login.html`)
  await page.waitForTimeout(1200)
  r = await que([{ id: 0, key: 'username', value: '', username: '', secret: '' }])
  ok(!r[0].fill, 'ahí no hay nada guardado: no ofrece rellenar')
  await page.fill('input[name=user]', 'x')
  await page.waitForTimeout(800)
  const cajaOtro = await page.locator('input[name=user]').boundingBox()
  await page.mouse.click(cajaOtro.x + cajaOtro.width - 10, cajaOtro.y + 8)
  const mo = await modal()
  ok(!!mo, 'el modal sale')
  if (mo) {
    await mo.locator('[data-testid=field-modal-search-toggle]').click()
    await page.waitForTimeout(300)
    ok(await mo.locator('[data-testid=field-modal-search]').isVisible(), 'la lupa abre el buscador')
    await mo.locator('[data-testid=field-modal-search]').fill('ana@ejemplo.com')
    await page.waitForTimeout(900)
    const traidos = mo.locator('[data-testid=field-modal-target]')
    ok(await traidos.count() >= 2, 'y encuentra la cuenta del otro dominio')
    // La primera es la encontrada; se elige y se rellena desde ella.
    const idTraido = await traidos.first().getAttribute('data-id')
    await mo.locator(`[data-testid=field-modal-target-${idTraido}]`).check()
    await page.waitForTimeout(400)
    ok(await mo.locator('[data-testid=field-modal-fill-row]').count() >= 1,
      'ofrece rellenar con ella aunque sea de otro sitio')
    await mo.locator('[data-testid=field-modal-fill-all]').click()
    await autorizar(mo)   // lleva la contraseña dentro: eso sí se autoriza
    await page.waitForTimeout(1200)
  }
  const puesto2 = await page.evaluate(() =>
    Object.fromEntries([...document.querySelectorAll('input')].map(i => [i.name, i.value])))
  ok(puesto2.user === 'ana@ejemplo.com' && !!puesto2.password,
    'y la credencial de otro dominio entra: ' + puesto2.user)

  console.log('\ny se cierra al pulsar fuera')
  await page.goto(`${SITE}/profile.html`)
  await page.waitForTimeout(1000)
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
    const abierta = (await abrir(g.id))?.result
    const c = JSON.parse(abierta?.fields || '[]').find((x) => x.kind === 'city')
    if (c) ciudades.push(c)
  }
  ok(ciudades.some((c) => c.value === 'Quito'), 'el campo queda guardado')
  ok(ciudades.find((c) => c.value === 'Quito')?.private === true, 'y marcado como privado')

  // La pregunta cuando NO hay ninguna pantalla de la extensión delante (un sitio pidiendo
  // una passkey) sale en una ventana propia, y eso **no se puede simular aquí**: en
  // `--headless=new` todas las pestañas dicen `visible` y `hasFocus` a la vez, así que la
  // pregunta siempre encuentra a esta página de la extensión y la ventana no llega a
  // abrirse. Comprobado a mano que `chrome.windows.create` abre `src/approve.html`; lo
  // que esa ventana dibuja y cómo contesta es el MISMO módulo que aloja el popup y los
  // modales, y eso sí lo cubre `abrir()` en todo este archivo. Sin cubrir quedan dos
  // líneas suyas: anunciarse como ventana y cerrarse al contestar.

} finally {
  await ctx.close()
  await rm(perfil, { recursive: true, force: true })
}
console.log(fallos.length ? `\n${fallos.length} FALLO(S)` : '\nTODO BIEN')
process.exit(fallos.length ? 1 : 0)
