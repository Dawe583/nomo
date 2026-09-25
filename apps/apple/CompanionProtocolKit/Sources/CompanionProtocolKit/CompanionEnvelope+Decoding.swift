import Foundation

extension CompanionFixture {
    enum CodingKeys: String, CodingKey {
        case fixture
        case protocolIdentifier = "protocol"
        case schemaVersion
        case implementation
        case sourceRoutes
        case request
        case response
    }
}

extension CompanionRequest {
    enum CodingKeys: String, CodingKey {
        case protocolIdentifier = "protocol"
        case schemaVersion
        case kind
        case requestId
        case operationId
        case operation
        case deviceId
        case workspaceId
        case sessionId
        case idempotencyKey
        case issuedAt
        case expiresAt
        case bodyDigest
        case body
    }
}

extension CompanionPairingRequest {
    enum CodingKeys: String, CodingKey {
        case protocolIdentifier = "protocol"
        case schemaVersion
        case kind
        case requestId
        case operationId
        case operation
        case idempotencyKey
        case issuedAt
        case expiresAt
        case bodyDigest
        case body
    }
}

extension CompanionResponse {
    enum CodingKeys: String, CodingKey {
        case protocolIdentifier = "protocol"
        case schemaVersion
        case kind
        case requestId
        case operationId
        case operation
        case deviceId
        case workspaceId
        case httpStatus
        case outcome
        case body
        case error
    }
}
