import Testing

@testable import NomoDesignSystem

/// The type ramp is quoted per platform, and the floor the guideline states is
/// the one a role may not fall under on either of them.
struct NomoTypeTests {
    @Test func everyTypeRoleIsAtLeastTheDocumentMinimumOnItsPlatform() {
        for role in NomoTypeRole.allCases {
            for platform in NomoPlatform.allCases {
                let metrics = role.metrics(for: platform)
                let minimum = platform == .macOS
                    ? NomoTypeRole.macOSMinimumSize
                    : NomoTypeRole.iosMinimumSize
                #expect(
                    metrics.size >= minimum,
                    "\(role.rawValue) is \(metrics.size) on \(platform.rawValue), floor \(minimum)"
                )
            }
        }
    }

    @Test func theRampIsOrderedFromLargestToSmallestOnBothPlatforms() {
        for platform in NomoPlatform.allCases {
            let sizes = NomoTypeRole.allCases.map { $0.metrics(for: platform).size }
            #expect(sizes == sizes.sorted(by: >), "\(platform.rawValue) is out of order")
        }
    }

    @Test func theLeadingNeverFallsBelowTheSizeItCarries() {
        for role in NomoTypeRole.allCases {
            for platform in NomoPlatform.allCases {
                let metrics = role.metrics(for: platform)
                #expect(
                    metrics.leading > metrics.size,
                    "\(role.rawValue) on \(platform.rawValue) has leading \(metrics.leading) at size \(metrics.size)"
                )
            }
        }
    }

    @Test func theEmphasisedWeightIsNeverLighterThanTheRoleItEmphasises() {
        for role in NomoTypeRole.allCases {
            for platform in NomoPlatform.allCases {
                let metrics = role.metrics(for: platform)
                guard let emphasised = metrics.emphasised else { continue }
                #expect(
                    emphasised.rank >= metrics.weight.rank,
                    "\(role.rawValue) on \(platform.rawValue) emphasises to \(emphasised.rawValue) from \(metrics.weight.rawValue)"
                )
            }
        }
    }
}
