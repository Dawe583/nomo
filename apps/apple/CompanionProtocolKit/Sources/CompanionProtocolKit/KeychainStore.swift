import Foundation
import Security

public enum KeychainStoreError: Error, Equatable, Sendable {
    case unexpectedStatus(OSStatus)
    case invalidData
}

public protocol KeychainStore: Sendable {
    func read(account: String) async throws -> Data?
    func write(_ data: Data, account: String) async throws
    func delete(account: String) async throws
}

public struct SecureKeychainStore: KeychainStore, @unchecked Sendable {
    public let service: String
    public let accessGroup: String?
    public let accessibility: CFString

    public init(
        service: String,
        accessGroup: String? = nil,
        accessibility: CFString = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    ) {
        self.service = service
        self.accessGroup = accessGroup
        self.accessibility = accessibility
    }

    public func read(account: String) async throws -> Data? {
        var query = baseQuery(account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw KeychainStoreError.unexpectedStatus(status) }
        guard let data = result as? Data else { throw KeychainStoreError.invalidData }
        return data
    }

    public func write(_ data: Data, account: String) async throws {
        var query = baseQuery(account: account)
        let attributes: [String: Any] = [kSecValueData as String: data]
        let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecItemNotFound {
            query[kSecValueData as String] = data
            query[kSecAttrAccessible as String] = accessibility
            let addStatus = SecItemAdd(query as CFDictionary, nil)
            guard addStatus == errSecSuccess else { throw KeychainStoreError.unexpectedStatus(addStatus) }
        } else if updateStatus != errSecSuccess {
            throw KeychainStoreError.unexpectedStatus(updateStatus)
        }
    }

    public func delete(account: String) async throws {
        let status = SecItemDelete(baseQuery(account: account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainStoreError.unexpectedStatus(status)
        }
    }

    private func baseQuery(account: String) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        return query
    }
}
