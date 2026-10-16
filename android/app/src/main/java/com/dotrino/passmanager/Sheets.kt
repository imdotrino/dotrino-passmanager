package com.dotrino.passmanager

import android.app.Dialog
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import com.dotrino.passmanager.core.Changes
import com.dotrino.passmanager.core.Entry
import com.dotrino.passmanager.core.Field
import com.dotrino.passmanager.core.Generate
import com.dotrino.passmanager.core.PmVault
import com.dotrino.passmanager.core.Totp
import com.dotrino.passmanager.core.View as EntryView
import java.util.UUID

/** What a field key is called on screen: the fixed ones and the known kinds by name, a free one by its own label. */
fun labelOfKey(key: String): String = when {
    key in Entry.FIXED -> t("field.$key")
    key.startsWith("label:") -> key.removePrefix("label:")
    key in Field.KINDS -> t("kind.$key")
    else -> key
}

/**
 * ONE ENTRY: its public details as they are, its private ones covered until asked for. A
 * private value is fetched from the vault when «Show» or «Copy» is pressed — which is when
 * the vault may ask one of your devices to approve — and forgotten when the sheet closes.
 */
class DetailSheet(private val act: MainActivity, private val vault: PmVault, private val view: EntryView) {
    private val ticker = Handler(Looper.getMainLooper())
    private var dialog: Dialog? = null
    private val opened = HashMap<String, String>()        // key -> value, only while the sheet is open
    private var entry: Entry? = null
    private lateinit var body: LinearLayout

