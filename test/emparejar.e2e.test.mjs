/**
 * DE PUNTA A PUNTA: el gestor se empareja COMO CUALQUIER APARATO y pide una credencial.
 *
 * Hubo un emparejamiento propio del gestor —dos públicas en base64 que se pegaban a mano
 * en las dos direcciones— y este archivo existe para que no vuelva. Lo que se recorre es
 * el camino entero y el de siempre:
 *
 *   1. la bóveda abre una invitación (`startDeviceVault` → `startPairing`)
 *   2. el aparato la lee y se enrola (`vaultPair` del núcleo de identidad)
 *   3. enseña SEIS caracteres que se teclean en la bóveda (`approve`)
 *   4. la bóveda firma su cert y lo admite en el ACTA con la capacidad `passwords`
 *   5. el aparato pide una credencial SELLADA y la recibe
 *
 * Corre contra un proxio de VERDAD, porque el enrolamiento levanta su propio cliente y
 * no admite un transporte de mentira. Por defecto usa el del ecosistema; para no tocar
 * producción se le pasa uno local:
 *
 *   PORT=4099 node server.js                     # en dotrino-proxy
 *   DOTRINO_PROXY=ws://localhost:4099 node --test test/emparejar.e2e.test.mjs
 *
 * Sin `DOTRINO_PROXY` se salta: una suite no abre conexiones a producción por su cuenta.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createIdentityCore } from '@dotrino/identity/vault/core.js'
import { startDeviceVault } from '@dotrino/vault'
import { inviteUrl, parseInvite } from '@dotrino/vault/invite'
import { WebSocketProxyClient } from '@dotrino/proxy-client'

import { LocalVault } from '../lib/src/vault/local.js'
import { RemoteVault } from '../lib/src/vault/remote.js'
import { VaultResponder } from '../lib/src/vault/responder.js'
import { ProxyTransport } from '../lib/src/transport/proxy.js'
import { makeVaultKey } from '../lib/src/crypto.js'
import { samePubkey } from '../lib/src/pubkey.js'

const PROXY = process.env.DOTRINO_PROXY || ''

// `localStorage` en memoria: el cliente del proxio guarda ahí su par de canales.
if (!globalThis.localStorage) {
  const mem = new Map()
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
    clear: () => mem.clear()
  }
}

/** Un núcleo de identidad entero, en memoria: el mismo que corre en el navegador. */
async function nucleo () {
  const mem = new Map()
  const kv = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k)
  }
  let peers = {}
  return createIdentityCore({
    kv,
    peers: {
      async initPeerStorage () {},
      loadPeers: () => peers,
      savePeers: (m) => { peers = m },
      setPeersDirect: (m) => { peers = m || {} },
      upsertPeer: (pub, patch) => { peers[pub] = { ...(peers[pub] || {}), ...patch, publickey: pub }; return peers[pub] },
      onDirty () {}
    },
    makeSync: null
  })
}

/** El adaptador de sellado del gestor, sobre una identidad del ecosistema. */
const sellado = (h) => ({
  async seal (msg, peerEncPub) {
    if (!peerEncPub) throw Object.assign(new Error('sin llave'), { code: 'unsealed' })
    return {
      app: 'passmanager',
      sealed: await h.encrypt({ recipients: [{ encryptionPubkey: peerEncPub }], plaintext: JSON.stringify(msg) }),
      from: await h.getEncryptionPubkey()
    }
  },
  async open (env) {
    return JSON.parse((await h.decrypt({ senderEncryptionPubkey: env.from, myToken: null, envelope: env.sealed })).plaintext)
  },
  isSealed: (m) => !!m && m.app === 'passmanager' && !!m.sealed
})

