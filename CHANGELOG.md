# Changelog

All notable user-facing changes since the first repository commit.

## Unreleased

- Add a live ledger TUI with keyboard inspection and signature checks.
- Refine the GUI with shared Apple-inspired styling, call search and details.
- Bring TUI management closer to Claude Code: fuzzy slash commands, status,
  cost, resume, rewind with auto-selected recoverable operation, control-key
  shortcuts, a real usage status line, and unified diff review.
- Add read-only `void doctor`, `void config`, `void init`, and `void --version`
  commands, each reused by matching TUI slash commands.
- Show the real provider token report in GUI chat, open reviewed branches with
  Arrow Up, and expose class, blast radius, and policy rationale in approvals.
- Consolidate the remaining-work list and clarify release requirements for
  Apple signing and notarization, Linux packaging, production key management,
  physical mobile keyboards, screen readers, and 200% browser zoom.
- Clarify that Node 26 is supported locally, not as the Vercel runtime.

### Security fixes

- Authenticate existing SDK ledger signatures before starting an upstream.

- Prevent agent-provided row counts from satisfying measured-radius policy rules.
- Reject malformed policies without crashing or echoing YAML source.
- Reject hostile browser origins and DNS rebinding against the local control plane.
- Distinguish signature verification from hash integrity in the ledger feed.
- Include the control plane and script suites in the standard workspace check.
- Hold every non-read-only cloud tool call, including built-in managed-document
  writes. The cloud agent previously short-circuited built-in tools to `allow`,
  so an r1 `void_workspace_write` or `void_workspace_delete` ran with no human
  in the loop while the signed journal recorded the agent itself as the
  approver. The cloud recovery sink also passed an unconditional authorize
  callback to the runtime, which forged an `authorized` stage nobody granted.
  Both now fail closed against an explicit allowlist of authorizing surfaces.
- Refuse a branch document snapshot when the server permission mode forbids
  document editing. `POST /api/sessions/:id/branches` with
  `snapshotDocuments: true` performed durable managed-document writes while
  `/api/capabilities` advertised `documentEditing: false`.
- Name the two permission-mode defaults. A local operator surface and the
  remote-facing control plane resolve an absent `VOID_PERMISSION_MODE`
  differently on purpose; both are now named constants with a test instead of
  two unrelated literals that had drifted apart unnoticed.
- Serve the frozen `void.companion.v1` outcome vocabulary from
  `operation.status`, and refuse a stored record carrying any other value.
- Require a per-hold possession token for a cloud approval decision. The hold
  identifier is derived from public session counters, so guessing one was
  enough to decide someone else's hold; the decision now also has to present
  the unguessable token minted with the hold, as the local approval broker
  already required.
- Give the web composer textarea a visible keyboard focus ring. `.composer
  textarea { outline: none }` outranked `:focus-visible`, and the halo painted
  the canvas colour on the canvas colour, so a keyboard user had no visible
  focus indicator at all.
- Return focus to the composer after a run is stopped. Pressing Stop unmounted
  the focused button and dropped focus to the document body.

### Added

- Add the three companion transport operations the release matrix recorded as
  having no server route: `operation.status`, `device.revoke` and
  `diagnostics.read`, plus a minimal device pairing model. Paired devices are
  read-only by default, are scoped to one workspace, and can never see or
  revoke another device. Diagnostics are an allowlisted, redacted projection
  capped at 100 entries; no host path, raw log line or credential shape is
  reachable through it.
- Add a single-endpoint companion envelope adapter so the Apple client can
  round-trip the protocol it was written against, and add `device.pair` to the
  client catalog as a separate request type.
- Add a standard-library Python client for the VOID proxy wire, closing the
  transport-client half of the R12 milestone. It has no third-party
  dependency, refuses a mismatched response identity, an oversized body, an
  unknown shape and a mutating call without an idempotency key, and never
  retries silently. Its canonical JSON is checked byte-for-byte against the
  repository's own `packages/ledger/src/canonical.ts` running under Node.
- Remove the unreachable pairing alert from the iOS companion entry screen. Its
  button is disabled in every state of this build, so the dialog that confirmed
  the same sentence already on screen could never open.
- R03: add file recovery vault retention and collection. The shipped default
  policy is manual, so nothing is collected implicitly; a pinned artifact is
  never evicted and a policy that gives a pinned kind an expiry is refused;
  unreadable evidence refuses the whole run before any delete; and every run
  lands as a signed `vault.retention` journal chain, so a delete is never
  silent. Not certified, and it does not cover the reserved SQLite vault.
- G06: publish a versioned, per-provider machine-readable capability profile
  and require it in the release gate. `void.adapter-capability.v2` states
  `authority: "scope-only"`, names the conformance runtime each provider ran
  against, and refuses unknown fields, a retired `v1` report, and a bare
  `certification: true` presented as evidence. An adapter with no published
  profile is refused, not skipped. Every profile stays `certification: false`.
