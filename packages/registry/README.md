# @nomo/registry

The Reversibility Registry: the classification data, and later the case
evaluator that reads it.

## Responsible for

An entry does not carry a class. It carries an ordered list of cases, each
guarded by a precondition, because reversibility is a property of a call
evaluated against the state of its target. This package owns that data, the
types describing it, the pure queries over it, and `REGISTRY_DISCLAIMER`, which
travels with the data verbatim wherever the data goes.

It is one module for one reason: the page at `/registry`, the endpoint at
`/api/registry` and the classification made at intercept time must not be able
to disagree about what a class means.

## Must never import

Nothing. Not the ledger, not a workspace package, not a node builtin, not zod.
It is data and pure functions, which is what lets the browser bundle, the Vercel
Function and the runtime all read the same module.

## Where the data actually lives

In this package: `src/registry.ts` holds the data and `src/index.ts`
re-exports it. No second copy may exist anywhere in the repository.

That direction is not a preference. While the data lived under the `api/`
directory, a relative import that left it raised TypeScript's inferred emit root to
the repository root, every compiled function moved from `<out>/registry.js` to
`<out>/api/registry.js`, and Vercel resolved no route at all while `tsc` still
exited 0. The decision is in `docs/DECISIONS.md` 6b. That `api/` tree no longer
exists: the site was split out of this repository, and with it went the layout that
made the import direction load bearing.

Consumers import `@nomo/registry` and reach the same module the CLI, the
workbench and the runtime use.

## Public surface

Re-exported from `src/registry.ts`:

- Types: `RegistryTone`, `RegistryCase`, `RegistryEntry`, `RegistryQuery`
- Data: `registry`, `REGISTRY_VERSION`, `REGISTRY_DISCLAIMER`, `TONE_LABEL`
- Queries: `worstCase`, `bestCase`, `isConditional`, `spread`, `findEntry`,
  `searchRegistry`, `registryVendors`, `registryTags`, `registryStats`

The case evaluator, which answers "which case holds for this call against this
declared configuration", is WP-04a and does not exist yet.
