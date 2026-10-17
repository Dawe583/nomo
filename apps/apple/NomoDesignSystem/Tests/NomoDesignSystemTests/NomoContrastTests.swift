import Testing

@testable import NomoDesignSystem

/// The document's contrast gate, measured rather than asserted in a comment.
///
/// Every pairing the token document introduces carries a minimum, and the
/// document says a ratio that nothing reproduces is a failing test rather than
/// a stale comment. These tests are that measurement: the package computes the
/// ratio with its own WCAG 2.1 implementation, in both appearances, for every
/// pair the document carries.
struct NomoContrastTests {
    @Test func everyContrastPairMeetsItsMinimumInBothAppearances() {
        for pair in NomoContrastPairs.all {
            for appearance in NomoAppearance.allCases {
                let ratio = NomoContrast.ratio(pair, appearance: appearance)
                #expect(
                    ratio >= pair.minimum,
                    "\(pair.name) measures \(ratio) in \(appearance.rawValue), minimum \(pair.minimum)"
                )
            }
        }
    }

    @Test func relativeLuminanceIsZeroForBlackAndOneForWhite() {
        // WCAG 2.1 rounds the comparison at the ratio step, so the luminance
        // identities are pinned tightly rather than approximately.
        #expect(abs(NomoContrast.relativeLuminance(red: 0, green: 0, blue: 0)) <= 1e-12)
        #expect(abs(NomoContrast.relativeLuminance(red: 1, green: 1, blue: 1) - 1) <= 1e-12)
    }

    @Test func theCanvasIsTheLightestRoleInLightAndTheDarkestInDark() {
        for appearance in NomoAppearance.allCases {
            for role in NomoColorRole.allCases where !role.isDecorative {
                let canvas = NomoContrast.relativeLuminance(.canvas, appearance: appearance)
                let other = NomoContrast.relativeLuminance(role, appearance: appearance)
                if appearance == .light {
                    #expect(canvas >= other, "\(role.rawValue) is lighter than the canvas")
                } else {
                    #expect(canvas <= other, "\(role.rawValue) is darker than the canvas")
                }
            }
        }
    }

    @Test func theContrastRatioIsSymmetricInItsTwoColours() {
        let light = NomoColorRole.text.components(for: .light)
        let dark = NomoColorRole.canvas.components(for: .light)
        #expect(
            abs(NomoContrast.ratio(light, dark) - NomoContrast.ratio(dark, light)) <= 1e-12
        )
    }

    @Test func theContrastRatioOfBlackOnWhiteIsTheSpecificationMaximum() {
        let black = NomoColorComponents(red: 0, green: 0, blue: 0)
        let white = NomoColorComponents(red: 1, green: 1, blue: 1)
        #expect(abs(NomoContrast.ratio(black, white) - 21) <= 1e-9)
    }

    @Test func noContrastPairMeasuresAgainstADecorativeRole() {
        for pair in NomoContrastPairs.all {
            #expect(
                !pair.foreground.isDecorative,
                "\(pair.name) is measured against a role that only separates"
            )
            #expect(
                !pair.background.isDecorative,
                "\(pair.name) is measured against a role that only separates"
            )
        }
    }
}
