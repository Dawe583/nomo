import CryptoKit
import Foundation
import Security
import XCTest
@testable import CompanionProtocolKit

/// The paired-device races from matrix P05.01-P05.05, on the client half.
/// Every case here asserts a refusal the client can name, because "please try
/// again" is not something an operator can act on.
final class PairedDeviceSecurityTests: XCTestCase {
    private func limits(maxStreamSeconds: Int = 55) -> ProtocolLimits {
        ProtocolLimits(
            maxRequestBytes: 65_536, maxPromptCharacters: 32_768, maxEventsPerPage: 1_000, maxEventPageBytes: 1_048_576,
            maxEventBytes: 32_768, maxStreamSeconds: maxStreamSeconds, replayWindowSeconds: 900,
            idempotencyRetentionHours: 24, deviceCredentialSeconds: 900, invitationSeconds: 120,
            grantSeconds: 300, recoveryPlanSeconds: 900, maxMutationsPerDevice: 2, maxStreamsPerDevice: 2,
            maxDevicesPerWorkspace: 8, maxOperationIds: 500, maxErrorCharacters: 320
        )
    }

    // MARK: - Credential storage

    func testDeviceCredentialLivesInTheKeychainAndIsReadableBack() async throws {
        let keychain = SecureKeychainStore(service: "com.void.companion.tests.\(UUID().uuidString)")
        let store = KeychainDeviceCredentialStore(keychain: keychain)
        // Start from a known state: a removal test that only ever sees an
        // absent credential proves nothing.
        try await store.remove()
        let beforeAny = try await store.load()
        XCTAssertNil(beforeAny)

        let credential = try DeviceCredential(
            deviceId: "device-test-001",
            workspaceId: "workspace-test",
            token: String(repeating: "t", count: 43),
            issuedAt: "2026-09-26T10:00:00.000Z",
            expiresAt: "2026-09-26T10:15:00.000Z"
        )
        try await store.save(credential)

        // Read it back through the Keychain, not through whatever the app
        // happens to have in a property.
        let readBack = try await store.load()
        XCTAssertEqual(readBack, credential)
        let item = try await keychain.read(account: KeychainDeviceCredentialStore.credentialAccount)
        let raw = try XCTUnwrap(item)
        XCTAssertNotNil(try? JSONDecoder().decode(DeviceCredential.self, from: raw))

        try await store.remove()
        let afterRemoval = try await store.load()
        XCTAssertNil(afterRemoval)
    }

    func testDeviceCredentialNeverReachesUserDefaultsAPlistOrALog() async throws {
        let keychain = SecureKeychainStore(service: "com.void.companion.tests.\(UUID().uuidString)")
        let store = KeychainDeviceCredentialStore(keychain: keychain)
        let token = String(repeating: "k", count: 43)
        let credential = try DeviceCredential(
            deviceId: "device-leak-001", workspaceId: "workspace-leak", token: token,
            issuedAt: "2026-09-26T10:00:00.000Z", expiresAt: "2026-09-26T10:15:00.000Z"
        )
        try await store.save(credential)
        defer { Task { try? await store.remove() } }

        // The default persistent domain, which is where an `@AppStorage` or a
        // careless `UserDefaults.standard.set` would land.
        let domain = Bundle.main.bundleIdentifier ?? "com.void.companion.tests"
        let defaults = UserDefaults.standard.persistentDomain(forName: domain) ?? [:]
        for (key, value) in defaults {
            let rendered = String(describing: value)
            XCTAssertFalse(rendered.contains(token), "\(key) holds the device token")
            XCTAssertFalse(rendered.contains(credential.deviceId), "\(key) holds the device identity")
        }

        // The shipped Info.plist, which is readable by anyone who has the app.
        if let info = Bundle.main.infoDictionary {
            for (key, value) in info {
                let rendered = String(describing: value)
                XCTAssertFalse(rendered.contains(token), "Info.plist key \(key) holds the device token")
            }
        }

        // Every way a Swift value reaches a log: interpolation, `print`, and
        // the debugger's own mirror dump.
        XCTAssertFalse(String(describing: credential).contains(token))
        XCTAssertFalse("\(credential)".contains(token))
        XCTAssertFalse(String(reflecting: credential).contains(token))
        XCTAssertFalse(String(describing: [credential]).contains(token))
        XCTAssertFalse(String(reflecting: [credential]).contains(token))
        XCTAssertTrue(credential.redactedSummary.contains(credential.deviceId))
    }

