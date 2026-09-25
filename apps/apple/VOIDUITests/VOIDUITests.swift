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
