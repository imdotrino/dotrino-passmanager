// LA BÓVEDA SELLADA CUANDO QUIEN GUARDA Y QUIEN LEE SON EL MISMO PROCESO.
//
// Pasa de verdad en dos sitios: `dotrino-passmanager serve` (atiende por el proxio y es
// también la línea de comandos del dueño) y la bóveda de dentro de la extensión. En los
// dos, quien lee lo hace con UNA envoltura, y se le dice cuál — adivinarla sería leer con
// la que hubiera, y entonces «no puedo abrir esto» y «esto no es para mí» se verían igual.
//
// Lo que se fija:
//
//   1. la vuelta entera —guardar, listar, abrir, buscar por sitio, quitar— con el dueño
//      leyendo por `#recovery`, que es lo que su contraseña abre;
//   2. lo guardado sigue sin llevar ni un valor en claro;
//   3. lo que escribe esta bóveda lo abre un APARATO del acta, que es la razón de que el
//      formato sea el mismo en las cuatro;
//   4. y pedir una entrada que no te envolvieron dice «no es tuya», no «no existe».

import test from 'node:test'
import assert from 'node:assert/strict'
import { openWrap, decryptWithCek } from '@dotrino/identity/content'
import { SealedStore, RECOVERY, KEY } from '../src/sealed/store.js'
import { SealedLocalVault } from '../src/vault/sealed-local.js'
import { makeRecovery, openRecovery, recoveryPubOf } from '../src/sealed/recovery.js'
import { convertToSealed } from '../src/sealed/convert.js'
import { profileKeys } from '../src/sealed/keys.js'
import { openSealedEntry } from '../src/sealed/device.js'

const ECDH = { name: 'ECDH', namedCurve: 'P-256' }
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' }
const SIGN = { name: 'ECDSA', hash: { name: 'SHA-256' } }
const CLAVE = 'una contraseña larga de verdad'
const canon = (v) => (v === null || typeof v !== 'object')
  ? JSON.stringify(v)
  : Array.isArray(v) ? '[' + v.map(canon).join(',') + ']'
    : '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}'

/** Un aparato del acta: el que pedirá por el proxio. */
async function aparato () {
  const sig = await crypto.subtle.generateKey(ECDSA, true, ['sign', 'verify'])
  const enc = await crypto.subtle.generateKey(ECDH, true, ['deriveBits'])
  const j = await crypto.subtle.exportKey('jwk', enc.publicKey)
  return {
    pub: JSON.stringify(await crypto.subtle.exportKey('jwk', sig.publicKey)),
    encPub: JSON.stringify({ kty: j.kty, crv: j.crv, x: j.x, y: j.y }),
    openSealed: async ({ wrap, envelope }) =>
      decryptWithCek({ cek: await openWrap({ wrap, myEncPrivateKey: enc.privateKey }), envelope })
  }
}

/** La bóveda: su identidad firma, y NO está entre los destinatarios. */
async function montar () {
  const sig = await crypto.subtle.generateKey(ECDSA, true, ['sign', 'verify'])
  const miPub = JSON.stringify(await crypto.subtle.exportKey('jwk', sig.publicKey))
  const dispositivo = await aparato()
  const { record } = await makeRecovery({ password: CLAVE })

  const mem = new Map()
  const store = { async get (k) { return mem.get(k) }, async set (k, v) { mem.set(k, v) } }
  const recipientsOf = () => [{ pub: dispositivo.pub, encPub: dispositivo.encPub }]
  const sealed = new SealedStore(store, {
    recipients: recipientsOf,
    verifyAuthor: async ({ body, author }) => crypto.subtle.verify(
      SIGN, sig.publicKey, Uint8Array.from(Buffer.from(author.sig, 'base64')), new TextEncoder().encode(canon(body)))
  })
  const author = {
    publickey: miPub,
    async sign (body) {
      const s = await crypto.subtle.sign(SIGN, sig.privateKey, new TextEncoder().encode(canon(body)))
      return { signature: Buffer.from(new Uint8Array(s)).toString('base64') }
    }
  }
  const recipients = async () => ({
    recoveryPub: recoveryPubOf(record), main: recipientsOf(), passkeys: []
  })
  const priv = await openRecovery({ record, password: CLAVE })
  const openSealed = async ({ wrap, envelope }) =>
    decryptWithCek({ cek: await openWrap({ wrap, myEncPrivateKey: priv }), envelope })

  await convertToSealed({ store, sealed, cek: null, recipients: await recipients(), author, dropOldKey: async () => {} })
  const keys = async () => profileKeys(await openSealed(await sealed.profile({ pub: RECOVERY }).then(
    ({ envelope, wrap }) => ({ wrap, envelope }))))

  const vault = new SealedLocalVault(sealed, { readerPub: RECOVERY, openSealed, author, recipients, keys })
  return { vault, sealed, store, dispositivo, mem }
}

