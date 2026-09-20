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

// LAS CONTRASEÑAS SELLADAS usan la cripto de los sobres de `@dotrino/identity`. El
// especificador desnudo no resuelve en un navegador, así que apunta a la copia que viaja
// al lado — la misma que ya usa el sellado del transporte.
for (const f of ['entry.js', 'device.js', 'store.js']) {
  const ruta = join(vendor, 'passmanager/sealed/', f)
  const txt = await readFile(ruta, 'utf8')
  await writeFile(ruta, txt.replace(
    "from '@dotrino/identity/content'", "from '../../identity/content.js'"))
}
console.log('vendor: sealed/* → la copia de @dotrino/identity/content')

// ENTRAR CON USUARIO Y CONTRASEÑA, dentro de la extensión: el mostrador del ecosistema
// (`@dotrino/vault`) y el OPAQUE que comprueba la contraseña sin verla.
//
// El OPAQUE es WASM —sale de `opaque-ke`, que es Rust— y MV3 bloquea instanciarlo con su
// CSP por defecto. Por eso el manifiesto declara `'wasm-unsafe-eval'`: NO habilita `eval()`
// de JavaScript ni código remoto, solo deja instanciar el módulo que ya viaja aquí dentro
// (`build/wasm-bytes.js`, dentro del propio JS).
for (const f of ['passwordLogins.js', 'enroll.js', 'protocol.js', 'index.js']) {
  await cp(join(here, '../../dotrino-vault/lib/src/', f), join(vendor, 'vault/', f))
}
await cp(join(here, '../../dotrino-opaque/src/index.js'), join(vendor, 'opaque/index.js'))
await mkdir(join(vendor, 'opaque/build'), { recursive: true })
for (const f of ['opaque.js', 'wasm-bytes.js']) {
  await cp(join(here, '../../dotrino-opaque/build/', f), join(vendor, 'opaque/build/', f))
}
console.log('vendor: @dotrino/{vault,opaque} → extension/src/vendor/ (usuario y contraseña)')

