import CryptoKit
import Foundation

/// The two-step code — `lib/src/totp.js`. Takes an `otpauth://` URI or a bare base32 secret.
enum Totp {
    private static let b32 = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")

    struct Params { let secret: String; let digits: Int; let period: Int; let algorithm: String }

    static func base32(_ input: String) throws -> Data {
        var s = input.uppercased().filter { !$0.isWhitespace }
        while s.hasSuffix("=") { s.removeLast() }
        var bits = 0, value = 0
        var out = Data()
        for ch in s {
            guard let idx = b32.firstIndex(of: ch) else { throw PmError("base32: invalid character", code: "bad-totp") }
            value = ((value << 5) | idx) & 0xFFFF
            bits += 5
            if bits >= 8 { bits -= 8; out.append(UInt8((value >> bits) & 0xff)) }
        }
        return out
    }

    static func parse(_ input: String) throws -> Params {
        let s = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard s.lowercased().hasPrefix("otpauth://") else { return Params(secret: s.filter { !$0.isWhitespace }, digits: 6, period: 30, algorithm: "SHA1") }
        guard let u = URLComponents(string: s) else { throw PmError("otpauth: not a valid address", code: "bad-totp") }
        guard u.host?.lowercased() == "totp" else { throw PmError("otpauth: unsupported type", code: "bad-totp") }
        var q: [String: String] = [:]
        for item in u.queryItems ?? [] { if let v = item.value { q[item.name] = v } }
        guard let secret = q["secret"], !secret.isEmpty else { throw PmError("otpauth: missing secret", code: "bad-totp") }
        let digits = q["digits"].flatMap { Int($0) }.flatMap { (6...10).contains($0) ? $0 : nil } ?? 6
        let period = q["period"].flatMap { Int($0) }.flatMap { (1...300).contains($0) ? $0 : nil } ?? 30
        return Params(secret: secret, digits: digits, period: period, algorithm: (q["algorithm"] ?? "SHA1").uppercased())
    }

    /// The code valid at [nowMs].
    static func code(_ input: String, nowMs: Int64 = Int64(Date().timeIntervalSince1970 * 1000)) throws -> String {
        let p = try parse(input)
        let key = SymmetricKey(data: try base32(p.secret))
        var counter = UInt64(nowMs / 1000 / Int64(p.period)).bigEndian
        let msg = Data(bytes: &counter, count: 8)
        let mac: [UInt8]
        switch p.algorithm {
        case "SHA1": mac = Array(HMAC<Insecure.SHA1>.authenticationCode(for: msg, using: key))
        case "SHA256": mac = Array(HMAC<SHA256>.authenticationCode(for: msg, using: key))
        case "SHA512": mac = Array(HMAC<SHA512>.authenticationCode(for: msg, using: key))
        default: throw PmError("otp: unsupported algorithm: \(p.algorithm)", code: "bad-totp")
        }
        let off = Int(mac[mac.count - 1] & 0x0f)
        let bin = (UInt32(mac[off] & 0x7f) << 24) | (UInt32(mac[off + 1]) << 16) | (UInt32(mac[off + 2]) << 8) | UInt32(mac[off + 3])
        var mod: UInt64 = 1
        for _ in 0..<p.digits { mod *= 10 }
        let text = String(UInt64(bin) % mod)
        return String(repeating: "0", count: max(0, p.digits - text.count)) + text
    }

    /// Seconds left before the code changes.
    static func remaining(_ input: String, nowMs: Int64 = Int64(Date().timeIntervalSince1970 * 1000)) throws -> Int {
        let period = try parse(input).period
        return period - Int((nowMs / 1000) % Int64(period))
    }
}
