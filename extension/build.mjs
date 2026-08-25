// Copia `lib/src` dentro de la extensión. Una extensión MV3 solo puede importar de su
// propia carpeta, así que la librería viaja con ella. Se regenera, no se commitea.
import { cp, rm, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const vendor = join(here, 'src/vendor')

await rm(vendor, { recursive: true, force: true })
await mkdir(vendor, { recursive: true })

await cp(join(here, '../lib/src'), join(vendor, 'passmanager'), { recursive: true })
console.log('vendor: lib/src → extension/src/vendor/passmanager')

// El transporte del ecosistema viaja con la extensión: MV3 solo importa de su propia
// carpeta. Se toma del repo hermano mientras 0.12.0 no esté en npm — es la versión
// que sabe persistir la identidad en un service worker.
const proxySrc = join(here, '../../dotrino-proxy-client/src')
await cp(proxySrc, join(vendor, 'proxy-client'), { recursive: true })
console.log('vendor: dotrino-proxy-client/src → extension/src/vendor/proxy-client')
