#!/usr/bin/env node
// La bóveda que RESPONDE, en la máquina del usuario.
//
// Monta la bóveda local y se pone a atender peticiones por el proxio: los aparatos
// (la extensión, la app) piden una credencial y esta es la que decide y contesta.
//
// **Es una bóveda del ecosistema, no un invento aparte.** Los aparatos entran por el
// enrolamiento de siempre —`@dotrino/vault` (`startDeviceVault`) contra el acta de
// este perfil—, con su invitación, su código de seis que se teclea aquí y su
// certificado. Quién puede pedir credenciales es la capacidad `passwords` del acta,
// como cualquier otro permiso. No hay códigos que pegar ni listas paralelas.
//
// El daemon `dotrino-vault` hace exactamente lo mismo y además sigue encendido con el
// navegador cerrado: esto es lo que hace que el gestor nazca funcionando sin él.

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { createInterface } from 'node:readline'

import { Identity } from '@dotrino/identity/node'
import { startDeviceVault } from '@dotrino/vault'
import { inviteUrl } from '@dotrino/vault/invite'

import { LocalVault } from '../lib/src/vault/local.js'
import { VaultResponder } from '../lib/src/vault/responder.js'
import {
  makeSalt, deriveKeyFromPassword, makeVerifier, checkVerifier, toBase64, fromBase64,
} from '../lib/src/crypto.js'
import { importAuto } from '../lib/src/import.js'
import { generatePassword } from '../lib/src/generate.js'
import { normalizeFields, KINDS } from '../lib/src/fields.js'
import { samePubkey } from '../lib/src/pubkey.js'
import { totpNow } from '../lib/src/totp.js'

const DIR = join(homedir(), '.dotrino', 'passmanager')
const FILE = join(DIR, 'vault.json')
const IDENTITY_DIR = join(DIR, 'identity')
const META = 'passmanager/meta/v1'
/** El permiso del acta que deja pedir credenciales. Uno, y el mismo en todo el ecosistema. */
const PASSWORDS_CAP = 'passwords'

// --- almacén en disco --------------------------------------------------------

async function loadAll () {
  try { return JSON.parse(await readFile(FILE, 'utf8')) } catch { return {} }
}

let cache = null
const store = {
  async get (k) { cache ??= await loadAll(); return cache[k] },
  async set (k, v) {
    cache ??= await loadAll()
    cache[k] = v
    await mkdir(dirname(FILE), { recursive: true })
    await writeFile(FILE, JSON.stringify(cache, null, 2), { mode: 0o600 })
  },
}

/**
 * La IDENTIDAD de esta bóveda: la del ecosistema, con su acta y su llave maestra.
 *
 * Vive en su propio directorio, aparte del archivo de credenciales: son dos cosas
 * distintas y una se puede respaldar sin la otra. De aquí salen las tres cosas que
 * necesita el enrolamiento estándar —firmar, delegar y sellar— sin que este archivo
 * tenga que saber nada de criptografía.
 */
let _identity = null
async function openIdentity () {
  _identity ||= await Identity.connect({ dir: IDENTITY_DIR })
  return _identity
}

/** Los aparatos que el acta autoriza a pedir credenciales. */
async function listDevices () {
  const id = await openIdentity()
  const r = await id.profileMembers()
  return (r?.members || []).filter((m) => (m.caps || []).includes(PASSWORDS_CAP))
}

// --- contraseña maestra ------------------------------------------------------

/**
 * Lectura de la entrada con COLA.
 *
 * `rl.question` solo captura la línea siguiente si ya está registrado cuando llega. Con
 * la entrada por tubería (un script, una prueba) el reader emite all las líneas de
 * golpe, así que entre una ask y la siguiente se pierden — y el proceso termina en
 * silencio, con exit 0, sin haber hecho nada. Por eso se acumulan las líneas y se van
 * repartiendo, en vez de pedirlas de una en una.
 *
 * `terminal` sigue a stdin: ocultar lo escrito solo tiene sentido en una terminal.
 */
