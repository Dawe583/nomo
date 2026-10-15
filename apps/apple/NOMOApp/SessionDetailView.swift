import SwiftUI

/// A session in the activity list opens as a conversation.
///
/// The status, the outcome explanation and the no-action statement that used
/// to be the whole detail screen now live in the bounded notices region of
/// `ChatView`, so the reason an action is unavailable is read next to the
/// composer that cannot send, instead of on a separate page.
struct SessionDetailView: View {
    @AppStorage("nomo-entry-language") private var entryLanguage = "en"

    let session: Session

    private var copy: AppCopy { AppCopy(language: entryLanguage) }

    var body: some View {
        ChatView(session: session)
            .navigationTitle(copy.sessionTitle(for: session))
            .navigationBarTitleDisplayMode(.inline)
    }
}

struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @AppStorage("nomo-entry-language") private var entryLanguage = "en"
    @State private var showingRevokeConfirmation = false
    @State private var showingRemoveConfirmation = false

    private var copy: AppCopy { AppCopy(language: entryLanguage) }

    var body: some View {
        List {
            Section(copy.executorTitle) {
                LabeledContent(copy.stateTitle, value: copy.noExecutor)
                LabeledContent(copy.connectionTitle, value: copy.connectionTitle(for: model.connectionState))
                LabeledContent(copy.accessTitle, value: copy.readOnly)
                Text(copy.connectionDetail(for: model.connectionState))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Section(copy.connectionTitle) {
                Text(copy.pairingPolicyDetail)
                    .foregroundStyle(.secondary)
                Button(copy.revokeDevice, role: .destructive) {
                    showingRevokeConfirmation = true
                }
                .frame(minHeight: 44)
                .disabled(model.connectionState != .paired)
                .accessibilityHint(copy.revokeMessage)
            }
            Section(copy.privacyTitle) {
                Text(copy.settingsPrivacyDetail)
                    .foregroundStyle(.secondary)
            }
            Section(copy.cachePolicyTitle) {
                Text(copy.cachePolicyDetail)
                    .foregroundStyle(.secondary)
            }
            Section(copy.removeDevice) {
                Button(copy.removeDevice, role: .destructive) {
                    showingRemoveConfirmation = true
                }
                .frame(minHeight: 44)
                .accessibilityHint(copy.removeDeviceMessage)
                if let outcome = model.removalOutcome {
                    Text(copy.removalNotice(for: outcome))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle(copy.settingsTitle)
        .confirmationDialog(copy.revokeTitle, isPresented: $showingRevokeConfirmation, titleVisibility: .visible) {
            Button(copy.revoke, role: .destructive) { model.revokePairing() }
            Button(copy.cancel, role: .cancel) {}
        } message: {
            Text(copy.revokeMessage)
        }
        .confirmationDialog(copy.removeDeviceTitle, isPresented: $showingRemoveConfirmation, titleVisibility: .visible) {
            Button(copy.removeDevice, role: .destructive) { Task { await model.removeThisDevice() } }
            Button(copy.cancel, role: .cancel) {}
        } message: {
            Text(copy.removeDeviceMessage)
        }
    }
}
