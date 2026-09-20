// ENTRAR CON USUARIO Y CONTRASEÑA, desde la extensión y de punta a punta.
//
// Las piezas son de verdad, y es lo que hace que esto valga: un proxio del ecosistema
// levantado aquí al lado, una bóveda de verdad (`startDeviceVault` de `@dotrino/vault`)
// con un aparato de usuario y contraseña dado de alta, y la extensión cargada en un Chrome.
//
// Lo que prueba y no cubre ninguna prueba unitaria:
//
//   · que el OPAQUE del SANDBOX sirve también para entrar (el cliente del pilar lo acepta
//     inyectado desde 0.69.0, y aquí llega por `postMessage`);
//   · que lo que sale de la conversación cruza al service worker y ESTE NAVEGADOR PASA A
//     SER ese aparato — la mitad que no se puede hacer en la página, porque el núcleo de
//     identidad vive en el worker;
//   · que sin «Recordar» la cuenta entra como cuenta de paso.
//
// El proxio y la bóveda corren en ESTE proceso; Chrome se conecta a ellos por ws://.
//
//   npm run test:login
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const EXT = join(here, '..')
const req = createRequire(join(here, '../../../dotrino-vault/test/x.mjs'))

process.env.NODE_ENV = 'test'
process.env.PROXY_DB_FILE = ':memory:'
process.env.PORT = '0'
const proxy = req('../../dotrino-proxy/server.js')
const puerto = await proxy.start(0)
const PROXY_URL = `ws://127.0.0.1:${puerto}`

// Los pilares se toman del repo del VAULT, que es donde están instalados: este repo no
// depende de `@dotrino/opaque` (su copia viaja dentro de la extensión, vendorizada). Se
// resuelven por ruta a propósito, para no añadirle dependencias de prueba al gestor.
const V = (p) => join(here, '../../../dotrino-vault/', p)
const N = (p) => V('node_modules/' + p)
const { makeDeviceKey, makeDeviceEncKey, signDelegationWith, pubkeyId } = await import(N('@dotrino/identity/vault/capabilities.js'))
const { genesisActa, sealActa, applyChanges } = await import(N('@dotrino/identity/vault/acta.js'))
// El proxio verifica sobre la serialización CANÓNICA, no sobre `JSON.stringify`: firmar
// con la otra da «Firma identify inválida», que no dice nada de la causa.
const { canonicalStringify } = await import(N('@dotrino/identity/vault/core.js'))
const { client: opaqueClient } = await import(N('@dotrino/opaque/src/index.js'))
const { startDeviceVault } = await import(V('lib/src/index.js'))
const { createLoginDesk, sealDeviceKeys, accountCode } = await import(V('lib/src/passwordLogins.js'))
const { WebSocketProxyClient } = await import(N('@dotrino/proxy-client/src/index.js'))

const fallos = []
const ok = (c, m) => { console.log((c ? '  ok    ' : '  FALLA ') + m); if (!c) fallos.push(m) }

/** La bóveda: identidad con acta de verdad, porque quien entra la verifica entera. */
async function laBoveda () {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const iss = JSON.stringify(await crypto.subtle.exportKey('jwk', pair.publicKey))
  let acta = await sealActa({ acta: genesisActa({ pub: iss, label: 'la bóveda' }), privateKey: pair.privateKey })
  const issued = []; const revoked = []
  const identity = {
    me: { publickey: iss, encryptionPubkey: null },
    iss,
    get acta () { return acta },
    async profileActa () { return { acta, isMaster: true } },
    async admitMember ({ pub, encPub = null, label = '', cn = null, caps = [] }) {
      const next = await applyChanges(acta, [{ op: 'admit', member: { pub, ...(encPub ? { encPub } : {}), label, ...(cn ? { cn } : {}), caps } }], { by: iss })
      acta = await sealActa({ acta: next, privateKey: pair.privateKey })
      return { ok: true, seq: acta.seq }
    },
    async signDelegation (sub, scope, { label = '' } = {}) {
      const cert = await signDelegationWith(pair.privateKey, iss, { sub, scope, iat: Date.now(), seq: acta.seq, nonce: crypto.randomUUID() })
      issued.push({ nonce: cert.nonce, sub, scope, label })
      return { cert }
    },
    async signData (data) {
      const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: { name: 'SHA-256' } }, pair.privateKey, new TextEncoder().encode(canonicalStringify(data)))
      return { signature: Buffer.from(new Uint8Array(sig)).toString('base64'), publickey: iss }
    },
    async listDelegations () { return { issued, revoked } },
    async revokeDelegation (nonce) { revoked.push({ nonce }); return { ok: true, nonce } }
  }

  const client = new WebSocketProxyClient({ url: PROXY_URL, enableWebRTC: false, autoReconnect: false })
  await client.connect()
  let guardado = null
  const logins = createLoginDesk({ load: () => (guardado ? JSON.parse(guardado) : null), save: (s) => { guardado = JSON.stringify(s) } })
  const vault = await startDeviceVault(identity, { client, logins })
  return { identity, client, vault }
}

const USUARIO = 'ana'
const CLAVE = 'una contraseña larga de verdad'

