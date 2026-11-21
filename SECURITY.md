# Security policy

## Reporting a vulnerability privately

Do not open a public issue or a public merge request for anything exploitable.

Report it privately to the maintainer through the platform's private channel:
**Security Advisories** on either forge. GitLab has *Security > Report a
vulnerability* on `sitespot1/void`, which opens a confidential issue only the
maintainer can see; GitHub has *Security advisories > Report a vulnerability* on
`Dawe583/void`. Both reach the same person and neither puts the report on a
public timeline.

Include the platform and Node version, the commit you tested, the exact command
or request, and what an attacker gains. `docs/THREAT-MODEL.md` is worth reading
before writing it up, because it states plainly which of NOMO's guarantees are
signature properties and which are not, and a report framed against the wrong
one reads as a false positive.

Acknowledge within a few days. Fixes land as a private merge request first and
are published with the advisory when the release goes out.

## What lives outside this repository

No credential, key or connection string is committed here. `.env*` is ignored,
and repository checks supplement the rule that nothing in this tree should
hold one. The repository does not use hosted CI as a security or release gate.

What is held elsewhere, and where:

- **Signing and workspace keys.** `NOMO_SIGNING_KEY` and
  `NOMO_ACCOUNT_SEAL_KEY` live in the AES-256-GCM snapshot, the macOS
  Keychain, the Windows Credential Manager, or a mode-0600 key file beside the
  data they sign. `docs/THREAT-MODEL.md` records what that custody is worth:
  the recorder, the executor, the policy engine and the signature all run in
  one process under one OS principal, so the signature defends against a third
  party who can edit the ledger but cannot read the key file, and against
  nothing else.
- **The cloud database.** `DATABASE_URL` and `NOMO_PG_URL` are deployment
  variables on Vercel. The hosted ledger is the production record of accountable
  tool calls, so a credential here is a credential over that record.
- **Control plane tokens.** `NOMO_CONTROL_TOKEN` and `NOMO_SECRET_KEY` are
  issued per workspace at run time and are present in no file, no fixture and no
  test.

Rotating `NOMO_SIGNING_KEY` means generating a new key, redeploying and running
`scripts/src/provision-cloud.mjs`; entries signed by the old key verify only
against it. `docs/OPERATIONS.md` covers the boundary, including the absence of a
production KMS.

If a secret is committed by accident, say so in the report rather than opening a
public issue about the commit. Removing it from history is not the fix; rotation
is.

## Local verification

This repository does not use GitHub Actions or another hosted CI pipeline as
a verification or release gate. Verify changes locally with the commands
listed in the applicable project instructions. Local test results do not
prove behavior on a clean machine, on another operating system, or in a
deployed environment. Security still depends on the controls described in
`docs/THREAT-MODEL.md`; a local test pass is not a security certification.
