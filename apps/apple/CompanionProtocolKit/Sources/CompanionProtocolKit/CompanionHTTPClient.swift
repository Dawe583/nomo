import CryptoKit
import Foundation
import Network
import Security

public enum LocalNetworkError: Error, Equatable, Sendable {
    case endpointNotHTTPS
    case endpointNotLocal
    case invalidIdentity
    case invalidCertificateFingerprint
    case trustValidationFailed
}

public struct LocalNetworkIdentity: Equatable, Sendable {
    public let endpoint: URL
    public let executorId: String
    public let identityKeyId: String
    public let certificateSHA256: String

    public init(endpoint: URL, executorId: String, identityKeyId: String, certificateSHA256: String) throws {
        guard endpoint.scheme?.lowercased() == "https" else { throw LocalNetworkError.endpointNotHTTPS }
        guard Self.isLocalHost(endpoint.host) else { throw LocalNetworkError.endpointNotLocal }
        guard Self.isBoundedIdentity(executorId), Self.isBoundedIdentity(identityKeyId) else { throw LocalNetworkError.invalidIdentity }
        guard Self.isLowercaseSHA256(certificateSHA256) else { throw LocalNetworkError.invalidCertificateFingerprint }
        self.endpoint = endpoint
        self.executorId = executorId
        self.identityKeyId = identityKeyId
        self.certificateSHA256 = certificateSHA256
    }

    public static func isLowercaseSHA256(_ value: String) -> Bool {
        value.utf8.count == 64 && value.utf8.allSatisfy { byte in
            (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(byte)
                || (UInt8(ascii: "a")...UInt8(ascii: "f")).contains(byte)
        }
    }

    private static func isBoundedIdentity(_ value: String) -> Bool {
        !value.isEmpty && value.count <= 160 && !value.unicodeScalars.contains { $0.value < 0x20 || $0.value == 0x7f || $0 == "/" || $0 == "\\" }
    }

    private static func isLocalHost(_ rawHost: String?) -> Bool {
        guard let rawHost = rawHost?.lowercased(), !rawHost.isEmpty else { return false }
        let host = rawHost.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if host == "localhost" { return true }
        if host.hasSuffix(".local") {
            let labels = host.split(separator: ".", omittingEmptySubsequences: false)
            return labels.count >= 2 && labels.allSatisfy { !$0.isEmpty }
        }
        if let address = IPv6Address(host) {
            let canonical = String(describing: address).lowercased()
            if canonical == "::1" { return true }
            guard let first = canonical.split(separator: ":").first else { return false }
            let firstValue = Int(first, radix: 16) ?? -1
            return (firstValue & 0xffc0) == 0xfe80 || (firstValue & 0xfe00) == 0xfc00
        }
        if let address = IPv4Address(host) {
            let octets = String(describing: address).split(separator: ".").compactMap { Int($0) }
            guard octets.count == 4 else { return false }
            let first = octets[0]
            let second = octets[1]
            return first == 10 || first == 127 || (first == 192 && second == 168) || (first == 172 && (16...31).contains(second))
        }
        return false
    }
}

public final class PinnedTLSDelegate: NSObject, URLSessionDelegate, @unchecked Sendable {
    private let fingerprint: String

    public init(fingerprint: String) {
        self.fingerprint = fingerprint
    }

    public func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        let host = challenge.protectionSpace.host
        let policy = SecPolicyCreateSSL(true, host as CFString)
        if SecTrustSetPolicies(trust, [policy] as CFArray) == errSecSuccess,
           SecTrustEvaluateWithError(trust, nil),
           let certificates = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
           let certificate = certificates.first,
           let certificateData = SecCertificateCopyData(certificate) as Data?,
           SHA256.hash(data: certificateData).map({ String(format: "%02x", $0) }).joined() == fingerprint {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }
}

public protocol HTTPTransport: Sendable {
    var boundEndpoint: URL { get }
    func data(for request: URLRequest) async throws -> (Data, URLResponse)
}

public final class URLSessionTransport: NSObject, HTTPTransport, @unchecked Sendable {
    public let boundEndpoint: URL
    private let session: URLSession

    public init(identity: LocalNetworkIdentity, sessionConfiguration: URLSessionConfiguration = .ephemeral) {
        let configuration = sessionConfiguration.copy() as! URLSessionConfiguration
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 30
        let delegate = PinnedTLSDelegate(fingerprint: identity.certificateSHA256)
        self.boundEndpoint = identity.endpoint
        self.session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
        super.init()
    }

    public func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        guard request.url == boundEndpoint else { throw CompanionHTTPError.endpointMismatch }
        return try await session.data(for: request)
    }
}

