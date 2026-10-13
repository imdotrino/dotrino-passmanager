package com.dotrino.passmanager.core

import java.security.SecureRandom

/** The password generator — `lib/src/generate.js`. Same alphabets, same rules. */
object Generate {
    private const val LOWER = "abcdefghijkmnopqrstuvwxyz"   // no «l»
    private const val UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ"    // no «I» nor «O»
    private const val DIGITS = "23456789"                   // no zero nor one
    private const val SYMBOLS = "!#\$%&*+-=?@_"
    private val random = SecureRandom()

    /** An integer in [0, max) without bias. */
    private fun below(max: Int): Int {
        val limit = (256 / max) * max
        val b = ByteArray(1)
        while (true) { random.nextBytes(b); val v = b[0].toInt() and 0xff; if (v < limit) return v % max }
    }

    fun password(length: Int = 20, upper: Boolean = true, digits: Boolean = true, symbols: Boolean = true, ambiguous: Boolean = false): String {
        val groups = ArrayList<String>()
        groups.add(if (ambiguous) LOWER + "l" else LOWER)
        if (upper) groups.add(if (ambiguous) UPPER + "IO" else UPPER)
        if (digits) groups.add(if (ambiguous) DIGITS + "01" else DIGITS)
        if (symbols) groups.add(SYMBOLS)
        val alphabet = groups.joinToString("")
        val size = maxOf(maxOf(groups.size, 4), minOf(256, length))
        // One of each group for sure, then shuffled so they are not at the start.
        val chars = groups.map { it[below(it.length)] }.toMutableList()
        while (chars.size < size) chars.add(alphabet[below(alphabet.length)])
        for (i in chars.size - 1 downTo 1) { val j = below(i + 1); val t = chars[i]; chars[i] = chars[j]; chars[j] = t }
        return chars.joinToString("")
    }
}
