// Service worker: el único dueño de la bóveda dentro del navegador.
//
// Ni el popup ni los content scripts ven la CEK ni el almacén; le hablan por
// mensajes. Así el día que la bóveda deje de ser local y la responda el vault o el
// teléfono (DISENO §8, pasos 2 y 3), solo cambia lo que hay detrás de `source()`.

import {
  LocalVault, makeSalt, deriveKeyFromPassword, makeVerifier, checkVerifier,
  exportVaultKey, importVaultKey, toBase64, fromBase64, sealEntry, totpNow,
} from './vendor/passmanager/index.js'
import { importAuto } from './vendor/passmanager/import.js'

const META = 'passmanager/meta/v1'
const SESSION_KEY = 'cek'

// El almacén que espera LocalVault, sobre chrome.storage.local.
const store = {
  async get (k) { return (await chrome.storage.local.get(k))[k] },
  async set (k, v) { await chrome.storage.local.set({ [k]: v }) },
}

const vault = new LocalVault(store)

/**
 * MV3 duerme el service worker, así que la CEK no puede vivir en una variable: se
 * guarda en `chrome.storage.session`, que es memoria y se borra al cerrar el
 * navegador. Es el riesgo que el diseño marca (§9) y esta es su respuesta.
 */
async function loadKey () {
  if (vault.key) return true
  const raw = (await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY]
  if (!raw) return false
  vault.unlock(await importVaultKey(fromBase64(raw)))
  return true
}

async function rememberKey (key) {
  await chrome.storage.session.set({ [SESSION_KEY]: toBase64(await exportVaultKey(key)) })
}

async function meta () { return (await store.get(META)) || null }

async function status () {
  const m = await meta()
  return { exists: !!m, unlocked: await loadKey() }
}

async function create (password) {
  if (await meta()) throw Object.assign(new Error('vault already exists'), { code: 'exists' })
  const salt = makeSalt()
  const key = await deriveKeyFromPassword(password, salt, undefined, true)
  await store.set(META, { salt: toBase64(salt), verifier: await makeVerifier(key), v: 1 })
  vault.unlock(key)
  await rememberKey(key)
  return { unlocked: true }
}

async function unlock (password) {
  const m = await meta()
  if (!m) throw Object.assign(new Error('no vault'), { code: 'no-vault' })
  const key = await deriveKeyFromPassword(password, fromBase64(m.salt), undefined, true)
  if (!await checkVerifier(key, m.verifier)) {
    throw Object.assign(new Error('wrong password'), { code: 'wrong-password' })
  }
  vault.unlock(key)
  await rememberKey(key)
  return { unlocked: true }
}

async function lock () {
  vault.lock()
  await chrome.storage.session.remove(SESSION_KEY)
  return { unlocked: false }
}

/** Importar entra de a muchas — es lo único que lo hace, y entrar no es salir (§10). */
async function importText (text) {
  const { format, entries } = importAuto(text)
  for (const e of entries) await vault.put(e)
  return { format, count: entries.length }
}

const OPS = {
  status,
  create: p => create(p.password),
  unlock: p => unlock(p.password),
  lock,
  find: async p => { await requireUnlocked(); return vault.find(p.url) },
  get: async p => { await requireUnlocked(); return vault.get(p.id) },
  put: async p => { await requireUnlocked(); return vault.put(p.entry) },
  list: async () => { await requireUnlocked(); return vault.list() },
  remove: async p => { await requireUnlocked(); return vault.remove(p.id) },
  import: async p => { await requireUnlocked(); return importText(p.text) },
  totp: async p => {
    await requireUnlocked()
    const entry = await vault.get(p.id)
    return entry.totp ? totpNow(entry.totp) : null
  },
}

async function requireUnlocked () {
  if (!await loadKey()) throw Object.assign(new Error('locked'), { code: 'locked' })
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const op = OPS[msg?.op]
  if (!op) { sendResponse({ error: { code: 'unknown-op' } }); return false }

  // Un content script solo puede preguntar qué hay para SU sitio y pedir una
  // credencial. Nunca listar, ni escribir, ni tocar el candado: si la página que
  // tienes delante pudiera listar la bóveda, el "pide de a una" no valdría nada.
  const fromPage = !!sender.tab
  if (fromPage && !['find', 'get', 'status', 'totp'].includes(msg.op)) {
    sendResponse({ error: { code: 'denied' } })
    return false
  }

  Promise.resolve(op(msg.payload || {}))
    .then(result => sendResponse({ result }))
    .catch(e => sendResponse({ error: { code: e?.code || 'error', message: e?.message } }))
  return true // la respuesta es asíncrona
})
