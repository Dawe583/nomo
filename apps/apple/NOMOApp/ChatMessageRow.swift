import SwiftUI

/// One transcript entry.
///
/// A user turn is a single short utterance, so it is announced as one combined
/// element. An assistant turn contains structure — headings, lists, code,
/// tables — so its role label and its body stay separate and are read in
/// order instead of being flattened into one sentence. A tool call is a state
/// record, so its summary is one combined element and its disclosure stays a
/// separate control.
struct ChatMessageRow: View {
    let message: ChatMessage
    let chatCopy: ChatCopy
    let reduceMotion: Bool
    var expandedToolCallID: String?
    var onToggleToolCall: (String) -> Void

    var body: some View {
        switch message.role {
        case .user:
            userTurn
        case .assistant:
            assistantTurn
        case .tool:
            if let call = message.toolCall {
                ToolCallCard(
                    call: call,
                    chatCopy: chatCopy,
                    isExpanded: expandedToolCallID == call.id,
                    onToggle: { onToggleToolCall(call.id) }
                )
            }
        }
    }

    /// The role label names the message, so it carries the message's
    /// accessibility identifier. The identifier must not be attached to the
    /// message container instead: an identifier on a plain container is pushed
    /// down onto every accessibility element beneath it, so a table or a code
    /// block inside the message lost its own identity and answered to the
    /// message's identifier.
    private func roleLabel(identifier: String? = nil) -> some View {
        HStack(spacing: NomoMetrics.space2) {
            Image(systemName: roleSymbol).accessibilityHidden(true)
            Text(chatCopy.roleLabel(for: message.role))
                .font(NomoFont.metadataEmphasised)
                .foregroundStyle(NomoColor.mutedText)
                .accessibilityAddTraits(.isHeader)
                .modifier(OptionalIdentifier(identifier: identifier))
        }
    }

    private var roleSymbol: String {
        switch message.role {
        case .user: "person.crop.circle"
        case .assistant: "circle.dotted.circle"
        case .tool: "wrench.and.screwdriver"
        }
    }

    private var userTurn: some View {
        VStack(alignment: .leading, spacing: NomoMetrics.space1) {
            roleLabel()
            MarkdownText(source: message.text)
                .padding(NomoMetrics.space3)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(NomoColor.raised, in: RoundedRectangle(cornerRadius: NomoMetrics.corner))
                .overlay(
                    RoundedRectangle(cornerRadius: NomoMetrics.corner)
                        .strokeBorder(NomoColor.line, lineWidth: 1)
                )
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(chatCopy.roleLabel(for: .user)). \(message.text)")
        .accessibilityIdentifier("chat.message.user")
    }

    private var assistantTurn: some View {
        VStack(alignment: .leading, spacing: NomoMetrics.space1) {
            HStack(spacing: NomoMetrics.space2) {
                roleLabel(identifier: "chat.message.assistant")
                if message.state == .stopped {
                    NomoStatePill(label: chatCopy.partialAnswer, tone: .warning, symbol: "exclamationmark.triangle")
                }
            }
            if message.text.isEmpty {
                if message.state == .streaming {
                    StreamingIndicator(label: chatCopy.streaming, reduceMotion: reduceMotion)
                }
            } else {
                MarkdownText(source: message.text)
                if message.state == .streaming {
                    StreamingIndicator(label: chatCopy.streaming, reduceMotion: reduceMotion)
                }
            }
        }
    }
}

/// Applies an accessibility identifier only when there is one, so a shared
/// view can be named in one role and left anonymous in another.
private struct OptionalIdentifier: ViewModifier {
    let identifier: String?

    func body(content: Content) -> some View {
        if let identifier {
            content.accessibilityIdentifier(identifier)
        } else {
            content
        }
    }
}

/// A live run indicator. With reduced motion the glyph does not pulse; the
/// state is still announced, because the wording never changes.
struct StreamingIndicator: View {
    let label: String
    let reduceMotion: Bool
    @State private var pulse = false

    var body: some View {
        HStack(spacing: NomoMetrics.space2) {
            Image(systemName: "ellipsis")
                .font(NomoFont.metadataEmphasised)
                .foregroundStyle(NomoColor.accent)
                .opacity(reduceMotion ? 1 : (pulse ? 0.35 : 1))
                .accessibilityHidden(true)
            Text(label)
                .font(NomoFont.metadata)
                .foregroundStyle(NomoColor.mutedText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.updatesFrequently)
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: NomoMetrics.motionDuration).repeatForever(autoreverses: true)) {
                pulse = true
            }
        }
    }
}

