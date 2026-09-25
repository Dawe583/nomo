import Foundation

public struct SanitizedDiagnostic: Codable, Equatable, Sendable {
    public let code: String
    public let message: String
    public let requestId: String?
    public let operationId: String?
    public let sessionId: String?

    public init(code: String, message: String, requestId: String? = nil, operationId: String? = nil, sessionId: String? = nil) {
        self.code = String(code.prefix(80))
        self.message = "diagnostic"
        self.requestId = Self.safeID(requestId)
        self.operationId = Self.safeID(operationId)
        self.sessionId = Self.safeID(sessionId)
    }

    private static func safeID(_ value: String?) -> String? {
        guard let value, !value.isEmpty, value.count <= 160 else { return nil }
        for scalar in value.unicodeScalars {
            if scalar.value < 0x20 || scalar.value == 0x7f || scalar == "/" || scalar == "\\" { return nil }
        }
        return value
    }
}

public enum DiagnosticSanitizer {
    public static func diagnostic(
        code: String,
        error: Error? = nil,
        requestId: String? = nil,
        operationId: String? = nil,
        sessionId: String? = nil
    ) -> SanitizedDiagnostic {
        SanitizedDiagnostic(code: code, message: "diagnostic", requestId: requestId, operationId: operationId, sessionId: sessionId)
    }
}
