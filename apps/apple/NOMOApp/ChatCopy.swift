import Foundation

/// Localised copy for the conversation surface.
///
/// Kept out of `AppCopy` on purpose: the entry screen and the activity list own
/// the connection and pairing vocabulary, and this surface must not become a
/// second place that wording is decided. Where a sentence already exists for
/// the operator, the chat view uses that one instead of writing a variant.
struct ChatCopy {
    let language: String

    private var isCzech: Bool { language == "cs" }

    var conversationTitle: String { isCzech ? "Konverzace" : "Conversation" }

    // Composer

    var composerPlaceholder: String { isCzech ? "Napište zprávu…" : "Write a message…" }
    var send: String { isCzech ? "Odeslat" : "Send" }
    var stop: String { isCzech ? "Zastavit" : "Stop" }
    var stopping: String { isCzech ? "Zastavuji…" : "Stopping…" }
    var stopped: String { isCzech ? "Zastaveno" : "Stopped" }
    var streaming: String { isCzech ? "Odpověď se generuje" : "Streaming response" }

    /// What a stopped run means. The second half is only true when a tool call
    /// was already accepted, so it is not said unconditionally.
    func stoppedDetail(pendingToolWork: Bool) -> String {
        switch (isCzech, pendingToolWork) {
        case (true, true): "Text, který dorazil, zůstává. Již odeslaný požadavek na nástroj pokračuje na Macu; zastavení ho neodvolá."
        case (true, false): "Text, který dorazil, zůstal zčástný. Žádný nástroj nebyl přijat."
        case (false, true): "Text that had arrived is kept. The tool request already submitted keeps running on the Mac; stopping does not recall it."
        case (false, false): "The text that had arrived stays partial. No tool was accepted."
        }
    }

    /// Why the composer is inert. The control is disabled, so the reason has to
    /// be readable as text next to it rather than only as a button hint.
    func composerStatus(for reason: ChatBlockReason) -> String {
        switch (isCzech, reason) {
        case (true, .noExecutorSelected): "Psát nelze: není vybraný spárovaný executor."
        case (true, .executorOffline): "Psát nelze: spárovaný Mac není dostupný."
        case (true, .readOnlyBuild): "Psát ani odesílat nelze: tato verze nemá přenosovou cestu k Macu."
        case (false, .noExecutorSelected): "Composing is unavailable: no paired executor is selected."
        case (false, .executorOffline): "Composing is unavailable: the paired Mac is not reachable."
        case (false, .readOnlyBuild): "Composing and sending are unavailable: this build has no transport to the Mac."
        }
    }

    var composerIdleStatus: String {
        isCzech ? "Odeslání vyžaduje spárovaný Mac." : "Sending requires a paired Mac."
    }

    var toolDurationLabel: String { isCzech ? "Doba trvání" : "Duration" }

    // Transcript states

    var loadingTranscript: String { isCzech ? "Načítám uloženou aktivitu…" : "Loading stored activity…" }

    var emptyTitle: String { isCzech ? "Zatím žádné zprávy" : "No messages yet" }
    var emptyDetail: String {
        isCzech
            ? "Executor znal tuto konverzaci a neposlal pro ni žádné události. Není to totéž co nevidět historii."
            : "The executor knew this conversation and sent no events for it. That is not the same as being unable to see its history."
    }

    var unavailableTitle: String { isCzech ? "Přepis není k dispozici" : "No transcript available" }

    func unavailableDetail(for reason: ChatBlockReason) -> String {
        switch (isCzech, reason) {
        case (true, .noExecutorSelected): "Není vybraný žádný spárovaný executor, takže se uložená konverzace nedá načíst."
        case (true, .executorOffline): "Spárovaný Mac není dostupný. Uloženou konverzaci nelze ověřit."
        case (true, .readOnlyBuild): "Tato verze neobsahuje přenosovou cestu k Macu. Historie se načítat nemůže."
        case (false, .noExecutorSelected): "No paired executor is selected, so the stored conversation cannot be loaded."
        case (false, .executorOffline): "The paired Mac is not reachable, so the stored conversation cannot be verified."
        case (false, .readOnlyBuild): "This build ships no transport to the Mac, so there is no way to load a transcript."
        }
    }

