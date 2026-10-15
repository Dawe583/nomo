import XCTest

@testable import NomoDesignSystem

/// The rhythm is the rule the document states: a spacing value outside it is a
/// defect, and a defect that only a comment mentions is a defect nobody fixes.
final class NomoSpacingTests: XCTestCase {
    func testEveryNamedSpacingStepIsAMemberOfTheRhythm() {
        for step in NomoSpacing.steps {
            XCTAssertTrue(
                NomoSpacing.isOnRhythm(step),
                "\(step) is a named step that is not in \(NomoSpacing.rhythm)"
            )
        }
    }

    func testTheNamedStepsAndTheRhythmAreTheSameSet() {
        XCTAssertEqual(
            Set(NomoSpacing.steps.map { $0 }),
            Set(NomoSpacing.rhythm),
            "a name exists for a step that is not on the rhythm, or a step has no name"
        )
    }

    func testTheRhythmRises() {
        XCTAssertEqual(NomoSpacing.rhythm, NomoSpacing.rhythm.sorted())
        XCTAssertEqual(Set(NomoSpacing.rhythm).count, NomoSpacing.rhythm.count)
    }

    func testTheGuidelineConstantsSitOutsideTheRhythmOnPurpose() {
        XCTAssertFalse(NomoSpacing.isOnRhythm(NomoSpacing.contentGap))
        XCTAssertFalse(NomoSpacing.isOnRhythm(NomoSpacing.sectionGap))
    }

    func testTheStepsAroundAValueBracketIt() {
        let (below, above) = NomoSpacing.steps(around: 20)
        XCTAssertLessThanOrEqual(below, 20)
        XCTAssertGreaterThanOrEqual(above, 20)
        XCTAssertTrue(NomoSpacing.isOnRhythm(below))
        XCTAssertTrue(NomoSpacing.isOnRhythm(above))
        XCTAssertEqual(NomoSpacing.steps(around: 0).below, NomoSpacing.rhythm[0])
        XCTAssertEqual(NomoSpacing.steps(around: 10_000).above, NomoSpacing.rhythm[NomoSpacing.rhythm.count - 1])
    }

    func testTheMeasureNeverExceedsTheWidthItWasGiven() {
        for width in NomoSpacing.measureSteps {
            XCTAssertLessThanOrEqual(NomoSpacing.measure(forWidth: width), width)
        }
        // One point under the widest measure has to fall to the next one down,
        // which is the whole reason the measure is a list and not a maximum.
        XCTAssertEqual(
            NomoSpacing.measure(forWidth: NomoSpacing.measureSteps[0] - 1),
            NomoSpacing.measureSteps[1]
        )
        XCTAssertEqual(
            NomoSpacing.measure(forWidth: NomoSpacing.measureSteps[0]),
            NomoSpacing.measureSteps[0]
        )
    }
}
