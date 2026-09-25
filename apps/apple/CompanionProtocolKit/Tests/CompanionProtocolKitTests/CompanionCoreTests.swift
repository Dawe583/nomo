import Foundation
import XCTest
@testable import CompanionProtocolKit

final class CompanionCoreTests: XCTestCase {
    func testEventCursorPreservesExactDecimalStringAndRejectsUnsafeValues() throws {
        let cursor = try EventCursor(rawValue: "00123")
        XCTAssertEqual(cursor.rawValue, "00123")
        XCTAssertThrowsError(try EventCursor(validating: "-1"))
        XCTAssertThrowsError(try EventCursor(validating: "9007199254740992"))
        XCTAssertThrowsError(try EventCursor(validating: "1.0"))
    }

    func testEventPageRequiresStrictlyIncreasingBoundedEvents() throws {
        let first = CompanionEvent(id: "e1", sessionId: "s1", seq: 1, at: "2026-01-01T00:00:00Z", type: "status", kind: "run", schemaVersion: 1)
        let page = try EventPage(items: [first], after: "0", nextAfter: "1", hasMore: false, historyComplete: true, scope: EventScope(workspaceId: "w1", sessionId: "s1"), asOf: "2026-01-01T00:00:00Z", replayExpiresAt: "2026-01-01T00:15:00Z")
        XCTAssertEqual(page.items.count, 1)
        XCTAssertThrowsError(try EventPage(items: [first, first], after: "0", nextAfter: nil, hasMore: false, historyComplete: true, scope: page.scope, asOf: page.asOf, replayExpiresAt: page.replayExpiresAt))
    }

    func testUnknownMutationIsNeverAutomaticallyRetried() {
        XCTAssertEqual(MutationRetryPolicy.action(for: .unknown), .reconcileWithoutRetry)
        XCTAssertEqual(MutationRetryPolicy.action(for: .running), .pollStatusWithoutRetry)
        XCTAssertEqual(MutationRetryPolicy.action(for: .conflict), .obtainNewGrant)
    }

    func testPairingStateRevocationIsTerminal() throws {
        var state = PairingStateMachine()
        try state.beginPairing()
        try state.pair()
        state.revoke()
        XCTAssertEqual(state.state, .revoked)
        XCTAssertThrowsError(try state.pair()) { error in
            XCTAssertEqual(error as? PairingStateError, .revoked)
        }
    }

    func testLocalNetworkIdentityRejectsPublicAndNonTLSEndpoints() {
        XCTAssertNoThrow(try LocalNetworkIdentity(endpoint: URL(string: "https://mac-mini.local:8443")!, executorId: "e", identityKeyId: "k", certificateSHA256: String(repeating: "a", count: 64)))
        XCTAssertThrowsError(try LocalNetworkIdentity(endpoint: URL(string: "https://example.com")!, executorId: "e", identityKeyId: "k", certificateSHA256: String(repeating: "a", count: 64)))
        XCTAssertThrowsError(try LocalNetworkIdentity(endpoint: URL(string: "http://mac-mini.local")!, executorId: "e", identityKeyId: "k", certificateSHA256: String(repeating: "a", count: 64)))
    }

    func testTLSFingerprintMustBeLowercaseSHA256() {
        XCTAssertThrowsError(try LocalNetworkIdentity(endpoint: URL(string: "https://mac-mini.local")!, executorId: "e", identityKeyId: "k", certificateSHA256: "A"))
        XCTAssertThrowsError(try LocalNetworkIdentity(endpoint: URL(string: "https://mac-mini.local")!, executorId: "e", identityKeyId: "k", certificateSHA256: "A" + String(repeating: "a", count: 63)))
    }

    func testDiagnosticRedactionDoesNotEchoSensitiveContent() {
        let diagnostic = SanitizedDiagnostic(code: "transport_failure", message: "token sk-123 /Users/dawe/secret.txt prompt: hello stack", requestId: "r1", operationId: "o1")
        XCTAssertFalse(diagnostic.message.contains("sk-123"))
        XCTAssertFalse(diagnostic.message.contains("/Users/dawe/secret.txt"))
        XCTAssertFalse(diagnostic.message.contains("prompt"))
        XCTAssertFalse(diagnostic.message.contains("stack"))
        XCTAssertLessThanOrEqual(diagnostic.message.count, 320)
    }

    func testHTTPClientDoesNotRetryUnknownMutation() async throws {
        let transport = RecordingTransport(response: try JSONDecoder().decode(CompanionResponse.self, from: Data(#"{"protocol":"void.companion.v1","schemaVersion":1,"kind":"response","requestId":"r1","operationId":"o1","operation":"recovery.apply","deviceId":"d","workspaceId":"w","httpStatus":202,"outcome":"unknown","error":{"code":"operation_unknown","message":"status unavailable","retryable":false,"reconcileRequired":true}}"#.utf8)))
        let client = CompanionHTTPClient(transport: transport)
        let request = CompanionRequest(protocolIdentifier: CompanionProtocol.identifier, schemaVersion: 1, kind: "request", requestId: "r1", operationId: "o1", operation: "recovery.apply", deviceId: "d", workspaceId: "w", sessionId: nil, idempotencyKey: "i", issuedAt: "2026-01-01T00:00:00Z", expiresAt: "2026-01-01T00:01:00Z", bodyDigest: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a", body: .object([:]))
        let response = try await client.send(request)
        XCTAssertEqual(response.outcome, CompanionOutcome.unknown)
        let requestCount = await transport.requestCount
        XCTAssertEqual(requestCount, 1)
    }

    func testKeychainStoreProtocolCanBeBackedByTestDouble() async throws {
        let store = TestKeychainStore()
        try await store.write(Data("credential".utf8), account: "device")
        let value = try await store.read(account: "device")
        XCTAssertEqual(value, Data("credential".utf8))
        try await store.delete(account: "device")
        let deleted = try await store.read(account: "device")
        XCTAssertNil(deleted)
    }
}

private actor RecordingTransport: HTTPTransport {
    let boundEndpoint = URL(string: "https://mac-mini.local")!
    private(set) var requestCount = 0
    let response: CompanionResponse

    init(response: CompanionResponse) { self.response = response }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        requestCount += 1
        return (try JSONEncoder().encode(response), HTTPURLResponse(url: boundEndpoint, statusCode: 202, httpVersion: nil, headerFields: nil)!)
    }
}

private actor TestKeychainStore: KeychainStore {
    private var values: [String: Data] = [:]
    func read(account: String) async throws -> Data? { values[account] }
    func write(_ data: Data, account: String) async throws { values[account] = data }
    func delete(account: String) async throws { values[account] = nil }
}
