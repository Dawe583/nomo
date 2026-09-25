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

    @Published private(set) var connectionState: ConnectionState = .offline
    @Published var hasCompletedOnboarding = false
    @Published private(set) var sessions: [Session] = []
    @Published private(set) var executorName = "No executor selected"

    var connectionDetail: String { connectionState.statusDetail }

    func completeOnboarding() {
        hasCompletedOnboarding = true
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