// Los imports desnudos de esas copias pasan a ser las que viajan al lado.
for (const f of ['passwordLogins.js', 'enroll.js', 'index.js']) {
  const ruta = join(vendor, 'vault/', f)
  await writeFile(ruta, (await readFile(ruta, 'utf8'))
    .replace(/from '@dotrino\/identity\/capabilities'/g, "from '../identity/capabilities.js'")
    .replace(/from '@dotrino\/identity\/acta'/g, "from '../identity/acta.js'")
    .replace(/from '@dotrino\/opaque'/g, "from '../opaque/index.js'"))
}
// UN SERVICE WORKER NO ADMITE `import()` DINÁMICO (lo prohíbe la especificación). El
// mostrador carga así el alta —en una página es lo correcto, porque arrastra el WASM— y
// aquí hay que dejarlo estático.
{
  const ruta = join(vendor, 'vault/index.js')
  await writeFile(ruta, (await readFile(ruta, 'utf8'))
    .replace("import { MSG, SCOPE } from './protocol.js'",
      "import { MSG, SCOPE } from './protocol.js'\nimport { registerLogin } from './passwordLogins.js'")
    .replace("      const { registerLogin } = await import('./passwordLogins.js')\n", '')
    // Y el cliente del proxio: el mostrador lo levantaría solo con otro `import()`
    // dinámico. Aquí SIEMPRE se le pasa hecho (`logins.js`), así que esa rama no existe —
    // y en vez de dejarla muerta, se dice.
    .replace(
      "  const client = injectedClient || await (async () => {",
      "  if (!injectedClient) throw new Error('device vault: pass a connected client (a service worker cannot import() the transport)')\n  const client = injectedClient || await (async () => {"))
}
// La copia del OPAQUE resuelve su WASM por ruta relativa: se conserva `build/`.
{
  const ruta = join(vendor, 'opaque/index.js')
  await writeFile(ruta, (await readFile(ruta, 'utf8')).replace(/from '\.\.\/build\//g, "from './build/"))
}

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
// …y lo que ELLA importa. `invite.js` pasó a sacar su base64url de `b64.js` —una sola
// implementación para el binario, la pestaña y esto— y aquí nadie lo copiaba: el grafo no
// resolvía y el service worker no arrancaba. Se copia al lado, que es donde lo busca.
await cp(join(here, '../../dotrino-vault/lib/src/b64.js'), join(vendor, 'vault/b64.js'))
console.log('vendor: dotrino-vault/lib/src/{invite,b64}.js → extension/src/vendor/vault/')

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
// La versión fijada en la URL cambia con cada support (0.9.0 la subió de @0.4 a @0.8): se lee
// del archivo, y todo lo demás del bloque tiene que ser idéntico o se para.
const pin = support.match(/const _STORE_CDN = 'https:\/\/cdn\.jsdelivr\.net\/npm\/@dotrino\/store@([0-9.]+)\/src\/index\.js'/)?.[1]
if (!pin) throw new Error('support: no encuentro el import remoto del store; revisa el recorte del vendor')
const remoto = `const _STORE_CDN = 'https://cdn.jsdelivr.net/npm/@dotrino/store@${pin}/src/index.js'
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
const recortado = support.replace(remoto,
  `// RECORTADO AL VENDORIZAR (extension/build.mjs): aquí no hay contador de aperturas.
// Llegaba al store por un import() de jsDelivr, que es código remoto — MV3 lo bloquea y
// la tienda lo rechaza —, y de paso avisaba a un servidor cada vez que se abre un gestor
// de contraseñas. Lo que se publica no lleva ni la URL ni el import.
function recordAppOpen() {}`)
if (recortado.includes('cdn.jsdelivr.net')) throw new Error('support: queda una URL de jsDelivr después del recorte')
await writeFile(supportPath, recortado)
console.log(`vendor: support sin el contador de aperturas (store@${pin} fuera, nada de código remoto)`)

// LA TARJETA DE PERFIL del ecosistema (CONVENCIONES §6.1). Trae el editor —nombre, foto,
// redes, datos— y además SU PROPIO conmutador de perfiles, con borrado, cuando se le pasa
// `manage`. Por eso viaja: el gestor tenía las operaciones (`profile-rename`,
// `profile-remove`) sin ninguna pantalla que las usara, y escribir aquí otro formulario
// sería reimplementar un pilar a mano — lo que la regla principal prohíbe.
await mkdir(join(vendor, 'profile'), { recursive: true })
await cp(join(here, '../../dotrino-profile/src/index.js'), join(vendor, 'profile/index.js'))
const profilePath = join(vendor, 'profile/index.js')
await writeFile(profilePath, (await readFile(profilePath, 'utf8'))
  .replace("from '@dotrino/identity/capabilities'", "from '../identity/capabilities.js'")
  .replace("from '@dotrino/identity/keyid'", "from '../identity/keyid.js'"))
console.log('vendor: dotrino-profile/src/index.js → extension/src/vendor/profile/index.js')

// El sellado extremo a extremo es de @dotrino/identity (la misma cripto que usa el
// vault para los secretos sellados). No se reescribe: viaja.
await mkdir(join(vendor, 'identity'), { recursive: true })
await cp(join(here, '../../dotrino-identity/vault/content.js'), join(vendor, 'identity/content.js'))
console.log('vendor: dotrino-identity/vault/content.js → extension/src/vendor/identity/content.js')

// El NÚCLEO de identidad, para que cada perfil tenga su llave de verdad (acta,
// delegaciones, certificados). Se vendoriza el núcleo, NO la clase `Identity`: esa monta
// un iframe contra id.dotrino.com y un service worker no tiene DOM.
//
// QUÉ archivos: **los que el núcleo importa**, siguiendo la cadena — no una lista escrita
// a mano. La lista existía y se quedó atrás: el núcleo empezó a importar `assertion.js`
// (identity 0.84) y aquí nadie lo copió, así que el service worker moría al arrancar por
// un import que no resuelve. Y muere en silencio: sin worker no hay marcador, no hay
// aviso y no hay error en ninguna parte — la extensión parece estar y no está.
const identitySrc = join(here, '../../dotrino-identity/vault')
const identityFiles = new Set(['core.js', 'acta.js', 'capabilities.js', 'remote.js', 'keyid.js', 'avatar.js'])
for (const f of [...identityFiles]) await seguirImports(join(identitySrc, f), identityFiles)
for (const f of identityFiles) await cp(join(identitySrc, f), join(vendor, 'identity/', f))

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
console.log('vendor: dotrino-identity/vault/ →', [...identityFiles].sort().join(', '))

// `@dotrino/identity` es peer dependency del sellado: en el navegador se le entrega la
// copia que viaja, en vez de que intente resolver un import desnudo.
const sealingPath = join(vendor, 'proxy-client/sealing.js')
const sealing = await readFile(sealingPath, 'utf8')
await writeFile(sealingPath,
  "import * as __identityContent from '../identity/content.js'\n" +
  sealing.replace(
    "let primitives = null",
    "let primitives = __identityContent"))


/**
 * Los archivos que `entrada` importa, y los que importan esos: la cadena entera.
 *
 * Solo mira imports RELATIVOS y del mismo directorio, que es lo que se vendoriza. Los
 * desnudos (`@dotrino/...`) los reescribe cada bloque de arriba a mano, porque cada uno
 * apunta a una copia distinta.
 */
async function seguirImports (archivo, out) {
  const code = await readFile(archivo, 'utf8')
  const re = /(?:^|\n)\s*(?:import|export)\s[^'"\n]*from\s*['"](\.[^'"]+)['"]|(?:^|\n)\s*import\s*['"](\.[^'"]+)['"]/g
  let m
  while ((m = re.exec(code))) {
    const rel = (m[1] || m[2]).replace(/^\.\//, '')
    if (rel.includes('/') || out.has(rel)) continue
    out.add(rel)
    await seguirImports(join(dirname(archivo), rel), out)
  }
}

// --- Y AL FINAL, QUE TODO RESUELVA ------------------------------------------
//
// Un import que no existe deja el service worker muerto ANTES de su primera línea, y no
// se nota: la extensión sigue instalada, el content script sigue corriendo y todo lo que
// le pregunta al worker se contesta solo con «no llego». Ni un error en la consola de la
// página. Así que se comprueba aquí, que es donde se puede parar.
async function verificarGrafo (entradas) {
  const visto = new Set()
  const rotos = []
  const ir = async (f) => {
    if (visto.has(f)) return
    visto.add(f)
    let code
    try { code = await readFile(f, 'utf8') } catch { rotos.push(f); return }
    // `[^;]*?` y no `[^'\"\n]*`: un import con llaves EN VARIAS LÍNEAS no casaba, así que
    // el grafo lo saltaba en silencio — justo lo que esta comprobación viene a evitar. El
    // `[^;]` corta en el punto y coma para no cruzar de una sentencia a la siguiente.
    const re = /(?:^|\n)\s*(?:import|export)\b[^;]*?from\s*['"](\.[^'"]+)['"]|(?:^|\n)\s*import\s*['"](\.[^'"]+)['"]/g
    let m
    while ((m = re.exec(code))) await ir(join(dirname(f), m[1] || m[2]))
  }
  for (const e of entradas) await ir(e)
  if (rotos.length) {
    throw new Error('imports que no resuelven (el service worker no arrancaría):\n  ' +
      rotos.map((f) => f.replace(here + '/', '')).join('\n  '))
  }
  return visto.size
}

const cuantos = await verificarGrafo([
  join(here, 'src/background.js'),
  // El documento offscreen es OTRA entrada: de él cuelgan el OPAQUE, el mostrador y el
  // transporte, y si sus imports no resuelven no arranca — en silencio, porque no se ve.
  join(here, 'src/offscreen.js'),
  join(here, 'src/content.js'),
  join(here, 'src/detect.js'),
  join(here, 'src/ui.js'),
  join(here, 'src/popup.js'),
  join(here, 'src/manager.js'),
  join(here, 'src/profile.js'),
  join(here, 'src/save-prompt.js'),
  join(here, 'src/field-modal.js'),
  join(here, 'src/approve.js'),
])
console.log(`grafo: ${cuantos} archivos y todos los imports resuelven`)
