import CryptoKit
import Foundation
import XCTest
@testable import CompanionProtocolKit

final class SecurityRegressionTests: XCTestCase {
    private let fingerprint = String(repeating: "a", count: 64)

    func testLocalNetworkIdentityRejectsIPv6PrefixImpersonators() {
        for host in ["fcevil.com", "fdpayload", "fe80evil.com"] {
            XCTAssertThrowsError(try LocalNetworkIdentity(endpoint: URL(string: "https://\(host):8443")!, executorId: "e", identityKeyId: "k", certificateSHA256: fingerprint))
        }
        XCTAssertNoThrow(try LocalNetworkIdentity(endpoint: URL(string: "https://[fe80::1]:8443")!, executorId: "e", identityKeyId: "k", certificateSHA256: fingerprint))
        XCTAssertNoThrow(try LocalNetworkIdentity(endpoint: URL(string: "https://[fd12:3456::1]:8443")!, executorId: "e", identityKeyId: "k", certificateSHA256: fingerprint))
        XCTAssertNoThrow(try LocalNetworkIdentity(endpoint: URL(string: "https://192.168.1.10:8443")!, executorId: "e", identityKeyId: "k", certificateSHA256: fingerprint))
    }

    func testMutatingRequestValidationHappensBeforeTransport() async throws {
        let transport = SecurityCountingTransport()
        let client = CompanionHTTPClient(transport: transport)
        let body = JSONValue.object(["b": .int(2), "a": .int(1)])
        let validDigest = Self.digest(Self.canonicalBody(body))

        await assertRejected(client: client, request: makeRequest(operation: "recovery.apply", idempotencyKey: nil, bodyDigest: validDigest))
        await assertRejected(client: client, request: makeRequest(operation: "recovery.apply", idempotencyKey: "i", bodyDigest: String(repeating: "b", count: 64)))
        await assertRejected(client: client, request: makeRequest(operation: "session.send", idempotencyKey: "i", bodyDigest: validDigest, issuedAt: "2026-01-01T00:00:00+00:00", expiresAt: "2026-01-01T00:01:00Z"))
        await assertRejected(client: client, request: makeRequest(operation: "session.send", idempotencyKey: "i", bodyDigest: validDigest, issuedAt: "2026-01-01T00:02:00Z", expiresAt: "2026-01-01T00:01:00Z"))
        await assertRejected(client: client, request: makeRequest(operation: "session.send", idempotencyKey: "i", bodyDigest: validDigest, workspaceId: String(repeating: "w", count: 161)))
        let requestCount = await transport.requestCount
        XCTAssertEqual(requestCount, 0)
    }

    func testEventPageRejectsCrossSessionAndWorkspaceMetadata() throws {
        let event = CompanionEvent(id: "e", sessionId: "session-a", seq: 1, at: "2026-01-01T00:00:00Z", type: "status", kind: "run", schemaVersion: 1)
        let scope = EventScope(workspaceId: "workspace-a", sessionId: "session-b")
        XCTAssertThrowsError(try EventPage(items: [event], after: "0", nextAfter: "1", hasMore: false, historyComplete: true, scope: scope, asOf: "2026-01-01T00:00:00Z", replayExpiresAt: "2026-01-01T00:15:00Z"))

        let wrongWorkspace = CompanionEvent(id: "e", sessionId: "session-a", seq: 1, at: "2026-01-01T00:00:00Z", type: "status", kind: "run", schemaVersion: 1, metadata: ["workspaceId": .string("workspace-b")])
        let matchingScope = EventScope(workspaceId: "workspace-a", sessionId: "session-a")
        XCTAssertThrowsError(try EventPage(items: [wrongWorkspace], after: "0", nextAfter: "1", hasMore: false, historyComplete: true, scope: matchingScope, asOf: "2026-01-01T00:00:00Z", replayExpiresAt: "2026-01-01T00:15:00Z"))
    }

    func testHTTPClientRejectsMissingOrMismatchedResponseScope() async throws {
        let request = makeRequest(operation: "session.send", idempotencyKey: "i", bodyDigest: Self.digest(Self.canonicalBody(.object(["a": .int(1), "b": .int(2)]))))
        let responses = [
            makeResponse(deviceId: nil, workspaceId: nil),
            makeResponse(deviceId: "other-device", workspaceId: "workspace-a"),
            makeResponse(deviceId: "device", workspaceId: "other-workspace")
        ]

        for response in responses {
            let client = CompanionHTTPClient(transport: ConfiguredResponseTransport(data: try JSONEncoder().encode(response), statusCode: 200))
            await assertIdentityMismatchRejected(client: client, request: request)
        }
    }