public enum CompanionHTTPError: Error, Equatable, Sendable {
    case invalidRequest
    case invalidResponse
    case identityMismatch
    case endpointMismatch
    case transportFailure
}

public struct CompanionHTTPClient: Sendable {
    public static let maxRequestBytes = 65_536
    public static let maxResponseBytes = 1_048_576

    /// Pairing is here because it issues a device credential: it is a mutation
    /// even though it is the one call an unpaired device may make, and it
    /// carries the same stable idempotency key across retries.
    private static let mutatingOperations: Set<String> = [
        "session.create", "session.send", "session.cancel", "approval.decide", "recovery.apply", "device.revoke",
        CompanionPairingRequest.operation,
    ]
    private let transport: any HTTPTransport
    private let encoder: JSONEncoder
    private let decoder = JSONDecoder()

    public init(transport: any HTTPTransport) {
        self.transport = transport
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        self.encoder = encoder
    }

    /// The identity a response must echo. A credentialed operation has to see
    /// its own device and workspace back, because the server derives both from
    /// the credential and any other value would be a different authority.
    /// Pairing has none to see, so its echo is checked for boundedness instead.
    private enum ExpectedIdentity {
        case credentialed(deviceId: String, workspaceId: String)
        case pairing
    }

    public func send(
        _ companionRequest: CompanionRequest,
        authorizationProvider: (@Sendable () async throws -> String?)? = nil
    ) async throws -> CompanionResponse {
        guard companionRequest.protocolIdentifier == CompanionProtocol.identifier,
              companionRequest.schemaVersion == CompanionProtocol.schemaVersion,
              companionRequest.kind == "request",
              Self.isBoundedID(companionRequest.requestId),
              Self.isBoundedID(companionRequest.operationId),
              Self.isBoundedID(companionRequest.deviceId),
              Self.isBoundedID(companionRequest.workspaceId),
              companionRequest.sessionId.map(Self.isBoundedID) ?? true,
              Self.isBoundedID(companionRequest.operation),
              Self.isBoundedID(companionRequest.idempotencyKey ?? "read"),
              Self.validateEnvelope(
                  issuedAt: companionRequest.issuedAt,
                  expiresAt: companionRequest.expiresAt,
                  bodyDigest: companionRequest.bodyDigest,
                  body: companionRequest.body
              ) else {
            throw CompanionHTTPError.invalidRequest
        }
        let body = try encoder.encode(companionRequest)
        guard body.count <= Self.maxRequestBytes else { throw CompanionHTTPError.invalidRequest }
        if Self.mutatingOperations.contains(companionRequest.operation), companionRequest.idempotencyKey?.isEmpty != false {
            throw CompanionHTTPError.invalidRequest
        }
        return try await perform(
            body,
            expected: .credentialed(deviceId: companionRequest.deviceId, workspaceId: companionRequest.workspaceId),
            requestId: companionRequest.requestId,
            operationId: companionRequest.operationId,
            operation: companionRequest.operation,
            authorizationProvider: authorizationProvider
        )
    }

    /// `device.pair` is sent without a device and a workspace, because an
    /// unpaired device has neither and the executor derives both. No
    /// authorization provider is accepted: there is no credential to present,
    /// and presenting one would be the only way to make a pairing answer look
    /// like an authenticated one.
    public func pair(_ pairingRequest: CompanionPairingRequest) async throws -> CompanionResponse {
        guard pairingRequest.protocolIdentifier == CompanionProtocol.identifier,
              pairingRequest.schemaVersion == CompanionProtocol.schemaVersion,
              pairingRequest.kind == "request",
              pairingRequest.operation == CompanionPairingRequest.operation,
              Self.isBoundedID(pairingRequest.requestId),
              Self.isBoundedID(pairingRequest.operationId),
              Self.isBoundedID(pairingRequest.idempotencyKey),
              Self.mutatingOperations.contains(pairingRequest.operation),
              Self.validateEnvelope(
                  issuedAt: pairingRequest.issuedAt,
                  expiresAt: pairingRequest.expiresAt,
                  bodyDigest: pairingRequest.bodyDigest,
                  body: pairingRequest.body
              ) else {
            throw CompanionHTTPError.invalidRequest
        }
        let body = try encoder.encode(pairingRequest)
        guard body.count <= Self.maxRequestBytes else { throw CompanionHTTPError.invalidRequest }
        return try await perform(
            body,
            expected: .pairing,
            requestId: pairingRequest.requestId,
            operationId: pairingRequest.operationId,
            operation: pairingRequest.operation,
            authorizationProvider: nil
        )
    }

