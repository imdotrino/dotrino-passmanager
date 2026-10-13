import DotrinoNative
import Foundation

/// Where the requests go: `{ request(op, payload) }`, the same contract as the JS transport.
protocol PmTransport: Sendable {
    func request(_ op: String, _ payload: JSON) async throws -> JSON
}

/// What this device does with its own keys. The private halves never come out: only the work is asked.
protocol PmIdentity: Sendable {
    var publickey: String { get }
    /// P1363 base64 signature over the canonical text of [body].
    func sign(_ body: JSON) throws -> String
    /// A value sealed to this device: its wrap of the content key, then the envelope.
    func openSealed(wrap: JSON, envelope: JSON) throws -> String
}

/// What changes in an entry. `nil` = untouched; an empty string = that field goes away.
struct Changes {
    var title: String? = nil
    var name: String? = nil
    var username: String? = nil
    var secret: String? = nil
    var totp: String? = nil
    var notes: String? = nil
    /// Free fields written again, WITH their value (the private mark lives inside the envelope).
    var fields: [Field] = []
    /// Free fields that go, by their key (`Field.key`).
    var removeFields: [String] = []
    /// The whole list of sites, when it changes.
    var sites: [String]? = nil
    /// The entry's visible name after the change (`Entry.who()` of the edited entry). Whoever
    /// edits has the name and the username in front — both public — and the view alone does
    /// not say which of the two the current one came from.
    var hint: String? = nil

    func fixed(_ k: String) -> String? {
        switch k {
        case "name": return name
        case "username": return username
        case "secret": return secret
        case "totp": return totp
        case "notes": return notes
        default: return nil
        }
    }
}

