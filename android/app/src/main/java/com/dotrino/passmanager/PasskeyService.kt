package com.dotrino.passmanager

import android.os.CancellationSignal
import android.os.OutcomeReceiver
import androidx.credentials.exceptions.ClearCredentialException
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.CreateCredentialUnknownException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.provider.BeginCreateCredentialRequest
import androidx.credentials.provider.BeginCreateCredentialResponse
import androidx.credentials.provider.BeginCreatePublicKeyCredentialRequest
import androidx.credentials.provider.BeginGetCredentialRequest
import androidx.credentials.provider.BeginGetCredentialResponse
import androidx.credentials.provider.CreateEntry
import androidx.credentials.provider.CredentialProviderService
import androidx.credentials.provider.ProviderClearCredentialStateRequest
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * CONTRASEÑAS AS THE PHONE'S PASSKEY PROVIDER (Android 14+, Credential Manager). The person
 * turns it on in Settings → Passwords & accounts; from then on, when a site or an app asks to
 * create a passkey — or a computer shows the «use a phone» QR and the camera reads it — the
 * system lists Contraseñas next to Google.
 *
 * This service only LISTS, and it has to be quick: creating and signing happen in
 * [PasskeyActivity], with a screen in front, once the person chose Contraseñas.
 */
class PasskeyService : CredentialProviderService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onDestroy() { scope.cancel(); super.onDestroy() }

    override fun onBeginCreateCredentialRequest(
        request: BeginCreateCredentialRequest,
        cancellationSignal: CancellationSignal,
        callback: OutcomeReceiver<BeginCreateCredentialResponse, CreateCredentialException>,
    ) {
        if (request !is BeginCreatePublicKeyCredentialRequest) {
            // Passwords are saved from the app itself; only passkeys come through here.
            callback.onError(CreateCredentialUnknownException("Contraseñas only saves passkeys here"))
            return
        }
        I18n.load(this)
        callback.onResult(BeginCreateCredentialResponse(createEntries = listOf(
            CreateEntry.Builder(t("passkey.account"), Passkeys.intent(this, Passkeys.MODE_CREATE))
                .setDescription(t("passkey.createHint")).build())))
    }

    override fun onBeginGetCredentialRequest(
        request: BeginGetCredentialRequest,
        cancellationSignal: CancellationSignal,
        callback: OutcomeReceiver<BeginGetCredentialResponse, GetCredentialException>,
    ) {
        I18n.load(this)
        // THE SYSTEM WAITS 3 SECONDS, AND IN THE BACKGROUND THE APP HAS NO NETWORK (Android blocks it
        // for a process that is not in front: «DNS … isBlocked=true»). So the vault is only asked
        // when it is ALREADY open and online in this process, and briefly; otherwise the answer is
        // at once a «open Contraseñas» row, which brings the app to the front — with network —
        // and lists the passkeys there. Waiting longer here only meant offering nothing at all
        // (seen 2026-10-16: the system timed out and went straight to Google).
        val vault = Passmanager.vault
        val online = Passmanager.session?.isOnline == true
        if (vault == null || !online) { callback.onResult(Passkeys.unlockResponse(this)); return }
        scope.launch {
            val r = try {
                withTimeoutOrNull(BEGIN_MS) { Passkeys.entries(this@PasskeyService, vault, request.beginGetCredentialOptions) }
            } catch (e: Exception) {
                android.util.Log.w("passmanager", "passkeys: could not list them now", e); null
            }
            callback.onResult(if (r != null) BeginGetCredentialResponse(credentialEntries = r) else Passkeys.unlockResponse(this@PasskeyService))
        }
    }

    override fun onClearCredentialStateRequest(
        request: ProviderClearCredentialStateRequest,
        cancellationSignal: CancellationSignal,
        callback: OutcomeReceiver<Void?, ClearCredentialException>,
    ) {
        // Nothing to clear: no session of the site is kept here.
        callback.onResult(null)
    }

    private companion object { const val BEGIN_MS = 1_500L }
}
