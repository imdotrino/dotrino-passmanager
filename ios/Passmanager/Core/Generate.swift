import Foundation
import Security

/// The password generator — `lib/src/generate.js`. Same alphabets, same rules.
enum Generate {
    private static let lower = Array("abcdefghijkmnopqrstuvwxyz")   // no «l»
    private static let upper = Array("ABCDEFGHJKLMNPQRSTUVWXYZ")    // no «I» nor «O»
    private static let digits = Array("23456789")                   // no zero nor one
    private static let symbols = Array("!#$%&*+-=?@_")

    /// An integer in [0, max) without bias.
    private static func below(_ max: Int) -> Int {
        let limit = (256 / max) * max
        while true {
            var b: UInt8 = 0
            guard SecRandomCopyBytes(kSecRandomDefault, 1, &b) == errSecSuccess else { continue }
            if Int(b) < limit { return Int(b) % max }
        }
    }

    static func password(length: Int = 20, upper useUpper: Bool = true, digits useDigits: Bool = true, symbols useSymbols: Bool = true, ambiguous: Bool = false) -> String {
        var groups: [[Character]] = [ambiguous ? lower + ["l"] : lower]
        if useUpper { groups.append(ambiguous ? upper + ["I", "O"] : upper) }
        if useDigits { groups.append(ambiguous ? digits + ["0", "1"] : digits) }
        if useSymbols { groups.append(symbols) }
        let alphabet = groups.flatMap { $0 }
        let size = max(max(groups.count, 4), min(256, length))
        // One of each group for sure, then shuffled so they are not at the start.
        var chars = groups.map { $0[below($0.count)] }
        while chars.count < size { chars.append(alphabet[below(alphabet.count)]) }
        var i = chars.count - 1
        while i > 0 { chars.swapAt(i, below(i + 1)); i -= 1 }
        return String(chars)
    }
}
