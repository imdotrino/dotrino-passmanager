package com.dotrino.passmanager

import com.dotrino.passmanager.core.Entry
import com.dotrino.passmanager.core.Field
import com.dotrino.passmanager.core.Generate
import com.dotrino.passmanager.core.PmKeys
import com.dotrino.passmanager.core.Totp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CoreTest {
    /**
     * The SAME values `lib/src/sealed/keys.js` gives for this base key (and iOS's CoreTests
     * expects): if a fingerprint differs by a byte, the entry never shows up, without an error.
     */
    @Test fun theProfileKeysAreTheOnesTheJsDerives() {
        val k = PmKeys.profileKeys("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=")
        assertEquals("vnUYh29wD+hnT4FOvtNffw==", PmKeys.siteIndex(k.kidx, " Banco.COM "))
        assertEquals("45Rne0EufT9JzCQ7ElUa9w==", PmKeys.fieldIndex(k.kidx, "label:cédula"))
        assertEquals("ZMw1klXZu+JT19cjGKSP2w==", PmKeys.valueDigest(k.kcmp, "e1", "secret", "la contraseña larga"))
    }

    @Test fun anEntrySaysWhatItIsCalledAndWhatIsPrivate() {
        val e = Entry(id = "e1", username = "ana", secret = "x", notes = "n",
            fields = listOf(Field("correo", "a@b.c", "email"), Field("cédula", "17", null, private = true)))
        assertEquals("ana", e.who())
        assertEquals(listOf("username", "secret", "email", "label:cédula"), e.fieldValues().map { it.first })
        assertEquals(listOf("secret", "notes", "label:cédula"), e.privateKeys())
        assertEquals("a@b.c", Entry(id = "e2", fields = e.fields).who())
        assertEquals(listOf("banco.com"), Entry.normalizeSites(listOf(" Banco.com ", "banco.com", "")))
    }

    /** RFC 6238, appendix B (SHA-1, 8 digits). */
    @Test fun theTwoStepCodeIsTheStandardOne() {
        val uri = "otpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=8"
        assertEquals("94287082", Totp.code(uri, 59_000))
        assertEquals("07081804", Totp.code(uri, 1111111109_000))
        assertEquals(6, Totp.code("GEZD GNBV GY3T QOJQ", 59_000).length)
        assertEquals(1, Totp.remaining(uri, 59_000))
    }

    @Test fun aGeneratedPasswordHasOneOfEachAndNothingAmbiguous() {
        repeat(200) {
            val p = Generate.password(20)
            assertEquals(20, p.length)
            assertTrue(p.any { it.isLowerCase() } && p.any { it.isUpperCase() } && p.any { it.isDigit() } && p.any { !it.isLetterOrDigit() })
            assertTrue(p.none { it in "lIO01" })
        }
        assertTrue(Generate.password(12, upper = false, digits = false, symbols = false).all { it.isLowerCase() })
    }
}
