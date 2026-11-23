// EL PUNTO DEL TOPBAR en las páginas de la extensión: dice si la bóveda contesta, como en
// el resto del ecosistema. Un perfil propio (la bóveda es esta extensión) sale gris,
// «solo en este navegador», y el menú lleva a adoptar la cuenta de una bóveda.
//
//   node extension/test/topbar-led.e2e.mjs
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const _pw = await import(process.env.PLAYWRIGHT || 'playwright')
const chromium = _pw.chromium || _pw.default?.chromium

const EXT = join(dirname(fileURLToPath(import.meta.url)), '..')
const perfil = await mkdtemp(join(tmpdir(), 'pm-led-'))
const ctx = await chromium.launchPersistentContext(perfil, {
  headless: false,
  args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
})
const fallos = []
const ok = (c, m) => { console.log((c ? '  ok    ' : '  FAIL  ') + m); if (!c) fallos.push(m) }
try {
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 })
  const id = new URL(sw.url()).host
  for (const pagina of ['manager', 'popup', 'profile']) {
    const p = await ctx.newPage()
    p.on('pageerror', (e) => console.log('   [page error]', e.message))
    await p.goto(`chrome-extension://${id}/src/${pagina}.html`)
    const dot = p.locator('dotrino-topbar [data-testid=backup-dot]')
    await dot.waitFor({ state: 'attached', timeout: 10000 })
    await p.waitForFunction(() => document.querySelector('dotrino-topbar')?.shadowRoot?.querySelector('[data-testid=backup-dot]')?.getAttribute('data-backup'), null, { timeout: 10000 })
    const nivel = await dot.getAttribute('data-backup')
    const visible = await dot.isVisible()
    ok(visible && nivel === 'local', `${pagina}: punto visible y gris (data-backup=${nivel}, visible=${visible})`)
    const href = await p.locator('dotrino-topbar').getAttribute('profile-vault-href')
    ok(href?.endsWith('/src/profile.html#adopt'), `${pagina}: «Enlazar a mi bóveda» lleva a adoptar (${href})`)
    await p.close()
  }
} finally {
  await ctx.close()
  await rm(perfil, { recursive: true, force: true })
}
if (fallos.length) { console.log(`\n${fallos.length} fallo(s)`); process.exit(1) }
console.log('\ntodo bien')