test('la vuelta entera: guardar, listar, abrir, buscar y quitar', async () => {
  const { vault } = await montar()

  await vault.put({ id: 'e1', type: 'login', title: 'El banco', sites: ['banco.example'], username: 'ana', secret: 'la-de-verdad' })
  await vault.put({ id: 'e2', type: 'login', title: 'Sin sitio', sites: [], username: 'ana', secret: 'otra' })

  const lista = await vault.list()
  assert.equal(lista.length, 2)
  assert.ok(lista.some((e) => e.title === 'El banco'), 'la vista se abre con la envoltura del dueño')

  const abierta = await vault.get('e1')
  assert.equal(abierta.secret, 'la-de-verdad')

  const paraElBanco = await vault.find('https://banco.example/login')
  assert.ok(paraElBanco.some((e) => e.id === 'e1'), 'la del banco tiene que salir')
  assert.ok(paraElBanco.some((e) => e.id === 'e2'), 'y la que no tiene sitios vale en cualquiera')

  assert.deepEqual(await vault.sites(), ['banco.example'])

  await vault.remove('e1')
  assert.equal((await vault.list()).length, 1)
})

test('lo guardado no lleva ni un valor en claro', async () => {
  const { vault, mem } = await montar()
  await vault.put({ id: 'e1', type: 'login', title: 'El banco', sites: ['banco.example'], secret: 'la-de-verdad' })
  const crudo = JSON.stringify(mem.get(KEY))
  assert.ok(!crudo.includes('la-de-verdad'), 'la contraseña quedó en claro')
  assert.ok(!crudo.includes('banco.example'), 'el sitio va por huella')
  assert.ok(!crudo.includes('El banco'), 'ni el título')
})

test('lo que escribe esta bóveda lo abre un APARATO del acta', async () => {
  const { vault, sealed, dispositivo } = await montar()
  await vault.put({ id: 'e1', type: 'login', title: 'El banco', sites: ['banco.example'], secret: 'la-de-verdad' })

  const suya = await sealed.get('e1', { pub: dispositivo.pub })
  const abierta = await openSealedEntry({ got: suya, openSealed: dispositivo.openSealed })
  assert.equal(abierta.secret, 'la-de-verdad', 'si no, el formato no sería el mismo en las cuatro')
})

test('una entrada que no te envolvieron dice «no es tuya», no «no existe»', async () => {
  const { vault, sealed } = await montar()
  await vault.put({ id: 'e1', type: 'login', title: 'x', sites: [], secret: 'y' })

  const ajena = await sealed.get('e1', { pub: 'otro-que-no-tiene-envoltura' }).catch((e) => e)
  assert.equal(ajena.code, 'not-yours')

  const noHay = await vault.get('no-existe').catch((e) => e)
  assert.match(String(noHay.message), /id/)
})

test('cambiar un campo no toca los demás', async () => {
  const { vault } = await montar()
  await vault.put({ id: 'e1', type: 'login', title: 'El banco', sites: ['banco.example'], username: 'ana', secret: 'vieja' })
  await vault.patch('e1', { secret: 'nueva' })
  const e = await vault.get('e1')
  assert.equal(e.secret, 'nueva')
  assert.equal(e.username, 'ana', 'lo que no se tocó se queda')
  assert.equal(e.title, 'El banco')
})
