# Pokrytí core auditu NOMO — 30. září 2026

Výchozí commit: `4c560dd98668da06e24b2189e854203fdcaa80a2`. Bez změn implementace. CLI/workbench vlastní hlavní agent, apps druhý subagent.

## Význam pokrytí

- **R**: celé znění modulu vráceno do kontextu a přečteno.
- **P**: cílené části; uveden rozsah nebo omezení zkráceného výstupu.
- **I**: celý soubor strojově indexován na importy, exporty, testy a rizikové vzory; NEZNAMENÁ přečtení každého řádku implementace.
- **D**: inventář dat, konfigurace a dokumentace; NEZNAMENÁ úplnou sémantickou revizi.

Všechny uvedené soubory otevřeny pro velikost, počet řádků, hash a strukturální index. Výsledek nesmí být označen jako úplný bezpečnostní audit každého řádku ani nezávislá certifikace providerů. Registry data a rozsáhlé testy mají slabší pokrytí než produkční hranice. Tento audit vědomě a výslovně nesplňuje doslovné přečtení každého řádku celého repository.

Pro TS/MJS/Python indexované vzory: import/export/def/class, test/posixTest/describe/it, TODO/FIXME, unsupported/not implemented, readFile, spawnSync, BEGIN IMMEDIATE a catch potlačení. JSON/YAML/README inventarizovány; README kontrakty cíleně porovnány s implementací. Datové/generované assety nejsou bezpečnostně certifikovány. Inventář je z git ls-files, takže nezahrnuje node_modules a pyc vytvořené testy.

## Ověření

1. Core Node testy runtime, recovery, ledger, filesystem, Git: 484 testů,477 pass,5 fail,2 skip. Prostředí umask077; pět selhání souviselo s implicitními oprávněními fixtures. Log `/tmp/nomo-core-tests.log`.
2. Opakování affected FS/Git souborů s umask022: 222 testů,220 pass,0 fail,2 skip. Log `/tmp/nomo-core-tests-umask022.log`. Restriktivní umask zůstává pokrytí, které je třeba opravit.
3. Python unittest:84/84 pass včetně skutečného loopback relay a CLI recovery serveru; `/tmp/nomo-python-tests.log`.
4. Ad hoc skutečný FS runtime: dva zápisy stejného souboru; recovery job končí konfliktem po jednom checkpointu.
5. Skutečný Session+relay: server id server-42 se vrací jako1.
6. Skutečný ledger append při umask022 vytváří0644.
7. Recovery payload validator odmítá emitovaný lease-expired payload.
8. Orientační lokální ledger:100 záznamů verify23ms;1000 záznamů verify211ms. Jeden cloud host, ne produkční benchmark.

## Souborový inventář

Celkem 242 souborů; D=40, I=146, P=13, R=43.

