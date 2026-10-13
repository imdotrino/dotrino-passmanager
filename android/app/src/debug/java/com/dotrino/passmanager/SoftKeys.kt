package com.dotrino.passmanager

import com.dotrino.sdk.Crypto
import com.dotrino.sdk.DeviceKeys
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.math.BigInteger
import java.security.KeyFactory
import java.security.PrivateKey
import java.security.PublicKey
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECPrivateKeySpec
import java.util.Base64
import javax.crypto.KeyAgreement

/**
 * A device's two keys in SOFTWARE, from the private JWKs a test harness wrote. Only for
 * tests and the debug build: on a phone they live in the chip and never come out.
 */
class SoftKeys(
    sign: JsonObject, enc: JsonObject,
    /** The public keys exactly as the pilar wrote them: the record and the paper compare them as text. */
    publickey: String? = null, encPub: String? = null,
) : DeviceKeys {
    private fun pubOf(j: JsonObject) = """{"kty":"EC","crv":"P-256","x":"${j["x"]!!.jsonPrimitive.content}","y":"${j["y"]!!.jsonPrimitive.content}"}"""
    private fun priv(j: JsonObject): PrivateKey {
        val d = BigInteger(1, Base64.getUrlDecoder().decode(j["d"]!!.jsonPrimitive.content))
        return KeyFactory.getInstance("EC").generatePrivate(ECPrivateKeySpec(d, (Crypto.publicKeyOf(pubOf(j)) as ECPublicKey).params))
    }
    private val s = priv(sign); private val e = priv(enc)
    override val publickey = publickey ?: pubOf(sign)
    override val encPub = encPub ?: pubOf(enc)
    override suspend fun sign(text: String): String =
        Crypto.b64(Crypto.derToP1363(Signature.getInstance("SHA256withECDSA").run { initSign(s); update(text.toByteArray(Charsets.UTF_8)); sign() }))
    override suspend fun agree(peer: PublicKey): ByteArray = KeyAgreement.getInstance("ECDH").run { init(e); doPhase(peer, true); generateSecret() }
}
