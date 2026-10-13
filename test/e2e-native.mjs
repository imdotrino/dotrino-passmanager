// Arnés de punta a punta para las apps NATIVAS del gestor: levanta un PROXIO y una BÓVEDA de
// verdad (los de los repos hermanos), enrola una llave de aparato «del teléfono», le da el
// permiso `passwords` y deja las contraseñas en el formato sellado, con la llave del perfil
// repartida. Lo usan la prueba JVM (`android/…/VaultE2eTest`) y la app de depuración en el
// emulador (`android/app/src/debug`), que arrancan con esa llave en software.
//
//   node test/e2e-native.mjs <salida.json>
//   E2E_HOST=10.0.2.2 node test/e2e-native.mjs <salida.json>   (para el emulador de Android)
//
// Con E2E_APPROVER=1 hay un segundo aparato con `approve`, así que leer algo privado queda
// PENDIENTE (aquí nadie lo aprueba: sirve para ver la espera y su vencimiento en la app).
// Se cierra solo a los E2E_MINUTES minutos (por defecto 10).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const out = process.argv[2]
if (!out) { console.error('usage: e2e-native.mjs <out.json>'); process.exit(2) }
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '../..')
const require = createRequire(import.meta.url)
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), n))
const log = process.env.VAULT_LOG ? console.error : () => {}

process.env.NODE_ENV = 'test'
process.env.PROXY_DB_FILE = ':memory:'
process.env.DOTRINO_VAULT_NOTICE_MS = '150'

const proxy = require(path.join(root, 'dotrino-proxy/server.js'))
const port = await proxy.start(0)
const local = `ws://127.0.0.1:${port}`

const { startVault } = await import(path.join(root, 'dotrino-vault/src/vault.js'))
const { parseInvite } = await import(path.join(root, 'dotrino-vault/lib/src/invite.js'))
const idv = path.join(root, 'dotrino-identity/vault')
const { makeDeviceKey, makeDeviceEncKey } = await import(path.join(idv, 'capabilities.js'))
const { enrollDevice } = await import(path.join(idv, 'remote.js'))

const vault = await startVault({ dir: tmp('pm-native-e2e-'), proxyUrl: local, log })

async function enroll (label, caps) {
  const dev = await makeDeviceKey({ label })
  const enc = await makeDeviceEncKey()
  const priv = await crypto.subtle.importKey('jwk', dev.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const sign = async (t) => Buffer.from(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, new TextEncoder().encode(t))).toString('base64')
  const inv = await vault.startPairing({ scope: ['vault:sign'], label, ttlMs: 120_000, account: 'Cuenta E2E' })
  const enrolled = await enrollDevice({
    qr: typeof inv.qr === 'string' ? parseInvite(inv.qr) : inv.qr,
    device: { publickey: dev.publickey, sign }, encPub: enc.encPublickey, label,
    onChallenge: ({ code }) => { vault.approveDevice(code).catch((e) => console.error('approve failed', e)) },
  })
  await vault.setCaps(dev.publickey, caps)
  return { dev, enc, enrolled }
}

// El teléfono: un aparato del acta con `passwords`, como la extensión.
const phone = await enroll('phone-native', ['sign', 'passwords', 'passkeys'])
// Con un aprobador en el acta, lo privado se pide; sin ninguno, se entrega (regla del dueño).
if (process.env.E2E_APPROVER) await enroll('approver', ['sign', 'approve'])

// La copia de recuperación nace al estrenar un cajón; con ella, la mesa de contraseñas puede
// sellar. La mesa se levanta sola en cuanto el acta tiene un aparato con `passwords`.
await vault.vars.recipients({ ns: 'e2e' })
let sealed = null
for (let i = 0; i < 60 && !sealed; i++) {
  sealed = await vault.sealPasswords()
  if (!sealed) await new Promise((r) => setTimeout(r, 500))
}
if (!sealed || sealed.convertError) throw new Error('the vault could not seal its passwords: ' + JSON.stringify(sealed))

fs.writeFileSync(out, JSON.stringify({
  proxyUrl: `ws://${process.env.E2E_HOST || '127.0.0.1'}:${port}`,
  master: phone.enrolled.master, cert: phone.enrolled.cert, deviceId: phone.enrolled.deviceId,
  // Las públicas TAL CUAL las escribe el pilar: el acta y el papel las comparan como texto.
  publickey: phone.dev.publickey, encPub: phone.enc.encPublickey,
  privateJwk: phone.dev.privateJwk, encPrivateJwk: phone.enc.encPrivateJwk,
}))
console.log('ready', out, JSON.stringify(sealed))

setTimeout(async () => {
  try { vault.close() } catch (_) {}
  try { await proxy.stop() } catch (_) {}
  process.exit(0)
}, Number(process.env.E2E_MINUTES || 10) * 60_000)
