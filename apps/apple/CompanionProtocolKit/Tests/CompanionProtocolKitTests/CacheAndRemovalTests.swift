import Foundation
import XCTest
@testable import CompanionProtocolKit

/// The cache and removal policy from matrix P06.05. The two properties that
/// matter are that nothing the executor answers survives on the device, and
/// that a removal leaves no credential behind.
final class CacheAndRemovalTests: XCTestCase {
    func testASessionBuiltByThisClientKeepsNoCacheAtAll() {
        // A cache that already holds an answer, which is the case that matters:
        // a `device.revoke` served from here is a mutation the client believes
        // happened and the executor never performed.
        let stale = URLCache(memoryCapacity: 1_048_576, diskCapacity: 0, directory: nil)
        let endpoint = URL(string: "https://void-mac.local:7443/api/companion/devices")!
        stale.storeCachedResponse(
            CachedURLResponse(response: URLResponse(url: endpoint, mimeType: "application/json", expectedContentLength: 2, textEncodingName: nil), data: Data("{}".utf8)),
            for: URLRequest(url: endpoint)
        )
        XCTAssertGreaterThan(stale.currentMemoryUsage + stale.currentDiskUsage, 0)

        let configuration = URLSessionConfiguration.default
        configuration.urlCache = stale
        configuration.httpCookieStorage = HTTPCookieStorage.shared
        configuration.requestCachePolicy = .useProtocolCachePolicy

        CompanionCachePolicy.apply(to: configuration)

        XCTAssertNil(configuration.urlCache, "a URL cache can replay a mutation the executor never performed")
        XCTAssertNil(configuration.httpCookieStorage)
        XCTAssertNil(configuration.urlCredentialStorage)
        XCTAssertFalse(configuration.httpShouldSetCookies)
        XCTAssertEqual(configuration.requestCachePolicy, .reloadIgnoringLocalCacheData)
        // The instance the caller still holds was emptied, not just unhooked.
        XCTAssertEqual(stale.currentMemoryUsage, 0)
        XCTAssertEqual(stale.diskCapacity, 0)
        XCTAssertEqual(stale.memoryCapacity, 0)
    }

    func testACachedTranscriptIsNonAuthoritativeAndCannotBecomeAMutation() async throws {
        let cache = TranscriptCache()
        let entry = try CachedTranscriptEntry(id: "event-3", sessionId: "session-a", occurredAt: "2026-09-26T10:03:00Z", text: "assistant: done")
        await cache.retain(entry)

        let stored = await cache.entries(for: "session-a")
        XCTAssertEqual(stored.count, 1)
        // A stored constant, not a value the caller chooses, so no decoder and
        // no call site can produce an entry that claims to be current.
        XCTAssertEqual(stored[0].authority, .nonAuthoritative)
        XCTAssertEqual(stored[0].text, "assistant: done")
        let authority = await cache.authority()
        XCTAssertEqual(authority, .nonAuthoritative)

        // The cache cannot produce a turn number, because nothing in it is
        // one. A relaunch starts at turn one, so the key it issues is not the
        // key the executor already honoured.
        let afterRelaunch = try ForwardMutationDraft(sessionId: "session-a", turn: TurnSequence(first: 1), text: "next")
        let cachedTurnKey = "\(entry.sessionId)-turn-3"
        XCTAssertNotEqual(afterRelaunch.idempotencyKey, cachedTurnKey)
        XCTAssertEqual(afterRelaunch.idempotencyKey, "session-a-turn-1")
    }

    func testTurnNumbersOnlyEverMoveForward() throws {
        let first = try TurnSequence()
        let second = first.next()
        let third = second.next()
        XCTAssertEqual([first.value, second.value, third.value], [1, 2, 3])
        XCTAssertLessThan(first, third)
        // A key reused for a different turn is the bug this stops, so two
        // successive turns must never collide.
        let a = try ForwardMutationDraft(sessionId: "s", turn: first, text: "one")
        let b = try ForwardMutationDraft(sessionId: "s", turn: second, text: "two")
        XCTAssertNotEqual(a.idempotencyKey, b.idempotencyKey)
        XCTAssertThrowsError(try TurnSequence(first: 0))
    }

