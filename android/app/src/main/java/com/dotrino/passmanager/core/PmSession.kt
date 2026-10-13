package com.dotrino.passmanager.core

import com.dotrino.sdk.SealedSession
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * The transport of the side that ASKS — `lib/src/transport/proxy.js`. Requests go SEALED
 * to the vault by its key (so the proxy's offline queue applies), and no answer is taken
 * unless it was sealed by the vault's own encryption key: anybody can answer in the clear,
 * and although they could not read what was asked, they could slip a forged credential in.
 */
class PmSession(
    private val session: SealedSession,
    private val vaultPubkey: String,
    private val vaultEncPub: String,
    /** Generous on purpose: at the other end somebody may be approving on another device. */
    private val timeoutMs: Long = 90_000,
) : PmTransport {
    companion object {
        const val TYPE = "dotrino.passmanager/1"
        const val REPLY = "dotrino.passmanager.reply/1"
    }

    private val pending = ConcurrentHashMap<String, CompletableDeferred<JsonObject>>()
    private val stop = session.onMessage { m ->
        val p = m.payload
        if ((p["type"] as? JsonPrimitive)?.content != REPLY) return@onMessage
        val rid = (p["rid"] as? JsonPrimitive)?.content ?: return@onMessage
        val waiting = pending[rid] ?: return@onMessage   // an answer to something that already expired
        if (m.senderEncPub != vaultEncPub) {
            waiting.completeExceptionally(PmError("that answer was not sealed by your vault", "unsealed"))
            return@onMessage
        }
        waiting.complete(p)
    }

    override suspend fun request(op: String, payload: JsonObject): JsonElement {
        val rid = UUID.randomUUID().toString()
        val waiting = CompletableDeferred<JsonObject>()
        pending[rid] = waiting
        try {
            if (!session.awaitOnline()) throw PmError("no connection to reach your vault", "unreachable")
            try {
                session.sendSealed(vaultPubkey, buildJsonObject {
                    put("type", TYPE); put("rid", rid); put("op", op); put("payload", payload)
                }, listOf(vaultEncPub))
            } catch (e: SealedSession.SessionError) {
                // The code is KEPT: «I lack the other side's key» and «the network dropped» are fixed differently.
                throw PmError(e.message ?: e.code, e.code)
            }
            // Not «nobody is there»: nobody ANSWERED. Usually an approval nobody looked at.
            val r = withTimeoutOrNull(timeoutMs) { waiting.await() } ?: throw PmError("nobody answered in time", "approval-timeout")
            (r["error"] as? JsonObject)?.let { e ->
                throw PmError((e["message"] as? JsonPrimitive)?.content ?: "error", (e["code"] as? JsonPrimitive)?.content ?: "unknown")
            }
            return r["result"] ?: JsonNull
        } finally { pending.remove(rid) }
    }

    fun close() {
        stop()
        pending.values.forEach { it.completeExceptionally(PmError("transport closed", "unreachable")) }
        pending.clear()
    }
}
