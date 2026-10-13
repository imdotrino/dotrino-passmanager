import XCTest
@testable import Passmanager

final class CoreTests: XCTestCase {
    /// The SAME values `lib/src/sealed/keys.js` gives for this base key (and Android's CoreTest
    /// checks): if a fingerprint differs by a byte, the entry never shows up, without an error.
    func testTheProfileKeysAreTheOnesTheJsDerives() throws {
        let k = try PmKeys.profileKeys("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=")
        XCTAssertEqual(PmKeys.siteIndex(k.kidx, " Banco.COM "), "vnUYh29wD+hnT4FOvtNffw==")
        XCTAssertEqual(PmKeys.fieldIndex(k.kidx, "label:cédula"), "45Rne0EufT9JzCQ7ElUa9w==")
        XCTAssertEqual(PmKeys.valueDigest(k.kcmp, id: "e1", field: "secret", value: "la contraseña larga"), "ZMw1klXZu+JT19cjGKSP2w==")
    }

    /// RFC 6238, appendix B (SHA-1, 8 digits).
    func testTheTwoStepCodeIsTheStandardOne() throws {
        let uri = "otpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=8"
        XCTAssertEqual(try Totp.code(uri, nowMs: 59_000), "94287082")
        XCTAssertEqual(try Totp.code(uri, nowMs: 1_111_111_109_000), "07081804")
        XCTAssertEqual(try Totp.code("GEZD GNBV GY3T QOJQ", nowMs: 59_000).count, 6)
        XCTAssertEqual(try Totp.remaining(uri, nowMs: 59_000), 1)
    }

    func testAGeneratedPasswordHasOneOfEachAndNothingAmbiguous() {
        for _ in 0..<200 {
            let p = Generate.password(length: 20)
            XCTAssertEqual(p.count, 20)
            XCTAssertTrue(p.contains { $0.isLowercase } && p.contains { $0.isUppercase } && p.contains { $0.isNumber } && p.contains { !$0.isLetter && !$0.isNumber })
            XCTAssertFalse(p.contains { "lIO01".contains($0) })
        }
        XCTAssertTrue(Generate.password(length: 12, upper: false, digits: false, symbols: false).allSatisfy { $0.isLowercase })
    }

    func testAnEntrySaysWhatItIsCalledAndWhatIsPrivate() {
        let e = Entry(id: "e1", username: "ana", secret: "x", notes: "n",
                      fields: [Field(label: "correo", value: "a@b.c", kind: "email"), Field(label: "cédula", value: "17", isPrivate: true)])
        XCTAssertEqual(e.who(), "ana")
        XCTAssertEqual(e.fieldValues().map { $0.key }, ["username", "secret", "email", "label:cédula"])
        XCTAssertEqual(e.privateKeys(), ["secret", "notes", "label:cédula"])
        XCTAssertEqual(Entry(id: "e2", fields: e.fields).who(), "a@b.c")
        XCTAssertEqual(Entry.normalizeSites([" Banco.com ", "banco.com", ""]), ["banco.com"])
    }
}
