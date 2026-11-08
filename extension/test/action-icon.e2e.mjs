// EL ICONO DE LA EXTENSIÓN ES EL DEL PERFIL ACTIVO, y cambia al cambiar de perfil (dueño,
// 2026-11-08). Se espía `chrome.action.setIcon` en el service worker y se compara lo que
// pinta con dos perfiles distintos.
//
//   npm run test:action-icon
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const { chromium } = await import('playwright')
const EXT = join(dirname(fileURLToPath(import.meta.url)), '..')
const perfil = await mkdtemp(join(tmpdir(), 'pm-icon-'))
const ctx = await chromium.launchPersistentContext(perfil, {
  headless: false,
  args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
})
const fallos = []
const ok = (c, m) => { console.log((c ? '  ok    ' : '  FAIL  ') + m); if (!c) fallos.push(m) }
try {
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 })
  const id = new URL(sw.url()).host
  await sw.evaluate(() => {
    globalThis.__icons = []
    const real = chrome.action.setIcon.bind(chrome.action)
    // Una huella de los píxeles de 16 px: dos perfiles distintos, dos huellas distintas.
    chrome.action.setIcon = (d) => {
      const px = d.imageData?.[16]?.data
      globalThis.__icons.push(px ? Array.from(px).reduce((h, b) => (h * 31 + b) >>> 0, 7) : 'path')
      return real(d)
    }
  })
  const page = await ctx.newPage()
  await page.goto(`chrome-extension://${id}/src/popup.html`)
  const ask = (op, payload) => page.evaluate(([op, payload]) =>
    new Promise((res) => chrome.runtime.sendMessage({ op, payload }, (r) => res(r))), [op, payload])
  const icons = () => sw.evaluate(() => globalThis.__icons.slice())
  const wait = async (n) => { for (let i = 0; i < 50 && (await icons()).length < n; i++) await page.waitForTimeout(100) }

  const current = async () => (await ask('profiles')).result.find((p) => p.current)
  const seen = new Map()   // perfil → huella de su icono
  const step = async (op, payload) => {
    const n = (await icons()).length
    await ask(op, payload)
    await wait(n + 1)
    const all = await icons()
    ok(all.length > n && typeof all.at(-1) === 'number', `${op}: el icono se vuelve a pintar, con píxeles`)
    const cur = await current()
    return { id: cur.id, icon: all.at(-1) }
  }

  ok(!!(await current())?.pubkey, 'hay un perfil activo con su pública')
  const a = await step('profile-add', { label: 'Uno' })
  const b = await step('profile-add', { label: 'Dos' })
  ok(a.id !== b.id && a.icon !== b.icon, 'dos perfiles, dos dibujos')
  seen.set(a.id, a.icon); seen.set(b.id, b.icon)
  const back = await step('profile-use', { id: a.id })
  ok(back.id === a.id && back.icon === seen.get(a.id), 'al volver a un perfil, vuelve su dibujo')
} finally {
  await ctx.close()
  await rm(perfil, { recursive: true, force: true })
}
console.log(fallos.length ? `\n${fallos.length} FAILED` : '\nALL GOOD')
process.exit(fallos.length ? 1 : 0)
