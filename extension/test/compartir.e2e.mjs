// LAS DOS BÓVEDAS DE LA EXTENSIÓN SON UNA, en dos Chrome de verdad.
//
// «Ambas bóvedas deben compartir los datos» (dueño, 2026-09-21). La bóveda de dentro de la
// extensión y la pestaña «Esta pestaña es tu bóveda» no tienen dos copias: la pestaña pone
// la conexión y lo que atiende es lo MISMO que rellena la extensión. Lo que se prueba:
//
//   · A guarda una contraseña en su bóveda propia, da de alta un aparato de usuario y
//     contraseña con permiso para contraseñas y enciende la pestaña de bóveda;
//   · B —otro navegador— entra con ese usuario y contraseña, y su cuenta pide a la bóveda
//     de A en vez de estrenar una vacía (antes quedaba como «propia», sin convertir);
//   · B encuentra lo que guardó A, lo abre cuando A dice que sí, y lo que guarda B lo ve A;
//   · a B no le envolvió nadie lo escrito antes de que entrara: lo completa la bóveda de A
//     sola, sin pedir la contraseña de recuperación.
//
// El proxio corre en ESTE proceso; los dos Chrome se conectan a él por ws://.
//
//   npm run test:compartir
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { CLAVE_BOVEDA } from './_boveda.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const EXT = join(here, '..')
const req = createRequire(join(here, '../../../dotrino-vault/test/x.mjs'))

process.env.NODE_ENV = 'test'
process.env.PROXY_DB_FILE = ':memory:'
process.env.PORT = '0'
const proxy = req('../../dotrino-proxy/server.js')
const puerto = await proxy.start(0)
const PROXY_URL = `ws://127.0.0.1:${puerto}`

const fallos = []
const ok = (c, m) => { console.log((c ? '  ok    ' : '  FALLA ') + m); if (!c) fallos.push(m) }

const _pw = await import(process.env.PLAYWRIGHT || 'playwright')
const chromium = _pw.chromium || _pw.default?.chromium

/** Un Chrome con la extensión, y la pantalla del gestor abierta para hablarle. */
async function navegador (nombre) {
  const dir = await mkdtemp(join(tmpdir(), `pm-compartir-${nombre}-`))
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: false,
    args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
    viewport: { width: 900, height: 820 },
  })
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 })
  const id = new URL(sw.url()).host
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.log(`   [${nombre}: error de página]`, e.message))
  // `PM_LOG=1` enseña la consola de la página y del worker: sin ella, un pedido que no llega
  // solo se ve como «nadie respondió».
  if (process.env.PM_LOG) {
    page.on('console', (m) => console.log(`   [${nombre}: página]`, m.text()))
    sw.on('console', (m) => console.log(`   [${nombre}: worker]`, m.text()))
  }
  await page.goto(`chrome-extension://${id}/src/manager.html#view=logins`)
  await page.waitForTimeout(1200)
  const pedir = (op, payload) => page.evaluate(([op, payload]) => new Promise((r) =>
    chrome.runtime.sendMessage({ op, payload }, r)), [op, payload])
  const logins = (fn, args) => page.evaluate(async ([id, fn, args]) => {
    const l = await import(`chrome-extension://${id}/src/logins.js`)
    return l[fn](args).then((r) => ({ ok: true, ...r })).catch((e) => ({ ok: false, code: e.code, message: e.message }))
  }, [id, fn, args])
  return { ctx, dir, id, page, pedir, logins }
}

const USUARIO = 'ana'
const CLAVE = 'otra contraseña larga de verdad'
const SITIO = 'https://banco.example/login'

const A = await navegador('A')
const B = await navegador('B')

