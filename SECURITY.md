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
and the Secret Detection job in CI is the second line of that; the first is
that nothing in this tree has ever needed to hold one.

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
- **The hosted function.** The Appwrite project id and endpoint, and the project
  API key the console actions need, are Appwrite-side configuration and local
  environment values. Nothing in `apps/appwrite-mcp` carries a key; the
  directory holds source, the deployed snapshot and the requirements.
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

## What the CI gate covers

GitHub Actions is the primary CI. `.github/workflows/ci.yml` and
`manifest.yml` run on Linux and Windows, `desktop-windows.yml` builds and
installs the signed Windows installer, and `cloud-integration.yml` drives a
pinned Neon wire-protocol proxy against a disposable Postgres. The GitLab mirror
in `.gitlab-ci.yml` covers the Linux subset: the typecheck, unit and end-to-end
gates on Node 24 and 26, the manifest persistence suite, and three security
analyzer templates (SAST, dependency scanning, secret detection).

So the gate that runs on every push and every merge request covers static
analysis, known-vulnerable dependency detection, and committed-secret
detection. It does not cover the Windows or macOS surfaces, the packaged
desktop application, the cloud integration path, or any deployed environment.

A passing pipeline is evidence that those gates ran. It is not evidence that
the product is free of vulnerabilities, and `docs/THREAT-MODEL.md` is explicit
about which of its guarantees a green pipeline says nothing about.

The Windows, macOS and cloud-integration jobs run on GitHub only: GitLab bills
Windows and macOS shared runner minutes at a multiple of the Linux rate, and
this namespace has a 400 minute monthly shared allowance.
