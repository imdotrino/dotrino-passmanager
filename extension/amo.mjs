// Sube la extensión a la tienda de Firefox (addons.mozilla.org, AMO). Es EL MISMO zip que
// va a la Chrome Web Store (`npm run package`): el manifiesto sirve a los dos navegadores, y
// Vivaldi para Android lo instala desde la Chrome Web Store.
//
// Firefox para Android solo instala extensiones firmadas por AMO y publicadas en su listado.
//
// Hacen falta las credenciales de la API de AMO (addons.mozilla.org → Herramientas →
// Administrar claves de API), que son del dueño:
//
//   AMO_JWT_ISSUER, AMO_JWT_SECRET
//
// La primera vez la ficha se crea a mano en AMO (nombre, categoría, que es compatible con
// Android). AMO pide además el código fuente del WASM de OPAQUE: es `dotrino-opaque`
// (público, MIT), y se adjunta su enlace en la revisión.
//
// Uso:
//   node amo.mjs              # sube y firma en el canal listado (pasa por revisión)

import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(await readFile(join(here, 'manifest.json'), 'utf8'))
const zip = join(here, 'build', `dotrino-passmanager-${manifest.version}.zip`)

const { AMO_JWT_ISSUER: issuer, AMO_JWT_SECRET: secret } = process.env
if (!issuer || !secret) {
  console.error('Missing AMO credentials: AMO_JWT_ISSUER, AMO_JWT_SECRET (see the header of this file)')
  process.exit(1)
}
if (!(await readFile(zip).catch(() => null))) {
  console.error('%s not found — run first: npm run package', zip)
  process.exit(1)
}

// web-ext firma una carpeta, no un zip: se desempaqueta el MISMO zip de la Chrome Web Store.
const dir = await mkdtemp(join(tmpdir(), 'pm-amo-'))
try {
  execFileSync('unzip', ['-q', zip, '-d', dir], { stdio: 'inherit' })
  // Las claves van por el entorno, no por argumentos: un argumento se ve en `ps`.
  execFileSync('npx', ['--yes', 'web-ext@8.10.0', 'sign',
    '--source-dir', dir, '--artifacts-dir', join(here, 'build'),
    '--channel', 'listed',
  ], { stdio: 'inherit', env: { ...process.env, WEB_EXT_API_KEY: issuer, WEB_EXT_API_SECRET: secret } })
} finally {
  await rm(dir, { recursive: true, force: true })
}
