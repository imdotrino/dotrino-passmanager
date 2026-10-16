package com.dotrino.passmanager.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.spec.ECParameterSpec
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.Signature
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECPrivateKeySpec
import java.util.Base64

/**
 * A passkey as the vault keeps it — the `webauthn` of an entry (`lib/src/webauthn.js`).
 * [privateKey] is the WebCrypto JWK as text, so the extension opens what the phone saved.
 */
data class Passkey(
    val credentialId: String,
    val rpId: String,
    val userHandle: String = "",
    val privateKey: String = "",
    val signCount: Long = 0,
)

/**
 * PASSKEYS: create a WebAuthn credential and sign with it — the port of `lib/src/webauthn.js`,
 * byte for byte. A malformed `authenticatorData` is rejected by the server without saying why,
 * so the format is fixed here and checked against the JS in `BridgeTest`.
 *
 * Same flags as the extension (UP | UV, plus AT on creation) and the same zero AAGUID: a
 * passkey is ONE credential used from the phone and from the browser, and a site that saw
 * different flags from each would take it for two.
 */
object Webauthn {
    const val UP = 0x01
    const val UV = 0x04
    const val AT = 0x40

    private val rnd = SecureRandom()

    fun b64url(b: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(b)
    fun unb64url(s: String): ByteArray = Base64.getUrlDecoder().decode(s.trimEnd('='))
    fun sha256(b: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(b)

    private fun u32(n: Long) = byteArrayOf((n ushr 24).toByte(), (n ushr 16).toByte(), (n ushr 8).toByte(), n.toByte())
    private fun u16(n: Int) = byteArrayOf((n ushr 8).toByte(), n.toByte())

    /** `rpIdHash ‖ flags ‖ signCount (big-endian)` (+ the attested credential on creation). */
    fun authenticatorData(rpId: String, flags: Int, signCount: Long, attested: ByteArray? = null): ByteArray =
        sha256(rpId.toByteArray(Charsets.UTF_8)) + byteArrayOf(flags.toByte()) + u32(signCount) + (attested ?: ByteArray(0))

    /** A coordinate as exactly 32 bytes: BigInteger drops leading zeros and may add a sign byte. */
    private fun fixed32(v: BigInteger): ByteArray {
        val b = v.toByteArray()
        return when {
            b.size == 32 -> b
            b.size > 32 -> b.copyOfRange(b.size - 32, b.size)
            else -> ByteArray(32 - b.size) + b
        }
    }

    /** COSE_Key of a P-256 public key (kty 2, alg -7, crv 1), the same 77 bytes the JS writes. */
    fun cose(pub: ECPublicKey): ByteArray =
        byteArrayOf(0xa5.toByte(), 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20) + fixed32(pub.w.affineX) +
            byteArrayOf(0x22, 0x58, 0x20) + fixed32(pub.w.affineY)

    /** `{"type", "challenge", "origin", "crossOrigin"}` in that order, as `JSON.stringify` writes it. */
    fun clientDataJson(type: String, challenge: String, origin: String): ByteArray =
        buildJsonObject { put("type", type); put("challenge", challenge); put("origin", origin); put("crossOrigin", false) }
            .toString().toByteArray(Charsets.UTF_8)

    private fun jwkOf(priv: ECPrivateKey, pub: ECPublicKey): String = buildJsonObject {
        // The keys in the order WebCrypto's exportKey gives them; `key_ops` has to allow `sign`.
        put("crv", "P-256"); put("d", b64url(fixed32(priv.s))); put("ext", true)
        put("key_ops", buildJsonArray { add(JsonPrimitive("sign")) }); put("kty", "EC")
        put("x", b64url(fixed32(pub.w.affineX))); put("y", b64url(fixed32(pub.w.affineY)))
    }.toString()

    private fun privateKeyOf(jwk: String): ECPrivateKey {
        val o = kotlinx.serialization.json.Json.parseToJsonElement(jwk) as? JsonObject
            ?: throw PmError("the passkey's private key is not a JWK", "bad-passkey")
        val d = (o["d"] as? JsonPrimitive)?.content ?: throw PmError("the passkey's private key has no d", "bad-passkey")
        val params = AlgorithmParameters.getInstance("EC").apply { init(ECGenParameterSpec("secp256r1")) }.getParameterSpec(ECParameterSpec::class.java)
        return KeyFactory.getInstance("EC").generatePrivate(ECPrivateKeySpec(BigInteger(1, unb64url(d)), params)) as ECPrivateKey
    }

    /** A minimal CBOR byte string header: the attestation object is fixed apart from authData's length. */
    private fun cborBytes(b: ByteArray): ByteArray = when {
        b.size < 24 -> byteArrayOf((0x40 + b.size).toByte())
        b.size < 256 -> byteArrayOf(0x58, b.size.toByte())
        else -> byteArrayOf(0x59) + u16(b.size)
    } + b

    private fun cborText(s: String): ByteArray = s.toByteArray(Charsets.UTF_8).let { byteArrayOf((0x60 + it.size).toByte()) + it }

    class Created(val passkey: Passkey, val credentialId: ByteArray, val authData: ByteArray, val publicKeySpki: ByteArray, val attestationObject: ByteArray)

    /** A new passkey for [rpId]. Nothing here is saved: the caller saves it BEFORE answering the site. */
    fun create(rpId: String, userHandle: ByteArray?): Created {
        val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        val pub = pair.public as ECPublicKey
        val credentialId = ByteArray(32).also(rnd::nextBytes)
        // UV goes on because the person opens their vault for this: there is real verification.
        val attested = ByteArray(16) + u16(credentialId.size) + credentialId + cose(pub)
        val authData = authenticatorData(rpId, UP or UV or AT, 0, attested)
        val att = byteArrayOf(0xa3.toByte()) + cborText("fmt") + cborText("none") + cborText("attStmt") + byteArrayOf(0xa0.toByte()) +
            cborText("authData") + cborBytes(authData)
        return Created(
            Passkey(b64url(credentialId), rpId, userHandle?.let(::b64url) ?: "", jwkOf(pair.private as ECPrivateKey, pub), 0),
            credentialId, authData, pub.encoded, att,
        )
    }

    class Assertion(val signCount: Long, val authData: ByteArray, val signature: ByteArray)

    /**
     * Signs `authenticatorData ‖ clientDataHash`. The signature comes out in DER, which is what
     * WebAuthn wants (Java's SHA256withECDSA already gives DER; WebCrypto's raw needs converting).
     */
    fun sign(passkey: Passkey, clientDataHash: ByteArray): Assertion {
        // The counter goes up on every signature and is saved in the vault: if it stays put the
        // server suspects a cloned credential.
        val signCount = passkey.signCount + 1
        val authData = authenticatorData(passkey.rpId, UP or UV, signCount)
        val sig = Signature.getInstance("SHA256withECDSA").run { initSign(privateKeyOf(passkey.privateKey)); update(authData + clientDataHash); sign() }
        return Assertion(signCount, authData, sig)
    }
}
