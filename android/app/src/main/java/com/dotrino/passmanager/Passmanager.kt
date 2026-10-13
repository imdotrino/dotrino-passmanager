package com.dotrino.passmanager

import android.content.Context
import com.dotrino.passmanager.core.PmBoot
import com.dotrino.passmanager.core.PmError
import com.dotrino.passmanager.core.PmSession
import com.dotrino.passmanager.core.PmVault
import com.dotrino.sdk.PhoneIdentity
import com.dotrino.sdk.Profile
import com.dotrino.sdk.ProxyConnection
import com.dotrino.sdk.SealedSession
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * The password manager of this process: ONE per app, not per screen. It is the phone's
 * profile (the identity app) talking `pm2.*` to the vault that profile is paired with — a
 * device of the record with the `passwords` permission, like the browser extension.
 *
 * Nothing is kept here: every value is asked from the vault when it is needed and lives in
 * memory while its screen is open.
 */
object Passmanager {
    /** Federated proxies, after the one the vault link names. */
    private val PROXIES = listOf("wss://proxy.dotrino.com", "wss://proxy2.dotrino.com")

    @Volatile var vault: PmVault? = null; private set
    @Volatile var session: SealedSession? = null; private set
    @Volatile var profile: Profile? = null; private set
    private var identity: PhoneIdentity? = null
    private var transport: PmSession? = null

    /**
     * Why it could not start: `no-identity-app`, `no-profile`, `no-profile-keys`, `no-vault`
     * (the profile is not paired with a vault), `no-permission` (the record does not give this
     * phone `passwords`), `no-vault-key` (the vault published no encryption key), or a message.
     */
    class BootError(message: String, val code: String) : Exception(message)

    private val bootLock = Mutex()

    suspend fun boot(context: Context): PmVault = bootLock.withLock { bootOnce(context) }

    /**
     * Where the profile comes from. The phone's identity, always — a DEBUG build may put a
     * software profile here to run against a test vault (`src/debug`), and nothing else does.
     */
    interface Source {
        suspend fun profile(): Profile
        suspend fun catchUp(profile: Profile, conn: ProxyConnection): Profile
    }
    @Volatile var source: Source? = null

    private suspend fun bootOnce(context: Context): PmVault {
        vault?.let { return it }
        val src = source ?: (identity ?: PhoneIdentity(context.applicationContext).also { identity = it }).let { id ->
            object : Source {
                override suspend fun profile() = id.profile()
                override suspend fun catchUp(profile: Profile, conn: ProxyConnection) = id.catchUp(profile, conn)
            }
        }
        val p = try { src.profile() } catch (e: Profile.ProfileError) { throw BootError(e.message ?: e.code, e.code) }
        profile = p
        val o = try {
            PmBoot.open(p, PROXIES, src::catchUp) { w, e -> android.util.Log.w("passmanager", w, e) }
        } catch (e: PmError) { throw BootError(e.message ?: e.code, e.code) }
        profile = o.profile; session = o.session; transport = o.transport; vault = o.vault
        return o.vault
    }

    /** Starts over: after pairing, or after the permission was given. */
    fun reset() {
        transport?.close(); session?.close()
        transport = null; session = null; vault = null
    }
}
