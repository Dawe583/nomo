import CoreGraphics

/// A control's size role, resolved to the points a control may occupy.
///
/// The numbers come from the document. What lives here is the rule: a hit
/// target is a floor and not a suggestion, and the floor is the platform's,
/// which is why the same role means different points on the two platforms.
public enum NomoControlSize: String, CaseIterable, Sendable {
    /// The hit target on iOS and iPadOS.
    case touch
    /// The pointer target on macOS.
    case macOS
    /// The absolute minimum on macOS, below which a control is not a control.
    case macOSMinimum

    /// The size for the role, in points.
    public var points: CGFloat {
        switch self {
        case .touch: NomoControlMetrics.touchPoints
        case .macOS: NomoControlMetrics.macOSPoints
        case .macOSMinimum: NomoControlMetrics.macOSMinimumPoints
        }
    }

    /// The smallest target the host platform accepts, in points. A control
    /// below it is refused by the system's own gesture handling before NOMO
    /// ever sees the touch.
    public static var platformFloor: CGFloat {
        NomoPlatform.current == .macOS ? NomoControlSize.macOSMinimum.points : NomoControlSize.touch.points
    }

    /// Whether a target of this size is acceptable on the host platform.
    public static func isValidHitTarget(_ points: CGFloat) -> Bool {
        points >= platformFloor
    }
}
