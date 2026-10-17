import Testing

@testable import NomoDesignSystem

/// The rhythm is the rule the document states: a spacing value outside it is a
/// defect, and a defect that only a comment mentions is a defect nobody fixes.
struct NomoSpacingTests {
    @Test func everyNamedSpacingStepIsAMemberOfTheRhythm() {
        for step in NomoSpacing.steps {
            #expect(
                NomoSpacing.isOnRhythm(step),
                "\(step) is a named step that is not in \(NomoSpacing.rhythm)"
            )
        }
    }

    @Test func theNamedStepsAndTheRhythmAreTheSameSet() {
        #expect(
            Set(NomoSpacing.steps.map { $0 }) == Set(NomoSpacing.rhythm),
            "a name exists for a step that is not on the rhythm, or a step has no name"
        )
    }

    @Test func theRhythmRises() {
        #expect(NomoSpacing.rhythm == NomoSpacing.rhythm.sorted())
        #expect(Set(NomoSpacing.rhythm).count == NomoSpacing.rhythm.count)
    }

    @Test func theGuidelineConstantsSitOutsideTheRhythmOnPurpose() {
        #expect(!NomoSpacing.isOnRhythm(NomoSpacing.contentGap))
        #expect(!NomoSpacing.isOnRhythm(NomoSpacing.sectionGap))
    }

    @Test func theStepsAroundAValueBracketIt() {
        let (below, above) = NomoSpacing.steps(around: 20)
        #expect(below <= 20)
        #expect(above >= 20)
        #expect(NomoSpacing.isOnRhythm(below))
        #expect(NomoSpacing.isOnRhythm(above))
        #expect(NomoSpacing.steps(around: 0).below == NomoSpacing.rhythm[0])
        #expect(NomoSpacing.steps(around: 10_000).above == NomoSpacing.rhythm[NomoSpacing.rhythm.count - 1])
    }

    @Test func theMeasureNeverExceedsTheWidthItWasGiven() {
        for width in NomoSpacing.measureSteps {
            #expect(NomoSpacing.measure(forWidth: width) <= width)
        }
        // One point under the widest measure has to fall to the next one down,
        // which is the whole reason the measure is a list and not a maximum.
        #expect(
            NomoSpacing.measure(forWidth: NomoSpacing.measureSteps[0] - 1) == NomoSpacing.measureSteps[1]
        )
        #expect(
            NomoSpacing.measure(forWidth: NomoSpacing.measureSteps[0]) == NomoSpacing.measureSteps[0]
        )
    }
}
