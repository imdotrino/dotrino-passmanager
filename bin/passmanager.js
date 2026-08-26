#!/usr/bin/env node
// La bóveda que RESPONDE, en la máquina del usuario.
//
// Monta la bóveda local y se pone a atender peticiones por el proxio: los aparatos
// (la extensión, la app) piden una credencial y esta es la que decide y contesta.
//
// Es el paso 2 del diseño en su forma mínima: bóveda propia con su política y su
// bitácora. Cuando el vault del ecosistema atienda estas peticiones, esto se
// convierte en su cliente y la política se muda allí — el protocolo no cambia.

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { createInterface } from 'node:readline'

import { WebSocketProxyClient, getPublicKeyJwk, setKeypairStore } from '@dotrino/proxy-client'
import { signData } from '@dotrino/proxy-client'

import { LocalVault } from '../lib/src/vault/local.js'
import { VaultResponder } from '../lib/src/vault/responder.js'
import { makeEncKeypair, importEncPrivate, exportEncPrivate } from '../lib/src/transport/sealed.js'
import {
  makeSalt, deriveKeyFromPassword, makeVerifier, checkVerifier, toBase64, fromBase64,
} from '../lib/src/crypto.js'
import { importAuto } from '../lib/src/import.js'
import { generatePassword } from '../lib/src/generate.js'
import { normalizeFields, KINDS } from '../lib/src/fields.js'
import { totpNow } from '../lib/src/totp.js'

const DIR = join(homedir(), '.dotrino', 'passmanager')
const FILE = join(DIR, 'vault.json')
const META = 'passmanager/meta/v1'

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

// La llave del proxio también va al mismo sitio: si se regenerara en cada arranque,
// los aparatos ya enlazados dejarían de reconocer a esta bóveda.
setKeypairStore({
  async get () {
    const raw = await store.get('proxy/keypair')
    if (!raw) return null
    const { privateJwk, publicJwk } = raw
    const alg = { name: 'ECDSA', namedCurve: 'P-256' }
    return {
      privateKey: await crypto.subtle.importKey('jwk', privateJwk, alg, true, ['sign']),
      publicKey: await crypto.subtle.importKey('jwk', publicJwk, alg, true, ['verify']),
      publicJwk,
    }
  },
  async set ({ privateKey, publicKey, publicJwk }) {
    await store.set('proxy/keypair', {
      privateJwk: await crypto.subtle.exportKey('jwk', privateKey),
      publicJwk: publicJwk || await crypto.subtle.exportKey('jwk', publicKey),
    })
  },
})

/**
 * Par de CIFRADO de esta bóveda, distinto del de firma. El de firma dice quién soy al
 * proxio; este es al que se le sella el contenido, para que el proxio no vea qué se
 * pide ni qué se devuelve.
 */
async function encKeypair () {
  const guardado = await store.get('enc/keypair')
  if (guardado) {
    return {
      privateKey: await importEncPrivate(guardado.privateJwk),
      encPub: guardado.encPub,
    }
  }
  const nuevo = await makeEncKeypair()
  await store.set('enc/keypair', {
    privateJwk: await exportEncPrivate(nuevo.privateKey),
    encPub: nuevo.encPub,
  })
  return { privateKey: nuevo.privateKey, encPub: nuevo.encPub }
}

/** El código de enlace lleva las DOS públicas: por una se enruta, a la otra se sella. */
function encodeCode ({ sign, enc }) {
  return Buffer.from(JSON.stringify({ v: 1, sign, enc })).toString('base64url')
}

function decodeCode (codigo) {
  const raw = Buffer.from(String(codigo || '').trim(), 'base64url').toString('utf8')
  const c = JSON.parse(raw)
  if (c?.v !== 1 || !c.sign || !c.enc) throw new Error('código inválido')
  return c
}

// --- contraseña maestra ------------------------------------------------------

/**
 * Lectura de la entrada con COLA.
 *
 * `rl.question` solo captura la línea siguiente si ya está registrado cuando llega. Con
 * la entrada por tubería (un script, una prueba) el lector emite todas las líneas de
 * golpe, así que entre una pregunta y la siguiente se pierden — y el proceso termina en
 * silencio, con exit 0, sin haber hecho nada. Por eso se acumulan las líneas y se van
 * repartiendo, en vez de pedirlas de una en una.
 *
 * `terminal` sigue a stdin: ocultar lo escrito solo tiene sentido en una terminal.
 */
