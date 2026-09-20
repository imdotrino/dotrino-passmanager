// LAS DOS PUNTAS, HABLANDO: `SealedVault` (el aparato) contra `SealedResponder` (la bóveda).
//
// La prueba anterior (`sellado.test.js`) mira el formato; esta mira el PROTOCOLO y, sobre
// todo, que la interfaz de siempre siga funcionando: `find(url)`, `get(id, {keys})`,
// `put`, `patch`, `search`, `sites`. Si esto pasa, el gestor no tiene que aprender nada
// nuevo — lo que cambió está debajo.
//
// El transporte es una llamada directa: lo que se prueba es el protocolo, no la red.

import test from 'node:test'
import assert from 'node:assert/strict'
import { openWrap, decryptWithCek } from '@dotrino/identity/content'
import { SealedStore } from '../src/sealed/store.js'
import { SealedResponder } from '../src/vault/sealed-responder.js'
import { SealedVault } from '../src/vault/sealed.js'

const ECDH = { name: 'ECDH', namedCurve: 'P-256' }
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' }
const SIGN = { name: 'ECDSA', hash: { name: 'SHA-256' } }

function canon (v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']'
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}'
}

async function device () {
  const sig = await crypto.subtle.generateKey(ECDSA, true, ['sign', 'verify'])
  const enc = await crypto.subtle.generateKey(ECDH, true, ['deriveBits'])
  const encJwk = await crypto.subtle.exportKey('jwk', enc.publicKey)
  const pub = JSON.stringify(await crypto.subtle.exportKey('jwk', sig.publicKey))
  return {
    pub,
    encPub: JSON.stringify({ kty: encJwk.kty, crv: encJwk.crv, x: encJwk.x, y: encJwk.y }),
    verifyKey: sig.publicKey,
    identity: {
      publickey: pub,
      async sign (body) {
        const s = await crypto.subtle.sign(SIGN, sig.privateKey, new TextEncoder().encode(canon(body)))
        return { signature: Buffer.from(new Uint8Array(s)).toString('base64') }
      },
      async openSealed ({ wrap, envelope }) {
        const cek = await openWrap({ wrap, myEncPrivateKey: enc.privateKey })
        return decryptWithCek({ cek, envelope })
      }
    }
  }
}

async function recoveryKey () {
  const enc = await crypto.subtle.generateKey(ECDH, true, ['deriveBits'])
  const jwk = await crypto.subtle.exportKey('jwk', enc.publicKey)
  return JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y })
}

/**
 * Una bóveda y un aparato ya enlazados. `aprobar` decide qué contesta el teléfono cuando la
 * bóveda pide el dedo encima.
 */
async function montar ({ aprobar = true, conPasskeys = true } = {}) {
  const ap = await device()
  const recoveryPub = await recoveryKey()
  const mem = new Map()
  const pedidos = []
  const store = new SealedStore(
    { async get (k) { return mem.get(k) }, async set (k, v) { mem.set(k, v) } },
    {
      recipients: (kind) => (kind === 'passkeys' && !conPasskeys ? [] : [{ pub: ap.pub, encPub: ap.encPub }]),
      verifyAuthor: async ({ body, author }) => author.pub === ap.pub && crypto.subtle.verify(
        SIGN, ap.verifyKey, Uint8Array.from(Buffer.from(author.sig, 'base64')),
        new TextEncoder().encode(canon(body)))
    }
  )
  const responder = new SealedResponder({
    client: null,
    store,
    recipients: async () => ({
      recoveryPub,
      main: [{ pub: ap.pub, encPub: ap.encPub }],
      passkeys: conPasskeys ? [{ pub: ap.pub, encPub: ap.encPub }] : []
    }),
    isAllowed: (pub) => pub === ap.pub,
    encPubOf: (pub) => (pub === ap.pub ? ap.encPub : null),
    needsApproval: async () => true,
    approve: async (r) => { pedidos.push(r); return aprobar },
    onRequest: () => {}
  })
  // El transporte, en corto: se le pasa la petición al responder y se devuelve su respuesta.
  const transport = {
    async request (op, payload) {
      let salida = null
      const cliente = {
        pubkeyOfToken: () => ap.pub,
        sendSealedTo: (_to, msg) => { salida = msg },
        on () {}, off () {}
      }
      responder.client = cliente
      await responder.handle({ from: 'tok', pubkey: ap.pub, msg: { type: 'dotrino.passmanager/1', rid: 'r1', op, payload } })
      if (salida?.error) throw Object.assign(new Error(salida.error.message), { code: salida.error.code })
      return salida?.result
    }
  }
  const vault = new SealedVault(transport, { identity: ap.identity })
  await vault.initProfileKey()
  return { vault, store, responder, pedidos, ap, mem }
}

const CUENTA = {
  id: 'e1',
  title: 'Correo',
  sites: ['empresa.com'],
  username: 'ana@empresa.com',
  secret: 'la contraseña larga',
  fields: [{ label: 'socio', value: '12345', kind: 'id-number' }]
}

test('guardar y encontrar por el sitio, con la misma interfaz de siempre', async () => {
  const { vault } = await montar()
  await vault.put(CUENTA)

  const hits = await vault.find('https://empresa.com/login')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].title, 'Correo')
  assert.equal(hits[0].hint, 'ana@empresa.com')
  assert.ok(hits[0].hasSecret)

  // Un SUBDOMINIO también empareja: la regla es la de `match.js`, que sigue siendo una.
  assert.equal((await vault.find('https://login.empresa.com/')).length, 1)
  // Y un dominio que solo se le parece, no.
  assert.equal((await vault.find('https://evil-empresa.com/')).length, 0)
})

