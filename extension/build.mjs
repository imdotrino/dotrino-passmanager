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

// Un navegador no resuelve imports desnudos: los de los pilares pasan a ser las
// copias que viajan al lado.
const sealedPath = join(vendor, 'passmanager/transport/sealed.js')
const sealed = await readFile(sealedPath, 'utf8')
await writeFile(sealedPath, sealed.replace(
  "from '@dotrino/proxy-client/sealing'", "from '../../proxy-client/sealing.js'"))

// El transporte del ecosistema viaja con la extensión: MV3 solo importa de su propia
// carpeta. Se toma del repo hermano mientras 0.12.0 no esté en npm — es la versión
// que sabe persistir la identidad en un service worker.
const proxySrc = join(here, '../../dotrino-proxy-client/src')
await cp(proxySrc, join(vendor, 'proxy-client'), { recursive: true })
console.log('vendor: dotrino-proxy-client/src → extension/src/vendor/proxy-client')

// La INVITACIÓN de emparejamiento la lee el parser del ecosistema (`@dotrino/vault`),
// que entiende todas las formas que imprime una bóveda —enlace del QR, código compacto,
// base64url, el JSON viejo—. Escribir aquí otro parser sería tener dos ideas distintas
// de qué es una invitación, que es justo lo que se acaba de quitar.
await mkdir(join(vendor, 'vault'), { recursive: true })
await cp(join(here, '../../dotrino-vault/lib/src/invite.js'), join(vendor, 'vault/invite.js'))
console.log('vendor: dotrino-vault/lib/src/invite.js → extension/src/vendor/vault/invite.js')

// LA BARRA SUPERIOR del ecosistema (CONVENCIONES §5). Viaja con la extensión, como todo
// lo demás: MV3 solo importa de su propia carpeta.
//
// Y se le quita UNA cosa al vendorizarla. `@dotrino/support` cuenta las aperturas de la
// app contra `store.dotrino.com`, y para llegar al store cae a un `import()` de jsDelivr
// cuando el especificador desnudo no resuelve — que en una extensión es SIEMPRE. Eso es
// código remoto: MV3 lo bloquea por CSP (`script-src 'self'`), así que ni siquiera
// correría, y la Chrome Web Store rechaza por ello. Aparte, un gestor de contraseñas que
// avisa a un servidor cada vez que lo abres contradice lo que promete su propia página.
//
// Se sustituye por un no-op. Lo que se publica no lleva ni la URL ni el `import()`.
await mkdir(join(vendor, 'topbar'), { recursive: true })
await cp(join(here, '../../dotrino-topbar/src/index.js'), join(vendor, 'topbar/index.js'))
await cp(join(here, '../../dotrino-nav/src'), join(vendor, 'nav'), { recursive: true })
await cp(join(here, '../../dotrino-support/src'), join(vendor, 'support'), { recursive: true })
console.log('vendor: dotrino-{topbar,nav,support}/src → extension/src/vendor/')

// Los imports desnudos del topbar pasan a ser las copias que viajan al lado. Y se borra
// la línea de EJEMPLO que enseña cómo cargarlo por jsDelivr: es un comentario y no se
// ejecuta, pero un escaneo automático de la tienda no distingue comentarios de código, y
// no vale la pena dejar una pregunta que no hace falta contestar.
const topbarPath = join(vendor, 'topbar/index.js')
await writeFile(topbarPath, (await readFile(topbarPath, 'utf8'))
  .replace("from '@dotrino/nav'", "from '../nav/index.js'")
  .replace("import '@dotrino/support'", "import '../support/index.js'")
  .replace("from '@dotrino/identity/avatar'", "from '../identity/avatar.js'")
  .split('\n').filter((l) => !l.includes('cdn.jsdelivr')).join('\n'))

// Y fuera el contador de aperturas, con su import remoto.
const supportPath = join(vendor, 'support/index.js')
const support = await readFile(supportPath, 'utf8')
const remoto = `const _STORE_CDN = 'https://cdn.jsdelivr.net/npm/@dotrino/store@0.4/src/index.js'
async function _loadStore() {
  try { return await import('@dotrino/store') }
  catch { return await import(/* @vite-ignore */ _STORE_CDN) }
}
function recordAppOpen(appId) {
  if (!appId || _openRecorded.has(appId)) return
  _openRecorded.add(appId)
  _loadStore()
    .then((mod) => mod.Store.connect())
    .then((store) => store.recordOpen(appId))
    .catch(() => { /* store no disponible (offline, bloqueado…): best-effort */ })
}`
if (!support.includes(remoto)) {
  throw new Error('support: el contador de aperturas cambió de forma; revisa el recorte del vendor')
}
await writeFile(supportPath, support.replace(remoto,
  `// RECORTADO AL VENDORIZAR (extension/build.mjs): aquí no hay contador de aperturas.
// Llegaba al store por un import() de jsDelivr, que es código remoto — MV3 lo bloquea y
// la tienda lo rechaza —, y de paso avisaba a un servidor cada vez que se abre un gestor
// de contraseñas. Lo que se publica no lleva ni la URL ni el import.
function recordAppOpen() {}`))
console.log('vendor: support sin el contador de aperturas (nada de código remoto)')

// El sellado extremo a extremo es de @dotrino/identity (la misma cripto que usa el
// vault para los secretos sellados). No se reescribe: viaja.
await mkdir(join(vendor, 'identity'), { recursive: true })
await cp(join(here, '../../dotrino-identity/vault/content.js'), join(vendor, 'identity/content.js'))
console.log('vendor: dotrino-identity/vault/content.js → extension/src/vendor/identity/content.js')

// El NÚCLEO de identidad, para que cada perfil tenga su llave de verdad (acta,
// delegaciones, certificados). Se vendoriza el núcleo, NO la clase `Identity`: esa monta
// un iframe contra id.dotrino.com y un service worker no tiene DOM.
for (const f of ['core.js', 'acta.js', 'capabilities.js', 'remote.js', 'keyid.js', 'avatar.js']) {
  await cp(join(here, '../../dotrino-identity/vault/', f), join(vendor, 'identity/', f))
}

// Un service worker no admite `import()` DINÁMICO (lo prohíbe la especificación, no
// Chrome). El núcleo lo usa para cargar el transporte perezosamente, que en una página
// es lo correcto; aquí se convierte en estático y apuntando a la copia que viaja.
for (const f of ['core.js', 'remote.js']) {
  const at = join(vendor, 'identity/', f)
  const code = await readFile(at, 'utf8')
  if (!code.includes("await import('@dotrino/proxy-client')")) continue
  await writeFile(at,
    "import * as __proxy from '../proxy-client/index.js'\n" +
    code.replace(/await import\('@dotrino\/proxy-client'\)/g, '__proxy'))
}
console.log('vendor: dotrino-identity/vault/{core,acta,capabilities,remote,keyid,avatar}.js')

// `@dotrino/identity` es peer dependency del sellado: en el navegador se le entrega la
// copia que viaja, en vez de que intente resolver un import desnudo.
const sealingPath = join(vendor, 'proxy-client/sealing.js')
const sealing = await readFile(sealingPath, 'utf8')
await writeFile(sealingPath,
  "import * as __identityContent from '../identity/content.js'\n" +
  sealing.replace(
    "let primitives = null",
    "let primitives = __identityContent"))
