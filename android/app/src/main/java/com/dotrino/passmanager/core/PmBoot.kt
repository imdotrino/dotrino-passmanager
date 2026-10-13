package com.dotrino.passmanager.core

import com.dotrino.sdk.Profile
import com.dotrino.sdk.ProxyConnection
import com.dotrino.sdk.SealedSession
import kotlinx.serialization.json.JsonObject

/**
 * From a profile to its password vault: the record brought up to date, the two things read
 * from it (the permission and the vault's encryption key), and the sealed session.
 *
 * Why it could not: `no-vault` (the profile is not paired), `no-permission` (the record does
 * not give this device `passwords`), `no-vault-key` (the vault published no encryption key).
 */
object PmBoot {
    class Opened(val profile: Profile, val session: SealedSession, val transport: PmSession, val vault: PmVault)

    suspend fun open(
        profile: Profile,
        /** Federated proxies to fall back to, after the one the vault link names. */
        proxies: List<String>,
        /** Puts the profile's record up to date from its vault over a connection identified as the profile. */
        catchUp: suspend (Profile, ProxyConnection) -> Profile,
        warn: (String, Throwable?) -> Unit,
    ): Opened {
        var p = profile
        var stale: Exception? = null
        val link = p.vault ?: throw PmError("this profile is not paired with a vault", "no-vault")

        // THE RECORD, UP TO DATE: the permission and the vault's key are read from it, and the
        // one the phone holds only moves when somebody asks. If the vault cannot be reached
        // now, the record held is still the one this device adopted: it decides.
        try {
            val conn = ProxyConnection(link.proxy)
            try {
                conn.connect()
                conn.identifyAs(p.publickey) { p.signData(it) }
                p = catchUp(p, conn)
            } finally { conn.close() }
        } catch (e: Exception) { stale = e; warn("could not bring the record up to date", e) }

        // With a record that could not be refreshed, «no permission» may only mean «not seen
        // yet»: the reason it could not be refreshed goes along, so it is not mistaken for a refusal.
        val why = stale?.let { " (the record could not be brought up to date: ${it.message ?: it})" } ?: ""
        if (!p.can("passwords")) throw PmError("the record does not give this device the passwords permission$why", "no-permission")
        val vaultEncPub = p.vaultEncPub ?: throw PmError("the vault has not published its encryption key$why", "no-vault-key")

        val s = SealedSession((listOf(link.proxy) + proxies).distinct(), p, "passmanager")
        s.onWarn = { w, e -> warn(w, e) }
        s.start()
        val t = PmSession(s, link.master, vaultEncPub)
        val me = p
        val v = PmVault(t, object : PmIdentity {
            override val publickey = me.publickey
            override suspend fun sign(body: JsonObject) = me.signData(body)
            override suspend fun openSealed(wrap: JsonObject, envelope: JsonObject) = me.openSealed(wrap, envelope)
        })
        return Opened(p, s, t, v)
    }
}
