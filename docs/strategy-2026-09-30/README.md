# VOID: plán dalšího vývoje

Auditní baseline: GitHub `main` commit `4c560dd98668da06e24b2189e854203fdcaa80a2`, načtený 30. září 2026. Plán vzniká na větvi `codex/void-strategy-2026-09-30`. Je to návrh k diskusi; jednotlivé nově navržené vlastnosti nejsou automaticky schválené k implementaci.

## Rozhodnutí, která už zazněla

- Produkt porovnáváme podle zákaznické hodnoty, opakovaného používání a nákladů. Uživatel chce nejdřív vidět směry a o návrzích rozhodovat průběžně.
- Zvolený produktový vstup je doplněk ke stávajícím agentům: **Codex, Claude Code, Hermes a OpenCode**. VOID nemá vyžadovat, aby developer opustil svůj běžný chat.
- Cílová demonstrace používá **soubory, Git a Postgres**.
- Uživatel plánuje kapacitu většího týmu; počet lidí ani dostupné úvazky zatím nejsou známé. Plán proto uvádí škálovací varianty.
- Souběžná práce má nejdřív používat oddělené worktrees a bezpečné zastavení při konfliktu. Automatické slučování až po vlastním důkazu.
- Po opravách jádra má následovat snadné každodenní použití, potom ověřování kvality výsledků a týmové funkce. Jde o uživatelem zvolené pořadí priorit.
- CEO obchodní doporučení: bezplatné nebo otevřené lokální jádro zachovat; první opakovaný příjem ověřit malým počtem placených pilotů s pevným rozsahem. Samoobslužné předplatné přidat až po důkazu aktivace a opakovaného používání.

## Navigace

- [Strategie a srovnání produktových směrů](STRATEGY.md)
- [Produktové a technické etapy](ROADMAP.md)
- [Podrobný funkční backlog a akceptace](BACKLOG.md)
- [Měření kvality výstupů a kompatibility agentů](QUALITY.md)
- [Příjmy, retence, prodejní experimenty a týmové scénáře](BUSINESS.md)
- [Zjištění o jádru](CORE-AUDIT.md)
- [Aplikace a cloud](SURFACES-AUDIT.md)
- [Konkurence, zdroje a limity průzkumu](MARKET-RESEARCH.md)
- [Pokrytí auditu jádra](CORE-COVERAGE.md)
- [Pokrytí aplikací a marketingu](SURFACES-COVERAGE.md)
- [Mapa CLI, workbench, skriptů, CI a download stránky](ROOT-SOURCE-MAP.md)
- [Strojově ověřitelný inventář všech souborů `main`](REPOSITORY-INVENTORY.csv)

## Hlavní závěr

VOID má rozsáhlý kód i propracovanou lokální auditní a recovery infrastrukturu. Další funkcí se nestane ultimátním nástrojem, pokud současně nezkrátí cestu od instalace k viditelnému výsledku, spolehlivě zachová práci uživatele a doloží, co bylo skutečně zkontrolováno. Konkurenti už mají vlastní chat, Git checkpointy, undo, schvalování a připojování MCP. Vstupní slib proto musí být mnohem přesnější:

> **Nech svůj oblíbený agent změnit podporované zdroje, uvidíš skutečný rozsah změny a ověřenou obnovu; když se mezitím změní práce někoho dalšího, VOID se zastaví a ochrání ji.**

Před rozšiřováním nabídky opravit a nezávisle otestovat nalezené recovery, attribution a MCP response problémy. Pak nabídnout tři srozumitelné povrchy téhož jádra: CLI/proxy pro stávající host, desktopový reviewer/installer pro jednotlivce a hosted týmovou evidenci jen tehdy, když z ní pilot získá opakovanou hodnotu.

## Důležité meze důkazů

GitHub `main` je privátní repozitář; přístup metadata potvrzují. Nejnovější release API vrací Windows/macOS desktop beta.4 z 14. září. Marketingový mirror byl načten zvlášť na `85c6792838f5014818d48e93188342cf3c824c8e`; hlavní zdroj `void-empty` má vlastní větev a není součástí změn této větve.

Nativní nástroj Deep Research ani obecné web search nebyl v tomto prostředí dostupný. Tržní část využívá přístupný GitHub konektor pro primární veřejné README a issues, dokumentaci a stávající zdroje v repozitáři. Prodejní ceny, customer demand, live deployments, security certification ani příjmy z repozitáře nelze potvrdit. Audit pokrytí výslovně odlišuje čtení modulu, cílenou kontrolu a pouhý index; nepředstírá, že všech 923 souborů bylo ručně přečteno řádek po řádku.
