# GUI upgrade — předání 2026-09-11

Produkce: https://void-tui.vercel.app. Implementace na větvi `codex/gui-upgrade`.
Plán: [GUI-UPGRADE-PLAN.md](GUI-UPGRADE-PLAN.md), původní audit: [GUI-UPGRADE-AUDIT.md](GUI-UPGRADE-AUDIT.md).

## Dodané chování

- Společná React aplikace pro Vercel, lokální server a desktop. Vlastní paper-terminal styl, světlý/tmavý/systémový vzhled, čeština/angličtina, adresovatelné stránky a konverzace.
- Desktopová navigace a kontext s nastavením šířky; mobilní navigace, drawer, modal kontext, safe area a composer v ohraničeném viewportu.
- Chat: Markdown, tabulky, kód s kopírováním a stažením, streaming, skutečné stavy nástrojů, drafty, textové přílohy, výběr modelu a oblíbené modely. Větvení a retry vytváří bezpečnou větev bez přehrání historických nástrojů.
- Přehled, konverzace, běhy, dokumenty, schvalování, ledger, konektory, modely/spotřeba a nastavení. Sdílená tabulka poskytuje serverové hledání, řazení, stránkování, sloupce, uložené pohledy a export stránky. Ledger má scope, filtry, podpisy a detail návazností.
- Dokumenty: editace s očekávanou revizí, konflikt 409, historie a diff; Undo používá aktuální preview a kontrolu digestu. Editor po Undo načte skutečnou novou revizi.
- Konektory: přidání, editace, test připojení a skutečný katalog nástrojů se schématy. Prázdný token při editaci zachová existující tajemství.
- Cloud uchovává append-only events samostatně; metadata polling nepřenáší celý transcript. Delta stránky a klientské sloučení zabraňují duplicitám. Starší zachovaná historie je dostupná přes serverové dotazy.
- Výchozí nové konverzace: **NVIDIA NIM / GLM 5.3 Flash**, ID `z-ai/glm-5.3-flash`, endpoint `https://integrate.api.nvidia.com/v1`. NVIDIA hosted trial/free quota je účetní a není garancí neomezeného bezplatného provozu. Klíč je serverový; nepřechází do klientského buildu. Existující sessions zachovávají původní provider/model. Bez klíče se zobrazí setup state, ne tichý placený fallback.
- OpenAI-compatible stream parser zvládá rozdělené UTF-8/CRLF, tool fragments, redakci klíče a neúplný stream. Chyby providera včetně 429 mají konkrétní stav; generace se automaticky neopakuje.

## Current management parity increment

- Chat now shows the latest real provider token report beside the provider.
  Missing token or cost data stays explicitly unknown.
- Arrow Up on an empty composer opens the reviewed branch editor for the last
  user message. It never rewrites history or replays earlier tools.
- Nová konverzace může nést projektový workspace; Sessions zobrazují projekt a nový agent katalog nabízí `default`, `planner`, `reviewer` a `implementer`. Agent preset mění pouze systémovou instrukci; nástroje a oprávnění zůstávají pod VOID policy.
- Chat má skutečnou akci Compact context. Server zachová systémové instrukce a poslední zprávy, vloží redigovatelný historický souhrn a zapíše `context.compacted` event.
- Background start now creates a durable session immediately; when the single
  active-run safety capacity is occupied, the session is visibly `queued` and
  drains after the active provider settles. Shutdown cancels queued work rather
  than pretending it completed.
- Approval review exposes class, workspace, blast radius and precision when the
  server provides them, plus the server policy rationale.
- Existing message actions, command palette, export, model picker, attachments,
  session rename, pin, archive, search, retry and safe branch controls remain
  the shared management surface.
- Disposable browser QA completed a real managed document tool run. Copy,
  branch, retry, Arrow Up branch review and the token status were reachable.
  At 390 by 844 pixels the document width stayed 390 pixels and the composer
  bottom stayed at 844 pixels. The browser console had no errors or warnings.
- `pnpm run build` passes on the release tree: Vite web build, Nitro server,
  Vercel artifact with 4 frontend assets, Node API and streaming route.

