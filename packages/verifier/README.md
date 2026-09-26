# @void/verifier

Offline verifier for a VOID ledger export. A third party runs this **without
VOID, and without trusting VOID**.

## What it checks

```sh
npx @void/verifier ledger-bundle.jsonl
npx @void/verifier ledger-bundle.jsonl --public-key <base64-spki> --key-id <id>
npx @void/verifier --selftest
```

With a public key it checks the ed25519 signature on every entry, the domain
separated preimage, the `sha256:` entry hash, and the `prev_hash` chain link
from the genesis digest to the head. Without a key it checks sequence continuity,
hash links and body digests only, and the verdict says exactly that. That
distinction is the point: hash integrity alone is **not** signature
verification, and this tool never reports one as the other.

## The commitment that it never moves

This package is the structural half of the open core licence line, and the
commitment is written down rather than implied:

- **It has zero dependencies.** Not zero VOID dependencies: zero, of any kind.
  `dependencies` and `devDependencies` are both empty objects and a gate fails
  the build if either stops being empty. A verifier that pulls in a package tree
  inherits that tree's supply chain, and the supply chain is exactly what a
  ledger audit is supposed to be independent of.
- **It imports nothing from this repository.** The canonicaliser, the entry hash
  and the signing preimage are replicated byte for byte from
  `packages/ledger`. That duplication is deliberate and is the one thing that
  makes independence possible, so the selftest pins the shared vectors: if the
  two ever drift, the selftest is where it shows.
- **It will not acquire a build step.** It is one executable file of Node
  built-ins. That is what makes it auditable by reading it, and a build step
  would be the first step toward the dependency tree it exists to avoid.

If a future change needs any of those three, that is a change to this product's
central claim, not a refactor.

## What it does not do

It is not a client for the VOID API and it holds no key material. It reads a
JSONL export bundle and nothing else. It cannot tell you whether a recorded
decision was _correct_, only whether the record has not been altered since it
was signed.

The ledger is tamper **evident**, not tamper proof. A database superuser
bypasses every grant and every trigger, which is exactly why entries are signed.
An entry signed by a compromised host key verifies, so past entries are only as
trustworthy as the key that signed them, and a published checkpoint is what
extends that trust past a rotation. This tool does not fix that limit; it is
what makes the limit inspectable by someone who is not us.

## Licence

Apache 2.0. The ledger format is documented well enough that a second verifier
can be written in another language; that is a deliberate property of the format,
not an accident of this implementation.