    fun open() {
        val (d, b) = act.sheet(act.titleOf(view))
        dialog = d; body = b
        d.window?.addFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE)
        d.setOnDismissListener { ticker.removeCallbacksAndMessages(null); opened.clear(); entry = null }
        render()
        d.show()
        // The public details cost no approval: they are asked for at once.
        val publicKeys = view.fieldKeys.filter { it !in view.privateKeys }
        if (publicKeys.isNotEmpty()) act.ask({ it.get(view.id, publicKeys) }) { e -> entry = e; if (d.isShowing) render() }
    }

    private fun valueOf(key: String): String? = opened[key] ?: entry?.let { e ->
        when (key) { "username" -> e.username.ifEmpty { null }; else -> e.fields.firstOrNull { it.key == key }?.value }
    }

    private fun render() {
        ticker.removeCallbacksAndMessages(null)
        body.removeAllViews()
        body.add(act.label(view.sites.joinToString(", ").ifEmpty { t("detail.noSites") }, 14f, act.col(R.color.m_muted)).apply { tag = "detail-sites" })
        // THE PASSKEY, visible: which site it is for and how many times it signed. Its key is not
        // shown (it is a key, not something to read); deleting it is the «Delete» below.
        (view.webauthn as? kotlinx.serialization.json.JsonObject)?.let { w ->
            fun s(k: String) = (w[k] as? kotlinx.serialization.json.JsonPrimitive)?.content ?: ""
            body.add(LinearLayout(act).apply {
                orientation = LinearLayout.VERTICAL; tag = "detail-passkey"
                add(act.label(t("passkey.label"), 12f, act.col(R.color.m_muted), bold = true))
                add(act.label(t("passkey.detail", "site" to s("rpId"), "n" to s("signCount").ifEmpty { "0" }), 16f))
            }, top = 14)
        }
        for (key in view.fieldKeys + (if (view.hasNotes) listOf("notes") else emptyList())) body.add(fieldRow(key), top = 14)
        if (entry?.withheld?.isNotEmpty() == true) body.add(act.label(t("detail.withheld"), 13f, act.col(R.color.m_muted)), top = 14)
        body.add(LinearLayout(act).apply {
            gravity = Gravity.END
            addView(act.pill(t("delete")) { askDelete() }.apply { tag = "detail-delete" })
            addView(act.pill(t("edit"), filled = true) { dialog?.dismiss(); EditSheet(act, vault, view).open() }.apply { tag = "detail-edit" },
                LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { leftMargin = act.px(10) })
        }, top = 22)
    }

    private fun fieldRow(key: String): View {
        val private = key in view.privateKeys || key == "notes"
        val value = valueOf(key)
        return LinearLayout(act).apply {
            orientation = LinearLayout.VERTICAL
            add(act.label(labelOfKey(key), 12f, act.col(R.color.m_muted), bold = true))
            addView(LinearLayout(act).apply {
                gravity = Gravity.CENTER_VERTICAL
                val shown = when {
                    value == null -> if (private) t("detail.hidden") else "…"
                    key == "totp" -> totpText(value)
                    else -> value
                }
                val text = act.label(shown, 16f).apply { tag = "value:$key"; setTextIsSelectable(value != null && !private) }
                addView(text, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
                if (key == "totp" && value != null) tick(text, value)
                if (private) addView(small(if (value == null) t("show") else t("hide"), "show:$key") {
                    if (value == null) reveal(key) { render() } else { opened.remove(key); render() }
                })
                addView(small(t("copy"), "copy:$key") {
                    val copyNow = { v: String -> act.copy(if (key == "totp") Totp.code(v) else v, if (key == "totp") t("copy.code") else labelOfKey(key)) }
                    val have = valueOf(key)
                    if (have != null) copyNow(have) else reveal(key, keep = false) { v -> copyNow(v) }
                })
            })
        }
    }

    private fun small(text: String, tag: String, onClick: () -> Unit) = act.label(text, 13f, act.col(R.color.m_accent), bold = true).apply {
        this.tag = tag; setPadding(act.px(10), act.px(8), act.px(4), act.px(8)); setOnClickListener { onClick() }
    }

    /** Fetches ONE private value: the phone's «is it you?» first, then the vault (and its approval). */
    private fun reveal(key: String, keep: Boolean = true, then: (String) -> Unit) = act.confirmed {
        act.ask({ it.get(view.id, listOf(key)) }) { e ->
            val v = when (key) {
                "secret" -> e.secret; "totp" -> e.totp; "notes" -> e.notes; "username" -> e.username
                else -> e.fields.firstOrNull { it.key == key }?.value ?: ""
            }
            if (keep && dialog?.isShowing == true) opened[key] = v
            then(v)
        }
    }

    private fun totpText(secret: String): String = try {
        Totp.code(secret) + "  ·  " + t("detail.totpLeft", "s" to Totp.remaining(secret))
    } catch (e: Exception) { act.messageOf(e) }

    private fun tick(text: TextView, secret: String) {
        ticker.postDelayed(object : Runnable {
            override fun run() { if (dialog?.isShowing == true) { text.text = totpText(secret); ticker.postDelayed(this, 1000) } }
        }, 1000)
    }

    private fun askDelete() {
        body.removeAllViews()
        body.add(act.label(t("delete.ask", "name" to act.titleOf(view)), 16f))
        body.add(LinearLayout(act).apply {
            gravity = Gravity.END
            addView(act.pill(t("cancel")) { render() }.apply { tag = "delete-cancel" })
            addView(act.pill(t("delete.yes"), filled = true) {
                // A request, not a wait: the sheet closes and the row says «pending» (requestDelete).
                dialog?.dismiss(); act.requestDelete(view)
            }.apply { tag = "delete-yes"; background = rounded(act.col(R.color.m_danger), act.px(24)) },
                LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { leftMargin = act.px(10) })
        }, top = 22)
    }
}

/**
 * NEW or EDIT. Editing changes ONLY what was touched: a private detail is not fetched to be
 * edited — left empty it stays as it is in the vault, and typing replaces it. That is what
 * lets a password be changed without anybody having to approve reading the old one.
 */
class EditSheet(private val act: MainActivity, private val vault: PmVault, private val view: EntryView?) {
    /** A free field on the form. [had] = it exists in the vault; [known] = its value is in hand (public). */
    private class Row(val key: String?, val label: EditText, val value: EditText, var private: Boolean, val had: Boolean, val known: String?, var removed: Boolean = false)

    private var dialog: Dialog? = null
    private lateinit var body: LinearLayout
    private lateinit var name: EditText
    private lateinit var sites: EditText
    private lateinit var username: EditText
    private lateinit var secret: EditText
    private lateinit var totp: EditText
    private lateinit var notes: EditText
    private val rows = ArrayList<Row>()
    private val dropFixed = HashSet<String>()
    private lateinit var free: LinearLayout
    private var before: Entry? = null