const tty = !!process.stdin.isTTY
let rl = null
const pending = []      // leídas y aún no pedidas
const waiters = []   // pedidas y aún no leídas
let closed = false

function reader () {
  if (rl) return rl
  rl = createInterface({ input: process.stdin, output: process.stdout, terminal: tty })
  rl.on('line', (l) => {
    const who = waiters.shift()
    if (who) who(l)
    else pending.push(l)
  })
  rl.on('close', () => {
    closed = true
    // Al llegar el final de la entrada, lo que siga waiters recibe cadena vacía en
    // vez de quedarse colgado para siempre.
    while (waiters.length) waiters.shift()('')
  })
  return rl
}

function ask (text, oculto = false) {
  reader()
  if (text) process.stdout.write(text)
  if (pending.length) return Promise.resolve(pending.shift())
  if (closed) return Promise.resolve('')

  if (oculto && tty) {
    // En una terminal de verdad, no repetir lo que se teclea.
    const escribir = rl._writeToOutput
    rl._writeToOutput = function (s) { if (s.includes('\n')) process.stdout.write('\n') }
    return new Promise(resolve => waiters.push(v => {
      rl._writeToOutput = escribir
      resolve(v)
    }))
  }
  return new Promise(resolve => waiters.push(resolve))
}

/** Se llama al terminar: sin esto el proceso se queda waiters más entrada. */
function closeReader () {
  rl?.close()
  rl = null
}


async function abrirBoveda () {
  const vault = new LocalVault(store)
  let meta = await store.get(META)

  if (!meta) {
    console.log('No hay ninguna bóveda todavía. Elige la contraseña que la abrirá.')
    console.log('No se puede recuperar: si la pierdes, pierdes la bóveda.\n')
    const p1 = await ask('Contraseña: ', true)
    const p2 = await ask('Otra vez: ', true)
    if (!p1 || p1 !== p2) { console.error('No coinciden.'); process.exit(1) }
    const salt = makeSalt()
    const key = await deriveKeyFromPassword(p1, salt)
    meta = { salt: toBase64(salt), verifier: await makeVerifier(key), v: 1 }
    await store.set(META, meta)
    vault.unlock(key)
    console.log('\nBóveda creada en', FILE, '\n')
    return vault
  }

  for (let i = 0; i < 3; i++) {
    const p = await ask('Contraseña de la bóveda: ', true)
    const key = await deriveKeyFromPassword(p, fromBase64(meta.salt))
    if (await checkVerifier(key, meta.verifier)) { vault.unlock(key); return vault }
    console.error('Esa contraseña no abre la bóveda.')
  }
  process.exit(1)
}

// --- editar la bóveda --------------------------------------------------------

/** Busca por id, o por título/sitio si no es un id. Exige que no haya ambigüedad. */
async function findOne (vault, ref) {
  const all = await vault.list()
  const exact = all.find(e => e.id === ref)
  if (exact) return exact

  const q = String(ref || '').toLowerCase()
  const hits = all.filter(e =>
    e.title.toLowerCase().includes(q) || (e.sites || []).some(s => s.includes(q)))

  if (!hits.length) throw new Error(`no encuentro «${ref}»`)
  if (hits.length > 1) {
    // Elegir una al azar cuando el usuario fue ambiguo sería la peor forma de acertar.
    console.error('Hay varias que coinciden. Precisa el título o usa el id:')
    for (const h of hits) console.error('  %s  %s', h.id, h.title)
    throw new Error('ambiguo')
  }
  return hits[0]
}

async function askFields (actuales = []) {
  const fields = [...actuales]
  console.log('\nCampos sueltos (correo, teléfono, cédula, lo que sea). Enter vacío para terminar.')
  console.log('Clases para autorrellenar: %s\n', KINDS.join(', '))
  for (;;) {
    const label = (await ask('  Nombre del campo: ')).trim()
    if (!label) break
    const value = await ask('  Valor: ', true)
    const kind = (await ask('  Clase (Enter si ninguna): ')).trim()
    fields.push({ label, value, kind: kind || undefined })
  }
  return normalizeFields(fields)
}

