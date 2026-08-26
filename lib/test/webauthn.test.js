import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createCredential, signAssertion, b64urlDecode, b64urlEncode,
  rawSignatureToDer, credentialMatches, coseFromJwk, FLAGS,
} from '../src/webauthn.js'

const enc = new TextEncoder()
const dec = new TextDecoder()

/**
 * Verifica la assertion COMO LO HARÍA EL SERVIDOR (WebAuthn L2 §7.2): rehace
 * `authenticatorData || sha256(clientDataJSON)` y comprueba la firma contra la pública
 * que se registró. Si esto pasa, Salesforce la acepta; si no, la rechaza sin decir por
 * qué — que es justo el fallo que no se puede depurar desde fuera.
 */
async function verificaComoElServidor ({ publicKeyJwk, assertion, rpId, origin, challenge }) {
  const authData = b64urlDecode(assertion.response.authenticatorData)
  const clientDataJSON = b64urlDecode(assertion.response.clientDataJSON)

  const cliente = JSON.parse(dec.decode(clientDataJSON))
  assert.equal(cliente.type, 'webauthn.get')
  assert.equal(cliente.origin, origin)
  assert.equal(cliente.challenge, challenge)

  // El hash del rpId son los primeros 32 bytes.
  const esperado = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(rpId)))
  assert.deepEqual(authData.slice(0, 32), esperado, 'el hash del rpId no cuadra')

  const firmado = new Uint8Array([
    ...authData,
    ...new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataJSON)),
  ])

  const key = await crypto.subtle.importKey(
    'jwk', publicKeyJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])

  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    derToRaw(b64urlDecode(assertion.response.signature)),
    firmado)
}

/** El servidor pasa el DER a crudo para verificar; aquí se hace el camino inverso. */
function derToRaw (der) {
  assert.equal(der[0], 0x30, 'la firma no es una SEQUENCE DER')
  let i = 2
  const leer = () => {
    assert.equal(der[i], 0x02, 'se esperaba un INTEGER')
    const len = der[i + 1]
    let v = der.slice(i + 2, i + 2 + len)
    i += 2 + len
    while (v.length > 32) v = v.slice(1)          // quita el relleno de signo
    const out = new Uint8Array(32)
    out.set(v, 32 - v.length)                      // alinea a 32 bytes
    return out
  }
  return new Uint8Array([...leer(), ...leer()])
}

const ORIGEN = 'https://login.salesforce.com'
const RP = 'salesforce.com'

test('passkey: la firma VERIFICA como en el servidor', async () => {
  const reto = b64urlEncode(crypto.getRandomValues(new Uint8Array(32)))
  const creada = await createCredential({
    rpId: RP, origin: ORIGEN, challenge: reto,
    userHandle: enc.encode('usuario-1'), userName: 'sandrade@dotrino.com',
  })

  // El servidor guarda la pública; aquí se saca del par para comprobar el ciclo.
  const jwkPriv = JSON.parse(creada.entry.privateKey)
  const publicKeyJwk = { kty: jwkPriv.kty, crv: jwkPriv.crv, x: jwkPriv.x, y: jwkPriv.y }

  const retoLogin = b64urlEncode(crypto.getRandomValues(new Uint8Array(32)))
  const firmada = await signAssertion({
    entry: creada.entry, origin: ORIGEN, challenge: retoLogin,
  })

  assert.equal(await verificaComoElServidor({
    publicKeyJwk, assertion: firmada.response, rpId: RP, origin: ORIGEN, challenge: retoLogin,
  }), true, 'el servidor rechazaría esta firma')
})

test('passkey: un reto distinto NO valida (no se puede reusar una firma)', async () => {
  const creada = await createCredential({ rpId: RP, origin: ORIGEN, challenge: 'a'.repeat(43) })
  const jwkPriv = JSON.parse(creada.entry.privateKey)
  const publicKeyJwk = { kty: jwkPriv.kty, crv: jwkPriv.crv, x: jwkPriv.x, y: jwkPriv.y }

  const firmada = await signAssertion({ entry: creada.entry, origin: ORIGEN, challenge: 'b'.repeat(43) })
  assert.equal(await verificaComoElServidor({
    publicKeyJwk, assertion: firmada.response, rpId: RP, origin: ORIGEN, challenge: 'c'.repeat(43),
  }).catch(() => false), false)
})

