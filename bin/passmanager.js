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
import {
  makeSalt, deriveKeyFromPassword, makeVerifier, checkVerifier, toBase64, fromBase64,
} from '../lib/src/crypto.js'
import { importAuto } from '../lib/src/import.js'

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

// --- contraseña maestra ------------------------------------------------------

function pregunta (texto, oculto = false) {
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    if (oculto) {
      const out = process.stdout
      rl._writeToOutput = function (s) { if (s.includes('\n')) out.write('\n') }
    }
    rl.question(texto, a => { rl.close(); resolve(a) })
  })
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

async function autorizar (pubkey, label) {
  const list = await aparatos()
  if (!list.some(d => d.pubkey === pubkey)) {
    list.push({ pubkey, label: label || 'aparato', ts: Date.now() })
    await store.set('devices', list)
  }
}

// --- órdenes -----------------------------------------------------------------

async function serve () {
  const vault = await abrirBoveda()
  const client = new WebSocketProxyClient({
    url: process.env.DOTRINO_PROXY || 'wss://proxy.dotrino.com',
    // Sin WebRTC: aquí no aporta nada (los sobres ya van sellados) y añade una pila
    // entera a la pieza que reparte credenciales.
    enableWebRTC: false,
  })

  await client.connect()
  const publickey = await getPublicKeyJwk()
  const data = { op: 'identify', publickey, token: client.token, ts: Date.now() }
  await client.identify({ data, signature: await signData(data) })

  let permitidos = new Set((await aparatos()).map(d => d.pubkey))

  const responder = new VaultResponder({
    client,
    vault,
    isAllowed: pub => permitidos.has(pub),
    // La aprobación es del APARATO: se pide una vez y vale mientras esta bóveda siga
    // encendida. Lo marcado `alwaysAsk` se pregunta igual, cada vez.
    needsApproval: op => op === 'get',
    approve: async ({ pubkey, entry }) => {
      const quien = (await aparatos()).find(d => d.pubkey === pubkey)
      const texto = entry?.alwaysAsk
        ? `\n¿Entregar «${entry.title}»? (esta se pregunta siempre) [s/N] `
        : `\n¿Dejar que «${quien?.label || 'un aparato'}» pida credenciales?\n` +
          `Vale mientras esta bóveda siga encendida. [s/N] `
      const r = await pregunta(texto)
      return /^s(i|í)?$/i.test(r.trim())
    },
    onRequest: r => {
      console.log('[%s] %s %s %s', new Date(r.ts).toISOString(), r.op, r.outcome, r.from.slice(0, 24) + '…')
    },
  })
  responder.start()

  console.log('\nBóveda escuchando. Al apagarla, los aparatos vuelven a pedir permiso.')
  console.log('\nEnlaza un aparato con este código:\n')
  console.log(Buffer.from(publickey).toString('base64url'))
  console.log('\nAparatos autorizados:', permitidos.size)

  // Recarga la lista al vuelo: enlazar un aparato no debe obligar a reiniciar.
  setInterval(async () => { permitidos = new Set((await aparatos()).map(d => d.pubkey)) }, 3000)
}

async function link (codigo, label) {
  if (!codigo) { console.error('Falta el código del aparato.'); process.exit(1) }
  const pubkey = Buffer.from(codigo, 'base64url').toString('utf8')
  try { JSON.parse(pubkey) } catch { console.error('Ese código no es válido.'); process.exit(1) }
  await autorizar(pubkey, label)
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
const ORDENES = { serve, link, devices, unlink, import: importar }

if (!ORDENES[orden]) {
  console.log(`dotrino-passmanager

  serve                  abre la bóveda y atiende peticiones por el proxio
  link <código> [nombre] autoriza un aparato a pedir credenciales
  devices                lista los aparatos autorizados
  unlink <nombre>        retira un aparato
  import <archivo>       importa de 1Password, Bitwarden o Chrome
`)
  process.exit(orden ? 1 : 0)
}

ORDENES[orden](...args).catch(e => { console.error(e?.message || e); process.exit(1) })
