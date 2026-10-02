import XCTest
import CompanionProtocolKit
@testable import VOID

private actor InMemoryDeviceCredentialStore: DeviceCredentialStore {
    private var credential: DeviceCredential?

    init(credential: DeviceCredential?) {
        self.credential = credential
    }

    func save(_ credential: DeviceCredential) async throws {
        self.credential = credential
    }

    func load() async throws -> DeviceCredential? {
        credential
    }

    func remove() async throws {
        credential = nil
    }
}

@MainActor
final class VOIDAppTests: XCTestCase {
    func testInitialStateIsTruthfullyOffline() {
        let model = AppModel()
        XCTAssertEqual(model.connectionState, .offline)
        XCTAssertEqual(model.executorName, "No executor selected")
    }

    func testRevokePairingReturnsToOffline() {
        let model = AppModel()
        model.revokePairing()
        XCTAssertEqual(model.connectionState, .offline)
    }

    func testCachedSessionsAreStableAndPreserveTruthfulOutcomes() {
        let model = AppModel()
        model.loadCachedSessions()
        let firstLoad = model.sessions
        model.loadCachedSessions()

        XCTAssertEqual(model.sessions, firstLoad)
        XCTAssertEqual(model.sessions.map(\.outcome), [.unavailable, .offline])
        XCTAssertEqual(model.sessions[0].detail, "Connect an explicitly paired executor to view durable activity.")
    }

    func testUnknownConflictPartialAndPausedOutcomesRemainDistinct() {
        let outcomes: [Session.Outcome] = [.unknown, .conflict, .unavailable, .partial, .paused]

        XCTAssertEqual(Set(outcomes.map(\.rawValue)), Set(["Unknown", "Conflict", "Unavailable", "Partial", "Paused"]))
        XCTAssertNotEqual(Session(id: "a", title: "A", detail: "detail", outcome: .unknown),
                          Session(id: "a", title: "A", detail: "detail", outcome: .partial))
    }

    func testEntryIsReadOnlyAndPairingFailsClosed() {
        let model = AppModel()

        XCTAssertEqual(model.pairingAvailability, .unavailable)
        XCTAssertFalse(model.canPair)
        XCTAssertTrue(model.isEntryReadOnly)

        model.completeOnboarding()

        XCTAssertEqual(model.connectionState, .offline)
        XCTAssertEqual(model.pairingAvailability, .unavailable)
        XCTAssertFalse(model.canPair)
        XCTAssertTrue(model.isEntryReadOnly)
        XCTAssertFalse(model.canRequestActions)

        model.revokePairing()
        XCTAssertEqual(model.connectionState, .offline)
        XCTAssertEqual(model.executorName, "No executor selected")
    }
    func testConnectionStatesExposeTruthfulPairedAndOfflineStatus() {
        XCTAssertEqual(AppModel.ConnectionState.offline.statusDetail, "Read-only until a trusted Mac is paired.")
        XCTAssertEqual(AppModel.ConnectionState.paired.statusDetail, "Paired Mac detected; this build remains read-only.")
        XCTAssertEqual(AppModel.ConnectionState.disconnected.statusDetail, "The paired Mac is not reachable; no action is available.")
        XCTAssertTrue(AppModel.ConnectionState.allCases.allSatisfy { $0.isReadOnly })
    }

    func testCzechCopyCoversActivitySettingsAndPrivacyWithoutChangingPolicy() {
        let copy = AppCopy(language: "cs")

        XCTAssertEqual(copy.activityTitle, "Aktivita")
        XCTAssertEqual(copy.settingsTitle, "Nastavení")
        XCTAssertEqual(copy.settingsPrivacyTitle, "Soukromí")
        XCTAssertTrue(copy.privacyDetail.contains("přihlašovací údaje"))
        XCTAssertEqual(copy.accessReadOnly, "Jen pro čtení")
        XCTAssertTrue(copy.activityStateNote.contains("Schválení"))
    }

    func testOutcomeCopyDistinguishesApprovalUndoConflictUnknownAndPaused() {
        let copy = AppCopy(language: "en")
        let outcomes: [Session.Outcome] = [.awaitingApproval, .undoAvailable, .conflict, .unknown, .paused]

        XCTAssertEqual(outcomes.map(copy.outcomeTitle), [
            "Awaiting approval",
            "Undo available",
            "Conflict",
            "Unknown",
            "Paused"
        ])
        XCTAssertTrue(outcomes.allSatisfy { copy.outcomeExplanation(for: $0).contains("Mac") })
    }

    func testCzechOutcomeCopyIsHumanReadable() {
        let copy = AppCopy(language: "cs")

        XCTAssertEqual(copy.outcomeTitle(for: .awaitingApproval), "Čeká na schválení")
        XCTAssertEqual(copy.outcomeTitle(for: .undoAvailable), "K dispozici je Zpět")
        XCTAssertEqual(copy.outcomeTitle(for: .conflict), "Konflikt")
        XCTAssertEqual(copy.outcomeTitle(for: .unknown), "Neznámé")
        XCTAssertEqual(copy.outcomeTitle(for: .paused), "Pozastaveno")
    }

    func testRemovingThisDeviceClearsSessionsAndReportsWhatItActuallyAchieved() async throws {
        let transcript = TranscriptCache()
        let credentials = InMemoryDeviceCredentialStore(
            credential: try DeviceCredential(
                deviceId: "device-test-001",
                workspaceId: "workspace-test",
                token: String(repeating: "t", count: 43),
                issuedAt: "2026-09-26T10:00:00Z",
                expiresAt: "2026-09-26T10:15:00Z"
            )
        )
        let removal = DeviceRemovalService(credentials: credentials, transcript: transcript) { _ in false }
        let model = AppModel(transcript: transcript, removal: removal)
        model.loadCachedSessions()
        XCTAssertFalse(model.sessions.isEmpty)

        await model.removeThisDevice()

        // The local half always happens: the pairing is gone from this side
        // and nothing that could authorise a later request is left on screen.
        XCTAssertTrue(model.sessions.isEmpty)
        XCTAssertEqual(model.connectionState, .offline)
        XCTAssertEqual(model.executorName, "No executor selected")
        // This build has no paired transport, so it never reached an executor
        // and the outcome must not claim it did.
        XCTAssertEqual(model.removalOutcome, .removedLocallyOnly)
        XCTAssertFalse(try XCTUnwrap(model.removalOutcome).credentialDeleted == false)
        let remainingCredential = try await credentials.load()
        XCTAssertNil(remainingCredential)
    }

    func testCachedHistoryIsNeverAuthorityForTheApp() {
        let model = AppModel()
        XCTAssertEqual(model.cachedHistoryAuthority, .nonAuthoritative)
    }

    func testRemovalCopyNamesWhatWasRemovedInBothLanguages() {
        let english = AppCopy(language: "en")
        let czech = AppCopy(language: "cs")

        XCTAssertNotEqual(english.removeDevice, czech.removeDevice)
        XCTAssertTrue(english.cachePolicyDetail.contains("in memory"))
        XCTAssertTrue(english.cachePolicyDetail.contains("never used to decide"))
        XCTAssertTrue(czech.cachePolicyDetail.contains("jen v paměti"))
        // A local-only removal and a confirmed one are different claims and
        // are not allowed to share a sentence.
        XCTAssertNotEqual(english.removalNotice(for: .removed), english.removalNotice(for: .removedLocallyOnly))
        XCTAssertNotEqual(english.removalNotice(for: .failed), english.removalNotice(for: .removed))
        XCTAssertNotEqual(czech.removalNotice(for: .removed), czech.removalNotice(for: .removedLocallyOnly))
    }
}
