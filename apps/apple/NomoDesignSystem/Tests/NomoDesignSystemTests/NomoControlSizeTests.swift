import XCTest

@testable import NomoDesignSystem

/// A hit target is a floor and not a suggestion. The floors themselves come
/// from the document; what these tests hold is that each size role is wired to
/// the floor it claims to be and that nothing the package offers is below a
/// floor.
final class NomoControlSizeTests: XCTestCase {
    func testEveryControlSizeClearsTheAbsoluteFloor() {
        for size in NomoControlSize.allCases {
            XCTAssertGreaterThanOrEqual(
                size.points,
                NomoControlSize.macOSMinimum.points,
                "\(size.rawValue) is \(size.points), absolute floor \(NomoControlSize.macOSMinimum.points)"
            )
        }
    }

    func testTheTouchSizeClearsTheTouchFloor() {
        XCTAssertGreaterThanOrEqual(
            NomoControlSize.touch.points,
            NomoControlMetrics.touchPoints
        )
    }

    func testTheMacOSSizeClearsTheMacOSPointerTarget() {
        XCTAssertGreaterThanOrEqual(
            NomoControlSize.macOS.points,
            NomoControlMetrics.macOSPoints
        )
        XCTAssertGreaterThanOrEqual(
            NomoControlSize.macOS.points,
            NomoControlMetrics.macOSMinimumPoints
        )
    }

    func testATargetAtTheHostFloorIsAcceptedAndOnePointBelowItIsNot() {
        let floor = NomoControlSize.platformFloor
        XCTAssertTrue(NomoControlSize.isValidHitTarget(floor))
        XCTAssertTrue(NomoControlSize.isValidHitTarget(floor + 1))
        XCTAssertFalse(NomoControlSize.isValidHitTarget(floor - 1))
    }

    func testTheHostFloorIsThePlatformTheBuildIsFor() {
        #if os(macOS)
        XCTAssertEqual(NomoControlSize.platformFloor, NomoControlSize.macOSMinimum.points)
        #else
        XCTAssertEqual(NomoControlSize.platformFloor, NomoControlSize.touch.points)
        #endif
    }
}
