import Foundation

public struct CompanionFixture: Codable, Equatable, Sendable {
    public let fixture: String
    public let protocolIdentifier: String
    public let schemaVersion: Int
    public let implementation: FixtureImplementation
    public let sourceRoutes: [String]
    public let request: CompanionRequest
    public let response: CompanionResponse
}

public struct FixtureImplementation: Codable, Equatable, Sendable {
    public let server: String
    public let apple: String
    public let transport: String
    public let authority: String
}

public struct CompanionRequest: Codable, Equatable, Sendable {
    public let protocolIdentifier: String
    public let schemaVersion: Int
    public let kind: String
    public let requestId: String
    public let operationId: String
    public let operation: String
    public let deviceId: String
    public let workspaceId: String
    public let sessionId: String?
    public let idempotencyKey: String?
    public let issuedAt: String
    public let expiresAt: String
    public let bodyDigest: String
    public let body: JSONValue
}


public struct CompanionResponse: Codable, Equatable, Sendable {
    public let protocolIdentifier: String
    public let schemaVersion: Int
    public let kind: String
    public let requestId: String
    public let operationId: String
    public let operation: String
    public let deviceId: String?
    public let workspaceId: String?
    public let httpStatus: Int
    public let outcome: CompanionOutcome
    public let body: JSONValue?
    public let error: CompanionError?

    public init(
        protocolIdentifier: String,
        schemaVersion: Int,
        kind: String,
        requestId: String,
        operationId: String,
        operation: String,
        deviceId: String? = nil,
        workspaceId: String? = nil,
        httpStatus: Int,
        outcome: CompanionOutcome,
        body: JSONValue? = nil,
        error: CompanionError? = nil
    ) {
        self.protocolIdentifier = protocolIdentifier
        self.schemaVersion = schemaVersion
        self.kind = kind
        self.requestId = requestId
        self.operationId = operationId
        self.operation = operation
        self.deviceId = deviceId
        self.workspaceId = workspaceId
        self.httpStatus = httpStatus
        self.outcome = outcome
        self.body = body
        self.error = error
    }
}

public struct CompanionError: Codable, Equatable, Sendable {
    public let code: String
    public let message: String
    public let retryable: Bool
    public let reconcileRequired: Bool?
    public let refreshRequired: Bool?
    public let retryAfterMs: Int?
    public let supportedVersions: [String]?
}

public enum CompanionOutcome: String, Codable, Equatable, Sendable {
    case succeeded
    case denied
    case conflict
    case unknown
    case running
    case unsupportedVersion = "unsupported_version"
    case revoked
    case invalid
    case expired
    case rateLimited = "rate_limited"
}
