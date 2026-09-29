import CompanionProtocolKit
import Foundation
import SwiftUI

@MainActor
final class AppModel: ObservableObject {
    enum ConnectionState: String, CaseIterable, Identifiable {
        case offline = "Offline"
        case paired = "Paired"

        case disconnected = "Disconnected"

        var id: String { rawValue }

        var statusDetail: String {
            switch self {
            case .offline:
                "Read-only until a trusted Mac is paired."
            case .paired:
                "Paired Mac detected; this build remains read-only."
            case .disconnected:
                "The paired Mac is not reachable; no action is available."
            }
        }

        var statusSymbolName: String {
            switch self {
            case .offline:
                "wifi.slash"
            case .paired:
                "checkmark.shield"
            case .disconnected:
                "exclamationmark.icloud"
            }
        }

        var isReadOnly: Bool { true }
    }

    enum PairingAvailability: Equatable {
        case unavailable
    }

    @Published private(set) var pairingAvailability: PairingAvailability = .unavailable

    var canPair: Bool {
        switch pairingAvailability {
        case .unavailable:
            false
        }
    }

    var isEntryReadOnly: Bool { true }

    var canRequestActions: Bool { false }

    /// What removing this device actually achieved. It is a value, not a
    /// sentence, so a removal that could not reach the executor is never
    /// reported to the operator as a completed revocation.
    enum RemovalOutcome: Equatable {
        /// The executor confirmed and the local credential is gone.
        case removed
        /// The local credential is gone but the executor was unreachable.
        case removedLocallyOnly
        /// The credential could not be deleted, so the removal did not happen.
        case failed

        var credentialDeleted: Bool { self != .failed }
    }

    @Published private(set) var connectionState: ConnectionState = .offline
    @Published private(set) var hasCompletedOnboarding: Bool
    @Published private(set) var sessions: [Session] = []
    @Published private(set) var executorName = "No executor selected"
    @Published private(set) var removalOutcome: RemovalOutcome?

    /// The in-memory transcript. It is a property of the app rather than of a
    /// transport because it is the app's own memory, and it is gone when the
    /// process is. The removal service purges this same instance, so a removal
    /// cannot leave a second cache behind.
    let transcript: TranscriptCache

    private let removal: DeviceRemovalService
    private let onboarding: OnboardingStateStore

    /// Nothing this app caches is ever authority for a mutation, so the answer
    /// is a value on the model rather than something each view has to
    /// remember.
    var cachedHistoryAuthority: TranscriptAuthority { .nonAuthoritative }

    init(
        transcript: TranscriptCache = TranscriptCache(),
        removal: DeviceRemovalService? = nil,
        onboarding: OnboardingStateStore = DefaultsOnboardingStateStore()
    ) {
        self.transcript = transcript
        // Restored rather than assumed, so a relaunch lands where the operator
        // left off instead of asking a question they already answered.
        self.onboarding = onboarding
        self.hasCompletedOnboarding = onboarding.hasCompletedOnboarding
        // This build has no paired transport, so it never reaches an executor
        // to revoke. The service is constructed with a revocation that reports
        // "not confirmed" rather than one that pretends it did; a build that
        // does pair injects the real call.
        self.removal = removal ?? DeviceRemovalService(
            credentials: KeychainDeviceCredentialStore(
                keychain: SecureKeychainStore(service: KeychainDeviceCredentialStore.defaultService)
            ),
            transcript: transcript,
            revoke: { _ in false }
        )
    }

    var connectionDetail: String { connectionState.statusDetail }

    /// Completing the entry screen is written where the next launch reads it,
    /// in the same call that flips the flag, so the two cannot disagree.
    func completeOnboarding() {
        hasCompletedOnboarding = true
        onboarding.hasCompletedOnboarding = true
    }

    func revokePairing() {
        connectionState = .offline
        executorName = "No executor selected"
    }

    func loadCachedSessions() {
        guard sessions.isEmpty else { return }
        sessions = [
            Session(id: "local-1", title: "No cached sessions", detail: "Connect an explicitly paired executor to view durable activity.", outcome: .unavailable),
            Session(id: "local-2", title: "Offline mode", detail: "Read-only until a trusted executor is paired.", outcome: .offline)
        ]
    }

    /// Remove this device: revoke it on the executor where that is possible,
    /// then delete the Keychain credential and empty every cache, so nothing
    /// that could authorise a later request survives the removal. The local
    /// half happens even when the executor is unreachable, and the outcome
    /// says which of the two the operator actually got.
    func removeThisDevice() async {
        let receipt: DeviceRemovalReceipt
        do {
            receipt = try await removal.removeStoredDevice()
        } catch {
            removalOutcome = .failed
            return
        }
        revokePairing()
        sessions = []
        removalOutcome = receipt.executorConfirmed ? .removed : .removedLocallyOnly
    }
}

/// Appearance choice for the whole app. `system` defers to the OS setting,
/// so the app never has to know what the platform thinks light or dark means.
enum AppTheme: String, CaseIterable, Identifiable {
    case system
    case light
    case dark

    var id: String { rawValue }

    /// `nil` means "no override", which is what following the system means.
    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}

struct Session: Identifiable, Equatable, Hashable {
    enum Outcome: String {
        case unavailable = "Unavailable"
        case offline = "Offline"
        case succeeded = "Succeeded"
        case conflict = "Conflict"
        case unknown = "Unknown"
        case partial = "Partial"
        case awaitingApproval = "Awaiting approval"
        case undoAvailable = "Undo available"
        case paused = "Paused"
    }

    let id: String
    let title: String
    let detail: String
    let outcome: Outcome
}
