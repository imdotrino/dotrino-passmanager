import DotrinoNative
import Foundation

/// A free field of an entry — `lib/src/fields.js`. `isPrivate` = it only leaves the vault with a confirmation.
struct Field: Equatable {
    var label: String
    var value: String
    var kind: String? = nil
    var isPrivate = false

    static let kinds = [
        "email", "tel", "given-name", "family-name", "full-name", "street-address", "city", "region",
        "postal-code", "country", "organization", "birthday", "id-number", "other",
    ]

    /// What makes two fields «the same»: the kind when known, else the label the user gave it.
    var key: String {
        if let kind { return kind }
        let l = label.trimmingCharacters(in: .whitespacesAndNewlines)
        return l.isEmpty ? "other" : "label:" + l
    }

    /// As the JS writes it inside its envelope (`JSON.stringify` of the normalised field).
    var json: JSON {
        var o: [String: JSON] = ["label": .string(label), "value": .string(value)]
        if let kind { o["kind"] = .string(kind) }
        if isPrivate { o["private"] = .bool(true) }
        return .object(o)
    }

    init(label: String, value: String, kind: String? = nil, isPrivate: Bool = false) {
        self.label = label; self.value = value; self.kind = kind; self.isPrivate = isPrivate
    }

    init?(_ o: JSON) {
        let label = (o["label"]?.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let value = o["value"]?.string ?? ""
        if label.isEmpty && value.isEmpty { return nil }
        let kind = o["kind"]?.string
        self.init(label: label, value: value, kind: kind.flatMap { Field.kinds.contains($0) ? $0 : nil }, isPrivate: o["private"]?.bool == true)
    }
}

/// An entry in the clear — the shape of `newEntry` in `lib/src/model.js`. Only ever in memory.
struct Entry {
    var id: String
    var type = "login"
    var title = ""
    var name = ""
    var sites: [String] = []
    var username = ""
    var secret = ""
    var totp = ""
    var notes = ""
    var fields: [Field] = []
    var createdAt: Int64 = 0
    var updatedAt: Int64 = 0
    /// What stayed behind: not asked for, or this device cannot open it (a passkey without the permission).
    var withheld: [String] = []

    static let fixed = ["name", "username", "secret", "totp", "notes"]
    /// Private for what they are, not for a mark. The username is not here on purpose: it is the entry's visible name.
    static let alwaysPrivate = ["secret", "totp", "notes"]

    static func normalizeSites(_ sites: [String]) -> [String] {
        var out: [String] = []
        for s in sites {
            let v = s.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if !v.isEmpty && !out.contains(v) { out.append(v) }
        }
        return out
    }

    func fixedValue(_ k: String) -> String {
        switch k {
        case "name": return name
        case "username": return username
        case "secret": return secret
        case "totp": return totp
        case "notes": return notes
        default: return ""
        }
    }

    /// Every field that can be filled, as `(key, value)`, no public/private distinction (`entryFieldValues`).
    func fieldValues() -> [(key: String, value: String)] {
        var out: [(key: String, value: String)] = []
        func add(_ k: String, _ v: String) { if !v.isEmpty && !out.contains(where: { $0.key == k }) { out.append((k, v)) } }
        add("username", username); add("secret", secret); add("totp", totp)
        for f in fields { add(f.key, f.value) }
        return out
    }

    /// The same plus the notes: only for the digests (`entryDigestValues`).
    func digestValues() -> [(key: String, value: String)] {
        var out = fieldValues()
        if !notes.isEmpty && !out.contains(where: { $0.key == "notes" }) { out.append(("notes", notes)) }
        return out
    }

    func privateKeys() -> [String] {
        var out: [String] = []
        func add(_ k: String) { if !out.contains(k) { out.append(k) } }
        if !secret.isEmpty { add("secret") }
        if !totp.isEmpty { add("totp") }
        if !notes.isEmpty { add("notes") }
        for f in fields where f.isPrivate && !f.value.isEmpty { add(f.key) }
        return out
    }

    /// What the entry is called for whoever has to choose: the user's name for it, else its
    /// clearest public datum (`entryWho`).
    func who() -> String {
        if !name.isEmpty { return name }
        if !username.isEmpty { return username }
        let pub = fields.filter { !$0.isPrivate && !$0.value.isEmpty }
        return (pub.first { $0.kind == "email" } ?? pub.first)?.value ?? ""
    }
}

/// What whoever can open the entry sees without asking for any value: names, never values.
struct EntryView: Identifiable, Equatable {
    var id: String
    var type: String
    var title: String
    var sites: [String]
    var hint: String
    var fieldKeys: [String]
    var privateKeys: [String]
    var hasSecret: Bool
    var hasTotp: Bool
    var hasNotes: Bool
    var hasFields: Bool
    var hasWebauthn: Bool
    var webauthn: JSON?
    var updatedAt: Int64
    /// The digests as the vault keeps them (free fields keyed by fingerprint).
    var digests: [String: String]

    /// The sealed view's JSON, as the JS writes it.
    var json: JSON {
        var o: [String: JSON] = [
            "type": .string(type), "title": .string(title),
            "sites": .array(sites.map { .string($0) }), "hint": .string(hint),
            "fieldKeys": .array(fieldKeys.map { .string($0) }), "privateKeys": .array(privateKeys.map { .string($0) }),
            "has": .object(["secret": .bool(hasSecret), "totp": .bool(hasTotp), "notes": .bool(hasNotes), "fields": .bool(hasFields), "webauthn": .bool(hasWebauthn)]),
        ]
        if let webauthn { o["webauthn"] = webauthn }
        return .object(o)
    }

    /// What a text search looks at: the title, the visible name and the sites. Never a value.
    func matches(_ term: String) -> Bool { ([title, hint] + sites).joined(separator: " ").lowercased().contains(term) }
}
