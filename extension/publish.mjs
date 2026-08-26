// Sube y publica la extensión en la Chrome Web Store por su API.
//
// La subida a mano es lenta y se hace mal: el zip equivocado, la versión sin subir, la
// ficha a medias. Esto lo deja en un comando. Lo que NO puede hacer es crear la cuenta
// de desarrollador (pago único de 5 USD) ni aceptar los términos: eso es del dueño y se
// hace una vez.
//
// Hacen falta tres valores, que salen de un proyecto de Google Cloud con la
// «Chrome Web Store API» activada:
//
//   CHROME_CLIENT_ID, CHROME_CLIENT_SECRET, CHROME_REFRESH_TOKEN
//
// Y el id de la extensión, que ya está creada:
//
//   CHROME_EXTENSION_ID=iheeephdbjdpgfhkhmfnpgbhmdflplpp
//
// Cómo se sacan, la primera vez:
//   1. console.cloud.google.com → proyecto nuevo → activar «Chrome Web Store API»
//   2. Credenciales → ID de cliente de OAuth → tipo «Aplicación de escritorio»
//   3. Autorizar una vez con scope https://www.googleapis.com/auth/chromewebstore
//      y canjear el código por un refresh_token
//
// Uso:
//   node publish.mjs            # sube el zip como borrador
//   node publish.mjs --publish  # sube y PUBLICA (queda a la vista de todos)

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(await readFile(join(here, 'manifest.json'), 'utf8'))
const zipPath = join(here, 'build', `dotrino-passmanager-${manifest.version}.zip`)

const {
  CHROME_CLIENT_ID: clientId,
  CHROME_CLIENT_SECRET: clientSecret,
  CHROME_REFRESH_TOKEN: refreshToken,
  CHROME_EXTENSION_ID: extensionId,
} = process.env

const faltan = Object.entries({
  CHROME_CLIENT_ID: clientId,
  CHROME_CLIENT_SECRET: clientSecret,
  CHROME_REFRESH_TOKEN: refreshToken,
  CHROME_EXTENSION_ID: extensionId,
}).filter(([, v]) => !v).map(([k]) => k)

if (faltan.length) {
  console.error('Faltan credenciales de la tienda: %s', faltan.join(', '))
  console.error('Cómo sacarlas: la cabecera de este archivo. Se hace una vez.')
  process.exit(1)
}

const zip = await readFile(zipPath).catch(() => null)
if (!zip) {
  console.error('No encuentro %s — corre antes: npm run package', zipPath)
  process.exit(1)
}

/** El refresh token no caduca; el de acceso dura una hora y se pide en cada corrida. */
async function accessToken () {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })
  const j = await r.json()
  if (!r.ok || !j.access_token) throw new Error('no se pudo renovar el token: ' + JSON.stringify(j))
  return j.access_token
}

const token = await accessToken()

const subida = await fetch(
  `https://www.googleapis.com/upload/chromewebstore/v1.1/items/${extensionId}`,
  {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'x-goog-api-version': '2' },
    body: zip,
  })
const resultado = await subida.json()

// `uploadState` puede ser SUCCESS, IN_PROGRESS o FAILURE — y FAILURE llega con 200,
// así que mirar solo el código HTTP diría que fue bien cuando no.
if (resultado.uploadState === 'FAILURE') {
  console.error('La tienda rechazó el paquete:')
  for (const e of resultado.itemError || []) console.error('  · %s', e.error_detail || e.error_code)
  process.exit(1)
}
console.log('Subido: %s v%s (%s)', extensionId, manifest.version, resultado.uploadState)

if (!process.argv.includes('--publish')) {
  console.log('Queda como BORRADOR. Para publicarlo: node publish.mjs --publish')
  process.exit(0)
}

const pub = await fetch(
  `https://www.googleapis.com/chromewebstore/v1.1/items/${extensionId}/publish`,
  { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'x-goog-api-version': '2', 'Content-Length': '0' } })
const pr = await pub.json()

if (!pub.ok) {
  console.error('No se pudo publicar: %s', JSON.stringify(pr))
  process.exit(1)
}
console.log('Publicado. Estado: %s', (pr.status || []).join(', ') || '(sin estado)')
for (const d of pr.statusDetail || []) console.log('  · %s', d)
console.log('La revisión de una extensión de credenciales tarda; se avisa por correo.')
