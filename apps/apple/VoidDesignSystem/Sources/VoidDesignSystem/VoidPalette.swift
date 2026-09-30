import SwiftUI

/// A colour role as the platform's own `Color`.
///
/// The document's `system` field is the rule. Where the platform has a semantic
/// colour for the role, the platform's value is the token, so Increase Contrast
/// and Reduce Transparency keep working and the two platforms stay in step with
/// the system rather than with each other.
///
/// `onAccent`, `danger` and `good` have platform colours too, and the document
/// does not use them. Those three are the roles the contrast gate moved: the
/// standard red measures 3.55:1 on a white canvas, and a refusal has to be
/// readable rather than merely red. Taking the platform value would silently
/// undo a measured decision, so those roles resolve to the recorded components
/// instead, and the reason is recorded beside the role in the generated module.
///
/// Nothing here imports UIKit or AppKit. The two platforms spell a semantic
/// background differently and SwiftUI has no spelling that covers both, so the
/// difference is one conditional rather than a dependency.
public enum VoidPalette {
    /// The platform's semantic colour for the role, or `nil` where the document
    /// records an adjusted value instead.
    public static func platformColor(for role: VoidColorRole) -> Color? {
        switch role {
        case .text:
            return .primary
        case .muted:
            return .secondary
        case .accent, .focus:
            return .accentColor
        case .canvas, .surface, .raised, .separator:
            return systemBackground(for: role)
        case .onAccent, .danger, .good:
            return nil
        // The syntax roles resolve to the recorded components for the same
        // reason `danger` and `good` do: the document measured these against the
        // canvas and the surface in both appearances, and there is no platform
        // semantic colour that would reproduce the measurement. Taking a
        // platform default would silently undo it.
        case .syntaxKeyword, .syntaxString, .syntaxNumber:
            return nil
        }
    }

    /// The colour to paint a role in one appearance: the platform's own where
    /// one exists, and the recorded components where the contrast gate moved it.
    public static func color(for role: VoidColorRole, appearance: VoidAppearance) -> Color {
        if let platform = platformColor(for: role) {
            return platform
        }
        let value = role.components(for: appearance)
        return Color(
            red: value.red,
            green: value.green,
            blue: value.blue,
            opacity: value.alpha
        )
    }

    /// The platform's own background roles.
    ///
    /// `Color(.systemBackground)` resolves the member against the platform
    /// colour type that `Color` takes, so the type never has to be named, and
    /// naming it is what would force the import this package refuses.
    private static func systemBackground(for role: VoidColorRole) -> Color? {
        #if canImport(UIKit)
        switch role {
        case .canvas: return Color(.systemBackground)
        case .surface: return Color(.secondarySystemBackground)
        case .raised: return Color(.tertiarySystemBackground)
        case .separator: return Color(.separator)
        default: return nil
        }
        #elseif canImport(AppKit)
        switch role {
        case .canvas: return Color(.windowBackgroundColor)
        case .surface: return Color(.underPageBackgroundColor)
        case .raised: return Color(.controlBackgroundColor)
        case .separator: return Color(.separatorColor)
        default: return nil
        }
        #else
        return nil
        #endif
    }
}