/// THE SEALED VAULT, SEEN FROM THIS DEVICE — the port of `lib/src/vault/sealed.js` and
/// `lib/src/sealed/{entry,device}.js` (`docs/sealed-passwords.md`). The same as
/// `android/…/core/PmVault.kt`, line by line.
///
/// At the other end there is a vault that keeps envelopes and has no key to open any. So
/// everything is done here: open each envelope with this device's wrap; to write, encrypt,
/// wrap to exactly the recipients the record names and sign; and to search by text, ask for
/// the views (names, never values) and search them here.
actor PmVault {
    static let recovery = "#recovery"
    static let ops = ["pm2.recipients", "pm2.profile", "pm2.views", "pm2.find", "pm2.passkey", "pm2.get", "pm2.put", "pm2.patch", "pm2.remove"]

    private let transport: PmTransport
    private let identity: PmIdentity
    private let now: @Sendable () -> Int64
    private var keysCache: ProfileKeys?
    private var recipientsCache: JSON?

    init(transport: PmTransport, identity: PmIdentity, now: @escaping @Sendable () -> Int64 = { nowMs() }) {
        self.transport = transport; self.identity = identity; self.now = now
    }

    /// Drops what was cached: after changing account, or when the record may have moved.
    func forget() { keysCache = nil; recipientsCache = nil }

    private static func isFixed(_ k: String) -> Bool { Entry.fixed.contains(k) || k.hasPrefix("wa.") }
    private static func strings(_ j: JSON?) -> [String] { (j?.array ?? []).compactMap { $0.string } }
    private static func arr(_ l: [String]) -> JSON { .array(l.map { .string($0) }) }
    private static func ref(_ env: JSON) -> String { (env["iv"]?.string ?? "") + "." + (env["ct"]?.string ?? "") }

    private func request(_ op: String, _ payload: JSON = .object([:])) async throws -> JSON {
        guard Self.ops.contains(op) else { throw PmError("unknown operation: \(op)", code: "not-allowed") }
        return try await transport.request(op, payload)
    }

    /// The profile keys. Without them there is no searching (the index goes by fingerprint) nor comparing.
    func keys() async throws -> ProfileKeys {
        if let k = keysCache { return k }
        let r = try await request("pm2.profile")
        guard let wrap = r["wrap"]?.objectValue else { throw PmError("this device has no key for the profile password key", code: "not-yours") }
        guard let envelope = r["envelope"]?.objectValue else { throw PmError("the vault answered no profile key", code: "unknown") }
        let k = try PmKeys.profileKeys(try identity.openSealed(wrap: wrap, envelope: envelope))
        keysCache = k
        return k
    }

    /// Who each key has to be wrapped to. The list comes out of the record and the vault knows it.
    func recipients() async throws -> JSON {
        if let r = recipientsCache { return r }
        let r = try await request("pm2.recipients")
        guard r.object != nil else { throw PmError("the vault answered no recipients", code: "unknown") }
        recipientsCache = r
        return r
    }

    private func sealedKey(_ k: String) async throws -> String {
        Self.isFixed(k) ? k : "f:" + PmKeys.fieldIndex(try await keys().kidx, k)
    }

    private func viewOf(id: String, updatedAt: Int64, digests: JSON?, text: String) throws -> EntryView {
        let o = try JSON.parse(text)
        guard o.object != nil else { throw PmError("the view of an entry is not an object", code: "bad-entry") }
        let has = o["has"]
        func flag(_ k: String) -> Bool { has?[k]?.bool == true }
        var d: [String: String] = [:]
        for (k, v) in digests?.object ?? [:] { if let s = v.string { d[k] = s } }
        return EntryView(
            id: id, type: o["type"]?.string ?? "login", title: o["title"]?.string ?? "", sites: Self.strings(o["sites"]),
            hint: o["hint"]?.string ?? "", fieldKeys: Self.strings(o["fieldKeys"]), privateKeys: Self.strings(o["privateKeys"]),
            hasSecret: flag("secret"), hasTotp: flag("totp"), hasNotes: flag("notes"), hasFields: flag("fields"), hasWebauthn: flag("webauthn"),
            webauthn: o["webauthn"]?.objectValue, updatedAt: updatedAt, digests: d)
    }

    private func openView(_ v: JSON) throws -> EntryView {
        guard let env = v["view"]?.objectValue else { throw PmError("an entry came without its view", code: "bad-entry") }
        guard let wrap = v["wrap"]?.objectValue else { throw PmError("this device has no key for that content generation", code: "no-wrap") }
        guard let id = v["id"]?.string else { throw PmError("an entry came without its id", code: "bad-entry") }
        return try viewOf(id: id, updatedAt: v["updatedAt"]?.int ?? 0, digests: v["digests"], text: try identity.openSealed(wrap: wrap, envelope: env))
    }

    /// THE WHOLE VAULT, OPENED HERE: the VIEWS, which carry no value, opened with this
    /// device's key. It is what replaces searching inside the vault, which sees no text.
    func list() async throws -> [EntryView] {
        try (try await request("pm2.views").array ?? []).map { try openView($0) }
    }

    /// Search by text, here, over the views: title, visible name and sites. No value leaves the vault for this.
    func search(_ q: String, limit: Int = 50) async throws -> [EntryView] {
        let term = q.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if term.isEmpty { return [] }
        return Array(try await list().filter { $0.matches(term) }.prefix(limit))
    }

    /// ONE entry, and only the fields asked for (`keys` = the interface's names: `username`,
    /// `secret`, a free field's key). With a private one among them the vault asks for an
    /// approval first, and this call waits for it.
    func get(_ id: String, keys wanted: [String]? = nil) async throws -> Entry {
        var payload: [String: JSON] = ["id": .string(id)]
        if let wanted {
            var ks: [String] = []
            for k in wanted { ks.append(try await sealedKey(k)) }
            payload["keys"] = Self.arr(ks)
        }
        let got = try await request("pm2.get", .object(payload))
        guard got.object != nil else { throw PmError("the vault answered no entry", code: "unknown") }
        let wraps = got["wraps"]
        func open(_ env: JSON) throws -> String {
            guard let gen = env["gen"]?.int, let wrap = wraps?[String(gen)]?.objectValue else {
                throw PmError("this device has no key for that content generation", code: "no-wrap")
            }
            return try identity.openSealed(wrap: wrap, envelope: env)
        }
        let updatedAt = got["updatedAt"]?.int ?? 0
        guard let viewEnv = got["view"]?.objectValue else { throw PmError("the entry came without its view", code: "bad-entry") }
        let view = try viewOf(id: id, updatedAt: updatedAt, digests: got["digests"], text: try open(viewEnv))
        var e = Entry(id: id, type: view.type, title: view.title, sites: view.sites, updatedAt: updatedAt, withheld: Self.strings(got["withheld"]))
        for (k, env) in got["envelopes"]?.object ?? [:] {
            guard env.object != nil else { continue }
            let value = try open(env)
            switch k {
            case "name": e.name = value
            case "username": e.username = value
            case "secret": e.secret = value
            case "totp": e.totp = value
            case "notes": e.notes = value
            default:
                // The field comes whole: its label, its kind, its value and its mark.
                if k.hasPrefix("f:"), let o = try? JSON.parse(value), let f = Field(o) { e.fields.append(f) }
            }
        }
        // A dictionary has no order: the free fields follow the view's, which is the entry's.
        let order = view.fieldKeys
        e.fields.sort { (order.firstIndex(of: $0.key) ?? Int.max) < (order.firstIndex(of: $1.key) ?? Int.max) }
        return e
    }

    // `recoveryPub: null` is «the account has no recovery copy yet»: sealed only to the
    // devices. A MISSING key means nobody asked the vault, and that is an error.
    private func wrapAll(_ cek: String) async throws -> JSON {
        let r = try await recipients()
        guard let recoveryPub = r["recoveryPub"] else { throw PmError("ask the vault for the recipients first", code: "no-recipients") }
        var wraps: [String: JSON] = [:]
        if let rp = recoveryPub.string { wraps[Self.recovery] = try Crypto.wrapForMember(cek, memberEncPub: rp) }
        for m in r["main"]?.array ?? [] {
            guard let pub = m["pub"]?.string else { continue }
            guard let encPub = m["encPub"]?.string else { throw PmError("a device in the record has no encryption key", code: "no-encpub") }
            wraps[pub] = try Crypto.wrapForMember(cek, memberEncPub: encPub)
        }
        return .object(wraps)
    }

    private func seal(_ cek: String, _ value: String) throws -> JSON { try Crypto.encryptWithCek(cek, gen: 0, value) }

    private func author(_ body: JSON, _ ts: Int64) throws -> JSON {
        ["pub": .string(identity.publickey), "sig": .string(try identity.sign(body)), "ts": .int(ts)]
    }

    /// Saves a NEW entry: encrypted, wrapped to whoever the record says, and signed. Returns its view.
    func put(_ plain: Entry) async throws -> EntryView {
        let k = try await keys()
        let t = now()
        var e = plain
        e.title = plain.title.trimmingCharacters(in: .whitespacesAndNewlines)
        e.name = plain.name.trimmingCharacters(in: .whitespacesAndNewlines)
        e.sites = Entry.normalizeSites(plain.sites)
        guard !e.id.isEmpty else { throw PmError("an entry needs an id", code: "bad-entry") }
        let cek = Crypto.makeContentKey()

        var fields: [String: JSON] = [:]
        for f in Entry.fixed where !e.fixedValue(f).isEmpty { fields[f] = try seal(cek, e.fixedValue(f)) }
        // The private mark belongs to the ENVELOPE, with its value: who opens it alone must know.
        for f in e.fields where !f.value.isEmpty { fields["f:" + PmKeys.fieldIndex(k.kidx, f.key)] = try seal(cek, f.json.text) }

        var view = EntryView(
            id: e.id, type: e.type, title: e.title, sites: e.sites, hint: e.who(),
            fieldKeys: e.fieldValues().map { $0.key }, privateKeys: e.privateKeys(),
            hasSecret: !e.secret.isEmpty, hasTotp: !e.totp.isEmpty, hasNotes: !e.notes.isEmpty,
            hasFields: !e.fields.isEmpty, hasWebauthn: false, webauthn: nil, updatedAt: t, digests: [:])
        var digests: [String: JSON] = [:]
        for (key, value) in e.digestValues() {
            let d = PmKeys.valueDigest(k.kcmp, id: e.id, field: key, value: value)
            let sk = try await sealedKey(key)
            digests[sk] = .string(d); view.digests[sk] = d
        }

        let idx = e.sites.map { PmKeys.siteIndex(k.kidx, $0) }
        let sealedView = try seal(cek, view.json.text)
        var priv: [String] = []
        for p in e.privateKeys() { priv.append(try await sealedKey(p)) }
        // Sorted as the JS sorts them: these are all ASCII, where every order agrees.
        let body: JSON = [
            "op": "pm.entry", "id": .string(e.id), "idx": Self.arr(idx.sorted()), "wa": .null,
            "view": .string(Self.ref(sealedView)),
            "fields": Self.arr(fields.keys.sorted().map { $0 + ":" + Self.ref(fields[$0]!) }),
            "digests": .object(digests), "ts": .int(t),
        ]
        let entry: JSON = [
            "id": .string(e.id), "createdAt": .int(e.createdAt > 0 ? e.createdAt : t), "updatedAt": .int(t),
            "idx": Self.arr(idx), "wa": .null, "view": sealedView,
            "fields": .object(fields), "digests": .object(digests), "priv": Self.arr(priv),
            "author": try author(body, t),
        ]
        let wraps = try await wrapAll(cek)
        _ = try await request("pm2.put", ["entry": entry, "main": ["wraps": wraps]])
        return view
    }

    /// CHANGES some fields without reading the rest. What does not come here stays in the
    /// vault as it was, unopened. The view is rebuilt with what is already known: the NAMES of
    /// the fields and which are private live in it.
    func patch(_ id: String, _ changes: Changes) async throws -> EntryView {
        let k = try await keys()
        guard let cur = try await list().first(where: { $0.id == id }) else { throw PmError("there is no entry with that id", code: "not-found") }
        let t = now()
        let cek = Crypto.makeContentKey()

        // sealed key -> (real name, sealed text, plain value): the digest is over the NAME and the VALUE.
        var values: [(sk: String, name: String, text: String, plain: String)] = []
        var drop: [String] = []
        var fieldKeys = cur.fieldKeys
        var privateKeys = cur.privateKeys
        var hasSecret = cur.hasSecret, hasTotp = cur.hasTotp, hasNotes = cur.hasNotes
        func addPrivate(_ key: String) { if !privateKeys.contains(key) { privateKeys.append(key) } }

        for f in Entry.fixed {
            guard let v = changes.fixed(f) else { continue }
            if !v.isEmpty {
                values.append((f, f, v, v))
                if f != "name" && f != "notes" && !fieldKeys.contains(f) { fieldKeys.append(f) }
            } else {
                drop.append(f); fieldKeys.removeAll { $0 == f }
            }
            if Entry.alwaysPrivate.contains(f) { if v.isEmpty { privateKeys.removeAll { $0 == f } } else { addPrivate(f) } }
            switch f {
            case "secret": hasSecret = !v.isEmpty
            case "totp": hasTotp = !v.isEmpty
            case "notes": hasNotes = !v.isEmpty
            default: break
            }
        }
        for f in changes.fields where !f.value.isEmpty {
            values.append((try await sealedKey(f.key), f.key, f.json.text, f.value))
            if f.isPrivate { addPrivate(f.key) } else { privateKeys.removeAll { $0 == f.key } }
            if !fieldKeys.contains(f.key) { fieldKeys.append(f.key) }
        }
        for key in changes.removeFields {
            drop.append(try await sealedKey(key))
            fieldKeys.removeAll { $0 == key }; privateKeys.removeAll { $0 == key }
        }

        let sites = changes.sites.map(Entry.normalizeSites)
        var view = cur
        view.title = changes.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? cur.title
        view.sites = sites ?? cur.sites
        view.hint = changes.hint ?? changes.name.flatMap { $0.isEmpty ? nil : $0 } ?? cur.hint
        view.fieldKeys = fieldKeys; view.privateKeys = privateKeys
        view.hasSecret = hasSecret; view.hasTotp = hasTotp; view.hasNotes = hasNotes
        view.hasFields = fieldKeys.contains { !Entry.fixed.contains($0) }
        view.updatedAt = t

        var fields: [String: JSON] = [:]
        var digests: [String: JSON] = [:]
        for v in values {
            fields[v.sk] = try seal(cek, v.text)
            digests[v.sk] = .string(PmKeys.valueDigest(k.kcmp, id: id, field: v.name, value: v.plain))
        }
        let sealedView = try seal(cek, view.json.text)
        var priv: [String] = []
        for p in view.privateKeys { priv.append(try await sealedKey(p)) }
        let idx = sites.map { $0.map { PmKeys.siteIndex(k.kidx, $0) } }
        let body: JSON = [
            "op": "pm.patch", "id": .string(id), "view": .string(Self.ref(sealedView)),
            "fields": Self.arr(fields.keys.sorted().map { $0 + ":" + Self.ref(fields[$0]!) }),
            "drop": Self.arr(drop.sorted()), "digests": .object(digests),
            "priv": Self.arr(priv.sorted()), "idx": idx.map { Self.arr($0.sorted()) } ?? .null, "wa": .null,
            "ts": .int(t),
        ]
        let wraps = try await wrapAll(cek)
        var payload: [String: JSON] = [
            "id": .string(id), "view": sealedView, "fields": .object(fields), "drop": Self.arr(drop),
            "digests": .object(digests), "priv": Self.arr(priv),
            "author": try author(body, t),
            "main": ["wraps": wraps],
        ]
        if let idx { payload["idx"] = Self.arr(idx) }
        _ = try await request("pm2.patch", .object(payload))
        return view
    }

    func remove(_ id: String) async throws { _ = try await request("pm2.remove", ["id": .string(id)]) }

    /// A value's digest, to say whether it is already saved the same without opening anything.
    func digest(_ id: String, _ key: String, _ value: String) async throws -> String {
        PmKeys.valueDigest(try await keys().kcmp, id: id, field: key, value: value)
    }
}