async function askSecret (actual) {
  const p = await ask(actual ? '  Contraseña (Enter deja la actual, «g» genera): ' : '  Contraseña («g» genera): ', true)
  if (!p) return actual ?? ''
  if (p === 'g') {
    const nueva = generatePassword({ length: 20 })
    console.log('  Generada:', nueva)
    return nueva
  }
  return p
}

async function add () {
  const vault = await abrirBoveda()
  console.log('\nEntrada nueva. Deja los sitios vacíos si sirve en cualquier parte.\n')
  const title = (await ask('  Nombre: ')).trim()
  const sites = (await ask('  Sitios (separados por coma): ')).split(',').map(x => x.trim()).filter(Boolean)
  const username = (await ask('  Usuario: ')).trim()
  const secret = await askSecret(null)
  const totp = (await ask('  Código de dos pasos (otpauth:// o el secreto): ')).trim()
  const fields = await askFields()

  const r = await vault.put({
    type: secret || username ? 'login' : 'data',
    title, sites, username, secret, totp, fields,
  })
  console.log('\nGuardada: %s  (%s)', r.title, r.id)
}

async function edit (ref) {
  if (!ref) { console.error('Falta qué entrada editar.'); process.exit(1) }
  const vault = await abrirBoveda()
  const found = await findOne(vault, ref)
  const e = await vault.get(found.id)
  const current = e.fields ? JSON.parse(e.fields) : []

  console.log('\nEditando «%s». Enter deja el valor actual.\n', e.title)
  const title = (await ask(`  Nombre [${e.title}]: `)).trim() || e.title
  const sitesRaw = (await ask(`  Sitios [${(e.sites || []).join(', ') || 'cualquiera'}]: `)).trim()
  const sites = sitesRaw ? sitesRaw.split(',').map(x => x.trim()).filter(Boolean) : e.sites
  const username = (await ask(`  Usuario [${e.username || '—'}]: `)).trim() || e.username
  const secret = await askSecret(e.secret)
  const totp = (await ask(`  Código de dos pasos [${e.totp ? 'puesto' : '—'}]: `)).trim() || e.totp

  console.log('\n  Campos actuales: %s', current.map(f => f.label).join(', ') || '(ninguno)')
  const touch = await ask('  ¿Añadir campos? [s/N] ')
  const fields = /^s(i|í)?$/i.test(touch.trim()) ? await askFields(current) : current

  await vault.put({ id: e.id, type: e.type, title, sites, username, secret, totp, fields })
  console.log('\nGuardada: %s', title)
}

async function ls (filtro) {
  const vault = await abrirBoveda()
  const all = await vault.list()
  const q = (filtro || '').toLowerCase()
  const hits = q
    ? all.filter(e => e.title.toLowerCase().includes(q) || (e.sites || []).some(s => s.includes(q)))
    : all

  if (!hits.length) return console.log(all.length ? 'Nada coincide.' : 'La bóveda está vacía.')
  for (const e of hits.sort((a, b) => a.title.localeCompare(b.title))) {
    console.log('%s  %s  %s%s%s',
      e.id.slice(0, 8),
      e.title.padEnd(24).slice(0, 24),
      (e.sites?.join(' ') || 'cualquier sitio').padEnd(28).slice(0, 28),
      e.hasTotp ? ' 2FA' : '',
      e.hasFields ? ' +fields' : '')
  }
}

async function show (ref) {
  if (!ref) { console.error('Falta qué entrada mostrar.'); process.exit(1) }
  const vault = await abrirBoveda()
  const e = await vault.get((await findOne(vault, ref)).id)

  console.log('\n%s', e.title)
  if (e.sites?.length) console.log('  sitios:    %s', e.sites.join(', '))
  else console.log('  sitios:    (cualquiera)')
  if (e.username) console.log('  usuario:   %s', e.username)
  if (e.secret) console.log('  clave:     %s', e.secret)
  if (e.totp) {
    const { code, expiresIn } = await totpNow(e.totp)
    console.log('  2FA:       %s  (%ss)', code, expiresIn)
  }
  for (const f of e.fields ? JSON.parse(e.fields) : []) {
    console.log('  %s: %s%s', f.label.padEnd(9).slice(0, 9), f.value, f.kind ? `  [${f.kind}]` : '')
  }
  console.log()
}