const tty = !!process.stdin.isTTY
let rl = null
const lineas = []      // leídas y aún no pedidas
const esperando = []   // pedidas y aún no leídas
let cerrado = false

function lector () {
  if (rl) return rl
  rl = createInterface({ input: process.stdin, output: process.stdout, terminal: tty })
  rl.on('line', (l) => {
    const quien = esperando.shift()
    if (quien) quien(l)
    else lineas.push(l)
  })
  rl.on('close', () => {
    cerrado = true
    // Al llegar el final de la entrada, lo que siga esperando recibe cadena vacía en
    // vez de quedarse colgado para siempre.
    while (esperando.length) esperando.shift()('')
  })
  return rl
}

function pregunta (texto, oculto = false) {
  lector()
  if (texto) process.stdout.write(texto)
  if (lineas.length) return Promise.resolve(lineas.shift())
  if (cerrado) return Promise.resolve('')

  if (oculto && tty) {
    // En una terminal de verdad, no repetir lo que se teclea.
    const escribir = rl._writeToOutput
    rl._writeToOutput = function (s) { if (s.includes('\n')) process.stdout.write('\n') }
    return new Promise(resolve => esperando.push(v => {
      rl._writeToOutput = escribir
      resolve(v)
    }))
  }
  return new Promise(resolve => esperando.push(resolve))
}

/** Se llama al terminar: sin esto el proceso se queda esperando más entrada. */
function cerrarLector () {
  rl?.close()
  rl = null
}


async function abrirBoveda () {
  const vault = new LocalVault(store)
  let meta = await store.get(META)

  if (!meta) {
    console.log('No hay ninguna bóveda todavía. Elige la contraseña que la abrirá.')
    console.log('No se puede recuperar: si la pierdes, pierdes la bóveda.\n')
    const p1 = await pregunta('Contraseña: ', true)
    const p2 = await pregunta('Otra vez: ', true)
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
    const p = await pregunta('Contraseña de la bóveda: ', true)
    const key = await deriveKeyFromPassword(p, fromBase64(meta.salt))
    if (await checkVerifier(key, meta.verifier)) { vault.unlock(key); return vault }
    console.error('Esa contraseña no abre la bóveda.')
  }
  process.exit(1)
}

// --- aparatos enlazados ------------------------------------------------------

async function aparatos () { return (await store.get('devices')) || [] }

async function autorizar ({ sign, enc }, label) {
  const list = await aparatos()
  const i = list.findIndex(d => d.pubkey === sign)
  const nuevo = { pubkey: sign, encPub: enc, label: label || 'aparato', ts: Date.now() }
  if (i >= 0) list[i] = { ...list[i], ...nuevo }
  else list.push(nuevo)
  await store.set('devices', list)
}

// --- editar la bóveda --------------------------------------------------------

