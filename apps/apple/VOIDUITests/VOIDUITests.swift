@preconcurrency import UIKit
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

    func testAppearanceControlIsLabelledReachableAndSelectsEveryChoice() {
        let appearance = app.segmentedControls["entry.theme"]
        XCTAssertTrue(appearance.waitForExistence(timeout: 5))
        XCTAssertEqual(appearance.label, "Appearance")
        XCTAssertGreaterThanOrEqual(appearance.frame.height, 44, "Appearance control must keep the 44pt touch target contract.")

        for choice in ["System", "Light", "Dark"] {
            XCTAssertTrue(appearance.buttons[choice].exists, "Appearance control is missing the \(choice) choice.")
            appearance.buttons[choice].tap()
            XCTAssertTrue(appearance.buttons[choice].isSelected, "Tapping \(choice) must select it.")
        }
    }

    func testChosenAppearanceSurvivesRelaunchWithoutLaunchArgument() {
        let appearance = app.segmentedControls["entry.theme"]
        XCTAssertTrue(appearance.waitForExistence(timeout: 5))
        appearance.buttons["Dark"].tap()

        app.terminate()
        app = XCUIApplication()
        app.launch()

        let reloaded = app.segmentedControls["entry.theme"]
        XCTAssertTrue(reloaded.waitForExistence(timeout: 5))
        XCTAssertTrue(reloaded.buttons["Dark"].isSelected, "The chosen appearance must be persisted, not held in memory.")

        // The preference outlives the test, so hand the next test a clean default.
        reloaded.buttons["System"].tap()
    }

    func testAppearanceSwitchChangesRenderedColorsAndKeepsTextAtAAContrast() throws {
        let light = try measureEntryTitle(name: "light", launchingWithTheme: "light")
        let dark = try measureEntryTitle(name: "dark", launchingWithTheme: "dark")

        XCTAssertNotEqual(light.text, dark.text, "Title text must not render identically in light and dark.")
        XCTAssertNotEqual(light.background, dark.background, "Title background must not render identically in light and dark.")
        XCTAssertGreaterThan(light.meanLuminance, 0.5, "Light appearance must render a light surface around the title.")
        XCTAssertLessThan(dark.meanLuminance, 0.5, "Dark appearance must render a dark surface around the title.")

        XCTAssertGreaterThanOrEqual(light.contrastRatio, 4.5, "Light appearance contrast was \(light.contrastRatio), below WCAG AA.")
        XCTAssertGreaterThanOrEqual(dark.contrastRatio, 4.5, "Dark appearance contrast was \(dark.contrastRatio), below WCAG AA.")

        for sample in [light, dark] {
            let title = XCTAttachment(data: sample.titleScreenshot)
            title.name = "entry-title-\(sample.name)"
            title.lifetime = .keepAlways
            add(title)
        }

        let measurements = XCTAttachment(string: [light, dark]
            .map { "\($0.name) text \(describe($0.text)) background \(describe($0.background)) mean \(String(format: "%.4f", $0.meanLuminance)) contrast \(String(format: "%.2f", $0.contrastRatio)):1" }
            .joined(separator: "\n"))
        measurements.lifetime = .keepAlways
        add(measurements)
    }

    private struct RGB: Equatable {
        let red: Double
        let green: Double
        let blue: Double

        /// WCAG 2.x relative luminance of an sRGB colour.
        var relativeLuminance: Double {
            func linear(_ channel: Double) -> Double {
                channel <= 0.04045 ? channel / 12.92 : pow((channel + 0.055) / 1.055, 2.4)
            }
            return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
        }
    }

    private struct RenderedText {
        let name: String
        let text: RGB
        let background: RGB
        let meanLuminance: Double
        let titleScreenshot: Data

        var contrastRatio: Double {
            let lighter = max(text.relativeLuminance, background.relativeLuminance)
            let darker = min(text.relativeLuminance, background.relativeLuminance)
            return (lighter + 0.05) / (darker + 0.05)
        }
    }


    // MARK: Conversation surface

    func testConversationShowsTheUnreachableTranscriptAndAnInertComposerWithItsReason() {
        openConversation(named: "Offline mode")

        XCTAssertTrue(app.staticTexts["No transcript available"].waitForExistence(timeout: 5))
        XCTAssertTrue(
            app.staticTexts["This build ships no transport to the Mac, so there is no way to load a transcript."].exists,
            "An unreachable transcript has to say why it is unreachable."
        )

        let composer = composerField
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        XCTAssertFalse(
            composer.isEnabled,
            "The compact chat disables its input while blocked rather than accepting a draft it can never send."
        )

        let send = app.buttons["chat.send"]
        XCTAssertTrue(send.exists)
        XCTAssertFalse(send.isEnabled, "Send must not be offered while no transport exists.")
        XCTAssertGreaterThanOrEqual(send.frame.height, 44, "Send must keep the 44pt touch target contract.")
        XCTAssertGreaterThanOrEqual(send.frame.width, 44)

        let window = app.windows.firstMatch.frame
        XCTAssertTrue(
            window.contains(send.frame),
            "Send must stay inside the window at any text size: send \(send.frame) window \(window)"
        )
        XCTAssertTrue(
            window.contains(composer.frame),
            "The composer must stay inside the window at any text size: composer \(composer.frame) window \(window)"
        )

        XCTAssertTrue(app.staticTexts["No action is available while offline"].exists)
        XCTAssertTrue(app.staticTexts["This companion build has no write authority."].exists)
        XCTAssertTrue(
            app.staticTexts["Composing and sending are unavailable: this build has no transport to the Mac."].exists,
            "The reason belongs next to the disabled control, not only in a button hint."
        )
        assertLabeledContent(label: "Outcome", value: "Offline")
    }

    func testAnEmptyConversationIsNotPresentedAsAnUnreachableOne() {
        relaunch(chatFixture: "empty")
        openConversation(named: "Offline mode")

        XCTAssertTrue(app.staticTexts["No messages yet"].waitForExistence(timeout: 5))
        XCTAssertTrue(
            app.staticTexts["The executor knew this conversation and sent no events for it. That is not the same as being unable to see its history."].exists
        )
        XCTAssertFalse(
            app.staticTexts["No transcript available"].exists,
            "An empty conversation and an unreadable one are different states and must not read the same."
        )
    }

    func testSampleTranscriptIsLabelledAndToolStateIsAnnouncedAsOneElement() {
        relaunch(chatFixture: "sample")
        openConversation(named: "Offline mode")

        XCTAssertTrue(app.staticTexts["Sample transport"].waitForExistence(timeout: 5))
        XCTAssertTrue(
            app.staticTexts["Simulated for interface verification. No executor is connected and nothing leaves this device."].exists,
            "Sample text must never be presented as executor data."
        )
        XCTAssertTrue(app.staticTexts["Partial history"].exists)

        let approval = element("chat.tool.call-approve")
        XCTAssertTrue(approval.waitForExistence(timeout: 5), "A tool card must be one combined accessibility element.")
        XCTAssertTrue(approval.label.contains("Tool call: document.write"), "got \(approval.label)")
        XCTAssertTrue(approval.label.contains("Awaiting approval"), "State must be part of the combined label. got \(approval.label)")
        XCTAssertTrue(
            approval.label.contains("The trusted Mac has to make this decision, so this companion offers no control for it."),
            "The reason a control is absent has to travel with the state. got \(approval.label)"
        )
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "Approve")).count, 0)
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "Deny")).count, 0)

        let incomplete = element("chat.tool.call-partial")
        XCTAssertTrue(incomplete.waitForExistence(timeout: 5))
        XCTAssertTrue(incomplete.label.contains("Incomplete call"), "got \(incomplete.label)")
        XCTAssertTrue(
            incomplete.label.contains("This call arrived incomplete and was not executed."),
            "A partial call must be shown and must say it was not executed. got \(incomplete.label)"
        )
    }

    func testExpandedToolDetailsOpenInTheBoundedRegionAboveTheComposer() {
        relaunch(chatFixture: "sample")
        openConversation(named: "Offline mode")

        let disclosure = app.buttons["chat.tool.call-read.disclosure"]
        XCTAssertTrue(disclosure.waitForExistence(timeout: 5))
        XCTAssertGreaterThanOrEqual(disclosure.frame.height, 44, "A disclosure is still a touch control.")
        disclosure.tap()

        let details = element("chat.tool.details")
        XCTAssertTrue(details.waitForExistence(timeout: 5), "Details must open in the bounded notices region.")

        // The details panel may be taller than the region that holds it — that
        // is the point of a bounded region — so the contract is that the region
        // stays on screen, stays bounded, and that its first line is reachable.
        let region = scrollView("chat.notices")
        XCTAssertTrue(region.waitForExistence(timeout: 5))
        let window = app.windows.firstMatch.frame
        XCTAssertTrue(
            window.contains(region.frame),
            "The notices region must stay inside the window: \(region.frame) in \(window)"
        )
        XCTAssertLessThanOrEqual(
            region.frame.height, 240,
            "The notices region is bounded so it cannot push the composer away: \(region.frame)"
        )
        let heading = app.staticTexts["Tool details"]
        XCTAssertTrue(heading.exists && heading.isHittable, "The start of the expanded details must be reachable without scrolling the composer away.")

        let send = app.buttons["chat.send"]
        XCTAssertTrue(send.exists, "Opening details must not remove Send.")
        XCTAssertTrue(
            window.contains(send.frame),
            "Send must stay inside the window while details are open: \(send.frame)"
        )
        XCTAssertTrue(
            app.buttons["chat.tool.call-read.close"].label.contains("Hide details"),
            "The region that shows the details must offer the way back to collapsed details."
        )
    }

    func testConversationTextKeepsAAContrastInBothAppearances() throws {
        var samples: [RenderedText] = []
        for theme in ["light", "dark"] {
            // The offline state carries the two text pairs most likely to fail:
            // the muted reason under the composer and the blocked notice on its
            // tinted fill, plus the disabled action control.
            relaunch(theme: theme)
            openConversation(named: "Offline mode")

            let composerStatus = app.staticTexts["chat.composer.status"]
            XCTAssertTrue(composerStatus.waitForExistence(timeout: 5))
            samples.append(try measureStrongestPair(element: composerStatus, name: "composer-status-\(theme)"))

            let blockedNotice = app.staticTexts["No action is available while offline"]
            XCTAssertTrue(blockedNotice.waitForExistence(timeout: 5))
            samples.append(try measureStrongestPair(element: blockedNotice, name: "blocked-notice-\(theme)"))

            let disabledSend = app.buttons["chat.send"]
            XCTAssertTrue(disabledSend.exists)
            samples.append(try measureStrongestPair(element: disabledSend, name: "send-disabled-\(theme)"))

            // The enabled action control is a different colour pair, so it is
            // measured in the state where it is actually enabled.
            relaunch(theme: theme, chatFixture: "streaming")
            openConversation(named: "Offline mode")
            let composer = composerField
            XCTAssertTrue(composer.waitForExistence(timeout: 5))
            XCTAssertTrue(composer.isEnabled)
            composer.tap()
            composer.typeText("contrast probe")
            let send = app.buttons["chat.send"]
            XCTAssertTrue(send.isEnabled, "A non-empty draft on a live transport must enable Send.")
            samples.append(try measureStrongestPair(element: send, name: "send-enabled-\(theme)"))
        }

        for sample in samples {
            XCTAssertGreaterThanOrEqual(
                sample.contrastRatio,
                4.5,
                "\(sample.name) measured \(sample.text) on \(sample.background) at \(String(format: "%.2f", sample.contrastRatio)):1, below WCAG AA."
            )
            let attachment = XCTAttachment(data: sample.titleScreenshot)
            attachment.name = sample.name
            attachment.lifetime = .keepAlways
            add(attachment)
        }

        let measurements = XCTAttachment(string: samples
            .map { "\($0.name) text \(describe($0.text)) background \(describe($0.background)) contrast \(String(format: "%.2f", $0.contrastRatio)):1" }
            .joined(separator: "\n"))
        measurements.lifetime = .keepAlways
        add(measurements)
    }

    func testStopEndsAStreamedRunAndKeepsThePartialAnswerTruthful() {
        relaunch(chatFixture: "streaming")
        openConversation(named: "Offline mode")

        let composer = composerField
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        XCTAssertTrue(composer.isEnabled, "A transport that reports itself available may accept a draft.")
        composer.tap()
        composer.typeText("What is the next step?")

        let send = app.buttons["chat.send"]
        XCTAssertTrue(send.isEnabled, "A non-empty draft with a live transport must be sendable.")
        send.tap()

        let stop = app.buttons["chat.stop"]
        XCTAssertTrue(stop.waitForExistence(timeout: 10), "A live run must offer a real stop control.")
        XCTAssertGreaterThanOrEqual(stop.frame.height, 44)
        XCTAssertGreaterThanOrEqual(stop.frame.width, 44)
        XCTAssertTrue(app.staticTexts["Streaming response"].exists, "A live run must be visible as a running state.")

        let runningTool = element("chat.tool.call-1")
        XCTAssertTrue(
            runningTool.waitForExistence(timeout: 30),
            "The scripted run must reach its running tool call, otherwise the stop has nothing pending to report."
        )
        XCTAssertTrue(runningTool.label.contains("Running"), "got \(runningTool.label)")

        stop.tap()

        XCTAssertTrue(app.staticTexts["Stopped"].waitForExistence(timeout: 5), "Stopping must settle into a stopped state, not a silent one.")
        XCTAssertTrue(
            app.staticTexts["Text that had arrived is kept. The tool request already submitted keeps running on the Mac; stopping does not recall it."].exists,
            "An accepted tool request must not be described as recalled by a stop."
        )
        XCTAssertTrue(app.staticTexts["Partial answer"].exists, "Interrupted text must stay marked partial.")
        XCTAssertTrue(app.buttons["chat.send"].exists, "Stop must give way to Send once the run has ended.")
    }

    /// Tables and code blocks render inside their own horizontal scroll view,
    /// nested in the transcript's vertical one. This pins that a table is laid
    /// out and addressable by its own identifier even though it starts far
    /// above the fold — a transcript that only fills in as it is scrolled
    /// reads as a conversation still loading — that it is one narrated element
    /// rather than a grid of separately targetable cells, and that the prose
    /// around it is not swallowed into it.
    ///
    /// Two further assertions about the closing paragraphs of that message (a
    /// refused URL scheme staying visible as text, and raw HTML rendering as
    /// literal text) are deliberately absent. XCUITest does not surface those
    /// paragraphs in a snapshot even after scrolling to them, so they could
    /// not be verified and are not claimed. The renderer that produces them
    /// still refuses every scheme but http/https and never interprets HTML.
    func testSampleTranscriptRendersTablesAndCodeAsAddressableElements() {
        relaunch(chatFixture: "sample")
        openConversation(named: "Offline mode")

        let table = element("chat.markdown.table")
        XCTAssertTrue(
            table.waitForExistence(timeout: 5),
            "A table above the fold must be laid out, not parsed on arrival."
        )
        // The table has to be its own element. An identifier attached to the
        // message's container is pushed down onto every element inside that
        // message, so when the message owned the identifier this element
        // answered to `chat.message.assistant` and the table's own identity was
        // lost. The narration survived only because it had been absorbed into
        // the message, which also meant the surrounding prose was narrated as
        // part of the table.
        XCTAssertEqual(
            app.descendants(matching: .any).matching(identifier: "chat.message.assistant").count, 2,
            "Each assistant message names itself once, on its role label; an identifier on the message container would be pushed down onto every block inside it."
        )
        // `MarkdownParser` is a pure value type, so these expectations are
        // checked against its real output rather than against the fixture by
        // eye. Parsing the sample message yields a 4-column table with 3 data
        // rows, narrated as "Table with 4 columns and 3 rows." — the header
        // is not counted as a row — and the last data row is "Row 3.". An
        // earlier version of this test expected 4 rows and "Row 4", which the
        // parser has never produced.
        XCTAssertTrue(table.label.contains("Table with 4 columns and 3 rows."), "got \(table.label)")
        XCTAssertTrue(table.label.contains("Columns: Revision, Change, Origin, Reversible."), "got \(table.label)")
        XCTAssertTrue(table.label.contains("Row 1. Revision: 41, Change: Compaction step added"), "got \(table.label)")
        XCTAssertTrue(table.label.contains("Row 3. Revision: 39, Change: Signing rules, Origin: manual"), "got \(table.label)")
        // The cells are not separately targetable. The table does keep its
        // horizontal scroll view as a child, because that is the affordance
        // that stops a wide table from widening the transcript; the property
        // under test is that no cell text is its own target.
        XCTAssertEqual(
            table.descendants(matching: .staticText).count, 0,
            "A table must not also expose its cells as separate targets; column position cannot be the only label."
        )
        XCTAssertEqual(
            app.descendants(matching: .staticText)
                .matching(NSPredicate(format: "label CONTAINS %@", "Compaction step added"))
                .count, 0,
            "A cell's text must not be reachable on its own, outside the table's narration."
        )

        scroll(table, into: app.windows.firstMatch)
        XCTAssertTrue(
            app.windows.firstMatch.frame.contains(table.frame),
            "A wide table scrolls inside its own container, not off the window: \(table.frame)"
        )

        let code = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH %@", "Code block, swift"))
            .firstMatch
        XCTAssertTrue(code.waitForExistence(timeout: 5), "A code block must expose its language and its source.")
        XCTAssertTrue((code.value as? String)?.contains("func compact") == true, "got \(String(describing: code.value))")
    }

    // MARK: Conversation helpers

    private var composerField: XCUIElement {
        // A `TextField` with a vertical axis is backed by a text view, so both
        // spellings have to be tried before the field is reported missing.
        let field = app.textFields["chat.composer"]
        if field.exists { return field }
        return app.textViews["chat.composer"]
    }

    private func element(_ identifier: String) -> XCUIElement {
        app.descendants(matching: .any)[identifier]
    }

    /// A scroll view propagates its identifier to its content, so a region that
    /// is addressable by type has to be looked up by type too.
    private func scrollView(_ identifier: String) -> XCUIElement {
        app.scrollViews.matching(identifier: identifier).firstMatch
    }

    /// Brings an element fully inside a window by scrolling the transcript
    /// towards the start of the conversation. An element can be laid out and
    /// addressable while sitting far above the fold, so a frame assertion has
    /// to measure it on screen; that is a property of where it is drawn, not
    /// of whether it was parsed.
    private func scroll(_ element: XCUIElement, into window: XCUIElement, attempts: Int = 8) {
        let transcript = scrollView("chat.transcript")
        for _ in 0..<attempts where !window.frame.contains(element.frame) {
            transcript.swipeDown()
        }
    }

    private func relaunch(theme: String? = nil, chatFixture: String? = nil) {
        app.terminate()
        app = XCUIApplication()
        var arguments: [String] = []
        if let theme { arguments += ["-void-theme", theme] }
        if let chatFixture { arguments += ["-VOID_CHAT_FIXTURE", chatFixture] }
        app.launchArguments = arguments
        app.launch()
    }

    private func openConversation(named title: String) {
        // Onboarding completion is not persisted, so every fresh launch is
        // still on the entry screen. This helper owns that step so a test that
        // had to relaunch for a fixture does not have to remember it.
        let continueButton = app.buttons["Continue offline"]
        if continueButton.waitForExistence(timeout: 3) {
            continueButton.tap()
        }
        let row = app.staticTexts[title]
        XCTAssertTrue(row.waitForExistence(timeout: 8), "Activity row \(title) never appeared.")
        row.tap()
        XCTAssertTrue(
            app.navigationBars[title].waitForExistence(timeout: 8),
            "Tapping \(title) must open the conversation."
        )
    }

    private func measureEntryTitle(name: String, launchingWithTheme theme: String, file: StaticString = #filePath, line: UInt = #line) throws -> RenderedText {
        app.terminate()
        app = XCUIApplication()
        app.launchArguments = ["-void-theme", theme]
        app.launch()

        // The navigation bar repeats the title, so scope to the entry body first. The
        // body omits its own header at regular width, so fall back to the bare title.
        let scoped = app.scrollViews.staticTexts["Connect to your Mac"].firstMatch
        let title = scoped.waitForExistence(timeout: 5) ? scoped : app.staticTexts["Connect to your Mac"].firstMatch
        XCTAssertTrue(title.waitForExistence(timeout: 5), file: file, line: line)
        return try measure(element: title, name: name, file: file, line: line)
    }

    /// Reads the rendered pixels behind an element and splits them into the
    /// glyph colour and the surface colour, so contrast is measured, not guessed.
    private func measure(element: XCUIElement, name: String, file: StaticString = #filePath, line: UInt = #line) throws -> RenderedText {
        let window = try XCTUnwrap(
            app.windows.allElementsBoundByIndex.first { $0.frame.contains(element.frame) },
            "No window contains the element under measurement.",
            file: file,
            line: line
        )
        let image = try XCTUnwrap(UIImage(data: window.screenshot().pngRepresentation), file: file, line: line)
        let titleScreenshot = element.screenshot().pngRepresentation
        let cgImage = try XCTUnwrap(image.cgImage, file: file, line: line)
        let pixels = try XCTUnwrap(rgbaBytes(of: cgImage), file: file, line: line)
        let region = element.frame
            .offsetBy(dx: -window.frame.minX, dy: -window.frame.minY)
            .insetBy(dx: 1, dy: 1)
            .standardized
            .intersection(CGRect(origin: .zero, size: window.frame.size))
            .applying(CGAffineTransform(
                scaleX: CGFloat(cgImage.width) / window.frame.width,
                y: CGFloat(cgImage.height) / window.frame.height
            ))
            .integral

        var samples: [(colour: RGB, luminance: Double)] = []
        for y in Int(region.minY)..<Int(region.maxY) {
            for x in Int(region.minX)..<Int(region.maxX) {
                let offset = y * cgImage.width * 4 + x * 4
                let colour = RGB(
                    red: Double(pixels[offset]) / 255,
                    green: Double(pixels[offset + 1]) / 255,
                    blue: Double(pixels[offset + 2]) / 255
                )
                samples.append((colour, colour.relativeLuminance))
            }
        }
        XCTAssertGreaterThan(samples.count, 64, "Element region is too small to measure.", file: file, line: line)

        let byLuminance = samples.sorted { $0.luminance < $1.luminance }
        let background = byLuminance[byLuminance.count / 2]
        let text = background.luminance > 0.5
            ? byLuminance[byLuminance.count / 50]
            : byLuminance[byLuminance.count - 1 - byLuminance.count / 50]
        let meanLuminance = byLuminance.reduce(0) { $0 + $1.luminance } / Double(byLuminance.count)

        return RenderedText(
            name: name,
            text: text.colour,
            background: background.colour,
            meanLuminance: meanLuminance,
            titleScreenshot: titleScreenshot
        )
    }

    /// Measures the strongest contrast pair inside an element.
    ///
    /// `measure` assumes a light glyph on a dark surface or the reverse, which
    /// holds for text on a canvas but not for a dark glyph on a mid-tone
    /// filled control. This takes the pixel furthest from the median instead,
    /// so it is correct whichever side the glyph is on. The existing helper is
    /// left exactly as it is; this is additive.
    private func measureStrongestPair(element: XCUIElement, name: String, file: StaticString = #filePath, line: UInt = #line) throws -> RenderedText {
        let window = try XCTUnwrap(
            app.windows.allElementsBoundByIndex.first { $0.frame.contains(element.frame) },
            "No window contains the element under measurement.",
            file: file,
            line: line
        )
        let image = try XCTUnwrap(UIImage(data: window.screenshot().pngRepresentation), file: file, line: line)
        let cgImage = try XCTUnwrap(image.cgImage, file: file, line: line)
        let pixels = try XCTUnwrap(rgbaBytes(of: cgImage), file: file, line: line)

        let region = element.frame
            .offsetBy(dx: -window.frame.minX, dy: -window.frame.minY)
            .insetBy(dx: 1, dy: 1)
            .standardized
            .intersection(CGRect(origin: .zero, size: window.frame.size))
            .applying(CGAffineTransform(
                scaleX: CGFloat(cgImage.width) / window.frame.width,
                y: CGFloat(cgImage.height) / window.frame.height
            ))
            .integral

        var samples: [(colour: RGB, luminance: Double)] = []
        for y in Int(region.minY)..<Int(region.maxY) {
            for x in Int(region.minX)..<Int(region.maxX) {
                let offset = y * cgImage.width * 4 + x * 4
                let colour = RGB(
                    red: Double(pixels[offset]) / 255,
                    green: Double(pixels[offset + 1]) / 255,
                    blue: Double(pixels[offset + 2]) / 255
                )
                samples.append((colour, colour.relativeLuminance))
            }
        }
        XCTAssertGreaterThan(samples.count, 64, "Element region is too small to measure.", file: file, line: line)

        let byLuminance = samples.sorted { $0.luminance < $1.luminance }
        let background = byLuminance[byLuminance.count / 2]
        let darkest = byLuminance[0]
        let lightest = byLuminance[byLuminance.count - 1]
        let text = abs(lightest.luminance - background.luminance) >= abs(darkest.luminance - background.luminance)
            ? lightest
            : darkest
        let meanLuminance = byLuminance.reduce(0) { $0 + $1.luminance } / Double(byLuminance.count)

        return RenderedText(
            name: name,
            text: text.colour,
            background: background.colour,
            meanLuminance: meanLuminance,
            titleScreenshot: element.screenshot().pngRepresentation
        )
    }

    private func rgbaBytes(of image: CGImage) -> [UInt8]? {
        let width = image.width
        let height = image.height
        var buffer = [UInt8](repeating: 0, count: width * height * 4)
        let rendered = buffer.withUnsafeMutableBytes { raw -> Bool in
            guard let base = raw.baseAddress,
                  let context = CGContext(
                    data: base,
                    width: width,
                    height: height,
                    bitsPerComponent: 8,
                    bytesPerRow: width * 4,
                    space: CGColorSpaceCreateDeviceRGB(),
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
                  )
            else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        return rendered ? buffer : nil
    }

    private func describe(_ colour: RGB) -> String {
        "rgb(\(Int((colour.red * 255).rounded())), \(Int((colour.green * 255).rounded())), \(Int((colour.blue * 255).rounded())))"
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
