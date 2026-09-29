import CoreGraphics

/// The rules about the spacing tokens, beside the tokens themselves.
///
/// The values are generated from `docs/design-tokens.json`; nothing here may
/// restate one, because a restated value is one that can drift. What belongs
/// here is what the document says about using them.
public extension VoidSpacing {
    /// Whether a value is on the rhythm. A spacing value that is not is a
    /// defect, which is why this exists rather than a free-form `CGFloat`.
    static func isOnRhythm(_ value: CGFloat) -> Bool {
        rhythm.contains(value)
    }

    /// The rhythm step at or below `value`, and the one above it, so a caller
    /// that has to fall back can round in a direction it chose rather than an
    /// arbitrary one.
    static func steps(around value: CGFloat) -> (below: CGFloat, above: CGFloat) {
        let below = rhythm.last { $0 <= value } ?? rhythm[0]
        let above = rhythm.first { $0 >= value } ?? rhythm[rhythm.count - 1]
        return (below, above)
    }

    /// The widest measure that still fits `width`, so a narrow column never
    /// gets the widest measure and a wide one never runs edge to edge.
    static func measure(forWidth width: CGFloat) -> CGFloat {
        measureSteps.first { $0 <= width } ?? measureSteps[measureSteps.count - 1]
    }
}
