# NOMO project guidance

For the GUI upgrade, read `docs/GUI-UPGRADE-PLAN.md` and `docs/GUI-UPGRADE-AUDIT.md` first. These documents describe the requested target and the verified baseline, not completed implementation.

The user requested active use of these installed skills throughout this work:

- `/Users/dawe/.codex/skills/caveman/SKILL.md`: concise Czech communication; preserve complete technical detail in explicitly requested plans and reports.
- `/Users/dawe/.codex/skills/ponytail/SKILL.md`: reuse existing capabilities, avoid unnecessary infrastructure, and never omit requested features, accessibility, validation, or verification.

The intended default for new conversations is the model of the current main session: `opencode/muse-spark-1.3-contributor-free` through OpenCode Zen. No glm model is used anywhere: neither this session nor any subagent spawned from it may route to `z-ai/glm-5.3-flash`, `z-ai/glm-5.3-free` or any other glm spelling. Never put credentials into source, documentation, browser storage, or logs. Existing conversations retain their provider/model snapshot. Never silently fall back to another provider.

The user reaffirmed on 2026-09-13: work directly on `main`, commit and push completed verified changes to GitHub `main` for automatic Vercel deployment. Preserve unrelated files and never commit secrets. Use caveman and ponytail by default for all work. Mobile usability and a stronger ASCII identity are current design priorities.

The user requested on 2026-09-14: all built-in TUI interface text must default to English. The interactive TUI must use its full color theme by default, even when the host inherits NO_COLOR=1. Use NOMO_TUI_COLOR=0 as its explicit monochrome option; keep noninteractive output plain. Preserve user-authored messages and documents in their original language.

Historical note: on 2026-09-18
the user removed Token Harbor and selected OpenCode Zen, which the default
above keeps. Explicit legacy
snapshots still use their saved provider. Credentials never belong in this repo
or command history.

The local Prime Agent recovery MCP is active through a macOS Keychain-backed
launcher. Its only writable filesystem scope is
`~/.local/share/void-prime-dogfood/project`. Use only the configured five-tool
allowlist. Do not regenerate its retained recovery key or expand its scope.
This managed path does not intercept ordinary shell or editor writes.
