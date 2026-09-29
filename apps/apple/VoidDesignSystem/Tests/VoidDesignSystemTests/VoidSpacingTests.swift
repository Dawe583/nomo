import XCTest

@testable import VoidDesignSystem

/// The rhythm is the rule the document states: a spacing value outside it is a
/// defect, and a defect that only a comment mentions is a defect nobody fixes.
final class VoidSpacingTests: XCTestCase {
    func testEveryNamedSpacingStepIsAMemberOfTheRhythm() {
        for step in VoidSpacing.steps {
            XCTAssertTrue(
                VoidSpacing.isOnRhythm(step),
                "\(step) is a named step that is not in \(VoidSpacing.rhythm)"
            )
        }
    }

    func testTheNamedStepsAndTheRhythmAreTheSameSet() {
        XCTAssertEqual(
            Set(VoidSpacing.steps.map { $0 }),
            Set(VoidSpacing.rhythm),
            "a name exists for a step that is not on the rhythm, or a step has no name"
        )
    }

    func testTheRhythmRises() {
        XCTAssertEqual(VoidSpacing.rhythm, VoidSpacing.rhythm.sorted())
        XCTAssertEqual(Set(VoidSpacing.rhythm).count, VoidSpacing.rhythm.count)
    }

    func testTheGuidelineConstantsSitOutsideTheRhythmOnPurpose() {
        XCTAssertFalse(VoidSpacing.isOnRhythm(VoidSpacing.contentGap))
        XCTAssertFalse(VoidSpacing.isOnRhythm(VoidSpacing.sectionGap))
    }

    func testTheStepsAroundAValueBracketIt() {
        let (below, above) = VoidSpacing.steps(around: 20)
        XCTAssertLessThanOrEqual(below, 20)
        XCTAssertGreaterThanOrEqual(above, 20)
        XCTAssertTrue(VoidSpacing.isOnRhythm(below))
        XCTAssertTrue(VoidSpacing.isOnRhythm(above))
        XCTAssertEqual(VoidSpacing.steps(around: 0).below, VoidSpacing.rhythm[0])
        XCTAssertEqual(VoidSpacing.steps(around: 10_000).above, VoidSpacing.rhythm[VoidSpacing.rhythm.count - 1])
    }

    func testTheMeasureNeverExceedsTheWidthItWasGiven() {
        for width in VoidSpacing.measureSteps {
            XCTAssertLessThanOrEqual(VoidSpacing.measure(forWidth: width), width)
        }
        // One point under the widest measure has to fall to the next one down,
        // which is the whole reason the measure is a list and not a maximum.
        XCTAssertEqual(
            VoidSpacing.measure(forWidth: VoidSpacing.measureSteps[0] - 1),
            VoidSpacing.measureSteps[1]
        )
        XCTAssertEqual(
            VoidSpacing.measure(forWidth: VoidSpacing.measureSteps[0]),
            VoidSpacing.measureSteps[0]
        )
    }
}
