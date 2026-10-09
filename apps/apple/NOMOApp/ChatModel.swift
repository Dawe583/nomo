import Foundation

// MARK: - Transcript values

enum ChatRole: String, Equatable, Sendable {
    case user
    case assistant
    case tool
}

enum ChatMessageState: String, Equatable, Sendable {
    case streaming
    case complete
    /// The operator stopped the run. Text that had already arrived is kept and
    /// marked as partial. It is never silently promoted to a finished answer.
    case stopped
}

struct ToolCall: Identifiable, Equatable, Sendable {
    enum State: String, Equatable, Sendable, CaseIterable {
        case queued
        case running
        case awaitingApproval
        case completed
        case failed
        case denied
        case cancelled
        /// The call arrived split across deltas and is not valid yet. It is
        /// shown so nothing is hidden, and it is never executed.
        case incomplete

        var isTerminal: Bool {
            switch self {
            case .queued, .running, .awaitingApproval, .incomplete: false
            case .completed, .failed, .denied, .cancelled: true
            }
        }
    }

    let id: String
    var name: String
    var source: String?
    var state: State
    var argumentSummary: String?
    var resultSummary: String?
    var durationLabel: String?
    /// True when settling this call needs an operator decision that only a
    /// paired Mac can make. It is why the card offers no button at all rather
    /// than an inert one.
    var requiresExecutorDecision: Bool
}

struct ChatMessage: Identifiable, Equatable, Sendable {
    let id: String
    let role: ChatRole
    var text: String
    var state: ChatMessageState
    var toolCall: ToolCall?
}

// MARK: - Run state

/// Why the chat cannot start a run. This is a value, not a sentence, so every
/// surface can say it in its own words instead of repeating one string.
enum ChatBlockReason: String, Equatable, Sendable, CaseIterable {
    case noExecutorSelected
    case executorOffline
    case readOnlyBuild
}

enum ChatTransportAvailability: Equatable, Sendable {
    case available
    case unavailable(ChatBlockReason)

    var blockReason: ChatBlockReason? {
        if case .unavailable(let reason) = self { return reason }
        return nil
    }
}

enum ChatRunState: Equatable, Sendable {
    case idle
    case streaming
    case stopping
    case stopped(pendingToolWork: Bool)
    case unavailable(ChatBlockReason)
}

enum ChatLoadState: Equatable, Sendable {
    case loading
    case loaded
    /// The executor answered and this conversation genuinely has no messages.
    /// That is a different claim from being unable to ask.
    case empty
    case blocked(ChatBlockReason)
}

/// Where the transcript on screen came from. The companion has no transport
/// yet, so everything it can show is either its own explanatory copy or a
/// clearly labelled interface sample. It never presents sample text as
/// executor data.
enum ChatTranscriptSource: String, Equatable, Sendable {
    case executor
    case interfaceSample
}

struct ChatTranscriptPage: Equatable, Sendable {
    let items: [ChatMessage]
    let source: ChatTranscriptSource
    let isComplete: Bool
}

struct ChatRunRequest: Equatable, Sendable {
    let sessionID: String
    /// One key per send, so a reconnect or a double tap cannot become two turns.
    let idempotencyKey: String
    let text: String
}

enum ChatRunEvent: Equatable, Sendable {
    case messageStarted(id: String)
    case messageDelta(id: String, text: String)
    /// `finalText` is the authoritative message. When it is present it
    /// replaces whatever streamed in, which is how a truncated stream is
    /// repaired after a reconnect.
    case messageCompleted(id: String, finalText: String?)
    case toolUpserted(ToolCall)
    case finished
}

// MARK: - Transport seam

enum ChatTransportError: Error, Equatable, Sendable {
    case blocked(ChatBlockReason)
    case unknownTool(String)
}