This increment does not claim full Claude Code parity. Structured permission
modes, background tasks, custom agents, hooks, durable context compaction and
dependency-aware multi-operation rewind remain in `PLAN-GAPS.md`.

## Ověření

| Důkaz | Výsledek |
|---|---|
| `pnpm run typecheck` | Prošlo včetně nového UI |
| `pnpm test` | 514 testů, 10 sad, bez chyby |
| Lokální a zabalený desktop runtime | Obě varianty prošly; zabalená varianta používá sdílený hashovaný web build |
| Build Vite, Nitro a Vercel | Prošly, produkční deployment READY |
| Izolovaný cloud dataset | 151 sessions, přes 1000 events, 10 000 podepsaných ledger records; staré záznamy a další stránky dohledány |
| Preview skutečný TokenRouter | Generace, tool write, idempotence, editace, konflikt, Undo a ověřený ledger prošly |
| Produkční skutečný TokenRouter | Prošlo: default, živá generace, tool write, idempotence, revision conflict, Undo, 4 ověřené signed records a events; session `b12bdd00-4a11-4441-acc3-95947bf65916` |
| Rozměry shellu | 320×568, 390×844, 430×932, 768×1024, 1024×768, 1280×720, 1440×900, 1920×1080; bez overflow dokumentu, composer uvnitř viewportu |
| Mobilní overlay | Background inert, focus uvnitř a návrat focusu; zkontrolováno v browseru |
| Kontrast základních tokenů | Text/muted/action v obou tématech minimálně 4,87:1; nejde o kompletní WCAG audit |
| JS rozpočet | Hlavní bundle přibližně 138 KB gzip, oddělený lazy highlighter přibližně 55 KB gzip |

Reprodukce cloudového smoke: `node scripts/src/verify-gui-deployment.mjs <VOID-deployment-url> <ignored-secret-json> run`. Vyžaduje autorizované Vercel CLI a JSON s `VOID_CONTROL_TOKEN`. Vytvoří jednu testovací session a dokument, upraví jej a vrátí změnu. `resume` pokračuje v již založeném smoke bez opakované generace. Přístupové údaje a výsledný session locator jsou ignorované soubory, ne součást repozitáře.

## Release a návrat

Produkční deployment: `dpl_CpxkQUbXepCDeRyhYtvfLkxuU4kc`, https://void-dj19pj0rs-sitespot.vercel.app.
Samostatný produkční build používá produkční prostředí. Izolovaný preview nebyl promován do produkce: měl vlastní databázi a tajemství.

Migrace je aditivní; produkce měla před změnou 11 sessions a žádný aktivní běh. Backfill zachoval 25 existujících events. Nastavení před migrací bylo lokálně zálohováno do ignorovaného souboru s právy 0600. Nová preview databáze je oddělená databáze na existujícím Neon endpointu, nikoli samostatná Neon branch.

Předchozí produkční deployment pro návrat: `dpl_BBh53V4VMvZvMKAJbz7BCxkScseV`. Při regresi vrátit tento deployment přes Vercel rollback po kontrole aktivních Workflow; nesmazat nové tabulky ani ledger. Samotný rollback nebyl proveden, aby se nepřerušovala funkční produkce.

## Přesné limity a otevřené ověření

- Textové přílohy mají společný limit 24 KB. Binární soubory, multimodální inference a privátní objektové úložiště nejsou součástí tohoto releasu.
- Zůstává jeden aktivní cloudový běh. Nejde o novou trvalou frontu ani souběžné agenty.
- Lokální úložiště dál zapisuje šifrovaný snapshot; běhy a usage jsou projekce zachovaných dat, nikoli nové inkrementální analytické tabulky. Historicky již ořezaná data nelze obnovit.
- Ceny a kapacity, které provider nevrací, UI označuje jako neznámé. Označení Free pochází z modelového katalogu, není vlastní garance trvalé ceny.
- Návrh je inspirován pracovními postupy Claude/OpenCode; nejde o tvrzení úplné funkční parity. Metadata projektů/tagů nejsou kompletní projektový management.
- Rozměry byly ověřeny v dostupném browseru. Fyzický iOS/Android, jejich softwarová klávesnice, všechny browser enginy, screen reader a kompletní 200% zoom audit zůstávají k ověření. LCP/INP/CLS z plánu jsou cíle, ne naměřený produkční výsledek.
- Preview narazilo na throttling Vercel Workflow event API s Retry-After 120 s. Durable běh po několika minutách sám pokračoval, nástroj se neopakoval a následný smoke prošel. Platforma může prodloužit čekání i při funkčním provideru.

