---
name: papayai-apple-gate-measure
description: Use when changing preview/ CSS layers or Apple gate scripts in Papayai and you must measure the result without corrupting the gate run
---

# Měření bran podle plánů Apple v Papayai

Použij, když měníš vrstvu CSS v `preview/` nebo sám skript
`preview/apple-gate-*.cjs` a potřebuješ čísla, ne odhad.

## Kód

```bash
cd /Users/dawe/Developer/Claude-Projects/Papayai
python3 preview/build.py                     # brány měří SESTAVENÝ index.html
node preview/apple-gate-material.cjs          # ~135 s
node preview/apple-gate-layer.cjs             # ~135 s
node prime/brany.js material layer            # jen jmenované brány
```

Jedna brana i jeden běh manifestu jsou pomalej než povolených 250 s na
jeden příkaz. Dvě brany za sebou spusť jako dva příkazy, ne jako `&&`.

## Tři věci, které tu už jednou stojily chybově

1. **Souběžné Playwrighty.** `projdi` a `li-worker-contract` jsou
   neteterministické, když běží současně s jinou bránou. Když spouštíš
   bránu, nesmí současně běžet žádná jiná. Agentovi to zapiš do zadání
   výslovně.
2. **`$?` po rouře.** `node brana | tail` vrací kód posledního článku,
   tedy kód `tail`, ne brány. Výstup čti celý, kód ne.
3. **Ablace, když dvě opravy spolu souvisí.** Když máš pocit, že
   pravidlo A udělalo polovinu a pravidlo B druhou, změň A na
   neexistující selektor, přestavěj a přeměř. Bez toho nevíš, kdo to
   udělal, a necháváš v repu zbytečné pravidlo. 30. září 2026 tak
   vyšlo, že pravidlo pro obsahovou vrstvu v `preview/pohyb.css` nebylo
   potřeba, protože příčina ležela v tokenech `--sk-*`.

## Co je co v `preview/apple-gate-material.cjs`

- hlídka A: čtyři standardní materiály existují a jsou čtyři různé výplně
- hlídka B: plocha v `.stage` kreslí výplní mimo `--mat-*` slovník
- hlídka C: plocha v `.stage` má `inset` ve stínu
- počítadla jsou **na měření**, ne na plochy: jedno měření je
  obrazovka krát šířka krát kůže. "160" znamená 160 měření, ne 160 ploch.

## Co je co v `preview/apple-gate-layer.cjs`

- hlídka A: sklo uvnitř `.stage`, mimo přechodné ovládání a mimo
  `PREKRYVNE`
- hlídka B: funkční nosič, který na obrazovce je, ale sklo nemá
- hlídka C: skleněné ovládání, které právě nikdo neaktivuje

## Když brána padá, nejdřív zjisti, jestli padá správně

Každá z těchto bran má v hlavičce napsané, co umí spadnout, a vlastní
negativní kontrolu. Když číslo nedává smysl, přečti hlavičku a
`preview/apple-gate-journey.cjs`, ne dělej pravidlo mírnější. Věta z
Appleho JSONu, která drží `material` hlídku B, je "use standard
materials for elements in the content layer", ne "can use".

## Zdroj citací

`https://developer.apple.com/tutorials/data/design/human-interface-guidelines/<slug>.json`,
ne vykreslené HTML stránky, ta jsou prázdná. V repu to má
`preview/build.py` a `docs/apple-plans/README.md`.
