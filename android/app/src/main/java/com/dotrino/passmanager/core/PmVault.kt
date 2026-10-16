package com.dotrino.passmanager.core

import com.dotrino.sdk.Crypto
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/** Where the requests go: `{ request(op, payload) }`, the same contract as the JS transport. */
fun interface PmTransport { suspend fun request(op: String, payload: JsonObject): JsonElement }

/** What this device does with its own keys. The private halves never come out: only the work is asked. */
interface PmIdentity {
    val publickey: String
    /** P1363 base64 signature over the canonical text of [body]. */
    suspend fun sign(body: JsonObject): String
    /** A value sealed to this device: its wrap of the content key, then the envelope. */
    suspend fun openSealed(wrap: JsonObject, envelope: JsonObject): String
}

/** What changes in an entry. `null` = untouched; an empty string = that field goes away. */
data class Changes(
    val title: String? = null,
    val name: String? = null,
    val username: String? = null,
    val secret: String? = null,
    val totp: String? = null,
    val notes: String? = null,
    /** Free fields written again, WITH their value (the private mark lives inside the envelope). */
    val fields: List<Field> = emptyList(),
    /** Free fields that go, by their key ([Field.key]). */
    val removeFields: List<String> = emptyList(),
    /** The whole list of sites, when it changes. */
    val sites: List<String>? = null,
    /**
     * The entry's visible name after the change ([Entry.who] of the edited entry). Whoever
     * edits has the name and the username in front — both public — and the view alone does
     * not say which of the two the current one came from.
     */
    val hint: String? = null,
    /** The passkey's new counter, after signing with it: it lives in the view (`webauthn.signCount`). */
    val signCount: Long? = null,
) {
    internal fun fixed(k: String): String? = when (k) {
        "name" -> name; "username" -> username; "secret" -> secret; "totp" -> totp; "notes" -> notes; else -> null
    }
}

/**
 * THE SEALED VAULT, SEEN FROM THIS DEVICE — the port of `lib/src/vault/sealed.js` and
 * `lib/src/sealed/{entry,device}.js` (`docs/sealed-passwords.md`).
 *
 * At the other end there is a vault that keeps envelopes and has no key to open any. So
 * everything is done here: open each envelope with this device's wrap; to write, encrypt,
 * wrap to exactly the recipients the record names and sign; and to search by text, ask for
 * the views (names, never values) and search them here.
 */