| Soubor | Řádky | SHA256 prefix | Pokrytí | Deklarace/vzory | Test deklarace |
| --- | ---: | --- | --- | ---: | ---: |
| `fixtures/e2e-http-server.mjs` | 118 | `92ab6b70a5d4` | I: strukturální index | 1 | 0 |
| `fixtures/e2e-policy.yaml` | 15 | `5e24bd292ca2` | D: inventář data/config/docs | 0 | 0 |
| `fixtures/e2e-server.mjs` | 107 | `338bed3fa8c5` | I: strukturální index | 1 | 0 |
| `fixtures/facts.json` | 24 | `3cc71972838c` | D: inventář data/config/docs | 0 | 0 |
| `fixtures/registry/wp04b-batch2.json` | 2870 | `98aa35b5c4bb` | D: inventář data/config/docs | 0 | 0 |
| `fixtures/registry/wp04b-batch3.json` | 3435 | `95a86da2b2e1` | D: inventář data/config/docs | 0 | 0 |
| `fixtures/session.jsonl` | 30 | `3103d77cdff5` | D: inventář data/config/docs | 0 | 0 |
| `packages/connectors/README.md` | 289 | `436ea1d6e2b7` | D: inventář data/config/docs | 31 | 0 |
| `packages/connectors/package.json` | 38 | `68d9f01b6878` | D: inventář data/config/docs | 0 | 0 |
| `packages/connectors/src/capability-profiles.test.ts` | 133 | `99dc59e15afc` | I: strukturální index | 5 | 8 |
| `packages/connectors/src/capability-profiles.ts` | 134 | `85439ab648f2` | R: celé znění | 8 | 0 |
| `packages/connectors/src/capability.test.ts` | 207 | `47c7e31ebc72` | I: strukturální index | 6 | 12 |
| `packages/connectors/src/capability.ts` | 330 | `95c23602c7be` | I: strukturální index | 14 | 2 |
| `packages/connectors/src/filesystem/managed.test.ts` | 458 | `7fac36260747` | P: 1–145 + failure lokace | 38 | 11 |
| `packages/connectors/src/filesystem/managed.ts` | 499 | `f1363dab7316` | R: celé znění | 5 | 4 |
| `packages/connectors/src/git/managed-commit.test.ts` | 2401 | `332204befe38` | I: strukturální index | 131 | 83 |
| `packages/connectors/src/git/managed-commit.ts` | 1614 | `5c53138933b0` | I: strukturální index | 64 | 15 |
| `packages/connectors/src/git/managed-remote.test.ts` | 524 | `9161917d911a` | I: strukturální index | 28 | 11 |
| `packages/connectors/src/git/managed-remote.ts` | 651 | `40577735f35b` | I: strukturální index | 17 | 7 |
| `packages/connectors/src/git/managed.test.ts` | 385 | `67e7e3aa5493` | P: 1–170 | 57 | 26 |
| `packages/connectors/src/git/managed.ts` | 596 | `c40fdbe00495` | P: většina modulu, parse/worktree výstup místy zkrácen | 33 | 4 |
| `packages/connectors/src/index.test.ts` | 25 | `8bfdd9073815` | I: strukturální index | 4 | 3 |
| `packages/connectors/src/index.ts` | 64 | `7d0db11cebce` | I: strukturální index | 8 | 0 |
| `packages/connectors/src/manifest.test.ts` | 195 | `b79f428c123f` | I: strukturální index | 10 | 12 |
| `packages/connectors/src/manifest.ts` | 213 | `cfe3acfeca36` | R: celé znění | 18 | 0 |
| `packages/connectors/src/postgres/capture.test.ts` | 56 | `7df67ab59d61` | I: strukturální index | 6 | 3 |
| `packages/connectors/src/postgres/capture.ts` | 143 | `b31b07584e55` | I: strukturální index | 8 | 0 |
| `packages/connectors/src/postgres/classify.test.ts` | 23 | `a3674de024ab` | I: strukturální index | 6 | 1 |
| `packages/connectors/src/postgres/classify.ts` | 10 | `eccd6772f644` | I: strukturální index | 3 | 0 |
| `packages/connectors/src/postgres/conformance-fixture.ts` | 431 | `d199c3607841` | I: strukturální index | 14 | 0 |
| `packages/connectors/src/postgres/inverse.test.ts` | 107 | `9a3cd85b9660` | I: strukturální index | 8 | 4 |
| `packages/connectors/src/postgres/inverse.ts` | 113 | `9d1f9f7f67a6` | I: strukturální index | 10 | 0 |
| `packages/connectors/src/postgres/managed-adversarial.test.ts` | 258 | `a7cb2768dbd0` | I: strukturální index | 13 | 8 |
| `packages/connectors/src/postgres/managed-install.test.ts` | 286 | `49ffb9fc7709` | I: strukturální index | 14 | 9 |
| `packages/connectors/src/postgres/managed.test.ts` | 539 | `771040475e5e` | I: strukturální index | 22 | 12 |
| `packages/connectors/src/postgres/managed.ts` | 1525 | `3295c3542a0b` | P: 1–95,750–910,1245–1525 | 18 | 4 |
| `packages/connectors/src/postgres/parse.test.ts` | 36 | `63bd79ef7196` | I: strukturální index | 4 | 2 |
| `packages/connectors/src/postgres/parse.ts` | 126 | `c384aa431eea` | I: strukturální index | 5 | 0 |
| `packages/connectors/src/postgres/replay.ts` | 57 | `d0468ecfae14` | I: strukturální index | 8 | 0 |
| `packages/connectors/src/postgres/reverse-exercise.ts` | 133 | `9823fe9360f9` | I: strukturální index | 10 | 0 |
| `packages/connectors/src/postgres/sql-engine.test.ts` | 33 | `0a87ec9939b1` | I: strukturální index | 8 | 1 |
| `packages/connectors/src/probes/cache.test.ts` | 29 | `b671f7c36d52` | I: strukturální index | 5 | 1 |
| `packages/connectors/src/probes/cache.ts` | 48 | `ee32f71b202e` | I: strukturální index | 5 | 0 |
| `packages/connectors/src/probes/postgres.test.ts` | 57 | `1c4abf59eb6d` | I: strukturální index | 5 | 3 |
| `packages/connectors/src/probes/postgres.ts` | 96 | `181648b6dbde` | I: strukturální index | 3 | 0 |
| `packages/connectors/src/probes/registry.test.ts` | 20 | `c88adb246f74` | I: strukturální index | 4 | 2 |
| `packages/connectors/src/probes/registry.ts` | 43 | `2fb35524dd7a` | I: strukturální index | 8 | 0 |
| `packages/connectors/src/probes/s3.test.ts` | 45 | `7a7f9b8946c5` | I: strukturální index | 5 | 2 |
| `packages/connectors/src/probes/s3.ts` | 54 | `02a0f4c44d14` | I: strukturální index | 3 | 0 |
| `packages/connectors/src/readme-contract.test.ts` | 41 | `f8fb53edf96d` | I: strukturální index | 5 | 4 |
| `packages/connectors/src/recovery.ts` | 73 | `52c90028ecb2` | R: celé znění | 11 | 0 |
| `packages/connectors/src/registry.test.ts` | 161 | `a906341ebf86` | I: strukturální index | 10 | 5 |
| `packages/connectors/src/registry.ts` | 382 | `59719c2357a0` | R: celé znění | 33 | 0 |
| `packages/connectors/src/reverse-engine.test.ts` | 550 | `826ac3315e37` | I: strukturální index | 33 | 9 |
| `packages/connectors/src/s3/apply-guard.test.ts` | 212 | `75888f9912f5` | I: strukturální index | 9 | 4 |
| `packages/connectors/src/s3/apply.test.ts` | 134 | `a49474248292` | I: strukturální index | 10 | 5 |
| `packages/connectors/src/s3/apply.ts` | 194 | `d7d648dd97b3` | R: celé znění | 10 | 0 |
| `packages/connectors/src/s3/capture.ts` | 73 | `bce1416eaa80` | I: strukturální index | 9 | 0 |
| `packages/connectors/src/s3/classify.ts` | 101 | `470c356144a2` | I: strukturální index | 9 | 0 |
| `packages/connectors/src/s3/inverse.ts` | 23 | `119b06219323` | R: celé znění | 4 | 0 |
| `packages/connectors/src/s3/s3.test.ts` | 175 | `1d96cf78e48d` | I: strukturální index | 13 | 7 |
| `packages/connectors/src/snapshot/local.ts` | 369 | `7eb384fc2651` | I: strukturální index | 12 | 2 |
| `packages/connectors/src/snapshot/redact.ts` | 18 | `7ae8429518c1` | I: strukturální index | 3 | 0 |
| `packages/connectors/src/snapshot/s3.ts` | 83 | `960d893c1541` | I: strukturální index | 7 | 0 |
| `packages/connectors/src/snapshot/snapshot.test.ts` | 319 | `42ae77a060f6` | I: strukturální index | 21 | 17 |
| `packages/connectors/src/snapshot/store.ts` | 43 | `38ec9813d1bf` | I: strukturální index | 20 | 0 |
| `packages/connectors/tsconfig.json` | 18 | `4d1e3014cd01` | D: inventář data/config/docs | 0 | 0 |
| `packages/ledger/README.md` | 67 | `36f5e9d7b3e1` | D: inventář data/config/docs | 0 | 0 |
| `packages/ledger/package.json` | 34 | `753af298bc78` | D: inventář data/config/docs | 0 | 0 |
| `packages/ledger/src/anchor.test.ts` | 244 | `3790a3ae7635` | I: strukturální index | 14 | 9 |
| `packages/ledger/src/anchor.ts` | 157 | `7200aa880ffc` | R: celé znění | 12 | 0 |
| `packages/ledger/src/attest.test.ts` | 75 | `e26f87b58ab7` | I: strukturální index | 11 | 2 |
| `packages/ledger/src/attest.ts` | 257 | `144160162a20` | I: strukturální index | 18 | 1 |
| `packages/ledger/src/attribution.test.ts` | 451 | `dce829b7b345` | I: strukturální index | 27 | 14 |
| `packages/ledger/src/attribution.ts` | 236 | `dfc67d2a7c9d` | I: strukturální index | 5 | 3 |
| `packages/ledger/src/canonical.ts` | 105 | `312ce4268f87` | R: celé znění | 4 | 1 |
| `packages/ledger/src/feed.test.ts` | 120 | `721da21c0ce1` | I: strukturální index | 11 | 4 |
| `packages/ledger/src/feed.ts` | 163 | `18d30cdb6416` | I: strukturální index | 12 | 0 |
| `packages/ledger/src/hardening.test.ts` | 117 | `f44cdf6f07dc` | I: strukturální index | 10 | 6 |
| `packages/ledger/src/hardening.ts` | 100 | `9aeeb336ca87` | I: strukturální index | 7 | 1 |
| `packages/ledger/src/index.test.ts` | 345 | `15608f427556` | I: strukturální index | 22 | 21 |
| `packages/ledger/src/index.ts` | 89 | `fb0fe11a64e3` | I: strukturální index | 16 | 1 |
| `packages/ledger/src/reversal-boundary.test.ts` | 221 | `269392911e26` | I: strukturální index | 18 | 5 |
| `packages/ledger/src/reversal.test.ts` | 211 | `8278058f1fe5` | I: strukturální index | 19 | 7 |
| `packages/ledger/src/reversal.ts` | 121 | `72879a05c9e5` | I: strukturální index | 5 | 1 |
| `packages/ledger/src/security.test.ts` | 93 | `ccecde53aed9` | I: strukturální index | 16 | 7 |
| `packages/ledger/src/sign.ts` | 219 | `63845883b982` | R: celé znění | 20 | 0 |
| `packages/ledger/src/store.ts` | 253 | `9e63e9d37655` | R: celé znění | 18 | 0 |
| `packages/ledger/src/taint/capture.test.ts` | 89 | `f89aa7aa313d` | I: strukturální index | 13 | 3 |
| `packages/ledger/src/taint/capture.ts` | 126 | `415b61cabab5` | I: strukturální index | 10 | 0 |
| `packages/ledger/src/taint/graph.test.ts` | 77 | `e59d083a5dad` | I: strukturální index | 6 | 4 |
| `packages/ledger/src/taint/graph.ts` | 178 | `6f2ff9145d1b` | I: strukturální index | 7 | 0 |
| `packages/ledger/src/taint/query.test.ts` | 58 | `2461ae5b9a59` | I: strukturální index | 5 | 4 |
| `packages/ledger/src/taint/query.ts` | 120 | `e1d9e02d03dd` | I: strukturální index | 5 | 0 |
| `packages/ledger/src/verify-key.test.ts` | 284 | `40547d013ab9` | I: strukturální index | 13 | 13 |
| `packages/ledger/src/verify-key.ts` | 558 | `5936d75b5019` | P: většina modulu, výstup místy zkrácen | 35 | 0 |
| `packages/ledger/src/verify.test.ts` | 86 | `f7549334fb31` | I: strukturální index | 10 | 3 |
| `packages/ledger/src/verify.ts` | 204 | `7a18aa14bc74` | R: celé znění | 20 | 0 |
| `packages/ledger/tsconfig.json` | 18 | `4d1e3014cd01` | D: inventář data/config/docs | 0 | 0 |
| `packages/policy/README.md` | 125 | `ca9d878670fc` | D: inventář data/config/docs | 2 | 0 |
| `packages/policy/package.json` | 36 | `362cb0205e5d` | D: inventář data/config/docs | 0 | 0 |
| `packages/policy/packs/balanced.yaml` | 15 | `27493c9bb0c8` | D: inventář data/config/docs | 0 | 0 |
| `packages/policy/packs/dev.yaml` | 15 | `7741036a7bf7` | D: inventář data/config/docs | 0 | 0 |
| `packages/policy/packs/strict.yaml` | 9 | `27d64e3f01ff` | D: inventář data/config/docs | 0 | 0 |
| `packages/policy/src/approvals.test.ts` | 111 | `816f5b35e533` | I: strukturální index | 6 | 5 |
| `packages/policy/src/approvals.ts` | 379 | `e37d3d50c286` | P: většina modulu, zkrácený společný výstup | 21 | 0 |
| `packages/policy/src/attribution.test.ts` | 120 | `ad3dfaa4ab2c` | I: strukturální index | 15 | 7 |
| `packages/policy/src/channels/cli.test.ts` | 78 | `ba56aa3449c3` | I: strukturální index | 5 | 5 |
| `packages/policy/src/channels/cli.ts` | 62 | `24f901d00b62` | I: strukturální index | 6 | 0 |
| `packages/policy/src/channels/slack.test.ts` | 92 | `aba369ba5e67` | I: strukturální index | 5 | 5 |
| `packages/policy/src/channels/slack.ts` | 119 | `2a49bedd73bf` | I: strukturální index | 7 | 0 |
| `packages/policy/src/decide.ts` | 192 | `4598b8b2af93` | R: celé znění | 5 | 0 |
| `packages/policy/src/digest.ts` | 20 | `fae5c61afb68` | I: strukturální index | 3 | 0 |
| `packages/policy/src/grammar.ts` | 57 | `e3d4962096be` | I: strukturální index | 9 | 0 |
| `packages/policy/src/hold.test.ts` | 119 | `b4284fdea678` | I: strukturální index | 5 | 9 |
| `packages/policy/src/hold.ts` | 180 | `f60eb114f934` | P: zobrazený konec společného výstupu | 8 | 0 |
| `packages/policy/src/index.test.ts` | 26 | `310c2792e7f2` | I: strukturální index | 4 | 3 |
| `packages/policy/src/index.ts` | 21 | `18a86bd0faa1` | I: strukturální index | 9 | 0 |
| `packages/policy/src/no-barrel-imports.test.ts` | 50 | `79d1fe307d9d` | I: strukturální index | 7 | 2 |
| `packages/policy/src/packs.test.ts` | 86 | `fd4a9996c56f` | I: strukturální index | 11 | 8 |
| `packages/policy/src/packs.ts` | 34 | `9c543e15c2ab` | I: strukturální index | 9 | 0 |
| `packages/policy/src/rules.test.ts` | 343 | `c04560860ae1` | I: strukturální index | 11 | 22 |
| `packages/policy/src/rules.ts` | 236 | `de7a41bfab97` | P: část společného výstupu | 12 | 0 |
| `packages/policy/src/skeptics.test.ts` | 143 | `5d737f1bfa0a` | I: strukturální index | 11 | 5 |
| `packages/policy/tsconfig.json` | 18 | `4d1e3014cd01` | D: inventář data/config/docs | 0 | 0 |
| `packages/proxy/README.md` | 77 | `3fb72bb6c2c9` | D: inventář data/config/docs | 1 | 0 |
| `packages/proxy/bin/nomo-proxy.mjs` | 76 | `5e0fc016c0ff` | I: strukturální index | 5 | 1 |
| `packages/proxy/docs/interface.md` | 249 | `6cf38fb05e1f` | D: inventář data/config/docs | 8 | 0 |
| `packages/proxy/docs/message-inventory.md` | 249 | `ff69e8599c97` | D: inventář data/config/docs | 1 | 0 |
| `packages/proxy/docs/message-inventory.verified.md` | 25 | `757fae327bae` | D: inventář data/config/docs | 0 | 0 |
| `packages/proxy/package.json` | 40 | `a5983f8eec78` | D: inventář data/config/docs | 0 | 0 |
| `packages/proxy/src/approval-loop.test.ts` | 183 | `983be2446112` | I: strukturální index | 12 | 4 |
| `packages/proxy/src/approval-loop.ts` | 118 | `9c751ec6ab3b` | I: strukturální index | 9 | 0 |
| `packages/proxy/src/bin.test.ts` | 1319 | `ce2b5406b111` | I: strukturální index | 30 | 28 |
| `packages/proxy/src/bin.ts` | 972 | `109cafa945fa` | R: celé znění | 39 | 0 |
| `packages/proxy/src/blast.ts` | 73 | `2afe46e36bfd` | I: strukturální index | 9 | 0 |
| `packages/proxy/src/forward/attribution.test.ts` | 182 | `4166d87242a9` | I: strukturální index | 19 | 6 |
| `packages/proxy/src/forward/forward.test.ts` | 38 | `01797d8a7572` | I: strukturální index | 5 | 3 |
| `packages/proxy/src/forward/legacy-binding.test.ts` | 110 | `78029a128f0e` | I: strukturální index | 8 | 4 |
| `packages/proxy/src/forward/legacy-binding.ts` | 175 | `bbffcc5c9524` | R: celé znění | 15 | 2 |
| `packages/proxy/src/forward/prompts.ts` | 39 | `de5cfb0529e2` | I: strukturální index | 4 | 0 |
| `packages/proxy/src/forward/resources.ts` | 41 | `85d65d1e6f8a` | I: strukturální index | 4 | 0 |
| `packages/proxy/src/forward/tools.test.ts` | 343 | `6accb9a66dcd` | I: strukturální index | 16 | 16 |
| `packages/proxy/src/forward/tools.ts` | 434 | `fadd94f4798f` | R: celé znění | 13 | 0 |
| `packages/proxy/src/hardening.test.ts` | 419 | `3c2f3dbb23a1` | I: strukturální index | 12 | 14 |
| `packages/proxy/src/hardening.ts` | 144 | `e32ab3b4be96` | R: celé znění | 8 | 0 |
| `packages/proxy/src/index.test.ts` | 18 | `ab588d653432` | I: strukturální index | 4 | 2 |
| `packages/proxy/src/index.ts` | 44 | `12385057dada` | I: strukturální index | 19 | 0 |
| `packages/proxy/src/legacy-root.test.ts` | 297 | `2f74b2ceaf48` | I: strukturální index | 17 | 11 |
| `packages/proxy/src/legacy-root.ts` | 233 | `d1325e28f935` | R: celé znění | 13 | 0 |
| `packages/proxy/src/relay/http-requests.test.ts` | 323 | `481560eb8d99` | I: strukturální index | 8 | 12 |
| `packages/proxy/src/relay/http-requests.ts` | 471 | `c88a5a72a37c` | I: strukturální index | 11 | 0 |
| `packages/proxy/src/relay/notifications.test.ts` | 91 | `c590d58329ce` | I: strukturální index | 5 | 4 |
| `packages/proxy/src/relay/notifications.ts` | 99 | `c3eada235f29` | I: strukturální index | 5 | 0 |
| `packages/proxy/src/relay/requests.test.ts` | 80 | `449945e76fab` | I: strukturální index | 6 | 5 |
| `packages/proxy/src/relay/requests.ts` | 80 | `9059dff56a90` | R: celé znění | 8 | 0 |
| `packages/proxy/src/rpc.ts` | 40 | `78cc4cb4be2e` | I: strukturální index | 8 | 0 |
| `packages/proxy/src/security.test.ts` | 142 | `4cdb61b9c240` | I: strukturální index | 10 | 5 |
| `packages/proxy/src/session.test.ts` | 413 | `5f507e855098` | I: strukturální index | 6 | 18 |
| `packages/proxy/src/session.ts` | 309 | `d3b07224cf18` | R: celé znění | 3 | 0 |
| `packages/proxy/src/transport/http.test.ts` | 332 | `d66cd97f7186` | I: strukturální index | 6 | 8 |
| `packages/proxy/src/transport/http.ts` | 357 | `3948bfc4ad85` | R: celé znění | 5 | 0 |
| `packages/proxy/src/transport/stdio.test.ts` | 330 | `a20b03d9a0bc` | I: strukturální index | 6 | 10 |
| `packages/proxy/src/transport/stdio.ts` | 218 | `9369b06925d0` | R: celé znění | 6 | 0 |
| `packages/proxy/tsconfig.json` | 18 | `4d1e3014cd01` | D: inventář data/config/docs | 0 | 0 |
| `packages/registry/README.md` | 50 | `8d0f5c044f8a` | D: inventář data/config/docs | 0 | 0 |
| `packages/registry/docs/facts.md` | 310 | `d4c478561bb3` | D: inventář data/config/docs | 0 | 0 |
| `packages/registry/docs/migration-audit.md` | 198 | `e7d9ff12d007` | D: inventář data/config/docs | 0 | 0 |
| `packages/registry/package.json` | 33 | `d22dd0fe679e` | D: inventář data/config/docs | 0 | 0 |
| `packages/registry/schema.json` | 169 | `7277f1d00225` | D: inventář data/config/docs | 0 | 0 |
| `packages/registry/src/audit.test.ts` | 123 | `c8c39c3bde3b` | I: strukturální index | 5 | 6 |
| `packages/registry/src/batch3.test.ts` | 92 | `a581a66abd56` | I: strukturální index | 12 | 4 |
| `packages/registry/src/evaluate.test.ts` | 244 | `19c739408b07` | I: strukturální index | 7 | 16 |
| `packages/registry/src/evaluate.ts` | 141 | `de5becee67da` | R: celé znění | 6 | 0 |
| `packages/registry/src/facts.test.ts` | 111 | `8975a7ff8391` | I: strukturální index | 7 | 6 |
| `packages/registry/src/facts.ts` | 126 | `001160378fee` | R: celé znění | 9 | 1 |
| `packages/registry/src/index.test.ts` | 74 | `abdee5d72c07` | I: strukturální index | 4 | 6 |
| `packages/registry/src/index.ts` | 9 | `7ba8cddae8ab` | R: celé znění | 4 | 0 |
| `packages/registry/src/precondition.ts` | 189 | `a49c803539c4` | R: celé znění | 10 | 0 |
| `packages/registry/src/registry.ts` | 3112 | `d90dedc4003d` | I: strukturální index | 18 | 0 |
| `packages/registry/tsconfig.json` | 19 | `4ecc4667dc86` | D: inventář data/config/docs | 0 | 0 |
| `packages/runtime/README.md` | 44 | `75f0187af180` | D: inventář data/config/docs | 0 | 0 |
| `packages/runtime/package.json` | 33 | `ef9fdf83262d` | D: inventář data/config/docs | 0 | 0 |
| `packages/runtime/src/adapter.ts` | 63 | `327d2db595e1` | R: celé znění | 10 | 0 |
| `packages/runtime/src/adversarial.test.ts` | 239 | `2ef3d4831686` | I: strukturální index | 19 | 10 |
| `packages/runtime/src/budget.test.ts` | 572 | `3a7b65982b44` | I: strukturální index | 25 | 9 |
| `packages/runtime/src/budget.ts` | 795 | `91bd8b5c2e59` | P: 1–cca440 + index | 26 | 2 |
| `packages/runtime/src/conformance.ts` | 231 | `fa934688566e` | I: strukturální index | 7 | 0 |
| `packages/runtime/src/crash.test.ts` | 421 | `81bf5de95639` | I: strukturální index | 25 | 5 |
| `packages/runtime/src/digest.ts` | 6 | `79ab9efbdaf9` | R: celé znění | 1 | 0 |
| `packages/runtime/src/execute.ts` | 1291 | `7a57833c341e` | R: celé znění | 21 | 12 |
| `packages/runtime/src/index.ts` | 11 | `7d70f49767da` | R: celé znění | 11 | 0 |
| `packages/runtime/src/journal.ts` | 346 | `830cf40b2c53` | R: celé znění | 24 | 5 |
| `packages/runtime/src/lease.test.ts` | 71 | `e80b57303414` | R: celé znění | 8 | 5 |
| `packages/runtime/src/persistence-fault.test.ts` | 349 | `68763a1aaf57` | I: strukturální index | 10 | 2 |
| `packages/runtime/src/provenance.test.ts` | 331 | `3711342b6202` | R: celé znění | 22 | 12 |
| `packages/runtime/src/recovery-crash.test.ts` | 170 | `73cd9de6d734` | I: strukturální index | 16 | 1 |
| `packages/runtime/src/recovery-job.test.ts` | 852 | `3cc4dd6fe0d9` | I: strukturální index | 26 | 17 |
| `packages/runtime/src/recovery/lease.ts` | 88 | `31da019542c2` | R: celé znění | 5 | 0 |
| `packages/runtime/src/recovery/plan.ts` | 752 | `0401a7bd2a55` | P: 460–752 + výběr první poloviny | 29 | 8 |
| `packages/runtime/src/recovery/provenance.ts` | 217 | `902d89190afb` | R: celé znění | 10 | 0 |
| `packages/runtime/src/recovery/run.ts` | 55 | `a8fe6fb93d0e` | R: celé znění | 7 | 0 |
| `packages/runtime/src/recovery/selectors.test.ts` | 451 | `23ea1928037d` | I: strukturální index | 30 | 26 |
| `packages/runtime/src/reserved-vault.test.ts` | 871 | `c3a5a85b24ff` | I: strukturální index | 39 | 20 |
| `packages/runtime/src/reserved-vault.ts` | 681 | `442e324aa749` | I: strukturální index | 19 | 5 |
| `packages/runtime/src/retention.test.ts` | 815 | `31a963ecf7f5` | I: strukturální index | 41 | 22 |
| `packages/runtime/src/retention.ts` | 829 | `3651dd7d110d` | I: strukturální index | 38 | 8 |
| `packages/runtime/src/runtime.test.ts` | 290 | `2ea7e0f36dde` | I: strukturální index | 22 | 10 |
| `packages/runtime/src/vault-budget.test.ts` | 97 | `4903050867e9` | I: strukturální index | 14 | 4 |
| `packages/runtime/src/vault.ts` | 123 | `30a6a504b190` | R: celé znění | 14 | 3 |
| `packages/runtime/tsconfig.json` | 18 | `c5707f78ccde` | D: inventář data/config/docs | 0 | 0 |
| `packages/sdk/README.md` | 61 | `4ac4546c066a` | D: inventář data/config/docs | 0 | 0 |
| `packages/sdk/package.json` | 41 | `fa27e22929cf` | D: inventář data/config/docs | 0 | 0 |
| `packages/sdk/src/client.test.ts` | 392 | `d9097626ae28` | I: strukturální index | 24 | 11 |
| `packages/sdk/src/client.ts` | 556 | `cbf3a5b8da75` | R: celé znění | 23 | 0 |
| `packages/sdk/src/errors.ts` | 63 | `3ffe9e67b265` | R: celé znění | 8 | 0 |
| `packages/sdk/src/hold.ts` | 59 | `f029b8dad368` | P: zkrácený společný výstup | 4 | 0 |
| `packages/sdk/src/index.ts` | 26 | `f69116103d63` | P: zkrácený společný výstup | 8 | 0 |
| `packages/sdk/src/managed.test.ts` | 127 | `48a0c7bb6a2d` | I: strukturální index | 10 | 1 |
| `packages/sdk/src/managed.ts` | 67 | `bf5837209299` | P: zkrácený společný výstup | 2 | 1 |
| `packages/sdk/tsconfig.json` | 17 | `2a61be5707e2` | D: inventář data/config/docs | 0 | 0 |
| `packages/verifier/README.md` | 61 | `59450db21056` | D: inventář data/config/docs | 1 | 0 |
| `packages/verifier/package.json` | 40 | `635327cbed88` | D: inventář data/config/docs | 0 | 0 |
| `packages/verifier/verify-ledger.mjs` | 545 | `496fa127e00d` | I: strukturální index | 8 | 8 |
| `packages/verifier/verify-ledger.test.mjs` | 67 | `494e94af53d3` | I: strukturální index | 9 | 3 |
| `python/nomo-transport/README.md` | 127 | `24bd6bf15b7e` | D: inventář data/config/docs | 1 | 0 |
| `python/nomo-transport/pyproject.toml` | 22 | `dda110047453` | D: inventář data/config/docs | 0 | 0 |
| `python/nomo-transport/src/nomo_transport/__init__.py` | 69 | `3c955e80418f` | R: celé znění | 4 | 0 |
| `python/nomo-transport/src/nomo_transport/canonical.py` | 264 | `760f4711e86b` | R: celé znění | 14 | 0 |
| `python/nomo-transport/src/nomo_transport/client.py` | 733 | `2c1944783d62` | R: celé znění | 17 | 0 |
| `python/nomo-transport/src/nomo_transport/errors.py` | 128 | `9b584a58461f` | R: celé znění | 7 | 0 |
| `python/nomo-transport/tests/__init__.py` | 15 | `8eb10cdc7a7a` | I: strukturální index | 3 | 0 |
| `python/nomo-transport/tests/fixtures/canonical_node.mjs` | 39 | `b0725f646054` | I: strukturální index | 2 | 0 |
| `python/nomo-transport/tests/fixtures/canonical_samples.json` | 15 | `f405d5e4b91b` | D: inventář data/config/docs | 0 | 0 |
| `python/nomo-transport/tests/fixtures/nomo_proxy_http.mjs` | 74 | `03e5cd251505` | I: strukturální index | 3 | 0 |
| `python/nomo-transport/tests/support.py` | 62 | `c60059dedbee` | I: strukturální index | 7 | 0 |
| `python/nomo-transport/tests/support_http.py` | 141 | `07ebe45aaf9e` | I: strukturální index | 10 | 0 |
| `python/nomo-transport/tests/support_proxy.py` | 144 | `86a5cf9ddaad` | I: strukturální index | 11 | 0 |
| `python/nomo-transport/tests/test_canonical.py` | 181 | `9e193497931a` | I: strukturální index | 10 | 22 |
| `python/nomo-transport/tests/test_client.py` | 559 | `1d571a1c6714` | I: strukturální index | 13 | 39 |
| `python/nomo-transport/tests/test_errors.py` | 117 | `9ad9c53937fd` | I: strukturální index | 5 | 12 |
| `python/nomo-transport/tests/test_integration.py` | 202 | `d1fae70e87d3` | I: strukturální index | 9 | 11 |
