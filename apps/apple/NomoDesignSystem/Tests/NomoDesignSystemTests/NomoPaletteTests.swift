import Testing

@testable import NomoDesignSystem

/// The palette answers with the platform's own semantic colour wherever the
/// platform has one. A role quietly gaining or losing that answer is the
/// failure the token source exists to prevent, and the roles it takes are a
/// decision rather than a default: `onAccent`, `danger` and `good` resolve to
/// the recorded components because the document moved them to clear the
/// contrast gate, and taking the platform value would undo a measurement.
struct NomoPaletteTests {
    @Test func thePlatformRolesAreTheOnesWithAPlatformSemanticColour() {
        let fromPlatform: Set<NomoColorRole> = [
            .canvas, .surface, .raised, .text, .muted, .separator, .accent, .focus,
        ]
        for role in NomoColorRole.allCases {
            #expect(
                (NomoPalette.platformColor(for: role) != nil) == fromPlatform.contains(role),
                "\(role.rawValue) resolves to the wrong source"
            )
        }
    }

    @Test func theFocusRingUsesTheAccentRole() {
        #expect(NomoColorRole.focus.systemName == NomoColorRole.accent.systemName)
        for appearance in NomoAppearance.allCases {
            #expect(
                NomoColorRole.focus.components(for: appearance)
                    == NomoColorRole.accent.components(for: appearance)
            )
        }
    }

    @Test func everyRoleCarriesBothAppearances() {
        for role in NomoColorRole.allCases {
            #expect(role.light != role.dark, "\(role.rawValue) is the same in both appearances")
            #expect(role.components(for: .light) == role.light)
            #expect(role.components(for: .dark) == role.dark)
        }
    }

    @Test func everyRecordedColourIsOpaque() {
        for role in NomoColorRole.allCases {
            for appearance in NomoAppearance.allCases {
                #expect(role.components(for: appearance).alpha == 1, "\(role.rawValue)")
            }
        }
    }
}

/// Corners are concentric with the element that contains them, so a nested
/// element takes a smaller role than its container.
struct NomoRadiiTests {
    @Test func aControlInsideACardTakesTheSmallerRole() {
        #expect(NomoRadii.nests(.control, inside: .card))
        #expect(!NomoRadii.nests(.card, inside: .control))
    }

    @Test func aCardInsideASheetTakesTheSmallerRole() {
        #expect(NomoRadii.nests(.card, inside: .sheet))
        #expect(!NomoRadii.nests(.sheet, inside: .card))
    }

    @Test func aCapsuleRoundsPastEveryOtherRole() {
        for role in NomoRadiusRole.allCases {
            #expect(NomoRadii.nests(role, inside: .capsule), "\(role.rawValue) does not fit a capsule")
        }
    }

    @Test func theRolesAreOrderedFromSmallestToLargest() {
        let radii = NomoRadii.bySize.map(\.radius)
        #expect(radii == radii.sorted())
    }

    @Test func theLargestNestingRoleIsTheBiggestThatFits() {
        for outer in NomoRadiusRole.allCases {
            let nested = NomoRadii.largestNesting(inside: outer)
            #expect(NomoRadii.nests(nested, inside: outer))
            for role in NomoRadiusRole.allCases where role.radius > nested.radius {
                #expect(
                    !NomoRadii.nests(role, inside: outer),
                    "\(role.rawValue) is larger than \(nested.rawValue) and does not fit inside \(outer.rawValue)"
                )
            }
        }
    }
}
