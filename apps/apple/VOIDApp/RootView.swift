import SwiftUI

struct RootView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var sidebarSelection: SidebarDestination? = .activity
    @AppStorage("void-entry-language") private var entryLanguage = "en"

    private var copy: AppCopy { AppCopy(language: entryLanguage) }

    var body: some View {
        Group {
            if !model.hasCompletedOnboarding {
                OnboardingView()
            } else if horizontalSizeClass == .regular {
                NavigationSplitView {
                    SidebarView(copy: copy, selection: $sidebarSelection)
                } detail: {
                    NavigationStack {
                        switch sidebarSelection ?? .activity {
                        case .activity:
                            SessionsView()
                        case .settings:
                            SettingsView()
                        }
                    }
                }
            } else {
                NavigationStack {
                    SessionsView()
                }
            }
        }
        .tint(.orange)
        .task {
            model.loadCachedSessions()
        }
    }
}

private enum SidebarDestination: Hashable {
    case activity
    case settings
}
private struct SidebarView: View {
    @EnvironmentObject private var model: AppModel
    let copy: AppCopy
    @Binding var selection: SidebarDestination?

    var body: some View {
        List(selection: $selection) {
            Section(copy.workspaceTitle) {
                NavigationLink(value: SidebarDestination.activity) {
                    Label(copy.activityTitle, systemImage: "clock.arrow.circlepath")
                        .frame(minHeight: 44)
                }
                NavigationLink(value: SidebarDestination.settings) {
                    Label(copy.settingsTitle, systemImage: "gearshape")
                        .frame(minHeight: 44)
                }
                .accessibilityIdentifier("sidebar.settings")
            }
            Section(copy.connectionTitle) {
                LabeledContent(copy.stateTitle, value: copy.connectionTitle(for: model.connectionState))
                Text(copy.connectionDetail(for: model.connectionState))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                LabeledContent(copy.accessTitle, value: copy.readOnly)
                LabeledContent(copy.executorTitle, value: copy.noExecutor)
            }
        }
        .navigationTitle("VOID")
    }
}
