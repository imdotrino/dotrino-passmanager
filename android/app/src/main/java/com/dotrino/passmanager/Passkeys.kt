package com.dotrino.passmanager

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.credentials.provider.AuthenticationAction
import androidx.credentials.provider.BeginGetCredentialOption
import androidx.credentials.provider.BeginGetCredentialResponse
import androidx.credentials.provider.BeginGetPublicKeyCredentialOption
import androidx.credentials.provider.CallingAppInfo
import androidx.credentials.provider.CredentialEntry
import androidx.credentials.provider.PublicKeyCredentialEntry
import com.dotrino.passmanager.core.PmError
import com.dotrino.passmanager.core.PmVault
import com.dotrino.passmanager.core.Webauthn
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL

/**
 * PASSKEYS ON THE PHONE: what the Credential Manager service and its screen share — reading
 * the site's request, deciding WHO is asking, and answering in the JSON the system expects.
 *
 * The passkey itself is the vault's, in the same format as the extension's (`core/Webauthn.kt`):
 * created here, it signs in from the browser extension, and the other way round.
 */
object Passkeys {
    const val TYPE = "androidx.credentials.TYPE_PUBLIC_KEY_CREDENTIAL"
    const val EXTRA_MODE = "dotrino.passkey.mode"
    const val EXTRA_ENTRY = "dotrino.passkey.entry"
    const val MODE_CREATE = "create"
    const val MODE_GET = "get"
    const val MODE_UNLOCK = "unlock"
    /** The only algorithm the extension's passkeys use: ES256. */
    const val ES256 = -7L

    private val json = Json { ignoreUnknownKeys = true }

    private fun JsonObject.str(k: String) = (this[k] as? JsonPrimitive)?.takeIf { it.isString }?.content
    private fun JsonObject.obj(k: String) = this[k] as? JsonObject

    fun parse(requestJson: String): JsonObject =
        json.parseToJsonElement(requestJson) as? JsonObject ?: throw PmError("the site's request is not an object", "bad-request")

    /** The credential ids a request lists (`allowCredentials` / `excludeCredentials`), as base64url. */
    fun credentialIds(req: JsonObject, key: String): List<String> =
        (req[key] as? JsonArray).orEmpty().mapNotNull { (it as? JsonObject)?.str("id") }

    /** The site a sign-in asks for. Without one there is no way to know which passkey, so it stops. */
    fun rpIdOfGet(req: JsonObject): String = req.str("rpId") ?: throw PmError("the site did not say which site it is (rpId)", "bad-request")

    class CreateRequest(val rpId: String, val rpName: String, val userHandle: ByteArray, val userName: String, val challenge: String, val exclude: List<String>)

    fun createRequest(req: JsonObject, origin: Origin): CreateRequest {
        val rp = req.obj("rp") ?: throw PmError("the site's request has no rp", "bad-request")
        val user = req.obj("user") ?: throw PmError("the site's request has no user", "bad-request")
        val algs = (req["pubKeyCredParams"] as? JsonArray).orEmpty().mapNotNull { ((it as? JsonObject)?.get("alg") as? JsonPrimitive)?.content?.toLongOrNull() }
        if (ES256 !in algs) throw PmError("the site does not accept ES256 keys", "not-supported")
        // Without rp.id WebAuthn uses the origin's host — never a guess of ours.
        val rpId = rp.str("id") ?: origin.host ?: throw PmError("the site did not say which site it is (rp.id)", "bad-request")
        return CreateRequest(
            rpId = rpId, rpName = rp.str("name") ?: rpId,
            userHandle = Webauthn.unb64url(user.str("id") ?: throw PmError("the site's request has no user id", "bad-request")),
            userName = user.str("name") ?: user.str("displayName") ?: "",
            challenge = req.str("challenge") ?: throw PmError("the site's request has no challenge", "bad-request"),
            exclude = credentialIds(req, "excludeCredentials"),
        )
    }

    // ---------- who is asking ----------

    /**
     * Who asks: a browser (or Google's QR service) with the web origin it vouches for, or an app,
     * whose origin is the hash of its signing key. [host] is what the rpId is checked against.
     */
    class Origin(val origin: String, val host: String?, val app: String?)

    private var allowlist: String? = null

    /** Google's list of browsers allowed to speak for a web origin (`gpm-passkeys-privileged-apps`), shipped with the app. */
    private fun allowlist(context: Context): String =
        allowlist ?: context.assets.open("privileged_browsers.json").use { it.readBytes().toString(Charsets.UTF_8) }.also { allowlist = it }

    /**
     * THE ORIGIN, CHECKED, before anything touches the vault. A browser is believed only if it
     * is in the privileged list; an app only if the site's `assetlinks.json` names it. Anything
     * else stops: a passkey answered to the wrong caller is a sign-in handed to it.
     */
    fun origin(context: Context, info: CallingAppInfo, rpId: String?): Origin {
        if (info.isOriginPopulated()) {
            val o = try { info.getOrigin(allowlist(context)) } catch (e: Exception) { throw PmError("could not check the browser asking: ${e.message}", "bad-caller") }
                ?: throw PmError("${info.packageName} is not a browser allowed to speak for a website", "bad-caller")
            val host = try { URI(o).host?.lowercase() } catch (_: Exception) { null } ?: throw PmError("the browser gave an origin without a host: $o", "bad-caller")
            if (rpId != null && host != rpId && !host.endsWith(".$rpId")) throw PmError("$o cannot ask for a passkey of $rpId", "bad-caller")
            return Origin(o.trimEnd('/'), host, null)
        }
        val cert = info.signingInfo.apkContentsSigners.firstOrNull()?.toByteArray()
            ?: throw PmError("${info.packageName} has no signing certificate", "bad-caller")
        val digest = Webauthn.sha256(cert)
        if (rpId != null && !assetLinksAllow(rpId, info.packageName, digest)) {
            throw PmError("$rpId does not list ${info.packageName} in its assetlinks.json: that app cannot use its passkeys", "bad-caller")
        }
        return Origin("android:apk-key-hash:" + Webauthn.b64url(digest), null, info.packageName)
    }

