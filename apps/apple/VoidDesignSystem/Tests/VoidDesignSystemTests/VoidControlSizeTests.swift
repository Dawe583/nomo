import XCTest

@testable import VoidDesignSystem

/// A hit target is a floor and not a suggestion. The floors themselves come
/// from the document; what these tests hold is that each size role is wired to
/// the floor it claims to be and that nothing the package offers is below a
/// floor.
final class VoidControlSizeTests: XCTestCase {
    func testEveryControlSizeClearsTheAbsoluteFloor() {
        for size in VoidControlSize.allCases {
            XCTAssertGreaterThanOrEqual(
                size.points,
                VoidControlSize.macOSMinimum.points,
                "\(size.rawValue) is \(size.points), absolute floor \(VoidControlSize.macOSMinimum.points)"
            )
        }
    }

    func testTheTouchSizeClearsTheTouchFloor() {
        XCTAssertGreaterThanOrEqual(
            VoidControlSize.touch.points,
            VoidControlMetrics.touchPoints
        )
    }

    func testTheMacOSSizeClearsTheMacOSPointerTarget() {
        XCTAssertGreaterThanOrEqual(
            VoidControlSize.macOS.points,
            VoidControlMetrics.macOSPoints
        )
        XCTAssertGreaterThanOrEqual(
            VoidControlSize.macOS.points,
            VoidControlMetrics.macOSMinimumPoints
        )
    }

    func testATargetAtTheHostFloorIsAcceptedAndOnePointBelowItIsNot() {
        let floor = VoidControlSize.platformFloor
        XCTAssertTrue(VoidControlSize.isValidHitTarget(floor))
        XCTAssertTrue(VoidControlSize.isValidHitTarget(floor + 1))
        XCTAssertFalse(VoidControlSize.isValidHitTarget(floor - 1))
    }

    func testTheHostFloorIsThePlatformTheBuildIsFor() {
        #if os(macOS)
        XCTAssertEqual(VoidControlSize.platformFloor, VoidControlSize.macOSMinimum.points)
        #else
        XCTAssertEqual(VoidControlSize.platformFloor, VoidControlSize.touch.points)
        #endif
    }
}
