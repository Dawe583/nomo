import Foundation

public struct EventCursor: Codable, Equatable, Sendable, CustomStringConvertible {
    public let rawValue: String
    public var description: String { rawValue }

    public init(_ rawValue: String) throws {
        self.rawValue = try Self.validate(rawValue)
    }

    public init(rawValue: String) throws {
        self.rawValue = try Self.validate(rawValue)
    }

    public init(validating rawValue: String) throws {
        self.rawValue = try Self.validate(rawValue)
    }

    private static func validate(_ value: String) throws -> String {
        guard !value.isEmpty,
              value.utf8.allSatisfy({ (UInt8(ascii: "0")...UInt8(ascii: "9")).contains($0) }),
              let number = UInt64(value),
              number <= UInt64(9_007_199_254_740_991) else {
            throw ProtocolContractError.invalidCursor
        }
        return value
    }
}

public struct EventScope: Codable, Equatable, Sendable {
    public let workspaceId: String
    public let sessionId: String

    public init(workspaceId: String, sessionId: String) {
        self.workspaceId = workspaceId
        self.sessionId = sessionId
    }
}

public struct CompanionEvent: Codable, Equatable, Sendable {
    public let id: String
    public let sessionId: String
    public let runId: String?
    public let seq: Int
    public let at: String
    public let type: String
    public let kind: String
    public let schemaVersion: Int
    public let summary: String?
    public let metadata: [String: JSONValue]?

    public init(
        id: String,
        sessionId: String,
        runId: String? = nil,
        seq: Int,
        at: String,
        type: String,
        kind: String,
        schemaVersion: Int,
        summary: String? = nil,
        metadata: [String: JSONValue]? = nil
    ) {
        self.id = id
        self.sessionId = sessionId
        self.runId = runId
        self.seq = seq
        self.at = at
        self.type = type
        self.kind = kind
        self.schemaVersion = schemaVersion
        self.summary = summary
        self.metadata = metadata
    }
}

public struct EventPage: Codable, Equatable, Sendable {
    public static let maxItems = 1_000
    public static let maxEncodedBytes = 1_048_576
    public static let maxEventBytes = 32_768
    public static let maxReplayWindow: TimeInterval = 15 * 60

    public let items: [CompanionEvent]
    public let after: String
    public let nextAfter: String?
    public let hasMore: Bool
    public let historyComplete: Bool
    public let scope: EventScope
    public let asOf: String
    public let replayExpiresAt: String

    public init(
        items: [CompanionEvent],
        after: String,
        nextAfter: String?,
        hasMore: Bool,
        historyComplete: Bool,
        scope: EventScope,
        asOf: String,
        replayExpiresAt: String
    ) throws {
        let afterCursor = try EventCursor(validating: after)
        let afterNumber = Int(afterCursor.rawValue)!
        let nextCursor = try nextAfter.map(EventCursor.init(validating:))
        let nextAfterNumber = nextCursor.flatMap { Int($0.rawValue) }
        guard items.count <= Self.maxItems,
              Self.isBoundedID(scope.workspaceId),
              Self.isBoundedID(scope.sessionId),
              !hasMore || nextAfter != nil,
              let asOfDate = Self.parseUTCTimestamp(asOf),
              let replayExpiresAtDate = Self.parseUTCTimestamp(replayExpiresAt),
              replayExpiresAtDate > asOfDate,
              replayExpiresAtDate.timeIntervalSince(asOfDate) <= Self.maxReplayWindow else {
            throw ProtocolContractError.invalidEventPage
        }
        var previous: Int? = afterNumber
        for event in items {
            guard event.sessionId == scope.sessionId,
                  Self.parseUTCTimestamp(event.at) != nil else {
                throw ProtocolContractError.invalidEventPage
            }
            if let workspace = event.metadata?["workspaceId"] {
                guard workspace == .string(scope.workspaceId) else { throw ProtocolContractError.invalidEventPage }
            }
            guard event.seq >= 0,
                  event.seq <= 9_007_199_254_740_991,
                  previous == nil || event.seq > previous! else {
                throw ProtocolContractError.invalidEventPage
            }
            previous = event.seq
            if let data = try? JSONEncoder().encode(event), data.count > Self.maxEventBytes {
                throw ProtocolContractError.eventTooLarge
            }
        }
        if let nextAfterNumber {
            let boundary = items.last?.seq ?? afterNumber
            guard hasMore ? nextAfterNumber > boundary : nextAfterNumber >= boundary else {
                throw ProtocolContractError.invalidEventPage
            }
        }
        self.nextAfter = nextAfter
        self.items = items
        self.after = after
        self.hasMore = hasMore
        self.historyComplete = historyComplete
        self.scope = scope
        self.asOf = asOf
        self.replayExpiresAt = replayExpiresAt
    }

    public func decoded(from data: Data) throws -> EventPage {
        guard data.count <= Self.maxEncodedBytes else { throw ProtocolContractError.eventPageTooLarge }
        do { return try JSONDecoder().decode(EventPage.self, from: data) } catch {
            throw ProtocolContractError.invalidEventPage
        }
    }
    private static func isBoundedID(_ value: String) -> Bool {
        !value.isEmpty && value.count <= 160 && !value.unicodeScalars.contains { $0.value < 0x20 || $0.value == 0x7f || $0 == "/" || $0 == "\\" }
    }

    private static func parseUTCTimestamp(_ value: String) -> Date? {
        guard value.hasSuffix("Z") else { return nil }
        return try? Date(value, strategy: .iso8601)
    }
}


extension EventPage {
    private enum CodingKeys: String, CodingKey {
        case items, after, nextAfter, hasMore, historyComplete, scope, asOf, replayExpiresAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(
            items: container.decode([CompanionEvent].self, forKey: .items),
            after: container.decode(String.self, forKey: .after),
            nextAfter: container.decodeIfPresent(String.self, forKey: .nextAfter),
            hasMore: container.decode(Bool.self, forKey: .hasMore),
            historyComplete: container.decode(Bool.self, forKey: .historyComplete),
            scope: container.decode(EventScope.self, forKey: .scope),
            asOf: container.decode(String.self, forKey: .asOf),
            replayExpiresAt: container.decode(String.self, forKey: .replayExpiresAt)
        )
    }
}
