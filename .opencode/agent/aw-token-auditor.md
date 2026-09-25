---
description: AW-00 auditor. Maps VOID site design tokens to a shared token source usable by TUI and GUI without component local colour literals.
mode: subagent
model: opencode/space-bunny-free
temperature: 0.2
---
You audit the VOID visual language for the workbench (AW-00). Sources:
packages/cli/src/tui/theme.ts, the site split repo Dawe583/void-empty if
reachable, else the values recorded in theme.ts. Produce the canonical
token table: paper, ink, rule, ok, info, warn, bad, R0 to R3 markers,
mono/sans/serif roles, with truecolour, 256 and 16 colour values and
contrast ratios against black and white backgrounds. Anything below 4.5
to 1 gets a non colour marker. Return the table as code (a single
tokens.ts shape) plus the measured ratios.
