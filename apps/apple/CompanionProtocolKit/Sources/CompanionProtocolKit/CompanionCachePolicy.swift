import Foundation

/// The companion client's cache policy, in one place.
///
/// The policy has three parts, and each exists because of a way a cached
/// response can lie about a mutation:
///
/// 1. **No response is ever served from a cache.** The URL cache, the cookie
///    store, the credential store, and the disk capacity are all switched off
///    for every session this client makes. A `device.revoke` or a
///    `device.pair` that came back from a disk cache would be a mutation the
///    client believes happened and the executor never performed.
/// 2. **A transcript is retained in memory, for this process only, and is
///    never authoritative.** Every entry is stamped
///    `TranscriptAuthority.nonAuthoritative` and carries the instant it was
///    captured. It is a picture of the past shown while the executor is
///    unreachable; it is never evidence that an operation is still running,
///    still pending, or still reversible.
/// 3. **Removal leaves nothing.** Removing this device deletes the Keychain
///    credential, empties the transcript cache, and purges the shared URL cache
///    and cookie store, because a shared cache survives the process that wrote
///    it and the next process would otherwise read a response that the
///    revocation just made false.
public enum CompanionCachePolicy {
    /// The policy in the words the Settings screen shows the operator.
    public static let operatorSummary = """
        Nothing a paired executor answers is stored on this device. \
        Conversation history is kept in memory only while the app is open, \
        is labelled as past activity rather than current state, and is never \
        used to decide what to do next. Removing this device deletes the \
        pairing credential and clears everything this app has cached.
        """

    /// The retention bound for an in-memory transcript: one screen of recent
    /// activity, oldest first out. A device that has been offline for a week
    /// does not accumulate a week of unbacked history that later reads as
    /// though the executor still owed those turns.
    public static let maxRetainedEntries = 200

    public static func apply(to configuration: URLSessionConfiguration) {
        // A cache that was handed in is emptied rather than merely dropped: a
        // caller elsewhere in the app may still be holding the same instance,
        // and a response it wrote before the policy ran is a response the
        // revocation may already have made false.
        if let existing = configuration.urlCache {
            existing.removeAllCachedResponses()
            existing.diskCapacity = 0
            existing.memoryCapacity = 0
        }
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    }

    /// Empty the caches the process does not own. A session built by this
    /// policy cannot write them, but a session built elsewhere in the app, or
    /// by a URL loading system default, can, and a removal that left them
    /// would be a removal that did not remove.
    public static func purgeSharedCaches() {
        URLCache.shared.removeAllCachedResponses()
        HTTPCookieStorage.shared.cookies?.forEach(HTTPCookieStorage.shared.deleteCookie)
    }
}

/// Whether anything this client shows may be treated as the current state of a
/// mutation. There is exactly one case, and it is the answer for a transcript
/// read out of memory: nothing this client caches is ever authoritative.
public enum TranscriptAuthority: String, Codable, Equatable, Sendable {
    case nonAuthoritative
}

/// One retained conversation entry.
public struct CachedTranscriptEntry: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let sessionId: String
    /// The executor's own stamp for the event, kept so the entry can be shown
    /// as "at 11:04" rather than as "now".
    public let occurredAt: String
    public let text: String
    /// Always `nonAuthoritative`. It is a stored constant rather than a
    /// parameter so that no code path, including a decoder, can produce an
    /// entry that claims authority it does not have.
    public let authority: TranscriptAuthority

    public init(id: String, sessionId: String, occurredAt: String, text: String) throws {
        guard !id.isEmpty, id.count <= 160, !sessionId.isEmpty, sessionId.count <= 160,
              !text.isEmpty, text.count <= 32_768,
              occurredAt.hasSuffix("Z") else { throw TranscriptCacheError.malformedEntry }
        self.id = id
        self.sessionId = sessionId
        self.occurredAt = occurredAt
        self.text = text
        self.authority = .nonAuthoritative
    }
}

public enum TranscriptCacheError: Error, Equatable, Sendable {
    case malformedEntry
}

/// The in-memory transcript cache.
///
/// It is an actor so that the read-modify-write of `retain` is atomic against a
/// view that is still reading, and it holds nothing after the process ends. It
/// has no `Codable` conformance on the container and no persistence hook, so
/// there is no path by which an entry reaches disk.
public actor TranscriptCache {
    private var entries: [CachedTranscriptEntry] = []

    public init() {}

    public func retain(_ entry: CachedTranscriptEntry) {
        entries.removeAll { $0.id == entry.id }
        entries.append(entry)
        // Bounded by age, not by size alone: the oldest entries leave first so
        // an offline device keeps the most recent activity rather than the
        // first activity it ever saw.
        if entries.count > CompanionCachePolicy.maxRetainedEntries {
            entries.removeFirst(entries.count - CompanionCachePolicy.maxRetainedEntries)
        }
    }

    public func entries(for sessionId: String) -> [CachedTranscriptEntry] {
        entries.filter { $0.sessionId == sessionId }
    }

    public func count() -> Int { entries.count }

    /// What a caller may conclude from the cache. It is a list and nothing
    /// else: there is deliberately no method that reports whether an operation
    /// is running, pending, or reversible, because the cache cannot know.
    public func authority() -> TranscriptAuthority { .nonAuthoritative }

    public func purge() {
        entries.removeAll()
    }
}

