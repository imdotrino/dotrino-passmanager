package com.dotrino.passmanager

import com.dotrino.passmanager.core.Changes
import com.dotrino.passmanager.core.Entry
import com.dotrino.passmanager.core.Field
import com.dotrino.passmanager.core.PmError
import com.dotrino.passmanager.core.PmIdentity
import com.dotrino.passmanager.core.PmTransport
import com.dotrino.passmanager.core.PmVault
import com.dotrino.passmanager.core.Webauthn
import com.dotrino.sdk.Canonical
import com.dotrino.sdk.Crypto
import com.dotrino.sdk.DeviceKeys
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.File
import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import java.security.spec.X509EncodedKeySpec
import java.security.PublicKey
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import javax.crypto.KeyAgreement

/**
 * THE NATIVE CLIENT AGAINST THE REAL JS LIBRARY (`lib/test/native-bridge.mjs`): a sealed
 * vault of `@dotrino/passmanager` with two devices in its record — this one and a JS one.
 * What the phone writes the extension must open, and the other way round; the vault checks
 * the recipients and the author's signature as in production.
 *
 * It needs `node` and the lib's dependencies installed (`cd lib && npm install`).
 */
class BridgeTest {
    private class Keys : DeviceKeys, PmIdentity {
        private fun pair() = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        private val s = pair(); private val e = pair()
        override val publickey = Crypto.jwkOf(s.public as ECPublicKey)
        override val encPub = Crypto.jwkOf(e.public as ECPublicKey)
        override suspend fun sign(text: String): String =
            Crypto.b64(Crypto.derToP1363(Signature.getInstance("SHA256withECDSA").run { initSign(s.private); update(text.toByteArray(Charsets.UTF_8)); sign() }))
        override suspend fun agree(peer: PublicKey): ByteArray = KeyAgreement.getInstance("ECDH").run { init(e.private); doPhase(peer, true); generateSecret() }
        override suspend fun sign(body: JsonObject): String = sign(Canonical.stringify(body))
        override suspend fun openSealed(wrap: JsonObject, envelope: JsonObject): String = Crypto.openSealed(wrap, envelope, this)
    }

    private lateinit var node: Process
    private lateinit var out: BufferedWriter
    private lateinit var inp: BufferedReader
    private lateinit var vault: PmVault
    private val json = Json

    private fun call(msg: JsonObject): JsonElement {
        out.write(msg.toString()); out.newLine(); out.flush()
        val line = inp.readLine() ?: throw IllegalStateException("the bridge died: " + node.errorStream.bufferedReader().readText())
        val r = json.parseToJsonElement(line) as JsonObject
        (r["error"] as? JsonObject)?.let { throw PmError((it["message"] as JsonPrimitive).content, (it["code"] as JsonPrimitive).content) }
        return r["result"] ?: JsonNull
    }

    private fun js(fn: String, vararg args: JsonElement) = call(buildJsonObject { put("cmd", "js"); put("fn", fn); put("args", JsonArray(args.toList())) })
    private fun asked() = ((call(buildJsonObject { put("cmd", "asked") }) as JsonObject)["asked"] as JsonPrimitive).content.toInt()
    private fun approve(v: Boolean) { call(buildJsonObject { put("cmd", "approve"); put("value", v) }) }
    private fun JsonElement.s(k: String) = ((this as JsonObject)[k] as JsonPrimitive).content

    @Before fun start() {
        val bridge = generateSequence(File("").absoluteFile) { it.parentFile }.map { File(it, "lib/test/native-bridge.mjs") }.firstOrNull { it.exists() }
            ?: throw IllegalStateException("lib/test/native-bridge.mjs not found above ${File("").absolutePath}")
        node = ProcessBuilder("node", bridge.path).directory(bridge.parentFile.parentFile).start()
        out = node.outputStream.bufferedWriter(); inp = node.inputStream.bufferedReader()
        val keys = Keys()
        call(buildJsonObject { put("cmd", "init"); put("pub", keys.publickey); put("encPub", keys.encPub) })
        vault = PmVault(PmTransport { op, payload -> call(buildJsonObject { put("cmd", "req"); put("op", op); put("payload", payload) }) }, keys)
    }

