@preconcurrency import XCTest

@MainActor
final class VOIDUITests: XCTestCase {
    nonisolated(unsafe) private var app: XCUIApplication!
    nonisolated override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launch()
    }

    func testEntryExplainsPairedMacWithoutCredentialsAndContinuesOffline() {
        XCTAssertTrue(app.staticTexts["Connect to your Mac"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["VOID has no account"].exists)
        XCTAssertTrue(app.staticTexts["You connect to a Mac you own, not to a VOID account."].exists)
        XCTAssertTrue(app.staticTexts["Mac not paired"].exists)
        XCTAssertTrue(app.staticTexts["Read-only offline"].exists)
        XCTAssertTrue(app.staticTexts["Secure Mac pairing is not available in this build."].exists)
        XCTAssertEqual(app.textFields.count, 0)
        XCTAssertEqual(app.secureTextFields.count, 0)

        let connectMac = app.buttons["Connect a Mac"]
        XCTAssertTrue(connectMac.exists)
        XCTAssertFalse(connectMac.isEnabled)
        XCTAssertGreaterThanOrEqual(connectMac.frame.height, 44)

        let continueOffline = app.buttons["Continue offline"]
        XCTAssertTrue(continueOffline.isEnabled)
        XCTAssertGreaterThanOrEqual(continueOffline.frame.height, 44)
        continueOffline.tap()

        XCTAssertTrue(app.navigationBars["Activity"].waitForExistence(timeout: 5))
    }

    func testEntrySupportsCzechWithoutCredentialFields() {
        app.terminate()
        app = XCUIApplication()
        app.launchArguments = ["-void-entry-language", "cs"]
        app.launch()

        XCTAssertTrue(app.staticTexts["Připojit k Macu"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["VOID nemá účet"].exists)
        XCTAssertTrue(app.staticTexts["Připojíte se k vlastnímu Macu, ne k účtu VOID."].exists)
        XCTAssertTrue(app.staticTexts["Mac není spárován"].exists)
        XCTAssertTrue(app.staticTexts["Offline jen pro čtení"].exists)
        XCTAssertTrue(app.staticTexts["Zabezpečené párování Macu v této verzi není dostupné."].exists)
        XCTAssertEqual(app.textFields.count, 0)
        XCTAssertEqual(app.secureTextFields.count, 0)

        let connectMac = app.buttons["Připojit Mac"]
        XCTAssertTrue(connectMac.exists)
        XCTAssertFalse(connectMac.isEnabled)
        XCTAssertGreaterThanOrEqual(connectMac.frame.height, 44)

        let continueOffline = app.buttons["Pokračovat offline"]
        XCTAssertTrue(continueOffline.exists)
        XCTAssertGreaterThanOrEqual(continueOffline.frame.height, 44)
    }

    func testSettingsShowsPrivacyAndRevocationIsDisabledWhileOffline() {
        completeOnboarding()
        app.buttons["Settings"].tap()

        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["No credentials, prompts, document contents, or pairing secrets are written to logs or UserDefaults."].exists)
        let revokeButton = app.buttons["Revoke paired device"]
        XCTAssertTrue(revokeButton.exists)
        XCTAssertFalse(revokeButton.isEnabled)
        XCTAssertTrue(app.staticTexts["Read-only until a trusted Mac is paired."].exists)
    }

    func testActivitySessionNavigatesToDetailAndShowsOutcome() {
        completeOnboarding()
        XCTAssertTrue(app.navigationBars["Activity"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["This companion build has no write authority."].exists)
        XCTAssertTrue(app.staticTexts["No cached sessions"].exists)
        XCTAssertTrue(app.staticTexts["Offline mode"].exists)

        app.staticTexts["Offline mode"].tap()

        XCTAssertTrue(app.navigationBars["Offline mode"].waitForExistence(timeout: 5))
        assertLabeledContent(label: "Outcome", value: "Offline")
        XCTAssertTrue(app.staticTexts["No action is available while offline"].exists)
    }
    func testUnavailableSessionDetailExplainsWhyNoExecutorIsNeeded() {
        completeOnboarding()
        XCTAssertTrue(app.navigationBars["Activity"].waitForExistence(timeout: 5))
        app.staticTexts["No cached sessions"].tap()

        XCTAssertTrue(app.navigationBars["No cached sessions"].waitForExistence(timeout: 5))
        assertLabeledContent(label: "Outcome", value: "Unavailable")
        XCTAssertTrue(app.staticTexts["Connect an explicitly paired executor to view durable activity."].exists)
    }

    func testPairingCTAStaysInertAndItsReasonStaysReadable() {
        let connectMac = app.buttons["Connect a Mac"]
        XCTAssertTrue(connectMac.waitForExistence(timeout: 5))
        XCTAssertFalse(connectMac.isEnabled, "Pairing must stay unavailable until a real executor path exists.")

        let notice = app.staticTexts["Secure Mac pairing is not available in this build."]
        XCTAssertTrue(notice.exists)
        XCTAssertGreaterThan(notice.frame.height, 0, "Pairing reason must render, not collapse to zero height.")
        XCTAssertGreaterThan(notice.frame.width, 0, "Pairing reason must render, not collapse to zero width.")
        XCTAssertTrue(
            app.windows.firstMatch.frame.contains(notice.frame),
            "Pairing reason is clipped outside the window: notice \(notice.frame) window \(app.windows.firstMatch.frame)"
        )

        connectMac.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()

        XCTAssertFalse(
            app.alerts.firstMatch.waitForExistence(timeout: 2),
            "A dead-end pairing dialog appeared; the CTA must stay inert while pairing is unavailable."
        )
        XCTAssertTrue(app.staticTexts["Connect to your Mac"].waitForExistence(timeout: 5), "Entry screen must survive a tap on the inert pairing CTA.")
        XCTAssertEqual(app.textFields.count, 0)
        XCTAssertEqual(app.secureTextFields.count, 0)
    }

    func testActivityRowIsAnnouncedAsOneCombinedElement() {
        completeOnboarding()
        XCTAssertTrue(app.navigationBars["Activity"].waitForExistence(timeout: 5))

        let row = app.buttons.matching(
            NSPredicate(
                format: "label CONTAINS %@ AND label CONTAINS %@",
                "Offline mode",
                "You can inspect cached activity only. No action can run without a paired Mac."
            )
        ).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 5), "Session row must expose a combined accessibility label, not bare child text.")
        XCTAssertTrue(row.isHittable)
        XCTAssertTrue(
            row.label.contains("Offline, You can inspect cached activity only. No action can run without a paired Mac."),
            "Session row label must carry title, outcome and detail: got \(row.label)"
        )
    }

    func testSettingsAndActivityExposeNamedAccessibilityTargets() {
        completeOnboarding()
        let settingsButton = app.buttons["Settings"]
        XCTAssertTrue(settingsButton.exists)
        XCTAssertEqual(settingsButton.label, "Settings")
        XCTAssertGreaterThanOrEqual(settingsButton.frame.height, 44)

        XCTAssertTrue(app.staticTexts["Offline"].exists)
    }

    private func assertLabeledContent(label: String, value: String, file: StaticString = #filePath, line: UInt = #line) {
        let element = app.staticTexts.containing(NSPredicate(format: "label CONTAINS[c] %@", value)).firstMatch
        XCTAssertTrue(element.exists, file: file, line: line)
        XCTAssertTrue(element.label.localizedCaseInsensitiveContains(label) || element.label.localizedCaseInsensitiveContains(value), file: file, line: line)
    }

    private func completeOnboarding() {
        let continueButton = app.buttons["Continue offline"]
        XCTAssertTrue(continueButton.waitForExistence(timeout: 5))
        continueButton.tap()
    }
}
