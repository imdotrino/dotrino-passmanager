package com.dotrino.passmanager.core

import java.net.URI
import java.net.URLDecoder
import java.nio.ByteBuffer
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** The two-step code — `lib/src/totp.js`. Takes an `otpauth://` URI or a bare base32 secret. */
object Totp {
    private const val B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
    private val HASHES = mapOf("SHA1" to "HmacSHA1", "SHA256" to "HmacSHA256", "SHA512" to "HmacSHA512")

    class Params(val secret: String, val digits: Int, val period: Int, val algorithm: String)

    fun base32(input: String): ByteArray {
        val s = input.uppercase().trimEnd('=').filter { !it.isWhitespace() }
        var bits = 0; var value = 0
        val out = ArrayList<Byte>()
        for (ch in s) {
            val idx = B32.indexOf(ch)
            if (idx == -1) throw PmError("base32: invalid character", "bad-totp")
            value = (value shl 5) or idx; bits += 5
            if (bits >= 8) { bits -= 8; out.add(((value ushr bits) and 0xff).toByte()) }
        }
        return out.toByteArray()
    }

    fun parse(input: String): Params {
        val s = input.trim()
        if (!s.lowercase().startsWith("otpauth://")) return Params(s.filter { !it.isWhitespace() }, 6, 30, "SHA1")
        val u = try { URI(s) } catch (_: Exception) { throw PmError("otpauth: not a valid address", "bad-totp") }
        if (u.host?.lowercase() != "totp") throw PmError("otpauth: unsupported type", "bad-totp")
        val q = (u.rawQuery ?: "").split("&").mapNotNull { p ->
            val i = p.indexOf('='); if (i < 0) null else URLDecoder.decode(p.substring(0, i), "UTF-8") to URLDecoder.decode(p.substring(i + 1), "UTF-8")
        }.toMap()
        val secret = q["secret"]?.takeIf { it.isNotEmpty() } ?: throw PmError("otpauth: missing secret", "bad-totp")
        val digits = q["digits"]?.toIntOrNull()?.takeIf { it in 6..10 } ?: 6
        val period = q["period"]?.toIntOrNull()?.takeIf { it in 1..300 } ?: 30
        return Params(secret, digits, period, (q["algorithm"] ?: "SHA1").uppercase())
    }

    /** The code valid at [nowMs]. */
    fun code(input: String, nowMs: Long = System.currentTimeMillis()): String {
        val p = parse(input)
        val alg = HASHES[p.algorithm] ?: throw PmError("otp: unsupported algorithm: ${p.algorithm}", "bad-totp")
        val counter = nowMs / 1000 / p.period
        val mac = Mac.getInstance(alg).run { init(SecretKeySpec(base32(p.secret), alg)); doFinal(ByteBuffer.allocate(8).putLong(counter).array()) }
        val off = mac[mac.size - 1].toInt() and 0x0f
        val bin = ((mac[off].toInt() and 0x7f) shl 24) or ((mac[off + 1].toInt() and 0xff) shl 16) or
            ((mac[off + 2].toInt() and 0xff) shl 8) or (mac[off + 3].toInt() and 0xff)
        var mod = 1L; repeat(p.digits) { mod *= 10 }
        return (bin.toLong() % mod).toString().padStart(p.digits, '0')
    }

    /** Seconds left before the code changes. */
    fun remaining(input: String, nowMs: Long = System.currentTimeMillis()): Int = parse(input).period.let { it - ((nowMs / 1000) % it).toInt() }
}
