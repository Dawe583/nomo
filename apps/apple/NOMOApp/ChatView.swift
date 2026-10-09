import SwiftUI

/// The conversation surface.
///
/// Its shape is fixed by the design contract: a bounded transcript scrolls on
/// its own, notices and expanded tool details share a second bounded region,
/// and the composer stays outside both. The status rail above the transcript
/// does not scroll, because the operator must never have to scroll to learn
/// that they cannot act.
struct ChatView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @AppStorage("nomo-entry-language") private var entryLanguage = "en"

    let session: Session
    @StateObject private var chat: ChatSessionModel
    @FocusState private var composerFocused: Bool
    @State private var viewportHeight: CGFloat = 0

    init(session: Session) {
        self.session = session
        _chat = StateObject(wrappedValue: ChatSessionModel(
            sessionID: session.id,
            transport: ChatTransportFactory.make()
        ))
    }

    private var copy: AppCopy { AppCopy(language: entryLanguage) }
    private var chatCopy: ChatCopy { ChatCopy(language: entryLanguage) }

    private static let coordinateName = "chat.transcript"
    private static let bottomAnchor = "chat.transcript.bottom"

    var body: some View {
        ScrollViewReader { proxy in
            VStack(spacing: 0) {
                statusRail
                Divider()
                transcript(proxy: proxy)
                    .overlay(alignment: .bottom) { newMessagesBadge(proxy: proxy) }
                Divider()
                noticesRegion
                Divider()
                composer
            }
            .background(NomoColor.canvas)
            .task { await chat.load() }
            .onChange(of: chat.revision) { _, _ in
                if chat.isFollowingLatest { proxy.scrollTo(Self.bottomAnchor, anchor: .bottom) }
            }
        }
    }

    // MARK: Status rail

    private var statusRail: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .top, spacing: NomoMetrics.space6) {
                stateRow
                outcomeRow
            }
            VStack(alignment: .leading, spacing: NomoMetrics.space2) {
                stateRow
                outcomeRow
            }
        }
        .padding(.horizontal, NomoMetrics.space4)
        .padding(.vertical, NomoMetrics.space2)
        .frame(maxWidth: NomoMetrics.readableColumn, alignment: .leading)
        .frame(maxWidth: .infinity)
        .background(NomoColor.surface)
    }

    private var stateRow: some View {
        LabeledContent {
            Text(copy.connectionTitle(for: model.connectionState))
                .foregroundStyle(NomoColor.text)
        } label: {
            Text(copy.stateTitle)
                .foregroundStyle(NomoColor.mutedText)
        }
        .font(NomoFont.metadata)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("chat.state")
    }

    private var outcomeRow: some View {
        LabeledContent {
            Text(copy.outcomeTitle(for: session.outcome))
                .foregroundStyle(NomoColor.text)
        } label: {
            Text(copy.outcomeLabel)
                .foregroundStyle(NomoColor.mutedText)
        }
        .font(NomoFont.metadata)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("chat.outcome")
    }

    // MARK: Transcript

    private func transcript(proxy: ScrollViewProxy) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: NomoMetrics.space4) {
                transcriptNotices
                transcriptContent
                Color.clear
                    .frame(height: 1)
                    .id(Self.bottomAnchor)
                    .background(
                        GeometryReader { geometry in
                            Color.clear.preference(
                                key: TranscriptBottomKey.self,
                                value: geometry.frame(in: .named(Self.coordinateName)).maxY
                            )
                        }
                    )
            }
            .frame(maxWidth: NomoMetrics.readableColumn, alignment: .leading)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, NomoMetrics.space4)
            .padding(.vertical, NomoMetrics.space3)
        }
        .coordinateSpace(name: Self.coordinateName)
        .accessibilityIdentifier("chat.transcript")
        .background(
            GeometryReader { geometry in
                Color.clear.preference(key: TranscriptViewportKey.self, value: geometry.size.height)
            }
        )
        .scrollDismissesKeyboard(.interactively)
        .onPreferenceChange(TranscriptViewportKey.self) { viewportHeight = $0 }
        .onPreferenceChange(TranscriptBottomKey.self) { bottom in
            guard let bottom, viewportHeight > 0 else { return }
            // Hysteresis: a few points of drift while content is appended must
            // not be read as the operator scrolling away from the end.
            if bottom >= viewportHeight - 40 {
                chat.noteTranscriptPosition(isAtLatest: true)
            } else if bottom < viewportHeight - 120 {
                chat.noteTranscriptPosition(isAtLatest: false)
            }
        }
        .onChange(of: viewportHeight) { _, _ in
            if chat.isFollowingLatest { proxy.scrollTo(Self.bottomAnchor, anchor: .bottom) }
        }
        .onChange(of: chat.isFollowingLatest) { _, following in
            if following {
                withAnimation(reduceMotion ? nil : .easeInOut(duration: NomoMetrics.motionDuration)) {
                    proxy.scrollTo(Self.bottomAnchor, anchor: .bottom)
                }
            }
        }
    }

    @ViewBuilder
    private var transcriptContent: some View {
        switch chat.loadState {
        case .loading:
            ProgressView()
                .frame(maxWidth: .infinity)
                .padding(.vertical, NomoMetrics.space6)
                .accessibilityLabel(chatCopy.loadingTranscript)
        case .blocked(let reason):
            NomoCard(
                title: chatCopy.unavailableTitle,
                systemImage: "tray",
                detail: chatCopy.unavailableDetail(for: reason)
            )
            .accessibilityIdentifier("chat.transcript.unavailable")
        case .empty:
            NomoCard(
                title: chatCopy.emptyTitle,
                systemImage: "bubble.left",
                detail: chatCopy.emptyDetail
            )
            .accessibilityIdentifier("chat.transcript.empty")
        case .loaded:
            ForEach(chat.messages) { message in
                ChatMessageRow(
                    message: message,
                    chatCopy: chatCopy,
                    reduceMotion: reduceMotion,
                    expandedToolCallID: chat.expandedToolCallID,
                    onToggleToolCall: { chat.toggleToolCall($0) }
                )
            }
        }
    }

    @ViewBuilder
    private var transcriptNotices: some View {
        if chat.source == .interfaceSample {
            NomoNotice(kind: .sample, title: chatCopy.sampleTitle, detail: chatCopy.sampleBody)
                .accessibilityIdentifier("chat.notice.sample")
        }
        if !chat.isTranscriptComplete {
            NomoNotice(kind: .info, title: chatCopy.partialHistoryTitle, detail: chatCopy.partialHistoryBody)
                .accessibilityIdentifier("chat.notice.partialHistory")
        }
    }

    private func newMessagesBadge(proxy: ScrollViewProxy) -> some View {
        Group {
            if !chat.isFollowingLatest {
                Button {
                    withAnimation(reduceMotion ? nil : .easeInOut(duration: NomoMetrics.motionDuration)) {
                        chat.jumpToLatest()
                    }
                    proxy.scrollTo(Self.bottomAnchor, anchor: .bottom)
                } label: {
                    Label(chatCopy.newMessages, systemImage: "arrow.down")
                        .labelStyle(.titleAndIcon)
                        .font(NomoFont.metadataEmphasised)
                        .padding(.horizontal, NomoMetrics.space3)
                        .frame(minHeight: NomoMetrics.minTouchTarget)
                        .background(NomoColor.raised, in: Capsule())
                        .overlay(Capsule().strokeBorder(NomoColor.line, lineWidth: 1))
                }
                .buttonStyle(.plain)
                .foregroundStyle(NomoColor.accent)
                .padding(.bottom, NomoMetrics.space2)
                .accessibilityIdentifier("chat.newMessages")
            }
        }
    }

    // MARK: Bounded notices region

    private var noticesMaxHeight: CGFloat {
        // The notices region may grow, but it may never take the composer off
        // screen. At accessibility sizes it is allowed a little more room and
        // the transcript gives up the difference.
        dynamicTypeSize.isAccessibilitySize ? 220 : 180
    }

    private var hasNotices: Bool {
        chat.blockReason != nil || runNotice != nil || chat.expandedToolCall != nil
    }

    /// The last run's outcome, kept until the next run replaces it. "Stopping"
    /// and "Stopped" are separate states with separate wording, and a stop
    /// only claims that a tool request is still finishing when one actually is.
    private var runNotice: (title: String, detail: String?)? {
        switch chat.run {
        case .stopping: (chatCopy.stopping, nil)
        case .stopped(let pendingToolWork): (chatCopy.stopped, chatCopy.stoppedDetail(pendingToolWork: pendingToolWork))
        case .unavailable(let reason): (chatCopy.unavailableTitle, chatCopy.unavailableDetail(for: reason))
        case .idle, .streaming: nil
        }
    }

    @ViewBuilder
    private var noticesRegion: some View {
        if hasNotices {
            ScrollView(.vertical) {
                VStack(alignment: .leading, spacing: NomoMetrics.space2) {
                    Text(copy.sessionDetail(for: session))
                        .font(NomoFont.metadata)
                        .foregroundStyle(NomoColor.text)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("chat.session.detail")
                    if chat.blockReason != nil {
                        NomoNotice(kind: .blocked, title: copy.noActionOffline, detail: copy.noWriteAuthority)
                            .accessibilityIdentifier("chat.notice.blocked")
                        Text(copy.outcomeExplanation(for: session.outcome))
                            .font(NomoFont.metadata)
                            .foregroundStyle(NomoColor.mutedText)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("chat.notice.outcome")
                    }
                    if let runNotice {
                        NomoNotice(
                            kind: runNoticeKind,
                            title: runNotice.title,
                            detail: runNotice.detail
                        )
                        .accessibilityIdentifier("chat.notice.run")
                    }
                    if let call = chat.expandedToolCall {
                        // Expanded details live here, in the bounded region, so
                        // reading a large argument or result can never push the
                        // composer or Send out of reach.
                        ExpandedToolDetails(call: call, chatCopy: chatCopy)
                            .accessibilityIdentifier("chat.tool.details")
                        ToolCallDisclosure(
                            call: call,
                            chatCopy: chatCopy,
                            isExpanded: true,
                            identifier: "chat.tool.\(call.id).close",
                            action: { chat.toggleToolCall(call.id) }
                        )
                    }
                }
                .padding(NomoMetrics.space3)
                .frame(maxWidth: NomoMetrics.readableColumn, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
            .frame(maxHeight: noticesMaxHeight)
            .accessibilityIdentifier("chat.notices")
        }
    }

    private var runNoticeKind: NomoNotice.Kind {
        if case .unavailable = chat.run { return .blocked }
        return .warning
    }

    // MARK: Composer

    private var composer: some View {
        VStack(alignment: .leading, spacing: NomoMetrics.space2) {
            HStack(alignment: .bottom, spacing: NomoMetrics.space2) {
                TextField(chatCopy.composerPlaceholder, text: $chat.draft, axis: .vertical)
                    .lineLimit(1...6)
                    .textFieldStyle(.plain)
                    .font(NomoFont.messageBody)
                    .padding(NomoMetrics.space3)
                    .frame(minHeight: NomoMetrics.minTouchTarget)
                    .background(NomoColor.raised, in: RoundedRectangle(cornerRadius: NomoMetrics.corner))
                    .overlay(
                        RoundedRectangle(cornerRadius: NomoMetrics.corner)
                            .strokeBorder(composerFocused ? NomoColor.accent : NomoColor.line, lineWidth: 1)
                    )
                    .focused($composerFocused)
                    // The compact chat disables its input while blocked rather
                    // than accepting a draft it can never send.
                    .disabled(!chat.canCompose)
                    .accessibilityLabel(chatCopy.composerPlaceholder)
                    .accessibilityIdentifier("chat.composer")
                    .onSubmit {
                        // On a compact window Return belongs to the keyboard,
                        // as the design contract requires. A hardware keyboard
                        // sends with Command-Return.
                        if horizontalSizeClass == .regular { chat.send() }
                    }

                actionButton
            }

            Text(composerStatus)
                .font(NomoFont.metadata)
                .foregroundStyle(NomoColor.mutedText)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("chat.composer.status")
        }
        .padding(NomoMetrics.space3)
        .frame(maxWidth: NomoMetrics.readableColumn, alignment: .leading)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(NomoColor.canvas)
    }

    @ViewBuilder
    private var actionButton: some View {
        if chat.canStop {
            Button {
                chat.stop()
            } label: {
                Label(chatCopy.stop, systemImage: "stop.fill")
                    .labelStyle(.iconOnly)
            }
            .buttonStyle(NomoPrimaryButtonStyle())
            .accessibilityLabel(chatCopy.stop)
            .accessibilityIdentifier("chat.stop")
        } else {
            Button {
                chat.send()
            } label: {
                Label(chatCopy.send, systemImage: "arrow.up")
                    .labelStyle(.iconOnly)
            }
            .buttonStyle(NomoPrimaryButtonStyle())
            .disabled(!chat.canSend)
            .accessibilityLabel(chatCopy.send)
            .accessibilityIdentifier("chat.send")
            .keyboardShortcut(.return, modifiers: .command)
        }
    }

    private var composerStatus: String {
        if let reason = chat.blockReason { return chatCopy.composerStatus(for: reason) }
        if case .streaming = chat.run { return chatCopy.streaming }
        return chatCopy.composerIdleStatus
    }
}

// MARK: - Supporting views

struct NomoCard: View {
    let title: String
    let systemImage: String
    let detail: String

    var body: some View {
        VStack(alignment: .leading, spacing: NomoMetrics.space2) {
            Label(title, systemImage: systemImage)
                .font(NomoFont.uiLabelEmphasised)
                .foregroundStyle(NomoColor.text)
                .accessibilityAddTraits(.isHeader)
            Text(detail)
                .font(NomoFont.metadata)
                .foregroundStyle(NomoColor.mutedText)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(NomoMetrics.space4)
        .background(NomoColor.surface, in: RoundedRectangle(cornerRadius: NomoMetrics.corner))
        .overlay(
            RoundedRectangle(cornerRadius: NomoMetrics.corner)
                .strokeBorder(NomoColor.line, lineWidth: 1)
        )
    }
}

/// Expanded tool details live in the bounded notices region, never in the
/// submit path, so reading a large argument or result cannot push Send away.
struct ExpandedToolDetails: View {
    let call: ToolCall
    let chatCopy: ChatCopy

    var body: some View {
        VStack(alignment: .leading, spacing: NomoMetrics.space2) {
            Text(chatCopy.expandedDetailsTitle)
                .font(NomoFont.uiLabelEmphasised)
                .foregroundStyle(NomoColor.text)
                .accessibilityAddTraits(.isHeader)
            detail(chatCopy.toolArgumentsLabel, call.argumentSummary, code: true)
            detail(chatCopy.toolResultLabel, call.resultSummary, code: false)
            detail(chatCopy.toolSourceLabel, call.source, code: false)
            if let duration = call.durationLabel {
                detail(chatCopy.toolDurationLabel, duration, code: false)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(NomoMetrics.space3)
        .background(NomoColor.surface, in: RoundedRectangle(cornerRadius: NomoMetrics.corner))
        .overlay(
            RoundedRectangle(cornerRadius: NomoMetrics.corner)
                .strokeBorder(NomoColor.line, lineWidth: 1)
        )
        // One element: the panel is a single block of evidence, and leaving its
        // children addressable would make every line its own target.
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func detail(_ label: String, _ value: String?, code: Bool) -> some View {
        if let value, !value.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                    .font(NomoFont.metadata)
                    .foregroundStyle(NomoColor.mutedText)
                Text(value)
                    .font(code ? NomoFont.code : NomoFont.metadata)
                    .foregroundStyle(NomoColor.text)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

// MARK: - Scroll plumbing

private struct TranscriptBottomKey: PreferenceKey {
    nonisolated(unsafe) static var defaultValue: CGFloat?

    static func reduce(value: inout CGFloat?, nextValue: () -> CGFloat?) {
        value = value ?? nextValue()
    }
}

private struct TranscriptViewportKey: PreferenceKey {
    nonisolated(unsafe) static var defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}