    /** Digital Asset Links: does [rpId] say this app may use its sign-ins? Network: call it off the main thread. */
    private fun assetLinksAllow(rpId: String, pkg: String, certSha256: ByteArray): Boolean {
        val fp = certSha256.joinToString(":") { "%02X".format(it) }
        val c = URL("https://$rpId/.well-known/assetlinks.json").openConnection() as HttpURLConnection
        c.instanceFollowRedirects = false; c.connectTimeout = 8000; c.readTimeout = 8000
        try {
            if (c.responseCode != 200) throw PmError("$rpId answered ${c.responseCode} for its assetlinks.json", "bad-caller")
            val arr = json.parseToJsonElement(c.inputStream.use { it.readBytes().toString(Charsets.UTF_8) }) as? JsonArray ?: return false
            return arr.any { s ->
                val o = s as? JsonObject ?: return@any false
                val rel = (o["relation"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.content }
                val t = o.obj("target") ?: return@any false
                "delegate_permission/common.get_login_creds" in rel && t.str("namespace") == "android_app" && t.str("package_name") == pkg &&
                    (t["sha256_cert_fingerprints"] as? JsonArray).orEmpty().any { (it as? JsonPrimitive)?.content?.equals(fp, ignoreCase = true) == true }
            }
        } finally { c.disconnect() }
    }

    // ---------- client data ----------

    /**
     * What gets signed over the client data. A browser (and the QR service) builds the
     * clientDataJSON itself and only hands its hash; an app does not, so it is built here with
     * the app's origin and goes back with the answer.
     */
    class ClientData(val hash: ByteArray, val json: ByteArray?)

    fun clientData(type: String, challenge: String, origin: Origin, given: ByteArray?): ClientData {
        if (given != null) return ClientData(given, null)
        val cd = Webauthn.clientDataJson(type, challenge, origin.origin)
        return ClientData(Webauthn.sha256(cd), cd)
    }

    // A placeholder when the browser has the real one: it replaces it with its own.
    private fun cdField(cd: ClientData) = Webauthn.b64url(cd.json ?: "{}".toByteArray())

    fun registrationJson(c: Webauthn.Created, cd: ClientData): String = buildJsonObject {
        val id = Webauthn.b64url(c.credentialId)
        put("id", id); put("rawId", id); put("type", "public-key"); put("authenticatorAttachment", "platform")
        put("response", buildJsonObject {
            put("clientDataJSON", cdField(cd))
            put("attestationObject", Webauthn.b64url(c.attestationObject))
            put("authenticatorData", Webauthn.b64url(c.authData))
            put("publicKey", Webauthn.b64url(c.publicKeySpki))
            put("publicKeyAlgorithm", ES256)
            put("transports", buildJsonArray { add(JsonPrimitive("internal")); add(JsonPrimitive("hybrid")) })
        })
        put("clientExtensionResults", buildJsonObject { put("credProps", buildJsonObject { put("rk", true) }) })
    }.toString()

    fun assertionJson(credentialId: String, userHandle: String, a: Webauthn.Assertion, cd: ClientData): String = buildJsonObject {
        put("id", credentialId); put("rawId", credentialId); put("type", "public-key"); put("authenticatorAttachment", "platform")
        put("response", buildJsonObject {
            put("clientDataJSON", cdField(cd))
            put("authenticatorData", Webauthn.b64url(a.authData))
            put("signature", Webauthn.b64url(a.signature))
            if (userHandle.isNotEmpty()) put("userHandle", userHandle)
        })
        put("clientExtensionResults", buildJsonObject {})
    }.toString()

    // ---------- the entries the system lists ----------

    fun intent(context: Context, mode: String, entryId: String? = null): PendingIntent {
        val i = Intent(context, PasskeyActivity::class.java).putExtra(EXTRA_MODE, mode).also { if (entryId != null) it.putExtra(EXTRA_ENTRY, entryId) }
        // MUTABLE: the system writes the site's request into it. One request code per target, or
        // every entry would open the last one.
        return PendingIntent.getActivity(context, (mode + (entryId ?: "")).hashCode(), i, PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    /** The passkeys of the vault for each option asked: only views, the key stays in the vault until one is chosen. */
    suspend fun entries(context: Context, vault: PmVault, options: List<BeginGetCredentialOption>): List<CredentialEntry> {
        val out = ArrayList<CredentialEntry>()
        for (o in options.filterIsInstance<BeginGetPublicKeyCredentialOption>()) {
            val req = parse(o.requestJson)
            val allow = credentialIds(req, "allowCredentials")
            for (v in vault.findPasskeys(rpIdOfGet(req))) {
                val cred = ((v.webauthn as? JsonObject)?.get("credentialId") as? JsonPrimitive)?.content ?: continue
                if (allow.isNotEmpty() && cred !in allow) continue
                out.add(PublicKeyCredentialEntry.Builder(context, v.hint.ifEmpty { v.title }, intent(context, MODE_GET, v.id), o)
                    .setDisplayName(v.title).build())
            }
        }
        return out
    }

    /** When the vault cannot answer in time: a «open Contraseñas» row that finds them with the screen open. */
    fun unlockResponse(context: Context) = BeginGetCredentialResponse(
        authenticationActions = listOf(AuthenticationAction(t("passkey.unlock"), intent(context, MODE_UNLOCK))))
}