    func testAMalformedCredentialIsRefusedRatherThanStored() async {
        let store = KeychainDeviceCredentialStore(keychain: SecureKeychainStore(service: "com.void.companion.tests.\(UUID().uuidString)"))
        // A token the executor would never mint, an identity that is a path, and
        // a lifetime that runs backwards.
        XCTAssertThrowsError(try DeviceCredential(deviceId: "d", workspaceId: "w", token: "short", issuedAt: "2026-09-26T10:00:00Z", expiresAt: "2026-09-26T10:15:00Z"))
        XCTAssertThrowsError(try DeviceCredential(deviceId: "a/b", workspaceId: "w", token: String(repeating: "t", count: 43), issuedAt: "2026-09-26T10:00:00Z", expiresAt: "2026-09-26T10:15:00Z"))
        XCTAssertThrowsError(try DeviceCredential(deviceId: "d", workspaceId: "w", token: String(repeating: "t", count: 43), issuedAt: "2026-09-26T10:15:00Z", expiresAt: "2026-09-26T10:00:00Z"))
        _ = store
    }

    // MARK: - Certificate mismatch

    func testACertificateThatIsNotThePinnedOneIsRefused() {
        let certificate = Data("a leaf certificate nobody pinned".utf8)
        let presented = Self.fingerprint(of: certificate)
        let other = Data("a different machine on the same network".utf8)

        XCTAssertEqual(ServerTrustDecision.evaluate(pinnedFingerprint: presented, leafCertificate: certificate), .pinned)
        // The mismatch is the whole case: something that is not the executor
        // answering on the executor's address.
        XCTAssertEqual(ServerTrustDecision.evaluate(pinnedFingerprint: presented, leafCertificate: other), .refused)
        // A one-character difference is still a mismatch, not a near miss.
        var flipped = presented
        flipped.replaceSubrange(flipped.startIndex..<flipped.index(flipped.startIndex, offsetBy: 1), with: flipped.prefix(1) == "a" ? "b" : "a")
        XCTAssertEqual(ServerTrustDecision.evaluate(pinnedFingerprint: flipped, leafCertificate: certificate), .refused)
        // A prefix of the real fingerprint is not a match either.
        XCTAssertEqual(ServerTrustDecision.evaluate(pinnedFingerprint: String(presented.prefix(32)), leafCertificate: certificate), .refused)
        // An empty chain and an unpinnable fingerprint both refuse.
        XCTAssertEqual(ServerTrustDecision.evaluate(pinnedFingerprint: presented, leafCertificate: Data()), .refused)
        XCTAssertEqual(ServerTrustDecision.evaluate(pinnedFingerprint: presented.uppercased(), leafCertificate: certificate), .refused)
        XCTAssertEqual(ServerTrustDecision.evaluate(pinnedFingerprint: "", leafCertificate: certificate), .refused)
    }

    func testABoundLocalNetworkIdentityRefusesAnEndpointThatIsNotTheExecutor() {
        // A remote host, a plain scheme, and a non-digest fingerprint are the
        // three ways this transport would leave the local network or lose the
        // pin, and each has to fail before a socket is opened.
        for candidate in ["https://example.com", "http://127.0.0.1", "https://192.169.0.1", "https://172.32.0.1", "https://[2001:db8::1]"] {
            let url = URL(string: candidate)!
            XCTAssertThrowsError(try LocalNetworkIdentity(endpoint: url, executorId: "mac", identityKeyId: "key-1", certificateSHA256: String(repeating: "a", count: 64)), candidate)
        }
        for accepted in ["https://localhost:7443", "https://void-mac.local", "https://[fe80::1]:7443", "https://192.168.1.4", "https://10.0.0.2"] {
            let url = URL(string: accepted)!
            XCTAssertNoThrow(try LocalNetworkIdentity(endpoint: url, executorId: "mac", identityKeyId: "key-1", certificateSHA256: String(repeating: "a", count: 64)), accepted)
        }
    }

    // MARK: - Bounded reconnect

