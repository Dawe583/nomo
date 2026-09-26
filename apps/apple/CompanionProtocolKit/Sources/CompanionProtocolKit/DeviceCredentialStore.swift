import Foundation
import Security

/// The device credential the executor minted at pairing.
///
/// The token is the whole authority, so this type is written to be unreadable
/// in a log: it carries no `description` and no `debugDescription` of its own
/// beyond a redacted summary, so `print`, string interpolation, a crash
/// reporter, and `Mirror` all see the identity without the secret. Anything
/// that needs the token asks for `token` by name, which makes each read of it
/// greppable.
public struct DeviceCredential: Codable, Equatable, Sendable {
    public let deviceId: String
    public let workspaceId: String
    public let token: String
    public let issuedAt: String
    public let expiresAt: String

    public init(deviceId: String, workspaceId: String, token: String, issuedAt: String, expiresAt: String) throws {
        // The identities come from the handshake and the scopes from the
        // pairing receipt, so they are bounded the same way the HTTP client
        // bounds them. A credential that could not be presented is not worth
        // storing, and storing one would leave a value in the Keychain that no
        // request could ever use.
        guard Self.isBoundedIdentity(deviceId), Self.isBoundedIdentity(workspaceId),
              token.count >= 32, token.count <= 128,
              issuedAt.hasSuffix("Z"), expiresAt.hasSuffix("Z"),
              let issued = Self.parse(issuedAt), let expires = Self.parse(expiresAt), issued < expires else {
            throw DeviceCredentialError.malformed
        }
        self.deviceId = deviceId
        self.workspaceId = workspaceId
        self.token = token
        self.issuedAt = issuedAt
        self.expiresAt = expiresAt
    }

    /// Whether the credential is still inside the lifetime the executor
    /// advertised. An expired credential is not deleted here, because the
    /// executor is the only authority on when a device credential dies; the
    /// caller decides whether to re-pair or to fail closed.
    public func isExpired(at now: Date) -> Bool {
        guard let expiry = Self.parse(expiresAt) else { return true }
        return expiry <= now
    }

    public var redactedSummary: String {
        "DeviceCredential(\(deviceId)@\(workspaceId), token withheld, expires \(expiresAt))"
    }

    private static func isBoundedIdentity(_ value: String) -> Bool {
        !value.isEmpty && value.count <= 160 && !value.unicodeScalars.contains { $0.value < 0x20 || $0.value == 0x7f || $0 == "/" || $0 == "\\" }
    }

    private static func parse(_ value: String) -> Date? {
        try? Date(value, strategy: .iso8601)
    }
}

extension DeviceCredential: CustomStringConvertible, CustomDebugStringConvertible {
    public var description: String { redactedSummary }
    public var debugDescription: String { redactedSummary }
}

public enum DeviceCredentialError: Error, Equatable, Sendable {
    case malformed
    case storageUnavailable(OSStatus)
}

/// Where the device credential lives.
///
/// The protocol is the whole point of the type: the only implementation this
/// package ships writes to the Keychain. There is deliberately no
/// `UserDefaults`, plist, file, or log path, because every one of those is
/// readable by a backup, a crash report, or another app extension, and none of
/// them can be revoked when a device is removed.
public protocol DeviceCredentialStore: Sendable {
    func save(_ credential: DeviceCredential) async throws
    func load() async throws -> DeviceCredential?
    /// Forget this device's credential. A store that has nothing to forget is
    /// already in the state removal needs, so this is not an error.
    func remove() async throws
}

/// The Keychain-backed store. The service and account are fixed by the app, so
/// there is one item to find and one item to delete, and a removal cannot leave
/// a second copy behind under a different name.
public struct KeychainDeviceCredentialStore: DeviceCredentialStore {
    public static let defaultService = "com.void.companion.device"
    public static let credentialAccount = "device.credential"

    private let keychain: any KeychainStore
    private let service: String
    private let account: String

    public init(keychain: any KeychainStore, service: String = KeychainDeviceCredentialStore.defaultService, account: String = KeychainDeviceCredentialStore.credentialAccount) {
        self.keychain = keychain
        self.service = service
        self.account = account
    }

    public func save(_ credential: DeviceCredential) async throws {
        do {
            try await keychain.write(JSONEncoder().encode(credential), account: account)
        } catch let error as KeychainStoreError {
            throw DeviceCredentialError.storageUnavailable(error.status)
        }
    }

    public func load() async throws -> DeviceCredential? {
        let data: Data?
        do {
            data = try await keychain.read(account: account)
        } catch let error as KeychainStoreError {
            throw DeviceCredentialError.storageUnavailable(error.status)
        }
        guard let data else { return nil }
        // A credential that cannot be decoded is not a credential the client can
        // present, and keeping it would mean reporting a paired device that
        // fails on its first request. It is dropped, not surfaced.
        guard let credential = try? JSONDecoder().decode(DeviceCredential.self, from: data) else { return nil }
        return credential
    }

    public func remove() async throws {
        do {
            try await keychain.delete(account: account)
        } catch let error as KeychainStoreError {
            throw DeviceCredentialError.storageUnavailable(error.status)
        }
    }
}

extension KeychainStoreError {
    /// The numeric status, so a caller can report the Keychain's own refusal
    /// rather than flattening every failure into one word.
    var status: OSStatus {
        switch self {
        case .unexpectedStatus(let status): status
        case .invalidData: errSecDecode
        }
    }
}
