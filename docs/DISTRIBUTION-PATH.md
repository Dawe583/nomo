# Historical distribution path for VOID

> Historical analysis written 2026-09-26. Its product recommendations and
> source direction were superseded on 2026-10-08. Keep its checked distribution
> facts as history, not as the NOMO launch plan. Current product authority is in
> the NOMO capability map and MVP spec.

Written 2026-09-26 against commit `63dbd2c` on `main`, read from source, and
checked against the vendors' own live documentation rather than against the
project's planning documents.

**This document answers one question: what is the shortest path from here to a
single person who is not on this machine using VOID, what does it genuinely
cost, and how long does one person actually take.** It is not a restatement of
`docs/VOID-FUTURE-DIRECTION.md` §6 ("Distribution reality"), and where the two
disagree it says so and gives the source.

**Method and its limits.** Every local claim was read from source or observed
with a command on 2026-09-26. Every external claim was fetched from the vendor's
own documentation or API on the same date; URLs are given inline so each can be
re-checked. General web search was unavailable for this session — the same
condition `docs/PREMISE-VERIFICATION.md` recorded — so search-derived
second-hand summaries are absent by construction and a few absences below are
genuine gaps rather than choices. No build, no simulator, and no test suite was
run. No credential, keychain value, or signing private material was read; where
an identity or account was checked, only its existence was checked. One npm
registry credential check was refused by design: the repository `.npmrc` was
inspected by key name only, and it contains two pnpm settings and no auth.

---

## 1. The finding that reorders every other finding

**`github.com/Dawe583/void` does not exist publicly.** `GET
https://api.github.com/repos/Dawe583/void` returns `404`; `GET
https://api.github.com/users/Dawe583` returns `200`. The git remote exists and
points at that URL, so the remote is configured and the repository is not
public.

This is not a new discovery and it is not a surprise to the project. It is
recorded in the project's own release notes. `docs/RELEASE.md:111`, under
"Credential-blocked git push":

> The handoff reports that pushing is blocked by repository credentials. A human
> must restore authorized access, then push the reviewed branch and release tag.
> No push or remote CI result is claimed by this runbook.

Two corroborating facts fall out of it:

- **`README.md` already advertises a download page that cannot exist.**
  `https://dawe583.github.io/void/` returns `404`. GitHub Pages is served from
  the repository, so a private repository cannot have a Pages site. The
  `.github/workflows/pages.yml` "Publish download page" workflow has therefore
  never run, and the README's only outbound link points at nothing.
- **Every CI gate in `.github/workflows/` has never executed against a remote
  commit.** `ci.yml` runs on `push: branches: [main]` and
  `pull_request`. With no push, the "everything is green" state established for
  this research was produced by local runs, not by CI.

This matters more than any signing, provisioning, or store question, because
almost every channel below has a hard dependency on a publicly reachable
repository, and one of them (npm provenance) says so in as many words.

---

## 2. What the CLI and the MCP server actually are today

The claim to test is "VOID's server is one command away from being installable
by a stranger." Reading the source, it is closer than that claim implies and
further than "one command".

**What is real and good.** `docs/MANAGED-RECOVERY.md` is a complete, careful
operator guide: a full config example, a policy YAML example, the eight tools
named, the digest workflow, and an honest failure-handling section. A stranger
can read it and understand the whole product. This is genuinely ahead of most
projects at zero users.

**The eight tools exist and are well made**
(`packages/cli/src/recovery-mcp.ts:162-171`). They already carry the annotations
that matter most for client-side safety — `readOnlyHint`, `destructiveHint`,
`idempotentHint`, `openWorldHint` (`recovery-mcp.ts:188-193`) — and they are
already split into read tools (`void_recovery_plan`,
`void_recovery_status_job`) and write tools (`void_execute`,
`void_recovery_apply`, `void_recovery_apply_job`), which is exactly the split
Anthropic's connector review checklist demands.

**The gap is packaging, and it is four specific things:**

1. **Nothing is publishable.** Every manifest in the workspace is
   `"private": true` — `packages/cli`, `connectors`, `ledger`, `policy`,
   `proxy`, `registry`, `runtime`, `sdk`, `workbench`, `apps/control-plane`,
   and the root. This is deliberate and enforced: `scripts/src/release-packaging.test.mjs:23`
   asserts `data.private === true` for every one of them. Making a package
   publishable is therefore a *deliberate change to a tested invariant*, not a
   flag someone forgot. That is good engineering and it is still a blocker.
2. **The `bin` is on the wrong package.** `package.json:39-42` declares
   `void` and `void-proxy` pointing at `packages/cli/bin/void.mjs` and
   `packages/proxy/bin/void-proxy.mjs` — on the *root workspace* package, which
   is private. `packages/cli/package.json` has no `bin` at all, and its
   `exports` points at `"./src/index.ts"`, raw TypeScript.