test('el gestor se empareja como cualquier aparato y recibe una credencial', { skip: PROXY ? false : 'sin DOTRINO_PROXY: no se toca producción' }, async (t) => {
  // ----- LA BÓVEDA: este proceso es la CA de su perfil -----
  const bovedaCore = await nucleo()
  const identity = {
    get me () { return bovedaCore.me },
    signData: (data) => bovedaCore.handlers.signData({ data }),
    signDelegation: (sub, scope, opts = {}) => bovedaCore.handlers.signDelegation({ sub, scope, ...opts }),
    listDelegations: () => bovedaCore.handlers.listDelegations({}),
    revokeDelegation: (nonce) => bovedaCore.handlers.revokeDelegation({ nonce }),
    revokeDevice: (sub) => bovedaCore.handlers.revokeDevice({ sub }),
    admitMember: (m) => bovedaCore.handlers.admitMember(m),
    profileActa: () => bovedaCore.handlers.profileActa(),
    encrypt: (a) => bovedaCore.handlers.encrypt(a),
    getEncryptionPubkey: () => bovedaCore.handlers.getEncryptionPubkey(),
    decrypt: (a) => bovedaCore.handlers.decrypt(a)
  }
  const handle = await startDeviceVault(identity, { proxyUrl: PROXY })
  t.after(() => handle.close())
  handle.client.updateConfig({ sealing: sellado(bovedaCore.handlers) })

  const boveda = new LocalVault({ _m: new Map(), async get (k) { return this._m.get(k) }, async set (k, v) { this._m.set(k, v) } })
  boveda.unlock(await makeVaultKey())
  await boveda.put({ title: 'Banco', sites: ['banco.com.ec'], username: 'seyacat', secret: 'hunter2' })

  const miembros = async () => (await bovedaCore.handlers.profileMembers()).members
  const conPermiso = async () => (await miembros()).filter((m) => (m.caps || []).includes('passwords'))

  let known = []
  const responder = new VaultResponder({
    client: handle.client,
    vault: boveda,
    isAllowed: (pub) => known.some((d) => samePubkey(d.pub, pub)),
    encPubOf: (pub) => known.find((d) => samePubkey(d.pub, pub))?.encPub || null,
    needsApproval: () => false
  })
  responder.start()
  t.after(() => responder.stop())

  // ----- 1. la invitación, la de siempre -----
  const { qr } = await handle.startPairing({ scope: ['vault:passwords'], label: 'gestor' })
  const url = inviteUrl(qr)
  assert.ok(url.startsWith('https://'), 'la invitación no es la del ecosistema: ' + url)

  // ----- 2 y 3. el aparato se enrola y enseña su código -----
  const aparatoCore = await nucleo()
  let codigo = null
  const off = aparatoCore.onVaultEvent((e) => { if (e?.phase === 'challenge') codigo = e })

  // Aprobar cuando haya LAS DOS COSAS: el pendiente en la bóveda y el código en la
  // pantalla del aparato. Llegan en ese orden y con un viaje de red en medio, así que
  // mirar una sola vez al ver el pendiente no vale — es el humano leyendo y tecleando.
  const tecleando = setInterval(() => {
    const [p] = handle.listPending()
    if (p && codigo?.code) {
      clearInterval(tecleando)
      handle.approve(p.deviceId, codigo.code).catch(() => {})
    }
  }, 100)
  t.after(() => clearInterval(tecleando))

  const r = await aparatoCore.handlers.vaultPair({ qr: parseInvite(url), label: 'gestor', join: 'new', approveTimeoutMs: 30000 })
  off()

  assert.ok(codigo?.code, 'el aparato no llegó a enseñar ningún código')
  assert.equal(codigo.code.length, 6, 'el código no es el de seis del ecosistema')
  assert.ok(r?.ok, 'el emparejamiento no llegó a término')

  // ----- 4. quedó en el acta, con su permiso y su cert -----
  const yo = await aparatoCore.handlers.publicMe()
  const enElActa = (await conPermiso()).find((m) => m.pub === yo.publickey)
  assert.ok(enElActa, 'el aparato no quedó en el acta con la capacidad `passwords`')
  assert.ok(enElActa.encPub, 'entró sin llave de cifrado: la bóveda no podría contestarle')

  const v = await aparatoCore.handlers.vaultStatus()
  assert.equal(v.paired, true)
  assert.ok(v.scope.includes('vault:passwords'), 'el cert no lleva el permiso: ' + JSON.stringify(v.scope))

  known = await conPermiso()

  // ----- 5. pide una credencial, sellada, y la recibe -----
  const client = new WebSocketProxyClient({
    url: PROXY, enableWebRTC: false, requireSealed: true, sealing: sellado(aparatoCore.handlers)
  })
  await client.connect()
  t.after(() => client.close())
  const data = { op: 'identify', publickey: yo.publickey, token: client.token, ts: Date.now() }
  const { signature } = await aparatoCore.handlers.signData({ data })
  await client.identify({ data, signature })

  const remota = new RemoteVault(new ProxyTransport({
    client,
    peerPubkey: v.master,
    peerEncPub: (await miembros()).find((m) => m.pub === v.master)?.encPub,
    timeoutMs: 15000
  }))

  const hits = await remota.find('https://banco.com.ec/entrar')
  assert.equal(hits.length, 1, 'la bóveda no reconoció al aparato recién emparejado')
  assert.ok(!JSON.stringify(hits).includes('hunter2'), 'el secreto viajó en la lista')
  assert.equal((await remota.get(hits[0].id)).secret, 'hunter2')
})
