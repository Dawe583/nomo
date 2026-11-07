# NOMO: analyza otevrenych issues a plan provedeni

Stav: rozpracovano. Zaklad: `7a242d56b0035ff7bc5c4fefd9d89a94af052c9a`.
Autorita: aktualni GitHub issues vcetne vsech komentaru, kontextovy balik a kod.
Aktivni stav teto zakazky patri do `.nomo/work-state.json`. Hotovo znamena
prokazane splnena acceptance, nikoli pouze napsany patch nebo existujici PR.

## Rozsah a provoz

- #125 je vyslovne vynechano. Jeho patch ani verifier nemenit.
- Uzivatel povolil prevzeti #126 a #127 v oddelenem worktree a instalaci podle
  existujiciho lockfile bez zmen verzi a globalni konfigurace.
- Puvodni Windows checkout ma cizi staged i unstaged zmeny. Zachovat je.
- Upravy: worktree `nomo-issues`, vetev `fix/issue-127-baseline` od main.
  Overeni: oddelena kopie ve WSL Ubuntu s Node 24.14.1 a pnpm 10.33.0,
  frozen lockfile, zadne zmeny manifests. Linuxovy clone je pouze verifier.
- Jedno aktivni issue. Reprodukce, specifikace, minimalni oprava, cilene testy,
  sirsi testy, typecheck, review, zaznam. Dalsi implementace az po brane.
- Zadny produkcni ucet, model, MCP server, platba, zmena opravneni ani publish.
- Obsidian vault uvedeny v pravidlech je macOS cesta, zde neni dostupny.
  Zaznam proto zustava v tomto planu a lokalnim execution state.

## Handoff a vetve

Fetch potvrdil shodny lokalni main a origin/main na vyse uvedenem zakladu.
PR #119 je slouceno merge commitem
`09e9d3c0df58a61d58551ca1be0189daf6f0968b`.

`feat/nomo-agent-policy-proxy-wiring` ma tri nesloucene commity `c6a78ce`,
`3b608f5`, `211081a`. Head-to-head diff vedle agent gate zahrnuje odstraneni
soucasneho pending-call limitu, starsi chybove zpravy a dalsi namespace/test
zmeny. Neslucovat celou vetev. Samostatny integration balik musi zachovat
backpressure a evidence path a prokazat grant/scope/revocation, neznameho
agenta, kombinaci agent a class policy a zadny dispatch pred approval.
Neni to automaticky kterekoli otevrene issue; musi navazat na produktovy graf.

Sedm zminovanych Harness commitu na `claude/fleet-main` neni predkem main,
ale main uz obsahuje integrovane Harness zmeny v `27a67f4` a dalsich commitech.
Cela vetev ma i starsi identity, policy, transport a TUI. Posuzovat chybejici
chovani, ne ancestry: provenance, digest approval, settled review, supersession,
secret rejection, bounded verified retrieval a restart. Prenest pouze mezeru
prokazanou failing testem, nikoli celou historickou vetev.

## Vsech 12 otevrenych issues mimo #125