3. **The bin crosses package boundaries at runtime.**
   `packages/cli/bin/void.mjs:6-22` imports `../src/recovery.ts`,
   `../src/agent.ts`, `../src/index.ts` and more, and those in turn import
   `@void/registry`, which is declared as `"workspace:*"`. npm cannot resolve
   `workspace:*`. Either all nine packages get published with `workspace:*`
   rewritten to real versions, or the CLI is bundled. `rollup` is already a root
   dependency, so bundling is the cheaper of the two and produces one artifact
   with no version skew.
4. **There is no zero-config entry point.** `void recovery serve` requires
   `--config` as an explicit path (`packages/cli/src/recovery.ts:96`, read with a
   non-null assertion, so it is mandatory), and the config it reads must supply
   `workspace`, an `agentId` matching `^[\w-]{1,120}$`, a `stateDir`, an
   `encryptionKeyEnv`, a `policyPath`, and **exactly one** of
   `postgres` / `filesystem` / `git` (`recovery.ts:99-103`). The key is a
   stable random 32-byte base64 value the operator must retain across restarts.
   `void init` does not help here: `packages/cli/src/init.ts:1-5` states it
   "Creates the local encrypted storage layout and nothing else". Nothing writes
   a recovery config for the user.

So the honest answer to the question in the brief is: **the server is not one
command away, but it is about one working day away, and the missing work is
packaging and a bootstrap command rather than capability.** Four of the five
steps below are mechanical.

---

## 3. Every channel, with what it really costs

Money column: what a single maintainer must spend that they have not agreed to
spend. "Free" means no spend beyond an account that can be created at $0.

| Channel | What it assumes | Money | Realistic time, one maintainer in sessions | Review queue | Would it get VOID a user? |
|---|---|---|---|---|---|
| **Make the repo public** | Nothing but a decision. Credentials restored. | $0 | 1 session incl. a secret scan of full history | No | Prerequisite for six of the rows below. Not a channel. |
| **npm, unscoped/scoped** | Public repo; a `bin`; bundle or publish chain; a version policy | $0 | 3–4 sessions | No | Yes. The install funnel. |
| **Official MCP Registry** | The npm package, `mcpName` in its `package.json`, a `server.json`, a public `repository.url` | $0 | +1 session after npm | No human review (see §4) | Yes, and it is where aggregators scrape from. |
| **GitHub Releases** | Public repo; something to release | $0 | 1 session | No | Weak alone; good as the artifact the registry and the post point at. |
| **`claude mcp add` one-liner in a README** | The npm package | $0 | Included above | No | **The actual mechanism by which most users will install.** |
| **Personal Homebrew tap** | Public repo named `homebrew-*`; a cask or formula | $0 | 1–2 sessions | No | Marginal. Friction removal for people already using brew. |
| **Homebrew/homebrew-cask** | *Notarized* app; passes Homebrew's Gatekeeper checks | **$99/yr** (Developer ID) | Weeks of `codesign` triage before the PR is even possible | PR review | Friction removal, not discovery. |
| **Direct notarized DMG** | Developer ID, hardened runtime, nested signing, `notarytool` | **$99/yr** | Same weeks, plus the first upload | Apple notary, no queue | Yes, if there is a download link and a reason to click it. |
| **MCPB bundle (Claude Desktop)** | A `.mcpb` zip: `manifest.json` + server, bundled Node | $0 | 2–3 sessions | No | Yes for Claude Desktop users. Narrow host. |
| **Claude Code plugin marketplace** | A git repo with `.claude-plugin/marketplace.json`. **May be private.** | $0 | 1–2 sessions | No | Only reaches people you hand the URL to. |
| **Anthropic's directory (plugin bundle)** | Public GitHub repo, a paid claude.ai plan | Paid Claude plan (Pro/Max) | 2–3 sessions to package | **Yes — a person reviews every new listing** | Real reach inside Claude. Not a first-user channel. |
| **Anthropic's directory (MCP connector)** | A *hosted remote* MCP server URL with OAuth | Hosting (free tier possible) | Much more than 3–4 sessions: it is a different product | Automated scan by default; escalates to human Verified review | Wrong shape for VOID today. See §7. |
| **Smithery** | Now part of Arcade.dev. Either a hosted streamable-HTTP URL, or an `.mcpb` bundle | $0 | 2–3 sessions for the MCPB route | Automated scan | Secondary discovery. Third-party dependency on an acquired company. |
| **TestFlight** | A paid Apple team, a real device, provisioning, a build that satisfies App Review | **$99/yr** | Weeks, plus a device that is offline | Beta App Review on first build; no published SLA | No, for a thin companion. |
| **Mac App Store** | Sandboxing the product's core function | **$99/yr** | Not a timeline question. See §5. | Full App Review | **No.** |
| **winget** | A Windows artefact, a manifest PR to `microsoft/winget-pkgs` | $0 | Blocked on the Windows surface, which is source-only | "Automatically validated and may also be reviewed manually" | No, today. The Windows app does not exist. |
| **Microsoft Store** | A packaged Windows app, a Partner Center account | $0–$19/yr (region-dependent; not verified here) | Blocked on the same | Yes | No, today. |
| **Container image on GHCR** | A real image. GitHub Packages usage is **free for public packages**. | $0 | 1 session | No | No. Wrong shape — VOID is local-first. |
| **Show HN** | Something worth reading | $0 | 1 session to write, then a lottery | No | **The shortest path to a first stranger.** |
| **Conference talk** | A story and 3–9 months | Varies | 3–9 months | CFP review | No. |