    @After fun stop() { node.destroy() }

    private val account = buildJsonObject {
        put("id", "e1"); put("title", "Correo"); put("sites", buildJsonArray { add(JsonPrimitive("Empresa.com")) })
        put("username", "ana@empresa.com"); put("secret", "la contraseña larga"); put("notes", "una nota")
        put("fields", buildJsonArray {
            add(buildJsonObject { put("label", "socio"); put("value", "12345"); put("kind", "id-number") })
            add(buildJsonObject { put("label", "cédula"); put("value", "1712345678"); put("private", true) })
        })
    }

    @Test fun whatTheJsDeviceSavedIsFoundAndOpenedHere() = runBlocking<Unit> {
        js("put", account)
        val views = vault.list()
        assertEquals(1, views.size)
        val v = views[0]
        assertEquals("Correo", v.title); assertEquals(listOf("empresa.com"), v.sites); assertEquals("ana@empresa.com", v.hint)
        assertTrue(v.hasSecret && v.hasNotes && v.hasFields && !v.hasTotp)
        assertEquals(listOf("username", "secret", "id-number", "label:cédula"), v.fieldKeys)
        assertTrue("label:cédula" in v.privateKeys && "secret" in v.privateKeys && "id-number" !in v.privateKeys)

        // Searching happens here, over the views: by title, by site and by the visible name.
        assertEquals(1, vault.search("corr").size); assertEquals(1, vault.search("EMPRESA").size); assertEquals(1, vault.search("ana@").size)
        assertEquals(0, vault.search("banco").size)
        assertEquals(listOf("empresa.com" to 1), vault.sites())

        // A public field costs no approval; a private one does.
        val before = asked()
        val pub = vault.get("e1", listOf("username", "id-number"))
        assertEquals("ana@empresa.com", pub.username); assertEquals("", pub.secret)
        assertEquals(listOf(Field("socio", "12345", "id-number")), pub.fields)
        assertEquals(before, asked())
        val priv = vault.get("e1", listOf("secret", "label:cédula"))
        assertEquals("la contraseña larga", priv.secret)
        assertEquals(listOf(Field("cédula", "1712345678", null, private = true)), priv.fields)
        assertEquals(before + 1, asked())
    }

    @Test fun aDeniedApprovalIsSaidWithItsCode() = runBlocking<Unit> {
        js("put", account)
        approve(false)
        try { vault.get("e1", listOf("secret")); fail("the secret came out without an approval") } catch (e: PmError) { assertEquals("not-approved", e.code) }
    }

    @Test fun whatIsSavedHereTheJsDeviceFindsOpensAndCompares() = runBlocking<Unit> {
        val saved = vault.put(Entry(
            id = "n1", title = " Banco ", sites = listOf("Banco.com", "banco.com"), username = "ana", secret = "s3creta", totp = "JBSWY3DPEHPK3PXP",
            notes = "pin 4 cifras", fields = listOf(Field("correo", "ana@x.com", "email"), Field("clave web", "zzz", null, private = true)),
        ))
        assertEquals("Banco", saved.title)
        // The JS device finds it by the SITE (same fingerprint), under a subdomain too.
        val found = js("find", JsonPrimitive("https://login.banco.com/entrar")) as JsonArray
        assertEquals(1, found.size)
        val f = found[0] as JsonObject
        assertEquals("ana", f.s("hint")); assertEquals("Banco", f.s("title"))
        assertEquals(listOf("username", "secret", "totp", "email", "label:clave web"), (f["fieldKeys"] as JsonArray).map { (it as JsonPrimitive).content })
        assertEquals(setOf("secret", "totp", "notes", "label:clave web"), (f["privateKeys"] as JsonArray).map { (it as JsonPrimitive).content }.toSet())
        // …opens every value…
        val open = js("get", JsonPrimitive("n1")) as JsonObject
        assertEquals("ana", open.s("username")); assertEquals("s3creta", open.s("secret")); assertEquals("JBSWY3DPEHPK3PXP", open.s("totp")); assertEquals("pin 4 cifras", open.s("notes"))
        val fields = Field.listOf(open.s("fields"))
        assertEquals(listOf(Field("correo", "ana@x.com", "email"), Field("clave web", "zzz", null, private = true)), fields)
        // …and compares without opening: the digests written here are the ones it computes.
        val hashes = f["fieldHashes"] as JsonObject
        assertEquals((js("digest", JsonPrimitive("n1"), JsonPrimitive("secret"), JsonPrimitive("s3creta")) as JsonPrimitive).content, hashes.s("secret"))
        assertEquals((js("digest", JsonPrimitive("n1"), JsonPrimitive("label:clave web"), JsonPrimitive("zzz")) as JsonPrimitive).content, hashes.s("label:clave web"))
        assertEquals(vault.digest("n1", "username", "ana"), hashes.s("username"))
    }

