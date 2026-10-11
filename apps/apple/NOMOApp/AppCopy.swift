import Foundation

/// User-facing copy for the local companion. The picker stores a language key;
/// keeping the copy in one value prevents the entry screen and the activity
/// surfaces from drifting into different partial localizations.
struct AppCopy {
    let language: String

    private var isCzech: Bool { language == "cs" }
    var accessReadOnly: String { readOnly }

    let title: String
    let accountTitle: String
    let accountDetail: String
    let languageLabel: String
    let englishName: String
    let themeLabel: String
    let themeSystemName: String
    let themeLightName: String
    let themeDarkName: String
    let czechName: String
    let pairingState: String
    let pairingDetail: String
    let pairingSteps: String
    let connectMac: String
    let pairingUnavailable: String
    let privacyTitle: String
    let privacyDetail: String
    let offlineState: String
    let offlineDetail: String
    let continueOffline: String

    let workspaceTitle: String
    let activityTitle: String
    let durableActivityTitle: String
    let activityStateNote: String
    let connectionTitle: String
    let stateTitle: String
    let accessTitle: String
    let readOnly: String
    let executorTitle: String
    let noExecutor: String
    let pairedExecutorDetail: String
    let disconnectedDetail: String
    let noWriteAuthority: String

    let settingsPrivacyTitle: String
    let settingsTitle: String
    let settingsPrivacyDetail: String
    let pairingPolicyDetail: String
    let revokeDevice: String
    let revokeTitle: String
    let cachePolicyTitle: String
    let cachePolicyDetail: String
    let removeDevice: String
    let removeDeviceTitle: String
    let removeDeviceMessage: String
    let removeDeviceDone: String
    let removeDeviceUnconfirmed: String
    let noCachedSessionsTitle: String
    let noCachedSessionsDetail: String
    let offlineModeTitle: String
    let revokeMessage: String
    let revoke: String
    let cancel: String
    let statusTitle: String
    let outcomeLabel: String
    let detailsTitle: String
    let noActionOffline: String
    let noActionReadOnly: String

