// Arma el .zip que se sube a la Chrome Web Store.
//
// Incluye el `vendor/` (que no se commitea pero SÍ tiene que viajar: MV3 solo importa
// de la propia carpeta) y deja fuera lo que no es la extensión.

import { rm, mkdir, readFile } from 'node:fs/promises'
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
  'manifest.json', 'src', 'icons',
  '-x', '*.DS_Store', '*/test/*', 'src/vendor/*/test/*',
], { cwd: here })

// La versión va en el nombre del archivo (CONVENCIONES §11.5): así se sabe qué es cada
// zip en el disco sin abrirlo.
console.log('listo:', zip)
