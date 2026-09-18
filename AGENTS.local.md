# VOID project guidance

For the GUI upgrade, read `docs/GUI-UPGRADE-PLAN.md` and `docs/GUI-UPGRADE-AUDIT.md` first. These documents describe the requested target and the verified baseline, not completed implementation.

The user requested active use of these installed skills throughout this work:

- `/Users/dawe/.codex/skills/caveman/SKILL.md`: concise Czech communication; preserve complete technical detail in explicitly requested plans and reports.
- `/Users/dawe/.codex/skills/ponytail/SKILL.md`: reuse existing capabilities, avoid unnecessary infrastructure, and never omit requested features, accessibility, validation, or verification.

The intended default for new conversations is TokenHarbor / mimo-v2.5:free: provider `tokenharbor`, API model `mimo-v2.5:free`, endpoint `https://tokenharbor.ai/v1`, the free model from the operator's opencode setup (TokenRouter / GLM 5.3 Free is dead; Pollinations openai-fast stays as the keyless fallback preset). Never put credentials into source, documentation, browser storage, or logs. Existing conversations retain their provider/model snapshot.

The user reaffirmed on 2026-09-13: work directly on `main`, commit and push completed verified changes to GitHub `main` for automatic Vercel deployment. Preserve unrelated files and never commit secrets. Use caveman and ponytail by default for all work. Mobile usability and a stronger ASCII identity are current design priorities.

The user requested on 2026-09-14: all built-in TUI interface text must default to English. The interactive TUI must use its full color theme by default, even when the host inherits NO_COLOR=1. Use VOID_TUI_COLOR=0 as its explicit monochrome option; keep noninteractive output plain. Preserve user-authored messages and documents in their original language.

On 2026-09-15 the user requested Token Harbor as the new local default provider.
Its official OpenAI-compatible endpoint is `https://tokenharbor.ai/v1`.
The key is staged in encrypted local provider setup storage, outside this repo.
Activation is pending account email verification: the live model catalog returned
HTTP 403 `email_verification_required`. After verification, `/connect tokenharbor`
validates the catalog and saves the provider for new conversations. The requested
model is not yet specified. Existing conversations retain their provider snapshots.
