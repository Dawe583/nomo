import Foundation

/// Why a stream stopped, and whether reconnecting could help.
public enum EventStreamFailure: Equatable, Sendable {
    /// The socket or the request failed. Reconnecting is allowed.
    case transport
    /// The executor answered that this credential is no longer good. No
    /// number of reconnects changes that, so this is terminal and the client
    /// has to re-pair.
    case credentialRefused
    /// The cursor the client held is outside the replay window, so the events
    /// it would resume from are gone. Reconnecting from the same cursor would
    /// silently skip them, so it is terminal.
    case replayWindowExpired
}

public enum EventReconnectReason: String, Equatable, Sendable {
    case transportFailure
    case credentialRevoked
    case replayWindowExpired
    case streamBudgetExhausted
    case attemptsExhausted
    case operatorStopped
}

/// What the caller should do next. There is no case here that can dispatch a
/// mutation, and there is no way to add one without changing this type, which is
/// the point: a reconnect is a read, and the only thing a client is allowed to
/// do about an uncertain forward mutation is ask what happened.
public enum EventReconnectDecision: Equatable, Sendable {
    /// Fetch one page strictly after the cursor. A read.
    case fetchPage(after: EventCursor?)
    /// Look up a dispatched operation. A read.
    case reconcile(operationId: String)
    /// Stop, and say why.
    case stop(EventReconnectReason)
}

public struct EventReconnectPolicy: Equatable, Sendable {
    /// The frozen `limits.maxStreamSeconds`. A stream that has been open that
    /// long is closed and a fresh one is opened, so a long-lived stream cannot
    /// become a permanent subscription to somebody else's workspace.
    public let maxStreamSeconds: Int
    /// The attempts one interruption may spend before the client gives up and
    /// shows the operator a disconnected state instead of retrying forever.
    public let maxAttempts: Int

    public init(limits: ProtocolLimits) {
        self.init(maxStreamSeconds: limits.maxStreamSeconds, maxAttempts: 3)
    }

    public init(maxStreamSeconds: Int, maxAttempts: Int) {
        self.maxStreamSeconds = maxStreamSeconds
        self.maxAttempts = maxAttempts
    }
}

/// The bounded reconnect for one event stream.
///
/// It is a state machine rather than a loop so that the bound is a decision the
/// client can be asked about and tested, not a timer that happens to fire. The
/// clock is injected because the bound is the whole feature: a test that
/// cannot move the clock cannot prove it.
public struct EventReconnector: Sendable {
    public private(set) var cursor: EventCursor?
    public private(set) var attempts: Int
    public private(set) var openedAt: Date
    public private(set) var reason: EventReconnectReason?

    private let policy: EventReconnectPolicy
    private let now: @Sendable () -> Date

    public init(policy: EventReconnectPolicy, from cursor: EventCursor? = nil, now: @escaping @Sendable () -> Date = { Date() }) {
        self.policy = policy
        self.cursor = cursor
        self.attempts = 0
        self.openedAt = now()
        self.reason = nil
        self.now = now
    }

    public mutating func opened(at instant: Date) {
        openedAt = instant
    }

    /// Advance the page cursor after a page that was accepted. The reconnect
    /// resumes from here, so a page that arrived is never fetched twice.
    public mutating func advanced(to cursor: EventCursor) {
        self.cursor = cursor
    }

    /// What to do after a stream ended. `nil` is the first open, not a
    /// failure; every later call is a decision about reconnecting.
    public mutating func next(after failure: EventStreamFailure?) -> EventReconnectDecision {
        // A reconnector that has stopped stays stopped. A caller that keeps
        // asking after a revocation must not be handed a fresh page fetch,
        // which is how a revoked device would keep reading a workspace it has
        // already been refused.
        if let reason { return .stop(reason) }
        guard let failure else { return .fetchPage(after: cursor) }
        switch failure {
        case .credentialRefused:
            return stop(.credentialRevoked)
        case .replayWindowExpired:
            return stop(.replayWindowExpired)
        case .transport:
            break
        }
        attempts += 1
        if attempts > policy.maxAttempts { return stop(.attemptsExhausted) }
        if now().timeIntervalSince(openedAt) >= TimeInterval(policy.maxStreamSeconds) { return stop(.streamBudgetExhausted) }
        return .fetchPage(after: cursor)
    }

    private mutating func stop(_ reason: EventReconnectReason) -> EventReconnectDecision {
        self.reason = reason
        return .stop(reason)
    }
}

/// A forward mutation the client cannot resolve on its own.
///
/// The runtime's rule is that an unknown or uncertain outcome is never retried
/// automatically, so the client may not undermine it by re-sending. The only
/// thing the client may do is ask, and this type is what it asks with.
public struct UnsettledMutation: Equatable, Sendable {
    public let operationId: String
    public let idempotencyKey: String

    public init(operationId: String, idempotencyKey: String) throws {
        guard !operationId.isEmpty, operationId.count <= 160,
              !idempotencyKey.isEmpty, idempotencyKey.count <= 160 else {
            throw EventReconnectError.malformedIdentity
        }
        self.operationId = operationId
        self.idempotencyKey = idempotencyKey
    }
}

public enum EventReconnectError: Error, Equatable, Sendable {
    case malformedIdentity
}

/// How the client resolves an uncertain mutation.
///
/// Every case is a read. There is no `.resend` case, and adding one is a
/// change to this enum rather than a call site, so the "never retry an unknown
/// outcome" rule is enforced by the type and can be asserted in a test.
public enum MutationResolution: Equatable, Sendable {
    /// Ask for the durable status of the operation.
    case lookUpStatus(of: UnsettledMutation)
    /// The executor already answered, so nothing is outstanding.
    case alreadySettled(outcome: CompanionOutcome)
    /// The credential is gone, so the lookup is not available either.
    case requiresRePair
}
