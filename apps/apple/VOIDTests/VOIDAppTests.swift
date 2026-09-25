import XCTest
@testable import VOID

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
}