class PmVault(
    private val transport: PmTransport,
    private val identity: PmIdentity,
    private val now: () -> Long = System::currentTimeMillis,
) {
    companion object {
        const val RECOVERY = "#recovery"
        /** The passkey's private key: the one field wrapped to OTHER recipients (`sealed-passwords.md` §2.8). */
        const val PASSKEY_FIELD = "wa.privateKey"
        val OPS = listOf("pm2.recipients", "pm2.profile", "pm2.views", "pm2.find", "pm2.passkey", "pm2.get", "pm2.put", "pm2.patch", "pm2.remove")
        private val json = Json { ignoreUnknownKeys = true }
        private fun isFixed(k: String) = k in Entry.FIXED || k.startsWith("wa.")
        private fun JsonObject.str(k: String) = (this[k] as? JsonPrimitive)?.takeIf { it.isString }?.content
        private fun JsonObject.obj(k: String) = this[k] as? JsonObject
        private fun strings(e: JsonElement?) = (e as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }
        private fun arr(l: List<String>) = JsonArray(l.map(::JsonPrimitive))
        private fun ref(env: JsonObject) = env.str("iv") + "." + env.str("ct")
    }

    private var keys: ProfileKeys? = null
    private var recipients: JsonObject? = null

    /** Drops what was cached: after changing account, or when the record may have moved. */
    fun forget() { keys = null; recipients = null }

    private suspend fun request(op: String, payload: JsonObject = JsonObject(emptyMap())): JsonElement {
        if (op !in OPS) throw PmError("unknown operation: $op", "not-allowed")
        return transport.request(op, payload)
    }

    /** The profile keys. Without them there is no searching (the index goes by fingerprint) nor comparing. */
    suspend fun keys(): ProfileKeys {
        keys?.let { return it }
        val r = request("pm2.profile") as? JsonObject ?: throw PmError("the vault answered no profile key", "unknown")
        val base = identity.openSealed(r.obj("wrap") ?: throw PmError("this device has no key for the profile password key", "not-yours"),
            r.obj("envelope") ?: throw PmError("the vault answered no profile key", "unknown"))
        return PmKeys.profileKeys(base).also { keys = it }
    }

    /** Who each key has to be wrapped to. The list comes out of the record and the vault knows it. */
    suspend fun recipients(): JsonObject {
        recipients?.let { return it }
        return (request("pm2.recipients") as? JsonObject ?: throw PmError("the vault answered no recipients", "unknown")).also { recipients = it }
    }

    private suspend fun sealedKey(k: String) = if (isFixed(k)) k else "f:" + PmKeys.fieldIndex(keys().kidx, k)

    private suspend fun openView(v: JsonObject): View {
        val env = v.obj("view") ?: throw PmError("an entry came without its view", "bad-entry")
        val wrap = v.obj("wrap") ?: throw PmError("this device has no key for that content generation", "no-wrap")
        val id = v.str("id") ?: throw PmError("an entry came without its id", "bad-entry")
        return viewOf(id, (v["updatedAt"] as? JsonPrimitive)?.longOrNull ?: 0, v.obj("digests"), identity.openSealed(wrap, env))
    }

    private fun viewOf(id: String, updatedAt: Long, digests: JsonObject?, text: String): View {
        val o = json.parseToJsonElement(text) as? JsonObject ?: throw PmError("the view of an entry is not an object", "bad-entry")
        val has = o.obj("has")
        fun flag(k: String) = (has?.get(k) as? JsonPrimitive)?.content == "true"
        return View(
            id = id, type = o.str("type") ?: "login", title = o.str("title") ?: "", sites = strings(o["sites"]),
            hint = o.str("hint") ?: "", fieldKeys = strings(o["fieldKeys"]), privateKeys = strings(o["privateKeys"]),
            hasSecret = flag("secret"), hasTotp = flag("totp"), hasNotes = flag("notes"), hasFields = flag("fields"), hasWebauthn = flag("webauthn"),
            webauthn = o["webauthn"]?.takeIf { it !is JsonNull }, updatedAt = updatedAt,
            digests = digests.orEmpty().mapNotNull { (k, d) -> (d as? JsonPrimitive)?.content?.let { k to it } }.toMap(),
        )
    }

    /**
     * THE WHOLE VAULT, OPENED HERE: the VIEWS, which carry no value, opened with this
     * device's key. It is what replaces searching inside the vault, which sees no text.
     */
    suspend fun list(): List<View> = (request("pm2.views") as? JsonArray).orEmpty().mapNotNull { (it as? JsonObject)?.let { v -> openView(v) } }

    /** Search by text, here, over the views: title, visible name and sites. No value leaves the vault for this. */
    suspend fun search(q: String, limit: Int = 50): List<View> {
        val term = q.trim().lowercase()
        if (term.isEmpty()) return emptyList()
        return list().filter { it.matches(term) }.take(limit)
    }

    /** In which sites there is something, and how many in each. */
    suspend fun sites(): List<Pair<String, Int>> =
        list().flatMap { it.sites }.groupingBy { it }.eachCount().toList().sortedBy { it.first }

    /** The passkeys this device can see for [rpId]: views, never a key. Matched in the vault by fingerprint. */
    suspend fun findPasskeys(rpId: String): List<View> {
        val rp = PmKeys.passkeyIndex(keys().kidx, "rp", rpId)
        return (request("pm2.passkey", buildJsonObject { put("rp", rp) }) as? JsonArray).orEmpty()
            .mapNotNull { (it as? JsonObject)?.let { v -> openView(v) } }
            // The fingerprint is a pre-filter; the site in the opened view decides.
            .filter { (it.webauthn as? JsonObject)?.str("rpId") == rpId }
    }

    /**
     * ONE entry, and only the fields asked for (`keys` = the interface's names: `username`,
     * `secret`, a free field's key). With a private one among them the vault asks for an
     * approval first, and this call waits for it.
     */
    suspend fun get(id: String, keys: List<String>? = null): Entry {
        val payload = buildJsonObject {
            put("id", id)
            if (keys != null) put("keys", arr(keys.map { sealedKey(it) }))
        }
        val got = request("pm2.get", payload) as? JsonObject ?: throw PmError("the vault answered no entry", "unknown")
        val wraps = got.obj("wraps") ?: JsonObject(emptyMap())
        suspend fun open(env: JsonObject): String {
            val gen = (env["gen"] as? JsonPrimitive)?.content
            val wrap = wraps[gen] as? JsonObject ?: throw PmError("this device has no key for that content generation", "no-wrap")
            return identity.openSealed(wrap, env)
        }
        val updatedAt = (got["updatedAt"] as? JsonPrimitive)?.longOrNull ?: 0
        val view = viewOf(id, updatedAt, got.obj("digests"), open(got.obj("view") ?: throw PmError("the entry came without its view", "bad-entry")))
        val fixed = HashMap<String, String>()
        val free = ArrayList<Field>()
        for ((k, env) in got.obj("envelopes").orEmpty()) {
            val value = open(env as? JsonObject ?: continue)
            when {
                k in Entry.FIXED -> fixed[k] = value
                k == "wa.userHandle" || k == PASSKEY_FIELD -> fixed[k] = value
                // The field comes whole: its label, its kind, its value and its mark.
                k.startsWith("f:") -> (try { json.parseToJsonElement(value) as? JsonObject } catch (_: Exception) { null })?.let(Field::of)?.let(free::add)
            }
        }
        return Entry(
            id = id, type = view.type, title = view.title, sites = view.sites,
            name = fixed["name"] ?: "", username = fixed["username"] ?: "", secret = fixed["secret"] ?: "",
            totp = fixed["totp"] ?: "", notes = fixed["notes"] ?: "", fields = free,
            updatedAt = updatedAt, withheld = strings(got["withheld"]),
            webauthn = (view.webauthn as? JsonObject)?.let { w ->
                Passkey(
                    credentialId = w.str("credentialId") ?: throw PmError("the passkey came without its credential id", "bad-entry"),
                    rpId = w.str("rpId") ?: throw PmError("the passkey came without its site", "bad-entry"),
                    userHandle = fixed["wa.userHandle"] ?: "", privateKey = fixed[PASSKEY_FIELD] ?: "",
                    signCount = (w["signCount"] as? JsonPrimitive)?.longOrNull ?: 0,
                )
            },
        )
    }

    // `recoveryPub: null` is «the account has no recovery copy yet»: sealed only to the
    // devices. A MISSING key means nobody asked the vault, and that is an error.
    private suspend fun wrapAll(cek: String, kind: String = "main"): JsonObject {
        val r = recipients()
        if (!r.containsKey("recoveryPub")) throw PmError("ask the vault for the recipients first", "no-recipients")
        val members = (r[kind] as? JsonArray).orEmpty()
        // Nobody to wrap a passkey to is not «zero recipients», it is an error: saved like that,
        // no device could use it. Same code the vault would answer.
        if (kind == "passkeys" && members.isEmpty()) {
            throw PmError("no device in the account record can open passkeys: grant `passkeys` to one before saving it", "no-passkeys-device")
        }
        val wraps = LinkedHashMap<String, JsonElement>()
        r.str("recoveryPub")?.let { wraps[RECOVERY] = Crypto.wrapForMember(cek, it) }
        for (m in members) {
            val o = m as? JsonObject ?: continue
            wraps[o.str("pub") ?: continue] = Crypto.wrapForMember(cek, o.str("encPub") ?: throw PmError("a device in the record has no encryption key", "no-encpub"))
        }
        return JsonObject(wraps)
    }

    private fun seal(cek: String, value: String) = Crypto.encryptWithCek(cek, 0, value)

    private suspend fun author(body: JsonObject, ts: Long) = buildJsonObject {
        put("pub", identity.publickey); put("sig", identity.sign(body)); put("ts", ts)
    }

    /** Saves a NEW entry: encrypted, wrapped to whoever the record says, and signed. Returns its view. */
    suspend fun put(plain: Entry): View {
        val k = keys()
        val t = now()
        val e = plain.copy(title = plain.title.trim(), name = plain.name.trim(), sites = Entry.normalizeSites(plain.sites))
        if (e.id.isEmpty()) throw PmError("an entry needs an id", "bad-entry")
        val cek = Crypto.makeContentKey()

        val fields = LinkedHashMap<String, JsonElement>()
        for (f in Entry.FIXED) e.let { it.copyFixed(f) }.takeIf { it.isNotEmpty() }?.let { fields[f] = seal(cek, it) }
        // The private mark belongs to the ENVELOPE, with its value: who opens it alone must know.
        for (f in e.fields) if (f.value.isNotEmpty()) fields["f:" + PmKeys.fieldIndex(k.kidx, f.key)] = seal(cek, f.toJson().toString())
        // The passkey's private key goes with ITS key and its recipients (only devices with
        // `passkeys`); the user handle, with everything else.
        val wa = e.webauthn
        val cekPk = if (wa != null && wa.privateKey.isNotEmpty()) Crypto.makeContentKey() else null
        if (wa != null) {
            if (wa.userHandle.isNotEmpty()) fields["wa.userHandle"] = seal(cek, wa.userHandle)
            if (cekPk != null) fields[PASSKEY_FIELD] = seal(cekPk, wa.privateKey)
        }

        val view = View(
            id = e.id, type = e.type, title = e.title, sites = e.sites, hint = e.who(),
            fieldKeys = e.fieldValues().map { it.first }, privateKeys = e.privateKeys(),
            hasSecret = e.secret.isNotEmpty(), hasTotp = e.totp.isNotEmpty(), hasNotes = e.notes.isNotEmpty(),
            hasFields = e.fields.isNotEmpty(), hasWebauthn = wa != null,
            webauthn = wa?.let { buildJsonObject { put("rpId", it.rpId); put("credentialId", it.credentialId); put("signCount", it.signCount) } },
            updatedAt = t, digests = emptyMap(),
        )
        val digests = LinkedHashMap<String, JsonElement>()
        for ((key, value) in e.digestValues()) digests[sealedKey(key)] = JsonPrimitive(PmKeys.valueDigest(k.kcmp, e.id, key, value))

        val idx = e.sites.map { PmKeys.siteIndex(k.kidx, it) }
        val sealedView = seal(cek, view.toJson().toString())
        val priv = e.privateKeys().map { sealedKey(it) }
        val waIdx = wa?.let { buildJsonObject {
            put("rp", PmKeys.passkeyIndex(k.kidx, "rp", it.rpId)); put("cred", PmKeys.passkeyIndex(k.kidx, "cred", it.credentialId))
        } }
        val body = buildJsonObject {
            put("op", "pm.entry"); put("id", e.id); put("idx", arr(idx.sorted())); put("wa", waIdx ?: JsonNull)
            put("view", ref(sealedView))
            put("fields", arr(fields.keys.sorted().map { it + ":" + ref(fields.getValue(it) as JsonObject) }))
            put("digests", JsonObject(digests)); put("ts", t)
        }
        val entry = buildJsonObject {
            put("id", e.id); put("createdAt", if (e.createdAt > 0) e.createdAt else t); put("updatedAt", t)
            put("idx", arr(idx)); put("wa", waIdx ?: JsonNull); put("view", sealedView)
            put("fields", JsonObject(fields)); put("digests", JsonObject(digests)); put("priv", arr(priv))
            put("author", author(body, t))
        }
        request("pm2.put", buildJsonObject {
            put("entry", entry); put("main", buildJsonObject { put("wraps", wrapAll(cek)) })
            if (cekPk != null) put("passkeys", buildJsonObject { put("wraps", wrapAll(cekPk, "passkeys")) })
        })
        return view.copy(digests = digests.mapValues { (it.value as JsonPrimitive).content })
    }

    /**
     * CHANGES some fields without reading the rest. What does not come here stays in the
     * vault as it was, unopened. The view is rebuilt with what is already known: the NAMES of
     * the fields and which are private live in it.
     */
    suspend fun patch(id: String, changes: Changes): View {
        val k = keys()
        val cur = list().firstOrNull { it.id == id } ?: throw PmError("there is no entry with that id", "not-found")
        val t = now()
        val cek = Crypto.makeContentKey()

        // sealed key -> (real name, value): the digest is over the NAME, not its fingerprint.
        val values = LinkedHashMap<String, Pair<String, String>>()
        val drop = ArrayList<String>()
        val fieldKeys = cur.fieldKeys.toMutableList()
        val privateKeys = LinkedHashSet(cur.privateKeys)
        var hasSecret = cur.hasSecret; var hasTotp = cur.hasTotp; var hasNotes = cur.hasNotes

        for (f in Entry.FIXED) {
            val v = changes.fixed(f) ?: continue
            if (v.isNotEmpty()) {
                values[f] = f to v
                if (f != "name" && f != "notes" && f !in fieldKeys) fieldKeys.add(f)
            } else {
                drop.add(f); fieldKeys.remove(f)
            }
            if (f in Entry.ALWAYS_PRIVATE) { if (v.isNotEmpty()) privateKeys.add(f) else privateKeys.remove(f) }
            when (f) { "secret" -> hasSecret = v.isNotEmpty(); "totp" -> hasTotp = v.isNotEmpty(); "notes" -> hasNotes = v.isNotEmpty() }
        }
        for (f in changes.fields) {
            if (f.value.isEmpty()) continue
            values[sealedKey(f.key)] = f.key to f.toJson().toString()
            if (f.private) privateKeys.add(f.key) else privateKeys.remove(f.key)
            if (f.key !in fieldKeys) fieldKeys.add(f.key)
        }
        for (key in changes.removeFields) { drop.add(sealedKey(key)); fieldKeys.remove(key); privateKeys.remove(key) }

        val sites = changes.sites?.let(Entry::normalizeSites)
        val view = cur.copy(
            title = changes.title?.trim() ?: cur.title,
            sites = sites ?: cur.sites,
            hint = changes.hint ?: changes.name?.takeIf { it.isNotEmpty() } ?: cur.hint,
            fieldKeys = fieldKeys, privateKeys = privateKeys.toList(),
            hasSecret = hasSecret, hasTotp = hasTotp, hasNotes = hasNotes,
            hasFields = fieldKeys.any { it !in Entry.FIXED }, updatedAt = t,
            webauthn = changes.signCount?.let { n ->
                val w = cur.webauthn as? JsonObject ?: throw PmError("that entry has no passkey to count signatures of", "bad-entry")
                JsonObject(w + ("signCount" to JsonPrimitive(n)))
            } ?: cur.webauthn,
        )

        val fields = LinkedHashMap<String, JsonElement>()
        val digests = LinkedHashMap<String, JsonElement>()
        for ((sk, nv) in values) {
            fields[sk] = seal(cek, nv.second)
            // The digest of a free field is over its VALUE, as whoever created the entry wrote it.
            val plain = if (sk.startsWith("f:")) Field.of(json.parseToJsonElement(nv.second) as JsonObject)?.value ?: "" else nv.second
            digests[sk] = JsonPrimitive(PmKeys.valueDigest(k.kcmp, id, nv.first, plain))
        }
        val sealedView = seal(cek, view.toJson().toString())
        val priv = view.privateKeys.map { sealedKey(it) }
        val idx = sites?.map { PmKeys.siteIndex(k.kidx, it) }
        val body = buildJsonObject {
            put("op", "pm.patch"); put("id", id); put("view", ref(sealedView))
            put("fields", arr(fields.keys.sorted().map { it + ":" + ref(fields.getValue(it) as JsonObject) }))
            put("drop", arr(drop.sorted())); put("digests", JsonObject(digests))
            put("priv", arr(priv.sorted())); put("idx", idx?.let { arr(it.sorted()) } ?: JsonNull); put("wa", JsonNull)
            put("ts", t)
        }
        request("pm2.patch", buildJsonObject {
            put("id", id); put("view", sealedView); put("fields", JsonObject(fields)); put("drop", arr(drop))
            put("digests", JsonObject(digests)); put("priv", arr(priv))
            if (idx != null) put("idx", arr(idx))
            put("author", author(body, t))
            put("main", buildJsonObject { put("wraps", wrapAll(cek)) })
        })
        return view
    }

    suspend fun remove(id: String) { request("pm2.remove", buildJsonObject { put("id", id) }) }

    /** A value's digest, to say whether it is already saved the same without opening anything. */
    suspend fun digest(id: String, key: String, value: String) = PmKeys.valueDigest(keys().kcmp, id, key, value)

    private fun Entry.copyFixed(f: String): String = when (f) {
        "name" -> name; "username" -> username; "secret" -> secret; "totp" -> totp; "notes" -> notes; else -> ""
    }
}
