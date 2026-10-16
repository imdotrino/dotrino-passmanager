package com.dotrino.passmanager

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.LinearLayout
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.GetCredentialResponse
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.CreateCredentialCancellationException
import androidx.credentials.exceptions.CreateCredentialUnknownException
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialUnknownException
import androidx.credentials.exceptions.domerrors.InvalidStateError
import androidx.credentials.exceptions.publickeycredential.CreatePublicKeyCredentialDomException
import androidx.credentials.provider.BeginGetCredentialResponse
import androidx.credentials.provider.PendingIntentHandler
import com.dotrino.passmanager.core.Entry
import com.dotrino.passmanager.core.PmError
import com.dotrino.passmanager.core.PmVault
import com.dotrino.passmanager.core.Webauthn
import com.dotrino.sdk.ui.DotrinoLocale
import com.dotrino.sdk.ui.IdentityRequired
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.util.UUID

/**
 * THE PASSKEY, WITH A SCREEN IN FRONT. The system opens this once the person chose Contraseñas
 * in its sheet: to create a passkey and save it in the vault, to sign in with one, or to find
 * them when the service could not in time.
 *
 * Every failure is SAID here and then handed to the system as an error, never swallowed:
 * the site falls back to its other ways in, and the person knows why this one did not work.
 */
