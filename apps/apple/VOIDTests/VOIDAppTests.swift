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

    func testRemovingThisDeviceClearsSessionsAndReportsWhatItActuallyAchieved() async {
        let model = AppModel()
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

    /// A relaunch is a second `AppModel` over the same storage, which is the
    /// only way this can be checked without a device: a flag held in the
    /// process is gone, and one held in the defaults is not.
    func testCompletingOnboardingSurvivesARelaunch() throws {
        let suite = "com.void.companion.tests.onboarding"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        let firstLaunch = AppModel(onboarding: DefaultsOnboardingStateStore(defaults: defaults))
        XCTAssertFalse(firstLaunch.hasCompletedOnboarding, "A first launch opens on the entry screen.")

        firstLaunch.completeOnboarding()

        let nextLaunch = AppModel(onboarding: DefaultsOnboardingStateStore(defaults: defaults))
        XCTAssertTrue(
            nextLaunch.hasCompletedOnboarding,
            "The entry screen came back for someone who already answered it."
        )
    }

    /// Every key in `Localizable.xcstrings` has to resolve, in both shipped
    /// languages. A key with no entry resolves to itself, so a gap in the
    /// catalog is a sentence the operator reads rather than an empty control,
    /// and this is what stops it shipping.
    func testEverySentenceResolvesInBothShippedLanguages() {
        for language in ["en", "cs"] {
            let copy = LocalizedCopy(language: language)
            for key in CopyKey.allCases {
                let resolved = copy[key]
                XCTAssertFalse(resolved.isEmpty, "\(key.rawValue) is empty in \(language).")
                XCTAssertNotEqual(
                    resolved, key.rawValue,
                    "\(key.rawValue) has no \(language) entry in Localizable.xcstrings."
                )
            }
        }
    }

    /// The read-only promise is the product's own sentence, and moving it into
    /// a catalog is exactly when it would get quietly reworded.
    func testTheReadOnlyPromiseIsSaidUnchangedInBothLanguages() {
        let english = AppCopy(language: "en")
        let czech = AppCopy(language: "cs")

        XCTAssertEqual(english.readOnly, "Read-only")
        XCTAssertEqual(czech.readOnly, "Jen pro čtení")
        XCTAssertEqual(english.noWriteAuthority, "This companion build has no write authority.")
        XCTAssertEqual(czech.noWriteAuthority, "Tato verze doprovodné aplikace nemá oprávnění zapisovat.")
        XCTAssertEqual(english.noActionOffline, "No action is available while offline")
        XCTAssertEqual(czech.noActionOffline, "Offline není dostupná žádná akce")
        XCTAssertEqual(english.connectionDetail(for: .offline), "Read-only until a trusted Mac is paired.")
        XCTAssertEqual(czech.connectionDetail(for: .offline), "Jen pro čtení, dokud není spárován důvěryhodný Mac.")
    }

    /// What a decision means is the second sentence the product owns. A tool
    /// call that needs an operator decision and one that arrived incomplete
    /// are two different claims, and both have to keep saying so.
    func testWhatADecisionMeansIsSaidUnchangedInBothLanguages() {
        let english = ChatCopy(language: "en")
        let czech = ChatCopy(language: "cs")

        XCTAssertEqual(
            english.needsExecutorDecision,
            "The trusted Mac has to make this decision, so this companion offers no control for it."
        )
        XCTAssertEqual(
            czech.needsExecutorDecision,
            "Rozhodnutí musí udělat důvěryhodný Mac. Tato aplikace proto nenabízí žádné tlačítko."
        )
        XCTAssertEqual(
            english.incompleteCallDetail,
            "This call arrived incomplete and was not executed. VOID does not guess the missing part."
        )
        XCTAssertEqual(
            czech.incompleteCallDetail,
            "Volání dorazilo neúplné a nebylo provedeno. VOID neuhoduje chybějící části."
        )
        XCTAssertEqual(
            english.composerStatus(for: .readOnlyBuild),
            "Composing and sending are unavailable: this build has no transport to the Mac."
        )
        XCTAssertEqual(
            czech.composerStatus(for: .readOnlyBuild),
            "Psát ani odesílat nelze: tato verze nemá přenosovou cestu k Macu."
        )
    }
}