test('pedir un campo público no despierta al teléfono; pedir la contraseña sí', async () => {
  const { vault, pedidos } = await montar()
  await vault.put(CUENTA)

  const publico = await vault.get('e1', { keys: ['username'] })
  assert.equal(publico.username, 'ana@empresa.com')
  assert.equal(publico.secret, '')
  assert.equal(pedidos.length, 0, 'rellenar un nombre pidió un dedo encima')

  const privado = await vault.get('e1', { keys: ['secret'] })
  assert.equal(privado.secret, 'la contraseña larga')
  assert.equal(pedidos.length, 1, 'la contraseña salió sin aprobación')
})

test('si el teléfono dice que no, no sale', async () => {
  const { vault } = await montar({ aprobar: false })
  await vault.put(CUENTA)
  await assert.rejects(() => vault.get('e1', { keys: ['secret'] }), (e) => /autoriz/i.test(e.message))
  // Y lo público sigue saliendo: decir que no a una contraseña no apaga el gestor.
  assert.equal((await vault.get('e1', { keys: ['username'] })).username, 'ana@empresa.com')
})

test('un campo marcado privado por el usuario también pregunta', async () => {
  const { vault, pedidos } = await montar()
  await vault.put({ ...CUENTA, fields: [{ label: 'socio', value: '12345', kind: 'id-number', private: true }] })
  await vault.get('e1', { keys: ['id-number'] })
  assert.equal(pedidos.length, 1, 'un campo que el usuario marcó privado salió sin preguntar')
})

test('cambiar un campo no saca los demás de la bóveda', async () => {
  const { vault, pedidos } = await montar()
  await vault.put(CUENTA)
  pedidos.length = 0

  await vault.patch('e1', { username: 'otra@empresa.com' })
  assert.equal(pedidos.length, 0, 'cambiar el usuario pidió aprobación: algo está leyendo de más')

  const todo = await vault.get('e1')
  assert.equal(todo.username, 'otra@empresa.com')
  assert.equal(todo.secret, 'la contraseña larga', 'se perdió la contraseña al cambiar el usuario')
  assert.deepEqual(JSON.parse(todo.fields), [{ label: 'socio', value: '12345', kind: 'id-number' }])
})

test('marcar un campo como privado no lo saca de la bóveda', async () => {
  const { vault, pedidos } = await montar()
  await vault.put(CUENTA)
  pedidos.length = 0

  await vault.patch('e1', { fields: [{ label: 'socio', kind: 'id-number', private: true }] })
  assert.equal(pedidos.length, 0, 'poner una marca pidió el valor')

  const vista = (await vault.find('https://empresa.com/'))[0]
  assert.ok(vista.privateKeys.includes('id-number'), 'la marca no quedó puesta')
  assert.equal((await vault.get('e1', { keys: ['id-number'] })).fields.includes('12345'), true, 'el valor se perdió')
})

test('buscar por texto y listar sitios los hace el aparato, con las vistas abiertas', async () => {
  const { vault } = await montar()
  await vault.put(CUENTA)
  await vault.put({ ...CUENTA, id: 'e2', title: 'Banco', sites: ['banco.com'], username: 'ana' })

  assert.deepEqual((await vault.search('banco')).map((v) => v.id), ['e2'])
  assert.deepEqual(await vault.sites(), [{ site: 'banco.com', count: 1 }, { site: 'empresa.com', count: 1 }])
})

test('comparar sin abrir: el resumen dice si es la misma contraseña', async () => {
  const { vault } = await montar()
  await vault.put(CUENTA)
  const vista = (await vault.find('https://empresa.com/'))[0]

  assert.equal(await vault.digest('e1', 'secret', 'la contraseña larga'), vista.fieldHashes.secret)
  assert.notEqual(await vault.digest('e1', 'secret', 'otra cosa'), vista.fieldHashes.secret)
})

test('quitar una entrada la quita', async () => {
  const { vault } = await montar()
  await vault.put(CUENTA)
  await vault.remove('e1')
  assert.deepEqual(await vault.find('https://empresa.com/'), [])
})

test('una passkey que ningún aparato podría abrir no se guarda, y se dice por qué', async () => {
  const { vault } = await montar({ conPasskeys: false })
  // Sin nadie con `passkeys` en el acta, guardarla la dejaría viva solo para la frase del
  // perfil: no se pierde, pero no sirve — y eso se descubre el día que hace falta.
  await assert.rejects(
    () => vault.put({ ...CUENTA, webauthn: { rpId: 'empresa.com', credentialId: 'c1', privateKey: 'LA-PRIVADA' } }),
    (e) => e.code === 'no-passkeys-device')
})

test('con el permiso, la passkey se guarda y se abre', async () => {
  const { vault } = await montar()
  await vault.put({ ...CUENTA, webauthn: { rpId: 'empresa.com', credentialId: 'c1', privateKey: 'LA-PRIVADA' } })
  const hits = await vault.findPasskey({ rpId: 'empresa.com' })
  assert.equal(hits.length, 1)
  const abierta = await vault.get('e1')
  assert.equal(abierta.webauthn.privateKey, 'LA-PRIVADA')
})
