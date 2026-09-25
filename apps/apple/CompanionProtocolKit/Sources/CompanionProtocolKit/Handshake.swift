import Foundation

public struct Handshake: Equatable, Sendable {
    public let body: HandshakeBody
}

public struct HandshakeBody: Codable, Equatable, Sendable {
    public let serverTime: String
    public let protocolVersions: [String]
    public let executor: ExecutorIdentity
    public let workspace: WorkspaceIdentity
    public let device: DeviceIdentity
    public let capabilities: [HandshakeCapability]
    public let limits: ProtocolLimits
    public let pendingBehaviors: [String]
    public let expiresAt: String
}

public struct ExecutorIdentity: Codable, Equatable, Sendable {
    public let executorId: String
    public let displayName: String
    public let platform: String
    public let build: String
    public let identityKeyId: String
}

public struct WorkspaceIdentity: Codable, Equatable, Sendable {
    public let workspaceId: String
    public let label: String?
}

public struct DeviceIdentity: Codable, Equatable, Sendable {
    public let deviceId: String
    public let state: DeviceState
}

public struct HandshakeCapability: Codable, Equatable, Sendable {
    public let id: String
    public let version: String
    public let status: HandshakeCapabilityStatus
    public let requiredScope: String?
    public let limitation: String?
}

public enum DeviceState: String, Codable, Equatable, Sendable {
    case paired
    case pending
    case revoked
}

public enum HandshakeCapabilityStatus: String, Codable, Equatable, Sendable {
    case pending
    case unsupported
    case available
}

public struct ProtocolLimits: Codable, Equatable, Sendable {
    public let maxRequestBytes: Int
    public let maxPromptCharacters: Int
    public let maxEventsPerPage: Int
    public let maxEventPageBytes: Int
    public let maxEventBytes: Int
    public let maxStreamSeconds: Int
    public let replayWindowSeconds: Int
    public let idempotencyRetentionHours: Int
    public let deviceCredentialSeconds: Int
    public let invitationSeconds: Int
    public let grantSeconds: Int
    public let recoveryPlanSeconds: Int
    public let maxMutationsPerDevice: Int
    public let maxStreamsPerDevice: Int
    public let maxDevicesPerWorkspace: Int
    public let maxOperationIds: Int
    public let maxErrorCharacters: Int
}