test('passkey: la firma va en DER, no en el crudo de WebCrypto', async () => {
  // Es el fallo silencioso clásico: WebCrypto da r||s y WebAuthn espera SEQUENCE DER.
  const creada = await createCredential({ rpId: RP, origin: ORIGEN, challenge: 'x'.repeat(43) })
  const firmada = await signAssertion({ entry: creada.entry, origin: ORIGEN, challenge: 'y'.repeat(43) })
  const sig = b64urlDecode(firmada.response.response.signature)
  assert.equal(sig[0], 0x30)
  assert.equal(sig[1], sig.length - 2, 'el largo declarado no cuadra')

  // Con un valor que empieza por bit alto hay que meter el byte de relleno, o el
  // servidor lee un número negativo.
  const alto = new Uint8Array(64).fill(0xff)
  const der = rawSignatureToDer(alto)
  assert.equal(der[2], 0x02)
  assert.equal(der[4], 0x00, 'falta el byte de signo')
})

test('passkey: el contador SUBE en cada firma (si no, el servidor sospecha clonación)', async () => {
  const creada = await createCredential({ rpId: RP, origin: ORIGEN, challenge: 'x'.repeat(43) })
  let entry = creada.entry
  assert.equal(entry.signCount, 0)

  const cuentas = []
  for (let i = 0; i < 3; i++) {
    const r = await signAssertion({ entry, origin: ORIGEN, challenge: 'z'.repeat(43) })
    cuentas.push(r.signCount)
    entry = { ...entry, signCount: r.signCount }

    const authData = b64urlDecode(r.response.response.authenticatorData)
    assert.equal(new DataView(authData.buffer).getUint32(33, false), r.signCount,
      'el contador del authenticatorData no coincide con el guardado')
  }
  assert.deepEqual(cuentas, [1, 2, 3])
})

test('passkey: las banderas dicen presencia y verificación, y AT solo al crear', async () => {
  const creada = await createCredential({ rpId: RP, origin: ORIGEN, challenge: 'x'.repeat(43) })
  const firmada = await signAssertion({ entry: creada.entry, origin: ORIGEN, challenge: 'y'.repeat(43) })
  const flags = b64urlDecode(firmada.response.response.authenticatorData)[32]

  assert.ok(flags & FLAGS.UP, 'sin presencia de usuario')
  assert.ok(flags & FLAGS.UV, 'sin verificación de usuario')
  assert.ok(!(flags & FLAGS.AT), 'una assertion no lleva credencial adjunta')
})

test('passkey: la pública viaja en COSE con los valores que el servidor espera', async () => {
  const jwk = { kty: 'EC', crv: 'P-256', x: b64urlEncode(new Uint8Array(32).fill(1)), y: b64urlEncode(new Uint8Array(32).fill(2)) }
  const cose = coseFromJwk(jwk)
  assert.equal(cose[0], 0xa5, 'no es un mapa de 5')
  assert.equal(cose.length, 77, 'una COSE_Key P-256 son 77 bytes')
  assert.equal(cose[2], 0x02, 'kty debe ser 2 (EC2)')
  assert.equal(cose[4], 0x26, 'alg debe ser -7 (ES256)')
})

test('passkey: solo se ofrece la del sitio, y la que el sitio permite', async () => {
  const mia = { webauthn: { rpId: 'salesforce.com', credentialId: 'AAA' } }
  assert.equal(credentialMatches(mia, 'salesforce.com'), true)
  assert.equal(credentialMatches(mia, 'otra.com'), false)
  assert.equal(credentialMatches(mia, 'salesforce.com', [{ id: 'AAA' }]), true)
  assert.equal(credentialMatches(mia, 'salesforce.com', [{ id: 'BBB' }]), false)
  assert.equal(credentialMatches({}, 'salesforce.com'), false)
})
