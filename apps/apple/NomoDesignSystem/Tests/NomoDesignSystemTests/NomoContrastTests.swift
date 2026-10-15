import XCTest

@testable import NomoDesignSystem

/// The document's contrast gate, measured rather than asserted in a comment.
///
/// Every pairing the token document introduces carries a minimum, and the
/// document says a ratio that nothing reproduces is a failing test rather than
/// a stale comment. These tests are that measurement: the package computes the
/// ratio with its own WCAG 2.1 implementation, in both appearances, for every
/// pair the document carries.
final class NomoContrastTests: XCTestCase {
    func testEveryContrastPairMeetsItsMinimumInBothAppearances() {
        for pair in NomoContrastPairs.all {
            for appearance in NomoAppearance.allCases {
                let ratio = NomoContrast.ratio(pair, appearance: appearance)
                XCTAssertGreaterThanOrEqual(
                    ratio,
                    pair.minimum,
                    "\(pair.name) measures \(ratio) in \(appearance.rawValue), minimum \(pair.minimum)"
                )
            }
        }
    }

    func testRelativeLuminanceIsZeroForBlackAndOneForWhite() {
        XCTAssertEqual(NomoContrast.relativeLuminance(red: 0, green: 0, blue: 0), 0, accuracy: 1e-12)
        XCTAssertEqual(NomoContrast.relativeLuminance(red: 1, green: 1, blue: 1), 1, accuracy: 1e-12)
    }

    func testTheCanvasIsTheLightestRoleInLightAndTheDarkestInDark() {
        for appearance in NomoAppearance.allCases {
            for role in NomoColorRole.allCases where !role.isDecorative {
                let canvas = NomoContrast.relativeLuminance(.canvas, appearance: appearance)
                let other = NomoContrast.relativeLuminance(role, appearance: appearance)
                if appearance == .light {
                    XCTAssertGreaterThanOrEqual(canvas, other, "\(role.rawValue) is lighter than the canvas")
                } else {
                    XCTAssertLessThanOrEqual(canvas, other, "\(role.rawValue) is darker than the canvas")
                }
            }
        }
    }

    func testTheContrastRatioIsSymmetricInItsTwoColours() {
        let light = NomoColorRole.text.components(for: .light)
        let dark = NomoColorRole.canvas.components(for: .light)
        XCTAssertEqual(
            NomoContrast.ratio(light, dark),
            NomoContrast.ratio(dark, light),
            accuracy: 1e-12
        )
    }

    func testTheContrastRatioOfBlackOnWhiteIsTheSpecificationMaximum() {
        let black = NomoColorComponents(red: 0, green: 0, blue: 0)
        let white = NomoColorComponents(red: 1, green: 1, blue: 1)
        XCTAssertEqual(NomoContrast.ratio(black, white), 21, accuracy: 1e-9)
    }

    func testNoContrastPairMeasuresAgainstADecorativeRole() {
        for pair in NomoContrastPairs.all {
            XCTAssertFalse(
                pair.foreground.isDecorative,
                "\(pair.name) is measured against a role that only separates"
            )
            XCTAssertFalse(
                pair.background.isDecorative,
                "\(pair.name) is measured against a role that only separates"
            )
        }
    }
}