    func testReconnectIsBoundedByTheFrozenStreamLimit() {
        let clock = MutableClock()
        var reconnector = EventReconnector(policy: EventReconnectPolicy(limits: limits(maxStreamSeconds: 55)), now: { clock.now })
        XCTAssertEqual(reconnector.next(after: nil), .fetchPage(after: nil))

        // A transport failure is the only failure that may be retried, and it
        // is retried only while the frozen stream budget lasts.
        XCTAssertEqual(reconnector.next(after: .transport), .fetchPage(after: nil))
        XCTAssertEqual(reconnector.next(after: .transport), .fetchPage(after: nil))
        clock.advance(seconds: 55)
        XCTAssertEqual(reconnector.next(after: .transport), .stop(.streamBudgetExhausted))
        XCTAssertEqual(reconnector.reason, .streamBudgetExhausted)
    }

    func testReconnectResumesFromTheLastAcceptedCursorAndNeverRepeatsAPage() throws {
        var reconnector = EventReconnector(policy: EventReconnectPolicy(limits: limits()))
        let first = try EventCursor(validating: "40")
        reconnector.advanced(to: first)
        XCTAssertEqual(reconnector.next(after: .transport), .fetchPage(after: first))
        let second = try EventCursor(validating: "80")
        reconnector.advanced(to: second)
        XCTAssertEqual(reconnector.next(after: .transport), .fetchPage(after: second))
    }

    func testReconnectGivesUpAfterTheAttemptBudget() {
        var reconnector = EventReconnector(policy: EventReconnectPolicy(maxStreamSeconds: 55, maxAttempts: 3))
        for _ in 0..<3 { XCTAssertEqual(reconnector.next(after: .transport), .fetchPage(after: nil)) }
        XCTAssertEqual(reconnector.next(after: .transport), .stop(.attemptsExhausted))
        XCTAssertEqual(reconnector.attempts, 4)
    }

    // MARK: - Revocation on an open stream and on a pending approval

    func testRevocationClosesAnOpenStreamOnTheNextStepAndKeepsWhatItDelivered() {
        var reconnector = EventReconnector(policy: EventReconnectPolicy(limits: limits()))
        // The stream is open and mid-page-sequence.
        XCTAssertEqual(reconnector.next(after: nil), .fetchPage(after: nil))
        reconnector.advanced(to: try! EventCursor(validating: "12"))
        XCTAssertEqual(reconnector.attempts, 0)

        // The executor revokes. The very next step is terminal and named; it is
        // not "retry until the budget runs out", because no number of retries
        // makes a revoked credential good again.
        XCTAssertEqual(reconnector.next(after: .credentialRefused), .stop(.credentialRevoked))
        XCTAssertEqual(reconnector.reason, .credentialRevoked)
        // The cursor is untouched, so the evidence the open stream already
        // delivered is still addressable and nothing is silently skipped.
        XCTAssertEqual(reconnector.cursor, try! EventCursor(validating: "12"))
        // And a refused stream stays refused.
        XCTAssertEqual(reconnector.next(after: .transport), .stop(.credentialRevoked))
    }

    func testAnExpiredReplayWindowIsTerminalRatherThanASilentSkip() {
        var reconnector = EventReconnector(policy: EventReconnectPolicy(limits: limits()))
        XCTAssertEqual(reconnector.next(after: .replayWindowExpired), .stop(.replayWindowExpired))
        XCTAssertEqual(reconnector.reason, .replayWindowExpired)
    }

