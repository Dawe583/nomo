# Směrování NOMO: čtyři varianty a doporučení

## Jak poznáme, že je NOMO oblíbený i výdělečný

Produktový cíl „pro každého vývojáře“ je příliš široký pro přímou roadmapu. Použijeme posloupnost:

1. **Užitečný jednomu vývojáři:** chráněný task bez nutnosti měnit oblíbeného agenta.
2. **Opakovatelný jednomu týmu:** kolega umí na jiné čisté instalaci zopakovat instalaci, rozhodnutí i obnovu.
3. **Měřitelný:** NOMO ukazuje, které efekty byly zachyceny, které nebyly, skutečné testy a stav obnovy.
4. **Prodejný:** konkrétní buyer platí opakovaně za provozní výsledek, týmovou správu nebo úroveň podpory.
5. **Rozšiřitelný:** nový host/connector se přidává přes společný kontrakt, ne další produktovou větev.

Nesčítat aktivní uživatele napříč TUI, desktopem, webem a hosted nástrojem, dokud každý záznam nemá konzistentní workspace/identity a privacy policy. Download, install, připojení hosta, první zachycený write, první ověřený restore a placený renewal jsou rozdílné stavy funnelu.

## Porovnání vstupních produktů

| Varianta | Hodnota | Prodej/retence | Rizika a cena | Rozhodnutí |
|---|---|---|---|---|
| **A. Doplněk pro stávající agenty** | Obnova skutečných změn napříč hosty; stávající agent zachová jeho modely a návyky | Nejrychlejší cesta k užitečnému pilotu; jednotlivci instalují lokálně, vedoucí kupuje společné policy/evidence | Každý host může směrovat operace jinudy; připojené MCP pokrývá jen tento MCP. Vysoká odpovědnost za recovery safety | **Zvoleno uživatelem** |
| **B. Vlastní agentní workspace** | End-to-end řízení v jednom produktu, snadněji spravovatelná zkušenost | Předplatné může být přirozené, pokud NOMO bude každý týden primární workspace | Přímá soutěž s Codex/Cline/OpenHands; inference/support náklady; migrace návyků. Stávající workbench je už významná implementace | Zachovat jako volitelný klient společného jádra; neschválit jako hlavní vstup |
| **C. Týmový control plane** | Policy, approvals, evidence, revokace a přehled napříč projekty | Vyšší možná cena a organizační retence | Delší bezpečnostní/procurement proces; current owner session není RBAC multi-tenant billing. Hrozí upsell před doloženým lokálním efektem | Navazující placená vrstva po pilotní hodnotě |
| **D. Kombinované jádro a všechny klienty** | Široká nabídka v dlouhém horizontu | Možná největší cílový trh | Vysoká koordinace a rozptýlení; jednotlivé povrchy nejsou rovnocenná integrace ani release maturity | Architektonický směr, ne výchozí kvartální scope |

### Doporučení pro CEO

Zvolit **A jako vstup**, budovat společný recovery/ledger/capability kontrakt a prodávat **C jako pilotní opakovanou službu**. B si ponechat jako už existující alternativní UI a těžit z něj jen tam, kde zjednoduší instalaci, review a reprodukci důkazů. Nedělat další obecný chat, marketplace, agent orchestration engine ani nové klientské platformy bez konkrétního zákazníka.

## Positioning, který může trh vyvrátit

**Pro vývojáře a malé platformní týmy, kteří pravidelně používají coding agenty:** NOMO ukazuje hranice zachycení, před změnou uloží důkazy pro podporované efekty, v konfliktu se zastaví a prokázanou změnu vrátí s ověřitelným výsledkem. Funguje vedle vybraného agenta; nevymýšlí nebo nepovoluje jeho business intent.

Tato hypotéza musí projít srovnáním proti built-in checkpoints, Git branch/worktree, editor Local History, provider approvals, agentgateway/Portkey a týmovému logování. Chybějící inverzní efekt dostane férový stav „není zachytitelný / obnovitelný“. Ochrana neskrytě nepřevádí nativní shell nebo síťový write do řízené cesty.

## Budování kategorie: outcome místo feature soup

- Uživatel kupuje menší pravděpodobnost ztráty podporované práce, rychlejší bezpečný review a jednodušší dohledání odpovědnosti.
- Bezplatné lokální jádro přináší důvěru, používání a kompatibilitu. Nepoškozovat existující práva/feature požadavkem na monetizaci.
- Platba za team znamená více identit, sdílená pravidla, řízení přístupu, export a retenci, podporu, provozní důkazy. Nikoli „odemčené bezpečnější Undo“.
- Retence má vznikat každodenním stavem chráněné/nechráněné práce a srozumitelným reportem. Nefabri­kovat zachráněné incidenty a nezaměňovat počet schválení za value.
- Po každé etapě má tým aktualizovat capability matrix, evidence, activation data, placené objections a cenu. Staré plány jsou návrhy, nikoli skutečný product state.