/// A turn number for a forward mutation.
///
/// The idempotency key of a turn is derived from this and from the session, and
/// the value is produced only by `next()`. It cannot be reconstructed from a
/// cache, because nothing in the cache carries one: that is what stops a
/// relaunch from re-issuing a key the executor already honoured, which would
/// collapse a new turn into the old one instead of failing as a conflict.
public struct TurnSequence: Equatable, Sendable, Comparable {
    public let value: Int

    public init(first: Int = 1) throws {
        guard first >= 1 else { throw TranscriptCacheError.malformedEntry }
        self.value = first
    }

    public static func < (lhs: TurnSequence, rhs: TurnSequence) -> Bool { lhs.value < rhs.value }

    public func next() -> TurnSequence {
        // Overflow here would mean a session that has run for longer than the
        // process can count, which is not reachable; clamping to the top of the
        // range keeps a key from silently wrapping onto an earlier turn.
        TurnSequence(unchecked: value == Int.max ? value : value + 1)
    }

    private init(unchecked value: Int) { self.value = value }
}

/// A forward mutation composed from live input.
///
/// The only initializer takes a `TurnSequence`, which the cache cannot produce.
/// There is no initializer that accepts a `CachedTranscriptEntry`, so no cached
/// history can reach a mutation by any route.
public struct ForwardMutationDraft: Equatable, Sendable {
    public let sessionId: String
    public let idempotencyKey: String
    public let text: String

    public init(sessionId: String, turn: TurnSequence, text: String) throws {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !sessionId.isEmpty, sessionId.count <= 160,
              !trimmed.isEmpty, trimmed.count <= 32_768 else { throw TranscriptCacheError.malformedEntry }
        self.sessionId = sessionId
        self.idempotencyKey = "\(sessionId)-turn-\(turn.value)"
        self.text = trimmed
    }
}

/// What removing this device did, so the operator is told the truth about what
/// is gone rather than being asked to trust it.
public struct DeviceRemovalReceipt: Equatable, Sendable {
    public let deviceId: String
    /// Whether the executor confirmed the revocation. `false` means the device
    /// was removed locally and the executor was unreachable, which is a
    /// different and weaker claim and is reported as such.
    public let executorConfirmed: Bool
    public let credentialDeleted: Bool
    public let transcriptEntriesDiscarded: Int
    public let sharedCachesPurged: Bool
}

public enum DeviceRemovalError: Error, Equatable, Sendable {
    case credentialUnavailable
}

/// Removing this device from the paired set.
///
/// The order is the contract: the executor is told first, so that a successful
/// local removal is never a removal the executor still considers live; the
/// credential is deleted next, because a credential that outlives the removal
/// is the one thing this path exists to prevent; and the caches are emptied
/// last, because a cache entry is the one artefact that would let a later
/// process read an answer the revocation has just made false.
public struct DeviceRemovalService: Sendable {
    private let credentials: any DeviceCredentialStore
    private let transcript: TranscriptCache
    private let revoke: @Sendable (DeviceCredential) async throws -> Bool

    public init(
        credentials: any DeviceCredentialStore,
        transcript: TranscriptCache,
        revoke: @escaping @Sendable (DeviceCredential) async throws -> Bool
    ) {
        self.credentials = credentials
        self.transcript = transcript
        self.revoke = revoke
    }

    /// Remove the device named by the stored credential. Calling it twice is
    /// the same as calling it once: the second call finds no credential, clears
    /// an already-empty cache, and reports that the executor was not asked,
    /// because there was nothing left to tell it about.
    public func removeStoredDevice() async throws -> DeviceRemovalReceipt {
        guard let credential = try await credentials.load() else {
            let discarded = await transcript.count()
            await transcript.purge()
            CompanionCachePolicy.purgeSharedCaches()
            return DeviceRemovalReceipt(
                deviceId: "",
                executorConfirmed: false,
                credentialDeleted: true,
                transcriptEntriesDiscarded: discarded,
                sharedCachesPurged: true
            )
        }
        // A failure to reach the executor is not a failure to remove: the local
        // credential is deleted either way, because leaving it would leave the
        // authority behind. The receipt says which of the two happened.
        let confirmed = (try? await revoke(credential)) ?? false
        do {
            try await credentials.remove()
        } catch {
            throw DeviceRemovalError.credentialUnavailable
        }
        let discarded = await transcript.count()
        await transcript.purge()
        CompanionCachePolicy.purgeSharedCaches()
        return DeviceRemovalReceipt(
            deviceId: credential.deviceId,
            executorConfirmed: confirmed,
            credentialDeleted: true,
            transcriptEntriesDiscarded: discarded,
            sharedCachesPurged: true
        )
    }
}