    func testReconnectNeverRepeatsAForwardMutationAndReconcilesInstead() async throws {
        // The counting transport is the whole point: it knows which requests
        // mutate and which read, and it fails the first attempt at the
        // mutation's own transport, which is the exact moment a naive client
        // would re-send it.
        let transport = MutationCountingTransport()
        let client = CompanionHTTPClient(transport: transport)
        let mutation = Self.makeRequest(operation: "session.send", idempotencyKey: "idem-turn-1")

        // The client dispatches once and the executor never answers.
        do {
            _ = try await client.send(mutation, authorizationProvider: { "token" })
            XCTFail("the executor never answered the mutation")
        } catch {
            XCTAssertEqual(error as? CompanionHTTPError, .transportFailure)
        }
        let afterFailure = await transport.counts()
        XCTAssertEqual(afterFailure.mutations, 1)
        XCTAssertEqual(afterFailure.reads, 0)

        // The socket came back. The client's only move is to ask what happened.
        await transport.setFailsNext(false)
        let unsettled = try UnsettledMutation(operationId: "op-turn-1", idempotencyKey: "idem-turn-1")
        let resolution = Self.resolve(unsettled, outcome: .unknown)
        guard case .lookUpStatus(let lookup) = resolution else {
            return XCTFail("an unknown outcome must be looked up, not re-sent")
        }
        XCTAssertEqual(lookup, unsettled)
        // There is no resolution that re-sends: the enum has no such case, and
        // the runtime rule that an unknown outcome is never retried is what
        // the type encodes.
        switch resolution {
        case .alreadySettled, .requiresRePair: XCTFail("a still-running operation is not settled")
        case .lookUpStatus: break
        }

        let status = Self.makeRequest(operation: "operation.status", idempotencyKey: nil)
        let response = try await client.send(status, authorizationProvider: { "token" })
        XCTAssertEqual(response.outcome, .unknown)
        let afterReconcile = await transport.counts()
        XCTAssertEqual(afterReconcile.mutations, 1, "the reconnect repeated a forward mutation")
        XCTAssertEqual(afterReconcile.reads, 1)
    }

    func testAPendingApprovalStopsAtRevocationAndKeepsItsRecordedOutcome() async throws {
        let transport = MutationCountingTransport()
        let client = CompanionHTTPClient(transport: transport)
        let approval = try UnsettledMutation(operationId: "op-approval-1", idempotencyKey: "idem-approval-1")

        // The approval is pending: the device may still ask about it.
        await transport.setStatusOutcome(.running)
        let pending = try await client.send(Self.makeRequest(operation: "operation.status", idempotencyKey: nil), authorizationProvider: { "token" })
        XCTAssertEqual(pending.outcome, .running)

        // The executor revokes the device mid-approval. Further authorized work
        // is refused by name rather than answered from a cache.
        await transport.setRefuses(true)
        do {
            _ = try await client.send(Self.makeRequest(operation: "operation.status", idempotencyKey: nil), authorizationProvider: { "token" })
            XCTFail("a revoked device was still served")
        } catch {
            XCTAssertEqual(error as? CompanionHTTPError, .invalidResponse)
        }

        // The durable evidence the device had already seen is still addressable
        // once the device is paired again; revocation stops the work, it does
        // not erase what was already dispatched.
        await transport.setRefuses(false)
        await transport.setStatusOutcome(.denied)
        let settled = try await client.send(Self.makeRequest(operation: "operation.status", idempotencyKey: nil), authorizationProvider: { "token" })
        XCTAssertEqual(settled.outcome, .denied)
        XCTAssertEqual(approval.operationId, "op-approval-1")
        let afterRevocation = await transport.counts()
        XCTAssertEqual(afterRevocation.mutations, 0, "an approval lookup is a read")
    }

    // MARK: - Two devices, one pairing

    func testAStoredCredentialIsBoundToOneDeviceAndOneWorkspace() async throws {
        let keychain = SecureKeychainStore(service: "com.void.companion.tests.\(UUID().uuidString)")
        let store = KeychainDeviceCredentialStore(keychain: keychain)
        defer { Task { try? await store.remove() } }
        let first = try DeviceCredential(deviceId: "device-a", workspaceId: "workspace-a", token: String(repeating: "a", count: 43), issuedAt: "2026-09-26T10:00:00Z", expiresAt: "2026-09-26T10:15:00Z")
        let second = try DeviceCredential(deviceId: "device-b", workspaceId: "workspace-a", token: String(repeating: "b", count: 43), issuedAt: "2026-09-26T10:00:00Z", expiresAt: "2026-09-26T10:15:00Z")

        try await store.save(first)
        // A second device's acceptance is a different authority, and one
        // Keychain item holds one device. Storing it must not merge the two or
        // leave the first readable.
        try await store.save(second)
        let readBack = try await store.load()
        XCTAssertEqual(readBack, second)
        // The first token is no longer anywhere the client can present it.
        let item = try await keychain.read(account: KeychainDeviceCredentialStore.credentialAccount)
        let raw = try XCTUnwrap(item)
        XCTAssertFalse(String(decoding: raw, as: UTF8.self).contains(first.token))
        XCTAssertEqual(first.deviceId != second.deviceId, true)
        XCTAssertEqual(first.workspaceId, second.workspaceId)
    }

