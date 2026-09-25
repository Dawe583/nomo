import CryptoKit
import Foundation
import XCTest
@testable import CompanionProtocolKit

/// The client and the executor adapter are proven together over a real
/// `HTTPTransport`: the request really goes on the wire as a `void.companion.v1`
/// envelope, and the answer really comes back as one. The committed fixture
/// files are the vectors, so the wire form cannot drift from them unnoticed.
final class EnvelopeAdapterTests: XCTestCase {
    private let fixturesDirectory = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .appendingPathComponent("Fixtures/Protocol", isDirectory: true)

    private let endpoint = URL(string: "https://mac-mini.local:8443/api/companion/envelope")!

    func testEveryCommittedRequestFixtureSurvivesTheRealWireRoundTrip() async throws {
        let names = ["succeeded.json", "denied.json", "conflict.json", "unknown.json", "revoked.json", "capability-handshake.json"]
        XCTAssertEqual(names.count, 6)

        for name in names {
            let data = try Data(contentsOf: fixturesDirectory.appendingPathComponent(name))
            let fixture = try ProtocolContractDecoder.decodeFixture(data)
            let root = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
            let responseSlice = try XCTUnwrap(root["response"])
            let transport = FixtureTransport(
                boundEndpoint: endpoint,
                payload: try JSONSerialization.data(withJSONObject: responseSlice),
                status: try XCTUnwrap((root["response"] as? [String: Any])?["httpStatus"] as? Int)
            )
            let client = CompanionHTTPClient(transport: transport)

            let response = try await client.send(fixture.request)

            XCTAssertEqual(response.protocolIdentifier, "void.companion.v1", name)
            XCTAssertEqual(response.kind, "response", name)
            XCTAssertEqual(response.outcome, fixture.response.outcome, name)
            XCTAssertEqual(response.requestId, fixture.response.requestId, name)
            XCTAssertEqual(response.operationId, fixture.response.operationId, name)
            XCTAssertEqual(response.operation, fixture.response.operation, name)
            XCTAssertEqual(response.deviceId, fixture.response.deviceId, name)
            XCTAssertEqual(response.workspaceId, fixture.response.workspaceId, name)
            XCTAssertEqual(response.body, fixture.response.body, name)
            XCTAssertEqual(response.error, fixture.response.error, name)

            // What reached the transport is the frozen request envelope, byte
            // for byte in meaning: the digest the fixture sealed is the one the
            // client recomputed, and nothing was added or dropped in encoding.
            let postedData = await transport.lastPostedValue()
            let posted = try XCTUnwrap(postedData)
            let wire = try JSONDecoder().decode(CompanionRequest.self, from: posted)
            XCTAssertEqual(wire, fixture.request, name)
            // Nothing was invented and nothing was dropped in encoding: the
            // optional members appear exactly when the request carries them.
            let wireKeys = Set(try XCTUnwrap(try JSONSerialization.jsonObject(with: posted) as? [String: Any]).keys)
            let optionalKeys = (fixture.request.sessionId == nil ? [] : ["sessionId"])
                + (fixture.request.idempotencyKey == nil ? [] : ["idempotencyKey"])
            let expectedKeys = Set([
                "protocol", "schemaVersion", "kind", "requestId", "operationId", "operation",
                "deviceId", "workspaceId", "issuedAt", "expiresAt", "bodyDigest", "body",
            ] + optionalKeys)
            XCTAssertEqual(wireKeys, expectedKeys, name)
        }
    }

