// Copia `lib/src` dentro de la extensión. Una extensión MV3 solo puede importar de su
// propia carpeta, así que la librería viaja con ella. Se regenera, no se commitea.
import { cp, rm, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dest = join(here, 'src/vendor/passmanager')

await rm(dest, { recursive: true, force: true })
await mkdir(dest, { recursive: true })
await cp(join(here, '../lib/src'), dest, { recursive: true })
console.log('vendor: lib/src → extension/src/vendor/passmanager')
