// REEMPLAZAR DATOS SIN PERDER NADA, y pedir permiso solo cuando toca.
//
// Nace de lo que el dueño vio el 2026-08-29: reemplazó «Nombre» —un dato público— en una
// entrada que tenía además un dato privado, y pasaron dos cosas que no debían: le pidió
// autorización, y la entrada quedó a medias.
//
// Las dos tenían la misma causa. Guardar era leer la entrada ENTERA, fusionar en la
// extensión y volver a escribirla: leerla entera obligaba a autorizar —dentro iba una
// contraseña— y, si esa lectura fallaba, el `put` de detrás escribía lo poco que había.
// Ahora guardar es un `patch`: la bóveda fusiona sobre lo suyo y no sale ni un valor.
//
// Lo que se comprueba aquí, en un Chrome de verdad:
//
//   1. reemplazar un dato público NO pide autorización
//   2. y no pierde nada: ni la contraseña, ni los otros campos, ni la marca de privado
//   3. rellenar un dato público tampoco pide autorización
//   4. rellenar un dato PRIVADO sí la pide, y sin el sí no se rellena
//   5. reemplazar diez veces no duplica campos ni deja basura
//
//   npm run test:web &
//   npm run test:reemplazos
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright')

const EXT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SITE = process.env.SITE || 'http://localhost:8099'
const perfil = await mkdtemp(join(tmpdir(), 'pm-reemplazo-'))
const ctx = await chromium.launchPersistentContext(perfil, {
  headless: false,
  args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
  viewport: { width: 720, height: 760 },
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

/** Abrir una entrada ENTERA desde la pantalla de la extensión, diciendo que sí. */
async function abrir (entryId) {
  await ext.bringToFront()
  await ext.waitForTimeout(250)
  const p = pedir('get', { id: entryId })
  try { await ext.locator('[data-testid=approval-yes]').click({ timeout: 10000 }) } catch (_) {}
  const r = await p
  await page.bringToFront()
  await page.waitForTimeout(150)
  return r?.result || null
}

const modal = async () => {
  for (let i = 0; i < 40; i++) {
    const f = page.frames().find((x) => x.url().includes('field-modal.html'))
    if (f) { await f.locator('body[data-ready]').waitFor({ timeout: 8000 }); return f }
    await page.waitForTimeout(200)
  }
  return null
}
const aviso = async () => {
  for (let i = 0; i < 40; i++) {
    const f = page.frames().find((x) => x.url().includes('save-prompt.html'))
    if (f) { await f.locator('[data-testid=save-prompt-field]').first().waitFor({ timeout: 8000 }); return f }
    await page.waitForTimeout(250)
  }
  return null
}

/** ¿Salió la pregunta de la bóveda en esta pantalla? Sin contestarla. */
const preguntó = async (f, ms = 2500) => {
  try {
    await f.locator('[data-testid=approval]').waitFor({ state: 'visible', timeout: ms })
    return true
  } catch (_) { return false }
}
const decir = async (f, si) => {
  await f.locator(`[data-testid=approval-${si ? 'yes' : 'no'}]`).click({ timeout: 5000 })
  await page.waitForTimeout(500)
}

/** El marcador de un campo: se pulsa por coordenadas (vive en un shadow root cerrado). */
async function pulsar (name) {
  const caja = await page.locator(`input[name=${name}]`).boundingBox()
  await page.mouse.click(caja.x + caja.width - 10, caja.y + 8)
}

const campos = (open) => { try { return JSON.parse(open?.fields || '[]') } catch { return [] } }
const campo = (open, label) => campos(open).find((f) => f.label === label)

try {
  // --- 1. una entrada de datos con un campo PRIVADO dentro --------------------
  console.log('\nse guarda una entrada de datos, con un campo privado')
  await page.goto(`${SITE}/profile.html`)
  await page.waitForTimeout(1000)
  for (const [n, v] of Object.entries({
    'given-name': 'Ana', 'family-name': 'Ruiz', email: 'ana@datos.com',
    tel: '0999111222', 'street-address': 'Calle 1 y Av. 2', city: 'Quito', member: 'SOC-4471',
  })) await page.fill(`input[name="${n}"]`, v)
  await Promise.all([page.waitForURL(/inside/), page.click('button[type=submit]')])

  let f = await aviso()
  ok(!!f, 'sale el aviso de guardar')
  if (f) {
    for (const c of await f.locator('[data-testid=save-prompt-field] input[type=checkbox]').all()) await c.check()
    await page.waitForTimeout(300)
    await f.locator('[data-testid=save-prompt-save]').click()
    ok(!(await preguntó(f)), 'guardar una entrada NUEVA no pide autorización')
    await page.waitForTimeout(1400)
  }

  let lista = (await pedir('find', { url: `${SITE}/profile.html` }))?.result || []
  const datos = lista.find((e) => e.type === 'data')
  ok(!!datos, 'la entrada de datos quedó guardada')
  const entryId = datos?.id

  // El número de socio se marca privado desde el modal de su campo.
  console.log('\nse marca «Número de socio» como privado')
  await page.goto(`${SITE}/profile.html`)
  await page.waitForTimeout(1100)
  // Un valor DISTINTO del guardado: si fuera el mismo no habría nada que guardar y la
  // fila —con su casilla de privado— no saldría, que es justo lo que el modal decide bien.
  await page.fill('input[name=member]', 'SOC-9999')
  await page.waitForTimeout(700)
  await pulsar('member')
  let m = await modal()
  if (m) {
    await m.locator(`[data-testid=field-modal-target-${entryId}]`).check()
    await page.waitForTimeout(300)
    await m.locator('[data-testid="field-modal-private-label:Número de socio"]').check()
    await m.locator('[data-testid="field-modal-save-label:Número de socio"]').click()
    ok(!(await preguntó(m)), 'y marcarlo privado tampoco pide autorización')
    await page.waitForTimeout(1400)
    await page.mouse.click(200, 120)
    await page.waitForTimeout(400)
  }

  const antes = await abrir(entryId)
  ok(campo(antes, 'Número de socio')?.private === true, 'el campo queda marcado como privado')
  const cuantos = campos(antes).length
  ok(cuantos === 7, 'y la entrada tiene sus siete campos (' + cuantos + ')')

  // --- 2. reemplazar un dato PÚBLICO -----------------------------------------
  console.log('\nreemplazar «Nombre», que es público, en esa misma entrada')
  await page.goto(`${SITE}/profile.html`)
  await page.waitForTimeout(1100)
  await page.fill('input[name=given-name]', 'Ana María')
  await page.waitForTimeout(700)
  await pulsar('given-name')
  m = await modal()
  ok(!!m, 'sale el modal del campo')
  if (m) {
    await m.locator(`[data-testid=field-modal-target-${entryId}]`).check()
    await page.waitForTimeout(350)
    const boton = m.locator('[data-testid=field-modal-save-given-name]')
    ok(/reemplazar|replace/i.test(await boton.textContent()), 'y su botón dice reemplazar')
    await boton.click()
    ok(!(await preguntó(m)), 'REEMPLAZAR UN DATO PÚBLICO NO PIDE AUTORIZACIÓN')
    await page.waitForTimeout(1500)
    await page.mouse.click(200, 120)
    await page.waitForTimeout(400)
  }

  console.log('\ny la entrada queda entera')
  const tras = await abrir(entryId)
  ok(!!tras, 'la entrada sigue existiendo')
  ok(tras?.id === entryId, 'con el mismo id')
  ok(campo(tras, 'Nombre')?.value === 'Ana María', 'el nombre se reemplazó')
  ok(campos(tras).length === cuantos, 'sin perder ni sumar campos (' + campos(tras).length + ')')
  ok(campo(tras, 'Teléfono')?.value === '0999111222', 'el teléfono sigue ahí')
  ok(campo(tras, 'Correo')?.value === 'ana@datos.com', 'y el correo')
  ok(campo(tras, 'Número de socio')?.value === 'SOC-9999', 'y el número de socio')
  ok(campo(tras, 'Número de socio')?.private === true, 'que sigue siendo privado')
  ok(tras?.createdAt === antes?.createdAt, 'y la fecha de creación es la misma')
  ok((tras?.sites || []).join() === (antes?.sites || []).join(), 'y sus sitios')

  const sigue = ((await pedir('find', { url: `${SITE}/profile.html` }))?.result || [])
    .filter((e) => e.id === entryId)
  ok(sigue.length === 1, 'y la entrada NO desapareció de la lista del sitio')

  // --- 3. rellenar: lo público no pregunta, lo privado sí --------------------
  console.log('\nrellenar un dato PÚBLICO')
  await page.goto(`${SITE}/profile.html`)
  await page.waitForTimeout(1200)
  await pulsar('tel')
  m = await modal()
  ok(!!m, 'sale el modal en un campo vacío')
  if (m) {
    await m.locator(`[data-testid=field-modal-target-${entryId}]`).check()
    await page.waitForTimeout(350)
    await m.locator('[data-testid=field-modal-fill-tel]').click()
    ok(!(await preguntó(m)), 'rellenar un dato público NO pide autorización')
    await page.waitForTimeout(900)
    ok(await page.inputValue('input[name=tel]') === '0999111222', 'y el teléfono entra')
  }

  console.log('\ny en la lista se ve CON QUÉ se va a rellenar')
  await page.goto(`${SITE}/profile.html`)
  await page.waitForTimeout(1200)
  await pulsar('tel')
  m = await modal()
  if (m) {
    await m.locator(`[data-testid=field-modal-target-${entryId}]`).check()
    await page.waitForTimeout(700)
    const vTel = m.locator('[data-testid=field-modal-value-tel]')
    ok(await vTel.textContent() === '0999111222', 'el valor público sale al lado del nombre')
    // Lo privado NO se enseña: verlo sería sacarlo de la bóveda sin que nadie lo pidiera.
    const vSocio = m.locator('[data-testid="field-modal-value-label:Número de socio"]')
    if (await vSocio.count()) {
      const tapado = await vSocio.textContent()
      ok(/^•+$/.test(tapado), 'y el privado sale tapado: ' + tapado)
    }
    await page.mouse.click(200, 120)
    await page.waitForTimeout(400)
  }

  console.log('\nrellenar un dato PRIVADO')
  await page.goto(`${SITE}/profile.html`)
  await page.waitForTimeout(1200)
  await pulsar('member')
  m = await modal()
  if (m) {
    await m.locator(`[data-testid=field-modal-target-${entryId}]`).check()
    await page.waitForTimeout(350)
    await m.locator('[data-testid="field-modal-fill-label:Número de socio"]').click()
    ok(await preguntó(m, 6000), 'rellenar un dato PRIVADO sí la pide')
    await decir(m, false)
    ok(await page.inputValue('input[name=member]') === '', 'y con un «ahora no», no se rellena')

    await m.locator('[data-testid="field-modal-fill-label:Número de socio"]').click()
    ok(await preguntó(m, 6000), 'vuelve a preguntar: una negativa no se recuerda')
    await decir(m, true)
    await page.waitForTimeout(800)
    ok(await page.inputValue('input[name=member]') === 'SOC-9999', 'y con el sí, entra')
  }

  // --- 4. reemplazar muchas veces no acumula basura --------------------------
  console.log('\nreemplazar el mismo campo varias veces')
  for (const valor of ['Cuenca', 'Loja', 'Manta']) {
    await page.goto(`${SITE}/profile.html`)
    await page.waitForTimeout(1000)
    await page.fill('input[name=city]', valor)
    await page.waitForTimeout(700)
    await pulsar('city')
    const mm = await modal()
    if (!mm) continue
    await mm.locator(`[data-testid=field-modal-target-${entryId}]`).check()
    await page.waitForTimeout(300)
    await mm.locator('[data-testid=field-modal-save-city]').click()
    if (await preguntó(mm, 1200)) { ok(false, 'pidió autorización al reemplazar ' + valor); await decir(mm, true) }
    await page.waitForTimeout(1300)
    await page.mouse.click(200, 120)
    await page.waitForTimeout(300)
  }
  const final = await abrir(entryId)
  ok(campos(final).length === cuantos, 'sigue habiendo los mismos campos (' + campos(final).length + ')')
  ok(campos(final).filter((c) => c.label === 'Ciudad').length === 1, 'y la ciudad no se duplicó')
  ok(campo(final, 'Ciudad')?.value === 'Manta', 'con el último valor')
  ok(campo(final, 'Número de socio')?.private === true, 'y lo privado sigue marcado')

  // --- 5. y la credencial del sitio, que no toca nada de esto ----------------
  console.log('\nlas credenciales del mismo sitio quedan aparte y enteras')
  await page.goto(`${SITE}/login.html`)
  await page.waitForTimeout(900)
  await page.fill('input[name=user]', 'ana@ejemplo.com')
  await page.fill('input[name=password]', 'clave-buena')
  await Promise.all([page.waitForURL(/inside/), page.click('button[type=submit]')])
  f = await aviso()
  if (f) {
    const nueva = f.locator('[data-testid=save-prompt-target-new]')
    if (await nueva.count()) await nueva.check()
    await page.waitForTimeout(300)
    await f.locator('[data-testid=save-prompt-save]').click()
    ok(!(await preguntó(f)), 'guardar una credencial nueva tampoco pide autorización')
    await page.waitForTimeout(1400)
  }
  const conLogin = ((await pedir('find', { url: `${SITE}/inside.html` }))?.result || [])
    .filter((e) => e.type === 'login')
  ok(conLogin.length >= 1, 'la credencial se guardó aparte')
  const abierta = conLogin[0] ? await abrir(conLogin[0].id) : null
  ok(abierta?.secret === 'clave-buena', 'con su contraseña')
  const datosFinal = await abrir(entryId)
  ok(campos(datosFinal).length === cuantos, 'y la entrada de datos sigue intacta')
  // --- 5b. el nombre lo pone el usuario, y se confirma con el visto ------------
  console.log('\nponerle nombre a una entrada')
  await page.goto(`${SITE}/profile.html`)
  await page.waitForTimeout(1200)
  await pulsar('tel')
  m = await modal()
  ok(!!m, 'sale el modal')
  if (m) {
    await m.locator(`[data-testid=field-modal-target-${entryId}]`).check()
    await page.waitForTimeout(400)
    await m.locator(`[data-testid=field-modal-rename-${entryId}]`).click()
    await page.waitForTimeout(400)
    const caja = m.locator(`[data-testid=field-modal-name-${entryId}]`)
    ok(await caja.isVisible(), 'el lápiz abre el campo del nombre')
    await caja.fill('La de mis datos')
    // Con el VISTO, que es lo que se ve; Enter y el blur hacen lo mismo pero no se
    // anuncian (dueño, 2026-08-29).
    const visto = m.locator(`[data-testid=field-modal-name-ok-${entryId}]`)
    ok(await visto.isVisible(), 'y a su lado hay un visto para confirmar')
    await visto.click()
    await page.waitForTimeout(1200)
    const fila = m.locator(`[data-testid=field-modal-target][data-id="${entryId}"] .who2`)
    ok(await fila.textContent() === 'La de mis datos', 'el nombre queda puesto en la lista')
    await page.mouse.click(200, 120)
    await page.waitForTimeout(400)
  }
  const conNombre = ((await pedir('find', { url: `${SITE}/profile.html` }))?.result || [])
    .find((e) => e.id === entryId)
  ok(conNombre?.hint === 'La de mis datos', 'y en la bóveda: ' + conNombre?.hint)
  // Vaciarlo devuelve el que se calcula del contenido: ninguna fila se queda sin nombre.
  await pedir('rename', { id: entryId, name: '' })
  await page.waitForTimeout(400)
  const sinNombre = ((await pedir('find', { url: `${SITE}/profile.html` }))?.result || [])
    .find((e) => e.id === entryId)
  ok(sinNombre?.hint === 'ana@datos.com', 'y vaciarlo devuelve el calculado: ' + sinNombre?.hint)

  // --- 6. dos registros que acaban VIÉNDOSE IGUAL -----------------------------
  //
  // Lo que el dueño vio el 2026-08-29: «cuando pongo un Nombre igual a dos records uno
  // desaparece; los records deben tener un id único que no se muestra, no se mergean
  // así». Aquí se recorre entero: dos fichas distintas, se le pone a una lo que hace que
  // se llame igual que la otra, y las dos tienen que seguir estando y seguir separadas.
  console.log('\ndos registros que acaban viéndose igual')
  const fichas = async () =>
    ((await pedir('find', { url: `${SITE}/profile.html` }))?.result || []).filter((e) => e.type === 'data')

  // Una segunda ficha de datos, con otro nombre y otro teléfono.
  await page.goto(`${SITE}/profile.html`)
  await page.waitForTimeout(1000)
  await page.fill('input[name="given-name"]', 'Beto')
  await page.fill('input[name=email]', 'beto@datos.com')
  await page.fill('input[name=tel]', '0977000222')
  await Promise.all([page.waitForURL(/inside/), page.click('button[type=submit]')])
  f = await aviso()
  if (f) {
    for (const c of await f.locator('[data-testid=save-prompt-field] input[type=checkbox]').all()) await c.check()
    await f.locator('[data-testid=save-prompt-target-new]').check()
    await page.waitForTimeout(300)
    await f.locator('[data-testid=save-prompt-save]').click()
    await page.waitForTimeout(1500)
  }
  let dos = await fichas()
  ok(dos.length === 2, 'hay dos fichas de datos (' + dos.length + ')')
  const beto = dos.find((e) => e.hint === 'beto@datos.com')
  ok(!!beto, 'y se distinguen por su nombre visible')

  // Y ahora se le pone a Beto el correo de la otra: por fuera pasan a ser la misma.
  await page.goto(`${SITE}/profile.html`)
  await page.waitForTimeout(1100)
  await page.fill('input[name=email]', 'ana@datos.com')
  await page.waitForTimeout(700)
  await pulsar('email')
  m = await modal()
  ok(!!m, 'sale el modal del correo')
  if (m) {
    const destinos = m.locator('[data-testid=field-modal-target]')
    const ids = []
    for (let i = 0; i < await destinos.count(); i++) ids.push(await destinos.nth(i).getAttribute('data-id'))
    ok(ids.includes(beto.id), 'el modal ofrece la ficha de Beto entre los destinos')
    await m.locator(`[data-testid=field-modal-target-${beto.id}]`).check()
    await page.waitForTimeout(350)
    await m.locator('[data-testid=field-modal-save-email]').click()
    await page.waitForTimeout(1600)
    await page.mouse.click(200, 120)
    await page.waitForTimeout(400)
  }

  dos = await fichas()
  ok(dos.length === 2, 'NINGUNA desapareció (' + dos.length + ')')
  ok(new Set(dos.map((e) => e.id)).size === 2, 'y cada una con su id')
  ok(dos[0].hint === dos[1].hint && dos[0].hint === 'ana@datos.com',
    'las dos se ven igual: ' + dos.map((e) => e.hint).join(' / '))

  // Se ven igual y NO son la misma: cada una conserva lo suyo dentro.
  const laDeBeto = await abrir(beto.id)
  const laOtra = await abrir(entryId)
  ok(campo(laDeBeto, 'Teléfono')?.value === '0977000222', 'la de Beto conserva su teléfono')
  ok(campo(laOtra, 'Teléfono')?.value === '0999111222', 'y la otra el suyo')
  ok(!campo(laDeBeto, 'Número de socio'), 'sin heredar nada de la otra')
  ok(campo(laOtra, 'Número de socio')?.private === true, 'ni al revés')

  // Con dos que se parecen, el aviso NO elige por ti: elegir una al azar sería escribir
  // encima de un registro cualquiera.
  await page.goto(`${SITE}/profile.html`)
  await page.waitForTimeout(1000)
  // DOS datos: con uno solo el aviso no salta solo (§4.0.2).
  await page.fill('input[name=city]', 'Ambato')
  await page.fill('input[name="family-name"]', 'Ruiz')
  await Promise.all([page.waitForURL(/inside/), page.click('button[type=submit]')])
  f = await aviso()
  ok(!!f, 'sale el aviso con dos fichas que se parecen')
  if (f) {
    ok(await f.locator('[data-testid=save-prompt-target-new]').isChecked(),
      'con dos fichas que se parecen, no se elige ninguna por ti')
    ok(await f.locator('[data-testid=save-prompt-target] .tag').count() === 0 ||
       !(await f.locator('[data-testid=save-prompt-target] .tag').first().textContent()).match(/parece|similar/i),
      'y ninguna se señala como «la que más se parece»')
    await f.locator('[data-testid=save-prompt-dismiss]').click().catch(() => {})
    await page.waitForTimeout(500)
  }

  // Y quitar una deja la otra en pie.
  await pedir('remove', { id: beto.id, url: `${SITE}/profile.html` })
  await page.waitForTimeout(500)
  const queda = await fichas()
  ok(queda.length === 1 && queda[0].id === entryId, 'quitar una deja la otra en pie')
  ok(campos(await abrir(entryId)).length === cuantos, 'y entera')
  // --- 6b. renombrar desde el AVISO, que es la otra pantalla con la lista -----
  console.log('\ny renombrar desde el aviso de guardar')
  await page.goto(`${SITE}/profile.html`)
  await page.waitForTimeout(900)
  await page.fill('input[name=city]', 'Guayaquil')
  await page.fill('input[name="family-name"]', 'Ruiz')
  await Promise.all([page.waitForURL(/inside/), page.click('button[type=submit]')])
  f = await aviso()
  ok(!!f, 'sale el aviso')
  if (f) {
    await f.locator(`[data-testid=save-prompt-rename-${entryId}]`).click()
    const caja = f.locator(`[data-testid=save-prompt-name-${entryId}]`)
    await caja.waitFor({ timeout: 5000 })
    // Lo que el dueño vio: la fila decía «undefined» en vez de traer el nombre actual.
    ok(await caja.inputValue() !== 'undefined', 'el campo trae el nombre, no «undefined»')
    await caja.fill('Mis datos')
    await f.locator(`[data-testid=save-prompt-name-ok-${entryId}]`).click()
    await page.waitForTimeout(1400)
    const fila = f.locator(`[data-testid=save-prompt-target][data-id="${entryId}"] .who2`)
    ok(await fila.textContent() === 'Mis datos', 'y el visto lo confirma en la lista')
    await f.locator('[data-testid=save-prompt-dismiss]').click().catch(() => {})
    await page.waitForTimeout(500)
  }

  // --- 7. y el lápiz también en la lista de la extensión ----------------------
  //
  // Es donde se administra lo guardado, así que es el primer sitio donde alguien busca
  // cómo renombrar algo (dueño, 2026-08-29: «en el modal de la extensión no veo el botón
  // de editar»).
  console.log('\nel lápiz en la lista de la extensión')
  await page.goto(`${SITE}/profile.html`)
  await page.waitForTimeout(700)
  // Con la pestaña del SITIO al frente, que es como corre el popup de verdad: colgado de
  // la barra, con el sitio delante. Si no, se ve a sí mismo y la lista sale vacía.
  await page.bringToFront()
  await ext.waitForTimeout(300)
  await ext.reload()
  await ext.waitForTimeout(2500)

  const lapiz = ext.locator(`[data-testid=popup-rename-${entryId}]`)
  ok(await lapiz.count() === 1, 'cada entrada de la lista lleva su lápiz')
  if (await lapiz.count()) {
    await lapiz.click()
    const caja = ext.locator(`[data-testid=popup-name-${entryId}]`)
    await caja.waitFor({ timeout: 5000 })
    await caja.fill('Mis datos de aquí')
    await ext.locator(`[data-testid=popup-name-ok-${entryId}]`).click()
    await ext.waitForTimeout(1800)
    ok(await ext.locator('.entry .nametext').first().textContent() === 'Mis datos de aquí',
      'y el visto lo confirma')
  }
  const renombrada = ((await pedir('find', { url: `${SITE}/profile.html` }))?.result || [])
    .find((e) => e.id === entryId)
  ok(renombrada?.hint === 'Mis datos de aquí', 'queda en la bóveda: ' + renombrada?.hint)
} finally {
  await ctx.close()
  await rm(perfil, { recursive: true, force: true })
}
console.log(fallos.length ? `\n${fallos.length} FALLO(S)` : '\nTODO BIEN')
process.exit(fallos.length ? 1 : 0)
