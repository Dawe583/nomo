import Testing

@testable import NomoDesignSystem

/// A hit target is a floor and not a suggestion. The floors themselves come
/// from the document; what these tests hold is that each size role is wired to
/// the floor it claims to be and that nothing the package offers is below a
/// floor.
struct NomoControlSizeTests {
    @Test func everyControlSizeClearsTheAbsoluteFloor() {
        for size in NomoControlSize.allCases {
            #expect(
                size.points >= NomoControlSize.macOSMinimum.points,
                "\(size.rawValue) is \(size.points), absolute floor \(NomoControlSize.macOSMinimum.points)"
            )
        }
    }

    @Test func theTouchSizeClearsTheTouchFloor() {
        #expect(NomoControlSize.touch.points >= NomoControlMetrics.touchPoints)
    }

    @Test func theMacOSSizeClearsTheMacOSPointerTarget() {
        #expect(NomoControlSize.macOS.points >= NomoControlMetrics.macOSPoints)
        #expect(NomoControlSize.macOS.points >= NomoControlMetrics.macOSMinimumPoints)
    }

    @Test func aTargetAtTheHostFloorIsAcceptedAndOnePointBelowItIsNot() {
        let floor = NomoControlSize.platformFloor
        #expect(NomoControlSize.isValidHitTarget(floor))
        #expect(NomoControlSize.isValidHitTarget(floor + 1))
        #expect(!NomoControlSize.isValidHitTarget(floor - 1))
    }

    @Test func theHostFloorIsThePlatformTheBuildIsFor() {
        #if os(macOS)
        #expect(NomoControlSize.platformFloor == NomoControlSize.macOSMinimum.points)
        #else
        #expect(NomoControlSize.platformFloor == NomoControlSize.touch.points)
        #endif
    }
}