    func testTheTranscriptCacheIsBoundedAndDropsTheOldestFirst() async throws {
        let cache = TranscriptCache()
        for index in 0..<(CompanionCachePolicy.maxRetainedEntries + 25) {
            await cache.retain(try CachedTranscriptEntry(id: "event-\(index)", sessionId: "s", occurredAt: "2026-09-26T10:00:00Z", text: "line \(index)"))
        }
        let kept = await cache.entries(for: "s")
        XCTAssertEqual(kept.count, CompanionCachePolicy.maxRetainedEntries)
        XCTAssertEqual(kept.first?.id, "event-25", "the cache kept the oldest activity instead of the most recent")
        XCTAssertEqual(kept.last?.id, "event-\(CompanionCachePolicy.maxRetainedEntries + 24)")

        // Re-retaining an id updates in place rather than stacking a duplicate,
        // which is what a replayed page would otherwise do.
        await cache.retain(try CachedTranscriptEntry(id: "event-25", sessionId: "s", occurredAt: "2026-09-26T11:00:00Z", text: "repaired"))
        let updated = await cache.entries(for: "s")
        XCTAssertEqual(updated.count, CompanionCachePolicy.maxRetainedEntries)
        XCTAssertEqual(updated.filter { $0.id == "event-25" }.count, 1)
        XCTAssertEqual(updated.first(where: { $0.id == "event-25" })?.text, "repaired")

        // A purge is total, and it is what a removal calls.
        await cache.purge()
        let afterPurge = await cache.count()
        XCTAssertEqual(afterPurge, 0)
    }

    func testEntriesFromAnotherSessionAreNeverMixedIn() async throws {
        let cache = TranscriptCache()
        await cache.retain(try CachedTranscriptEntry(id: "a", sessionId: "session-a", occurredAt: "2026-09-26T10:00:00Z", text: "a"))
        await cache.retain(try CachedTranscriptEntry(id: "b", sessionId: "session-b", occurredAt: "2026-09-26T10:00:00Z", text: "b"))
        let a = await cache.entries(for: "session-a")
        XCTAssertEqual(a.map(\.id), ["a"])
        let other = await cache.entries(for: "session-c")
        XCTAssertTrue(other.isEmpty)
    }

    func testRemovingTheDeviceDeletesTheCredentialFromTheKeychain() async throws {
        let keychain = RecordingKeychain()
        let store = KeychainDeviceCredentialStore(keychain: keychain)
        let cache = TranscriptCache()
        await cache.retain(try CachedTranscriptEntry(id: "a", sessionId: "s", occurredAt: "2026-09-26T10:00:00Z", text: "a"))
        await cache.retain(try CachedTranscriptEntry(id: "b", sessionId: "s", occurredAt: "2026-09-26T10:01:00Z", text: "b"))

        let credential = try DeviceCredential(deviceId: "device-remove-001", workspaceId: "workspace-a", token: String(repeating: "r", count: 43), issuedAt: "2026-09-26T10:00:00Z", expiresAt: "2026-09-26T10:15:00Z")
        try await store.save(credential)
        let storedCredential = try await store.load()
        XCTAssertNotNil(storedCredential)

        let revoked = Recorder()
        let service = DeviceRemovalService(credentials: store, transcript: cache) { removed in
            revoked.record(removed.deviceId)
            return true
        }
        let receipt = try await service.removeStoredDevice()

        // The executor was told.
        XCTAssertEqual(revoked.values, ["device-remove-001"])
        XCTAssertTrue(receipt.executorConfirmed)
        XCTAssertTrue(receipt.credentialDeleted)
        XCTAssertEqual(receipt.deviceId, "device-remove-001")
        // Nothing is left that could authorise a later request, and the
        // transcript this app was showing is gone with it.
        let readBack = try await store.load()
        XCTAssertNil(readBack)
        let entriesLeft = await cache.count()
        XCTAssertEqual(entriesLeft, 0)
        XCTAssertEqual(receipt.transcriptEntriesDiscarded, 2)
        // The Keychain was actually written to, rather than the store simply
        // forgetting it had one.
        XCTAssertEqual(keychain.deletedAccounts, [KeychainDeviceCredentialStore.credentialAccount])
    }