async function rm (ref) {
  if (!ref) { console.error('Falta qué entrada quitar.'); process.exit(1) }
  const vault = await abrirBoveda()
  const e = await findOne(vault, ref)
  const r = await ask(`¿Quitar «${e.title}»? No se puede deshacer. [s/N] `)
  if (!/^s(i|í)?$/i.test(r.trim())) return console.log('Se queda.')
  await vault.remove(e.id)
  console.log('Quitada.')
}

async function gen (length) {
  console.log(generatePassword({ length: Number(length) || 20 }))
}

// --- órdenes -----------------------------------------------------------------

async function serve (...args) {
  const vault = await abrirBoveda()
  const identity = await openIdentity()

  // LA BÓVEDA DEL ECOSISTEMA: este proceso es la CA de su perfil, exactamente como el
  // daemon `dotrino-vault` o como una pestaña de `vault.dotrino.com/vault`. De aquí
  // salen las invitaciones y aquí se firman los certificados.
  const handle = await startDeviceVault(identity, {
    proxyUrl: process.env.DOTRINO_PROXY || 'wss://proxy.dotrino.com'
  })

  // El sellado del gestor sobre el MISMO cliente: el protocolo de la CA viaja en claro
  // a propósito (un enrolamiento es público hasta que hay cert) y lo que se sella es lo
  // del gestor. Por eso `isSealed` mira su marca y no otra.
  handle.client.updateConfig({
    sealing: {
      async seal (msg, peerEncPub) {
        if (!peerEncPub) throw Object.assign(new Error('no encryption key'), { code: 'unsealed' })
        return {
          app: 'passmanager',
          // Destinatarios como OBJETOS: `encrypt` expande cada uno a todos los aparatos
          // de esa persona; una llave suelta se le cae sin envolver nada.
          sealed: await identity.encrypt([{ encryptionPubkey: peerEncPub }], JSON.stringify(msg)),
          from: await identity.getEncryptionPubkey()
        }
      },
      // `decrypt` devuelve `{ plaintext }`, no la cadena.
      async open (env) { return JSON.parse((await identity.decrypt(env.from, null, env.sealed)).plaintext) },
      isSealed: (m) => !!m && m.app === 'passmanager' && !!m.sealed
    }
  })

  let known = await listDevices()
  const refresh = async () => { known = await listDevices() }

  const responder = new VaultResponder({
    client: handle.client,
    vault,
    // Por LLAVE, no por cadena: la misma pubkey se serializa distinto según quién la
    // escriba, y comparar el JSON hace que un aparato autorizado salga «denegado» sin
    // que se vea por qué — los dos valores parecen iguales al mirarlos.
    isAllowed: pub => known.some(d => samePubkey(d.pub, pub)),
    encPubOf: pub => known.find(d => samePubkey(d.pub, pub))?.encPub || null,
    // Qué exige un dedo encima lo decide el responder por defecto: **solo `get`, y solo
    // si lo pedido incluye algo privado** (dueño, 2026-08-29). Rellenar un nombre no es
    // sacar un secreto, y pedir permiso para eso enseña a decir que sí sin mirar.
    // La aprobación, cuando toca, es del APARATO: se pide una vez y vale mientras esta
    // bóveda siga encendida.

    approve: async ({ pubkey }) => {
      const who = known.find(d => samePubkey(d.pub, pubkey))
      const name = who?.label || who?.id || 'un aparato'
      const r = await ask(`\n¿Dejar que «${name}» pida credenciales?\n` +
        'Vale mientras esta bóveda siga encendida. [s/N] ')
      return /^s(i|í)?$/i.test(r.trim())
    },
    // Sin mostrador de administración: los aparatos se conectan y se quitan aquí, en la
    // bóveda, que es donde está el acta. Un aparato no administra a los demás.
    onRequest: r => {
      console.log('[%s] %s %s %s', new Date(r.ts).toISOString(), r.op, r.outcome, r.from.slice(0, 24) + '…')
    },
  })
  responder.start()

  console.log('\nBóveda escuchando. Al apagarla, los aparatos vuelven a pedir permiso.')
  console.log('Aparatos que pueden pedir: %d', known.length)

  // Recarga la lista al vuelo: conceder el permiso no debe obligar a reiniciar.
  setInterval(refresh, 3000)

  // La invitación se abre sola cuando todavía no hay a quién responder — es el primer
  // minuto del gestor y no tendría sentido pedir un comando más. Después, a petición.
  if (!known.length || args.includes('--pair')) await pairDevice(handle)
  else console.log('Para conectar otro aparato:  dotrino-passmanager serve --pair')
}