- R14: add an export bundle that can prove it is complete, and a metrics
  surface. `void.export-bundle.v1` records the ledger, journal, vault manifest
  and capability profile with counts, byte lengths and digests, and writes its
  `complete` manifest last, so a failed export leaves no completeness claim on
  disk. Verification takes an out-of-band anchor and recomputes every declared
  number from the bytes. `void metrics` recomputes 18 closed-label counters
  from the existing ledger, journal and vault, with no new persisted state.
  Neither is an operational certification.
- Move the Windows Credential Manager target name and the accepted blob length
  out of the `cfg(windows)` block and pin them with tests, so a rule that could
  only be exercised on Windows is now exercised on every host. Renaming the
  target turns two of those tests red.
- Add a real appearance preference to the iOS companion: light, dark and
  system, persisted across launches and applied once at the root, with copy in
  English and Czech. Two entry screens that the extra control pushed below the
  fold on a 402-point-wide window are fixed by laying the language and
  appearance controls out in one row when it fits.
- R10: add a shared, fenced server budget ledger. Reserve before dispatch,
  settle on a terminal result, release only on confirmed non-execution, and a
  crash between reserve and settle leaves a durable spend that expiry surfaces
  without refunding, because a crashed process cannot prove it never ran.
  A per-session ledger is refused outright: N workers would each authorise the
  full limit.
- R02: add a production composition root for legacy proxy bindings, with
  explicit operator selection, a refusal on an unknown name, and three bound
  tools, each with a cross-layer fixture.
- Keep a paired device's operation status inside that device. The bound
  envelope path resolved an operation by workspace alone while the internal
  route also checked the owner, so a sibling device could read it.
- Take the collection lock when recording a retention pin, and re-read the
  evidence immediately before each unlink. A pin written during a collection
  was previously never observed, and the artifact and its pin record were both
  deleted by the run meant to respect the pin.
- Refuse retention evidence written inside the artifact root, which is the one
  place a sidecar breaks the reserved vault.
- Say in an export bundle's own capability section that the ledger and journal
  sections are verbatim copies of recorded operations.
- Derive the `signed` flag in a bundle verification and a metrics report
  instead of asserting it, and report basenames rather than absolute host
  paths, so a pasted report does not carry the operator's home directory.
- Add an internal `/gallery` route for the component families that have a real
  consumer, using the existing app and the existing browser harness rather than
  a new UI kit. It replaces the shell before `App` mounts, issues no API
  requests, is absent from the sidebar and the command palette, and is checked
  by the same viewport, focus, reduced-motion, zoom and touch-target gate as
  the rest of the product.
- Add a read budget to the file recovery vault, so a host that will not load a
  large artifact gets a refusal naming the size instead of an allocation it
  cannot satisfy. It defaults to the write quota, so nothing changes by default,
  and the artifact itself is untouched so a host that later raises its budget
  can still read it.
- Give the recovery path an operator mode, so the same control the workbench
  exposes as a permission mode also exists where files actually change.
  `audit` and `plan` refuse dispatch before the policy is consulted, so widening
  a policy cannot widen the mode; `normal` is the unchanged default; and
  `recovery health` reports the effective mode.
- Make a recovery plan prove its own undo order. Adapters may record the read
  set they consulted, it is stored durably in the capture, and a plan whose order
  cannot be proven is refused rather than run. An absent read set is unknown, not
  empty.
- Give a recovery job a durable lease that is reclaimed only when it expired and
  its holder is provably gone, so a worker that dies mid-apply cannot freeze the
  workspace forever and a live one is never displaced.
- Add a disposable end-to-end exercise of the agentic reverse loop against real
  files: a refused call changes nothing, an approved call captures before it
  writes, a reused identity cannot be rebound, the signed journal verifies, a
  restart keeps the history, the confirmed inverse restores exact bytes and
  mode, and a replayed inverse is refused. The same loop runs against a real
  database over PGlite, where a refused row change leaves the row alone and the
  confirmed inverse restores the captured values rather than a reconstruction.
  A third arm drives the loop over real MCP stdio against a spawned
  `void recovery serve`, so the claim covers the transport an agent actually
  uses. All three run in the gate.
- Deduplicate a mutating companion operation by its idempotency key, bound to
  the exact request body, so a retry is distinguishable from a key reused for a
  different body. A replayed pairing is refused with a conflict instead of
  minting a second device, and its one-time credential is never written to disk
  to make a retry cheap. The handshake now lists what it does not enforce.
- Stop letting a pairing caller grant itself `companion:write`. The write scope
  is the host operator's decision now, refused unless the host configured
  `VOID_COMPANION_WRITE_PAIRING=1` and refused rather than quietly downgraded,
  so a client never believes it holds an authority it does not.

