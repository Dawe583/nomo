import Foundation

public enum MutationRetryAction: String, Codable, Equatable, Sendable {
    case reconcileWithoutRetry
    case pollStatusWithoutRetry
    case obtainNewGrant
    case rePair
    case noRetry
}

public enum MutationRetryPolicy {
    public static func action(for outcome: CompanionOutcome) -> MutationRetryAction {
        switch outcome {
        case .unknown: return .reconcileWithoutRetry
        case .running: return .pollStatusWithoutRetry
        case .conflict: return .obtainNewGrant
        case .revoked: return .rePair
        case .succeeded, .denied, .unsupportedVersion, .invalid, .expired, .rateLimited:
            return .noRetry
        }
    }
}

public struct DurableOperationStatus: Codable, Equatable, Sendable {
    public let operationId: String
    public let deviceId: String
    public let workspaceId: String
    public let operation: String
    public let idempotencyKey: String?
    public let outcome: CompanionOutcome
    public let receipt: JSONValue?
    public let updatedAt: String

    public init(
        operationId: String,
        deviceId: String,
        workspaceId: String,
        operation: String,
        idempotencyKey: String? = nil,
        outcome: CompanionOutcome,
        receipt: JSONValue? = nil,
        updatedAt: String
    ) {
        self.operationId = operationId
        self.deviceId = deviceId
        self.workspaceId = workspaceId
        self.operation = operation
        self.idempotencyKey = idempotencyKey
        self.outcome = outcome
        self.receipt = receipt
        self.updatedAt = updatedAt
    }
}

public enum OperationStatusStoreError: Error, Equatable, Sendable {
    case corruptStore
    case invalidScope
    case scopeMismatch
}

public protocol OperationStatusStore: Sendable {
    func status(deviceId: String, workspaceId: String, operationId: String) async throws -> DurableOperationStatus?
    func save(_ status: DurableOperationStatus) async throws
    func delete(deviceId: String, workspaceId: String, operationId: String) async throws
}

public actor FileOperationStatusStore: OperationStatusStore {
    private let fileURL: URL
    private var statuses: [String: DurableOperationStatus]

    public init(fileURL: URL) throws {
        self.fileURL = fileURL
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            self.statuses = [:]
            return
        }
        do {
            let data = try Data(contentsOf: fileURL)
            let decoded = try JSONDecoder().decode([String: DurableOperationStatus].self, from: data)
            for (key, status) in decoded {
                let parts = key.split(separator: "\u{1f}", omittingEmptySubsequences: false).map(String.init)
                guard parts.count == 3,
                      parts[0] == status.deviceId,
                      parts[1] == status.workspaceId,
                      parts[2] == status.operationId else { throw OperationStatusStoreError.corruptStore }
            }
            self.statuses = decoded
        } catch let error as OperationStatusStoreError {
            throw error
        } catch {
            throw OperationStatusStoreError.corruptStore
        }
    }

    public func status(deviceId: String, workspaceId: String, operationId: String) async throws -> DurableOperationStatus? {
        let key = try Self.makeKey(deviceId: deviceId, workspaceId: workspaceId, operationId: operationId)
        guard let status = statuses[key] else { return nil }
        guard status.deviceId == deviceId, status.workspaceId == workspaceId, status.operationId == operationId else {
            throw OperationStatusStoreError.scopeMismatch
        }
        return status
    }

    public func save(_ status: DurableOperationStatus) async throws {
        let key = try Self.makeKey(deviceId: status.deviceId, workspaceId: status.workspaceId, operationId: status.operationId)
        statuses[key] = status
        try persist()
    }

    public func delete(deviceId: String, workspaceId: String, operationId: String) async throws {
        let key = try Self.makeKey(deviceId: deviceId, workspaceId: workspaceId, operationId: operationId)
        statuses.removeValue(forKey: key)
        try persist()
    }

    private func persist() throws {
        let data = try JSONEncoder().encode(statuses)
        try data.write(to: fileURL, options: [.atomic, .completeFileProtection])
    }

    private static func makeKey(deviceId: String, workspaceId: String, operationId: String) throws -> String {
        let values = [deviceId, workspaceId, operationId]
        guard values.allSatisfy({ !$0.isEmpty && $0.count <= 160 && !$0.unicodeScalars.contains { $0.value < 0x20 || $0.value == 0x7f || $0 == "/" || $0 == "\\" } }) else {
            throw OperationStatusStoreError.invalidScope
        }
        return values.joined(separator: "\u{1f}")
    }
}

public enum PairingState: String, Codable, Equatable, Sendable {
    case unpaired
    case pending
    case paired
    case revoked
}

public enum PairingStateError: Error, Equatable, Sendable {
    case invalidTransition
    case revoked
}

public struct PairingStateMachine: Sendable {
    public private(set) var state: PairingState = .unpaired
    public init() {}

    public mutating func beginPairing() throws {
        guard state != .revoked else { throw PairingStateError.revoked }
        state = .pending
    }

    public mutating func pair() throws {
        guard state != .revoked else { throw PairingStateError.revoked }
        guard state == .pending else { throw PairingStateError.invalidTransition }
        state = .paired
    }

    public mutating func revoke() {
        state = .revoked
    }
}
