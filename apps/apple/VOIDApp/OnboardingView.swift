import SwiftUI

struct OnboardingView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @AppStorage("void-entry-language") private var entryLanguage = "en"
    @AppStorage("void-theme") private var theme: AppTheme = .system

    private var copy: AppCopy { AppCopy(language: entryLanguage) }

    var body: some View {
        Group {
            if horizontalSizeClass == .regular {
                NavigationSplitView {
                    EntrySidebar(copy: copy)
                } detail: {
                    EntryConnectionView(
                        copy: copy,
                        language: $entryLanguage,
                        theme: $theme,
                        showsHeader: false
                    )
                    .navigationTitle(copy.title)
                }
            } else {
                NavigationStack {
                    EntryConnectionView(
                        copy: copy,
                        language: $entryLanguage,
                        theme: $theme,
                        showsHeader: true
                    )
                    .navigationTitle(copy.title)
                }
            }
        }
        .tint(.orange)
    }
}

private struct EntrySidebar: View {
    let copy: AppCopy

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 12) {
                    Image(systemName: "circle.dotted.circle.fill")
                        .font(.system(size: 64))
                        .foregroundStyle(.orange)
                        .accessibilityHidden(true)
                    Text("VOID")
                        .font(.largeTitle.bold())
                        .accessibilityAddTraits(.isHeader)
                    Text(copy.accountTitle)
                        .font(.title3.bold())
                        .accessibilityAddTraits(.isHeader)
                    Text(copy.accountDetail)
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 12)
            }
        }
        .navigationTitle("VOID")
    }
}

private struct EntryConnectionView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    let copy: AppCopy
    @Binding var language: String
    @Binding var theme: AppTheme
    let showsHeader: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                if showsHeader {
                    let headerLayout = dynamicTypeSize.isAccessibilitySize
                        ? AnyLayout(VStackLayout(alignment: .leading, spacing: 16))
                        : AnyLayout(HStackLayout(alignment: .top, spacing: 16))
                    headerLayout {
                        Image(systemName: "circle.dotted.circle.fill")
                            .font(.system(size: 64))
                            .foregroundStyle(.orange)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 8) {
                            Text("VOID")
                                .font(.largeTitle.bold())
                                .accessibilityAddTraits(.isHeader)
                            Text(copy.title)
                                .font(.title2.bold())
                                .accessibilityAddTraits(.isHeader)
                        }
                    }
                }
                // Both preferences share one row when it fits. Two stacked
                // pickers pushed the pairing reason below the fold on a
                // 402-point-wide window, which the entry screen must not do:
                // the reason for the disabled pairing control has to be
                // readable without scrolling.
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .top, spacing: 16) {
                        EntryLanguagePicker(copy: copy, language: $language)
                        EntryThemePicker(copy: copy, theme: $theme)
                    }
                    VStack(alignment: .leading, spacing: 24) {
                        EntryLanguagePicker(copy: copy, language: $language)
                        EntryThemePicker(copy: copy, theme: $theme)
                    }
                }

                EntryCard(
                    title: copy.accountTitle,
                    detail: copy.accountDetail,
                    systemImage: "person.crop.circle.badge.questionmark"
                )
                EntryCard(
                    title: copy.pairingState,
                    detail: copy.pairingDetail,
                    systemImage: "link.badge.plus"
                )

                Text(copy.pairingSteps)
                    .foregroundStyle(.secondary)

                Button {
                    // Pairing cannot run in this build, and the reason is
                    // already on screen. An alert that can only ever confirm
                    // the same sentence is dead weight, and it would be
                    // unreachable anyway: the button is disabled whenever
                    // `canPair` is false, which is every state in this build.
                } label: {
                    Text(copy.connectMac)
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.bordered)
                .disabled(!model.canPair)

                Text(copy.pairingUnavailable)
                    .font(.footnote)
                    .foregroundStyle(.secondary)

                EntryCard(
                    title: copy.privacyTitle,
                    detail: copy.privacyDetail,
                    systemImage: "lock"
                )
                EntryCard(
                    title: copy.offlineState,
                    detail: copy.offlineDetail,
                    systemImage: "eye"
                )

                Button {
                    model.completeOnboarding()
                } label: {
                    Text(copy.continueOffline)
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.borderedProminent)
                .accessibilityHint(copy.offlineDetail)
            }
            .frame(maxWidth: 720, alignment: .leading)
            .frame(maxWidth: .infinity)
            .padding(24)
        }
    }
}

