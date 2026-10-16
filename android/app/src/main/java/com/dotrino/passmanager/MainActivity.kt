package com.dotrino.passmanager

import android.app.Activity
import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle
import android.text.Editable
import android.text.TextWatcher
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.BaseAdapter
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.TextView
import com.dotrino.passmanager.core.PmError
import com.dotrino.passmanager.core.PmVault
import com.dotrino.passmanager.core.View as EntryView
import com.dotrino.sdk.ui.DotrinoLocale
import com.dotrino.sdk.ui.DotrinoTopbar
import com.dotrino.sdk.ui.DotrinoWebActivity
import com.dotrino.sdk.ui.IdentityRequired
import com.dotrino.sdk.ui.Presence
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The app: a search box and what is saved, with «copy» one tap away — finding a password and
 * copying it is what this app is for. From a row, its detail; from there, editing. Plain
 * native views.
 */
class MainActivity : Activity() {
    companion object {
        /** The «is it you?» of this app: asked before a private value is shown or copied, where the person turned it on. */
        const val PRESENCE_KEY = "passmanager.reveal"
        private const val CLIP_MS = 60_000L
    }

    private val ui = Handler(Looper.getMainLooper())
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var vault: PmVault? = null
    private var views: List<EntryView> = emptyList()
    /** Deletions sent and waiting for an approval: the row says so until the vault answers. */
    private val pendingDelete = HashSet<String>()
    private var loaded = false
    private var query = ""
    private var content: FrameLayout? = null
    private var status: TextView? = null
    private var busy = 0
    private var clipUntil = 0L