    @Test fun aPatchChangesOnlyWhatItSays() = runBlocking<Unit> {
        js("put", account)
        val v = vault.patch("e1", Changes(
            secret = "otra", notes = "", title = "Correo del trabajo", sites = listOf("empresa.com", "intranet.empresa.org"),
            fields = listOf(Field("socio", "99999", "id-number")), removeFields = listOf("label:cédula"),
        ))
        assertFalse(v.hasNotes); assertTrue(v.hasSecret)
        assertEquals(listOf("username", "secret", "id-number"), v.fieldKeys)
        val open = js("get", JsonPrimitive("e1")) as JsonObject
        assertEquals("otra", open.s("secret")); assertEquals("ana@empresa.com", open.s("username")); assertEquals("", open.s("notes"))
        assertEquals("Correo del trabajo", open.s("title"))
        assertEquals(listOf(Field("socio", "99999", "id-number")), Field.listOf(open.s("fields")))
        assertEquals(1, (js("find", JsonPrimitive("https://intranet.empresa.org/")) as JsonArray).size)
        // The view here says the same after reading it back from the vault.
        val back = vault.list().single()
        assertEquals(v.copy(digests = back.digests, updatedAt = back.updatedAt), back)
        assertEquals(vault.digest("e1", "secret", "otra"), back.digests["secret"])
    }

    @Test fun whatTheJsDevicePatchesIsReadHere() = runBlocking<Unit> {
        vault.put(Entry(id = "n2", title = "Wifi", secret = "vieja"))
        js("patch", JsonPrimitive("n2"), buildJsonObject { put("secret", "nueva"); put("username", "casa") })
        val e = vault.get("n2")
        assertEquals("nueva", e.secret); assertEquals("casa", e.username); assertEquals("Wifi", e.title)
    }

    @Test fun removingItTakesItFromBoth() = runBlocking<Unit> {
        vault.put(Entry(id = "n3", title = "Borrar", secret = "x"))
        vault.remove("n3")
        assertTrue(vault.list().isEmpty()); assertEquals(0, (js("list") as JsonArray).size)
    }

    // ---------- passkeys: the phone and the extension use the SAME one ----------

    private fun wa(fn: String, vararg args: JsonElement) = call(buildJsonObject { put("cmd", "wa"); put("fn", fn); put("args", JsonArray(args.toList())) })

    private fun verifies(pub: PublicKey, authData: ByteArray, clientDataJson: ByteArray, sig: ByteArray) =
        Signature.getInstance("SHA256withECDSA").run { initVerify(pub); update(authData + Webauthn.sha256(clientDataJson)); verify(sig) }

    @Test fun aPasskeyCreatedOnThePhoneSignsInFromTheExtension() = runBlocking<Unit> {
        val c = Webauthn.create("example.com", "user-1".toByteArray())
        // The fixed bytes are the JS's, to the bit: the COSE key and the authenticatorData.
        val jwk = Json.parseToJsonElement(c.passkey.privateKey) as JsonObject
        assertEquals((wa("coseFromJwk", jwk) as JsonPrimitive).content, Webauthn.b64url(Webauthn.cose(KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(c.publicKeySpki)) as ECPublicKey)))
        assertEquals((wa("makeAuthenticatorData", buildJsonObject { put("rpId", "example.com"); put("flags", 5); put("signCount", 7) }) as JsonPrimitive).content,
            Webauthn.b64url(Webauthn.authenticatorData("example.com", 5, 7)))