    init(language: String) {
        self.language = language

        if language == "cs" {
            title = "Připojit k Macu"
            accountTitle = "NOMO nemá účet"
            accountDetail = "Připojíte se k vlastnímu Macu, ne k účtu NOMO."
            languageLabel = "Jazyk"
            themeLabel = "Vzhled"
            themeSystemName = "Systém"
            themeLightName = "Světlý"
            themeDarkName = "Tmavý"
            englishName = "English"
            czechName = "Čeština"
            pairingState = "Mac není spárován"
            pairingDetail = "Spárujte jeden vlastní Mac přes důvěryhodné místní připojení. Párování nevytváří účet NOMO."
            pairingSteps = "Mac ponechte odemčený a potvrďte na Macu toto zařízení a pracovní prostor."
            connectMac = "Připojit Mac"
            pairingUnavailable = "Zabezpečené párování Macu v této verzi není dostupné."
            privacyTitle = "Žádné uživatelské jméno ani heslo"
            privacyDetail = "Tato úvodní obrazovka ne sbírá přihlašovací údaje. Klíče poskytovatele zůstávají na vybraném Macu a nejsou zde zadávány."
            offlineState = "Offline jen pro čtení"
            offlineDetail = "Prohlížet můžete pouze uloženou aktivitu. Bez spárovaného Macu nelze spustit žádnou akci."
            continueOffline = "Pokračovat offline"
            workspaceTitle = "Pracovní prostor"
            activityTitle = "Aktivita"
            durableActivityTitle = "Uložená aktivita"
            activityStateNote = "Schválení, Zpět, konflikty, neznámé výsledky a pozastavené běhy se řeší na Macu. Tato aplikace zůstává jen pro čtení."
            connectionTitle = "Připojení"
            stateTitle = "Stav"
            accessTitle = "Přístup"
            readOnly = "Jen pro čtení"
            executorTitle = "Executor"
            noExecutor = "Není vybraný executor"
            pairedExecutorDetail = "Mac je spárován, ale tato verze zůstává jen pro čtení."
            disconnectedDetail = "Spárovaný Mac není dostupný; žádná akce není možná."
            noWriteAuthority = "Tato verze doprovodné aplikace nemá oprávnění zapisovat."
            statusTitle = "Stav"
            outcomeLabel = "Výsledek"
            detailsTitle = "Podrobnosti"
            noActionOffline = "Offline není dostupná žádná akce"
            settingsPrivacyTitle = "Soukromí"
            noActionReadOnly = "Tato verze je jen pro čtení"
            settingsTitle = "Nastavení"
            settingsPrivacyDetail = "Do protokolů ani UserDefaults se nezapisují přihlašovací údaje, výzvy, obsah dokumentů ani tajné údaje párování."
            pairingPolicyDetail = "Párování vyžaduje výslovně vybraný vlastní Mac. NOMO nevyhledává ani nedůvěřuje libovolným serverům."
            revokeDevice = "Odpojit spárované zařízení"
            revokeTitle = "Odpojit párování tohoto zařízení?"
            cachePolicyTitle = "Mezipaměť"
            cachePolicyDetail = "Nic, co spárovaný executor odpoví, se na tomto zařízení neukládá trvale. Historie konverzace zůstává jen v paměti, je označena jako minulá aktivita a nikdy se nepoužije k rozhodnutí o dalším kroku."
            removeDevice = "Odebrat toto zařízení"
            removeDeviceTitle = "Odebrat párování tohoto zařízení?"
            removeDeviceMessage = "Přihlašovací údaje zařízení se smažou z klíčenky a všechno, co tato aplikace uložila, se vyprázdní. Executor musí zařízení znovu spárovat, než bude možné pokračovat."
            removeDeviceDone = "Toto zařízení bylo odebráno a jeho přihlašovací údaje smazány."
            removeDeviceUnconfirmed = "Toto zařízení bylo odebráno lokálně. Executor nebyl dosažen, takže párování zrušte na Macu."
            noCachedSessionsTitle = "Žádné uložené relace"
            noCachedSessionsDetail = "Pro zobrazení trvalé aktivity připojte výslovně spárovaný executor."
            offlineModeTitle = "Režim offline"
            revokeMessage = "Další požadavky budou odepřeny, dokud zařízení znovu nespárujete."
            revoke = "Odpojit"
            cancel = "Zrušit"
        } else {
            title = "Connect to your Mac"
            accountTitle = "NOMO has no account"
            accountDetail = "You connect to a Mac you own, not to a NOMO account."
            languageLabel = "Language"
            themeLabel = "Appearance"
            themeSystemName = "System"
            themeLightName = "Light"
            themeDarkName = "Dark"
            englishName = "English"
            czechName = "Čeština"
            pairingState = "Mac not paired"
            pairingDetail = "Pair one user-owned Mac over a trusted local connection. Pairing never grants a NOMO account."
            pairingSteps = "Keep the Mac unlocked and confirm this device and the workspace on the Mac."
            connectMac = "Connect a Mac"
            pairingUnavailable = "Secure Mac pairing is not available in this build."
            privacyTitle = "No username or password"
            privacyDetail = "This entry screen collects no credentials. Provider keys stay on the selected Mac and are not entered here."
            offlineState = "Read-only offline"
            offlineDetail = "You can inspect cached activity only. No action can run without a paired Mac."
            continueOffline = "Continue offline"
            workspaceTitle = "Workspace"
            activityTitle = "Activity"
            durableActivityTitle = "Durable activity"
            activityStateNote = "Approval, Undo, conflicts, unknown outcomes, and paused runs are resolved on the Mac. This companion stays read-only."
            connectionTitle = "Connection"
            stateTitle = "State"
            accessTitle = "Access"
            readOnly = "Read-only"
            executorTitle = "Executor"
            noExecutor = "No executor selected"
            pairedExecutorDetail = "Paired Mac detected; this build remains read-only."
            disconnectedDetail = "The paired Mac is not reachable; no action is available."
            noWriteAuthority = "This companion build has no write authority."
            statusTitle = "Status"
            outcomeLabel = "Outcome"
            detailsTitle = "Details"
            noActionOffline = "No action is available while offline"
            settingsPrivacyTitle = "Privacy"
            noActionReadOnly = "No action is available in this read-only build"
            settingsTitle = "Settings"
            settingsPrivacyDetail = "No credentials, prompts, document contents, or pairing secrets are written to logs or UserDefaults."
            pairingPolicyDetail = "Pairing requires an explicitly selected, user-owned executor. NOMO does not discover or trust arbitrary servers."
            revokeDevice = "Revoke paired device"
            revokeTitle = "Revoke this device pairing?"
            cachePolicyTitle = "Cache"
            cachePolicyDetail = "Nothing a paired executor answers is kept on this device. Conversation history stays in memory, is labelled as past activity, and is never used to decide what happens next."
            removeDevice = "Remove this device"
            removeDeviceTitle = "Remove this device pairing?"
            removeDeviceMessage = "This device's credential is deleted from the Keychain and everything this app cached is cleared. The executor must pair the device again before anything else works."
            removeDeviceDone = "This device was removed and its credential deleted."
            removeDeviceUnconfirmed = "This device was removed on this side. The executor was not reachable, so revoke the pairing on the Mac too."
            revokeMessage = "Future requests will be denied until the device is paired again."
            noCachedSessionsTitle = "No cached sessions"
            noCachedSessionsDetail = "Connect an explicitly paired executor to view durable activity."
            offlineModeTitle = "Offline mode"
            revoke = "Revoke"
            cancel = "Cancel"
        }
    }

