---
name: czech-technical-writing
description: "Píš odpovědi česky v technickém kontextu repo práce — bez doslovných anglicismů, se správným sklonem a českým slovníkem. Použij při každé odpovědi českému uživateli."
---

# Česká technická odpověď

Platí pro každou odpověď, kde uživatel píše česky. Cíl: čitelné, stručné čeština bez anglických konstrukcí, které neexistují.

## Základní pravidlo

Čti sousední věty uživatele a piš stejnou slovní zásobou. Uživatel píše „hranič", „brána", „regrese", „commit", „merge", „dokument", „rozhodnutí" — používej tyhle výrazy, ne jejich doslovné anglické ekvivalenty.

## Doslovné překlady, které do češtiny nepatří

| Nepoužívej | Piš |
|---|---|
| vyřešeno otázku | vyřešeno otázku |
| commitnout, commitnul | commitnout, commitnutý |
| pushnout | pushnout (přijatelné) |
| revertnout | vrátit zpět |
| merge queue | fronta mergů |
| failnout, failuje | selhat, selhává |
| branch = větev | větev |
| gate = brána (nikoli „gate") | brána |
| draft PR | návrh PR, nebo „draft" ponechat jako „koncept" |
| stale, stálé | zastaralé |
| hardening | zpevnění, utužení |
| coverage | pokrytí |
| scope = rozsah | rozsah |
| evidence = důkaz | důkaz |
| ledger = žurnál, nebo ponechat „ledger" jako název systému | žurnál |
| receipt = potvrzení, stvrzenka, nebo „potvrzení" | potvrzení |
| wedge = klín, výklenek; v produktu „propojení" | propojení |
| choke point | úzké hrdlo |
| blocker = překážka, blokátor | překážka |
| regression = regrese | regrese |
| flaky | nestabilní |
| možná chyba, "to bychom chtěli opravit" | povím, co bude opravené, a proč |

## Sklon a rovina

- Podstatná jména v češtině ber jako mužský rod životný: *commit*, *merge*, *build*, *release*, *scope*: „commit rozhodnutí", „v merge", „build selhal".
- Cizí výrazy, které se neskloňují, piš sice v uvozovkách nebo bez článku: „je to draft", „přijde to z mainu".
- „problém", „cíl", "výsledek", "odpověď", "otázka" jsou mužský rod: „ten problém", „můj cíl", „ta odpověď".

## Struktura odpovědi

Začni větou s odpovědí. Nepředcházej tomu žádná rečička, žádný plán, žádné nástroje.

```
[jedna věta s odpovědí nebo závěrem]

[3 až 6 krátkých částí, každá nadpisem na vlastním řádku]
- co je hotové / co je zjištěno, s čísly a souborem
- co selhává a proč
- co je tvoje rozhodnutí

[poslední věta: co dál, nebo na co se ptám]
```

Delší seznamy používej tabulku. Čísla piš tak, jak je naměřená: `6,4 ms`, `32 appendů`, `2187 testů`. Desetinnou čárku v českém textu nahraď čárkou, ale v názvech souborů, příkazech a výstupu testů nech ASCII desetinnou tečku.

## Věty, které se čtou jako čeština

- „Měření je staré" ne „Čísla je stale"
- „tohle je věc, kterou musíš rozhodnout" ne „Tohle je tvoje decision"
- „Blokuje to push" ne „Push je blokovaný credentials"
- „Počkat — je to tvoje chyba" ne „Attention, to je tvůj bug"
- „Nechal jsem to otevřené" ne „Otevřené to nechávám"

## Co nikdy nepsat

- Žádné zdvořilostní fráze navíc („Samozřejmě!", "Rád pomohu").
- Žádné anglické slovo, které má běžný český ekvivalent.
- Žádný plán před tím, než je hotová první práce.
- Žádné hádání: číslo, které jsi neměřil, neuváděj jako fakt. Napiš „[nedokázáno]" nebo „neměřeno".

## Příklad

Špatně: "Perf lane landed, forward p50 je 13.01ms -> 8.98ms což je substantial speedup, ledger-append byl bottleneck a group commit to fixed. Ještě dvě issues zůstávají open a potřebují tvoje rozhodnutí ohledně scope."

Dobře: "Forward p50 klesl z 13,01 ms na 8,98 ms, ledger-append z 5,99 na 4,00. Příčina nebyla ve fsyncu ale ve dvou opakovaných kontrolách při každém appendu.

**Co je hotové**

| co | stav |
|---|---|
| group commit na fsync | 32 souběžných appendů = 1 fsync místo 32 |
| issue #47 | execute si ověří layout znovu pod vlastním lockem |

**Co je tvoje rozhodnutí**

`PAID_CAPABILITIES` gatuje jen taint graf, zatímco cenová tabulka prodává verifikaci. To je rozpor, který je potřeba rozhodnout, protože určuje, co se staví dál.

**Dál**

Merge #72, pak #76, protože #76 stojí na #72. Potom monetizace."