    func testACredentialedSuccessWithAnEmptyBodyIsRefused() async throws {
        // The server's `sendReply` downgrades a `succeeded` with no body keys to
        // a refusal, so an empty object is a shape the server would never emit.
        // Accepting it here would hand a caller a completed operation with no
        // receipt to reconcile against.
        let data = try Data(contentsOf: fixturesDirectory.appendingPathComponent("succeeded.json"))
        let fixture = try ProtocolContractDecoder.decodeFixture(data)
        let transport = ExecutorTransport(boundEndpoint: endpoint) { posted in
            let received = try JSONDecoder().decode(CompanionRequest.self, from: posted)
            return (try Self.responsePayload(
                requestId: received.requestId,
                operationId: received.operationId,
                operation: received.operation,
                deviceId: received.deviceId,
                workspaceId: received.workspaceId,
                httpStatus: 200,
                outcome: .succeeded,
                body: .object([:])
            ), 200)
        }
        let client = CompanionHTTPClient(transport: transport)

        do {
            _ = try await client.send(fixture.request)
            XCTFail("a succeeded answer with an empty receipt must be refused")
        } catch {
            XCTAssertEqual(error as? CompanionHTTPError, .invalidResponse)
        }
    }

    func testAnEnvelopeForAnotherProtocolVersionNeverReachesTheTransport() async throws {
        let data = try Data(contentsOf: fixturesDirectory.appendingPathComponent("unsupported-version.json"))
        let fixture = try ProtocolContractDecoder.decodeFixture(data)
        XCTAssertEqual(fixture.request.protocolIdentifier, "void.companion.v2")
        XCTAssertEqual(fixture.response.outcome, .unsupportedVersion)

        let transport = FixtureTransport(boundEndpoint: endpoint, payload: Data(), status: 426)
        let client = CompanionHTTPClient(transport: transport)

        do {
            _ = try await client.send(fixture.request)
            XCTFail("a v2 envelope must never be sent")
        } catch {
            XCTAssertEqual(error as? CompanionHTTPError, .invalidRequest)
        }
        let posted = await transport.postedCount
        XCTAssertEqual(posted, 0)
    }

    func testPairingRoundTripsWithoutADeviceIdentityAndReturnsTheIssuedCredential() async throws {
        let body = JSONValue.object([
            "label": .string("Kitchen iPhone"),
            "scopes": .array([.string("companion:read")]),
        ])
        let request = pairingRequest(body: body)
        let transport = ExecutorTransport(boundEndpoint: endpoint) { posted in
            // The executor decodes the wire form it was handed, so a pairing
            // envelope that did not survive encoding could not answer at all.
            let received = try JSONDecoder().decode(CompanionPairingRequest.self, from: posted)
            return (try Self.responsePayload(
                requestId: received.requestId,
                operationId: received.operationId,
                operation: received.operation,
                deviceId: "device-mintedaaaa",
                workspaceId: "alpha",
                httpStatus: 201,
                outcome: .succeeded,
                body: .object([
                    "deviceId": .string("device-mintedaaaa"),
                    "deviceToken": .string(String(repeating: "b", count: 43)),
                    "expiresAt": .string("2026-09-25T12:15:00.000Z"),
                    "scopes": .array([.string("companion:read")]),
                ])
            ), 201)
        }
        let client = CompanionHTTPClient(transport: transport)

        let response = try await client.pair(request)

        XCTAssertEqual(response.protocolIdentifier, "void.companion.v1")
        XCTAssertEqual(response.schemaVersion, 1)
        XCTAssertEqual(response.kind, "response")
        XCTAssertEqual(response.operation, "device.pair")
        XCTAssertEqual(response.outcome, .succeeded)
        XCTAssertEqual(response.httpStatus, 201)
        XCTAssertEqual(response.deviceId, "device-mintedaaaa")
        XCTAssertEqual(response.workspaceId, "alpha")

        let postedData = await transport.lastPostedValue()
        let posted = try XCTUnwrap(postedData)
        let wire = try XCTUnwrap(try JSONSerialization.jsonObject(with: posted) as? [String: Any])
        // An unpaired device has no device and no workspace, so neither is on
        // the wire, and the request still carries the idempotency key that
        // issuing authority requires.
        XCTAssertNil(wire["deviceId"])
        XCTAssertNil(wire["workspaceId"])
        XCTAssertEqual(wire["idempotencyKey"] as? String, "idem-pair-001")
        XCTAssertEqual(wire["operation"] as? String, "device.pair")
        XCTAssertEqual(wire["protocol"] as? String, "void.companion.v1")
        let decoded = try JSONDecoder().decode(CompanionPairingRequest.self, from: posted)
        XCTAssertEqual(decoded, request)

        // The credential the executor issued is readable as a bounded receipt.
        let fields = try XCTUnwrap(response.body?.objectValue)
        XCTAssertEqual(fields["deviceId"], .string("device-mintedaaaa"))
        XCTAssertEqual((fields["deviceToken"]?.stringValue ?? "").count, 43)
    }

