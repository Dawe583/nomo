# VOID project guidance

For the GUI upgrade, read `docs/GUI-UPGRADE-PLAN.md` and `docs/GUI-UPGRADE-AUDIT.md` first. These documents describe the requested target and the verified baseline, not completed implementation.

The user requested active use of these installed skills throughout this work:

- `/Users/dawe/.codex/skills/caveman/SKILL.md`: concise Czech communication; preserve complete technical detail in explicitly requested plans and reports.
- `/Users/dawe/.codex/skills/ponytail/SKILL.md`: reuse existing capabilities, avoid unnecessary infrastructure, and never omit requested features, accessibility, validation, or verification.

The intended default for new conversations is OpenCode Zen: provider `opencode-zen`, endpoint `https://opencode.ai/zen/v1`, key only from the `OPENCODE_ZEN_API_KEY` variable or the local opencode auth file via `/connect opencode:zen` (TokenRouter / GLM 5.3 Free is dead; Token Harbor is not used). Never put credentials into source, documentation, browser storage, or logs. Existing conversations retain their provider/model snapshot.

The user reaffirmed on 2026-09-13: work directly on `main`, commit and push completed verified changes to GitHub `main` for automatic Vercel deployment. Preserve unrelated files and never commit secrets. Use caveman and ponytail by default for all work. Mobile usability and a stronger ASCII identity are current design priorities.

The user requested on 2026-09-14: all built-in TUI interface text must default to English. The interactive TUI must use its full color theme by default, even when the host inherits NO_COLOR=1. Use VOID_TUI_COLOR=0 as its explicit monochrome option; keep noninteractive output plain. Preserve user-authored messages and documents in their original language.

On 2026-09-18 the user removed Token Harbor and set OpenCode Zen as the
default provider with the key from `OPENCODE_ZEN_API_KEY` or local opencode
auth, never typed into the repo or history.
