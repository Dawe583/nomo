import SwiftUI

/// Which of the document's two appearances a token value belongs to.
///
/// The document carries exactly two, and nothing else may choose between them,
/// so naming the choice keeps a call site from passing a bare Bool into a token
/// accessor. The platform's colour scheme is the only input.
public enum VoidAppearance: String, CaseIterable, Sendable {
    case light
    case dark

    public init(_ scheme: ColorScheme) {
        self = scheme == .dark ? .dark : .light
    }
}

/// One colour as the four channels the contrast gate measures.
///
/// The values are unit-interval `Double`s rather than bytes so the generated
/// module needs no platform colour type at all, which is what keeps it
/// importable from a target that has neither UIKit nor AppKit.
public struct VoidColorComponents: Equatable, Hashable, Sendable {
    public let red: Double
    public let green: Double
    public let blue: Double
    public let alpha: Double

    public init(red: Double, green: Double, blue: Double, alpha: Double = 1) {
        self.red = red
        self.green = green
        self.blue = blue
        self.alpha = alpha
    }
}
