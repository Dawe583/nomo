import XCTest

@testable import NomoDesignSystem

/// The palette answers with the platform's own semantic colour wherever the
/// platform has one. A role quietly gaining or losing that answer is the
/// failure the token source exists to prevent, and the roles it takes are a
/// decision rather than a default: `onAccent`, `danger` and `good` resolve to
/// the recorded components because the document moved them to clear the
/// contrast gate, and taking the platform value would undo a measurement.
final class NomoPaletteTests: XCTestCase {
    func testThePlatformRolesAreTheOnesWithAPlatformSemanticColour() {
        let fromPlatform: Set<NomoColorRole> = [
            .canvas, .surface, .raised, .text, .muted, .separator, .accent, .focus,
        ]
        for role in NomoColorRole.allCases {
            XCTAssertEqual(
                NomoPalette.platformColor(for: role) != nil,
                fromPlatform.contains(role),
                "\(role.rawValue) resolves to the wrong source"
            )
        }
    }

    func testTheFocusRingUsesTheAccentRole() {
        XCTAssertEqual(NomoColorRole.focus.systemName, NomoColorRole.accent.systemName)
        for appearance in NomoAppearance.allCases {
            XCTAssertEqual(
                NomoColorRole.focus.components(for: appearance),
                NomoColorRole.accent.components(for: appearance)
            )
        }
    }

    func testEveryRoleCarriesBothAppearances() {
        for role in NomoColorRole.allCases {
            XCTAssertNotEqual(role.light, role.dark, "\(role.rawValue) is the same in both appearances")
            XCTAssertEqual(role.components(for: .light), role.light)
            XCTAssertEqual(role.components(for: .dark), role.dark)
        }
    }

    func testEveryRecordedColourIsOpaque() {
        for role in NomoColorRole.allCases {
            for appearance in NomoAppearance.allCases {
                XCTAssertEqual(role.components(for: appearance).alpha, 1, "\(role.rawValue)")
            }
        }
    }
}

/// Corners are concentric with the element that contains them, so a nested
/// element takes a smaller role than its container.
final class NomoRadiiTests: XCTestCase {
    func testAControlInsideACardTakesTheSmallerRole() {
        XCTAssertTrue(NomoRadii.nests(.control, inside: .card))
        XCTAssertFalse(NomoRadii.nests(.card, inside: .control))
    }

    func testACardInsideASheetTakesTheSmallerRole() {
        XCTAssertTrue(NomoRadii.nests(.card, inside: .sheet))
        XCTAssertFalse(NomoRadii.nests(.sheet, inside: .card))
    }

    func testACapsuleRoundsPastEveryOtherRole() {
        for role in NomoRadiusRole.allCases {
            XCTAssertTrue(NomoRadii.nests(role, inside: .capsule), "\(role.rawValue) does not fit a capsule")
        }
    }

    func testTheRolesAreOrderedFromSmallestToLargest() {
        let radii = NomoRadii.bySize.map(\.radius)
        XCTAssertEqual(radii, radii.sorted())
    }

    func testTheLargestNestingRoleIsTheBiggestThatFits() {
        for outer in NomoRadiusRole.allCases {
            let nested = NomoRadii.largestNesting(inside: outer)
            XCTAssertTrue(NomoRadii.nests(nested, inside: outer))
            for role in NomoRadiusRole.allCases where role.radius > nested.radius {
                XCTAssertFalse(
                    NomoRadii.nests(role, inside: outer),
                    "\(role.rawValue) is larger than \(nested.rawValue) and does not fit inside \(outer.rawValue)"
                )
            }
        }
    }
}
