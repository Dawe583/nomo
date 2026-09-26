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
