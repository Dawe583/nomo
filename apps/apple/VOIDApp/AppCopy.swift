import Foundation

/// User-facing copy for the local companion, read from the string catalog.
///
/// The picker stores a language key and every sentence lives in
/// `Localizable.xcstrings`, which keeps the entry screen and the activity
/// surfaces from drifting into different partial localizations: both read the
/// same key.
struct AppCopy {
    private let strings: LocalizedCopy

    init(language: String) {
        self.strings = LocalizedCopy(language: language)
    }

    var accessReadOnly: String { readOnly }

    var title: String { strings[.EntryTitle] }
    var accountTitle: String { strings[.EntryAccountTitle] }
    var accountDetail: String { strings[.EntryAccountDetail] }
    var languageLabel: String { strings[.EntryLanguageLabel] }
    var englishName: String { strings[.EntryLanguageEnglish] }
    var czechName: String { strings[.EntryLanguageCzech] }
    var themeLabel: String { strings[.EntryThemeLabel] }
    var themeSystemName: String { strings[.EntryThemeSystem] }
    var themeLightName: String { strings[.EntryThemeLight] }
    var themeDarkName: String { strings[.EntryThemeDark] }
    var pairingState: String { strings[.EntryPairingState] }
    var pairingDetail: String { strings[.EntryPairingDetail] }
    var pairingSteps: String { strings[.EntryPairingSteps] }
    var connectMac: String { strings[.EntryPairingConnectMac] }
    var pairingUnavailable: String { strings[.EntryPairingUnavailable] }
    var privacyTitle: String { strings[.EntryPrivacyTitle] }
    var privacyDetail: String { strings[.EntryPrivacyDetail] }
    var offlineState: String { strings[.EntryOfflineState] }
    var offlineDetail: String { strings[.EntryOfflineDetail] }
    var continueOffline: String { strings[.EntryOfflineContinue] }

    var workspaceTitle: String { strings[.ActivityWorkspace] }
    var activityTitle: String { strings[.ActivityTitle] }
    var durableActivityTitle: String { strings[.ActivityDurable] }
    var activityStateNote: String { strings[.ActivityStateNote] }
    var connectionTitle: String { strings[.ConnectionTitle] }
    var stateTitle: String { strings[.ConnectionState] }
    var accessTitle: String { strings[.AccessTitle] }
    var readOnly: String { strings[.AccessReadOnly] }
    var executorTitle: String { strings[.ExecutorTitle] }
    var noExecutor: String { strings[.ExecutorNone] }
    var pairedExecutorDetail: String { strings[.ExecutorPairedDetail] }
    var disconnectedDetail: String { strings[.ExecutorDisconnectedDetail] }
    var noWriteAuthority: String { strings[.WriteAuthority] }

    var settingsPrivacyTitle: String { strings[.PrivacyTitle] }
    var settingsTitle: String { strings[.SettingsTitle] }
    var settingsPrivacyDetail: String { strings[.SettingsPrivacyDetail] }
    var pairingPolicyDetail: String { strings[.SettingsPairingPolicy] }
    var revokeDevice: String { strings[.RevokeDevice] }
    var revokeTitle: String { strings[.RevokeTitle] }
    var cachePolicyTitle: String { strings[.CacheTitle] }
    var cachePolicyDetail: String { strings[.CacheDetail] }
    var removeDevice: String { strings[.RemoveDevice] }
    var removeDeviceTitle: String { strings[.RemoveDeviceTitle] }
    var removeDeviceMessage: String { strings[.RemoveDeviceMessage] }
    var removeDeviceDone: String { strings[.RemoveDeviceDone] }
    var removeDeviceUnconfirmed: String { strings[.RemoveDeviceUnconfirmed] }
    var noCachedSessionsTitle: String { strings[.ActivityNoCachedTitle] }
    var noCachedSessionsDetail: String { strings[.ActivityNoCachedDetail] }
    var offlineModeTitle: String { strings[.OfflineModeTitle] }
    var revokeMessage: String { strings[.RevokeMessage] }
    var revoke: String { strings[.Revoke] }
    var cancel: String { strings[.Cancel] }
    var statusTitle: String { strings[.StatusTitle] }
    var outcomeLabel: String { strings[.OutcomeLabel] }
    var detailsTitle: String { strings[.DetailsTitle] }
    var noActionOffline: String { strings[.ActionOffline] }
    var noActionReadOnly: String { strings[.ActionReadOnly] }

    func outcomeTitle(for outcome: Session.Outcome) -> String {
        switch outcome {
        case .awaitingApproval: strings[.OutcomeAwaitingApprovalTitle]
        case .undoAvailable: strings[.OutcomeUndoAvailableTitle]
        case .conflict: strings[.OutcomeConflictTitle]
        case .unknown: strings[.OutcomeUnknownTitle]
        case .paused: strings[.OutcomePausedTitle]
        case .partial: strings[.OutcomePartialTitle]
        case .succeeded: strings[.OutcomeSucceededTitle]
        case .offline: strings[.OutcomeOfflineTitle]
        case .unavailable: strings[.OutcomeUnavailableTitle]
        }
    }

    func outcomeExplanation(for outcome: Session.Outcome) -> String {
        switch outcome {
        case .awaitingApproval: strings[.OutcomeAwaitingApprovalExplanation]
        case .undoAvailable: strings[.OutcomeUndoAvailableExplanation]
        case .conflict: strings[.OutcomeConflictExplanation]
        case .unknown: strings[.OutcomeUnknownExplanation]
        case .paused: strings[.OutcomePausedExplanation]
        case .partial: strings[.OutcomePartialExplanation]
        case .succeeded: strings[.OutcomeSucceededExplanation]
        case .offline: strings[.OutcomeOfflineExplanation]
        case .unavailable: strings[.OutcomeUnavailableExplanation]
        }
    }

    /// What the app says after a removal. The three outcomes are three
    /// different claims, and saying "done" for a local-only removal would
    /// leave the operator believing the executor had stopped honouring the
    /// device when it had not.
    func removalNotice(for outcome: AppModel.RemovalOutcome) -> String {
        switch outcome {
        case .removed: removeDeviceDone
        case .removedLocallyOnly, .failed: removeDeviceUnconfirmed
        }
    }

    func connectionTitle(for state: AppModel.ConnectionState) -> String {
        switch state {
        case .offline: strings[.ConnectionStateOffline]
        case .paired: strings[.ConnectionStatePaired]
        case .disconnected: strings[.ConnectionStateDisconnected]
        }
    }

    func sessionTitle(for session: Session) -> String {
        if session.id == "local-1" { return noCachedSessionsTitle }
        if session.id == "local-2" { return offlineModeTitle }
        return session.title
    }

    func sessionDetail(for session: Session) -> String {
        if session.id == "local-1" { return noCachedSessionsDetail }
        if session.id == "local-2" { return offlineDetail }
        return session.detail
    }

    func connectionDetail(for state: AppModel.ConnectionState) -> String {
        switch state {
        case .offline: strings[.ConnectionDetailOffline]
        case .paired: pairedExecutorDetail
        case .disconnected: disconnectedDetail
        }
    }
}