    func testEventPageRequiresNextAfterToAdvancePastLastEventWhenMoreExists() {
        let event = CompanionEvent(id: "e", sessionId: "session-a", seq: 7, at: "2026-01-01T00:00:00Z", type: "status", kind: "run", schemaVersion: 1)

        XCTAssertThrowsError(try EventPage(items: [event], after: "5", nextAfter: "7", hasMore: true, historyComplete: false, scope: EventScope(workspaceId: "workspace-a", sessionId: "session-a"), asOf: "2026-01-01T00:00:00Z", replayExpiresAt: "2026-01-01T00:15:00Z"))
        XCTAssertNoThrow(try EventPage(items: [event], after: "5", nextAfter: "8", hasMore: true, historyComplete: false, scope: EventScope(workspaceId: "workspace-a", sessionId: "session-a"), asOf: "2026-01-01T00:00:00Z", replayExpiresAt: "2026-01-01T00:15:00Z"))
        XCTAssertThrowsError(try EventPage(items: [], after: "7", nextAfter: "7", hasMore: true, historyComplete: false, scope: EventScope(workspaceId: "workspace-a", sessionId: "session-a"), asOf: "2026-01-01T00:00:00Z", replayExpiresAt: "2026-01-01T00:15:00Z"))
    }

    func testEventPageRejectsNonUTCTimestamps() {
        let scope = EventScope(workspaceId: "workspace-a", sessionId: "session-a")
        let nonUTCTime = "2026-01-01T00:00:00+00:00"

        XCTAssertThrowsError(try EventPage(items: [], after: "0", nextAfter: nil, hasMore: false, historyComplete: true, scope: scope, asOf: nonUTCTime, replayExpiresAt: "2026-01-01T00:15:00Z"))
        XCTAssertThrowsError(try EventPage(items: [], after: "0", nextAfter: nil, hasMore: false, historyComplete: true, scope: scope, asOf: "2026-01-01T00:00:00Z", replayExpiresAt: nonUTCTime))
        let event = CompanionEvent(id: "e", sessionId: "session-a", seq: 1, at: nonUTCTime, type: "status", kind: "run", schemaVersion: 1)
        XCTAssertThrowsError(try EventPage(items: [event], after: "0", nextAfter: "1", hasMore: false, historyComplete: true, scope: scope, asOf: "2026-01-01T00:00:00Z", replayExpiresAt: "2026-01-01T00:15:00Z"))
    }

    func testEventPageRejectsExpiredOrExtendedReplayWindow() {
        let scope = EventScope(workspaceId: "workspace-a", sessionId: "session-a")

        XCTAssertThrowsError(try EventPage(items: [], after: "0", nextAfter: nil, hasMore: false, historyComplete: true, scope: scope, asOf: "2026-01-01T00:00:00Z", replayExpiresAt: "2026-01-01T00:00:00Z"))
        XCTAssertThrowsError(try EventPage(items: [], after: "0", nextAfter: nil, hasMore: false, historyComplete: true, scope: scope, asOf: "2026-01-01T00:00:00Z", replayExpiresAt: "2026-01-01T00:15:00.001Z"))
    }

    func testOperationStatusStoreUsesScopedCompositeKeyAndFailsClosedOnCorruption() async throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("void-status-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url) }
        let store = try FileOperationStatusStore(fileURL: url)
        let status = DurableOperationStatus(operationId: "op", deviceId: "device-a", workspaceId: "workspace-a", operation: "recovery.apply", outcome: .running, updatedAt: "2026-01-01T00:00:00Z")
        try await store.save(status)
        let scoped = try await store.status(deviceId: "device-a", workspaceId: "workspace-a", operationId: "op")
        XCTAssertNotNil(scoped)
        let otherDevice = try await store.status(deviceId: "device-b", workspaceId: "workspace-a", operationId: "op")
        XCTAssertNil(otherDevice)
        let otherWorkspace = try await store.status(deviceId: "device-a", workspaceId: "workspace-b", operationId: "op")
        XCTAssertNil(otherWorkspace)

        try Data("not-json".utf8).write(to: url)
        XCTAssertThrowsError(try FileOperationStatusStore(fileURL: url)) { error in
            XCTAssertEqual(error as? OperationStatusStoreError, .corruptStore)
        }
        XCTAssertEqual(try Data(contentsOf: url), Data("not-json".utf8))
    }

    func testDiagnosticsBoundAndRedactIdentifiersWithGenericMessage() {
        let diagnostic = SanitizedDiagnostic(code: String(repeating: "c", count: 200), message: "private data", requestId: String(repeating: "r", count: 161), operationId: "/Users/alice/op", sessionId: "s")
        XCTAssertEqual(diagnostic.message, "diagnostic")
        XCTAssertNil(diagnostic.requestId)
        XCTAssertNil(diagnostic.operationId)
        XCTAssertLessThanOrEqual(diagnostic.code.count, 80)
    }

