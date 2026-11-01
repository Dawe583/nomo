# OpenTUI dependency notice

NOMO interactive workspace uses OpenTUI 0.6.8 (`@opentui/core` and `@opentui/react`), licensed under MIT. The workspace renderer and NOMO action/state contracts are maintained by this project.

Interactive runtime support is Bun 1.3.14 or newer, or Node 26.4 or newer with `--experimental-ffi`. The CLI re-execs interactive sessions under Bun when needed. `--once` and non-interactive snapshots do not initialize OpenTUI.