    func testPairingRefusesASuccessThatCarriesNoCredential() async throws {
        let request = pairingRequest(body: .object([:]))
        let transport = ExecutorTransport(boundEndpoint: endpoint) { posted in
            let received = try JSONDecoder().decode(CompanionPairingRequest.self, from: posted)
            // A `succeeded` pairing with no receipt is the one answer a client
            // must not accept: it would store a device it never received.
            return (try Self.responsePayload(
                requestId: received.requestId,
                operationId: received.operationId,
                operation: received.operation,
                httpStatus: 201,
                outcome: .succeeded
            ), 201)
        }
        let client = CompanionHTTPClient(transport: transport)

        do {
            _ = try await client.pair(request)
            XCTFail("a pairing success without a receipt must be refused")
        } catch {
            XCTAssertEqual(error as? CompanionHTTPError, .invalidResponse)
        }
        let posted = await transport.postedCount
        XCTAssertEqual(posted, 1)
    }

    func testPairingRefusesAnEnvelopeAnsweringAnotherRequest() async throws {
        let request = pairingRequest(body: .object([:]))
        let transport = ExecutorTransport(boundEndpoint: endpoint) { _ in
            (try Self.responsePayload(
                requestId: "req-somebody-else",
                operationId: "op-pair-001",
                operation: "device.pair",
                httpStatus: 201,
                outcome: .succeeded,
                body: .object(["deviceId": .string("device-mintedaaaa")])
            ), 201)
        }
        let client = CompanionHTTPClient(transport: transport)

        do {
            _ = try await client.pair(request)
            XCTFail("a pairing answer for another request must be refused")
        } catch {
            XCTAssertEqual(error as? CompanionHTTPError, .identityMismatch)
        }
    }

    func testAnUnsealedOrKeylessPairingNeverReachesTheTransport() async throws {
        let body = JSONValue.object(["label": .string("Kitchen iPhone")])
        let transport = ExecutorTransport(boundEndpoint: endpoint) { posted in
            let received = try JSONDecoder().decode(CompanionPairingRequest.self, from: posted)
            return (try Self.responsePayload(
                requestId: received.requestId,
                operationId: received.operationId,
                operation: received.operation,
                httpStatus: 201,
                outcome: .denied
            ), 403)
        }
        let client = CompanionHTTPClient(transport: transport)
        let sealed = pairingRequest(body: body)

        // A body that no longer matches the digest it was sealed with.
        let tampered = CompanionPairingRequest(
            protocolIdentifier: sealed.protocolIdentifier,
            schemaVersion: sealed.schemaVersion,
            kind: sealed.kind,
            requestId: sealed.requestId,
            operationId: sealed.operationId,
            operation: sealed.operation,
            idempotencyKey: sealed.idempotencyKey,
            issuedAt: sealed.issuedAt,
            expiresAt: sealed.expiresAt,
            bodyDigest: String(repeating: "0", count: 64),
            body: sealed.body
        )
        // A window that has already closed.
        let expired = CompanionPairingRequest(
            protocolIdentifier: sealed.protocolIdentifier,
            schemaVersion: sealed.schemaVersion,
            kind: sealed.kind,
            requestId: sealed.requestId,
            operationId: sealed.operationId,
            operation: sealed.operation,
            idempotencyKey: sealed.idempotencyKey,
            issuedAt: "2026-09-25T11:00:00.000Z",
            expiresAt: "2026-09-25T11:00:00.000Z",
            bodyDigest: sealed.bodyDigest,
            body: sealed.body
        )

        for request in [tampered, expired] {
            do {
                _ = try await client.pair(request)
                XCTFail("an unsealed pairing must be refused before the transport")
            } catch {
                XCTAssertEqual(error as? CompanionHTTPError, .invalidRequest)
            }
        }
        let posted = await transport.postedCount
        XCTAssertEqual(posted, 0)
    }

