package com.dotrino.passmanager.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** A free field of an entry — `lib/src/fields.js`. `private` = it only leaves the vault with a confirmation. */
data class Field(val label: String, val value: String, val kind: String? = null, val private: Boolean = false) {
    /** What makes two fields «the same»: the kind when known, else the label the user gave it. */
    val key: String get() = kind ?: label.trim().let { if (it.isNotEmpty()) "label:$it" else "other" }

    /** As the JS writes it inside its envelope (`JSON.stringify` of the normalised field). */
    fun toJson(): JsonObject = buildJsonObject {
        put("label", label); put("value", value)
        if (kind != null) put("kind", kind)
        if (private) put("private", true)
    }

    companion object {
        val KINDS = listOf(
            "email", "tel", "given-name", "family-name", "full-name", "street-address", "city", "region",
            "postal-code", "country", "organization", "birthday", "id-number", "other",
        )

        fun of(o: JsonObject): Field? {
            fun s(k: String) = (o[k] as? JsonPrimitive)?.content ?: ""
            val label = s("label").trim(); val value = s("value")
            if (label.isEmpty() && value.isEmpty()) return null
            return Field(label, value, s("kind").takeIf { it in KINDS }, (o["private"] as? JsonPrimitive)?.content == "true")
        }

        fun listOf(text: String?): List<Field> = try {
            (Json.parseToJsonElement(text?.ifEmpty { "[]" } ?: "[]") as? JsonArray).orEmpty().mapNotNull { (it as? JsonObject)?.let(::of) }
        } catch (_: Exception) { emptyList() }
    }
}

/** An entry in the clear — the shape of `newEntry` in `lib/src/model.js`. Only ever in memory. */
data class Entry(
    val id: String,
    val type: String = "login",
    val title: String = "",
    val name: String = "",
    val sites: List<String> = emptyList(),
    val username: String = "",
    val secret: String = "",
    val totp: String = "",
    val notes: String = "",
    val fields: List<Field> = emptyList(),
    val createdAt: Long = 0,
    val updatedAt: Long = 0,
    /** What stayed behind: not asked for, or this device cannot open it (a passkey without the permission). */
    val withheld: List<String> = emptyList(),
) {
    companion object {
        val FIXED = listOf("name", "username", "secret", "totp", "notes")
        /** Private for what they are, not for a mark. The username is not here on purpose: it is the entry's visible name. */
        val ALWAYS_PRIVATE = listOf("secret", "totp", "notes")

        fun normalizeSites(sites: List<String>): List<String> =
            sites.map { it.trim().lowercase() }.filter { it.isNotEmpty() }.distinct()
    }

    /** Every field that can be filled, as `key to value`, no public/private distinction (`entryFieldValues`). */
    fun fieldValues(): List<Pair<String, String>> {
        val out = ArrayList<Pair<String, String>>()
        fun add(k: String, v: String) { if (v.isNotEmpty() && out.none { it.first == k }) out.add(k to v) }
        add("username", username); add("secret", secret); add("totp", totp)
        for (f in fields) add(f.key, f.value)
        return out
    }

    /** The same plus the notes: only for the digests (`entryDigestValues`). */
    fun digestValues(): List<Pair<String, String>> =
        fieldValues().let { if (notes.isNotEmpty() && it.none { p -> p.first == "notes" }) it + ("notes" to notes) else it }

    fun privateKeys(): List<String> {
        val out = LinkedHashSet<String>()
        if (secret.isNotEmpty()) out.add("secret"); if (totp.isNotEmpty()) out.add("totp"); if (notes.isNotEmpty()) out.add("notes")
        for (f in fields) if (f.private && f.value.isNotEmpty()) out.add(f.key)
        return out.toList()
    }

    /** What the entry is called for whoever has to choose: the user's name for it, else its clearest public datum (`entryWho`). */
    fun who(): String {
        if (name.isNotEmpty()) return name
        if (username.isNotEmpty()) return username
        val pub = fields.filter { !it.private && it.value.isNotEmpty() }
        return (pub.firstOrNull { it.kind == "email" } ?: pub.firstOrNull())?.value ?: ""
    }
}

/** What whoever can open the entry sees without asking for any value: names, never values. */
data class View(
    val id: String,
    val type: String,
    val title: String,
    val sites: List<String>,
    val hint: String,
    val fieldKeys: List<String>,
    val privateKeys: List<String>,
    val hasSecret: Boolean,
    val hasTotp: Boolean,
    val hasNotes: Boolean,
    val hasFields: Boolean,
    val hasWebauthn: Boolean,
    val webauthn: JsonElement?,
    val updatedAt: Long,
    /** The digests as the vault keeps them (free fields keyed by fingerprint). */
    val digests: Map<String, String>,
) {
    /** The sealed view's JSON, as the JS writes it. */
    fun toJson(): JsonObject = buildJsonObject {
        put("type", type); put("title", title)
        put("sites", JsonArray(sites.map(::JsonPrimitive)))
        put("hint", hint)
        put("fieldKeys", JsonArray(fieldKeys.map(::JsonPrimitive)))
        put("privateKeys", JsonArray(privateKeys.map(::JsonPrimitive)))
        put("has", buildJsonObject {
            put("secret", hasSecret); put("totp", hasTotp); put("notes", hasNotes); put("fields", hasFields); put("webauthn", hasWebauthn)
        })
        if (webauthn != null) put("webauthn", webauthn)
    }

    /** What a text search looks at: the title, the visible name and the sites. Never a value. */
    fun matches(term: String): Boolean = (listOf(title, hint) + sites).joinToString(" ").lowercase().contains(term)
}