    var partialHistoryTitle: String { isCzech ? "Neúplná historie" : "Partial history" }
    var partialHistoryBody: String {
        isCzech
            ? "Zobrazuje se jen okno událostí. Executor musí oznámit, zda je tato stránka úplná."
            : "Only an event window is shown. The executor has to report whether this page is complete."
    }

    var sampleTitle: String { isCzech ? "Ukázkový přenos" : "Sample transport" }
    var sampleBody: String {
        isCzech
            ? "Simulováno pro kontrolu rozhraní. Není připojen žádný executor a ze zařízení nic neodejde."
            : "Simulated for interface verification. No executor is connected and nothing leaves this device."
    }

    var newMessages: String { isCzech ? "Přejít na konec" : "Jump to latest" }

    // Roles

    func roleLabel(for role: ChatRole) -> String {
        switch (isCzech, role) {
        case (true, .user): "Vy"
        case (true, .assistant): "Odpověď NOMO"
        case (true, .tool): "Nástroj"
        case (false, .user): "You"
        case (false, .assistant): "NOMO reply"
        case (false, .tool): "Tool"
        }
    }

    var partialAnswer: String { isCzech ? "Částečná odpověď" : "Partial answer" }

    // Tool cards

    var toolCardLabel: String { isCzech ? "Volání nástroje" : "Tool call" }
    var toolArgumentsLabel: String { isCzech ? "Argumenty" : "Arguments" }
    var toolResultLabel: String { isCzech ? "Výsledek" : "Result" }
    var toolSourceLabel: String { isCzech ? "Zdroj" : "Source" }
    var showDetails: String { isCzech ? "Zobrazit podrobnosti" : "Show details" }
    var hideDetails: String { isCzech ? "Skrýt podrobnosti" : "Hide details" }
    var expandedDetailsTitle: String { isCzech ? "Podrobnosti nástroje" : "Tool details" }

    var needsExecutorDecision: String {
        isCzech
            ? "Rozhodnutí musí udělat důvěryhodný Mac. Tato aplikace proto nenabízí žádné tlačítko."
            : "The trusted Mac has to make this decision, so this companion offers no control for it."
    }

    var incompleteCallDetail: String {
        isCzech
            ? "Volání dorazilo neúplné a nebylo provedeno. NOMO neuhoduje chybějící části."
            : "This call arrived incomplete and was not executed. NOMO does not guess the missing part."
    }

    func toolStateLabel(_ state: ToolCall.State) -> String {
        switch (isCzech, state) {
        case (true, .queued): "Ve frontě"
        case (true, .running): "Probíhá"
        case (true, .awaitingApproval): "Čeká na schválení"
        case (true, .completed): "Dokončeno"
        case (true, .failed): "Selhalo"
        case (true, .denied): "Zamítnuto"
        case (true, .cancelled): "Zrušeno"
        case (true, .incomplete): "Neúplné volání"
        case (false, .queued): "Queued"
        case (false, .running): "Running"
        case (false, .awaitingApproval): "Awaiting approval"
        case (false, .completed): "Completed"
        case (false, .failed): "Failed"
        case (false, .denied): "Denied"
        case (false, .cancelled): "Cancelled"
        case (false, .incomplete): "Incomplete call"
        }
    }

    func toolTone(_ state: ToolCall.State) -> NomoTone {
        switch state {
        case .queued, .running: .action
        case .awaitingApproval: .warning
        case .completed: .success
        case .failed, .denied: .danger
        case .cancelled, .incomplete: .unknown
        }
    }

    /// One sentence that carries a tool card's whole state, so a screen reader
    /// user is not left to assemble it from separate fragments — and so the
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