    func testHTTPClientRejectsOversizedResponseAndStatusEnvelopeMismatch() async throws {
        let request = makeRequest(operation: "session.send", idempotencyKey: "i", bodyDigest: Self.digest(Self.canonicalBody(.object(["a": .int(1), "b": .int(2)]))))
        let oversized = CompanionHTTPClient(transport: ConfiguredResponseTransport(data: Data(repeating: 0x20, count: CompanionHTTPClient.maxResponseBytes + 1), statusCode: 200))
        await assertRejected(client: oversized, request: request)

        let mismatched = CompanionResponse(protocolIdentifier: CompanionProtocol.identifier, schemaVersion: 1, kind: "response", requestId: "request", operationId: "operation", operation: "session.send", deviceId: "device", workspaceId: "workspace-a", httpStatus: 201, outcome: .succeeded)
        let mismatchClient = CompanionHTTPClient(transport: ConfiguredResponseTransport(data: try JSONEncoder().encode(mismatched), statusCode: 200))
        await assertRejected(client: mismatchClient, request: request)
    }

    func testHTTPClientRejectsUnknownResponseShape() async throws {
        let request = makeRequest(operation: "session.send", idempotencyKey: "i", bodyDigest: Self.digest(Self.canonicalBody(.object(["a": .int(1), "b": .int(2)]))))
        let unknown = Data(#"{"protocol":"void.companion.v1","schemaVersion":1,"kind":"response","requestId":"request","operationId":"operation","operation":"session.send","httpStatus":200,"outcome":"future"}"#.utf8)
        let client = CompanionHTTPClient(transport: ConfiguredResponseTransport(data: unknown, statusCode: 200))
        await assertRejected(client: client, request: request)
    }

    func testURLSessionTransportRejectsURLOutsideBoundIdentity() async throws {
        let identity = try LocalNetworkIdentity(endpoint: URL(string: "https://mac-mini.local:8443")!, executorId: "e", identityKeyId: "k", certificateSHA256: fingerprint)
        let transport = URLSessionTransport(identity: identity)
        let request = URLRequest(url: URL(string: "https://other.local:8443")!)
        do {
            _ = try await transport.data(for: request)
            XCTFail("expected endpoint mismatch")
        } catch let error as CompanionHTTPError {
            XCTAssertEqual(error, .endpointMismatch)
        }
    }

    private func makeRequest(operation: String, idempotencyKey: String?, bodyDigest: String, workspaceId: String = "workspace-a", issuedAt: String = "2026-01-01T00:00:00Z", expiresAt: String = "2026-01-01T00:01:00Z") -> CompanionRequest {
        CompanionRequest(protocolIdentifier: CompanionProtocol.identifier, schemaVersion: 1, kind: "request", requestId: "request", operationId: "operation", operation: operation, deviceId: "device", workspaceId: workspaceId, sessionId: "session", idempotencyKey: idempotencyKey, issuedAt: issuedAt, expiresAt: expiresAt, bodyDigest: bodyDigest, body: .object(["a": .int(1), "b": .int(2)]))
    }

    private func makeResponse(deviceId: String?, workspaceId: String?) -> CompanionResponse {
        CompanionResponse(protocolIdentifier: CompanionProtocol.identifier, schemaVersion: 1, kind: "response", requestId: "request", operationId: "operation", operation: "session.send", deviceId: deviceId, workspaceId: workspaceId, httpStatus: 200, outcome: .succeeded)
    }

    private func assertRejected(client: CompanionHTTPClient, request: CompanionRequest, file: StaticString = #filePath, line: UInt = #line) async {
        do {
            _ = try await client.send(request)
            XCTFail("expected rejection", file: file, line: line)
        } catch {}
    }

    private func assertIdentityMismatchRejected(client: CompanionHTTPClient, request: CompanionRequest, file: StaticString = #filePath, line: UInt = #line) async {
        do {
            _ = try await client.send(request)
            XCTFail("expected identity mismatch", file: file, line: line)
        } catch let error as CompanionHTTPError {
            XCTAssertEqual(error, .identityMismatch, file: file, line: line)
        } catch {
            XCTFail("unexpected error: \(error)", file: file, line: line)
        }
    }

    private static func canonicalBody(_ value: JSONValue) -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return (try? encoder.encode(value)) ?? Data()
    }

    private static func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}

private actor SecurityCountingTransport: HTTPTransport {
    let boundEndpoint = URL(string: "https://mac-mini.local")!
    private(set) var requestCount = 0

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        requestCount += 1
        let response = CompanionResponse(protocolIdentifier: CompanionProtocol.identifier, schemaVersion: 1, kind: "response", requestId: "request", operationId: "operation", operation: "session.send", deviceId: "device", workspaceId: "workspace-a", httpStatus: 200, outcome: .succeeded)
        return (try JSONEncoder().encode(response), HTTPURLResponse(url: boundEndpoint, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
}

private actor ConfiguredResponseTransport: HTTPTransport {
    let boundEndpoint = URL(string: "https://mac-mini.local")!
    let data: Data
    let statusCode: Int

    init(data: Data, statusCode: Int) {
        self.data = data
        self.statusCode = statusCode
    }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        (data, HTTPURLResponse(url: boundEndpoint, statusCode: statusCode, httpVersion: nil, headerFields: nil)!)
    }
}
