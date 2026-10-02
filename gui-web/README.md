# VOID Workbench, web preview

**This is a prototype, not the product.** It renders mock data and it
is not the interface VOID ships. The product UI is
`apps/control-plane/ui/`, the terminal workbench is `void`, and the
native macOS app is under `apps/apple`.

It is a static, zero dependency sketch of a future desktop shell, kept
here so the interaction model can be reviewed in a browser before any
native work is committed to.

Every number, hash, signature state, latency and status on screen comes
from `fixtures.js`, which is hand written mock data. Nothing in this
directory came from a live session, and nothing in it is evidence about
one. In particular the ledger view walks fixture hash links and checks
no signature, so it never claims a chain is verified.

## Run

```
cd gui-web
python3 -m http.server 4173
```

Open http://localhost:4173/index.html

There is nothing to install and nothing to build, but it is not offline.
The chat view calls whatever provider base URL and key you set yourself
in Providers, the GitHub view calls api.github.com with a personal access
token you paste into the page, and the icon font, the PDF reader and the
DOCX reader are fetched from unpkg and cdnjs. Every other view reads the
fixture file and makes no request.

## Deployment

There is deliberately no Vercel config in this directory. The
`vercel.json` at the repository root is the live production config for
the control plane deployment, and a preview must not be able to change
it. If you ever want this served, point a separate Vercel project at
this directory as its root directory rather than editing the root
config.

## Structure

```
gui-web/
  index.html       shell, black 44px nav, parchment sub nav, sidebar
  icon.svg          aperture mark, the icon the manifest points at
  styles.css       Apple tokens from docs/GUI-RULES.md plus chat layer
  fixtures.js      MOCK session, calls, holds, ledger, registry, policy,
                   providers, models, routing, usage, keys
  app.js           hash router, sidebar, palette, shortcuts, status line,
                   theme init, boot sequence, service worker
  manifest.json  PWA shell (installable, standalone, dark chrome)
  sw.js            offline cache for the app shell, network first rest
  js/api.js        real OpenAI compatible client (streaming, models, test)
  views/           one file per view, registered on window.VOID_VIEWS
    chat.js        agent session: streaming, tool cards, plan mode,
                   slash commands, voice input, attachments
    artifacts.js   right drawer for generated files (preview, copy)
    overview.js    dark hero, stats, class mix, recent calls, hub
    intercept.js   one call through classify, policy, model, ledger preview
    live.js        intercepted call feed with pause and filter
    holds.js       approval queue, compensation plan, SLA timer,
                   focus mode, j/k/a/d keys
    ledger.js      chain browser, full entry schema, focus mode,
                   hash link check over the fixture entries
    registry.js    case explorer with first match evaluator
    policy.js      rules with toggles, approval channel
    providers.js   gateway, direct, local, BYOK keys, real connection
                   test once you set your own key
    models.js      catalog, routing, fallbacks, spend, request log
    replay.js      preview then commit gate, timeline, attestation export
    sessions.js    wrapped agent sessions, transports, posture
    connectors.js  postgres and S3 undo plus snapshot store
    facts.js       declared facts, probe cache, mock probe run
    taint.js       read to write edges plus scope query
    audit.js       period export, frame map, link check, forger table
    cli.js         command builder with copy and exit codes
    github.js      token login, profile, repos, open PRs (real API)
    settings.js    posture, keys, policy source, channels
    shortcuts.js   cheatsheet, press ?
```

## Chat is real, governance is mock

Chat calls your configured provider for real (key in Providers,
stored in this browser only). Attachments work like Claude:
images (JPEG, PNG, GIF, WebP, downscaled), PDF and DOCX (text
extracted locally), any text or code file inlined, anything else
inserted as a filename reference. Max 20 files per chat, 30 MB
per file, 5 MB per image. The GitHub view is real too, once you paste
your own token. Everything else (holds, ledger, replay, audit) is an
interactive local simulation of the VOID write path, labelled mock
wherever it runs. None of it classifies, holds, signs or replays
anything.

## File generation

Every code block has Copy and Download (extension follows the
language: py, js, ts, html, css, json, md, sh, sql and more).
Every assistant reply has Save file (markdown). Whole chats
export to markdown or JSON.

## Shortcuts

Cmd or Ctrl K palette, Cmd or Ctrl N new chat, Cmd or Ctrl 1-4
chat/holds/ledger/replay, Enter send, Shift Enter newline,
Esc stop or close, ? cheatsheet, j/k move, a approve, d refuse.

## Desktop path

This bundle is a plain static site on purpose. A later Tauri or
Electron shell can wrap `gui-web/` without a bundler change.
Native work (tray, global keys, local proxy socket) is not started
here. Nothing in this directory is on the path from an agent to a
tool call: no write is intercepted, no ledger entry is appended, and
no policy is enforced.

## Design

VOID Aperture, exactly like apps/tui-preview: warm near-black paper,
single orange accent, mono labels, serif display, ASCII glyphs,
no gradients, one soft shadow reserved for palette and drawers.
Dark first, light theme fully supported, theme toggle in nav,
system font stacks only.
