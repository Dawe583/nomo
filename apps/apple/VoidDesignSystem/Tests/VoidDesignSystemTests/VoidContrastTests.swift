import XCTest

@testable import VoidDesignSystem

/// The document's contrast gate, measured rather than asserted in a comment.
///
/// Every pairing the token document introduces carries a minimum, and the
/// document says a ratio that nothing reproduces is a failing test rather than
/// a stale comment. These tests are that measurement: the package computes the
/// ratio with its own WCAG 2.1 implementation, in both appearances, for every
/// pair the document carries.
final class VoidContrastTests: XCTestCase {
    func testEveryContrastPairMeetsItsMinimumInBothAppearances() {
        for pair in VoidContrastPairs.all {
            for appearance in VoidAppearance.allCases {
                let ratio = VoidContrast.ratio(pair, appearance: appearance)
                XCTAssertGreaterThanOrEqual(
                    ratio,
                    pair.minimum,
                    "\(pair.name) measures \(ratio) in \(appearance.rawValue), minimum \(pair.minimum)"
                )
            }
        }
    }

    func testRelativeLuminanceIsZeroForBlackAndOneForWhite() {
        XCTAssertEqual(VoidContrast.relativeLuminance(red: 0, green: 0, blue: 0), 0, accuracy: 1e-12)
        XCTAssertEqual(VoidContrast.relativeLuminance(red: 1, green: 1, blue: 1), 1, accuracy: 1e-12)
    }

    func testTheCanvasIsTheLightestRoleInLightAndTheDarkestInDark() {
        for appearance in VoidAppearance.allCases {
            for role in VoidColorRole.allCases where !role.isDecorative {
                let canvas = VoidContrast.relativeLuminance(.canvas, appearance: appearance)
                let other = VoidContrast.relativeLuminance(role, appearance: appearance)
                if appearance == .light {
                    XCTAssertGreaterThanOrEqual(canvas, other, "\(role.rawValue) is lighter than the canvas")
                } else {
                    XCTAssertLessThanOrEqual(canvas, other, "\(role.rawValue) is darker than the canvas")
                }
            }
        }
    }

    func testTheContrastRatioIsSymmetricInItsTwoColours() {
        let light = VoidColorRole.text.components(for: .light)
        let dark = VoidColorRole.canvas.components(for: .light)
        XCTAssertEqual(
            VoidContrast.ratio(light, dark),
            VoidContrast.ratio(dark, light),
            accuracy: 1e-12
        )
    }

    func testTheContrastRatioOfBlackOnWhiteIsTheSpecificationMaximum() {
        let black = VoidColorComponents(red: 0, green: 0, blue: 0)
        let white = VoidColorComponents(red: 1, green: 1, blue: 1)
        XCTAssertEqual(VoidContrast.ratio(black, white), 21, accuracy: 1e-9)
    }

    func testNoContrastPairMeasuresAgainstADecorativeRole() {
        for pair in VoidContrastPairs.all {
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
