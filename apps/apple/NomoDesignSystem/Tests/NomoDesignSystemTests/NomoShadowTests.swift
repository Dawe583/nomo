import Testing

@testable import NomoDesignSystem

/// The shadow roles are recorded, not used on the Apple platforms, so the only
/// property worth holding is that a dark appearance shadow is at least as deep
/// as the light one it replaces. A role that came back lighter in the dark would
/// be a value nobody would notice until a surface dropped its own shadow.
struct NomoShadowTests {
    @Test func aShadowIsDeeperInTheDarkAppearanceThanInTheLightOne() throws {
        for role in NomoShadowRole.allCases {
            let light = try #require(opacity(of: role.light), "\(role.rawValue) light")
            let dark = try #require(opacity(of: role.dark), "\(role.rawValue) dark")
            #expect(dark >= light, "\(role.rawValue) is lighter in the dark appearance")
        }
    }

    /// The alpha of a recorded value, which is the last channel of the form the
    /// document uses: `0 1px 2px rgb(0 0 0 / 0.06)`.
    private func opacity(of value: String) -> Double? {
        guard let tail = value.split(separator: "/").last else { return nil }
        return Double(String(tail.filter { $0.isNumber || $0 == "." }))
    }
}