const { identity, client, vault } = await laBoveda()
// El alta, como la hace la consola: las llaves NACEN en la bóveda y salen cerradas con
// lo que deriva de la contraseña.
const device = await makeDeviceKey({ label: 'equipo prestado' })
const enc = await makeDeviceEncKey()
const reg = opaqueClient.registrationStart({ password: CLAVE })
const { response } = await vault.loginRegisterBegin({ user: USUARIO, request: reg.request })
const fin = opaqueClient.registrationFinish({ state: reg.state, response, password: CLAVE })
await vault.loginRegisterFinish({
  user: USUARIO, upload: fin.upload, pub: device.publickey, encPub: enc.encPublickey,
  label: 'equipo prestado', blob: await sealDeviceKeys(fin.exportKey, { sign: device.privateJwk, enc: enc.encPrivateJwk })
})
const DIR = `${USUARIO}@${accountCode((await pubkeyId(identity.acta.profileId)).slice(0, 16))}`
console.log(`  (bóveda en ${PROXY_URL}, dirección ${DIR})`)

// --- y ahora Chrome ----------------------------------------------------------
const _pw = await import(process.env.PLAYWRIGHT || 'playwright')
const chromium = _pw.chromium || _pw.default?.chromium
const perfil = await mkdtemp(join(tmpdir(), 'pm-login-'))
const ctx = await chromium.launchPersistentContext(perfil, {
  headless: false,
  args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
  viewport: { width: 900, height: 820 },
})
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 })
const extId = new URL(sw.url()).host

const page = await ctx.newPage()
page.on('pageerror', (e) => console.log('   [error de página]', e.message))
await page.goto(`chrome-extension://${extId}/src/manager.html#view=login`)
await page.waitForTimeout(1200)

ok(await page.locator('[data-testid=login-address]').isVisible(), 'la pantalla de entrar existe y se llega por #view=login')

const antes = await page.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ op: 'status' }, (x) => r(x?.result))))

// La dirección y la contraseña, como las teclea una persona. El proxio de prueba se pasa
// por el mismo parámetro que ya existía: la pantalla usa el del ecosistema.
const entrada = await page.evaluate(async ([id, address, password, url]) => {
  const logins = await import(`chrome-extension://${id}/src/logins.js`)
  return logins.enterWithPassword({ address, password, remember: false, label: 'el cyber', proxyUrl: url })
    .then((r) => ({ ok: true, ...r }))
    .catch((e) => ({ ok: false, code: e.code, message: e.message }))
}, [extId, DIR, CLAVE, PROXY_URL])

ok(entrada.ok, 'se entra desde la extensión' + (entrada.ok ? '' : ` — ${entrada.code}: ${entrada.message}`))
ok(entrada.user === USUARIO, `entró como «${entrada.user}»`)

const despues = await page.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ op: 'status' }, (x) => r(x?.result))))
ok(despues?.active && despues.active !== antes?.active, 'el perfil ACTIVO de la extensión es el de la cuenta a la que se entró')
const activo = (despues?.profiles || []).find((p) => p.current)
ok(!!activo?.login, 'y se marca como inicio de sesión, que es lo que pone «Salir» en el menú del perfil')
ok(activo?.login?.volatile === true, 'sin «Recordar», es una cuenta de paso')

ok(vault.listLogins().find((l) => l.user === USUARIO)?.sessions.length === 1,
  'la bóveda anotó la sesión abierta (es lo que se cierra desde la consola)')

// Y la contraseña equivocada no entra, ni deja el perfil a medias.
const mala = await page.evaluate(async ([id, address, url]) => {
  const logins = await import(`chrome-extension://${id}/src/logins.js`)
  return logins.enterWithPassword({ address, password: 'no es esa', proxyUrl: url })
    .then(() => ({ ok: true })).catch((e) => ({ ok: false, code: e.code }))
}, [extId, DIR, PROXY_URL])
ok(!mala.ok && mala.code === 'login-failed', 'la contraseña equivocada se para con `login-failed`')

// SALIR: la cuenta se va de este navegador y la bóveda suelta la plaza.
const salida = await page.evaluate(async (id) => {
  const logins = await import(`chrome-extension://${id}/src/logins.js`)
  return logins.leaveLogin().then((r) => ({ ok: true, ...r })).catch((e) => ({ ok: false, code: e.code, message: e.message }))
}, extId)
ok(salida.ok, 'se sale' + (salida.ok ? '' : ` — ${salida.code}: ${salida.message}`))
const final = await page.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ op: 'status' }, (x) => r(x?.result))))
ok(!(final?.profiles || []).some((p) => p.id === despues.active), 'y la cuenta de paso no queda en el navegador')
ok(vault.listLogins().find((l) => l.user === USUARIO)?.sessions.length === 0, 'la bóveda soltó la plaza')

await ctx.close()
await rm(perfil, { recursive: true, force: true })
try { client.close() } catch (_) {}
try { await proxy.stop?.() } catch (_) {}
console.log(fallos.length ? `\nFALLARON ${fallos.length}` : '\nTODO BIEN')
process.exit(fallos.length ? 1 : 0)
