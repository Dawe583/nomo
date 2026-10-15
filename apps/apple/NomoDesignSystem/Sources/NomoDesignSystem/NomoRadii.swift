import CoreGraphics

/// The rule about radius roles, beside the roles themselves.
///
/// Corners are concentric with the element that contains them, which one radius
/// cannot express. A nested element therefore takes a smaller role than its
/// container, and a literal radius in a component rule is a defect.
public extension NomoRadii {
    /// Whether `inner` may sit inside `outer` without its corner breaking the
    /// concentric arc the container draws.
    static func nests(_ inner: NomoRadiusRole, inside outer: NomoRadiusRole) -> Bool {
        inner.radius <= outer.radius
    }

    /// The largest role that still nests inside `outer`, which is what a
    /// container has to pick for a child it does not name explicitly.
    static func largestNesting(inside outer: NomoRadiusRole) -> NomoRadiusRole {
        NomoRadiusRole.allCases
            .filter { nests($0, inside: outer) }
            .max { $0.radius < $1.radius } ?? .inline
    }
}