Skilly caveman a ponytail byly již instalované a použité: stručná komunikace a opětovné využití stávajícího runtime, komponent a nativních dialogů. Instalace duplicit nebyla potřebná.

## Obrazové důkazy

Aktuální produkční konverzace po skutečné generaci, editaci a Undo:

![Desktop 1440×900](gui-upgrade/desktop.png)

![Mobil 390×844](gui-upgrade/mobile.png)

## GUI parity increment 2026-09-16 (claude.ai controls)

Scope: `apps/control-plane/ui/src/{main,chat,pages,commands}.tsx|ts` plus a
new `commands.test.ts`. No server, policy or connector change. No new
dependency. No em or en dash in the new text.

- Cmd+K is now a real command palette, not only conversation search. It lists
  app actions (new conversation plus every page route) above the
  server-searched conversation hits. Actions and hits are plain buttons, so
  all of them stay keyboard reachable with visible focus.
- New shortcuts: Cmd+Shift+O opens a new chat from anywhere. Esc inside the
  composer requests a real run cancellation on the server while a run is
  active; an open slash menu or dialog still consumes Esc first. Arrow Up on
  an empty composer keeps opening the branch editor for the last user
  message, without rewriting history or replaying tools.
- Archive and restore on the Conversations page now ask for confirmation.
  The dialog states that archiving only hides the conversation: it never
  stops running work and never deletes the signed ledger. Hard delete stays
  unavailable because the server exposes no session delete endpoint
  (DELETE on a session cancels its run).
- The Runs page shows a live capacity banner from `/api/overview`: the real
  active run count, or an explicit unknown label when the count is missing.
  The banner also states the waiting rule the composer already enforces:
  a new message waits while its conversation runs, and Stop ends the run.
- Sign-in gating (A18 follow-up): the provider probe doubles as the login
  check, and sessions, approvals, conversation search, preferences and the
  current conversation detail now stay disabled until that probe succeeds.
  The dedicated token gate surface itself is unchanged.
- New tests: `commands.test.ts` covers the palette filter (empty query
  lists everything, bilingual case-insensitive match, no hit returns empty).

Verification on this tree (2026-09-16):

| Check | Result |
|---|---|
| `pnpm --filter @void/control-plane-ui typecheck` | pass, exit 0 |
| `pnpm exec tsc -p apps/control-plane/tsconfig.json` | pass, exit 0 |
| `node --test --test-reporter=tap src/*.test.ts` (control-plane UI) | 11 tests, 11 pass |
| `pnpm run build:web` | pass, Vite build ready in `dist/web` |
| `pnpm run typecheck` (repo root) | fails only in `packages/cli/src/tui/workspace.ts`, which is sibling `tui-parity` working-tree code outside this package scope |
| Headless Chrome QA on the local server at 320, 390, 430, 768, 1280 and 1440 px | zero horizontal overflow everywhere, composer inside the viewport, welcome state shown, Cmd+K palette opens with actions and hits, no console errors |

Audit IDs touched by this increment: A18 closed (gate plus no protected
fetches before login), A07 visibly closed on the Runs page with live
numbers (a cloud single-run limit claim is still not stated because the
local contract does not expose it), A15 re-verified (stable `/chat/:id`
URLs, per-conversation drafts, explicit welcome state) with the palette
added on top, A11/A16/A05/A06/A09 re-verified unchanged (structured
approval rationale with explicit unknowns, provider usage reports with
cost unknown, server-side search and cursor pagination in every table).
Still open: hard conversation delete (no server endpoint) and a thinking
toggle (no server contract for extended thinking; nothing was invented).
