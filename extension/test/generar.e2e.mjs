// EL GENERADOR EN EL CAMPO, en un Chrome de verdad (DISENO §4.1.1).
//
// Lo que se comprueba, que es justo lo que no se puede comprobar sin navegador:
//   · una contraseña vacía saca botón aunque el sitio no tenga NADA guardado (el caso de
//     registrarse, que antes se quedaba sin marcador y sin generador);
//   · «Usar» escribe la misma contraseña en la casilla de repetir;
//   · y lo generado queda apuntado en el acto, así que el aviso de después de enviar lo
//     ofrece — una contraseña generada que no se guarda deja al usuario fuera.
//
//   npm run test:web &
//   npm run test:generar
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright')

const EXT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SITE = process.env.SITE || 'http://localhost:8099'
const perfil = await mkdtemp(join(tmpdir(), 'pm-generar-'))
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

const que = async (campos) => (await pedir('offers', { url: page.url(), fields: campos }))?.result || []

async function modal () {
  for (let i = 0; i < 40; i++) {
    const f = page.frames().find((x) => x.url().includes('field-modal.html'))
    if (f) { await f.locator('body[data-ready]').waitFor({ timeout: 8000 }); return f }
    await page.waitForTimeout(200)
  }
  return null
}

async function aviso () {
  for (let i = 0; i < 40; i++) {
    const f = page.frames().find((x) => x.url().includes('save-prompt.html'))
    if (f) { await f.locator('[data-testid=save-prompt-field]').first().waitFor({ timeout: 8000 }); return f }
    await page.waitForTimeout(250)
  }
  return null
}

/** El marcador vive pegado al borde derecho de su campo. */
async function pulsarMarcador (selector) {
  const caja = await page.locator(selector).boundingBox()
  await page.mouse.click(caja.x + caja.width - 10, caja.y + caja.height / 2)
}

try {
  console.log('\nregistrarse en un sitio sin nada guardado')
  await page.goto(`${SITE}/signup.html`)
  await page.waitForTimeout(1200)

  const r = await que([
    { id: 0, key: 'secret', value: '', username: '', secret: '' },
    { id: 1, key: 'username', value: '', username: '', secret: '' },
  ])
  ok(r[0]?.gen === true, 'la contraseña vacía ofrece generar')
  ok(r[0]?.fill === false && r[0]?.save === false, 'y nada más: no hay qué rellenar ni qué guardar')
  ok(r[1]?.gen !== true, 'el usuario vacío sigue sin botón (esto es solo para contraseñas)')

  await pulsarMarcador('input[name=pass1]')
  const m = await modal()
  ok(!!m, 'el modal se abre desde una contraseña vacía')

  let generada = ''
  if (m) {
    const val = m.locator('[data-testid=field-modal-gen-value]')
    ok(await val.isVisible(), 'y enseña una contraseña nueva')
    generada = (await val.textContent() || '').trim()
    ok(generada.length === 20, `de 20 caracteres (salieron ${generada.length})`)

    // «Otra» tiene que dar otra: si no, el botón miente.
    await m.locator('[data-testid=field-modal-gen-again]').click()
    await page.waitForTimeout(300)
    const segunda = (await val.textContent() || '').trim()
    ok(segunda !== generada && segunda.length === 20, 'el botón «Otra» da otra distinta')
    generada = segunda

    await m.locator('[data-testid=field-modal-gen-use]').click()
    await page.waitForTimeout(900)
  }

  const p1 = await page.inputValue('input[name=pass1]')
  const p2 = await page.inputValue('input[name=pass2]')
  ok(p1 === generada, 'la contraseña se escribe en el campo')
  ok(p2 === generada, 'y la MISMA en la casilla de repetir')

  // Y no se pierde: lo generado queda apuntado, así que el campo ya ofrece guardarlo.
  const tras = await que([{ id: 0, key: 'secret', value: p1, username: '', secret: p1 }])
  ok(tras[0]?.save === true, 'el campo pasa a ofrecer guardar lo generado')

  console.log('\ny al enviar, el aviso lo ofrece')
  await page.fill('input[name=email]', 'ana@ejemplo.com')
  await Promise.all([page.waitForURL(/inside/), page.click('button[type=submit]')])
  const f = await aviso()
  ok(!!f, 'sale el aviso de guardar')
  if (f) {
    await f.locator('[data-testid=save-prompt-save]').click()
    await page.waitForTimeout(1500)
  }

  const guardadas = ((await pedir('find', { url: `${SITE}/signup.html` }))?.result) || []
  ok(guardadas.length === 1, 'queda una entrada guardada')

  console.log('\ncon algo ya guardado, rellenar manda y generar sigue estando')
  await page.goto(`${SITE}/signup.html`)
  await page.waitForTimeout(1200)
  const r2 = await que([{ id: 0, key: 'secret', value: '', username: '', secret: '' }])
  ok(r2[0]?.fill === true, 'con algo guardado, la contraseña vacía ofrece rellenar')
  ok(r2[0]?.gen === true, 'y generar sigue disponible: cambiar de contraseña es normal')

  await pulsarMarcador('input[name=pass1]')
  const m2 = await modal()
  ok(!!m2, 'el modal se abre')
  if (m2) {
    ok(await m2.locator('[data-testid=field-modal-gen-value]').isVisible(), 'con el generador a la vista')
    ok(await m2.locator('#fillBox').isVisible(), 'y con lo que hay guardado, debajo')
  }
} finally {
  await ctx.close()
  await rm(perfil, { recursive: true, force: true })
}
console.log(fallos.length ? `\n${fallos.length} FALLO(S)` : '\nTODO BIEN')
process.exit(fallos.length ? 1 : 0)
