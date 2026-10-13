package com.dotrino.passmanager.core

import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * The profile's password key and the two that come out of it — `lib/src/sealed/keys.js`.
 *
 * `kidx` is the site index (the vault searches by fingerprints, not by domains) and `kcmp`
 * compares a value without opening it. Two keys and not one so that one use cannot stand in
 * for the other: they come from HKDF with different labels.
 */
class ProfileKeys(val kidx: ByteArray, val kcmp: ByteArray)

object PmKeys {
    private fun hmac(key: ByteArray, data: ByteArray): ByteArray =
        Mac.getInstance("HmacSHA256").run { init(SecretKeySpec(key, "HmacSHA256")); doFinal(data) }

    /** HKDF-SHA256 with an empty salt and one block of output: what WebCrypto's `deriveKey` to a 256-bit HMAC key gives. */
    private fun derive(base: ByteArray, use: String): ByteArray {
        val prk = hmac(ByteArray(32), base)
        return hmac(prk, ("dotrino-passmanager/v2/$use").toByteArray(Charsets.UTF_8) + byteArrayOf(1))
    }

    fun profileKeys(base: String): ProfileKeys {
        if (base.isEmpty()) throw PmError("missing the profile password key", "no-profile-key")
        val raw = Base64.getDecoder().decode(base)
        return ProfileKeys(derive(raw, "idx"), derive(raw, "cmp"))
    }

    /** 128 bits of the HMAC, base64: enough not to collide, half the bytes. */
    private fun hmac16(key: ByteArray, text: String): String =
        Base64.getEncoder().encodeToString(hmac(key, text.toByteArray(Charsets.UTF_8)).copyOf(16))

    /** A site's fingerprint. Normalised HERE and only here: a differing case is an entry that never shows up. */
    fun siteIndex(kidx: ByteArray, site: String) = hmac16(kidx, "site " + site.trim().lowercase())

    /** The fingerprint of a free field's NAME: the vault matches keys without reading «cédula». */
    fun fieldIndex(kidx: ByteArray, key: String) = hmac16(kidx, "field $key")

    /** A value's digest. The entry id and the field name go INSIDE: the same value twice gives two digests. */
    fun valueDigest(kcmp: ByteArray, id: String, field: String, value: String) = hmac16(kcmp, "$id $field $value")
}

/** What went wrong, with the code the other side sent — the screen turns it into words. */
class PmError(message: String, val code: String) : Exception(message)
