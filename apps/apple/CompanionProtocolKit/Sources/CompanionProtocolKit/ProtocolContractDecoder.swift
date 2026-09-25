import Foundation

public enum ProtocolContractError: Error, Equatable, Sendable {
    case unsupportedVersion
    case invalidFixture
    case identityMismatch
    case invalidDigest
    case capabilityNotPending
    case invalidCursor
    case invalidEventPage
    case eventTooLarge
    case eventPageTooLarge
}

public enum ProtocolContractDecoder {
    public static func decodeFixture(_ data: Data) throws -> CompanionFixture {
        let fixture: CompanionFixture
        do {
            fixture = try JSONDecoder().decode(CompanionFixture.self, from: data)
        } catch {
            throw ProtocolContractError.invalidFixture
        }

        try validate(fixture)
        return fixture
    }

    public static func decodeHandshake(_ data: Data) throws -> Handshake {
        let fixture = try decodeFixture(data)
        guard fixture.request.operation == "capability.handshake",
              fixture.response.operation == "capability.handshake",
              fixture.response.outcome == .succeeded,
              let body = fixture.response.body,
              case .object = body else {
            throw ProtocolContractError.invalidFixture
        }

        let payload: HandshakeBody
        do {
            payload = try JSONDecoder().decode(HandshakeBody.self, from: JSONEncoder().encode(body))
        } catch {
            throw ProtocolContractError.invalidFixture
        }

        guard payload.protocolVersions == [CompanionProtocol.identifier] else {
            throw ProtocolContractError.unsupportedVersion
        }
        guard payload.capabilities.allSatisfy({ $0.status == .pending || $0.status == .unsupported }) else {
            throw ProtocolContractError.capabilityNotPending
        }
        return Handshake(body: payload)
    }

    private static func validate(_ fixture: CompanionFixture) throws {
        guard fixture.protocolIdentifier == CompanionProtocol.identifier,
              fixture.schemaVersion == CompanionProtocol.schemaVersion,
              fixture.implementation.server == "pending",
              fixture.implementation.apple == "pending",
              fixture.implementation.transport == "pending",
              fixture.implementation.authority == "not-granted" else {
            throw ProtocolContractError.invalidFixture
        }

        let requestVersionIsSupported = fixture.request.protocolIdentifier == CompanionProtocol.identifier
            && fixture.request.schemaVersion == CompanionProtocol.schemaVersion
        let isOnlyUnsupportedHandshake = fixture.request.operation == "capability.handshake"
            && fixture.request.protocolIdentifier == "void.companion.v2"
            && fixture.response.outcome == .unsupportedVersion
        guard requestVersionIsSupported || isOnlyUnsupportedHandshake else {
            throw ProtocolContractError.unsupportedVersion
        }

        guard fixture.request.kind == "request",
              fixture.response.protocolIdentifier == CompanionProtocol.identifier,
              fixture.response.schemaVersion == CompanionProtocol.schemaVersion,
              fixture.response.kind == "response" else {
            throw ProtocolContractError.unsupportedVersion
        }
        guard fixture.request.requestId == fixture.response.requestId,
              fixture.request.operationId == fixture.response.operationId,
              fixture.request.operation == fixture.response.operation else {
            throw ProtocolContractError.identityMismatch
        }
        guard isLowercaseSHA256(fixture.request.bodyDigest) else {
            throw ProtocolContractError.invalidDigest
        }
    }

    private static func isLowercaseSHA256(_ value: String) -> Bool {
        value.utf8.count == 64 && value.utf8.allSatisfy { byte in
            (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(byte)
                || (UInt8(ascii: "a")...UInt8(ascii: "f")).contains(byte)
        }
    }
}

public enum CompanionProtocol {
    public static let identifier = "void.companion.v1"
    public static let schemaVersion = 1
}
