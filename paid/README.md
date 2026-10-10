# paid/

This directory is closed. Nothing in it is licensed under the root Apache 2.0
licence, and it carries its own `LICENSE` declaring
`SPDX-License-Identifier: LicenseRef-VOID-Proprietary`. It holds the channel
implementations that `docs/DECISIONS.md` section 5 names on the paid side:
`channels/slack.ts`, the Slack approval channel, and its test.

The split is the point. The channel **interface** and the CLI channel stay open
in `packages/policy`, because a policy package that cannot notify anyone is not
complete for its purpose. The Slack **implementation** is a vendor-specific
webhook client, it is paid by name in the decision log, and it lives here
instead of in an Apache 2.0 package. A paid implementation of an open interface
is what that decision prescribes.

The dependency runs one way: this directory may import `@nomo/policy`, and no
open package may import this one. `scripts/src/licence-line.test.mjs` asserts
both directions and the licence identifier here, so putting the implementation
back under `packages/policy` fails a gate rather than passing review.

Tests run with the rest of the tree: `node scripts/src/check-tests.mjs` collects
`paid/**/*.test.ts` under the per-suite ceiling, the same way it collects the
`cloud/` suites.