### Sources for the table

- **Apple Developer Program, 99 USD/year, with a waiver.**
  <https://developer.apple.com/programs/enroll/>: "The Apple Developer Program is
  99 USD per membership year… If you're a nonprofit organization, accredited
  educational institution, or government entity and meet certain requirements,
  you can request a fee waiver."
- **GitHub Actions is free for public repositories.**
  `github/docs`, `content/billing/concepts/product-billing/github-actions.md`:
  "GitHub Actions usage is **free** for **self-hosted runners** and for
  **public repositories** that use standard GitHub-hosted runners."
- **GitHub Packages is free for public packages.**
  `content/billing/concepts/product-billing/github-packages.md`: "GitHub
  Packages usage is **free** for **public packages**. In addition, data
  transferred in from any source is free."
- **npm provenance requires a public repository.**
  <https://docs.npmjs.com/generating-provenance-statements>: "Ensure your
  package.json is configured with a public repository that matches
  (case-sensitive) where you are publishing with provenance from", and "you must
  use a supported cloud CI/CD provider using a cloud-hosted runner", and with
  trusted publishing "provenance attestations are automatically generated for
  your packages without requiring the --provenance flag".
- **Scoped packages publish free.** <https://docs.npmjs.com/creating-and-publishing-scoped-public-packages>:
  "By default, scoped packages are published with private visibility. To publish
  a scoped package with public visibility, use `npm publish --access public`."
- **Homebrew's actual bar.** <https://docs.brew.sh/Acceptable-Casks>: "On
  macOS, apps, installers and other executable artefacts that Gatekeeper can
  assess must pass Homebrew's Gatekeeper checks and must not require System
  Integrity Protection or Gatekeeper to be disabled or bypassed." A personal tap
  is explicitly a first-class path — <https://docs.brew.sh/How-to-Create-and-Maintain-a-Tap>
  documents `brew tap-new $YOUR_GITHUB_USERNAME/homebrew-tap`.
- **TestFlight limits.** <https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/>:
  "up to 10,000 people" external, "up to 100 App Store Connect users"
  internal, "Your build becomes unavailable for testers after 90 days", and
  "When you add the first build of your app to a group, the build gets sent to
  App Review".
- **winget.** <https://learn.microsoft.com/en-us/windows/package-manager/>:
  "ISVs can upload package manifests to have their software packages considered
  for inclusion in the default winget source. Manifests and the packages they
  reference are automatically validated and may also be reviewed manually."
