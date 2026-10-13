package com.dotrino.passmanager

import android.content.Context
import com.dotrino.sdk.ui.DotrinoLocale
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * The app's texts: the SAME as the PWA (src/i18n.js), which `scripts/native-i18n.mjs` flattens
 * to assets/i18n.json (`add.title`). `{name}` is replaced; a missing key or variable is an
 * error, not a hole on screen.
 */
object I18n {
    private var dict: Map<String, Map<String, String>>? = null
    var lang = "es"; private set

    fun load(context: Context) {
        if (dict == null) {
            val text = context.assets.open("i18n.json").use { it.readBytes().toString(Charsets.UTF_8) }
            dict = parse(text)
        }
        lang = DotrinoLocale.current(context)
    }

    fun parse(text: String): Map<String, Map<String, String>> =
        Json.parseToJsonElement(text).jsonObject.mapValues { (_, v) -> v.jsonObject.mapValues { it.value.jsonPrimitive.content } }

    fun t(key: String, vararg vars: Pair<String, Any>): String {
        val s = dict?.get(lang)?.get(key) ?: throw IllegalStateException("missing i18n key: $key ($lang)")
        if (vars.isEmpty()) return s
        val m = vars.toMap()
        return Regex("\\{(\\w+)\\}").replace(s) { r ->
            (m[r.groupValues[1]] ?: throw IllegalStateException("missing i18n var \"${r.groupValues[1]}\" for $key")).toString()
        }
    }
}

fun t(key: String, vararg vars: Pair<String, Any>) = I18n.t(key, *vars)