/** Busca por id, o por título/sitio si no es un id. Exige que no haya ambigüedad. */
async function buscarUna (vault, ref) {
  const todas = await vault.list()
  const exacta = todas.find(e => e.id === ref)
  if (exacta) return exacta

  const q = String(ref || '').toLowerCase()
  const hits = todas.filter(e =>
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

async function pedirCampos (actuales = []) {
  const campos = [...actuales]
  console.log('\nCampos sueltos (correo, teléfono, cédula, lo que sea). Enter vacío para terminar.')
  console.log('Clases para autorrellenar: %s\n', KINDS.join(', '))
  for (;;) {
    const label = (await pregunta('  Nombre del campo: ')).trim()
    if (!label) break
    const value = await pregunta('  Valor: ', true)
    const kind = (await pregunta('  Clase (Enter si ninguna): ')).trim()
    campos.push({ label, value, kind: kind || undefined })
  }
  return normalizeFields(campos)
}

async function pedirSecreto (actual) {
  const p = await pregunta(actual ? '  Contraseña (Enter deja la actual, «g» genera): ' : '  Contraseña («g» genera): ', true)
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
  const title = (await pregunta('  Nombre: ')).trim()
  const sites = (await pregunta('  Sitios (separados por coma): ')).split(',').map(x => x.trim()).filter(Boolean)
  const username = (await pregunta('  Usuario: ')).trim()
  const secret = await pedirSecreto(null)
  const totp = (await pregunta('  Código de dos pasos (otpauth:// o el secreto): ')).trim()
  const fields = await pedirCampos()

  const r = await vault.put({
    type: secret || username ? 'login' : 'data',
    title, sites, username, secret, totp, fields,
  })
  console.log('\nGuardada: %s  (%s)', r.title, r.id)
}

async function edit (ref) {
  if (!ref) { console.error('Falta qué entrada editar.'); process.exit(1) }
  const vault = await abrirBoveda()
  const encontrada = await buscarUna(vault, ref)
  const e = await vault.get(encontrada.id)
  const campos = e.fields ? JSON.parse(e.fields) : []

  console.log('\nEditando «%s». Enter deja el valor actual.\n', e.title)
  const title = (await pregunta(`  Nombre [${e.title}]: `)).trim() || e.title
  const sitesRaw = (await pregunta(`  Sitios [${(e.sites || []).join(', ') || 'cualquiera'}]: `)).trim()
  const sites = sitesRaw ? sitesRaw.split(',').map(x => x.trim()).filter(Boolean) : e.sites
  const username = (await pregunta(`  Usuario [${e.username || '—'}]: `)).trim() || e.username
  const secret = await pedirSecreto(e.secret)
  const totp = (await pregunta(`  Código de dos pasos [${e.totp ? 'puesto' : '—'}]: `)).trim() || e.totp

  console.log('\n  Campos actuales: %s', campos.map(f => f.label).join(', ') || '(ninguno)')
  const tocar = await pregunta('  ¿Añadir campos? [s/N] ')
  const fields = /^s(i|í)?$/i.test(tocar.trim()) ? await pedirCampos(campos) : campos

  await vault.put({ id: e.id, type: e.type, title, sites, username, secret, totp, fields })
  console.log('\nGuardada: %s', title)
}

async function ls (filtro) {
  const vault = await abrirBoveda()
  const todas = await vault.list()
  const q = (filtro || '').toLowerCase()
  const hits = q
    ? todas.filter(e => e.title.toLowerCase().includes(q) || (e.sites || []).some(s => s.includes(q)))
    : todas

  if (!hits.length) return console.log(todas.length ? 'Nada coincide.' : 'La bóveda está vacía.')
  for (const e of hits.sort((a, b) => a.title.localeCompare(b.title))) {
    console.log('%s  %s  %s%s%s',
      e.id.slice(0, 8),
      e.title.padEnd(24).slice(0, 24),
      (e.sites?.join(' ') || 'cualquier sitio').padEnd(28).slice(0, 28),
      e.hasTotp ? ' 2FA' : '',
      e.hasFields ? ' +campos' : '')
  }
}

async function show (ref) {
  if (!ref) { console.error('Falta qué entrada mostrar.'); process.exit(1) }
  const vault = await abrirBoveda()
  const e = await vault.get((await buscarUna(vault, ref)).id)

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
  const e = await buscarUna(vault, ref)
  const r = await pregunta(`¿Quitar «${e.title}»? No se puede deshacer. [s/N] `)
  if (!/^s(i|í)?$/i.test(r.trim())) return console.log('Se queda.')
  await vault.remove(e.id)
  console.log('Quitada.')
}

async function gen (largo) {
  console.log(generatePassword({ length: Number(largo) || 20 }))
}

// --- órdenes -----------------------------------------------------------------

async function serve () {
  const vault = await abrirBoveda()
  const enc = await encKeypair()
  const client = new WebSocketProxyClient({
    url: process.env.DOTRINO_PROXY || 'wss://proxy.dotrino.com',
    // Sin WebRTC: aquí no aporta y añade una pila entera a la pieza que reparte
    // credenciales.
    enableWebRTC: false,
    // La garantía: nada en claro sale ni entra.
    requireSealed: true,
    myEncPrivateKey: enc.privateKey,
  })

  await client.connect()
  const publickey = await getPublicKeyJwk()
  const data = { op: 'identify', publickey, token: client.token, ts: Date.now() }
  await client.identify({ data, signature: await signData(data) })

  let conocidos = await aparatos()
  const refrescar = async () => { conocidos = await aparatos() }

  const responder = new VaultResponder({
    client,
    vault,
    isAllowed: pub => conocidos.some(d => d.pubkey === pub),
    encPubOf: pub => conocidos.find(d => d.pubkey === pub)?.encPub || null,
    // La aprobación es del APARATO: se pide una vez y vale mientras esta bóveda siga
    // encendida.
    needsApproval: op => op === 'get',
    approve: async ({ pubkey, op, payload, admin }) => {
      const quien = (await aparatos()).find(d => d.pubkey === pubkey)
      const nombre = quien?.label || 'un aparato'
      // Administrar se pregunta SIEMPRE y por separado: retirar un aparato desde otro
      // es tan delicado como entregar una contraseña, y en el otro sentido.
      const texto = admin
        ? (op === 'unlink'
            ? `\n«${nombre}» quiere RETIRAR un aparato. ¿Le dejas? [s/N] `
            : `\n«${nombre}» quiere ver la lista de aparatos. ¿Le dejas? [s/N] `)
        : `\n¿Dejar que «${nombre}» pida credenciales?\n` +
          `Vale mientras esta bóveda siga encendida. [s/N] `
      const r = await pregunta(texto)
      return /^s(i|í)?$/i.test(r.trim())
    },
    // La consola web administra APARATOS, nunca credenciales: listar la bóveda sigue
    // siendo de quien tiene la llave.
    admin: {
      async devices () {
        return (await aparatos()).map(d => ({ pubkey: d.pubkey, label: d.label, ts: d.ts }))
      },
      async unlink (pubkey) {
        const list = await aparatos()
        const resto = list.filter(d => d.pubkey !== pubkey)
        if (resto.length === list.length) return { ok: false }
        await store.set('devices', resto)
        await refrescar()
        return { ok: true }
      },
    },
    onRequest: r => {
      console.log('[%s] %s %s %s', new Date(r.ts).toISOString(), r.op, r.outcome, r.from.slice(0, 24) + '…')
    },
  })
  responder.start()

  console.log('\nBóveda escuchando. Al apagarla, los aparatos vuelven a pedir permiso.')
  console.log('\nEnlaza un aparato con este código:\n')
  console.log(encodeCode({ sign: publickey, enc: enc.encPub }))
  console.log('\nAparatos autorizados:', conocidos.length)

  // Recarga la lista al vuelo: enlazar un aparato no debe obligar a reiniciar.
  setInterval(refrescar, 3000)
}

async function link (codigo, label) {
  if (!codigo) { console.error('Falta el código del aparato.'); process.exit(1) }
  let c
  try { c = decodeCode(codigo) } catch { console.error('Ese código no es válido.'); process.exit(1) }
  await autorizar(c, label)
  console.log('Aparato autorizado:', label || '(sin nombre)')
}

async function devices () {
  const list = await aparatos()
  if (!list.length) return console.log('Ningún aparato autorizado.')
  for (const d of list) {
    console.log('%s  %s  %s', new Date(d.ts).toISOString().slice(0, 10), (d.label || '—').padEnd(18), d.pubkey.slice(0, 40) + '…')
  }
}

async function unlink (label) {
  const list = await aparatos()
  const rest = list.filter(d => d.label !== label && !d.pubkey.startsWith(label))
  if (rest.length === list.length) return console.error('No encuentro ese aparato.')
  await store.set('devices', rest)
  console.log('Aparato retirado. Deja de poder pedir en la siguiente petición.')
}

async function importar (ruta) {
  const vault = await abrirBoveda()
  const { format, entries } = importAuto(await readFile(ruta, 'utf8'))
  for (const e of entries) await vault.put(e)
  console.log('Importadas %d entradas (%s).', entries.length, format)
}

const [orden, ...args] = process.argv.slice(2)
const ORDENES = { serve, link, devices, unlink, import: importar, add, edit, ls, show, rm, gen }

if (!ORDENES[orden]) {
  console.log(`dotrino-passmanager

  La bóveda
    ls [filtro]            lista lo guardado
    add                    añade una entrada
    edit <id|nombre>       edita una entrada
    show <id|nombre>       enseña una entrada (con su código de dos pasos)
    rm <id|nombre>         quita una entrada
    gen [largo]            genera una contraseña
    import <archivo>       importa de 1Password, Bitwarden o Chrome

  Aparatos
    serve                  atiende peticiones por el proxio
    link <código> [nombre] autoriza un aparato a pedir credenciales
    devices                lista los aparatos autorizados
    unlink <nombre>        retira un aparato
`)
  process.exit(orden ? 1 : 0)
}

ORDENES[orden](...args)
  .then(() => { if (orden !== 'serve') cerrarLector() })
  .catch(e => {
    cerrarLector()
    if (e?.message !== 'ambiguo') console.error(e?.message || e)
    process.exit(1)
  })