/// A tool call. State and provenance come before raw arguments. A call that
/// needs an operator decision offers no control for it at all, rather than an
/// inert one, and the reason is stated in the card.
struct ToolCallCard: View {
    let call: ToolCall
    let chatCopy: ChatCopy
    let isExpanded: Bool
    let onToggle: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: NomoMetrics.space2) {
            summary
            ToolCallDisclosure(
                call: call,
                chatCopy: chatCopy,
                isExpanded: isExpanded,
                identifier: "chat.tool.\(call.id).disclosure",
                action: onToggle
            )
        }
        .padding(NomoMetrics.space3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(NomoColor.surface, in: RoundedRectangle(cornerRadius: NomoMetrics.corner))
        .overlay(
            RoundedRectangle(cornerRadius: NomoMetrics.corner)
                .strokeBorder(chatCopy.toolTone(call.state).color.opacity(0.45), lineWidth: 1)
        )
    }

    private var summary: some View {
        VStack(alignment: .leading, spacing: NomoMetrics.space2) {
            HStack(alignment: .firstTextBaseline, spacing: NomoMetrics.space2) {
                Text(call.name)
                    .font(NomoFont.uiLabelEmphasised)
                    .foregroundStyle(NomoColor.text)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: NomoMetrics.space2)
                NomoStatePill(
                    label: chatCopy.toolStateLabel(call.state),
                    tone: chatCopy.toolTone(call.state),
                    symbol: symbol(for: call.state)
                )
            }

            if let source = call.source {
                Text("\(chatCopy.toolSourceLabel): \(source)")
                    .font(NomoFont.metadata)
                    .foregroundStyle(NomoColor.mutedText)
            }

            if call.state == .incomplete {
                Text(chatCopy.incompleteCallDetail)
                    .font(NomoFont.metadata)
                    .foregroundStyle(NomoColor.text)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if call.requiresExecutorDecision && call.state == .awaitingApproval {
                Text(chatCopy.needsExecutorDecision)
                    .font(NomoFont.metadata)
                    .foregroundStyle(NomoColor.text)
                    .fixedSize(horizontal: false, vertical: true)
            }

            callSummary
                .font(NomoFont.metadata)
                .foregroundStyle(NomoColor.mutedText)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(chatCopy.toolCardSummary(call))
        .accessibilityIdentifier("chat.tool.\(call.id)")
    }

    private var callSummary: Text {
        var parts: [String] = []
        if let arguments = call.argumentSummary, !arguments.isEmpty {
            parts.append("\(chatCopy.toolArgumentsLabel): \(arguments)")
        }
        if let result = call.resultSummary, !result.isEmpty {
            parts.append("\(chatCopy.toolResultLabel): \(result)")
        }
        if let duration = call.durationLabel { parts.append(duration) }
        return Text(parts.isEmpty ? "—" : parts.joined(separator: " · "))
    }

    private func symbol(for state: ToolCall.State) -> String {
        switch state {
        case .queued: "clock"
        case .running: "arrow.triangle.2.circlepath"
        case .awaitingApproval: "hand.raised"
        case .completed: "checkmark.circle"
        case .failed: "xmark.octagon"
        case .denied: "nosign"
        case .cancelled: "slash.circle"
        case .incomplete: "questionmark.circle"
        }
    }
}

/// The disclosure control for a tool card. It is deliberately a sibling of the
/// combined summary, so the summary keeps reading as one sentence while the
/// control keeps its own name and target.
struct ToolCallDisclosure: View {
    let call: ToolCall
    let chatCopy: ChatCopy
    let isExpanded: Bool
    /// The transcript card and the notices region each show a disclosure for
    /// the same call, so they have to be separately addressable.
    let identifier: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label(
                isExpanded ? chatCopy.hideDetails : chatCopy.showDetails,
                systemImage: isExpanded ? "chevron.up" : "chevron.down"
            )
            .labelStyle(.titleAndIcon)
            .font(NomoFont.metadata)
            .frame(minHeight: NomoMetrics.minTouchTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(NomoColor.accent)
        .accessibilityIdentifier(identifier)
    }
}