| Issue | Aktualni zaver                                                                                                           | Postup a dukaz dokonceni                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #127  | Prvni aktivni oprava. Novy Linuxovy `pnpm run test:tui` na presnem main selhal v Node testech.                           | Rozdelit fixture schema a Git-root setup, kaskady failed sessions a skutecne renderer/navigation chyby. Pouzit pouze relevantni opravy PR #128, ne jeho features ani verifier. Serialni workspace tests, workspace typecheck, test:tui a samostatny POSIX PTY.                                                                                                                                                                                        |
| #126  | Na main neni PNG ani Kitty kod popsany v issue. PR #129 uz ma copy a pack testy.                                         | Neduplikovat main-only opravu. Na presnem TUI kandidatu proverit bundle do temp output, pack a spusteni mimo checkout. Prokazat puvod/licenci konkretniho PNG; blob/commit nestaci. Bez dolozeni pouzit schvaleny fallback nebo zadat souhlas vlastnika. Overit Kitty framing, fallback, signal cleanup, terminal-injection ochranu, typecheck a TUI.                                                                                                 |
| #55   | Castecne historicke. Cloud uz ma licenci a entitlement testy. PR #140 opravuje README a komentar.                        | Review existujiciho diffu, licence-line, capability-gate, doc-truth a typecheck. Nemenit licenci ani dodatecne neplatit za open retention, local approvals, budget a taint builder. Raw signed export neni compliance mapping. Nesoulad uzavrene licence vyzaduje vlastnika.                                                                                                                                                                          |
| #131  | Sedm apiTransport radku, dalsi ctyri provider/model kombinace a Prime serving metadata maji ruzne kontraktove blokatory. | Pro kazdy radek pinned upstream, primarni protocol/auth, refresh/revocation, streaming/tool/usage/error/cancel contract. Vertex Anthropic verejne podklady nejsou hotovy ADC/project/location/model contract. Az pote offline fixtures a adapter. Bez autoritativniho zdroje zustat blocked. Zadne CLI credentials, private endpoints ani heuristicky serving kind. Brana: generator, manifest parity, catalog/factory/adapter, redaction, typecheck. |
| #110  | Aktualni account blocker.                                                                                                | Cerstvy run `42315997569` ma vsechny jobs s runner_id 0 a 0 steps. Check-run `128228619429` stale uvadi billing/spending limit. Spravce uctu musi odstranit blokaci. Nekupovat tarif ani nemenit limity automaticky.                                                                                                                                                                                                                                  |
| #98   | Aktualni startup blok neni dukaz vadne workflow YAML.                                                                    | Oddelit account blokaci od source failures. Starsi PR maji skutecne dokoncene jobs, netvrdit, ze nikdy runner nebezel. PR #138 uz sdruzuje konkretni CI fixture opravy; cist diff a logs pred novou implementaci. Acceptance az po aktualnim remote gate.                                                                                                                                                                                             |
| #34   | Samostatnost workflow a cloud integrace.                                                                                 | Nezavadet produkcni secrets. Overit aktualni manifest matrix a isolated Postgres s pinned wsproxy. #138 uz opravuje managed-cloud finish_reason a predani disposable DB hesla. Po odblokovani potvrdit realny run a absenci nove zavedeneho secretu.                                                                                                                                                                                                  |
| #13   | Windows runtime/ACL a backup/restore matrix neni cela overena.                                                           | PR #135 izoluje Windows API fixtures, je zahrnuto v #138. Rozlisit parent ACL, casovy limit a unikly worker/SQLite handle. Opravit root cause bez oslabeni kontrol. Acceptance: aktualni Node 24/26 Linux+Windows runtime/ledger/proxy i backup/restore.                                                                                                                                                                                              |
| #10   | Owner-only implementace je na main; focused Windows evidence nenahrazuje matrix.                                         | Stejna platform brana jako #13, vcetne realneho refusal broad paths a recovery. Bez cele matrix ponechat otevrene.                                                                                                                                                                                                                                                                                                                                    |
| #4    | PR #140 ma rozpoznaneho autora LiveFuller, Vercel odmita clenstvi v tymu. Jine PR preview prosly.                        | Spravce pripoji opravneny GitHub ucet nebo udeli pristup. Nefalsovat autora, nemenit tarif ani viditelnost repa. Acceptance: novy uspesny preview pro opravneny ucet.                                                                                                                                                                                                                                                                                 |
| #32   | CLI publikace je vedome zablokovana lidskym release rozhodnutim.                                                         | Vlastnik potvrdi package identity/vlastnictvi, private/public distribuci a publishing/provenance cestu. Pote allowlist a installed-bin gate. Prokazat clean consumer help/version a packed-file audit. Nepublikovat ani nezverejnovat repo. #126 je zavislost.                                                                                                                                                                                        |
| #1    | Program prijmu, ne automaticky uzavritelny coding ticket.                                                                | Pouzit aktualni direction a realne release evidence, ne obnovit zamerne vyrazene marketingove plany jako autoritu. Chybi lidske DRI, rozhovory, placeni partneri a skutecne MRR. Neoslovovat firmy ani netvrdit prijem bez dokladu.                                                                                                                                                                                                                   |

## Detail prvniho baliku #127

### Potvrzovane priciny

1. OpenAI fixtures bez `finish_reason` jsou spravne odmitnute produkcnim
   adapterem. Opravit fixture, ne provider validaci. Approval, subagent, review,
   sessions, lifecycle, search a rewind mohou byt kaskadou tehoz failed run.
2. Project fixture musi mit vlastni Git root, ne obchazet root validaci.
3. Stare frame tests vyzaduji ramecek, aktualni composer je borderless.
   Overit editor, rozmery, controls a rezervaci prostoru, ne vratit stary design.
4. Barvy overovat podle theme tokenu, ne pevnym SGR 203.
5. Prompt jump ma identifikovat prompt, ne incidentalni pocet radku role/body.
6. TODO musi vychazet ze skutecneho zdroje dat. Pokud schvaleny kontrakt vyzaduje
   strukturovany tool a producent chybi, nevyrabet falesne polozky v rendereru.

### Nemenne garance

Zadny dispatch pred approval, zadne zmekceni Undo/drift, signed export,
lifecycle a restart assertions. Reprodukce pred opravou, kazdy slice zvlast,
pote serialni sirsi overeni. Testy musi mit dukaz, ze se starou chybou padaji.

### Brana a vazba na #125

Spustit Node workspace tests, workspace typecheck, `pnpm run test:tui` a
samostatny `python3 scripts/src/verify-tui-terminal.py` na stejnem candidate.
Jestli po oprave Node testu zbyde pouze vyloucene #125, oznacit #127 za castecne
opraveno, nikoli hotovo. Issue nezavirat a dalsi implementaci nezacinat bez
vyjasneni teto zavislosti. Vylouceni #125 neni souhlas tvrdit PTY zelene.

## Poradi po prvnim baliku

1. #127 baseline a brana.
2. #126 na presnem TUI kandidatu po dolozeni assetu.
3. #55 review existujiciho PR a konkretni chybejici regrese.
4. #131 kontrakty po jednom transportu; nedolozene radky explicitne blocked.
5. #98/#34/#13/#10 overeni #138 a platform matrix po skutecnem spusteni runneru.
   #110 a #4 jsou soubezne read-only diagnostikovatelne account blockers.
6. #32 az po release rozhodnuti; #1 spotrebovava pouze skutecne evidence.

Nezavirat issues automaticky, neslucovat historicke vetve naslepo. Blokovane
issue musi mit duvod, vlastnika a konkretni verifier pro odblokovani.
