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
// LA LLAVE VIVE EN LA BÓVEDA, no en el disco. Está en el cajón `passmanager` como
// `CRX_KEY_PEM_B64` (en base64, para que viaje en una línea y ningún parser de `.env` la
// parta), así que este script se corre por delante de ella:
//
//   dotrino-env run --ns passmanager -- npm run crx
//
// Si no está en el entorno, se PARA. No cae a un archivo por su cuenta: firmar con otra
// llave no da un error, da una extensión distinta en todos los aparatos — y eso no se
// descubre hasta que alguien intenta actualizar y no puede. Para casos declarados (el
// primer arranque, una máquina sin bóveda) existe `CRX_KEY`, que es una ruta y hay que
// escribirla a propósito.

import { readFile, writeFile, mkdir, rm, cp, readdir } from 'node:fs/promises'
import { createPrivateKey, createPublicKey, createHash, createSign, createVerify } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const BASE = 'https://pass.dotrino.com/app'

const pem = process.env.CRX_KEY_PEM_B64
  ? Buffer.from(process.env.CRX_KEY_PEM_B64, 'base64').toString('utf8')
  : (process.env.CRX_KEY ? await readFile(process.env.CRX_KEY, 'utf8') : null)
if (!pem) {
  console.error('No tengo la llave de firma.')
  console.error('Vive en la bóveda de Dotrino, cajón «passmanager». Corre esto por delante:')
  console.error('  dotrino-env run --ns passmanager -- npm run crx')
  console.error('(pide aprobación en el teléfono: es la llave que firma lo que se instala)')
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

// SE ARMA AQUÍ, no con `chrome --pack-extension`. Dos motivos, y el primero manda:
// ese comando quiere la llave **en un archivo**, y la llave viene de la bóveda — tendría
// que escribirla en el disco para volver a leerla, que es justo lo que la bóveda evita.
// El segundo es que así no hace falta un Chrome instalado para sacar una versión.
//
// Un CRX3 son tres cosas pegadas: `Cr24` + la cabecera + el zip de siempre.
execFileSync('zip', ['-r', '-q', `${stage}.zip`, '.', '-x', '*.DS_Store'], { cwd: stage })
const zip = await readFile(`${stage}.zip`)
const crx = armarCrx(zip, pem, spki, id)
// Y SE RELEE lo que acaba de escribirse, con el mismo código que leería Chrome: que el
// id sea el que se esperaba y que la firma valga. El id es lo único que ata todos los
// dispositivos a la misma extensión, y una llave equivocada aquí se vería como una
// instalación nueva en cada máquina, sin vuelta atrás.
const dentro = idDelCrx(crx)
if (dentro !== id) throw new Error(`el .crx dice ${dentro} y la llave dice ${id}`)
comprobarFirma(crx)

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

// LOS ARCHIVOS DE POLÍTICA para Windows y macOS, al lado del paquete.
//
// En esos dos sistemas Chrome no deja instalar nada de fuera de la tienda salvo que una
// política lo autorice, así que el `.crx` por sí solo no basta ahí. Y esa política se
// escribía a mano, copiando de la documentación: un JSON con las comillas escapadas dentro
// de un texto del registro, o un plist entero. Es justo lo que se copia mal — y el Bloc de
// notas encima lo guarda como `.reg.txt`.
//
// Aquí los dos salen del build, que es quien sabe el id y la URL de verdad.
//
// SIN VERSIÓN EN EL NOMBRE, y no es un descuido del §11.5: eso rige para los INSTALADORES,
// y esto no instala nada — apunta a `updates.xml`, que es lo que cambia. Un `.reg` con
// versión obligaría a volver a aplicarlo en cada release, que es exactamente lo contrario
// de para lo que sirve.
const politicaJson = JSON.stringify({
  [id]: { installation_mode: 'normal_installed', update_url: `${BASE}/updates.xml` },
})
await writeFile(join(appDir, 'dotrino-passmanager.reg'),
  'Windows Registry Editor Version 5.00\r\n\r\n' +
  '; Politica de Chrome: deja instalar esta extension desde pass.dotrino.com y la mantiene\r\n' +
  '; al dia sola. Doble clic como administrador y reinicia Chrome. Comprueba en chrome://policy\r\n' +
  '; OJO: ExtensionSettings es UNA sola politica para todas las extensiones del equipo. Si ya\r\n' +
  '; tenias una puesta, esto la reemplaza entera: ahi hay que anadir la entrada dentro.\r\n' +
  '[HKEY_LOCAL_MACHINE\\Software\\Policies\\Google\\Chrome]\r\n' +
  `"ExtensionSettings"="${politicaJson.replace(/"/g, '\\"')}"\r\n`)

await writeFile(join(appDir, 'dotrino-passmanager.plist'),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- macOS: va en /Library/Managed Preferences/com.google.Chrome.plist (pide administrador).
     Despues:  sudo killall cfprefsd   y reinicia Chrome. Comprueba en chrome://policy
     OJO: este archivo es la politica ENTERA de Chrome en ese equipo. Si ya habia una, hay
     que anadir esta clave dentro en vez de reemplazarlo. -->
<plist version="1.0">
<dict>
  <key>ExtensionSettings</key>
  <dict>
    <key>${id}</key>
    <dict>
      <key>installation_mode</key><string>normal_installed</string>
      <key>update_url</key><string>${BASE}/updates.xml</string>
    </dict>
  </dict>
</dict>
</plist>
`)
console.log('política: %s/dotrino-passmanager.{reg,plist}', BASE)

// EL ENLACE DE LA LANDING, apuntado a este paquete. El nombre lleva la versión
// (CONVENCIONES §11.5), así que escrito a mano se queda atrás — y el wiki manda aquí a
// descargarlo en vez de guardar él la URL, para no tener la versión escrita en dos repos.
const landing = join(here, '../web/index.html')
const html = await readFile(landing, 'utf8')
const puesto = html.replace(
  /\.\/app\/dotrino-passmanager-\d+\.\d+\.\d+\.crx/g, `./app/${nombre}`)
if (!puesto.includes(nombre)) throw new Error('la landing no tiene el enlace al .crx donde se esperaba')
if (puesto !== html) { await writeFile(landing, puesto); console.log('y la landing apunta a él') }

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
 * ARMA el CRX3: `Cr24` + versión + el tamaño de la cabecera + la cabecera + el zip.
 *
 * La cabecera es un protobuf con dos cosas: la prueba `sha256_with_rsa` (la pública y la
 * firma) y el `signed_header_data`, que solo lleva el id. Y lo que se firma no es el zip
 * a secas sino `"CRX3 SignedData\0"` + el largo de ese bloque + el bloque + el zip: así la
 * firma cubre también de qué extensión dice ser, y nadie puede reetiquetar un paquete
 * firmado como si fuera otro.
 */
function armarCrx (zip, pem, spki, id) {
  const crxId = Buffer.from(id.replace(/[a-p]/g, (c) => '0123456789abcdef'['abcdefghijklmnop'.indexOf(c)]), 'hex')
  const signedHeaderData = bytes(1, crxId)

  const largo = Buffer.alloc(4); largo.writeUInt32LE(signedHeaderData.length)
  const firma = createSign('RSA-SHA256')
    .update(Buffer.concat([Buffer.from('CRX3 SignedData\0', 'binary'), largo, signedHeaderData, zip]))
    .sign(pem)

  const header = Buffer.concat([
    bytes(2, Buffer.concat([bytes(1, spki), bytes(2, firma)])),   // sha256_with_rsa
    bytes(10000, signedHeaderData),
  ])
  const cabecera = Buffer.alloc(12)
  cabecera.write('Cr24', 0)
  cabecera.writeUInt32LE(3, 4)
  cabecera.writeUInt32LE(header.length, 8)
  return Buffer.concat([cabecera, header, zip])
}

/** Un campo protobuf de los que llevan longitud (que aquí son todos). */
function bytes (campo, valor) {
  return Buffer.concat([varintBuf((campo << 3) | 2), varintBuf(valor.length), valor])
}

function varintBuf (n) {
  const out = []
  while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n >>>= 7 }
  out.push(n)
  return Buffer.from(out)
}

/**
 * Los campos de una cabecera CRX3, en orden. Se recorre la estructura en vez de buscar
 * los bytes de una clave sueltos por ahí: esos mismos bytes pueden aparecer dentro de una
 * firma, y entonces se lee basura sin que nada avise.
 */
function * campos (buf) {
  let p = 0
  while (p < buf.length) {
    const [tag, t1] = varint(buf, p)
    if ((tag & 7) !== 2) throw new Error('la cabecera del .crx trae un campo que no esperaba')
    const [len, t2] = varint(buf, t1)
    yield [tag >> 3, buf.subarray(t2, t2 + len)]
    p = t2 + len
  }
}

/**
 * El id que lleva DENTRO el paquete: el `crx_id` del `signed_header_data` (campo 10000),
 * que son 16 bytes con los dígitos hexadecimales corridos a las letras a..p.
 */
function idDelCrx (buf) {
  const header = buf.subarray(12, 12 + buf.readUInt32LE(8))
  for (const [campo, valor] of campos(header)) {
    if (campo !== 10000) continue
    for (const [c, id] of campos(valor)) {
      if (c !== 1 || id.length !== 16) continue
      return id.toString('hex').replace(/[0-9a-f]/g, (x) => 'abcdefghijklmnop'[parseInt(x, 16)])
    }
  }
  throw new Error('la cabecera del .crx no trae el id')
}

/**
 * La firma RSA del paquete, comprobada como la comprueba Chrome: sobre
 * `"CRX3 SignedData\0"` + el largo del `signed_header_data` + ese bloque + el zip.
 */
function comprobarFirma (buf) {
  const headerSize = buf.readUInt32LE(8)
  const header = buf.subarray(12, 12 + headerSize)
  const zip = buf.subarray(12 + headerSize)

  let shd = null
  for (const [campo, valor] of campos(header)) if (campo === 10000) shd = valor
  if (!shd) throw new Error('la cabecera del .crx no trae signed_header_data')

  const largo = Buffer.alloc(4); largo.writeUInt32LE(shd.length)
  const firmado = Buffer.concat([Buffer.from('CRX3 SignedData\0', 'binary'), largo, shd, zip])

  let n = 0
  for (const [campo, proof] of campos(header)) {
    if (campo !== 2) continue    // sha256_with_rsa
    let pub = null; let sig = null
    for (const [c, v] of campos(proof)) {
      if (c === 1) pub = v
      if (c === 2) sig = v
    }
    if (!pub || !sig) throw new Error('una prueba del .crx viene incompleta')
    const vale = createVerify('RSA-SHA256').update(firmado)
      .verify({ key: pub, format: 'der', type: 'spki' }, sig)
    if (!vale) throw new Error('la firma del .crx no vale')
    n++
  }
  if (!n) throw new Error('el .crx no trae ninguna firma')
}

function varint (buf, p) {
  let valor = 0; let corrimiento = 0
  while (buf[p] & 0x80) { valor |= (buf[p] & 0x7f) << corrimiento; corrimiento += 7; p++ }
  valor |= buf[p] << corrimiento
  return [valor, p + 1]
}