    func testRemovingTheDeviceStillDeletesTheCredentialWhenTheExecutorIsUnreachable() async throws {
        let keychain = RecordingKeychain()
        let store = KeychainDeviceCredentialStore(keychain: keychain)
        let cache = TranscriptCache()
        try await store.save(try DeviceCredential(deviceId: "device-offline-001", workspaceId: "workspace-a", token: String(repeating: "o", count: 43), issuedAt: "2026-09-26T10:00:00Z", expiresAt: "2026-09-26T10:15:00Z"))

        struct ExecutorDown: Error {}
        let service = DeviceRemovalService(credentials: store, transcript: cache) { _ in throw ExecutorDown() }
        let receipt = try await service.removeStoredDevice()

        // The local removal happened anyway, because leaving the credential
        // behind is the one outcome the path exists to prevent. The receipt
        // does not claim the executor was told.
        let readBack = try await store.load()
        XCTAssertNil(readBack)
        XCTAssertFalse(receipt.executorConfirmed)
        XCTAssertTrue(receipt.credentialDeleted)
    }

    func testRemovingTwiceIsTheSameAsRemovingOnce() async throws {
        let store = KeychainDeviceCredentialStore(keychain: RecordingKeychain())
        let cache = TranscriptCache()
        await cache.retain(try CachedTranscriptEntry(id: "a", sessionId: "s", occurredAt: "2026-09-26T10:00:00Z", text: "a"))
        let calls = Recorder()
        let service = DeviceRemovalService(credentials: store, transcript: cache) { _ in
            calls.bump()
            return true
        }
        try await store.save(try DeviceCredential(deviceId: "device-twice-001", workspaceId: "workspace-a", token: String(repeating: "t", count: 43), issuedAt: "2026-09-26T10:00:00Z", expiresAt: "2026-09-26T10:15:00Z"))

        let first = try await service.removeStoredDevice()
        let second = try await service.removeStoredDevice()
        XCTAssertEqual(first.deviceId, "device-twice-001")
        XCTAssertEqual(second.deviceId, "", "a second removal has no device left to name")
        XCTAssertTrue(second.credentialDeleted)
        XCTAssertEqual(calls.calls, 1, "the executor was asked to revoke a device that no longer exists here")
        let readBack = try await store.load()
        XCTAssertNil(readBack)
    }

    func testARemovalThatCannotDeleteTheCredentialReportsFailureRatherThanSuccess() async throws {
        final class FailingStore: DeviceCredentialStore {
            func save(_ credential: DeviceCredential) async throws {}
            func load() async throws -> DeviceCredential? {
                try DeviceCredential(deviceId: "device-x", workspaceId: "w", token: String(repeating: "x", count: 43), issuedAt: "2026-09-26T10:00:00Z", expiresAt: "2026-09-26T10:15:00Z")
            }
            func remove() async throws { throw DeviceCredentialError.storageUnavailable(errSecInteractionNotAllowed) }
        }
        let service = DeviceRemovalService(credentials: FailingStore(), transcript: TranscriptCache()) { _ in true }
        do {
            _ = try await service.removeStoredDevice()
            XCTFail("a removal that kept the credential reported success")
        } catch {
            XCTAssertEqual(error as? DeviceRemovalError, .credentialUnavailable)
        }
    }

    func testThePolicyIsStatedForTheOperatorInBothLanguages() {
        // The policy is not only a comment: it is the sentence the Settings
        // screen shows, and it says the three things the code does.
        let summary = CompanionCachePolicy.operatorSummary
        for clause in ["in memory", "never used to decide", "deletes the pairing credential"] {
            XCTAssertTrue(summary.contains(clause), clause)
        }
    }
}

/// A Keychain double that records what it was asked to do, so a removal test
/// can prove the credential was deleted rather than merely forgotten. It is
/// deliberately unlocked: a test drives it from one task, and `NSLock` is
/// unavailable from an async context on Darwin.
private final class RecordingKeychain: KeychainStore, @unchecked Sendable {
    private var items: [String: Data] = [:]
    private(set) var deletedAccounts: [String] = []

    func read(account: String) async throws -> Data? { items[account] }
    func write(_ data: Data, account: String) async throws { items[account] = data }
    func delete(account: String) async throws {
        deletedAccounts.append(account)
        items[account] = nil
    }
}

/// A test-only accumulator for the revocation calls a removal made.
private final class Recorder: @unchecked Sendable {
    private(set) var values: [String] = []
    private(set) var calls = 0
    func record(_ value: String) { values.append(value) }
    func bump() { calls += 1 }
}
