import SwiftUI

/// The platform a token is being resolved for.
///
/// The document quotes the type ramp separately for the two platforms and they
/// are one step tighter on macOS, so "the size for this role" is not a question
/// with one answer until the platform is named.
public enum NomoPlatform: String, CaseIterable, Sendable {
    case iOS
    case macOS

    /// The platform this build is running on.
    public static var current: NomoPlatform {
        #if os(macOS)
        return .macOS
        #else
        return .iOS
        #endif
    }
}

public extension NomoTypeWeight {
    /// The weight the platform's own font stack uses for this weight.
    ///
    /// The mapping is hand written because `Font.Weight` is a platform type and
    /// the generated module carries values, not fonts. A weight the document
    /// adds next has no mapping until one is written here, which is a compile
    /// error rather than a silent default.
    var fontWeight: Font.Weight {
        switch self {
        case .regular: .regular
        case .semibold: .semibold
        case .bold: .bold
        }
    }

    /// How heavy the weight is, in the order the font stack renders them. A
    /// test needs an order to compare two weights with, and the platform's own
    /// `Font.Weight` does not expose one.
    var rank: Int {
        switch self {
        case .regular: 0
        case .semibold: 1
        case .bold: 2
        }
    }
}

/// The type surface: a role asked for by name, the platform's own font
/// returned for it.
///
/// A surface never asks for a point size. The sizes in the document are the
/// built-in styles the guideline quotes, and asking SwiftUI for the role is
/// what makes the whole surface scale when a person changes the text size.
public enum NomoType {
    /// The platform's built-in font for the role, emphasised when asked for.
    public static func font(_ role: NomoTypeRole, emphasised: Bool = false) -> Font {
        let font = builtInFont(role)
        guard emphasised, let weight = role.metrics(for: NomoPlatform.current).emphasised else {
            return font
        }
        return font.weight(weight.fontWeight)
    }

    /// The metrics the document quotes for the role on one platform, for a
    /// caller that has to reason about the numbers rather than draw with them.
    public static func metrics(_ role: NomoTypeRole, platform: NomoPlatform) -> NomoTypeMetrics {
        role.metrics(for: platform)
    }

    /// The smallest legible size the document states on the host platform.
    public static var minimumLegibleSize: Double {
        NomoPlatform.current == .macOS
            ? NomoTypeRole.macOSMinimumSize
            : NomoTypeRole.iosMinimumSize
    }

    private static func builtInFont(_ role: NomoTypeRole) -> Font {
        switch role {
        case .largeTitle: .largeTitle
        case .title1: .title
        case .title2: .title2
        case .title3: .title3
        case .headline: .headline
        case .body: .body
        case .callout: .callout
        case .subhead: .subheadline
        case .footnote: .footnote
        case .caption1: .caption
        case .caption2: .caption2
        }
    }
}