    // MARK: - Wire helpers

    private func pairingRequest(body: JSONValue) -> CompanionPairingRequest {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let encoded = try! encoder.encode(body)
        let digest = SHA256.hash(data: encoded).map { String(format: "%02x", $0) }.joined()
        return CompanionPairingRequest(
            protocolIdentifier: CompanionProtocol.identifier,
            schemaVersion: CompanionProtocol.schemaVersion,
            kind: "request",
            requestId: "req-pair-001",
            operationId: "op-pair-001",
            operation: CompanionPairingRequest.operation,
            idempotencyKey: "idem-pair-001",
            issuedAt: "2026-09-25T12:00:00.000Z",
            expiresAt: "2026-09-25T12:01:00.000Z",
            bodyDigest: digest,
            body: body
        )
    }

    private static func responsePayload(
        requestId: String,
        operationId: String,
        operation: String,
        deviceId: String? = nil,
        workspaceId: String? = nil,
        httpStatus: Int,
        outcome: CompanionOutcome,
        body: JSONValue? = nil
    ) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(CompanionResponse(
            protocolIdentifier: CompanionProtocol.identifier,
            schemaVersion: CompanionProtocol.schemaVersion,
            kind: "response",
            requestId: requestId,
            operationId: operationId,
            operation: operation,
            deviceId: deviceId,
            workspaceId: workspaceId,
            httpStatus: httpStatus,
            outcome: outcome,
            body: body
        ))
    }
}

private extension JSONValue {
    var objectValue: [String: JSONValue]? {
        if case .object(let fields) = self { return fields }
        return nil
    }

    var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }
}

/// Answers with a fixed response, for the committed fixture vectors.
private actor FixtureTransport: HTTPTransport {
    let boundEndpoint: URL
    private let payload: Data
    private let status: Int
    private(set) var posted: [Data] = []

    init(boundEndpoint: URL, payload: Data, status: Int) {
        self.boundEndpoint = boundEndpoint
        self.payload = payload
        self.status = status
    }

    func lastPostedValue() -> Data? { posted.last }
    var postedCount: Int { posted.count }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        posted.append(request.httpBody ?? Data())
        return (payload, HTTPURLResponse(url: boundEndpoint, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }
}

/// Runs a real in-process executor over the posted envelope, so the answer is
/// produced from the request rather than replayed from a stored vector.
private actor ExecutorTransport: HTTPTransport {
    let boundEndpoint: URL
    private let handler: @Sendable (Data) throws -> (Data, Int)
    private(set) var posted: [Data] = []

    init(boundEndpoint: URL, handler: @escaping @Sendable (Data) throws -> (Data, Int)) {
        self.boundEndpoint = boundEndpoint
        self.handler = handler
    }

    var lastPosted: Data? { posted.last }
    var postedCount: Int { posted.count }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        let body = request.httpBody ?? Data()
        posted.append(body)
        let (payload, status) = try handler(body)
        return (payload, HTTPURLResponse(url: boundEndpoint, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }

    /// The methods, not the stored array, because `XCTUnwrap` takes an
    /// autoclosure that cannot await an actor.
    func lastPostedValue() -> Data? { posted.last }
}
