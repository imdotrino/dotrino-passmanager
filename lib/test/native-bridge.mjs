// EL PUENTE PARA LAS APPS NATIVAS: una bóveda sellada de verdad (`SealedStore` +
// `SealedResponder`) y un aparato JS (`SealedVault`), hablando por stdin/stdout.
//
// Lo usan las pruebas de `android/` (y las de `ios/` cuando haya Mac): el puerto nativo de
// `SealedVault` habla el protocolo `pm2.*` contra ESTA librería, no contra una copia de sus
// reglas. Así, lo que escribe el teléfono lo abre la extensión y al revés, o la prueba falla.
//
// Una línea JSON por orden, una línea JSON por respuesta:
//   { cmd: 'init', pub, encPub }        el aparato nativo entra al acta, junto al de JS
//   { cmd: 'req', op, payload }         una petición pm2.* del aparato nativo
//   { cmd: 'js', fn, args }             una llamada al aparato JS (put, get, list, find, …)
//   { cmd: 'approve', value }           qué contesta quien aprueba, de aquí en adelante
//   { cmd: 'asked' }                    cuántas aprobaciones se pidieron
//   { cmd: 'wa', fn, args }             una función de `webauthn.js` (lo que hace la extensión con una passkey)
import { createInterface } from 'node:readline'
import { openWrap, decryptWithCek } from '@dotrino/identity/content'
import { SealedStore } from '../src/sealed/store.js'
import { SealedResponder } from '../src/vault/sealed-responder.js'
import { SealedVault } from '../src/vault/sealed.js'
import * as webauthn from '../src/webauthn.js'

const ECDH = { name: 'ECDH', namedCurve: 'P-256' }
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' }
const SIGN = { name: 'ECDSA', hash: { name: 'SHA-256' } }
const { subtle } = globalThis.crypto

function canon (v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']'
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}'
}
const pubOf = (jwk) => JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y })

async function jsDevice () {
  const sig = await subtle.generateKey(ECDSA, true, ['sign', 'verify'])
  const enc = await subtle.generateKey(ECDH, true, ['deriveBits'])
  const pub = pubOf(await subtle.exportKey('jwk', sig.publicKey))
  return {
    pub,
    encPub: pubOf(await subtle.exportKey('jwk', enc.publicKey)),
    identity: {
      publickey: pub,
      async sign (body) {
        const s = await subtle.sign(SIGN, sig.privateKey, new TextEncoder().encode(canon(body)))
        return { signature: Buffer.from(new Uint8Array(s)).toString('base64') }
      },
      async openSealed ({ wrap, envelope }) {
        return decryptWithCek({ cek: await openWrap({ wrap, myEncPrivateKey: enc.privateKey }), envelope })
      }
    }
  }
}

let state = null

async function init ({ pub, encPub }) {
  const js = await jsDevice()
  const rec = await subtle.generateKey(ECDH, true, ['deriveBits'])
  const recoveryPub = pubOf(await subtle.exportKey('jwk', rec.publicKey))
  const members = [{ pub: js.pub, encPub: js.encPub }, { pub, encPub }]
  const mem = new Map()
  const s = { approve: true, asked: 0 }
  const store = new SealedStore(
    { async get (k) { return mem.get(k) }, async set (k, v) { mem.set(k, v) } },
    {
      recipients: () => members,
      // La firma del autor se comprueba DE VERDAD, con la llave que dice y solo si es del acta.
      verifyAuthor: async ({ body, author }) => {
        if (!members.some((m) => m.pub === author.pub)) return false
        const key = await subtle.importKey('jwk', JSON.parse(author.pub), ECDSA, false, ['verify'])
        return subtle.verify(SIGN, key, Uint8Array.from(Buffer.from(author.sig, 'base64')), new TextEncoder().encode(canon(body)))
      }
    }
  )
  const responder = new SealedResponder({
    client: null,
    store,
    recipients: async () => ({ recoveryPub, main: members, passkeys: members }),
    isAllowed: (p) => members.some((m) => m.pub === p),
    encPubOf: (p) => members.find((m) => m.pub === p)?.encPub || null,
    needsApproval: async () => true,
    approve: async () => { s.asked++; return s.approve },
    onRequest: () => {}
  })
  // El transporte, en corto: la petición entra al responder y sale su respuesta.
  const ask = (who) => async (op, payload) => {
    let out = null
    responder.client = { pubkeyOfToken: () => who, sendSealedTo: (_to, msg) => { out = msg }, on () {}, off () {} }
    await responder.handle({ from: 'tok', pubkey: who, msg: { type: 'dotrino.passmanager/1', rid: 'r1', op, payload } })
    if (out?.error) throw Object.assign(new Error(out.error.message), { code: out.error.code })
    return out?.result
  }
  const vault = new SealedVault({ request: ask(js.pub) }, { identity: js.identity })
  await vault.initProfileKey()
  state = { ...s, s, native: ask(pub), vault }
  return { ok: true }
}

async function run (m) {
  if (m.cmd === 'init') return init(m)
  if (!state) throw new Error('init first')
  if (m.cmd === 'req') return state.native(m.op, m.payload || {})
  if (m.cmd === 'js') return state.vault[m.fn](...(m.args || []))
  if (m.cmd === 'approve') { state.s.approve = !!m.value; return { ok: true } }
  if (m.cmd === 'asked') return { asked: state.s.asked }
  if (m.cmd === 'wa') {
    const r = await webauthn[m.fn](...(m.args || []))
    return r instanceof Uint8Array ? webauthn.b64urlEncode(r) : r
  }
  throw new Error('unknown command: ' + m.cmd)
}

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue
  let out
  try {
    const result = await run(JSON.parse(line))
    out = { result: result === undefined ? null : result }
  } catch (e) {
    out = { error: { code: e?.code || 'unknown', message: e?.message || String(e) } }
  }
  process.stdout.write(JSON.stringify(out) + '\n')
}