    override fun attachBaseContext(base: Context) = super.attachBaseContext(DotrinoLocale.wrap(base))

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        I18n.load(this)
        // Nothing of this app shows up in a screenshot nor in the recent-apps preview.
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        query = savedInstanceState?.getString("query") ?: ""
        setContentView(shell())
        boot()
    }

    override fun onSaveInstanceState(out: Bundle) { super.onSaveInstanceState(out); out.putString("query", query) }
    // Coming back READS AGAIN: a passkey saved from the system sheet, or a deletion approved on
    // another device, happened while this screen was behind, and the old list would hide it.
    // And the passkey screen may have started the connection over: then this one boots again.
    override fun onResume() {
        super.onResume(); clearClipIfDue()
        if (vault == null || vault !== Passmanager.vault) boot() else reload()
    }
    override fun onDestroy() { scope.cancel(); super.onDestroy() }

    // ---------- start ----------

    private fun boot() {
        if (Passmanager.source == null && !IdentityRequired.check(this)) { showProblem(t("boot.noIdentityApp")); return }
        showMessage(t("list.loading"))
        scope.launch {
            try {
                vault = withContext(Dispatchers.IO) { Passmanager.boot(this@MainActivity) }
                setContentView(shell())
                Passmanager.session?.onStatus { ui.post { renderStatus() } }
                reload()
            } catch (e: Passmanager.BootError) {
                when (e.code) {
                    "no-identity-app" -> { IdentityRequired.show(this@MainActivity); showProblem(t("boot.noIdentityApp")) }
                    "no-profile", "no-profile-keys" -> showProblem(t("boot.noProfile"), listOf(
                        t("boot.createProfile") to { DotrinoWebActivity.open(this@MainActivity, DotrinoTopbar.CREATE_URL) },
                        t("boot.adoptProfile") to { DotrinoWebActivity.open(this@MainActivity, DotrinoTopbar.ADOPT_URL) }))
                    "no-vault" -> showProblem(t("boot.noVault"), listOf(
                        t("boot.noVaultHow") to { DotrinoWebActivity.open(this@MainActivity, DotrinoTopbar.ADOPT_URL) }))
                    "no-permission" -> showProblem(t("boot.noPermission", "id" to (Passmanager.profile?.vault?.deviceId ?: "")))
                    "no-vault-key" -> showProblem(t("boot.noVaultKey"))
                    else -> showProblem(e.message ?: e.code)
                }
            } catch (e: Exception) { showProblem(e.message ?: e.toString()) }
        }
    }

    private fun showMessage(msg: String) {
        val c = content ?: return
        c.removeAllViews()
        c.addView(label(msg, 16f, col(R.color.m_muted)).apply { gravity = Gravity.CENTER; setPadding(px(32), px(48), px(32), px(32)) },
            FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    }

    private fun showProblem(msg: String, actions: List<Pair<String, () -> Unit>> = emptyList()) {
        val c = content ?: return
        c.removeAllViews()
        c.addView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER; setPadding(px(32), px(32), px(32), px(32))
            add(label(msg, 16f, col(R.color.m_muted)).apply { gravity = Gravity.CENTER; tag = "problem" })
            actions.forEachIndexed { i, (text, run) -> add(pill(text, filled = i == 0) { run() }, top = if (i == 0) 20 else 12, width = ViewGroup.LayoutParams.WRAP_CONTENT) }
            add(pill(t("retry"), filled = actions.isEmpty()) { Passmanager.reset(); vault = null; boot() }.apply { tag = "retry" }, top = 20, width = ViewGroup.LayoutParams.WRAP_CONTENT)
        }, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    }

    // ---------- the frame ----------

    private fun shell(): View = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setBackgroundColor(col(R.color.m_bg))
        fitsSystemWindows = true
        val add = label("+", 24f, col(R.color.m_on_accent), bold = true).apply {
            tag = "add"; contentDescription = t("add"); gravity = Gravity.CENTER
            background = rounded(col(R.color.m_accent), px(18)); setPadding(px(14), px(2), px(14), px(4))
            setOnClickListener { vault?.let { EditSheet(this@MainActivity, it, null).open() } }
        }
        addView(DotrinoTopbar(this@MainActivity, repo = "imdotrino/dotrino-passmanager",
            brand = DotrinoTopbar.Brand(t("app.name"), R.drawable.passmanager_brand),
            actions = if (vault != null) listOf(add) else emptyList(),
            profile = Passmanager.profile?.topbar(),
        ) { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://dotrino.com/"))) }.view)
        status = label("", 13f, col(R.color.m_muted)).apply { setPadding(px(16), px(6), px(16), px(6)); visibility = View.GONE; setBackgroundColor(col(R.color.m_card2)); tag = "status" }
        addView(status)
        if (vault != null) {
            val search = field(t("search.placeholder")).apply {
                tag = "search"; setText(query)
                addTextChangedListener(object : TextWatcher {
                    override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
                    override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
                    override fun afterTextChanged(s: Editable?) { query = s?.toString() ?: ""; renderList() }
                })
            }
            addView(search, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { setMargins(px(12), px(10), px(12), px(4)) })
        }
        content = FrameLayout(this@MainActivity)
        addView(content, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
    }

    private fun renderStatus() {
        val s = Passmanager.session?.status?.state
        status?.apply {
            when {
                busy > 0 -> { visibility = View.VISIBLE; text = t("approval.waiting") }
                s == "connecting" -> { visibility = View.VISIBLE; text = t("status.connecting") }
                s == "offline" -> { visibility = View.VISIBLE; text = t("status.offline") }
                else -> visibility = View.GONE
            }
        }
    }

    // ---------- the list ----------

    /** Reads the views again from the vault: names and sites, never a value. */
    fun reload() {
        val v = vault ?: return
        scope.launch {
            try {
                views = withContext(Dispatchers.IO) { v.list() }.sortedBy { titleOf(it).lowercase() }
                pendingDelete.retainAll(views.map { it.id }.toSet())   // what went, went
                loaded = true
                renderList()
            } catch (e: Exception) { showProblem(messageOf(e)) }
        }
    }

    /** What a row is called: the visible name; without one, its title or its first site. */
    fun titleOf(v: EntryView): String = v.hint.ifEmpty { v.title.ifEmpty { v.sites.firstOrNull() ?: "—" } }
    private fun subtitleOf(v: EntryView): String =
        (if (v.id in pendingDelete) t("delete.pendingTag") + " · " else "") +
        // A passkey says so: next to the passwords it looks the same, and it is not.
        (if (v.hasWebauthn) t("passkey.label") + " · " else "") +
            (if (v.hint.isNotEmpty() && v.title.isNotEmpty() && v.title != v.hint) v.title else v.sites.joinToString(", ")).ifEmpty { t("detail.noSites") }

    private fun renderList() {
        val c = content ?: return
        if (!loaded) return
        val term = query.trim().lowercase()
        val shown = if (term.isEmpty()) views else views.filter { it.matches(term) }
        if (shown.isEmpty()) {
            showMessage(if (views.isEmpty()) t("list.empty") else t("list.noMatch", "q" to query.trim()))
            return
        }
        val list = (c.getChildAt(0) as? ListView) ?: ListView(this).apply {
            divider = null; clipToPadding = false; setPadding(px(12), px(6), px(12), px(24)); tag = "list"
            addFooterView(presenceRule(), null, false)
            c.removeAllViews()
            c.addView(this, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        }
        list.adapter = object : BaseAdapter() {
            override fun getCount() = shown.size
            override fun getItem(i: Int) = shown[i]
            override fun getItemId(i: Int) = shown[i].id.hashCode().toLong()
            override fun getView(i: Int, old: View?, parent: ViewGroup?): View = row(shown[i])
        }
    }

    private fun row(v: EntryView): View = LinearLayout(this).apply {
        setPadding(0, px(4), 0, px(4))
        addView(LinearLayout(this@MainActivity).apply {
            background = rounded(col(R.color.m_card), px(16)); gravity = Gravity.CENTER_VERTICAL
            setPadding(px(12), px(10), px(8), px(10)); tag = "entry:" + v.id
            addView(avatar(titleOf(v), v.id, 40))
            addView(LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.VERTICAL; setPadding(px(12), 0, px(8), 0)
                add(label(titleOf(v), 16f, bold = true).apply { isSingleLine = true; ellipsize = android.text.TextUtils.TruncateAt.END })
                add(label(subtitleOf(v), 13f, col(R.color.m_muted)).apply { isSingleLine = true; ellipsize = android.text.TextUtils.TruncateAt.END })
            }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            // Both buttons are always there: one that does not apply is shown disabled, not hidden.
            addView(quick("👤", t("copy.user"), "copy-user:" + v.id, "username" in v.fieldKeys) { copyField(v, "username", t("field.username")) })
            addView(quick("🔑", t("copy.secret"), "copy-secret:" + v.id, v.hasSecret) { copyField(v, "secret", t("field.secret")) })
            setOnClickListener { vault?.let { DetailSheet(this@MainActivity, it, v).open() } }
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    }

    private fun quick(glyph: String, what: String, tag: String, enabled: Boolean, onClick: () -> Unit) = label(glyph, 18f).apply {
        this.tag = tag; contentDescription = what; gravity = Gravity.CENTER
        background = rounded(col(R.color.m_card2), px(14)); setPadding(px(12), px(8), px(12), px(8))
        isEnabled = enabled; alpha = if (enabled) 1f else 0.35f
        if (enabled) setOnClickListener { onClick() }
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { leftMargin = px(6) }
    }

    /** The rule as a sentence, with its button beside it. */
    private fun presenceRule(): View = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL; setPadding(px(4), px(18), px(4), px(8))
        val on = Presence.isOn(this@MainActivity, PRESENCE_KEY)
        add(label(t(if (on) "presence.rule.on" else "presence.rule.off"), 13f, col(R.color.m_muted)).apply { tag = "presence-rule" })
        add(pill(t("presence.change")) {
            Presence.turn(this@MainActivity, PRESENCE_KEY, !on, t("presence.what")) { r ->
                Presence.message(this@MainActivity, r)?.let { toast(it) }
                // The footer is rebuilt with what was saved.
                content?.removeAllViews(); renderList()
            }
        }.apply { tag = "presence-change" }, top = 8, width = ViewGroup.LayoutParams.WRAP_CONTENT)
    }

    // ---------- what the sheets use ----------

    /**
     * Runs something that talks to the vault. While it waits — a private value may need an
     * approval on another device — the bar says so; an error comes out in words.
     */
    fun <T> ask(block: suspend (PmVault) -> T, failed: ((Exception) -> Unit)? = null, done: (T) -> Unit) {
        val v = vault ?: return
        busy++; ui.postDelayed({ renderStatus() }, 1200)
        scope.launch {
            try { done(withContext(Dispatchers.IO) { block(v) }) }
            catch (e: Exception) { toast(messageOf(e)); failed?.invoke(e) }
            finally { busy--; renderStatus() }
        }
    }

    /** The phone's «is it you?» first, where the person turned it on; then [then]. */
    fun confirmed(then: () -> Unit) = Presence.confirmIfOn(this, PRESENCE_KEY, t("presence.what")) { r ->
        if (r == Presence.Result.Confirmed) then() else Presence.message(this, r)?.let { toast(it) }
    }

    /** Copies one field of an entry: asked from the vault now, never kept here. */
    private fun copyField(v: EntryView, key: String, what: String) {
        val go = { ask({ it.get(v.id, listOf(key)) }) { e -> copy(if (key == "secret") e.secret else e.username, what) } }
        if (key in v.privateKeys) confirmed(go) else go()
    }

    fun copy(text: String, what: String) {
        if (text.isEmpty()) return
        val clip = ClipData.newPlainText(what, text)
        // The keyboard and the clipboard preview do not show it.
        clip.description.extras = PersistableBundle().apply { putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true) }
        (getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(clip)
        clipUntil = System.currentTimeMillis() + CLIP_MS
        ui.postDelayed({ clearClipIfDue() }, CLIP_MS + 500)
        toast(t("copied", "what" to what))
    }

    /** What was copied is cleared after a minute — when the app is in front, which is when Android lets it. */
    private fun clearClipIfDue() {
        if (clipUntil == 0L || System.currentTimeMillis() < clipUntil) return
        clipUntil = 0
        runCatching { (getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).clearPrimaryClip() }
    }

    /**
     * DELETING IS A REQUEST, NOT A WAIT (dueño, 2026-10-16: «no me debería quedar esperando la
     * aprobación: se manda la solicitud, se pone pendiente»). The vault keeps the request alive
     * and deletes it when somebody approves, even if this phone stopped listening; so the row is
     * marked pending and the person goes on. A refusal takes the mark off and says so.
     */
    fun requestDelete(v: EntryView) {
        val vault = vault ?: return
        pendingDelete.add(v.id); renderList()
        toast(t("delete.pending"))
        scope.launch {
            try {
                withContext(Dispatchers.IO) { vault.remove(v.id) }
                pendingDelete.remove(v.id); toast(t("deleted")); reload()
            } catch (e: Exception) {
                if ((e as? PmError)?.code == "approval-timeout") {
                    // This phone stopped listening; the vault did not. Look again once its own wait is over.
                    ui.postDelayed({ pendingDelete.remove(v.id); reload() }, 6 * 60_000L)
                } else {
                    pendingDelete.remove(v.id); renderList(); toast(messageOf(e))
                }
            }
        }
    }

    fun messageOf(e: Throwable): String {
        val code = (e as? PmError)?.code ?: (e as? com.dotrino.sdk.Profile.ProfileError)?.code
        val known = listOf("not-approved", "approval-timeout", "unreachable", "denied", "not-sealed", "not-yours", "no-wrap", "not-found", "needs-vault-signer", "wrong-recipients")
        return if (code in known) t("err.$code") else t("err.other", "msg" to (e.message ?: code ?: e.toString()))
    }
}
