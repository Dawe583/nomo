import Foundation

/// Where a completed entry screen is remembered across launches.
///
/// It is the app's own defaults, next to the appearance and the language the
/// entry screen already owns, and not the process: a preference the app forgets
/// at quit is a preference the operator has to give again, and the entry screen
/// is the first thing they see. The interface is a protocol because the model
/// takes the store as an argument, so a test can hold one in memory and read
/// back what a relaunch would read.
protocol OnboardingStateStore: AnyObject {
    var hasCompletedOnboarding: Bool { get set }
}

final class DefaultsOnboardingStateStore: OnboardingStateStore {
    /// A namespaced key, because this is app state rather than something a
    /// view reads out of the defaults directly.
    static let key = "void-onboarding-completed"

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    var hasCompletedOnboarding: Bool {
        get { defaults.bool(forKey: Self.key) }
        set { defaults.set(newValue, forKey: Self.key) }
    }
}
