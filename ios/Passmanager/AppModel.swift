import DotrinoNative
import DotrinoNativeUI
import Foundation
import UIKit

/// The password manager of this app, on the main thread: the phone's profile talking `pm2.*`
/// to the vault that profile is paired with — a device of the record with the `passwords`
/// permission, like the browser extension.
///
/// Nothing is kept: every value is asked from the vault when it is needed and lives in memory
/// while its screen is open.
@MainActor
final class AppModel: ObservableObject {
    /// Federated proxies, after the one the vault link names.
    static let proxies = ["wss://proxy.dotrino.com", "wss://proxy2.dotrino.com"]
    /// The «is it you?» of this app: asked before a private value is shown or copied, where the person turned it on.
    static let presenceKey = "passmanager.reveal"

    /// Why it could not start, for the screen: `no-profile`, `no-vault`, `no-permission`, `no-vault-key`, or nil with a message.
    @Published var problem: String?
    @Published var problemCode: String?
    @Published var booted = false
    @Published var loaded = false
    @Published var views: [EntryView] = []
    @Published var status = "connecting"
    /// How many requests are waiting on the vault: a private value may need an approval on another device.
    @Published var busy = 0
    @Published var toast: String?
    @Published var topbarProfile: DotrinoTopbarProfile?
    @Published var presenceOn = Presence.isOn(AppModel.presenceKey)

    private(set) var vault: PmVault?
    private var session: SealedSession?
    private var transport: PmSession?
    private var booting = false
    private var clipUntil: Date?

    private struct Identity: PmIdentity, @unchecked Sendable {
        let profile: Profile
        var publickey: String { profile.publickey }
        func sign(_ body: JSON) throws -> String { try profile.signData(body) }
        func openSealed(wrap: JSON, envelope: JSON) throws -> String { try profile.openSealed(wrap: wrap, envelope: envelope) }
    }

    private func fail(_ code: String?, _ message: String) { problemCode = code; problem = message }

    func boot() async {
        if vault != nil || booting { return }
        booting = true
        defer { booting = false }
        var p: Profile
        do { p = try Profile.fromPhone() }
        catch let e as Profile.ProfileError { fail("no-profile", t("boot.noProfile") + (e.code == "no-profile" ? "" : " (\(e.code))")); return }
        catch { fail(nil, "\(error)"); return }
        topbarProfile = p.topbar
        guard let link = p.vault else { fail("no-vault", t("boot.noVault")); return }

        // THE RECORD, UP TO DATE: the permission and the vault's key are read from it, and the
        // one the phone holds only moves when somebody asks. If the vault cannot be reached
        // now, the record held is still the one this phone adopted: it decides.
        var stale: Error?
        do {
            let conn = try ProxyConnection(link.proxy)
            defer { conn.close() }
            _ = try await conn.connect()
            let me = p
            try await conn.identifyAs(me.publickey, sign: { try me.signData($0) })
            p = try await ActaSync.catchUp(p, conn)
        } catch { stale = error; print("passmanager: could not bring the record up to date:", error) }

        // With a record that could not be refreshed, «no permission» may only mean «not seen
        // yet»: the reason goes along, so it is not mistaken for a refusal.
        let why = stale.map { " (\($0))" } ?? ""
        guard p.can("passwords") else { fail("no-permission", t("boot.noPermission", ["id": link.deviceId]) + why); return }
        guard let vaultEncPub = p.vaultEncPub else { fail("no-vault-key", t("boot.noVaultKey") + why); return }

        var urls = [link.proxy]
        for u in Self.proxies where !urls.contains(u) { urls.append(u) }
        let s = SealedSession(urls: urls, profile: p, app: "passmanager")
        s.onWarn = { w, e in print("passmanager:", w, e.map { "\($0)" } ?? "") }
        _ = s.onStatus { [weak self] st in Task { @MainActor in self?.status = st.state } }
        s.start()
        let tr = PmSession(session: s, vaultPubkey: link.master, vaultEncPub: vaultEncPub)
        session = s; transport = tr
        vault = PmVault(transport: tr, identity: Identity(profile: p))
        booted = true
        await reload()
    }

    /// ANOTHER PROFILE (switched, created, adopted from the bar's menu), or «Retry»: everything
    /// starts again — changing profile is not reactive, as on the web.
    func reboot() async {
        transport?.close(); session?.close()
        transport = nil; session = nil; vault = nil
        booted = false; loaded = false; views = []; problem = nil; problemCode = nil; topbarProfile = nil
        await boot()
    }

    /// What a row is called: the visible name; without one, its title or its first site.
    func title(of v: EntryView) -> String { !v.hint.isEmpty ? v.hint : (!v.title.isEmpty ? v.title : (v.sites.first ?? "—")) }

    /// Reads the views again from the vault: names and sites, never a value.
    func reload() async {
        guard let vault else { return }
        do {
            views = try await vault.list().sorted { title(of: $0).lowercased() < title(of: $1).lowercased() }
            loaded = true
        } catch { fail(nil, message(of: error)) }
    }

    /// Runs something that talks to the vault. While it waits the bar says so; an error comes
    /// out in words, and the result is nil.
    func ask<T>(_ block: (PmVault) async throws -> T) async -> T? {
        guard let vault else { return nil }
        busy += 1
        defer { busy -= 1 }
        do { return try await block(vault) }
        catch { toast = message(of: error); return nil }
    }

    /// The phone's «is it you?» first, where the person turned it on.
    func confirmed() async -> Bool {
        let r = await Presence.confirmIfOn(Self.presenceKey, reason: t("presence.what"))
        if r == .confirmed { return true }
        if let m = Presence.message(r) { toast = m }
        return false
    }

    func togglePresence() async {
        let r = await Presence.turn(Self.presenceKey, on: !presenceOn, reason: t("presence.what"))
        if let m = Presence.message(r) { toast = m }
        presenceOn = Presence.isOn(Self.presenceKey)
    }

    /// Copies one field of an entry: asked from the vault now, never kept here.
    func copyField(_ v: EntryView, _ key: String, what: String) async {
        if v.privateKeys.contains(key), await !confirmed() { return }
        guard let e = await ask({ try await $0.get(v.id, keys: [key]) }) else { return }
        copy(key == "secret" ? e.secret : e.username, what: what)
    }

    /// To the clipboard, only on this phone (no Handoff) and gone by itself in a minute.
    func copy(_ text: String, what: String) {
        if text.isEmpty { return }
        UIPasteboard.general.setItems([[UIPasteboard.typeAutomatic: text]], options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(60)])
        toast = t("copied", ["what": what])
    }

    func message(of error: Error) -> String {
        let code = (error as? PmError)?.code ?? (error as? Profile.ProfileError)?.code
        let known = ["not-approved", "approval-timeout", "unreachable", "denied", "not-sealed", "not-yours", "no-wrap", "not-found", "needs-vault-signer", "wrong-recipients"]
        if let code, known.contains(code) { return t("err.\(code)") }
        return t("err.other", ["msg": "\(error)"])
    }
}

/// What a field key is called on screen: the fixed ones and the known kinds by name, a free one by its own label.
func labelOfKey(_ key: String) -> String {
    if Entry.fixed.contains(key) { return t("field.\(key)") }
    if key.hasPrefix("label:") { return String(key.dropFirst("label:".count)) }
    if Field.kinds.contains(key) { return t("kind.\(key)") }
    return key
}
