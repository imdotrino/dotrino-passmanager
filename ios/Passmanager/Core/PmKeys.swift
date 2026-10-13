import CryptoKit
import Foundation

/// What went wrong, with the code the other side sent — the screen turns it into words.
struct PmError: Error, CustomStringConvertible {
    let description: String
    let code: String
    init(_ d: String, code: String) { description = d; self.code = code }
}

/// The profile's password key and the two that come out of it — `lib/src/sealed/keys.js`.
///
/// `kidx` is the site index (the vault searches by fingerprints, not by domains) and `kcmp`
/// compares a value without opening it. Two keys and not one so that one use cannot stand in
/// for the other: they come from HKDF with different labels.
struct ProfileKeys {
    let kidx: SymmetricKey
    let kcmp: SymmetricKey
}

enum PmKeys {
    private static func hmac(_ key: SymmetricKey, _ data: Data) -> Data {
        Data(HMAC<SHA256>.authenticationCode(for: data, using: key))
    }

    /// HKDF-SHA256 with an empty salt and one block of output: what WebCrypto's `deriveKey`
    /// to a 256-bit HMAC key gives.
    private static func derive(_ base: Data, _ use: String) -> SymmetricKey {
        let prk = hmac(SymmetricKey(data: Data(count: 32)), base)
        return SymmetricKey(data: hmac(SymmetricKey(data: prk), Data(("dotrino-passmanager/v2/" + use).utf8) + Data([1])))
    }

    static func profileKeys(_ base: String) throws -> ProfileKeys {
        guard !base.isEmpty, let raw = Data(base64Encoded: base) else { throw PmError("missing the profile password key", code: "no-profile-key") }
        return ProfileKeys(kidx: derive(raw, "idx"), kcmp: derive(raw, "cmp"))
    }

    /// 128 bits of the HMAC, base64: enough not to collide, half the bytes.
    private static func hmac16(_ key: SymmetricKey, _ text: String) -> String {
        hmac(key, Data(text.utf8)).prefix(16).base64EncodedString()
    }

    /// A site's fingerprint. Normalised HERE and only here: a differing case is an entry that never shows up.
    static func siteIndex(_ kidx: SymmetricKey, _ site: String) -> String {
        hmac16(kidx, "site " + site.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())
    }

    /// The fingerprint of a free field's NAME: the vault matches keys without reading «cédula».
    static func fieldIndex(_ kidx: SymmetricKey, _ key: String) -> String { hmac16(kidx, "field " + key) }

    /// A value's digest. The entry id and the field name go INSIDE: the same value twice gives two digests.
    static func valueDigest(_ kcmp: SymmetricKey, id: String, field: String, value: String) -> String {
        hmac16(kcmp, "\(id) \(field) \(value)")
    }
}
