import CoreGraphics

/// WCAG 2.1 contrast, so the token gate is a measurement and not a comment.
///
/// The document states a minimum for every pairing it introduces, and a stated
/// ratio that nothing reproduces is a stale comment. This is the implementation
/// the package's own tests measure with, in both appearances, for every pair
/// the document carries.
public enum NomoContrast {
    /// The relative luminance of a colour, WCAG 2.1 section 6.2.2.
    /// Eight bit channels are linearised before they are weighted, and the
    /// alpha is ignored: a translucent colour has no luminance of its own, only
    /// the luminance of whatever it is composited over, and every colour the
    /// document gates is opaque.
    public static func relativeLuminance(
        red: Double,
        green: Double,
        blue: Double
    ) -> Double {
        0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
    }

    /// The relative luminance of the recorded components.
    public static func relativeLuminance(_ value: NomoColorComponents) -> Double {
        relativeLuminance(red: value.red, green: value.green, blue: value.blue)
    }

    /// The relative luminance of a role in one appearance.
    public static func relativeLuminance(
        _ role: NomoColorRole,
        appearance: NomoAppearance
    ) -> Double {
        relativeLuminance(role.components(for: appearance))
    }

    /// The contrast ratio of two colours, WCAG 2.1 section 6.2.1: the lighter
    /// over the darker, each with 0.05 added, so the range is 1 to 21.
    public static func ratio(
        _ foreground: NomoColorComponents,
        _ background: NomoColorComponents
    ) -> Double {
        ratio(relativeLuminance(foreground), relativeLuminance(background))
    }

    /// The contrast ratio of a pair in one appearance.
    public static func ratio(_ pair: NomoContrastPair, appearance: NomoAppearance) -> Double {
        ratio(
            pair.foreground.components(for: appearance),
            pair.background.components(for: appearance)
        )
    }

    /// The contrast ratio of two relative luminances. Order does not matter,
    /// which is why this takes the maximum and the minimum rather than a
    /// foreground and a background it would have to know which is which.
    public static func ratio(_ first: Double, _ second: Double) -> Double {
        (max(first, second) + 0.05) / (min(first, second) + 0.05)
    }

    /// The one place the 0.03928 threshold of the specification appears, kept
    /// separate so it is one number in one place.
    private static func linear(_ channel: Double) -> Double {
        channel <= 0.03928
            ? channel / 12.92
            : pow((channel + 0.055) / 1.055, 2.4)
    }
}