protocol ChatTransport: Sendable {
    var availability: ChatTransportAvailability { get }
    func transcript(for sessionID: String) async throws -> ChatTranscriptPage
    func run(_ request: ChatRunRequest) -> AsyncThrowingStream<ChatRunEvent, Error>
}

/// The only transport this build ships. It has no socket to open, so it fails
/// closed on every call and names the reason rather than inventing a result.
struct OfflineChatTransport: ChatTransport {
    let availability: ChatTransportAvailability = .unavailable(.readOnlyBuild)

    func transcript(for sessionID: String) async throws -> ChatTranscriptPage {
        throw ChatTransportError.blocked(.readOnlyBuild)
    }

    func run(_ request: ChatRunRequest) -> AsyncThrowingStream<ChatRunEvent, Error> {
        AsyncThrowingStream { continuation in
            continuation.finish(throwing: ChatTransportError.blocked(.readOnlyBuild))
        }
    }
}

// MARK: - Session model

@MainActor
final class ChatSessionModel: ObservableObject {
    @Published private(set) var messages: [ChatMessage] = []
    @Published private(set) var loadState: ChatLoadState = .loading
    @Published private(set) var run: ChatRunState = .idle
    @Published private(set) var source: ChatTranscriptSource = .executor
    @Published private(set) var isTranscriptComplete = true
    @Published private(set) var expandedToolCallID: String?
    @Published private(set) var isFollowingLatest = true
    @Published var draft = ""

    let sessionID: String


    private let transport: any ChatTransport
    private var runTask: Task<Void, Never>?
    private var hasRequestedLoad = false
    private var stopRequested = false
    private var turnCounter = 0
    /// Bumped whenever the transcript changes, so the scroll follower can tell
    /// a new message from a re-render.
    @Published private(set) var revision = 0

    init(sessionID: String, transport: any ChatTransport) {
        self.sessionID = sessionID
        self.transport = transport
    }


    /// The compact chat disables its input while blocked, so this is false in
    /// every shipping state: an empty editable field would promise a send that
    /// cannot happen.
    var canCompose: Bool { transport.availability == .available }

    var availability: ChatTransportAvailability { transport.availability }

    var blockReason: ChatBlockReason? { transport.availability.blockReason }

    /// A stopped run is a finished run, so the next turn is still allowed.
    /// Only a live or stopping run blocks a new one.
    var isRunActive: Bool { run == .streaming || run == .stopping }

    var canSend: Bool {
        guard transport.availability == .available else { return false }
        guard !isRunActive else { return false }
        return !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var canStop: Bool { run == .streaming }

    var expandedToolCall: ToolCall? {
        guard let id = expandedToolCallID else { return nil }
        return messages.first { $0.toolCall?.id == id }?.toolCall
    }

    func load() async {
        guard !hasRequestedLoad else { return }
        hasRequestedLoad = true
        loadState = .loading
        do {
            let page = try await transport.transcript(for: sessionID)
            source = page.source
            isTranscriptComplete = page.isComplete
            messages = page.items
            loadState = page.items.isEmpty ? .empty : .loaded
        } catch {
            messages = []
            loadState = .blocked(Self.reason(for: error))
        }
        revision += 1
    }

    /// Sends the draft. Fails closed when there is no transport: a message the
    /// executor never received must not be inserted into the local transcript.
    /// The composer is already disabled in that state, so this is the belt to
    /// that braces rather than a second, different code path.
    func send() {
        guard transport.availability == .available else { return }
        guard !isRunActive else { return }
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }

        turnCounter += 1
        let request = ChatRunRequest(
            sessionID: sessionID,
            idempotencyKey: "\(sessionID)-turn-\(turnCounter)",
            text: text
        )
        messages.append(ChatMessage(id: request.idempotencyKey, role: .user, text: text, state: .complete, toolCall: nil))
        draft = ""
        isFollowingLatest = true
        startRun(request)
    }

