import Foundation

/// Localised copy for the conversation surface, read from the string catalog.
///
/// Kept out of `AppCopy` on purpose: the entry screen and the activity list own
/// the connection and pairing vocabulary, and this surface must not become a
/// second place that wording is decided. Where a sentence already exists for
/// the operator, the chat view uses that one instead of writing a variant.
struct ChatCopy {
    private let strings: LocalizedCopy

    init(language: String) {
        self.strings = LocalizedCopy(language: language)
    }

    var conversationTitle: String { strings[.ChatTitle] }

    // Composer

    var composerPlaceholder: String { strings[.ChatComposerPlaceholder] }
    var send: String { strings[.ChatSend] }
    var stop: String { strings[.ChatStop] }
    var stopping: String { strings[.ChatStopping] }
    var stopped: String { strings[.ChatStopped] }
    var streaming: String { strings[.ChatStreaming] }

    /// What a stopped run means. The second half is only true when a tool call
    /// was already accepted, so it is not said unconditionally.
    func stoppedDetail(pendingToolWork: Bool) -> String {
        switch pendingToolWork {
        case true: strings[.ChatStoppedDetailPendingToolWork]
        case false: strings[.ChatStoppedDetailNoToolWork]
        }
    }

    /// Why the composer is inert. The control is disabled, so the reason has to
    /// be readable as text next to it rather than only as a button hint.
    func composerStatus(for reason: ChatBlockReason) -> String {
        switch reason {
        case .noExecutorSelected: strings[.ChatComposerStatusNoExecutorSelected]
        case .executorOffline: strings[.ChatComposerStatusExecutorOffline]
        case .readOnlyBuild: strings[.ChatComposerStatusReadOnlyBuild]
        }
    }

    var composerIdleStatus: String { strings[.ChatComposerIdle] }

    var toolDurationLabel: String { strings[.ChatToolDuration] }

    // Transcript states

    var loadingTranscript: String { strings[.ChatLoading] }

    var emptyTitle: String { strings[.ChatEmptyTitle] }
    var emptyDetail: String { strings[.ChatEmptyDetail] }

    var unavailableTitle: String { strings[.ChatUnavailableTitle] }

    func unavailableDetail(for reason: ChatBlockReason) -> String {
        switch reason {
        case .noExecutorSelected: strings[.ChatUnavailableDetailNoExecutorSelected]
        case .executorOffline: strings[.ChatUnavailableDetailExecutorOffline]
        case .readOnlyBuild: strings[.ChatUnavailableDetailReadOnlyBuild]
        }
    }

    var partialHistoryTitle: String { strings[.ChatPartialHistoryTitle] }
    var partialHistoryBody: String { strings[.ChatPartialHistoryBody] }

    var sampleTitle: String { strings[.ChatSampleTitle] }
    var sampleBody: String { strings[.ChatSampleBody] }

    var newMessages: String { strings[.ChatNewMessages] }

    // Roles

    func roleLabel(for role: ChatRole) -> String {
        switch role {
        case .user: strings[.ChatRoleUser]
        case .assistant: strings[.ChatRoleAssistant]
        case .tool: strings[.ChatRoleTool]
        }
    }

    var partialAnswer: String { strings[.ChatPartialAnswer] }

    // Tool cards

    var toolCardLabel: String { strings[.ChatToolCard] }
    var toolArgumentsLabel: String { strings[.ChatToolArguments] }
    var toolResultLabel: String { strings[.ChatToolResult] }
    var toolSourceLabel: String { strings[.ChatToolSource] }
    var showDetails: String { strings[.ChatToolShowDetails] }
    var hideDetails: String { strings[.ChatToolHideDetails] }
    var expandedDetailsTitle: String { strings[.ChatToolExpandedTitle] }

    var needsExecutorDecision: String { strings[.ChatToolNeedsDecision] }

    var incompleteCallDetail: String { strings[.ChatToolIncomplete] }

    func toolStateLabel(_ state: ToolCall.State) -> String {
        switch state {
        case .queued: strings[.ChatToolStateQueued]
        case .running: strings[.ChatToolStateRunning]
        case .awaitingApproval: strings[.ChatToolStateAwaitingApproval]
        case .completed: strings[.ChatToolStateCompleted]
        case .failed: strings[.ChatToolStateFailed]
        case .denied: strings[.ChatToolStateDenied]
        case .cancelled: strings[.ChatToolStateCancelled]
        case .incomplete: strings[.ChatToolStateIncomplete]
        }
    }

    func toolTone(_ state: ToolCall.State) -> VoidTone {
        switch state {
        case .queued, .running: .action
        case .awaitingApproval: .warning
        case .completed: .success
        case .failed, .denied: .danger
        case .cancelled, .incomplete: .unknown
        }
    }

    /// One sentence that carries a tool card's whole state, so a screen reader
    /// user is not left to assemble it from separate fragments, and so the
    /// reason a control is absent travels with the state itself.
    func toolCardSummary(_ call: ToolCall) -> String {
        var parts = ["\(toolCardLabel): \(call.name)", toolStateLabel(call.state)]
        if let source = call.source { parts.append("\(toolSourceLabel): \(source)") }
        if let duration = call.durationLabel { parts.append(duration) }
        if call.state == .incomplete { parts.append(incompleteCallDetail) }
        if call.requiresExecutorDecision && call.state == .awaitingApproval {
            parts.append(needsExecutorDecision)
        }
        return parts.joined(separator: ". ") + "."
    }
}
