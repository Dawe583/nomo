---
name: david-project-stack-map
description: Use when working in David's repositories or when the repository identity is unclear. Maps his recurring project families to the correct tools, standards, and verification commands.
---

# David's project stack map

Use this map as a starting hypothesis, then verify against the current repository files. Never assume the map is newer than the code.

## Active product and app families

- `Dawe583/ScalpFX`: Next.js 15, React 19, TypeScript, Tailwind 4, motion/visx/charts, Python backend/FastAPI/ML, SQLite, Raspberry Pi, Vercel. Keep paper trading and risk rails as defaults; never enable live execution from an agent action.
- `Dawe583/dsakapp`: large private Papayai/SiteSpot-era application with iOS assets, Supabase, Vercel, existing `.prime`, `.claude`, graphify and strict no-fabricated-business-data rules. Read repository `CLAUDE.md` and local `.prime/agent/` before any work.
- `Dawe583/Cortex` and `Cortexia`: Next.js, React, Tailwind, Motion, Three.js/React Three Fiber, instrument-like product design, mobile-first behavior and explicit reversibility/accessibility rules.
- `Dawe583/Synx`: Vite/React/TypeScript PWA with Supabase functions, n8n workflows, Obsidian vault and Czech project documentation. Read the vault start notes and conventions before coding; record new durable decisions in the vault.
- `Dawe583/void` and `Dawe583/void-empty`: pnpm monorepo, Node 22, TypeScript, MCP/reversibility/policy/ledger concepts, Vercel-facing site. Preserve package boundaries and run `pnpm run check` plus mirror checks where relevant.
- `Dawe583/Project_String`: Python SymPy/mpmath verification plus TypeScript/KaTeX/Three.js/esbuild and native Swift String Lab. Preserve `derived`, `numeric`, `cross-check`, `quoted`, and `speculative` labels; do not edit generated build artifacts as source.
- `Dawe583/AstroPhysics`: Python, NumPy, SciPy, Matplotlib, Astropy, Jupyter, pytest. Every result needs units, limit checks, uncertainty/numerical error and source provenance; run `PYTHONPATH=src python3 -m pytest`.
- `Dawe583/OptikDvorak`, `3DWEB`, `vrstva`, `LynxStudio`, `Branzly*`, `SiteSpot*`, `DavidSak`, `Project_String`: mostly Vite/React/TypeScript or static marketing sites deployed to Vercel. Prefer existing components/tokens, visual browser checks, Lighthouse/Chrome DevTools and `npm run build` or the repository's exact scripts.

## Universal checks

1. Read project-specific context files before coding.
2. Detect the lockfile: use pnpm for `pnpm-lock.yaml`, npm for `package-lock.json`, and the repository's documented Python environment for Python projects.
3. Verify typecheck/lint/tests/build with the existing scripts; do not invent substitute commands unless the documented command is broken.
4. Run browser or simulator checks for user-visible changes.
5. Check generated artifacts, secrets, fake data, migrations, and git status before completion.
6. Communicate in Czech for David's projects unless the repository explicitly requires another language.
