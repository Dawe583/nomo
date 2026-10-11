import XCTest

@testable import NomoDesignSystem

/// The type ramp is quoted per platform, and the floor the guideline states is
/// the one a role may not fall under on either of them.
final class NomoTypeTests: XCTestCase {
    func testEveryTypeRoleIsAtLeastTheDocumentMinimumOnItsPlatform() {
        for role in NomoTypeRole.allCases {
            for platform in NomoPlatform.allCases {
                let metrics = role.metrics(for: platform)
                let minimum = platform == .macOS
                    ? NomoTypeRole.macOSMinimumSize
                    : NomoTypeRole.iosMinimumSize
                XCTAssertGreaterThanOrEqual(
                    metrics.size,
                    minimum,
                    "\(role.rawValue) is \(metrics.size) on \(platform.rawValue), floor \(minimum)"
                )
            }
        }
    }

    func testTheRampIsOrderedFromLargestToSmallestOnBothPlatforms() {
        for platform in NomoPlatform.allCases {
            let sizes = NomoTypeRole.allCases.map { $0.metrics(for: platform).size }
            XCTAssertEqual(sizes, sizes.sorted(by: >), "\(platform.rawValue) is out of order")
        }
    }

    func testTheLeadingNeverFallsBelowTheSizeItCarries() {
        for role in NomoTypeRole.allCases {
            for platform in NomoPlatform.allCases {
                let metrics = role.metrics(for: platform)
                XCTAssertGreaterThan(
                    metrics.leading,
                    metrics.size,
                    "\(role.rawValue) on \(platform.rawValue) has leading \(metrics.leading) at size \(metrics.size)"
                )
            }
        }
    }

    func testTheEmphasisedWeightIsNeverLighterThanTheRoleItEmphasises() {
        for role in NomoTypeRole.allCases {
            for platform in NomoPlatform.allCases {
                let metrics = role.metrics(for: platform)
                guard let emphasised = metrics.emphasised else { continue }
                XCTAssertGreaterThanOrEqual(
                    emphasised.rank,
                    metrics.weight.rank,
                    "\(role.rawValue) on \(platform.rawValue) emphasises to \(emphasised.rawValue) from \(metrics.weight.rawValue)"
                )
            }
        }
    }
}
