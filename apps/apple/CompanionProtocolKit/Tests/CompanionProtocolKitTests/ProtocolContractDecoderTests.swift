import Foundation
import XCTest
@testable import CompanionProtocolKit

final class ProtocolContractDecoderTests: XCTestCase {
    private let fixturesDirectory = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .appendingPathComponent("Fixtures/Protocol", isDirectory: true)

    func testDecodesEverySharedOutcomeFixture() throws {
        let expectations: [(String, CompanionOutcome)] = [
            ("succeeded.json", .succeeded),
            ("denied.json", .denied),
            ("conflict.json", .conflict),
            ("unknown.json", .unknown),
            ("unsupported-version.json", .unsupportedVersion),
            ("revoked.json", .revoked)
        ]

        for (name, expectedOutcome) in expectations {
            let fixture = try ProtocolContractDecoder.decodeFixture(
                Data(contentsOf: fixturesDirectory.appendingPathComponent(name))
            )

            XCTAssertEqual(fixture.response.outcome, expectedOutcome, name)
            XCTAssertEqual(fixture.request.requestId, fixture.response.requestId, name)
            XCTAssertEqual(fixture.request.operationId, fixture.response.operationId, name)
            XCTAssertEqual(fixture.request.operation, fixture.response.operation, name)
        }
    }

    func testPreservesOpaqueIdentityStringsExactly() throws {
        let identity = "000000000000000000000000000000000000000123"
        let fixture = try decodedFixture(named: "revoked.json")
        let changed = try replacingRequestIdentity(in: fixture, with: identity)

        let decoded = try ProtocolContractDecoder.decodeFixture(changed)

        XCTAssertEqual(decoded.request.sessionId, identity)
        XCTAssertNotEqual(decoded.request.sessionId, "123")
    }

    func testRejectsResponseWithMismatchedOperationIdentity() throws {
        let data = try replacingResponseField(
            in: fixtureData(named: "succeeded.json"),
            field: "operationId",
            value: "op-different"
        )

        XCTAssertThrowsError(try ProtocolContractDecoder.decodeFixture(data)) { error in
            XCTAssertEqual(error as? ProtocolContractError, .identityMismatch)
        }
    }

    func testRejectsUnknownSupportedResponseVersion() throws {
        let data = try replacingTopLevelResponseField(
            in: fixtureData(named: "succeeded.json"),
            field: "schemaVersion",
            value: 2
        )

        XCTAssertThrowsError(try ProtocolContractDecoder.decodeFixture(data)) { error in
            XCTAssertEqual(error as? ProtocolContractError, .unsupportedVersion)
        }
    }

    func testRejectsFixtureClaimingAvailableCapability() throws {
        let data = try replacingNestedValue(
            in: fixtureData(named: "capability-handshake.json"),
            path: ["response", "body", "capabilities", "0", "status"],
            value: "available"
        )

        XCTAssertThrowsError(try ProtocolContractDecoder.decodeHandshake(data)) { error in
            XCTAssertEqual(error as? ProtocolContractError, .capabilityNotPending)
        }
    }

    func testDecodesHandshakeAsPendingAndBounded() throws {
        let data = try fixtureData(named: "capability-handshake.json")

        let handshake = try ProtocolContractDecoder.decodeHandshake(data)

        XCTAssertEqual(handshake.body.executor.executorId, "executor-demo-001")
        XCTAssertEqual(handshake.body.device.state, .pending)
        XCTAssertFalse(handshake.body.capabilities.isEmpty)
        XCTAssertTrue(handshake.body.capabilities.allSatisfy { $0.status == .pending })
        XCTAssertEqual(handshake.body.limits.maxRequestBytes, 65_536)
        XCTAssertEqual(handshake.body.limits.maxEventsPerPage, 1_000)
        XCTAssertEqual(handshake.body.limits.maxStreamSeconds, 55)
        XCTAssertEqual(handshake.body.limits.grantSeconds, 300)
    }

    private func fixtureData(named name: String) throws -> Data {
        try Data(contentsOf: fixturesDirectory.appendingPathComponent(name))
    }

    private func decodedFixture(named name: String) throws -> CompanionFixture {
        try ProtocolContractDecoder.decodeFixture(fixtureData(named: name))
    }

    private func replacingRequestIdentity(
        in fixture: CompanionFixture,
        with identity: String
    ) throws -> Data {
        var object = try JSONSerialization.jsonObject(with: try JSONEncoder().encode(fixture)) as! [String: Any]
        var request = object["request"] as! [String: Any]
        request["sessionId"] = identity
        object["request"] = request
        return try JSONSerialization.data(withJSONObject: object)
    }

    private func replacingResponseField(
        in data: Data,
        field: String,
        value: String
    ) throws -> Data {
        try replacingTopLevelResponseField(in: data, field: field, value: value)
    }

    private func replacingTopLevelResponseField(
        in data: Data,
        field: String,
        value: Any
    ) throws -> Data {
        var object = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        var response = object["response"] as! [String: Any]
        response[field] = value
        object["response"] = response
        return try JSONSerialization.data(withJSONObject: object)
    }

    private func replacingNestedValue(
        in data: Data,
        path: [String],
        value: Any
    ) throws -> Data {
        var object = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        object = try replacing(object, path: path, value: value)
        return try JSONSerialization.data(withJSONObject: object)
    }

    private func replacing(
        _ object: [String: Any],
        path: [String],
        value: Any
    ) throws -> [String: Any] {
        var result = object
        let key = try XCTUnwrap(path.first)
        let remainder = Array(path.dropFirst())

        if remainder.isEmpty {
            result[key] = value
        } else if let next = path.dropFirst().first, let index = Int(next) {
            let array = try XCTUnwrap(result[key] as? [[String: Any]])
            var mutableArray = array
            mutableArray[index] = try replacing(mutableArray[index], path: Array(remainder.dropFirst()), value: value)
            result[key] = mutableArray
        } else {
            var child = try XCTUnwrap(result[key] as? [String: Any])
            child = try replacing(child, path: remainder, value: value)
            result[key] = child
        }
        return result
    }
}
