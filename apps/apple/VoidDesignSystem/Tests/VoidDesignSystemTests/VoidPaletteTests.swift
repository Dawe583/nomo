import XCTest

@testable import VoidDesignSystem

/// The palette answers with the platform's own semantic colour wherever the
/// platform has one. A role quietly gaining or losing that answer is the
/// failure the token source exists to prevent, and the roles it takes are a
/// decision rather than a default: `onAccent`, `danger` and `good` resolve to
/// the recorded components because the document moved them to clear the
/// contrast gate, and taking the platform value would undo a measurement.
final class VoidPaletteTests: XCTestCase {
    func testThePlatformRolesAreTheOnesWithAPlatformSemanticColour() {
        let fromPlatform: Set<VoidColorRole> = [
            .canvas, .surface, .raised, .text, .muted, .separator, .accent, .focus,
        ]
        for role in VoidColorRole.allCases {
            XCTAssertEqual(
                VoidPalette.platformColor(for: role) != nil,
                fromPlatform.contains(role),
                "\(role.rawValue) resolves to the wrong source"
            )
        }
    }

    func testTheFocusRingUsesTheAccentRole() {
        XCTAssertEqual(VoidColorRole.focus.systemName, VoidColorRole.accent.systemName)
        for appearance in VoidAppearance.allCases {
            XCTAssertEqual(
                VoidColorRole.focus.components(for: appearance),
                VoidColorRole.accent.components(for: appearance)
            )
        }
    }

    func testEveryRoleCarriesBothAppearances() {
        for role in VoidColorRole.allCases {
            XCTAssertNotEqual(role.light, role.dark, "\(role.rawValue) is the same in both appearances")
            XCTAssertEqual(role.components(for: .light), role.light)
            XCTAssertEqual(role.components(for: .dark), role.dark)
        }
    }

    func testEveryRecordedColourIsOpaque() {
        for role in VoidColorRole.allCases {
            for appearance in VoidAppearance.allCases {
                XCTAssertEqual(role.components(for: appearance).alpha, 1, "\(role.rawValue)")
            }
        }
    }
}

/// Corners are concentric with the element that contains them, so a nested
/// element takes a smaller role than its container.
final class VoidRadiiTests: XCTestCase {
    func testAControlInsideACardTakesTheSmallerRole() {
        XCTAssertTrue(VoidRadii.nests(.control, inside: .card))
        XCTAssertFalse(VoidRadii.nests(.card, inside: .control))
    }

    func testACardInsideASheetTakesTheSmallerRole() {
        XCTAssertTrue(VoidRadii.nests(.card, inside: .sheet))
        XCTAssertFalse(VoidRadii.nests(.sheet, inside: .card))
    }

    func testACapsuleRoundsPastEveryOtherRole() {
        for role in VoidRadiusRole.allCases {
            XCTAssertTrue(VoidRadii.nests(role, inside: .capsule), "\(role.rawValue) does not fit a capsule")
        }
    }

    func testTheRolesAreOrderedFromSmallestToLargest() {
        let radii = VoidRadii.bySize.map(\.radius)
        XCTAssertEqual(radii, radii.sorted())
    }

    func testTheLargestNestingRoleIsTheBiggestThatFits() {
        for outer in VoidRadiusRole.allCases {
            let nested = VoidRadii.largestNesting(inside: outer)
            XCTAssertTrue(VoidRadii.nests(nested, inside: outer))
            for role in VoidRadiusRole.allCases where role.radius > nested.radius {
                XCTAssertFalse(
                    VoidRadii.nests(role, inside: outer),
                    "\(role.rawValue) is larger than \(nested.rawValue) and does not fit inside \(outer.rawValue)"
                )
            }
        }
    }
}