- **Smithery is now part of Arcade.dev.** The banner on
  <https://smithery.ai/docs>: "Smithery is now a part of Arcade.dev!" Its
  publish page (<https://smithery.ai/docs/build/publish>) offers exactly two
  routes: a hosted **streamable HTTP** URL, or a local **MCPB** bundle.
- **The install mechanism is a one-liner.**
  <https://docs.claude.com/en/docs/claude-code/mcp>: "claude mcp add
  --transport stdio myserver -- npx server → runs npx server".
- **MCPB is a one-click local install.**
  <https://claude.com/docs/connectors/building/mcpb>: "An MCP Bundle (`.mcpb`)
  is a zip archive containing a local MCP server and a `manifest.json`, which
  Claude Desktop installs in a single click"; Node "is included with Claude
  Desktop on macOS and Windows, so users need no separate runtime".

### On `npm i -g void`

`docs/VOID-FUTURE-DIRECTION.md` §6 ranks "`npm i -g void` + GitHub Releases" as
path #1. **The name is taken.** `registry.npmjs.org/void` returns a live
package — `void@0.20.3`, repository `github.com/voidzero-dev/void`, maintainers
`yyx990803` and `cpojer`, last modified 2026-09-24. `void-cli` is also taken
(HTTP 200). Checked free at the time of writing: `void-mcp`, `voidrecovery`,
`void-ledger`, and the `@void` scope entirely (`@void/cli` → 404). This is a
five-minute decision, not a blocker, but the plan's headline command cannot be
the plan's headline command.

---

## 4. The MCP registry, in detail

This is the channel that deserves the attention, and the live service answers
today.

### What it is, verified against the live API

`https://registry.modelcontextprotocol.io/v0.1/servers?limit=3` returns real
servers with real metadata. A search for `void` returns five unrelated servers
(`bible.void/reader`, `io.github.VoidNullable/lific`, and three others) — so
the name is contested but `io.github.Dawe583/...` is free. The service is in
**preview**: every document in the registry repository opens with "The MCP
Registry is currently in preview. Breaking changes or data resets may occur
before general availability."

### What publishing actually requires

From `modelcontextprotocol/registry`, `docs/modelcontextprotocol-io/quickstart.mdx`
and `docs/reference/server-json/official-registry-requirements.md`:

1. **A namespace you can prove you own.** With GitHub device-flow auth
   (`mcp-publisher login github`), the server name must start with
   `io.github.<your-username>/`. DNS auth exists for custom domains
   (`docs/modelcontextprotocol-io/authentication.mdx`). Free, no money.
2. **The npm package published first.** "The MCP Registry only hosts metadata,
   not artifacts, so we must publish the package to npm before publishing the
   server."
3. **`mcpName` in that package's `package.json`, matching `server.json`'s
   `name` exactly.** This is the ownership check — "The MCP Registry verifies
   ownership of npm packages by checking `mcpName` in `package.json`. The
   `mcpName` property **MUST** match the server name from `server.json`."
4. **A `server.json`** with `$schema`, `name`, `description`, `version`,
   `repository` (`url` + `source: "github"`), and a `packages[]` entry with
   `registryType: "npm"`, `identifier`, `version`, and
   `transport: { "type": "stdio" }`. Monorepos use `repository.subfolder` — which
   is exactly VOID's shape.
5. **A supported package registry.** "NPM: `https://registry.npmjs.org` only."
   Also PyPI, NuGet, Cargo, and OCI images from Docker Hub / `ghcr.io` / Quay /
   Google / Azure / MCR, plus MCPB from GitHub and GitLab releases.
6. **`mcp-publisher`.** `brew install mcp-publisher`, or a prebuilt binary
   tarball. Then `init`, `validate`, `publish`.

**Money: $0. Human review: none on the critical path. Wall clock on the
registry's side: a device-code login and an API call.**

### The review question, answered honestly

The moderation policy (`docs/modelcontextprotocol-io/moderation-policy.mdx`) is
explicitly permissive: "We only remove illegal content, malware, spam, and
completely broken servers." What it *will* remove includes "hacking tools" as a
category of illegal content. VOID is a governed-write-path and recovery server,
not a hacking tool, so this is a description-writing discipline rather than a
risk — but a listing whose description reads like an offensive toolkit would be
a legitimate moderation target, and that is worth knowing before writing the
first sentence of the listing.

What the registry will *not* remove is worth reading twice, because it is the
honest characterisation of this ecosystem: "we won't remove: … Servers with
security vulnerabilities." A registry that does not act on a vulnerable server
is a reason to keep publishing, not a reason to trust.

### Why the registry is the shortest path and not just another row

Three properties, all verified:

- **The registry is the substrate aggregators scrape.** From
  `docs/modelcontextprotocol-io/registry-aggregators.mdx`: aggregators consume
  an unauthenticated read-only REST API, "are expected to scrape data on a
  regular but infrequent basis (e.g., once per hour)", and the registry
  "**does not provide uptime or data durability guarantees**". One publish
  therefore reaches Smithery-class discovery without a second submission.
- **The `repository` field is a dead link if the repo is private.** I could not
  determine whether the registry verifies public reachability of
  `repository.url` — nothing in the requirements document says it does. But a
  private repository makes the field useless to every human who reads the
  listing, and npm provenance (a different channel, same repo) explicitly
  requires public. Treat public as required.
- **It composes with the channel people actually use.** `claude mcp add
  --transport stdio void -- npx -y <pkg>` is the install command. The registry
  is how a stranger finds out that command exists.

### What it will not do for VOID

It will not make anyone install. The registry is a catalogue, not a funnel. Its
contribution is that the catalogue entry is permanent, machine-readable, and
scraped — which means the *second* wave of users finds VOID without VOID doing
anything. The *first* user still comes from a person writing a post.

---

## 5. The Mac App Store: the plans are right and the reason is wrong

`docs/VOID-FUTURE-DIRECTION.md` §6 says the Mac App Store is "structurally
disqualifying: guidelines 2.4.5(ii)–(iv) and 2.5.2 describe the exact negation
of a tool that manages files outside its container and spawns child processes."
It should not attempt it.

**The guideline quotes are accurate.** I read them verbatim from
<https://developer.apple.com/app-store/review/guidelines/>:

> **2.4.5** Apps distributed via the Mac App Store have some additional
> requirements to keep in mind:
> (i) They must be appropriately sandboxed, and follow macOS File System
> Documentation. […]
> (ii) They must be packaged and submitted using technologies provided in
> Xcode; no third-party installers allowed. They must also be self-contained,
> single app installation bundles and cannot install code or resources in shared
> locations.
> (iii) They may not auto-launch or have other code run automatically at startup
> or login without consent nor spawn processes that continue to run without
> consent after a user has quit the app. […]
> (iv) They may not download or install standalone apps, kexts, additional code,
> or resources to add functionality or significantly change the app from what we
> see during the review process.
> […] (vii) They must use the Mac App Store to distribute updates; other update
> mechanisms are not allowed.

> **2.5.2** Apps should be self-contained in their bundles, and may not read or
> write data outside the designated container area, nor may they download,
> install, or execute code which introduces or changes features or functionality
> of the app, including other apps.

**But the reasoning is wrong in three specific ways, and two of them would have
kept a whole track closed for the wrong reason.**

1. **"Spawns child processes" is not a violation.** 2.4.5(iii) forbids
   processes that *continue to run* after the user quits. It does not forbid
   spawning. Apple documents embedding a command-line helper in a sandboxed Mac
   App Store app as a first-class technique —
   <https://developer.apple.com/documentation/xcode/embedding-a-helper-tool-in-a-sandboxed-app>
   walks through creating a Command Line Tool target, embedding it with Code
   Sign On Copy, and exporting to App Store Connect. VOID bundles a Node runtime
   and a sidecar CLI. That is the documented shape, not the forbidden one.
2. **"Manages files outside its container" is not a violation either, as long
   as the user chooses the locations.** From
   <https://developer.apple.com/documentation/security/accessing-files-from-the-macos-app-sandbox>:
   "When the URL your app receives from a standard user interface interaction
   represents a folder, the operating system extends your app's sandbox to items
   within that folder, and recursively in nested folders." The
   `com.apple.security.files.user-selected.read-write` entitlement exists for
   exactly this, and `com.apple.security.files.user-selected.executable` exists
   for running programs in user-selected locations. The same document says:
   "Certain app workflows, like an app for backing up your Mac, require access
   to files wherever they reside on a file system. Your app can't automatically
   gain full disk access through an entitlement or with code: the person using
   your app must choose to grant access in System Settings." A governed
   write-path tool that a user points at a project directory is squarely inside
   what Apple permits.
3. **The "Privileged File Operations" entitlement is a real, named thing, not a
   rumour** — the guidelines' own introduction says "we offer entitlements for
   CarPlay Audio, HyperVisisor, and Privileged File Operations." The direction
   document is right that it has no public documentation page. I could not find
   one either, and I am not going to guess at its terms.

**So why is the verdict still no?** Because the disqualifier is 2.4.5(i), not
2.4.5(ii)–(iv), and 2.4.5(vii):

- **2.4.5(i) requires the app to be sandboxed.** VOID's function is to govern
  writes by *another process* — the agent, which is a different app with its
  own sandbox. A sandboxed VOID can only see what it has personally been
  granted. It cannot observe an agent writing to `~/.gitconfig`, to a package
  manager's cache, or to any path the user never picked in a panel. The
  governed write path is the product; the sandbox is defined by what the user
  happened to select. Under a full-disk user grant the app is far more capable,
  but a review that hinges on a user manually granting FDA in System Settings is
  a review that will be argued, and a tool whose *purpose* is to be trustworthy
  is the worst possible candidate for "we could not reproduce the described
  behaviour".
- **2.4.5(vii) forbids Sparkle.** The auto-update path the project wants is
  closed. Not fatal, but it removes the cheapest trust mechanism available for
  a desktop tool.
- **2.4.5(iv) forbids downloading code that changes functionality.** A tool that
  will happily update its own sidecar cannot ship that way.

**The corrected statement is: the Mac App Store is not disqualifying because
VOID spawns processes or touches files outside the container — both are
sanctioned. It is disqualifying because 2.4.5(i) requires the product's central
guarantee to be scoped to what a user selected in a panel, and because a tool
whose pitch is provable integrity is a poor candidate for a review that cannot
reproduce its central claim.** The conclusion survives. The stated reason would
not have survived contact with an informed reviewer, and a wrong *never* here
would have kept a distribution track closed on a false premise.

---

## 6. What one person can actually finish

The user works on this in sessions alongside a paid job. The unit that matters
is therefore a **focused session of two to four hours**, not a week. Estimates
below are in sessions, with wall-clock in parentheses at a realistic three
sessions a week. They are deliberately conservative; the work is packaging, and
packaging is where estimates go wrong in the optimistic direction.

### Tier 1 — completable, and each one unblocks a user

| # | Work | Sessions | Unblocks a user? |
|---|---|---|---|
| 1 | Restore push credentials; make the repo public; run a secret scan over **full history** (329 commits, five identities) before it is public | 1 | **Yes — it is the gate on six channels** |
| 2 | Add a `bin` to a publishable CLI package; bundle with the rollup already in the tree so there is no nine-package publish chain; drop the `private: true` assertion for that one package in `release-packaging.test.mjs` **deliberately**, with a test that the built artifact runs | 2 | Yes |
| 3 | `mcpName` in the manifest; `server.json`; `npm publish --access public`; a CI publish workflow with npm trusted publishing (provenance automatic, no long-lived token) | 1.5 | **Yes — this is the install funnel** |
| 4 | `mcp-publisher login github`; `init`; `validate`; `publish`. Add `title` to all eight tool definitions while you are there — Anthropic's checklist requires it and clients use it | 0.5 | Yes |
| 5 | A bootstrap command: `void init --mcp` that writes a working `config.json` (workspace, generated `agentId`, `stateDir`, `encryptionKeyEnv`, generated key, a starter `policy.yml`) so the README's install is two commands | 2 | **Yes — this is the difference between a demo and a product** |
| 6 | A README that leads with the ledger, a Show HN post, a GitHub Release carrying a sample signed ledger | 1 | Yes |

Total: **about 8 sessions, roughly 2.5–3 weeks** at three sessions a week.
Steps 1–4 are the shortest honest path to *installable*; step 5 is the shortest
honest path to *usable by someone who is not you*.

### Tier 2 — completable, but each one is progress, not a user

- **MCPB bundle for Claude Desktop** (2–3 sessions). Real reach, narrow host,
  and Claude Desktop already ships the Node runtime VOID would otherwise demand.
- **A public GitHub repo holding just the CLI + MCP server + verifier**, separate
  from the Apple apps. This is a variant of step 1, not extra work, and it is
  the right move if the full history is not publishable.
- **Claude Code plugin marketplace** (1–2 sessions). May be private. Only
  reaches people you send the URL to.
- **A public SBOM, a published threat model, a documented signing-key rotation
  policy, and a static landing page.** Cheap, and for a tool whose claim is
  verifiable integrity these are the artefacts a security reviewer actually
  looks at first.

### Tier 3 — not completable by one person in a session budget, and should not
be attempted now

- Notarized DMG and the Homebrew cask. $99/year, which the user has said is not
  acceptable, plus days of nested `codesign` triage across a Tauri bundle that
  embeds a Node runtime and a sidecar (each executable needs its own signature
  and its own hardened-runtime entitlements; V8 needs `allow-jit` on its own
  signature). This is the real cost, and the sibling documents are right about
  it.
- TestFlight. $99/year, a physical device, a beta review with no published SLA.
- Anything Windows. The surface is source-inspected only; there is no runner and
  no current evidence. This is a genuine blocker, correctly identified.
- Mac App Store. §5.
- An Anthropic-directory *MCP connector* listing. It requires a hosted remote
  MCP server with OAuth — a different product from a local, key-holding, stdio
  server whose entire value is that it touches the user's own files. Hosting it
  would remove the reason to use it.

### What looks like progress but unblocks nobody

- More surface area. A ninth platform, another connector, another screen. Every
  hour here is an hour not spent on step 1, and step 1 is worth more than all
  of them combined.
- Another internal audit. The tree is green and audited. `pnpm test` is 1527
  tests; the marginal audit finding has a much lower expected value than a
  public URL.
- A specification proposal to an IETF working group. Genuinely valuable, and
  genuinely a multi-month relationship with a multi-month clock. It is not step
  1.
- A polished launch video for a product with zero users.

---

## 7. Recommendation

**Ship the MCP server to npm and the official MCP registry, and post it.**

Concretely: restore push credentials and make the repository public after a
full-history secret scan; add a real `bin` to a publishable CLI package and
bundle it with the rollup already in the tree so there is one artifact and no
nine-package version chain; publish it to npm under a name that is actually
free (`@void/cli`, `void-mcp`, or `voidrecovery` — `void` and `void-cli` are
taken); add `mcpName` and a `server.json` with `repository.subfolder` set for
the monorepo; publish to `registry.modelcontextprotocol.io` under
`io.github.Dawe583/`, which costs nothing and involves no human; add `title` to
the eight tool definitions; add a `void init --mcp` that writes a working config
and a starter policy so the install is two commands instead of a hand-authored
JSON file; then write the Show HN post, whose artefact is the thing the ledger
is for — publish a signed ledger bundle and let readers verify it and try to
break the guarantee, because a competitor with a nicer UI cannot fake that. The
whole thing is about eight focused sessions, roughly two and a half to three
weeks of evenings, and the first real user is the post, not the registry — the
registry is what makes the *second* and *third* user find VOID without anyone
doing anything.

**Prerequisites genuinely required:** push credentials; a decision to make the
repo public; a clean full-history secret scan; an npm account; a decision on the
package name; and permission to relax one asserted test invariant
(`release-packaging.test.mjs:23`) on purpose.

**Prerequisites that are *not* required, contrary to what the plans imply:** the
Apple Developer Program, a Developer ID, notarisation, a Mac App Store account, a
paid Apple team, a physical iPhone, App Store Connect access, TestFlight, a
clean test Mac, a support/legal/privacy owner, a provider sandbox with a bounded
cost, local-network scope sign-off, and design-direction approval. None of them
sit on this path. The `docs/RELEASE-1.0.1-MATRIX.md` "Blocking inputs" list is
an accurate inventory of what blocks *an Apple release*. It is not an inventory
of what blocks *a user*, and reading it as the latter is the single largest
planning error in the project: it puts a nine-item Apple checklist in front of a
decision that does not need any of the nine.

**What I would not claim.** That eight sessions produces a *popular* tool. The
honest expectation for a well-written, technically-credible Show HN post from an
unknown account with no prior following is a few dozen upvotes, a handful of
substantive comments, and somewhere between zero and a handful of installs in the
first month. The goal of this path is not traction. It is that the next person
who hears about VOID finds a URL, an install command, and something they can
verify — instead of a README pointing at a 404.

---

## 8. Two alternatives, with their costs

**Alternative A — the hosted web app, which is more provisioned than anyone
realises.** A Vercel project named `void-tui` is already linked
(`.vercel/project.json`, `projectId prj_zri74ziz7CjG3zWlvhMvCqxm3SHB`,
`orgId team_GLVZEvWLcDk83n7rHy8QsjGB`), `vercel.json` is complete with a build
command, a strict CSP, no-store on HTML and immutable caching on assets, and
fifteen rewrites (twelve SPA routes plus three legacy `.html` aliases), and a
local nitro build output exists at
`.vercel/output/`. So the account and the configuration are done. Cost: $0 on a
Hobby-tier deployment. Time: one session to deploy, plus an honest check of
whether the hosted build retains a real write path, which I did **not** verify
and which depends on where the journal and signing keys live in a serverless
function — the documentation consistently describes the ledger as local. If the
answer is that the hosted surface is read-only over a local database, this
becomes a demo rather than a product, and that is one session to find out.
Strength: it gives a stranger something to click with no install at all.
Weakness: it is the surface most likely to need the provider sandbox and
local-network scope that the blocker list names, and it is the least defensible
thing in the repository to lead with, because the ledger's whole argument is
about a local principal holding a local key.

**Alternative B — the notarized DMG, done properly, once $99 is on the table.**
Cost: $99/year, plus the nested code-signing triage the sibling documents
describe and I agree with: a Tauri bundle embedding a Node runtime and a sidecar
is *N* signing identities, Hardened Runtime disallows JIT by default so V8 needs
`allow-jit` on its own signature, "you add entitlements only to executables", and
one notarization failure is likely. Time: a few days of debugging plus the
review queue Apple applies to a first submission. What it buys: Sparkle
auto-update, Homebrew cask eligibility, and a download link that does not warn
"Apple cannot check this app for malicious software" — which for a tool whose
pitch is integrity is a brand problem, not a compliance one. This is the right
sequence *after* a user exists, because the cost is fixed and the payoff scales
with demand that does not yet exist. It is the wrong first move at zero users
and with a stated refusal to spend the $99.

---

## 9. Treated as blocked; not blocked

| Item | Where it is called a blocker | What is actually true |
|---|---|---|
| **A public repository** | Implicit everywhere; `docs/RELEASE.md:111` records "Credential-blocked git push" | The single hardest prerequisite for six of the channels, and it is a credentials restore plus a visibility decision. Not on any feature list. It gates npm provenance, GitHub Releases, both package registries, the Anthropic directory plugin route, and the README's own download link. |
| **A downloadable artefact at all** | `README.md` links `https://dawe583.github.io/void/` | A static landing page plus a GitHub Release needs no signing, no Apple, and no review. The Pages workflow already exists. |
| **A publishable CLI** | `release-packaging.test.mjs:23` asserts `private: true` | Deliberate and enforced — but `rollup` is already a root dependency, so a bundled single-package CLI is roughly two sessions, not a project. |
| **MCP tool review-readiness** | Not on any list | All eight tools already carry `readOnlyHint`/`destructiveHint` and are already split read/write. Only the `title` field that Anthropic's checklist requires is missing. Under an hour. |
| **A stranger-facing quickstart** | `docs/MANAGED-RECOVERY.md` is complete but assumes a cloned repo | The guide is genuinely good. What it assumes is `node packages/cli/bin/void.mjs`, which requires a clone and a `pnpm install`. One bootstrap command removes that. |
| **Hosted web deployment** | "bounded-cost provider sandbox" and "local-network scope" listed as blocking inputs | The Vercel project exists and is linked, and the config is complete. What is unknown is whether the hosted build has a write path — one session to determine, and that is a finding, not a blocker. |
| **CI as a distribution mechanism** | "No push or remote CI result is claimed by this runbook" | Correct today, and free the moment the repo is public: GitHub Actions is free for public repositories, and GitHub Packages is free for public packages. |
| **A `server.json` and an MCP listing** | `docs/RELEASE.md:115-118` lists "MCP registry listing" as missing WP-15 evidence | The registry is live, in preview, costs nothing, and has no human on the critical path. It is one `mcp-publisher publish` away and depends only on the npm step above it. |

---

## 10. Where the current plans are wrong

1. **The Mac App Store reasoning is wrong** even though the verdict is right.
   §5 above. "Spawns child processes" and "manages files outside its container"
   are both explicitly sanctioned by Apple's own documentation. The real
   disqualifier is 2.4.5(i)'s sandbox requirement and 2.4.5(vii)'s ban on
   non-store updates. Anyone who restates the old reason to a reviewer will be
   corrected, and the correction will be used to reopen the question.
2. **`npm i -g void` cannot be the headline.** The name belongs to
   `voidzero-dev/void`, maintained and published two days ago. `void-cli` is
   also taken. This is a five-minute rename, but the plan's first-ranked path is
   not executable as written.
3. **The blocker list conflates "blocks an Apple release" with "blocks a
   user."** Nine named blocking inputs, none of which sit on the shortest path
   to a first real user. This is the most expensive error in the planning
   documents because it is the one that makes the project look further from
   users than it is.
4. **The blocker list omits the one item that is actually on the critical
   path** — a public repository — while listing ten that are not. `docs/RELEASE.md`
   does record it, as a credentials problem rather than a distribution
   problem, which is why it never made the distribution list.
5. **Smithery is presented as a stable third-party channel.** It has been
   absorbed into Arcade.dev, and one of its two publish routes now requires a
   hosted HTTP server with OAuth. Its remaining route for a local stdio server
   depends on the MCPB format, which is fine — but this is a vendor that changed
   hands, and the plan does not reflect it.
6. **One number in the sibling pair survives but should be read as stated.** The
   direction document's claim that `void recovery serve` answers
   `protocolVersion: "2024-11-05"` is refuted by `PREMISE-VERIFICATION.md` and by
   the source: `packages/cli/src/recovery-mcp.ts:298-300` constructs a plain
   `new Server(...)` and the version is chosen by the pinned SDK. I did not
   re-run the harness that established this, so I record it as the sibling's
   finding, not as mine. It does not affect any recommendation here: the MCP
   registry's `server.json` does not require a protocol version, and every
   mainstream host either negotiates or falls back.

---

## 11. What I could not determine

- **Whether the MCP registry verifies that `repository.url` is publicly
  reachable.** The requirements document does not say. I have assumed public is
  required, on the grounds that a dead link helps nobody and that npm provenance
  requires it outright.
- **Whether the hosted Vercel build has a real write path.** The project is
  linked and the config is complete, but whether the journal and signing keys
  are available to a serverless function is the kind of question that takes an
  hour of running to answer, and I was instructed not to deploy.
- **Whether the full git history is safe to make public.** 329 commits and five
  commit identities. The tracked tree is clean of `.env` files, but a history
  scan is a different question and it has a real failure mode — which is why it
  is step 1 rather than a footnote.
- **The Microsoft Store developer account fee.** I could not load the current
  Partner Center account-pricing page. The row in §3 is marked unverified rather
  than guessed.
- **Whether the user has an npm account.** The repository `.npmrc` contains two
  pnpm settings and no npm auth token, which says nothing about whether an
  account exists elsewhere. I did not read any credential to find out.
- **What the eight tools' `title` values should be.** I confirmed they are
  absent. What they should say is a product decision, not a research finding.

## Appendix — primary sources read on 2026-09-26

modelcontextprotocol/registry: `docs/modelcontextprotocol-io/quickstart.mdx`,
`package-types.mdx`, `moderation-policy.mdx`, `registry-aggregators.mdx`,
`docs/reference/server-json/official-registry-requirements.md`; live API
`registry.modelcontextprotocol.io/v0.1/servers`. Apple:
`developer.apple.com/app-store/review/guidelines/`,
`/app-store/review/` §2.4.5 and §2.5.2, `/programs/enroll/`,
`/help/app-store-connect/test-a-beta-version/testflight-overview/`,
`/documentation/security/accessing-files-from-the-macos-app-sandbox`,
`/documentation/xcode/embedding-a-helper-tool-in-a-sandboxed-app`.
Anthropic: `claude.com/docs/directory/publish`,
`claude.com/docs/connectors/building/review-criteria`,
`claude.com/docs/connectors/building/mcpb`,
`code.claude.com/docs/en/plugins/publish`,
`code.claude.com/docs/en/plugin-marketplaces`,
`docs.claude.com/en/docs/claude-code/mcp`. Homebrew: `docs.brew.sh/Acceptable-Casks`,
`/How-to-Create-and-Maintain-a-Tap`. npm: `docs.npmjs.com/generating-provenance-statements`,
`/creating-and-publishing-scoped-public-packages`; `registry.npmjs.org` name
availability probes. GitHub: `github/docs` billing documents for Actions and
Packages. Microsoft: `learn.microsoft.com/en-us/windows/package-manager/`.
Smithery: `smithery.ai/docs`, `/docs/build/publish`. Local: `package.json`,
`packages/*/package.json`, `apps/control-plane/package.json`, `vercel.json`,
`.vercel/project.json`, `Dockerfile`, `.github/workflows/{ci,pages}.yml`,
`README.md`, `docs/{RELEASE,MANAGED-RECOVERY,MANAGED-FILESYSTEM,RELEASE-1.0.1-MATRIX}.md`,
`scripts/src/release-packaging.test.mjs`,
`packages/cli/bin/void.mjs`, `packages/cli/src/{recovery,recovery-mcp,init}.ts`.
