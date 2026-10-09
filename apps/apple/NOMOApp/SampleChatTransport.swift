import Foundation

#if DEBUG
/// A scripted transport used only by UI tests, and only when they pass the
/// `NOMO_CHAT_FIXTURE` launch argument. It exists so the transcript, the
/// table and code rendering, the streaming states, and the stop path can be
/// exercised on a real surface.
///
/// It talks to nothing. Every transcript it returns is labelled
/// `interfaceSample` in the UI, so sample text is never presented as executor
/// data, and it contains no credential of any kind.
struct SampleChatTransport: ChatTransport {
    enum Mode {
        case history
        case empty
        case streaming
    }

    let mode: Mode

    var availability: ChatTransportAvailability {
        // Only the streaming fixture pretends a run can start, because that is
        // the only fixture that needs a live run. The other two keep sending
        // disabled so the inert-composer state is still the default reading.
        mode == .streaming ? .available : .unavailable(.readOnlyBuild)
    }

    func transcript(for sessionID: String) async throws -> ChatTranscriptPage {
        switch mode {
        case .empty:
            return ChatTranscriptPage(items: [], source: .interfaceSample, isComplete: true)
        case .history, .streaming:
            return ChatTranscriptPage(items: Self.history, source: .interfaceSample, isComplete: false)
        }
    }

    func run(_ request: ChatRunRequest) -> AsyncThrowingStream<ChatRunEvent, Error> {
        AsyncThrowingStream { continuation in
            let producer = Task<Void, Never> {
                do {
                    let messageID = "assistant-\(request.idempotencyKey)"
                    continuation.yield(.messageStarted(id: messageID))
                    var received = ""
                    for chunk in Self.streamChunks {
                        try Task.checkCancellation()
                        try await Task.sleep(for: .milliseconds(180))
                        received += chunk
                        continuation.yield(.messageDelta(id: messageID, text: chunk))
                    }
                    // The tool is accepted before the last stretch of text, so
                    // stopping here has to say that a request already accepted
                    // elsewhere is not recalled.
                    continuation.yield(.toolUpserted(ToolCall(
                        id: "call-1",
                        name: "document.write",
                        source: "workspace",
                        state: .running,
                        argumentSummary: "path=plan.md, revision=41",
                        resultSummary: nil,
                        durationLabel: nil,
                        requiresExecutorDecision: false
                    )))
                    for chunk in Self.streamChunks {
                        try Task.checkCancellation()
                        try await Task.sleep(for: .milliseconds(180))
                        received += chunk
                        continuation.yield(.messageDelta(id: messageID, text: chunk))
                    }
                    try Task.checkCancellation()
                    continuation.yield(.messageCompleted(id: messageID, finalText: received))
                    continuation.yield(.finished)
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in producer.cancel() }
        }
    }

    // MARK: Scripted content

    private static let streamChunks: [String] = {
        let sentence = "The workspace is unchanged, so the next step is a review of the bounded event window rather than a re-run. "
        return Array(repeating: sentence, count: 22)
    }()

    private static let history: [ChatMessage] = [
        ChatMessage(
            id: "user-1",
            role: .user,
            text: "Summarise what changed in `plan.md`, and keep the table of revisions.",
            state: .complete,
            toolCall: nil
        ),
        ChatMessage(
            id: "tool-call-read",
            role: .tool,
            text: "",
            state: .complete,
            toolCall: ToolCall(
                id: "call-read",
                name: "document.read",
                source: "workspace",
                state: .completed,
                argumentSummary: "path=plan.md, revision=41, limit=400",
                resultSummary: "Read 312 lines from plan.md at revision 41.",
                durationLabel: "0.4 s",
                requiresExecutorDecision: false
            )
        ),
        ChatMessage(
            id: "assistant-1",
            role: .assistant,
            text: """
            ## What changed

            The plan gained a compaction step and lost the hand-written rollback notes.

            - **Added** a bounded context compaction at roughly 60% of the window.
            - **Removed** the manual rollback section, which conflicted with the ledger.
            - **Unchanged** the signing rules and the tool risk classes.

            | Revision | Change | Origin | Reversible |
            | --- | --- | --- | --- |
            | 41 | Compaction step added | `plan.edit` | Yes, Undo is offered |
            | 40 | Rollback notes removed | `plan.edit` | Yes, Undo is offered |
            | 39 | Signing rules | manual | No, ledger entry only |

            ```swift
            func compact(window: Int, used: Int) -> Bool {
                guard window > 0 else { return false }
                return used * 10 >= window * 6
            }
            ```

            > Rollback availability is decided on the Mac. This companion does not offer it.

            Read more about the window in [the design contract](https://example.invalid/contract) or ask for the full diff.

            A refused scheme stays visible as plain text instead of becoming a link: [raw notes](file:///var/nomo/notes.md).

            <script>alert('this line is text, never markup')</script>
            """,
            state: .complete,
            toolCall: nil
        ),
        ChatMessage(
            id: "tool-call-approve",
            role: .tool,
            text: "",
            state: .complete,
            toolCall: ToolCall(
                id: "call-approve",
                name: "document.write",
                source: "workspace",
                state: .awaitingApproval,
                argumentSummary: "path=plan.md, revision=41, bytes=1840",
                resultSummary: nil,
                durationLabel: nil,
                requiresExecutorDecision: true
            )
        ),
        ChatMessage(
            id: "tool-call-partial",
            role: .tool,
            text: "",
            state: .complete,
            toolCall: ToolCall(
                id: "call-partial",
                name: "shell.exec",
                source: "workspace",
                state: .incomplete,
                argumentSummary: "command was cut off mid-call",
                resultSummary: nil,
                durationLabel: nil,
                requiresExecutorDecision: false
            )
        ),
        ChatMessage(
            id: "assistant-2",
            role: .assistant,
            text: """
            The long answer, so the transcript gets a realistic reading column: a paragraph that runs on long enough to prove the measure holds at every Dynamic Type size without pushing the composer out of the viewport, followed by another paragraph so the scroll behaviour is visible rather than asserted.

            Nothing in this sample was produced by an executor. It exists to show how the transcript reads, and the banner above it says so.

            ```
            let column = 760
            ```
            """,
            state: .complete,
            toolCall: nil
        )
    ]
}
#endif