try {
  console.log('\nA: su bóveda propia, con algo dentro')
  const conv = await A.pedir('sealed-convert', { password: CLAVE_BOVEDA })
  ok(!conv?.error, 'A convierte su bóveda' + (conv?.error ? ` — ${conv.error.code}: ${conv.error.message}` : ''))
  const puesta = await A.pedir('put', { entry: {
    type: 'login', title: 'El banco', sites: ['banco.example'], username: 'ana@banco.example', secret: 'la-de-verdad',
  } })
  ok(!puesta?.error, 'A guarda la del banco' + (puesta?.error ? ` — ${puesta.error.code}: ${puesta.error.message}` : ''))

  console.log('\nA: un aparato de usuario y contraseña que puede pedir contraseñas, y la pestaña encendida')
  const alta = await A.logins('addLogin', { user: USUARIO, password: CLAVE, label: 'equipo prestado', caps: ['sign', 'read', 'store', 'passwords'] })
  ok(alta.ok && !!alta.address, 'se da de alta' + (alta.ok ? ` (${alta.address})` : ` — ${alta.code}: ${alta.message}`))
  const atiende = await A.logins('serveLogins', { proxyUrl: PROXY_URL })
  ok(atiende.ok, 'la pestaña de bóveda se enciende' + (atiende.ok ? '' : ` — ${atiende.code}: ${atiende.message}`))
  ok(atiende.passwords?.ok === true, 'y atiende las contraseñas de la bóveda propia' +
    (atiende.passwords?.ok ? '' : ` — ${atiende.passwords?.code}: ${atiende.passwords?.message}`))
  ok(atiende.passwords?.devices === 1, `a 1 aparato de la cuenta (dice ${atiende.passwords?.devices})`)
  ok(atiende.passwords?.rewrapped > 0, 'y le envolvió al recién llegado lo que ya había, sin pedir la frase')

  console.log('\nB: entra con usuario y contraseña')
  const entrada = await B.logins('enterWithPassword', { address: alta.address, password: CLAVE, remember: true, label: 'el cyber', proxyUrl: PROXY_URL })
  ok(entrada.ok, 'B entra' + (entrada.ok ? '' : ` — ${entrada.code}: ${entrada.message}`))
  const st = (await B.pedir('status'))?.result
  ok(st?.mode === 'linked', `su cuenta pide a la bóveda de A, no a una vacía de B (modo «${st?.mode}»)`)

  console.log('\nB usa lo que guardó A')
  const hallado = await B.pedir('find', { url: SITIO })
  const lista = hallado?.result || []
  ok(!hallado?.error, 'B pregunta qué hay para el banco' + (hallado?.error ? ` — ${hallado.error.code}: ${hallado.error.message}` : ''))
  ok(lista.length === 1 && lista[0].title === 'El banco', `y encuentra la de A (${lista.map((e) => e.title).join(', ') || 'nada'})`)

  // La contraseña es privada: A tiene que decir que sí, y la pregunta dice quién la pide.
  const pedida = B.pedir('get', { id: lista[0]?.id, keys: ['secret'] })
  const si = A.page.locator('[data-testid=approval-yes]')
  let pregunto = false
  try { await si.waitFor({ state: 'visible', timeout: 20000 }); pregunto = true } catch (_) {}
  ok(pregunto, 'A pregunta antes de soltar la contraseña')
  if (pregunto) {
    const quien = await A.page.locator('[data-testid=approval-device]').textContent().catch(() => '')
    ok(/equipo prestado/.test(quien || ''), `y dice quién la pide: «${quien}»`)
    await si.click()
  }
  const abierta = await pedida
  ok(abierta?.result?.secret === 'la-de-verdad',
    'B recibe la contraseña de A' + (abierta?.error ? ` — ${abierta.error.code}: ${abierta.error.message}` : ''))

  console.log('\nA ve lo que guarda B')
  const deB = await B.pedir('put', { entry: {
    type: 'login', title: 'El correo', sites: ['correo.example'], username: 'ana@correo.example', secret: 'la-del-correo',
  } })
  ok(!deB?.error, 'B guarda una nueva' + (deB?.error ? ` — ${deB.error.code}: ${deB.error.message}` : ''))
  const enA = (await A.pedir('find', { url: 'https://correo.example/' }))?.result || []
  ok(enA.length === 1 && enA[0].title === 'El correo', 'y está en la bóveda propia de A: es la misma')

} finally {
  await A.ctx.close()
  await B.ctx.close()
  await rm(A.dir, { recursive: true, force: true })
  await rm(B.dir, { recursive: true, force: true })
  try { await proxy.stop?.() } catch (_) {}
}

console.log(fallos.length ? `\nFALLARON ${fallos.length}` : '\nTODO BIEN')
process.exit(fallos.length ? 1 : 0)
