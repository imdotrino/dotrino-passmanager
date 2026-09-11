// Arma el .zip que se sube a la Chrome Web Store.
//
// Incluye el `vendor/` (que no se commitea pero SÍ tiene que viajar: MV3 solo importa
// de la propia carpeta) y deja fuera lo que no es la extensión.

import { rm, mkdir, readFile, writeFile, readdir, cp } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(await readFile(join(here, 'manifest.json'), 'utf8'))
const salida = join(here, 'build')
const zip = join(salida, `dotrino-passmanager-${manifest.version}.zip`)

await rm(salida, { recursive: true, force: true })
await mkdir(salida, { recursive: true })

// El vendor tiene que estar fresco: es la librería y el transporte de verdad.
execFileSync('node', [join(here, 'build.mjs')], { stdio: 'inherit' })

execFileSync('zip', [
  '-r', '-q', zip,
  'manifest.json', 'src', 'icons', '_locales',
  '-x', '*.DS_Store', '*/test/*', 'src/vendor/*/test/*',
], { cwd: here })

// La versión va en el nombre del archivo (CONVENCIONES §11.5): así se sabe qué es cada
// zip en el disco sin abrirlo.
console.log('listo:', zip)

// Y se copia a la web, que es de donde se instala mientras no esté en la tienda. Si se
// quedara aquí, `npm run package` diría «listo» y la descarga seguiría sirviendo la
// versión anterior sin que nadie lo notara.
const appDir = join(here, '../web/app')
const enLaWeb = join(appDir, `dotrino-passmanager-${manifest.version}.zip`)
await mkdir(appDir, { recursive: true })
await cp(zip, enLaWeb)
console.log('y en la web:', enLaWeb)

// EL ENLACE DE DESCARGA, apuntado a este zip — y los anteriores, fuera.
//
// Copiar el zip no bastaba: el nombre lleva la versión (CONVENCIONES §11.5) y el enlace
// de la landing se escribía a mano, así que se quedaba atrás en silencio. Pasó: la página
// sirvió la 0.29.0 durante cinco versiones, y el que se la instalaba no veía el marcador
// en una casilla de contraseña vacía porque eso nació en la 0.32.0. Dos sitios que hay
// que acordarse de tocar son un sitio de más.
const landing = join(here, '../web/index.html')
const html = await readFile(landing, 'utf8')
const puesto = html.replace(
  /\.\/app\/dotrino-passmanager-\d+\.\d+\.\d+\.zip/g,
  `./app/dotrino-passmanager-${manifest.version}.zip`)
if (!puesto.includes(`dotrino-passmanager-${manifest.version}.zip`)) {
  throw new Error('la landing no tiene el enlace de descarga donde se esperaba')
}
if (puesto !== html) { await writeFile(landing, puesto); console.log('y la landing apunta a él') }

for (const f of await readdir(appDir)) {
  if (/^dotrino-passmanager-\d+\.\d+\.\d+\.zip$/.test(f) && f !== `dotrino-passmanager-${manifest.version}.zip`) {
    await rm(join(appDir, f)); console.log('fuera el viejo:', f)
  }
}

// Y EL CANAL PROPIO NO SE QUEDA ATRÁS. El `.crx` que se instala solo en los aparatos lo
// arma `crx.mjs`, que es otro comando porque necesita la llave de firma. Publicar el zip
// sin él dejaría `updates.xml` anunciando una versión vieja, y los aparatos no se
// enterarían de nada — que es exactamente lo que acaba de pasar con el enlace de descarga.
// Así que aquí se para y se dice, en vez de avisar y seguir.
const updates = await readFile(join(appDir, 'updates.xml'), 'utf8').catch(() => '')
const anunciada = updates.match(/<updatecheck[^>]*\sversion='([^']+)'/)?.[1]
if (anunciada && anunciada !== manifest.version) {
  console.error('\nEl canal propio se queda en %s y esto es %s.', anunciada, manifest.version)
  console.error('Arma también el .crx:  npm run crx   (o las dos cosas:  npm run release)')
  process.exit(1)
}