        vault.put(Entry(id = "p1", type = "webauthn", title = "Example", sites = listOf("example.com"), username = "ana", webauthn = c.passkey))
        val found = js("findPasskey", buildJsonObject { put("rpId", "example.com") }) as JsonArray
        assertEquals(1, found.size)
        assertEquals(c.passkey.credentialId, ((found[0] as JsonObject)["webauthn"] as JsonObject).s("credentialId"))
        assertEquals(0, (js("findPasskey", buildJsonObject { put("rpId", "otro.com") }) as JsonArray).size)

        val open = js("get", JsonPrimitive("p1")) as JsonObject
        val w = open["webauthn"] as JsonObject
        assertEquals(c.passkey.privateKey, w.s("privateKey")); assertEquals(c.passkey.userHandle, w.s("userHandle")); assertEquals("ana", open.s("username"))

        val r = (wa("signAssertion", buildJsonObject {
            put("entry", w); put("origin", "https://example.com"); put("challenge", "Y2hhbGxlbmdl")
        }) as JsonObject)["response"] as JsonObject
        val resp = r["response"] as JsonObject
        val pub = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(c.publicKeySpki))
        assertTrue(verifies(pub, Webauthn.unb64url(resp.s("authenticatorData")), Webauthn.unb64url(resp.s("clientDataJSON")), Webauthn.unb64url(resp.s("signature"))))
    }

    @Test fun aPasskeyCreatedByTheExtensionSignsInFromThePhone() = runBlocking<Unit> {
        val created = wa("createCredential", buildJsonObject {
            put("rpId", "example.com"); put("userName", "ana"); put("origin", "https://example.com"); put("challenge", "abc")
        }) as JsonObject
        val entry = created["entry"] as JsonObject
        js("put", buildJsonObject {
            put("id", "p2"); put("type", "webauthn"); put("title", "Example"); put("sites", buildJsonArray { add(JsonPrimitive("example.com")) })
            put("username", "ana"); put("webauthn", entry)
        })

        val views = vault.findPasskeys("example.com")
        assertEquals(listOf("p2"), views.map { it.id })
        assertTrue(views[0].hasWebauthn && "webauthn" in views[0].privateKeys)
        assertTrue(vault.findPasskeys("otro.com").isEmpty())

        val before = asked()
        val pk = vault.get("p2", listOf("wa.privateKey", "wa.userHandle")).webauthn!!
        assertEquals(before + 1, asked())   // the private key asks for an approval, as any secret
        assertEquals(entry.s("credentialId"), pk.credentialId); assertEquals("example.com", pk.rpId)

        val cd = Webauthn.clientDataJson("webauthn.get", "Y2g", "https://example.com")
        val a = Webauthn.sign(pk, Webauthn.sha256(cd))
        assertEquals(1, a.signCount)
        val jwk = Json.parseToJsonElement(pk.privateKey) as JsonObject
        val params = AlgorithmParameters.getInstance("EC").apply { init(ECGenParameterSpec("secp256r1")) }.getParameterSpec(ECParameterSpec::class.java)
        val pub = KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(
            ECPoint(BigInteger(1, Webauthn.unb64url(jwk.s("x"))), BigInteger(1, Webauthn.unb64url(jwk.s("y")))), params))
        assertTrue(verifies(pub, a.authData, cd, a.signature))

        // The counter goes up in the vault, and the extension sees it.
        vault.patch("p2", Changes(signCount = a.signCount))
        val after = (js("findPasskey", buildJsonObject { put("rpId", "example.com") }) as JsonArray)[0] as JsonObject
        assertEquals("1", ((after["webauthn"] as JsonObject)["signCount"] as JsonPrimitive).content)
        // …and the key is still there to sign the next time.
        assertEquals(pk.privateKey, vault.get("p2", listOf("wa.privateKey")).webauthn!!.privateKey)
    }
}