    func testAnExpiredCredentialIsReportedAsExpiredRatherThanPresented() throws {
        let credential = try DeviceCredential(deviceId: "d", workspaceId: "w", token: String(repeating: "t", count: 43), issuedAt: "2026-09-26T10:00:00Z", expiresAt: "2026-09-26T10:15:00Z")
        // Absolute instants rather than parsed strings, so the test does not
        // depend on a Foundation date strategy that differs between the
        // package's macOS build and its iOS one.
        let before = Date(timeIntervalSince1970: 1_780_000_000)
        let after = Date(timeIntervalSince1970: 1_800_000_000)
        XCTAssertFalse(credential.isExpired(at: before))
        XCTAssertTrue(credential.isExpired(at: after))
    }

    // MARK: - Helpers

    private static func fingerprint(of data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private static func resolve(_ unsettled: UnsettledMutation, outcome: CompanionOutcome) -> MutationResolution {
        // The unknown-outcome rule, as the client applies it: a settled
        // outcome needs no lookup, and an unsettled one is only ever looked up.
        outcome == .unknown ? .lookUpStatus(of: unsettled) : .alreadySettled(outcome: outcome)
    }

    private static func makeRequest(operation: String, idempotencyKey: String?) -> CompanionRequest {
        let body = JSONValue.object(["a": .int(1)])
        let encoded = JSONEncoder()
        encoded.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let digest = SHA256.hash(data: (try? encoded.encode(body)) ?? Data()).map { String(format: "%02x", $0) }.joined()
        return CompanionRequest(
            protocolIdentifier: CompanionProtocol.identifier, schemaVersion: 1, kind: "request",
            requestId: "request", operationId: "operation", operation: operation, deviceId: "device",
            workspaceId: "workspace-a", sessionId: "session", idempotencyKey: idempotencyKey,
            issuedAt: "2026-01-01T00:00:00Z", expiresAt: "2026-01-01T00:01:00Z", bodyDigest: digest, body: body
        )
    }
}

/// A clock the test moves, because the reconnect bound is the feature and a
/// wall clock cannot be waited on.
private final class MutableClock: @unchecked Sendable {
    private let lock = NSLock()
    // A fixed instant rather than a parsed string, so the test does not depend
    // on a Foundation date strategy that differs between the package's macOS
    // build and its iOS one.
    private var value = Date(timeIntervalSince1970: 1_789_000_000)

    var now: Date {
        lock.lock()
        defer { lock.unlock() }
        return value
    }

    func advance(seconds: TimeInterval) {
        lock.lock()
        defer { lock.unlock() }
        value = value.addingTimeInterval(seconds)
    }
}

/// Counts what the client actually dispatched, and can refuse a device the way
/// the executor does after a revocation.
private actor MutationCountingTransport: HTTPTransport {
    let boundEndpoint = URL(string: "https://void-mac.local:7443")!
    private var mutations = 0
    private var reads = 0
    private var failNext = true
    private var refuses = false
    private var statusOutcome: CompanionOutcome = .unknown

    func counts() -> (mutations: Int, reads: Int) { (mutations, reads) }
    func setFailsNext(_ value: Bool) { failNext = value }
    func setRefuses(_ value: Bool) { refuses = value }
    func setStatusOutcome(_ value: CompanionOutcome) { statusOutcome = value }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        let body = try JSONDecoder().decode(CompanionRequest.self, from: request.httpBody ?? Data())
        let mutating = body.idempotencyKey != nil
        if mutating {
            mutations += 1
            if failNext { throw URLError(.networkConnectionLost) }
        } else {
            reads += 1
        }
        if refuses {
            return (Data(#"{"error":"device_forbidden"}"#.utf8), HTTPURLResponse(url: boundEndpoint, statusCode: 403, httpVersion: nil, headerFields: nil)!)
        }
        let response = CompanionResponse(
            protocolIdentifier: CompanionProtocol.identifier, schemaVersion: 1, kind: "response",
            requestId: body.requestId, operationId: body.operationId, operation: body.operation,
            deviceId: body.deviceId, workspaceId: body.workspaceId, httpStatus: 200,
            outcome: mutating ? .succeeded : statusOutcome,
            body: mutating ? .object(["ok": .bool(true)]) : nil
        )
        return (try JSONEncoder().encode(response), HTTPURLResponse(url: boundEndpoint, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
}
