package com.dotrino.passmanager

import com.dotrino.passmanager.core.Changes
import com.dotrino.passmanager.core.Entry
import com.dotrino.passmanager.core.Field
import com.dotrino.passmanager.core.PmBoot
import com.dotrino.sdk.ActaSync
import com.dotrino.sdk.Profile
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File

/**
 * AGAINST A REAL PROXY AND A REAL VAULT (`test/e2e-native.mjs`, from the sibling repos
 * dotrino-proxy, dotrino-vault and dotrino-identity): the whole road the app takes — the
 * record brought from the vault, the sealed session, the `pm2.*` desk of `dotrino-vault` —
 * with the device's keys in software instead of the chip.
 */
class VaultE2eTest {
    private lateinit var node: Process
    private lateinit var out: File
    private var opened: PmBoot.Opened? = null

    @Before fun start() {
        val script = generateSequence(File("").absoluteFile) { it.parentFile }.map { File(it, "test/e2e-native.mjs") }.firstOrNull { it.exists() }
            ?: throw IllegalStateException("test/e2e-native.mjs not found above ${File("").absolutePath}")
        out = File.createTempFile("pm-e2e", ".json").also { it.delete() }
        node = ProcessBuilder("node", script.path, out.path).redirectErrorStream(true).redirectOutput(File(out.path + ".log")).start()
        val until = System.currentTimeMillis() + 90_000
        while (!out.exists()) {
            if (!node.isAlive) throw IllegalStateException("the harness died: " + File(out.path + ".log").readText())
            if (System.currentTimeMillis() > until) throw IllegalStateException("the harness did not get ready: " + File(out.path + ".log").readText())
            Thread.sleep(200)
        }
    }

    @After fun stop() {
        opened?.let { it.transport.close(); it.session.close() }
        node.destroy(); out.delete(); File(out.path + ".log").delete()
    }

    @Test fun theAppsRoadWorksAgainstTheRealVault() = runBlocking<Unit> {
        val f = Json.parseToJsonElement(out.readText()).jsonObject
        fun s(k: String) = f[k]!!.jsonPrimitive.content
        val keys = SoftKeys(f["privateJwk"]!!.jsonObject, f["encPrivateJwk"]!!.jsonObject, s("publickey"), s("encPub"))
        val profile = Profile.of(keys, null, Profile.VaultLink(s("master"), s("proxyUrl"), f["cert"]!!.jsonObject, s("deviceId")))
        val warnings = ArrayList<String>()
        val o = PmBoot.open(profile, emptyList(), { p, conn -> ActaSync.update(p, conn, { _, _ -> }) }) { w, e -> warnings.add("$w: $e") }
        opened = o
        assertTrue("the record came from the vault and gives this device passwords: $warnings", o.profile.can("passwords"))
        val vault = o.vault

        assertTrue(vault.list().isEmpty())
        vault.put(Entry(id = "e1", title = "banco.com", name = "Banco", sites = listOf("banco.com"), username = "ana", secret = "s3creta",
            fields = listOf(Field("cédula", "1712345678", null, private = true))))
        val v = vault.list().single()
        assertEquals("Banco", v.hint); assertEquals(listOf("banco.com"), v.sites)
        assertEquals(1, vault.search("banc").size)

        // Nobody in this record approves, so a private value is handed over (the owner's rule).
        val e = vault.get("e1", listOf("secret", "label:cédula"))
        assertEquals("s3creta", e.secret); assertEquals("1712345678", e.fields.single().value)

        vault.patch("e1", Changes(secret = "otra", username = "", hint = "Banco"))
        val after = vault.get("e1")
        assertEquals("otra", after.secret); assertEquals("", after.username); assertEquals("Banco", after.name)
        assertEquals(listOf("secret", "label:cédula"), vault.list().single().fieldKeys)

        vault.remove("e1")
        assertTrue(vault.list().isEmpty())
    }
}