class PasskeyActivity : Activity() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private lateinit var status: android.widget.TextView
    private lateinit var box: LinearLayout

    override fun attachBaseContext(base: Context) = super.attachBaseContext(DotrinoLocale.wrap(base))

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        I18n.load(this)
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        status = label(t("list.loading"), 16f, col(R.color.m_muted)).apply { gravity = Gravity.CENTER; tag = "passkey-status" }
        box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER
            setBackgroundColor(col(R.color.m_bg)); fitsSystemWindows = true
            setPadding(px(32), px(32), px(32), px(32))
            add(label(t("passkey.account"), 20f, bold = true).apply { gravity = Gravity.CENTER })
            add(status, top = 16)
        }
        setContentView(box, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

        when (intent.getStringExtra(Passkeys.EXTRA_MODE)) {
            Passkeys.MODE_CREATE -> run(::create, ::failCreate)
            Passkeys.MODE_GET -> run(::get, ::failGet)
            Passkeys.MODE_UNLOCK -> run(::unlock, ::failGet)
            else -> { setResult(RESULT_CANCELED); finish() }
        }
    }

    override fun onDestroy() { scope.cancel(); super.onDestroy() }

    private fun say(msg: String) { status.text = msg }

    private fun run(work: suspend () -> Intent, fail: (Intent, Exception) -> Unit) {
        scope.launch {
            try {
                val out = work()
                setResult(RESULT_OK, out); finish()
            } catch (e: Exception) {
                android.util.Log.w("passmanager", "passkey: ${e.message}", e)
                val out = Intent()
                fail(out, e)
                say(explain(e))
                // The person reads why, then closes: the error goes to the system on closing.
                box.add(pill(t("close"), filled = true) { setResult(RESULT_OK, out); finish() }.apply { tag = "passkey-close" },
                    top = 24, width = ViewGroup.LayoutParams.WRAP_CONTENT)
            }
        }
    }

    private fun explain(e: Exception): String = when ((e as? PmError)?.code ?: (e as? Passmanager.BootError)?.code) {
        "no-identity-app" -> t("boot.noIdentityApp")
        "no-profile", "no-profile-keys" -> t("boot.noProfile")
        "no-vault" -> t("boot.noVault")
        "no-permission" -> t("boot.noPermission", "id" to (Passmanager.profile?.vault?.deviceId ?: ""))
        "no-vault-key" -> t("boot.noVaultKey")
        "no-passkeys-device" -> t("passkey.noPasskeysDevice")
        "no-passkey-permission" -> t("passkey.noPermission", "id" to (Passmanager.profile?.vault?.deviceId ?: ""))
        "not-approved", "approval-timeout" -> t("passkey.notApproved")
        "bad-caller" -> t("passkey.badCaller", "why" to (e.message ?: ""))
        "exists" -> t("passkey.exists")
        else -> t("passkey.failed", "why" to (e.message ?: e.toString()))
    }

    private suspend fun vault(): PmVault {
        if (Passmanager.source == null && !IdentityRequired.check(this)) throw PmError("the identity app is missing", "no-identity-app")
        return withContext(Dispatchers.IO) { Passmanager.boot(this@PasskeyActivity) }
    }

    // ---------- create ----------

    private suspend fun create(): Intent {
        val req = PendingIntentHandler.retrieveProviderCreateCredentialRequest(intent) ?: throw PmError("the system sent no request", "bad-request")
        val pk = req.callingRequest as? CreatePublicKeyCredentialRequest ?: throw PmError("that is not a passkey request", "bad-request")
        val json = Passkeys.parse(pk.requestJson)
        val rpHint = (json["rp"] as? JsonObject)?.get("id")?.let { (it as? JsonPrimitive)?.content }
        val origin = withContext(Dispatchers.IO) { Passkeys.origin(this@PasskeyActivity, req.callingAppInfo, rpHint) }
        val r = Passkeys.createRequest(json, origin)
        say(t("passkey.saving", "site" to r.rpId))
        val v = vault()

        // `excludeCredentials`: the site already has one of ours for this account. Making a second
        // would leave the person with two and the site knowing one.
        if (r.exclude.isNotEmpty()) {
            val mine = withContext(Dispatchers.IO) { v.findPasskeys(r.rpId) }
                .mapNotNull { ((it.webauthn as? JsonObject)?.get("credentialId") as? JsonPrimitive)?.content }
            if (mine.any { it in r.exclude }) throw PmError("there is already a passkey of this vault for that account", "exists")
        }

        val c = Webauthn.create(r.rpId, r.userHandle)
        // SAVED BEFORE ANSWERING: if the site registered it and the vault did not have it, the
        // person would be locked out of their account without knowing why.
        withContext(Dispatchers.IO) {
            v.put(Entry(id = UUID.randomUUID().toString(), type = "webauthn", title = r.rpName, sites = listOf(r.rpId),
                username = r.userName, webauthn = c.passkey))
        }
        val cd = Passkeys.clientData("webauthn.create", r.challenge, origin, pk.clientDataHash)
        return Intent().also { PendingIntentHandler.setCreateCredentialResponse(it, CreatePublicKeyCredentialResponse(Passkeys.registrationJson(c, cd))) }
    }

    private fun failCreate(out: Intent, e: Exception) {
        val ex = when ((e as? PmError)?.code) {
            "exists" -> CreatePublicKeyCredentialDomException(InvalidStateError(), e.message)
            "not-approved" -> CreateCredentialCancellationException(e.message)
            else -> CreateCredentialUnknownException(e.message)
        }
        PendingIntentHandler.setCreateCredentialException(out, ex)
    }

    // ---------- sign in ----------

    private suspend fun get(): Intent {
        val id = intent.getStringExtra(Passkeys.EXTRA_ENTRY) ?: throw PmError("no passkey was chosen", "bad-request")
        val req = PendingIntentHandler.retrieveProviderGetCredentialRequest(intent) ?: throw PmError("the system sent no request", "bad-request")
        val v = vault()
        say(t("passkey.opening"))
        // The private key is private: the vault may ask for an approval on another device first.
        val entry = withContext(Dispatchers.IO) { v.get(id, listOf("wa.privateKey", "wa.userHandle")) }
        val pk = entry.webauthn ?: throw PmError("that entry has no passkey", "bad-entry")
        if (pk.privateKey.isEmpty()) throw PmError("this phone cannot open passkeys", "no-passkey-permission")

        val option = req.credentialOptions.filterIsInstance<GetPublicKeyCredentialOption>()
            .firstOrNull { Passkeys.rpIdOfGet(Passkeys.parse(it.requestJson)) == pk.rpId }
            ?: throw PmError("the site did not ask for ${pk.rpId}", "bad-request")
        val json = Passkeys.parse(option.requestJson)
        val allow = Passkeys.credentialIds(json, "allowCredentials")
        if (allow.isNotEmpty() && pk.credentialId !in allow) throw PmError("the site does not accept that passkey", "bad-request")
        val origin = withContext(Dispatchers.IO) { Passkeys.origin(this@PasskeyActivity, req.callingAppInfo, pk.rpId) }
        val challenge = (json["challenge"] as? JsonPrimitive)?.content ?: throw PmError("the site's request has no challenge", "bad-request")

        val cd = Passkeys.clientData("webauthn.get", challenge, origin, option.clientDataHash)
        val a = Webauthn.sign(pk, cd.hash)
        // The counter goes up in the vault before answering, as the extension does.
        withContext(Dispatchers.IO) { v.patch(id, com.dotrino.passmanager.core.Changes(signCount = a.signCount)) }
        return Intent().also {
            PendingIntentHandler.setGetCredentialResponse(it, GetCredentialResponse(PublicKeyCredential(Passkeys.assertionJson(pk.credentialId, pk.userHandle, a, cd))))
        }
    }

    private fun failGet(out: Intent, e: Exception) {
        val ex = if ((e as? PmError)?.code == "not-approved") GetCredentialCancellationException(e.message) else GetCredentialUnknownException(e.message)
        PendingIntentHandler.setGetCredentialException(out, ex)
    }

    /** The service could not list them in time: find them now, with the screen open, and hand the list back. */
    private suspend fun unlock(): Intent {
        val req = PendingIntentHandler.retrieveBeginGetCredentialRequest(intent) ?: throw PmError("the system sent no request", "bad-request")
        val v = vault()
        val entries = withContext(Dispatchers.IO) { Passkeys.entries(this@PasskeyActivity, v, req.beginGetCredentialOptions) }
        // NOTHING THAT SERVES IS SAID, not closed in silence. Usually the site only accepts other
        // keys (it lists them in `allowCredentials`): one deleted on the site still lives here.
        if (entries.isEmpty()) {
            val sites = req.beginGetCredentialOptions.filterIsInstance<androidx.credentials.provider.BeginGetPublicKeyCredentialOption>()
                .mapNotNull { runCatching { Passkeys.rpIdOfGet(Passkeys.parse(it.requestJson)) }.getOrNull() }.distinct()
            say(t("passkey.noneForSite", "site" to sites.joinToString(", ")))
            val closed = kotlinx.coroutines.CompletableDeferred<Unit>()
            box.add(pill(t("close"), filled = true) { closed.complete(Unit) }.apply { tag = "passkey-close" },
                top = 24, width = ViewGroup.LayoutParams.WRAP_CONTENT)
            closed.await()
        }
        return Intent().also { PendingIntentHandler.setBeginGetCredentialResponse(it, BeginGetCredentialResponse(credentialEntries = entries)) }
    }
}