- d125b7e9: Restored the product baseline from upstream history.
- 9ef84fe2: Synchronized the product branch with upstream history.
- f40bbead: Improved the interactive telemetry and replay story.
- 976e0bd2: Added the first registry, hold, shadow run, taint, and attestation concepts.
- f120d562: Added the product build plan.
- b02de3b4: Added the workflow execution plan and market plan.
- b2d3e9f1: Added the package scaffold and authoritative context pack.
- 4a157891: Added the terminal interface workstream to the plan.
- e9f55b1f: Added a visual preview for the terminal interface.
- e3093e56: Added the workbench master prompt.
- af093034: Added the terminal render model.
- c074fd5f: Added the Agent Workbench workstream.
- 1107eecb: Added the append only ledger, canonical form, signing, and verification.
- 0d2e0059: Added runtime registry evaluation.
- f7b89d77: Added declared facts loading and precondition validation.
- ec9ad970: Added a complete MCP message inventory for the proxy.
- c6adaeb0: Fixed terminal classification coverage found in review.
- 07970ddd: Added the proxy inventory verification checklist.
- 5d878b52: Added policy loading, decisions, and blocking holds.
- a692f88b: Added the terminal approval channel.
- 1200068b: Changed the proxy interface from draft to frozen contract.
- 523c26f6: Added review helpers, Slack-shaped approvals, and the demo moment.
- 400bdf08: Added the first control plane pages.
- 532354ed: Added the proxy message pipeline.
- bd78892e: Improved terminal watch and approval views.
- f1b11092: Added an adversarial registry migration audit.
- f5e0372c: Improved the root project explanation.
- 75edef91: Expanded the demo moment and terminal preview.
- 02909fa6: Added verified ledger feed support and the feed command.
- 2c3ee6a0: Added SQL parsing support for connector classification.
- b0cff15a: Changed connector and snapshot store contracts from draft to frozen.
- cb5b0626: Changed the proxy to write real ledger entries during interception.
- 6e36fb25: Added replay planning against snapshot manifests.
- b1c28f5e: Added blast radius probes.
- 662cbe62: Added S3 connector capture and restore logic.
- 698e9bc2: Added local and S3-backed snapshot stores.
- b7c1b919: Added Postgres connector capture, inverse, and replay logic.
- 371c4d2c: Added connector round trip proof for restore and drift refusal.
- eb776cf9: Added the local control plane API server.
- c327656e: Added approval broker wiring for held calls.
- 7fd9d6b3: Added taint graph construction from ledger entries.
- 1b9176d7: Added Streamable HTTP upstream transport support.
- 8644f817: Added taint graph querying from the CLI.
- cedff44a: Expanded registry coverage across more agent tool surfaces.
- a6150688: Added signed ledger attestations and standalone verification.

### Changed

- 69fa9a41: Refreshed the dependency set and prompt asset used by the workspace.
- 0ce7cc61: Refreshed the VOID artifact with new interface components and assets.
- 2eeae3f1: Rebuilt the site with a fuller design system, complete pages, and a working backend.
- 9fc95d90: Changed the default site theme to light.
- a2000b64: Restored the site to the original Replit-style visual language.
- 41357f32: Adjusted the site palette toward beige paper and burnt orange.
- 93c19b96: Improved the dark theme and strengthened the warm palette.
- 4ef6f792: Reworked deployment wiring so the live pieces connect correctly.
- 170f7afc: Moved this repository to product-only focus after the site split.
- 86586427: Added classification for the pilot registry entries and the classify command.
- a7e666ec: Changed remaining registry entries to structured guards.
- 59b88a25: Added the runnable proxy binary.
- e84e6657: Changed blast radius handling to prefer measured probe results.
- f9790f24: Added connector lookup and snapshot manifest wiring.
- Lowered the declared Node.js floor from >=26 to >=24 so hosted build platforms that offer Node 24 can build the repo; verified green under Node v24.21.0.

### Fixed

- 32e9d891: Made the repository deployable on Vercel and exposed the API through serverless functions.
- 5b8d7013: Fixed the serverless function build so it emits deployable code.
- 8b097a19: Fixed registry guards that matched too broadly.
- 04e19881: Fixed hold error wording.

### Added since wave 4

- 79d8683: Added the whole-product arc e2e moment.
- 3a482ca: Synced operator docs to the wave 5 surfaces.
- 411d505: Audited the 270 registry entries and pinned the invariants.
- 7041b06: Hardened the wave-5 surface in an adversarial pass.
- 6967fcc: Closed S08 for the control plane with signature aware feeds.

### Fixed since wave 4

- The control plane verify endpoint now reports signed separately from chain
  integrity, and the web UI downgrades to an integrity-only warning when no
  signing key is configured instead of labeling a hash-only view verified.
- The decision endpoint rejects posts that do not carry an application/json
  content type.
- The unknown-tool classification outcome no longer carries assume or tone
  fields.
