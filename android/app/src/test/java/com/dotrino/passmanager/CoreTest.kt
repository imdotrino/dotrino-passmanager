package com.dotrino.passmanager

import com.dotrino.passmanager.core.Generate
import com.dotrino.passmanager.core.Totp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CoreTest {
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