/**
 * Conectar un aparato: el emparejamiento de siempre. Se imprime la invitación, el
 * aparato la abre, muestra SEIS caracteres y se teclean aquí. El código no viaja: la
 * bóveda solo lo aprende cuando lo escribes, y por eso aprobar exige tener el aparato
 * delante.
 */
async function pairDevice (handle) {
  const { qr } = await handle.startPairing({
    // Lo único que va a hacer ese aparato. Pedirlo en dos pasos era el paso que nadie
    // daba, y dejaba al gestor conectado pero mudo.
    scope: ['vault:passwords'],
    label: 'gestor de contraseñas'
  })
  console.log('\nAbre esto en el aparato que quieras conectar:\n')
  console.log('  ' + inviteUrl(qr) + '\n')

  handle.onPendingChange(async () => {
    const [p] = handle.listPending()
    if (!p) return
    const code = (await ask(`Escribe el código que muestra ${p.deviceId}: `)).trim()
    if (!code) return
    try {
      await handle.approve(p.deviceId, code)
      console.log('Aparato conectado: %s. Ya puede pedir credenciales.', p.deviceId)
    } catch (e) {
      console.error('No se pudo conectar: %s', e?.message || e)
    }
  })
}

async function devices () {
  const list = await listDevices()
  if (!list.length) return console.log('Ningún aparato puede pedir credenciales.')
  for (const d of list) {
    console.log('%s  %s', d.id, d.label || '—')
  }
}

/** Quitar un aparato es quitarlo del PERFIL: sale del acta y pierde su certificado. */
async function unlink (ref) {
  if (!ref) { console.error('Falta qué aparato retirar.'); process.exit(1) }
  const list = await listDevices()
  const d = list.find(x => x.id === ref || x.label === ref)
  if (!d) return console.error('No encuentro ese aparato.')
  const identity = await openIdentity()
  await identity.revokeDevice(d.pub)
  console.log('Aparato retirado del perfil. Deja de poder pedir en la siguiente petición.')
}

async function importFile (ruta) {
  const vault = await abrirBoveda()
  const { format, entries } = importAuto(await readFile(ruta, 'utf8'))
  for (const e of entries) await vault.put(e)
  console.log('Importadas %d entradas (%s).', entries.length, format)
}

const [orden, ...args] = process.argv.slice(2)
const ORDENES = { serve, devices, unlink, import: importFile, add, edit, ls, show, rm, gen }

if (!ORDENES[orden]) {
  console.log(`dotrino-passmanager

  La bóveda
    ls [filtro]            lista lo guardado
    add                    añade una entrada
    edit <id|nombre>       edita una entrada
    show <id|nombre>       enseña una entrada (con su código de dos pasos)
    rm <id|nombre>         quita una entrada
    gen [largo]             genera una contraseña
    import <archivo>       importa de 1Password, Bitwarden o Chrome

  Aparatos
    serve [--pair]         atiende peticiones por el proxio. Con --pair, además abre
                           una invitación para conectar otro aparato
    devices                lista los aparatos que pueden pedir credenciales
    unlink <ID|nombre>     retira un aparato del perfil
`)
  process.exit(orden ? 1 : 0)
}

ORDENES[orden](...args)
  .then(() => { if (orden !== 'serve') closeReader() })
  .catch(e => {
    closeReader()
    if (e?.message !== 'ambiguo') console.error(e?.message || e)
    process.exit(1)
  })
