import Foundation

/// The words the app says, read from `Localizable.xcstrings` for one language.
///
/// The entry screen stores a language key and the catalog holds every sentence,
/// so a language is data rather than a branch in code: adding a third language
/// is a catalog entry, not a second copy of every string. A key the catalog
/// does not carry resolves to itself, which is the one failure mode worth
/// designing for. The alternative is an empty control, and an empty control is
/// something nobody reports.
struct LocalizedCopy {
    private let bundle: Bundle

    /// `String(localized:locale:)` resolves through the language the device is
    /// set to rather than the one the picker holds, so a person who chose Czech
    /// on an English device was shown English. Opening the catalog's own
    /// directory is what makes the choice the operator made the one that is
    /// read. A language the bundle does not carry falls back to the source
    /// language, which is what a picker that has not been extended yet should
    /// show rather than a screen of raw keys.
    init(language: String) {
        self.bundle = LanguageCatalogs.bundle(for: language)
    }

    subscript(key: CopyKey) -> String {
        bundle.localizedString(forKey: key.rawValue, value: key.rawValue, table: nil)
    }
}

private enum LanguageCatalogs {
    /// The catalogs, opened once and kept. Every view rebuilds its copy on
    /// every body pass and opening a bundle reads its plist, so a lookup that
    /// opened one each time would cost more than the words are worth.
    nonisolated(unsafe) static let bundles: [String: Bundle] = {
        var opened: [String: Bundle] = [:]
        for language in Bundle.main.localizations {
            if let path = Bundle.main.path(forResource: language, ofType: "lproj") {
                opened[language] = Bundle(path: path)
            }
        }
        return opened
    }()

    static func bundle(for language: String) -> Bundle {
        bundles[language] ?? .main
    }
}