    private func perform(
        _ body: Data,
        expected: ExpectedIdentity,
        requestId: String,
        operationId: String,
        operation: String,
        authorizationProvider: (@Sendable () async throws -> String?)?
    ) async throws -> CompanionResponse {
        var request = URLRequest(url: transport.boundEndpoint)
        request.httpMethod = "POST"
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let authorizationProvider, let token = try await authorizationProvider() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        do {
            let (data, response) = try await transport.data(for: request)
            // `outcome` is the single discriminator. A receipt and the error
            // that explains it are both legal, and the frozen `conflict`
            // fixture pairs them, so their presence together is not ambiguity.
            // What is not legal is a success that carries an error, or one that
            // arrives without the evidence a client would store as the result.
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode) || (400..<500).contains(httpResponse.statusCode),
                  httpResponse.statusCode == 200 || httpResponse.statusCode == 201 || httpResponse.statusCode == 202 || (400..<500).contains(httpResponse.statusCode),
                  data.count <= Self.maxResponseBytes else {
                throw CompanionHTTPError.invalidResponse
            }
            let decoded: CompanionResponse
            do { decoded = try decoder.decode(CompanionResponse.self, from: data) } catch { throw CompanionHTTPError.invalidResponse }
            // The envelope identity is checked before the payload, because an
            // answer for another request is never this request's result, and
            // reading its body first would be reading somebody else's receipt.
            guard decoded.protocolIdentifier == CompanionProtocol.identifier,
                  decoded.schemaVersion == CompanionProtocol.schemaVersion,
                  decoded.kind == "response",
                  decoded.httpStatus == httpResponse.statusCode,
                  (100...599).contains(decoded.httpStatus),
                  decoded.requestId == requestId,
                  decoded.operationId == operationId,
                  decoded.operation == operation else { throw CompanionHTTPError.identityMismatch }
            switch expected {
            case .credentialed(let deviceId, let workspaceId):
                guard decoded.deviceId == deviceId, decoded.workspaceId == workspaceId else { throw CompanionHTTPError.identityMismatch }
            case .pairing:
                guard decoded.deviceId.map(Self.isBoundedID) ?? true,
                      decoded.workspaceId.map(Self.isBoundedID) ?? true else { throw CompanionHTTPError.identityMismatch }
            }
            guard !(decoded.outcome == .succeeded && decoded.error != nil),
                  !(decoded.outcome == .succeeded && decoded.body == nil) else { throw CompanionHTTPError.invalidResponse }
            if case .pairing = expected { try Self.validatePairingReceipt(decoded) }
            return decoded
        } catch let error as CompanionHTTPError {
            throw error
        } catch {
            throw CompanionHTTPError.transportFailure
        }
    }

    /// A pairing that reports success has to carry the credential it issued. A
    /// success without one is a receipt the client cannot store, so it is
    /// refused here instead of being handed to a caller as a paired device.
    private static func validatePairingReceipt(_ response: CompanionResponse) throws {
        guard response.outcome == .succeeded else { return }
        guard case .object(let fields)? = response.body,
              case .string(let deviceId)? = fields["deviceId"], isBoundedID(deviceId),
              case .string(let token)? = fields["deviceToken"], token.count >= 32, token.count <= 128,
              case .string(let expiresAt)? = fields["expiresAt"], parseUTC(expiresAt) != nil else {
            throw CompanionHTTPError.invalidResponse
        }
    }

    /// The window and digest rules every request shares, whether it carries a
    /// device identity or mints one.
    private static func validateEnvelope(issuedAt: String, expiresAt: String, bodyDigest: String, body: JSONValue) -> Bool {
        guard isLowercaseSHA256(bodyDigest),
              digest(body) == bodyDigest,
              issuedAt.hasSuffix("Z"),
              expiresAt.hasSuffix("Z"),
              let issued = parseUTC(issuedAt),
              let expires = parseUTC(expiresAt) else { return false }
        return issued < expires
    }

    private static func parseUTC(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }

    private static func digest(_ body: JSONValue) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(body) else { return "" }
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private static func isBoundedID(_ value: String) -> Bool {
        !value.isEmpty && value.count <= 160 && !value.unicodeScalars.contains { $0.value < 0x20 || $0.value == 0x7f || $0 == "/" || $0 == "\\" }
    }

    private static func isLowercaseSHA256(_ value: String) -> Bool {
        value.utf8.count == 64 && value.utf8.allSatisfy { byte in
            (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(byte)
                || (UInt8(ascii: "a")...UInt8(ascii: "f")).contains(byte)
        }
    }
}