    func outcomeTitle(for outcome: Session.Outcome) -> String {
        switch (isCzech, outcome) {
        case (true, .awaitingApproval): "Čeká na schválení"
        case (true, .undoAvailable): "K dispozici je Zpět"
        case (true, .conflict): "Konflikt"
        case (true, .unknown): "Neznámé"
        case (true, .paused): "Pozastaveno"
        case (true, .partial): "Částečné"
        case (true, .succeeded): "Hotovo"
        case (true, .offline): "Offline"
        case (true, .unavailable): "Nedostupné"
        case (false, .awaitingApproval): "Awaiting approval"
        case (false, .undoAvailable): "Undo available"
        case (false, .conflict): "Conflict"
        case (false, .unknown): "Unknown"
        case (false, .paused): "Paused"
        case (false, .partial): "Partial"
        case (false, .succeeded): "Succeeded"
        case (false, .offline): "Offline"
        case (false, .unavailable): "Unavailable"
        }
    }

    func outcomeExplanation(for outcome: Session.Outcome) -> String {
        switch (isCzech, outcome) {
        case (true, .awaitingApproval): "Schválení musí být provedeno na důvěryhodném Macu; tato aplikace nemá oprávnění schvalovat."
        case (true, .undoAvailable): "Zpět lze použít na důvěryhodném Macu; tato aplikace zůstává jen pro čtení."
        case (true, .conflict): "Na Macu je novější změna. Tato aplikace konflikt nevyřeší."
        case (true, .unknown): "Výsledek nelze z uložené aktivity bezpečně určit; ověřte jej na Macu."
        case (true, .paused): "Běh je pozastavený na Macu. Tato aplikace jej nemůže obnovit."
        case (true, .partial): "Aktivita obsahuje jen část výsledku. Podrobnosti zůstávají na Macu."
        case (true, .succeeded): "Mac potvrdil dokončení. Tato aplikace pouze zobrazuje uloženou aktivitu."
        case (true, .offline): "Bez spárovaného Macu není dostupná žádná akce."
        case (true, .unavailable): "Bez spárovaného executoru není uložená aktivita k dispozici."
        case (false, .awaitingApproval): "Approval must happen on the trusted Mac; this companion cannot approve actions."
        case (false, .undoAvailable): "Undo is available on the trusted Mac; this companion remains read-only."
        case (false, .conflict): "A newer change exists on the Mac. This companion will not resolve the conflict."
        case (false, .unknown): "The outcome cannot be determined safely from cached activity; verify it on the Mac."
        case (false, .paused): "The run is paused on the Mac. This companion cannot resume it."
        case (false, .partial): "Only part of the outcome is cached. Details remain on the Mac."
        case (false, .succeeded): "The Mac confirmed completion. This companion only displays cached activity."
        case (false, .offline): "No action is available without a paired Mac."
        case (false, .unavailable): "No durable activity is available without a paired executor."
        }
    }

    /// What the app says after a removal. The three outcomes are three
    /// different claims, and saying "done" for a local-only removal would
    /// leave the operator believing the executor had stopped honouring the
    /// device when it had not.
    func removalNotice(for outcome: AppModel.RemovalOutcome) -> String {
        switch (isCzech, outcome) {
        case (true, .removed): removeDeviceDone
        case (true, .removedLocallyOnly), (true, .failed): removeDeviceUnconfirmed
        case (false, .removed): removeDeviceDone
        case (false, .removedLocallyOnly), (false, .failed): removeDeviceUnconfirmed
        }
    }

    func connectionTitle(for state: AppModel.ConnectionState) -> String {
        switch (isCzech, state) {
        case (true, .offline): "Offline"
        case (true, .paired): "Spárováno"
        case (true, .disconnected): "Odpojeno"
        case (false, .offline): "Offline"
        case (false, .paired): "Paired"
        case (false, .disconnected): "Disconnected"
        }
    }

    func sessionTitle(for session: Session) -> String {
        if session.id == "local-1" { return noCachedSessionsTitle }
        if session.id == "local-2" { return offlineModeTitle }
        return session.title
    }

    func sessionDetail(for session: Session) -> String {
        if session.id == "local-1" { return noCachedSessionsDetail }
        if session.id == "local-2" { return offlineDetail }
        return session.detail
    }

    func connectionDetail(for state: AppModel.ConnectionState) -> String {
        switch (isCzech, state) {
        case (true, .offline): "Jen pro čtení, dokud není spárován důvěryhodný Mac."
        case (true, .paired): pairedExecutorDetail
        case (true, .disconnected): disconnectedDetail
        case (false, .offline): "Read-only until a trusted Mac is paired."
        case (false, .paired): pairedExecutorDetail
        case (false, .disconnected): disconnectedDetail
        }
    }
}
