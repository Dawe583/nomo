// Generated from scripts/design/tokens.json by
// scripts/src/build-design-tokens.mjs. Do not edit by hand: the design
// system test fails when this file drifts from the source.
//
// No colour value appears here on purpose. The native surfaces resolve
// colour through the platform's semantic types, which already adapt to
// appearance, Increase Contrast and Reduce Transparency. A hex in Swift
// would be a second source of truth for something the system gets right.

import CoreGraphics

/// Every scalar the Human Interface Guidelines state, in one place.
public enum VoidMetrics {
    /// A 4 point rhythm. The guidelines' own layout constants are 40 points
    /// of horizontal spacing and 100 points minimum between unrelated groups.
    public static let space1: CGFloat = 4
    public static let space2: CGFloat = 8
    public static let space3: CGFloat = 12
    public static let space4: CGFloat = 16
    public static let space6: CGFloat = 24
    public static let space8: CGFloat = 32

    /// Corners are concentric with the element that contains them, which a
    /// single radius cannot express.
    public static let radiuscontrol: CGFloat = 10
    public static let radiuscard: CGFloat = 14
    public static let radiussheet: CGFloat = 20
    public static let radiuswindow: CGFloat = 12

    /// Hit targets are a floor, not a suggestion.
    public static let controltouch: CGFloat = 44
    public static let controlpointer: CGFloat = 28
    public static let controlmacosMin: CGFloat = 20

    /// Interaction feedback only, and never the only signal that something
    /// changed, because Reduce Motion turns it off.
    public static let motionInteraction: Double = 0.15

    /// The guidelines' standard horizontal spacing, and the minimum vertical
    /// spacing between unrelated groups.
    public static let horizontalSpacing: CGFloat = 40
    public static let groupSpacing: CGFloat = 100
}

/// One rung of the type ramp, in both platforms' own numbers.
public struct VoidTypeStyle: Sendable {
    public let ios: CGFloat
    public let iosLeading: CGFloat
    public let macos: CGFloat
    public let macosLeading: CGFloat
    public let weight: String

    public init(
        ios: CGFloat,
        iosLeading: CGFloat,
        macos: CGFloat,
        macosLeading: CGFloat,
        weight: String
    ) {
        self.ios = ios
        self.iosLeading = iosLeading
        self.macos = macos
        self.macosLeading = macosLeading
        self.weight = weight
    }
}

/// The type ramp. A semantic role resolves to the platform's own style, so
/// Dynamic Type scales the surface and no view sets a point size. These
/// numbers are the mapping, kept beside the web form so the two cannot drift
/// apart unnoticed.
public enum VoidTypeRamp {
    /// bold, 32 points on iOS with 39 of leading,
    /// 31 points on macOS with 38 of leading.
    public static let largeTitle = VoidTypeStyle(ios: 32, iosLeading: 39, macos: 31, macosLeading: 38, weight: "bold")
    /// bold, 26 points on iOS with 32 of leading,
    /// 25 points on macOS with 31 of leading.
    public static let title1 = VoidTypeStyle(ios: 26, iosLeading: 32, macos: 25, macosLeading: 31, weight: "bold")
    /// bold, 20 points on iOS with 25 of leading,
    /// 19 points on macOS with 24 of leading.
    public static let title2 = VoidTypeStyle(ios: 20, iosLeading: 25, macos: 19, macosLeading: 24, weight: "bold")
    /// semibold, 18 points on iOS with 23 of leading,
    /// 17 points on macOS with 22 of leading.
    public static let title3 = VoidTypeStyle(ios: 18, iosLeading: 23, macos: 17, macosLeading: 22, weight: "semibold")
    /// semibold, 15 points on iOS with 20 of leading,
    /// 14 points on macOS with 19 of leading.
    public static let headline = VoidTypeStyle(ios: 15, iosLeading: 20, macos: 14, macosLeading: 19, weight: "semibold")
    /// regular, 15 points on iOS with 20 of leading,
    /// 14 points on macOS with 19 of leading.
    public static let body = VoidTypeStyle(ios: 15, iosLeading: 20, macos: 14, macosLeading: 19, weight: "regular")
    /// regular, 14 points on iOS with 19 of leading,
    /// 13 points on macOS with 18 of leading.
    public static let callout = VoidTypeStyle(ios: 14, iosLeading: 19, macos: 13, macosLeading: 18, weight: "regular")
    /// regular, 13 points on iOS with 18 of leading,
    /// 12 points on macOS with 16 of leading.
    public static let subhead = VoidTypeStyle(ios: 13, iosLeading: 18, macos: 12, macosLeading: 16, weight: "regular")
    /// regular, 12 points on iOS with 16 of leading,
    /// 12 points on macOS with 16 of leading.
    public static let footnote = VoidTypeStyle(ios: 12, iosLeading: 16, macos: 12, macosLeading: 16, weight: "regular")
    /// regular, 11 points on iOS with 13 of leading,
    /// 11 points on macOS with 13 of leading.
    public static let caption1 = VoidTypeStyle(ios: 11, iosLeading: 13, macos: 11, macosLeading: 13, weight: "regular")
    /// regular, 11 points on iOS with 13 of leading,
    /// 11 points on macOS with 13 of leading.
    public static let caption2 = VoidTypeStyle(ios: 11, iosLeading: 13, macos: 11, macosLeading: 13, weight: "regular")

    /// Dynamic Type floors: 11 points on iOS, 10 on macOS.
    public static let iosMinimum: CGFloat = 11
    public static let macosMinimum: CGFloat = 10

    /// The web maps Body to this size with the line height below, and never
    /// below webMinimum pixels for interface text.
    public static let webBody: CGFloat = 15
    public static let webMinimum: CGFloat = 13
    public static let webLineHeight: Double = 1.5
}

/// A semantic colour role, named so the web and the native surfaces call the
/// same concept the same thing. The platform supplies the value.
public enum VoidColorRole: String, CaseIterable, Sendable {
    case Canvas
    case Surface
    case Raised
    case Ink
    case Muted
    case Line
    case Action
    case Danger
    case Good
    case Focus
    case OnAction

    /// What the role stands for, so the name is never the only record.
    public var note: String {
        switch self {
        case .Canvas: return "systemBackground"
        case .Surface: return "secondarySystemBackground"
        case .Raised: return "tertiarySystemBackground"
        case .Ink: return "label"
        case .Muted: return "secondaryLabel"
        case .Line: return "separator"
        case .Action: return "systemBlue, darkened until it clears AA as text"
        case .Danger: return "systemRed, adjusted for contrast"
        case .Good: return "systemGreen, adjusted for contrast"
        case .Focus: return "the focus ring is the action colour, so focus is never a second palette"
        case .OnAction: return "the foreground of a filled action, which flips with the action colour"
        }
    }
}
