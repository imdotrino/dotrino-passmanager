// Copia `lib/src` dentro de la extensión. Una extensión MV3 solo puede importar de su
// propia carpeta, así que la librería viaja con ella. Se regenera, no se commitea.
import { cp, rm, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const vendor = join(here, 'src/vendor')

await rm(vendor, { recursive: true, force: true })
await mkdir(vendor, { recursive: true })

await cp(join(here, '../lib/src'), join(vendor, 'passmanager'), { recursive: true })
console.log('vendor: lib/src → extension/src/vendor/passmanager')

// Un navegador no resuelve imports desnudos: `@dotrino/identity/content` pasa a ser
// la copia que viaja al lado.
const sealedPath = join(vendor, 'passmanager/transport/sealed.js')
const sealed = await readFile(sealedPath, 'utf8')
await writeFile(sealedPath, sealed.replace(
  "from '@dotrino/identity/content'", "from '../../identity/content.js'"))

// El transporte del ecosistema viaja con la extensión: MV3 solo importa de su propia
// carpeta. Se toma del repo hermano mientras 0.12.0 no esté en npm — es la versión
// que sabe persistir la identidad en un service worker.
const proxySrc = join(here, '../../dotrino-proxy-client/src')
await cp(proxySrc, join(vendor, 'proxy-client'), { recursive: true })
console.log('vendor: dotrino-proxy-client/src → extension/src/vendor/proxy-client')

// El sellado extremo a extremo es de @dotrino/identity (la misma cripto que usa el
// vault para los secretos sellados). No se reescribe: viaja.
await mkdir(join(vendor, 'identity'), { recursive: true })
await cp(join(here, '../../dotrino-identity/vault/content.js'), join(vendor, 'identity/content.js'))
console.log('vendor: dotrino-identity/vault/content.js → extension/src/vendor/identity/content.js')