    func stop() {
        guard case .streaming = run else { return }
        // "Stopping" is its own state. The run is not described as stopped
        // until the stream has actually ended.
        run = .stopping
        stopRequested = true
        runTask?.cancel()
    }

    func toggleToolCall(_ id: String) {
        expandedToolCallID = expandedToolCallID == id ? nil : id
    }

    func noteTranscriptPosition(isAtLatest: Bool) {
        guard isAtLatest != isFollowingLatest else { return }
        isFollowingLatest = isAtLatest
    }

    func jumpToLatest() {
        isFollowingLatest = true
    }

    // MARK: Run plumbing

    private func startRun(_ request: ChatRunRequest) {
        run = .streaming
        runTask = Task { [weak self] in
            guard let self else { return }
            do {
                for try await event in transport.run(request) {
                    if Task.isCancelled { break }
                    self.apply(event)
                }
            } catch is CancellationError {
                // The operator asked to stop, or the view went away. Either
                // way the stream ended; finishRun records the real state.
            } catch {
                if !Task.isCancelled {
                    self.run = .unavailable(Self.reason(for: error))
                }
            }
            self.finishRun()
        }
    }

    private func apply(_ event: ChatRunEvent) {
        switch event {
        case .messageStarted(let id):
            if !messages.contains(where: { $0.id == id }) {
                messages.append(ChatMessage(id: id, role: .assistant, text: "", state: .streaming, toolCall: nil))
            }
        case .messageDelta(let id, let text):
            if let index = messages.firstIndex(where: { $0.id == id }) {
                messages[index].text += text
            } else {
                messages.append(ChatMessage(id: id, role: .assistant, text: text, state: .streaming, toolCall: nil))
            }
        case .messageCompleted(let id, let finalText):
            if let index = messages.firstIndex(where: { $0.id == id }) {
                // The completed message is authoritative. It replaces the
                // streamed fragments rather than appending to them.
                if let finalText { messages[index].text = finalText }
                messages[index].state = .complete
            } else if let finalText {
                messages.append(ChatMessage(id: id, role: .assistant, text: finalText, state: .complete, toolCall: nil))
            }
        case .toolUpserted(let call):
            // Tool cards merge by call id, so a reconnect that repeats a call
            // updates one card instead of stacking duplicates.
            if let index = messages.firstIndex(where: { $0.toolCall?.id == call.id }) {
                messages[index].toolCall = call
            } else {
                messages.append(ChatMessage(id: "tool-\(call.id)", role: .tool, text: "", state: .complete, toolCall: call))
            }
            if expandedToolCallID == call.id, call.state.isTerminal {
                expandedToolCallID = nil
            }
        case .finished:
            break
        }
        revision += 1
    }

    private func finishRun() {
        let pendingToolWork = messages.contains { $0.toolCall?.state == .running }
        for index in messages.indices where messages[index].state == .streaming {
            messages[index].state = stopRequested ? .stopped : .complete
        }
        run = stopRequested ? .stopped(pendingToolWork: pendingToolWork) : .idle
        stopRequested = false
        runTask = nil
        revision += 1
    }

    static func reason(for error: any Error) -> ChatBlockReason {
        if let transportError = error as? ChatTransportError, case .blocked(let reason) = transportError {
            return reason
        }
        return .readOnlyBuild
    }
}

// MARK: - Transport selection

enum ChatTransportFactory {
    /// The shipping transport is always the offline one. The sample transport
    /// exists only in debug builds and only when a UI test asks for it by
    /// launch argument, so a release build cannot show a transcript that did
    /// not come from an executor.
    static func make() -> any ChatTransport {
        #if DEBUG
        switch UserDefaults.standard.string(forKey: "NOMO_CHAT_FIXTURE") {
        case "sample": return SampleChatTransport(mode: .history)
        case "empty": return SampleChatTransport(mode: .empty)
        case "streaming": return SampleChatTransport(mode: .streaming)
        default: break
        }
        #endif
        return OfflineChatTransport()
    }
}
