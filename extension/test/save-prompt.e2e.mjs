// EL AVISO DE GUARDAR, en un Chrome de verdad con la extensión cargada.
//
// Es lo único que no se puede probar sin navegador: un formulario que NAVEGA al enviar,
// y el aviso saliendo en la página siguiente — que es donde los gestores preguntan y
// donde este no preguntaba.
//
// Se corre a mano porque necesita Chrome y Playwright:
//
//   python3 -m http.server 8099 --directory extension/test &
//   node extension/test/guardar.e2e.mjs
//
// `PLAYWRIGHT` apunta al paquete si no está instalado aquí (p. ej. el de dotrino-test).
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright')

const EXT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SITE = process.env.SITE || 'http://localhost:8099'

const perfil = await mkdtemp(join(tmpdir(), 'pm-chrome-'))
const ctx = await chromium.launchPersistentContext(perfil, {
  headless: false,
  args: [
    '--headless=new',
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--no-sandbox',
  ],
})

const fallos = []
const ok = (cond, msg) => { console.log((cond ? '  ok   ' : '  FALLA ') + msg); if (!cond) fallos.push(msg) }

try {
  // El service worker de la extensión: hay que esperarlo antes de nada.
  let sw = ctx.serviceWorkers()[0]
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 })
  const id = new URL(sw.url()).host
  console.log('extensión cargada:', id)

  const page = await ctx.newPage()
  page.on('console', (m) => { if (m.type() === 'error') console.log('   [consola]', m.text()) })

  // Para preguntarle a la bóveda hace falta una PÁGINA de la extensión: un mensaje que
  // el propio service worker se manda a sí mismo no llega a su listener.
  const ext = await ctx.newPage()
  await ext.goto(`chrome-extension://${id}/src/popup.html`)
  const pedir = (op, payload) => ext.evaluate(([op, payload]) => new Promise((r) =>
    chrome.runtime.sendMessage({ op, payload }, r)), [op, payload])

  // --- 1. entrar: se escribe y se envía, y la página NAVEGA ---
  await page.goto(`${SITE}/login.html`)
  await page.waitForTimeout(600)
  await page.fill('input[name=user]', 'seyacat@dotrino.com')
  await page.fill('input[name=password]', 'hunter2-de-prueba')
  await Promise.all([page.waitForURL(/inside\.html/), page.click('button[type=submit]')])
  console.log('navegó a:', new URL(page.url()).pathname)

  // --- 2. el aviso sale SOLO, en la página siguiente ---
  //
  // Se busca por FRAME y no por selector: el aviso vive en un shadow root CERRADO, así
  // que no hay `iframe` que localizar desde la página — que es justamente lo que se
  // quiere. Un frame sí existe a nivel de navegador.
  const buscarFrame = async () => {
    for (let i = 0; i < 40; i++) {
      const f = page.frames().find(x => x.url().includes('/src/save-prompt.html'))
      if (f) return f
      await page.waitForTimeout(250)
    }
    return null
  }
  const frame = await buscarFrame()
  ok(!!frame, 'el aviso aparece solo en la página siguiente')
  if (!frame) throw new Error('no salió el aviso')
  const guardar = frame.locator('[data-testid=save-prompt-save]')
  // A que esté PINTADO: el botón existe en el HTML antes de que el aviso sepa qué va a
  // escribir. Se espera a la primera fila de campo, que solo aparece ya cargado.
  await frame.locator('[data-testid=save-prompt-field]').first().waitFor({ timeout: 8000 })
  await guardar.waitFor({ state: 'visible', timeout: 8000 })

  ok((await frame.locator('#host').textContent()) === 'localhost', 'enseña el sitio')
  ok((await frame.locator('#user').textContent()) === 'seyacat@dotrino.com', 'enseña el usuario')

  // La contraseña NO puede estar en el aviso: solo la sabe el service worker.
  const inner = await frame.locator('body').innerHTML()
  ok(!inner.includes('hunter2-de-prueba'), 'la contraseña NO viaja al aviso')

  // Ni la página puede leer lo que hay dentro: shadow root cerrado y otro origen.
  const alcanzable = await page.evaluate(() => {
    const h = document.getElementById('dotrino-passmanager-ui')
    try { return !!h?.shadowRoot } catch { return false }
  })
  ok(!alcanzable, 'la página no alcanza el shadow root del gestor')
  ok(await page.locator('iframe').count() === 0, 'la página no ve ningún iframe del gestor')

  // --- 2b. la lista de lo que se va a escribir, con su casilla ---
  //
  // Guardar un formulario no es un sí o un no a todo: se enseña fila por fila lo que se
  // añade o lo que cambia, y el usuario elige. Aquí es una cuenta nueva, así que las dos
  // filas son nuevas y van marcadas.
  const filas = frame.locator('[data-testid=save-prompt-field]')
  ok(await filas.count() === 2, 'el aviso lista usuario y contraseña (hay ' + (await filas.count()) + ')')
  ok(await frame.locator('[data-testid=save-prompt-pick-username]').isChecked(), 'el usuario, marcado')
  ok(await frame.locator('[data-testid=save-prompt-pick-secret]').isChecked(), 'la contraseña, marcada')
  ok((await filas.nth(1).locator('.v').textContent()).trim() === '••••••••',
    'la contraseña se enseña TAPADA, no en claro')

  // Sin nada marcado no hay nada que guardar, y el botón lo dice estando apagado.
  await frame.locator('[data-testid=save-prompt-pick-username]').uncheck()
  await frame.locator('[data-testid=save-prompt-pick-secret]').uncheck()
  ok(await guardar.isDisabled(), 'sin nada marcado no se puede guardar')
  await frame.locator('[data-testid=save-prompt-pick-username]').check()
  await frame.locator('[data-testid=save-prompt-pick-secret]').check()
  ok(await guardar.isEnabled(), 'y al volver a marcar, sí')

  // --- 3. se guarda al pulsar, y solo entonces ---
  const antes = await pedir('find', { url: `${SITE}/inside.html` })
  ok((antes?.result || []).length === 0, 'antes de pulsar, la bóveda no tiene nada')

  await guardar.click()
  await page.waitForTimeout(1200)

  const despues = await pedir('find', { url: `${SITE}/inside.html` })
  const items = despues?.result || []
  ok(items.length === 1, 'después de pulsar, la entrada está guardada')
  ok(items[0]?.title === 'localhost', 'con el sitio como título')
  ok(items[0]?.hint === 's•••t@dotrino.com', 'y el usuario enmascarado: ' + items[0]?.hint)

  // Y la credencial completa se recupera.
  const full = items[0] ? await pedir('get', { id: items[0].id }) : null
  ok(full?.result?.secret === 'hunter2-de-prueba', 'la contraseña guardada es la que se escribió')

  // --- 4. el aviso se cierra y no queda nada pendiente ---
  const sigue = page.frames().some(f => f.url().includes('/src/save-prompt.html'))
  ok(!sigue, 'el aviso se cierra al guardar')

  const pend = await sw.evaluate(() => chrome.storage.session.get('passmanager/pending-save'))
  ok(!pend['passmanager/pending-save'], 'no queda ninguna contraseña esperando en la sesión')

  // --- 5. y no vuelve a preguntar por lo mismo ---
  await page.goto(`${SITE}/inside.html`)
  await page.waitForTimeout(1500)
  const otra = page.frames().some(f => f.url().includes('/src/save-prompt.html'))
  ok(!otra, 'no vuelve a preguntar al recargar')
} finally {
  await ctx.close()
  await rm(perfil, { recursive: true, force: true })
}

console.log(fallos.length ? `\n${fallos.length} FALLO(S)` : '\nTODO BIEN')
process.exit(fallos.length ? 1 : 0)