private struct EntryLanguagePicker: View {
    let copy: AppCopy
    @Binding var language: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(copy.languageLabel)
                .font(.headline)
                .accessibilityAddTraits(.isHeader)
            Picker(copy.languageLabel, selection: $language) {
                Text(copy.englishName).tag("en")
                Text(copy.czechName).tag("cs")
            }
            .pickerStyle(.segmented)
            .frame(minHeight: 44)
            .accessibilityLabel(copy.languageLabel)
        }
    }
}

private struct EntryThemePicker: View {
    let copy: AppCopy
    @Binding var theme: AppTheme

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(copy.themeLabel)
                .font(.headline)
                .accessibilityAddTraits(.isHeader)
            Picker(copy.themeLabel, selection: $theme) {
                Text(copy.themeSystemName).tag(AppTheme.system)
                Text(copy.themeLightName).tag(AppTheme.light)
                Text(copy.themeDarkName).tag(AppTheme.dark)
            }
            .pickerStyle(.segmented)
            .frame(minHeight: 44)
            .controlSize(.large)
            .accessibilityLabel(copy.themeLabel)
            .accessibilityIdentifier("entry.theme")
        }
    }
}

private struct EntryCard: View {
    let title: String
    let detail: String
    let systemImage: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(title, systemImage: systemImage)
                .font(.headline)
                .accessibilityAddTraits(.isHeader)
            Text(detail)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 6))
        .accessibilityElement(children: .combine)
    }
}

struct SessionsView: View {
    @EnvironmentObject private var model: AppModel
    @AppStorage("void-entry-language") private var entryLanguage = "en"
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    private var copy: AppCopy { AppCopy(language: entryLanguage) }

    var body: some View {
        List {
            Section {
                StatusCard(copy: copy)
            }
            Section {
                ForEach(model.sessions) { session in
                    NavigationLink(value: session) {
                        SessionRow(session: session, copy: copy)
                    }
                    .accessibilityLabel(
                        "\(copy.sessionTitle(for: session)), \(copy.outcomeTitle(for: session.outcome)), \(copy.sessionDetail(for: session))"
                    )
                }
            } header: {
                Text(copy.durableActivityTitle)
            } footer: {
                Text(copy.activityStateNote)
            }
        }
        .navigationTitle(copy.activityTitle)
        .navigationDestination(for: Session.self) { session in
            SessionDetailView(session: session)
        }
        .toolbar {
            if horizontalSizeClass == .compact {
                ToolbarItem(placement: .topBarTrailing) {
                    NavigationLink {
                        SettingsView()
                    } label: {
                        Image(systemName: "gearshape")
                    }
                    .frame(minWidth: 44, minHeight: 44)
                    .controlSize(.large)
                    .contentShape(Rectangle())
                    .accessibilityLabel(copy.settingsTitle)
                    .accessibilityIdentifier("activity.settings")
                }
            }
        }
    }
}

private struct StatusCard: View {
    @EnvironmentObject private var model: AppModel
    let copy: AppCopy

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(
                copy.connectionTitle(for: model.connectionState),
                systemImage: model.connectionState.statusSymbolName
            )
            .font(.headline)
            Text(copy.connectionDetail(for: model.connectionState))
                .font(.subheadline)
                .foregroundStyle(.secondary)
            if !model.canRequestActions {
                Text(copy.noWriteAuthority)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
    }
}

private struct SessionRow: View {
    let session: Session
    let copy: AppCopy

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(copy.sessionTitle(for: session))
                .font(.headline)
            Text(copy.sessionDetail(for: session))
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Text(copy.outcomeTitle(for: session.outcome))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
    }
}
