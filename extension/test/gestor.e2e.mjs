// EL GESTOR DE REGISTROS, en un Chrome de verdad.
//
// Es la pantalla que el dueño pidió el 2026-08-29: un botón EDITAR que abre el registro y
// deja cambiar cada valor, el nombre, y añadir y quitar valores — nada de esto tiene que
// ver con la página que tienes delante.
//
// Y con dos reglas suyas, que son las que estas pruebas fijan:
//
//   · **no trae valores privados**: se enseñan tapados, se comparan por resumen y se
//     REEMPLAZAN escribiendo encima. Editar un registro no pide una sola autorización.
//   · **un único botón** para guardar todos los cambios, o cancelarlos todos.
//
//   npm run test:web &
//   npm run test:gestor
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright')

const EXT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SITE = process.env.SITE || 'http://localhost:8099'
const perfil = await mkdtemp(join(tmpdir(), 'pm-gestor-'))
const ctx = await chromium.launchPersistentContext(perfil, {
  headless: false,
  args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
  viewport: { width: 900, height: 820 },
})
const fallos = []
const ok = (c, m) => { console.log((c ? '  ok    ' : '  FALLA ') + m); if (!c) fallos.push(m) }

const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 })
const extId = new URL(sw.url()).host
const POPUP = `chrome-extension://${extId}/src/popup.html`
let ext = await ctx.newPage()
await ext.goto(POPUP)
/** El popup se cierra solo al abrir el gestor (`window.close()`): se vuelve a abrir. */
async function popup () {
  if (ext.isClosed()) { ext = await ctx.newPage(); await ext.goto(POPUP); await ext.waitForTimeout(1500) }
  return ext
}
const pedir = async (op, payload) => (await popup()).evaluate(([op, payload]) => new Promise((r) =>
  chrome.runtime.sendMessage({ op, payload }, r)), [op, payload])

const page = await ctx.newPage()
page.on('pageerror', (e) => console.log('   [error de página]', e.message))

const URLSITIO = `${SITE}/profile.html`

/** Abrir una entrada ENTERA desde una pantalla de la extensión, diciendo que sí. */
/**
 * Abrir una entrada ENTERA, diciendo que sí.
 *
 * La pregunta sale en **la pantalla de la extensión que haya** (§3.3.2), y con el gestor
 * abierto esa puede ser su pestaña y no el popup — en `--headless=new` todas se declaran
 * visibles, así que no se puede predecir cuál. Se contesta en la que salga.
 */
