import DotrinoNative
import Foundation

/// The transport of the side that ASKS — `lib/src/transport/proxy.js`. Requests go SEALED to
/// the vault by its key (so the proxy's offline queue applies), and no answer is taken unless
/// it was sealed by the vault's own encryption key: anybody can answer in the clear, and
/// although they could not read what was asked, they could slip a forged credential in.
final class PmSession: PmTransport, @unchecked Sendable {
    static let type = "dotrino.passmanager/1"
    static let reply = "dotrino.passmanager.reply/1"

    private let session: SealedSession
    private let vaultPubkey: String
    private let vaultEncPub: String
    /// Generous on purpose: at the other end somebody may be approving on another device.
    private let timeout: TimeInterval
    private let lock = NSLock()
    private var pending: [String: CheckedContinuation<JSON, Error>] = [:]
    private var stop: (() -> Void)?

    init(session: SealedSession, vaultPubkey: String, vaultEncPub: String, timeout: TimeInterval = 90) {
        self.session = session; self.vaultPubkey = vaultPubkey; self.vaultEncPub = vaultEncPub; self.timeout = timeout
        stop = session.onMessage { [weak self] m in self?.incoming(m) }
    }

    private func take(_ rid: String) -> CheckedContinuation<JSON, Error>? {
        lock.lock(); defer { lock.unlock() }
        return pending.removeValue(forKey: rid)
    }

    private func incoming(_ m: SealedSession.Message) {
        let p = m.payload
        guard p["type"]?.string == Self.reply, let rid = p["rid"]?.string else { return }
        guard let waiting = take(rid) else { return }   // an answer to something that already expired
        if m.senderEncPub != vaultEncPub {
            waiting.resume(throwing: PmError("that answer was not sealed by your vault", code: "unsealed"))
        } else if let e = p["error"]?.objectValue {
            waiting.resume(throwing: PmError(e["message"]?.string ?? "error", code: e["code"]?.string ?? "unknown"))
        } else {
            waiting.resume(returning: p["result"] ?? .null)
        }
    }

    func request(_ op: String, _ payload: JSON) async throws -> JSON {
        guard await session.awaitOnline() else { throw PmError("no connection to reach your vault", code: "unreachable") }
        let rid = UUID().uuidString
        return try await withCheckedThrowingContinuation { (c: CheckedContinuation<JSON, Error>) in
            lock.lock(); pending[rid] = c; lock.unlock()
            Task {
                do {
                    try await session.sendSealed(toPubkey: vaultPubkey, ["type": .string(Self.type), "rid": .string(rid), "op": .string(op), "payload": payload],
                                                 recipientEncPubs: [vaultEncPub])
                } catch let e as SealedSession.SessionError {
                    // The code is KEPT: «I lack the other side's key» and «the network dropped» are fixed differently.
                    self.take(rid)?.resume(throwing: PmError(e.description, code: e.code))
                    return
                } catch {
                    self.take(rid)?.resume(throwing: PmError("\(error)", code: "unreachable"))
                    return
                }
                try? await Task.sleep(nanoseconds: UInt64(self.timeout * 1_000_000_000))
                // Not «nobody is there»: nobody ANSWERED. Usually an approval nobody looked at.
                self.take(rid)?.resume(throwing: PmError("nobody answered in time", code: "approval-timeout"))
            }
        }
    }

    func close() {
        stop?(); stop = nil
        lock.lock(); let all = pending; pending = [:]; lock.unlock()
        for c in all.values { c.resume(throwing: PmError("transport closed", code: "unreachable")) }
    }
}
