// Las capturas de la ficha, con la extensión cargada DE VERDAD y en español.
//
// La página es nuestra y se sirve interceptando una URL: así el sitio que sale en la UI
// («tienda.ejemplo») es legible y no un `localhost:8099` que no le dice nada a nadie.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright')

const EXT = new URL('../', import.meta.url).pathname
const OUT = new URL('./capturas', import.meta.url).pathname
const perfil = await mkdtemp(join(tmpdir(), 'pm-tienda-'))

const CSS = `
  :root { color-scheme: light }
  * { box-sizing: border-box }
  body { margin:0; font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
         background:#eef2f6; color:#1a2530; display:flex; justify-content:center;
         padding:60px 20px }
  .caja { width:520px; background:#fff; border-radius:16px; padding:34px 36px;
          box-shadow:0 12px 40px rgba(20,40,60,.10) }
  h1 { font-size:22px; margin:0 0 4px }
  p.sub { margin:0 0 26px; color:#5b6b7a; font-size:15px }
  label { display:block; font-size:13px; color:#5b6b7a; margin:16px 0 6px }
  input { width:100%; padding:11px 13px; font:inherit; border:1px solid #d6dee6;
          border-radius:9px; background:#fbfdff }
  input:focus { outline:2px solid #00658c; outline-offset:-1px }
  button { margin-top:24px; width:100%; padding:12px; font:inherit; font-weight:600;
           border:0; border-radius:9px; background:#00658c; color:#fff; cursor:pointer }
`
const ACCESO = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<title>Entrar</title><style>${CSS}</style></head><body>
<form class="caja" method="GET" action="/dentro">
  <h1>Entrar en tu cuenta</h1><p class="sub">Bienvenido de vuelta.</p>
  <label for="u">Correo</label><input id="u" name="user" type="email" autocomplete="username">
  <label for="p">Contraseña</label><input id="p" name="password" type="password" autocomplete="current-password">
  <button type="submit">Entrar</button>
</form></body></html>`

const DATOS = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<title>Tus datos</title><style>${CSS}</style></head><body>
<form class="caja" method="GET" action="/dentro">
  <h1>Tus datos</h1><p class="sub">Para el envío de tu pedido.</p>
  <label for="n">Nombre</label><input id="n" name="given-name" autocomplete="given-name">
  <label for="e">Correo</label><input id="e" name="email" type="email" autocomplete="email">
  <label for="t">Teléfono</label><input id="t" name="tel" type="tel" autocomplete="tel">
  <label for="d">Dirección</label><input id="d" name="street-address" autocomplete="street-address">
  <label for="s">Número de socio</label><input id="s" name="member">
  <button type="submit">Continuar</button>
</form></body></html>`

const DENTRO = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<title>Listo</title><style>${CSS}</style></head><body>
<div class="caja"><h1>Ya estás dentro</h1><p class="sub">Tu sesión está abierta.</p></div>
</body></html>`

const ctx = await chromium.launchPersistentContext(perfil, {
  headless: false,
  args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    '--no-sandbox', '--lang=es-ES'],
  viewport: { width: 1280, height: 800 },
  locale: 'es-ES',
})
const page = await ctx.newPage()
await ctx.route('https://tienda.ejemplo/**', (route) => {
  const u = route.request().url()
  const body = u.includes('/datos') ? DATOS : u.includes('/dentro') ? DENTRO : ACCESO
  route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body })
})

const aviso = () => page.frames().find((x) => x.url().includes('save-prompt.html'))
const modal = () => page.frames().find((x) => x.url().includes('field-modal.html'))
const esperar = async (fn, ms = 12000) => {
  for (let i = 0; i < ms / 200; i++) { const f = fn(); if (f) return f; await page.waitForTimeout(200) }
  return null
}
const marcador = async (sel) => {
  const c = await page.locator(sel).boundingBox()
  await page.mouse.click(c.x + c.width - 10, c.y + 8)
}
const foto = (n) => page.screenshot({ path: `${OUT}/${n}` })

// --- 1. el aviso de después de entrar ---------------------------------------------
await page.goto('https://tienda.ejemplo/entrar')
await page.waitForTimeout(1200)
await page.fill('#u', 'ana@ejemplo.com')
await page.fill('#p', 'la-de-siempre')
await Promise.all([page.waitForURL(/dentro/), page.click('button[type=submit]')])
let f = await esperar(aviso)
await f.locator('[data-testid=save-prompt-field]').first().waitFor({ timeout: 8000 })
await page.waitForTimeout(600)
await foto('1-guardar.png')
await f.locator('[data-testid=save-prompt-save]').click()
await page.waitForTimeout(1400)

// Una segunda cuenta, para que la lista tenga de dónde elegir.
await page.goto('https://tienda.ejemplo/entrar')
await page.waitForTimeout(900)
await page.fill('#u', 'trabajo@ejemplo.com')
await page.fill('#p', 'otra-distinta')
await Promise.all([page.waitForURL(/dentro/), page.click('button[type=submit]')])
f = await esperar(aviso)
await f.locator('[data-testid=save-prompt-field]').first().waitFor({ timeout: 8000 })
const nueva = f.locator('[data-testid=save-prompt-target-new]')
if (await nueva.count()) { await nueva.check(); await page.waitForTimeout(400) }
await f.locator('[data-testid=save-prompt-save]').click()
await page.waitForTimeout(1400)

// --- 2. el botón del campo, rellenando --------------------------------------------
await page.goto('https://tienda.ejemplo/entrar')
await page.waitForTimeout(1600)
await marcador('#u')
let m = await esperar(modal)
await m.locator('body[data-ready]').waitFor({ timeout: 8000 })
await page.waitForTimeout(700)
await foto('2-rellenar.png')
await page.mouse.click(200, 120)
await page.waitForTimeout(500)

// --- 3. datos, no solo contraseñas ------------------------------------------------
await page.goto('https://tienda.ejemplo/datos')
await page.waitForTimeout(1200)
for (const [s, v] of [['#n', 'Ana'], ['#e', 'ana@ejemplo.com'], ['#t', '099 111 2222'],
  ['#d', 'Av. Amazonas y Colón'], ['#s', 'SOC-4471']]) await page.fill(s, v)
await page.waitForTimeout(900)
await marcador('#t')
m = await esperar(modal)
await m.locator('body[data-ready]').waitFor({ timeout: 8000 })
await page.waitForTimeout(700)
await foto('3-datos.png')

// --- 4. el popup ------------------------------------------------------------------
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 })
const id = new URL(sw.url()).host
const pop = await ctx.newPage()
await pop.setViewportSize({ width: 420, height: 560 })
await pop.goto(`chrome-extension://${id}/src/popup.html`)
await page.bringToFront()
await pop.reload()
await pop.waitForTimeout(2200)
await pop.screenshot({ path: `${OUT}/4-popup-crudo.png` })

await ctx.close()
await rm(perfil, { recursive: true, force: true })
console.log('capturas listas')
