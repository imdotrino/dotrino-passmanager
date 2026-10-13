import CryptoKit
import DotrinoNative
import XCTest
@testable import Passmanager

/// AGAINST A REAL PROXY AND A REAL VAULT (`test/e2e-native.mjs`): the whole road the app
/// takes, with the device's keys in software instead of the Secure Enclave. The twin of
/// Android's `VaultE2eTest`.
///
/// It only runs when the harness is up and reachable from the simulator:
///
///   E2E_HOST=<this Mac's or the Linux box's LAN address> node test/e2e-native.mjs /tmp/pm.json
///   TEST_RUNNER_PM_E2E="$(cat /tmp/pm.json)" xcodebuild … test
final class VaultE2eTests: XCTestCase {
    private struct SoftKeys: DeviceKeys {
        let publickey: String, encPub: String
        let s: P256.Signing.PrivateKey, e: P256.KeyAgreement.PrivateKey

        private static func scalar(_ jwk: JSON) throws -> Data {
            var t = (jwk["d"]?.string ?? "").replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
            while t.count % 4 != 0 { t += "=" }
            guard let d = Data(base64Encoded: t) else { throw PmError("bad private jwk", code: "bad-test-key") }
            return d
        }

        init(sign: JSON, enc: JSON, publickey: String, encPub: String) throws {
            s = try P256.Signing.PrivateKey(rawRepresentation: Self.scalar(sign))
            e = try P256.KeyAgreement.PrivateKey(rawRepresentation: Self.scalar(enc))
            // The public keys exactly as the pilar wrote them: the record and the paper compare them as text.
            self.publickey = publickey; self.encPub = encPub
        }

        func signBytes(_ bytes: Data) throws -> String { Crypto.b64(try s.signature(for: bytes).rawRepresentation) }
        func agree(_ peer: P256.KeyAgreement.PublicKey) throws -> Data {
            try e.sharedSecretFromKeyAgreement(with: peer).withUnsafeBytes { Data($0) }
        }
    }

    private struct Identity: PmIdentity, @unchecked Sendable {
        let profile: Profile
        var publickey: String { profile.publickey }
        func sign(_ body: JSON) throws -> String { try profile.signData(body) }
        func openSealed(wrap: JSON, envelope: JSON) throws -> String { try profile.openSealed(wrap: wrap, envelope: envelope) }
    }

    func testTheAppsRoadWorksAgainstTheRealVault() async throws {
        guard let raw = ProcessInfo.processInfo.environment["PM_E2E"], !raw.isEmpty else {
            throw XCTSkip("PM_E2E not set: start test/e2e-native.mjs and pass its output (see this file's header)")
        }
        let f = try JSON.parse(raw)
        func s(_ k: String) throws -> String {
            guard let v = f[k]?.string else { throw PmError("the harness output has no \(k)", code: "bad-harness") }
            return v
        }
        guard let signJwk = f["privateJwk"], let encJwk = f["encPrivateJwk"], let cert = f["cert"] else {
            throw PmError("the harness output is incomplete", code: "bad-harness")
        }
        let keys = try SoftKeys(sign: signJwk, enc: encJwk, publickey: try s("publickey"), encPub: try s("encPub"))
        let link = Profile.VaultLink(master: try s("master"), proxy: try s("proxyUrl"), cert: cert, deviceId: try s("deviceId"))
        var p = Profile.of(keys, acta: nil, vault: link)

        let conn = try ProxyConnection(link.proxy)
        _ = try await conn.connect()
        let me = p
        try await conn.identifyAs(me.publickey, sign: { try me.signData($0) })
        p = try await ActaSync.update(p, conn, save: { _, _ in })
        conn.close()
        XCTAssertTrue(p.can("passwords"), "the record came from the vault and gives this device passwords")
        let vaultEncPub = try XCTUnwrap(p.vaultEncPub)

        let session = SealedSession(urls: [link.proxy], profile: p, app: "passmanager")
        session.start()
        let transport = PmSession(session: session, vaultPubkey: link.master, vaultEncPub: vaultEncPub)
        defer { transport.close(); session.close() }
        let vault = PmVault(transport: transport, identity: Identity(profile: p))

        let empty = try await vault.list()
        XCTAssertTrue(empty.isEmpty)
        _ = try await vault.put(Entry(id: "e1", title: "banco.com", name: "Banco", sites: ["banco.com"], username: "ana", secret: "s3creta",
                                      fields: [Field(label: "cédula", value: "1712345678", isPrivate: true)]))
        let views = try await vault.list()
        XCTAssertEqual(views.count, 1)
        XCTAssertEqual(views.first?.hint, "Banco")
        XCTAssertEqual(views.first?.sites, ["banco.com"])
        let found = try await vault.search("banc")
        XCTAssertEqual(found.count, 1)

        // Nobody in this record approves, so a private value is handed over (the owner's rule).
        let e = try await vault.get("e1", keys: ["secret", "label:cédula"])
        XCTAssertEqual(e.secret, "s3creta")
        XCTAssertEqual(e.fields.first?.value, "1712345678")

        _ = try await vault.patch("e1", Changes(username: "", secret: "otra", hint: "Banco"))
        let after = try await vault.get("e1")
        XCTAssertEqual(after.secret, "otra")
        XCTAssertEqual(after.username, "")
        XCTAssertEqual(after.name, "Banco")
        let keysAfter = try await vault.list().first?.fieldKeys
        XCTAssertEqual(keysAfter, ["secret", "label:cédula"])

        try await vault.remove("e1")
        let gone = try await vault.list()
        XCTAssertTrue(gone.isEmpty)
    }
}