async function abrir (entryId) {
  await popup()
  await ext.bringToFront()
  await ext.waitForTimeout(250)
  const p = pedir('get', { id: entryId })
  const si = (pg) => pg && !pg.isClosed()
    ? pg.locator('[data-testid=approval-yes]').click({ timeout: 12000 })
    : new Promise(() => {})
  try { await Promise.race([si(ext), si(gestor)]) } catch (_) {}
  return (await p)?.result || null
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
const preguntó = async (f, ms = 2000) => {
  try { await f.locator('[data-testid=approval]').waitFor({ state: 'visible', timeout: ms }); return true }
  catch (_) { return false }
}

const campos = (open) => { try { return JSON.parse(open?.fields || '[]') } catch { return [] } }
const campo = (open, label) => campos(open).find((f) => f.label === label)

let gestor = null
async function abrirGestor (id) {
  if (!gestor) { gestor = await ctx.newPage(); gestor.on('pageerror', (e) => console.log('   [error del gestor]', e.message)) }
  const p = new URLSearchParams({ site: URLSITIO, ...(id ? { id } : {}) })
  await gestor.goto(`chrome-extension://${extId}/src/manager.html#${p}`)
  // Ir a la MISMA dirección no dispara `hashchange` ni recarga: sin esto, la pantalla
  // anterior se quedaba puesta (con su buscador escrito) y el test miraba lo de antes.
  await gestor.reload()
  await gestor.waitForTimeout(1200)
  return gestor
}

try {
  // --- se prepara un registro con datos públicos y uno privado ------------------
  console.log('\nse guarda una entrada de datos, con un campo privado')
  await page.goto(URLSITIO)
  await page.waitForTimeout(1000)
  for (const [n, v] of Object.entries({
    'given-name': 'Ana', 'family-name': 'Ruiz', email: 'ana@datos.com',
    tel: '0999111222', 'street-address': 'Calle 1 y Av. 2', city: 'Quito', member: 'SOC-4471',
  })) await page.fill(`input[name="${n}"]`, v)
  await Promise.all([page.waitForURL(/inside/), page.click('button[type=submit]')])

  let f = await aviso()
  if (f) {
    for (const c of await f.locator('[data-testid=save-prompt-field] input[type=checkbox]').all()) await c.check()
    await page.waitForTimeout(300)
    await f.locator('[data-testid=save-prompt-save]').click()
    await page.waitForTimeout(1500)
  }
  const lista = (await pedir('find', { url: URLSITIO }))?.result || []
  const datos = lista.find((e) => e.type === 'data')
  ok(!!datos, 'la entrada quedó guardada')
  const id = datos?.id

  // El número de socio, privado: es el valor que el gestor NO puede traerse.
  await pedir('patch', { id, changes: { fields: [{ label: 'Número de socio', private: true }] } })
  const inicial = await abrir(id)
  ok(campo(inicial, 'Número de socio')?.private === true, 'y «Número de socio» queda privado')
  ok(campos(inicial).length === 7, 'con sus siete campos (' + campos(inicial).length + ')')

  // --- 1. el botón EDITAR del popup abre el gestor ------------------------------
  console.log('\nel botón EDITAR del popup')
  await page.goto(URLSITIO)
  await page.waitForTimeout(600)
  await page.bringToFront()
  await ext.waitForTimeout(300)
  await ext.reload()
  await ext.waitForTimeout(2500)
  const editar = ext.locator(`[data-testid=popup-edit-${id}]`)
  ok(await editar.count() === 1, 'cada tarjeta lleva su botón de editar')
  ok(await ext.locator('[data-testid=popup-manager]').isVisible(), 'y hay un segundo botón que abre el gestor entero')
  if (await editar.count()) {
    const [abierta] = await Promise.all([ctx.waitForEvent('page', { timeout: 8000 }), editar.click()])
    await abierta.waitForLoadState()
    ok(abierta.url().includes('manager.html'), 'y abre el gestor en su propia pestaña')
    ok(abierta.url().includes(id), 'directo a la ficha de ESE registro')
    await abierta.close()
  }

  // --- 2. la ficha: lo público con su valor, lo privado tapado -------------------
  console.log('\nla ficha del registro')
  const g = await abrirGestor(id)
  ok(!(await preguntó(g)), 'ABRIR UNA FICHA NO PIDE NINGUNA AUTORIZACIÓN')
  ok(await g.locator('[data-testid=manager-value-email]').inputValue() === 'ana@datos.com',
    'un dato público sale con su valor')
  const privado = g.locator('[data-testid="manager-value-label:Número de socio"]')
  ok(await privado.inputValue() === '', 'y el privado sale vacío: no se trae')
  ok(/reemplaz|replace/i.test(await privado.getAttribute('placeholder') || ''),
    'con el aviso de que se escribe encima para reemplazarlo')
  ok(await g.locator('[data-testid="manager-private-label:Número de socio"]').isChecked(),
    'y marcado como privado')
  ok(await g.locator('[data-testid=manager-save]').isDisabled(), 'sin tocar nada no hay nada que guardar')

  // --- 3. escribir en un privado LO MISMO que ya hay: no es un cambio ------------
  console.log('\nescribir en un privado lo mismo que ya hay')
  await privado.fill('SOC-4471')
  await g.waitForTimeout(1400)
  ok(/^(igual|same)$/.test(await g.locator('[data-testid="manager-tag-label:Número de socio"]').textContent()),
    'el resumen dice que es igual, sin abrir nada')
  ok(await g.locator('[data-testid=manager-save]').isDisabled(), 'y no hay nada que guardar')
  ok(!(await preguntó(g, 1200)), 'comparar tampoco pide autorización')

  // --- 4. un cambio de cada clase, y UN solo botón -------------------------------
  console.log('\nun cambio de cada clase, guardados de una vez')
  await privado.fill('SOC-0001')
  await g.waitForTimeout(2000)
  const dice = await g.locator('[data-testid="manager-tag-label:Número de socio"]').textContent()
  ok(/^(cambia|changes)$/.test(dice), 'ahora sí dice que cambia: «' + dice + '»')
  await g.locator('[data-testid=manager-value-email]').fill('ana@nueva.com')
  await g.locator('[data-testid=manager-name]').fill('La de mis datos')
  await g.locator('[data-testid=manager-remove-city]').click()
  ok(await g.locator('[data-testid=manager-row-city]').getAttribute('class') === 'value gone',
    'lo quitado se ve tachado hasta que se guarda')
  await g.locator('[data-testid=manager-add]').click()
  await g.waitForTimeout(200)
  await g.locator('[data-testid=manager-label-new-0]').fill('Apodo')
  await g.locator('[data-testid=manager-value-new-0]').fill('Anita')
  await g.waitForTimeout(300)

  ok(!(await g.locator('[data-testid=manager-save]').isDisabled()), 'el botón de guardar se enciende')
  ok(await g.locator('[data-testid=manager-cancel]').count() === 1, 'y a su lado el de cancelar')
  await g.locator('[data-testid=manager-save]').click()
  ok(!(await preguntó(g)), 'GUARDAR TAMPOCO PIDE AUTORIZACIÓN')
  await g.waitForTimeout(1800)
  ok(g.url().endsWith(`site=${encodeURIComponent(URLSITIO)}`), 'y se vuelve a la lista')

  console.log('\ny en la bóveda quedó exactamente eso')
  const tras = await abrir(id)
  ok(tras?.id === id, 'el mismo registro')
  ok(tras?.name === 'La de mis datos', 'con su nombre: ' + tras?.name)
  ok(campo(tras, 'Número de socio')?.value === 'SOC-0001', 'el privado reemplazado')
  ok(campo(tras, 'Número de socio')?.private === true, 'y sigue siendo privado')
  ok(campo(tras, 'Correo')?.value === 'ana@nueva.com', 'el público cambiado')
  ok(!campo(tras, 'Ciudad'), 'el quitado ya no está')
  ok(campo(tras, 'Apodo')?.value === 'Anita', 'y el nuevo entró')
  ok(campo(tras, 'Teléfono')?.value === '0999111222', 'lo que no se tocó sigue igual')
  ok(campos(tras).length === 7, 'siete campos: uno menos y uno más (' + campos(tras).length + ')')

  // --- 5. cancelar no guarda nada -----------------------------------------------
  console.log('\ncancelar')
  await abrirGestor(id)
  await g.locator('[data-testid=manager-value-tel]').fill('0000000000')
  await g.waitForTimeout(300)
  await g.locator('[data-testid=manager-cancel]').click()
  await g.waitForTimeout(1200)
  const igual = await abrir(id)
  ok(campo(igual, 'Teléfono')?.value === '0999111222',
    'el teléfono no se tocó')

  // --- 6. quitar la marca de privado SIN tener el valor delante ------------------
  console.log('\nquitar la marca de privado, sin traerse el valor')
  await abrirGestor(id)
  await g.locator('[data-testid="manager-private-label:Número de socio"]').uncheck()
  await g.waitForTimeout(300)
  await g.locator('[data-testid=manager-save]').click()
  ok(!(await preguntó(g)), 'cambiar la marca no pide autorización')
  await g.waitForTimeout(1800)
  const suelto = await abrir(id)
  ok(campo(suelto, 'Número de socio')?.value === 'SOC-0001', 'el valor sigue intacto')
  ok(campo(suelto, 'Número de socio')?.private === undefined, 'y ya no es privado')
  await abrirGestor(id)
  ok(await g.locator('[data-testid="manager-value-label:Número de socio"]').inputValue() === 'SOC-0001',
    'y ahora sí sale su valor, porque ya es público')

  // --- 7. UN REGISTRO QUE CRUZA DOMINIOS ------------------------------------------
  //
  // Lo que el dueño pidió el 2026-08-29: *«un record que cruce dominios»*. La misma
  // cuenta en dos sitios que no se parecen en nada — el emparejamiento ya recorría toda
  // la lista, lo que faltaba era poder escribirla.
  console.log('\nun registro en varios dominios')
  await abrirGestor(id)
  ok(await g.locator('[data-testid="manager-site-chip-localhost"]').count() === 1,
    'la ficha enseña el sitio que tenía')
  await g.locator('[data-testid=manager-site-input]').fill('https://otro-dominio.example/entrar')
  await g.locator('[data-testid=manager-site-add]').click()
  await g.waitForTimeout(300)
  ok(await g.locator('[data-testid="manager-site-chip-otro-dominio.example"]').count() === 1,
    'se pega la dirección entera y queda el dominio')
  await g.locator('[data-testid=manager-save]').click()
  await g.waitForTimeout(1800)

  const enOtro = ((await pedir('find', { url: 'https://otro-dominio.example/algo' }))?.result || [])
    .find((e) => e.id === id)
  ok(!!enOtro, 'el MISMO registro sale en el dominio nuevo')
  ok(((await pedir('find', { url: URLSITIO }))?.result || []).some((e) => e.id === id),
    'y sigue saliendo en el de siempre')
  ok(enOtro?.sites?.length === 2, 'con sus dos sitios (' + enOtro?.sites?.join(' · ') + ')')

  // Un subdominio del nuevo entra sin escribir ningún comodín.
  ok(((await pedir('find', { url: 'https://intranet.otro-dominio.example/' }))?.result || [])
    .some((e) => e.id === id), 'y un subdominio suyo también, sin comodín')

  await abrirGestor(null)
  await g.locator('[data-testid=manager-search]').fill('otro-dominio')
  await g.waitForTimeout(900)
  const linea = await g.locator(`[data-testid=manager-record-${id}] .who .hint`).textContent()
  ok(/localhost/.test(linea) && /otro-dominio\.example/.test(linea),
    'y la lista enseña los dos sitios, uno al lado de otro: ' + linea)

  // Quitarlos todos: entonces vale en cualquier sitio, que es lo que significa la lista
  // vacía desde siempre.
  await abrirGestor(id)
  for (const d of ['localhost', 'otro-dominio.example']) {
    await g.locator(`[data-testid="manager-site-remove-${d}"]`).click()
  }
  await g.waitForTimeout(300)
  await g.locator('[data-testid=manager-save]').click()
  await g.waitForTimeout(1800)
  ok(((await pedir('find', { url: 'https://cualquier-cosa.example/' }))?.result || [])
    .some((e) => e.id === id), 'sin ningún sitio, vale en cualquiera')
  // Y se deja como estaba, que abajo se sigue usando.
  await abrirGestor(id)
  await g.locator('[data-testid=manager-site-input]').fill('localhost')
  await g.locator('[data-testid=manager-site-add]').click()
  await g.locator('[data-testid=manager-save]').click()
  await g.waitForTimeout(1800)

  // --- 8. la lista y el buscador -------------------------------------------------
  console.log('\nla lista del gestor')
  await abrirGestor(null)
  ok(await g.locator(`[data-testid=manager-record-${id}]`).count() === 1, 'salen los del sitio de donde se vino')
  ok(await g.locator('[data-testid=manager-site-localhost]').isVisible(), 'y arriba, en qué sitios hay algo')
  await g.locator('[data-testid=manager-search]').fill('nada-de-nada')
  await g.waitForTimeout(900)
  ok(await g.locator(`[data-testid=manager-record-${id}]`).count() === 0, 'y el buscador filtra de verdad')
  await g.locator('[data-testid=manager-search]').fill('localhost')
  await g.waitForTimeout(900)
  ok(await g.locator('.entry').count() > 0, 'buscando por el sitio, aparece')
  ok(!(await g.locator('[data-testid=manager-site-localhost]').isVisible()),
    'y mientras se busca, los dominios se apartan')

  // --- 9. pulsar un dominio filtra DE VERDAD ---------------------------------------
  //
  // El fallo que vio el dueño: el botón decía «1» y la lista enseñaba de todo. Eran dos
  // preguntas distintas — lo archivado ahí, y lo que serviría en esa página, que incluye
  // todo lo que no tiene sitio.
  console.log('\npulsar un dominio filtra de verdad')
  const suelta = (await pedir('put', { entry: {
    type: 'data', title: 'sin sitio', name: 'Vale en cualquier parte',
    fields: [{ kind: 'email', label: 'Correo', value: 'suelta@ejemplo.com' }],
  } }))?.result
  await abrirGestor(null)
  ok(await g.locator('[data-testid=manager-site-anywhere]').isVisible(),
    'las que no tienen sitio tienen su propio botón')
  ok(await g.locator(`[data-testid=manager-peek-${id}]`).count() === 1,
    'la tarjeta del gestor es la del popup: su chevron')
  ok(await g.locator(`[data-testid=manager-del-${id}]`).count() === 1, 'su borrar')
  ok(await g.locator(`[data-testid=manager-default-${id}]`).count() === 1, 'su predeterminada')
  ok(await g.locator(`[data-testid=manager-fill-${id}]`).count() === 0,
    'y SIN rellenar, que es de la página que tienes delante')
  ok(await g.locator('[data-testid^=profile-]').first().isVisible(),
    'y arriba, de qué bóveda se está hablando')

  await g.locator('[data-testid=manager-site-localhost]').click()
  await g.waitForTimeout(1200)
  ok(await g.locator(`[data-testid=manager-record-${id}]`).count() === 1,
    'pulsando localhost sale la suya')
  ok(await g.locator(`[data-testid=manager-record-${suelta.id}]`).count() === 0,
    'y NO se cuela la que no tiene sitio')
  const cuantas = await g.locator('.entry').count()
  const boton = await g.locator('[data-testid=manager-site-localhost]').textContent()
  ok(boton.endsWith(String(cuantas)), `el número del botón y la lista coinciden (${boton} / ${cuantas})`)

  await g.locator('[data-testid=manager-site-anywhere]').click()
  await g.waitForTimeout(1200)
  ok(await g.locator(`[data-testid=manager-record-${suelta.id}]`).count() === 1,
    'y en «en cualquier sitio» está la suelta')
  ok(await g.locator(`[data-testid=manager-record-${id}]`).count() === 0, 'y solo ella')
} finally {
  await ctx.close()
  await rm(perfil, { recursive: true, force: true })
}

console.log(fallos.length ? `\nFALLAN ${fallos.length}:\n - ` + fallos.join('\n - ') : '\nTODO BIEN')
process.exit(fallos.length ? 1 : 0)