    fun open() {
        val (d, b) = act.sheet(t(if (view == null) "edit.new" else "edit.title"))
        dialog = d; body = b
        d.window?.addFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE)
        if (view == null) { build(null); d.show(); return }
        // What is public is brought to be edited in place; what is private is not.
        val publicKeys = listOf("name") + view.fieldKeys.filter { it !in view.privateKeys }
        act.ask({ it.get(view.id, publicKeys) }) { e -> before = e; build(e); d.show() }
    }

    private fun input(tag: String, hint: String, text: String = "", secret: Boolean = false, multi: Boolean = false) = act.field(hint, single = !multi).apply {
        this.tag = tag; setText(text)
        if (secret) inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        if (multi) { minLines = 2; inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE }
    }

    private fun caption(text: String) = act.label(text, 12f, act.col(R.color.m_muted), bold = true)

    /** A private detail that already exists: «unchanged» as its hint, and a way to take it out. */
    private fun keepable(key: String, field: EditText, has: Boolean): View = LinearLayout(act).apply {
        orientation = LinearLayout.VERTICAL
        add(field)
        if (has) {
            field.hint = t("field.keep")
            val link = act.label(t("field.remove"), 13f, act.col(R.color.m_accent), bold = true).apply { tag = "remove:$key"; setPadding(act.px(4), act.px(8), act.px(4), 0) }
            link.setOnClickListener {
                if (dropFixed.remove(key)) { field.isEnabled = true; field.hint = t("field.keep"); link.text = t("field.remove") }
                else { dropFixed.add(key); field.setText(""); field.isEnabled = false; field.hint = t("field.willRemove"); link.text = t("field.undo") }
            }
            add(link, width = ViewGroup.LayoutParams.WRAP_CONTENT)
        }
    }

    private fun build(e: Entry?) {
        body.removeAllViews()
        body.add(caption(t("field.name")))
        name = input("edit-name", t("field.nameHint"), e?.name ?: ""); body.add(name, top = 4)
        body.add(caption(t("field.sites")), top = 14)
        sites = input("edit-sites", t("field.sitesHint"), (view?.sites ?: emptyList()).joinToString(", ")); body.add(sites, top = 4)
        body.add(caption(t("field.username")), top = 14)
        username = input("edit-username", "", e?.username ?: ""); body.add(username, top = 4)

        body.add(caption(t("field.secret")), top = 14)
        secret = input("edit-secret", "", secret = true)
        body.add(keepable("secret", secret, view?.hasSecret == true), top = 4)
        body.add(act.pill(t("generate")) { secret.isEnabled = true; dropFixed.remove("secret"); secret.setText(Generate.password()) }.apply { tag = "edit-generate" }, top = 8, width = ViewGroup.LayoutParams.WRAP_CONTENT)

        body.add(caption(t("field.totp")), top = 14)
        totp = input("edit-totp", t("field.totpHint"), secret = true)
        body.add(keepable("totp", totp, view?.hasTotp == true), top = 4)
        body.add(caption(t("field.notes")), top = 14)
        notes = input("edit-notes", "", multi = true)
        body.add(keepable("notes", notes, view?.hasNotes == true), top = 4)

        free = LinearLayout(act).apply { orientation = LinearLayout.VERTICAL }
        body.add(free)
        for (key in view?.fieldKeys.orEmpty().filter { it !in Entry.FIXED }) {
            val f = e?.fields?.firstOrNull { it.key == key }
            addRow(key, f?.label ?: labelOfKey(key), f?.value, key in view!!.privateKeys)
        }
        body.add(act.pill(t("field.addFree")) { addRow(null, "", "", false) }.apply { tag = "edit-add-field" }, top = 14, width = ViewGroup.LayoutParams.WRAP_CONTENT)
        if (view != null) body.add(act.label(t("edit.privateNote"), 13f, act.col(R.color.m_muted)), top = 14)
        body.add(act.pill(t("save"), filled = true) { save() }.apply { tag = "edit-save" }, top = 20)
    }

    /** [known] null = a private field that exists: its value is not here, and stays unless replaced. */
    private fun addRow(key: String?, label: String, known: String?, private: Boolean) {
        val had = key != null
        val l = input("free-label", t("field.label"), label).apply { isEnabled = !had }   // the name IS the key of an existing field
        val v = input("free-value", if (had && known == null) t("field.keep") else t("field.value"), known ?: "", secret = private)
        val row = Row(key, l, v, private, had, known)
        rows.add(row)
        val box = LinearLayout(act).apply { orientation = LinearLayout.VERTICAL; tag = "free-row" }
        box.add(l); box.add(v, top = 6)
        val mark = act.label("", 13f, act.col(R.color.m_accent), bold = true).apply { tag = "free-private"; setPadding(act.px(4), act.px(8), act.px(14), 0) }
        fun paint() { mark.text = t(if (row.private) "field.private" else "field.public") }
        paint()
        // The private mark lives inside the envelope, with the value: it changes when the value is written again.
        val canMark = !had || known != null
        mark.alpha = if (canMark) 1f else 0.5f
        if (canMark) mark.setOnClickListener { row.private = !row.private; paint() }
        val remove = act.label(t("field.remove"), 13f, act.col(R.color.m_accent), bold = true).apply { tag = "free-remove"; setPadding(act.px(4), act.px(8), act.px(4), 0) }
        remove.setOnClickListener {
            if (!had) { rows.remove(row); free.removeView(box); return@setOnClickListener }
            row.removed = !row.removed
            v.isEnabled = !row.removed; box.alpha = if (row.removed) 0.5f else 1f
            remove.text = t(if (row.removed) "field.undo" else "field.remove")
        }
        box.addView(LinearLayout(act).apply { addView(mark); addView(remove) })
        free.add(box, top = 14)
    }

    private fun save() {
        val siteList = sites.text.toString().split(",", " ", "\n").map { it.trim() }.filter { it.isNotEmpty() }
        val nm = name.text.toString().trim(); val user = username.text.toString().trim()
        if (view == null) {
            if (nm.isEmpty() && siteList.isEmpty() && user.isEmpty()) { act.toast(t("edit.needTitle")); return }
            val fields = rows.mapNotNull { r -> val l = r.label.text.toString().trim(); val v = r.value.text.toString(); if (l.isEmpty() || v.isEmpty()) null else Field(l, v, null, r.private) }
            val entry = Entry(
                id = UUID.randomUUID().toString(), title = siteList.firstOrNull() ?: nm, name = nm, sites = siteList, username = user,
                secret = secret.text.toString(), totp = totp.text.toString().trim(), notes = notes.text.toString(), fields = fields,
            )
            act.ask({ it.put(entry) }) { dialog?.dismiss(); act.toast(t("saved")); act.reload() }
            return
        }
        val was = before ?: return
        fun fixed(key: String, field: EditText, trim: Boolean = false): String? = when {
            key in dropFixed -> ""
            else -> field.text.toString().let { if (trim) it.trim() else it }.takeIf { it.isNotEmpty() }
        }
        val changed = ArrayList<Field>(); val removed = ArrayList<String>(); val publicAfter = ArrayList<Field>()
        for (r in rows) {
            val typed = r.value.text.toString()
            if (r.had) {
                val key = r.key!!
                val old = was.fields.firstOrNull { it.key == key }
                if (r.removed) { removed.add(key); continue }
                val value = typed.ifEmpty { r.known ?: "" }
                val f = Field(old?.label ?: r.label.text.toString().trim(), value, old?.kind, r.private)
                if (value.isNotEmpty() && (typed != (r.known ?: "") || r.private != (key in view.privateKeys))) changed.add(f)
                if (!r.private && value.isNotEmpty()) publicAfter.add(f)
            } else {
                val l = r.label.text.toString().trim()
                if (l.isEmpty() || typed.isEmpty()) continue
                val f = Field(l, typed, null, r.private); changed.add(f); if (!r.private) publicAfter.add(f)
            }
        }
        val sitesNow = Entry.normalizeSites(siteList)
        // The visible name after the change, from what is public and in hand; with nothing to go by, it stays.
        val hint = Entry(id = view.id, name = nm, username = user, fields = publicAfter).who().takeIf { it.isNotEmpty() }
        val changes = Changes(
            name = nm.takeIf { it != was.name },
            username = user.takeIf { it != was.username },
            secret = fixed("secret", secret), totp = fixed("totp", totp, trim = true), notes = fixed("notes", notes),
            fields = changed, removeFields = removed,
            sites = sitesNow.takeIf { it != view.sites }, hint = hint,
        )
        act.ask({ it.patch(view.id, changes) }) { dialog?.dismiss(); act.toast(t("saved")); act.reload() }
    }
}
