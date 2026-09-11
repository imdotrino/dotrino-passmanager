// EL CANAL PROPIO: un `.crx` firmado por ti y un `updates.xml`, servidos por la misma
// página que ya sirve el zip (`pass.dotrino.com`).
//
// Por qué existe, además del zip: el zip se carga descomprimida, o sea a mano en cada
// máquina y otra vez en cada versión, y Chrome le da un id distinto cada vez. Un `.crx`
// con llave propia tiene **un id estable en todos los dispositivos** y Chrome lo
// **actualiza solo** mirando el `updates.xml`. La tienda sigue siendo otro camino, más
// lento y con revisión; este es el de casa, y encaja con lo que promete el proyecto: tu
// software, en tu servidor, bajo tus reglas.
//
// Uso:
//   node crx.mjs                      # arma el .crx y el updates.xml en ../web/app/
//   CRX_KEY=/ruta/otra.pem node crx.mjs
//
// LA LLAVE NO VIVE EN EL REPO. Por defecto se busca en `~/.dotrino/keys/`, fuera del
// árbol de trabajo, como el keystore de las apps Android. Si se pierde, el id cambia y
// todos los dispositivos ven una extensión distinta: hay que guardarla en la bóveda.

import { readFile, writeFile, mkdir, rm, cp, readdir } from 'node:fs/promises'
import { createPrivateKey, createPublicKey, createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { tmpdir, homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const BASE = 'https://pass.dotrino.com/app'

const keyPath = process.env.CRX_KEY || join(homedir(), '.dotrino/keys/passmanager-crx.pem')
const pem = await readFile(keyPath, 'utf8').catch(() => null)
if (!pem) {
  console.error('No encuentro la llave de firma en %s', keyPath)
  console.error('Se crea UNA vez y se guarda (si se pierde, el id cambia en todos los aparatos):')
  console.error('  mkdir -p ~/.dotrino/keys && openssl genrsa -out %s 2048 && chmod 600 %s', keyPath, keyPath)
  process.exit(1)
}

// EL ID sale de la llave, no de la tienda: es el SHA-256 de la pública, los primeros 16
// bytes, con los dígitos hexadecimales corridos a las letras a..p.
const spki = createPublicKey(createPrivateKey(pem)).export({ type: 'spki', format: 'der' })
const id = createHash('sha256').update(spki).digest().subarray(0, 16).toString('hex')
  .replace(/[0-9a-f]/g, (c) => 'abcdefghijklmnop'[parseInt(c, 16)])

const manifest = JSON.parse(await readFile(join(here, 'manifest.json'), 'utf8'))
const { version } = manifest

// El vendor tiene que estar fresco, igual que al armar el zip: es la librería de verdad.
execFileSync('node', [join(here, 'build.mjs')], { stdio: 'inherit' })

// Se empaqueta una COPIA, no la carpeta de trabajo: al manifiesto del canal propio hay
// que añadirle dos cosas que **no pueden ir en el que sube a la tienda** — la tienda
// rechaza un `update_url`, porque ahí quien actualiza es ella.
const stage = join(await mkdtempDir(), 'dotrino-passmanager')
await mkdir(stage, { recursive: true })
for (const f of ['manifest.json', 'src', 'icons', '_locales']) {
  await cp(join(here, f), join(stage, f), { recursive: true })
}
await writeFile(join(stage, 'manifest.json'), JSON.stringify({
  ...manifest,
  // La pública, para que el id se pueda comprobar mirando el paquete y para que cargarla
  // descomprimida dé el MISMO id que instalada.
  key: spki.toString('base64'),
  // Dónde preguntar si hay versión nueva. Chrome lo mira solo, cada pocas horas.
  update_url: `${BASE}/updates.xml`,
}, null, 2) + '\n')

const chrome = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']
  .find((c) => { try { execFileSync('which', [c], { stdio: 'ignore' }); return true } catch { return false } })
if (!chrome) {
  console.error('No hay ningún Chrome para empaquetar (google-chrome o chromium).')
  process.exit(1)
}
execFileSync(chrome, [
  '--headless', '--no-sandbox', '--disable-gpu',
  `--pack-extension=${stage}`, `--pack-extension-key=${keyPath}`,
], { stdio: 'inherit' })

// Y SE COMPRUEBA que el paquete lleva el id que se esperaba, en vez de darlo por hecho:
// el id es lo único que ata todos los dispositivos a la misma extensión, y una llave
// equivocada aquí se vería como una instalación nueva en cada máquina.
const crx = await readFile(`${stage}.crx`)
if (crx.subarray(0, 4).toString() !== 'Cr24') throw new Error('eso no es un .crx')
const dentro = idDelCrx(crx)
if (dentro !== id) throw new Error(`el .crx dice ${dentro} y la llave dice ${id}`)

const appDir = join(here, '../web/app')
await mkdir(appDir, { recursive: true })
// La versión va en el nombre (CONVENCIONES §11.5): así se sabe qué es cada archivo.
const nombre = `dotrino-passmanager-${version}.crx`
// Se escribe el buffer ya leído en vez de mover el archivo: `/tmp` y el repo están en
// discos distintos, y ahí `rename` no vale.
await writeFile(join(appDir, nombre), crx)
await rm(dirname(stage), { recursive: true, force: true })

// El manifiesto de actualización, que es lo que Chrome consulta. Apunta al .crx con su
// versión en el nombre, así que se reescribe en cada corrida.
await writeFile(join(appDir, 'updates.xml'),
  `<?xml version='1.0' encoding='UTF-8'?>
<!-- Lo consulta Chrome para saber si hay versión nueva. Lo escribe extension/crx.mjs. -->
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='${id}'>
    <updatecheck codebase='${BASE}/${nombre}' version='${version}' />
  </app>
</gupdate>
`)

for (const f of await readdir(appDir)) {
  if (/^dotrino-passmanager-\d+\.\d+\.\d+\.crx$/.test(f) && f !== nombre) {
    await rm(join(appDir, f)); console.log('fuera el viejo:', f)
  }
}

console.log('\n.crx  : %s  (%s KB)', join(appDir, nombre), Math.round(crx.length / 1024))
console.log('update: %s/updates.xml', BASE)
console.log('id    : %s', id)

/** Una carpeta temporal propia, para no empaquetar la de trabajo. */
async function mkdtempDir () {
  const d = join(tmpdir(), `crx-${Date.now()}`)
  await mkdir(d, { recursive: true })
  return d
}

/**
 * El id que lleva DENTRO el paquete. Está en la cabecera CRX3, en el `signed_header_data`
 * (campo 10000 del protobuf), que es un `SignedData` con el `crx_id` de 16 bytes.
 */
function idDelCrx (buf) {
  const headerSize = buf.readUInt32LE(8)
  const header = buf.subarray(12, 12 + headerSize)
  // Campo 10000, tipo 2 (bytes) → clave varint 0x82 0xf1 0x04.
  const at = header.indexOf(Buffer.from([0x82, 0xf1, 0x04]))
  if (at < 0) throw new Error('la cabecera del .crx no trae signed_header_data')
  let p = at + 3
  const [, tras] = varint(header, p); p = tras
  // Dentro del SignedData: campo 1, tipo 2 → clave 0x0a, y 16 bytes de id.
  if (header[p] !== 0x0a || header[p + 1] !== 16) throw new Error('crx_id con una forma que no conozco')
  return header.subarray(p + 2, p + 18).toString('hex')
    .replace(/[0-9a-f]/g, (c) => 'abcdefghijklmnop'[parseInt(c, 16)])
}

function varint (buf, p) {
  let valor = 0; let corrimiento = 0
  while (buf[p] & 0x80) { valor |= (buf[p] & 0x7f) << corrimiento; corrimiento += 7; p++ }
  valor |= buf[p] << corrimiento
  return [valor, p + 1]
}
