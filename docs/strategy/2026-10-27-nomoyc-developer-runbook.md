# NOMO × YC: developer runbook for the private founder page

**Status:** implementation runbook
**Reviewed:** 27 October 2026
**Canonical page source:** `docs/strategy/2026-10-27-nomoyc-integrated-roadmap.md`
**Scope:** local source-to-encrypted-snapshot workflow for `/nomoyc` in DavidSak.

## Prerequisites

- Node.js 22 or later and the Vercel CLI (`vercel --version`).
- Both checkouts at sibling paths: `DavidSak/` and `NOMO/`.
- Vercel account access to the DavidSak project, a local project link, and its required local environment variables: `AUTH_SECRET`, `NOMOYC_PASSWORD`, and `NOMOYC_CONTENT_KEY_V2`.
- The 32-byte hexadecimal content key stored outside Git at `~/.config/nomoyc/content-key-v2`, with directory mode `700` and file mode `600`. The key is not included in `.env.example`, page source, or the encrypted payload.

## Back up and restore the content key

Before relying on the encrypted snapshot, store the same key as a restricted secure note in the founders' approved password manager or secrets vault. Limit access to named founders, assign one owner for recovery, and do not store the key in Git, email, chat, ordinary shared drives, or the private-page ciphertext itself.

To restore on a replacement workstation, retrieve the key through the trusted password-manager app or CLI directly into `~/.config/nomoyc/content-key-v2`; do not print it or put it in a shell argument. Create the directory with mode `700`, set the file to mode `600`, and restore `NOMOYC_CONTENT_KEY_V2` into ignored `.env.local` with the local-key sync command below. Verify the restored copy by running the manifest `--check` command. It must decrypt and match all source documents without printing their contents or key. Keep the recovery item until this restore check passes; remove temporary recovery files afterward.

Run a restore check before first deployment and after changing the recovery owner or password manager. If the key is suspected to be exposed, stop distribution and rotate it through a separately reviewed migration; do not delete the old key until the payload has been re-encrypted and the deployed page has been verified.

## Validate the encrypted library

From `DavidSak/`:

```sh
node scripts/sync-nomoyc-content.mjs \
  --source ../NOMO/docs/strategy \
  --key-file ~/.config/nomoyc/content-key-v2 \
  --check
```

Expected output: `OK: N documents match encrypted manifest` and exit code 0. The check decrypts the checked-in payload locally, compares the dated strategy Markdown files by ID and SHA-256, and prints no document contents or key material.

If the check reports `NOMOYC_MANIFEST_MISMATCH`, it names only missing, extra, or changed `.md` paths. Regenerate the encrypted snapshot with the same source and key arguments and `--write`, then run `--check` again. A wrong key returns `NOMOYC_KEY_MISMATCH`; check the key file without pasting it into chat, a shell command, or Git. A key permission error is fixed with `chmod 600 ~/.config/nomoyc/content-key-v2`.

The one-time `--content-json` option exists only to migrate an already authenticated plaintext snapshot into a newly rotated key. It must point to a protected local file and must be removed after migration. Normal edits use the encrypted payload as the plan-data source and only synchronize canonical Markdown documents.

## Run a local preview

**First-time contributor, estimated 15–30 minutes:**

```sh
vercel login
vercel link
vercel env pull .env.local
node scripts/sync-nomoyc-local-key.mjs \
  --key-file ~/.config/nomoyc/content-key-v2 \
  --env-file .env.local
```

Choose the existing DavidSak Vercel project when `vercel link` asks. `.env.local` is ignored by Git; keep it private and never paste its contents into chat or commit it. Vercel may not return a hidden key in `vercel env pull`; the sync command restores only `NOMOYC_CONTENT_KEY_V2` from the protected founder key file and does not print its value. A contributor also needs the authorized local `NOMOYC_PASSWORD` value from the password manager if Vercel marks it hidden. Do not share the page credential through `.env.example` or Git.

If the password is hidden by Vercel, open `.env.local` in a trusted local editor or secret manager and add `NOMOYC_PASSWORD=<authorized value>` there. Do not put the value in a shell command, terminal argument, clipboard shared with an untrusted app, or tool output. Verify only that the variable is present:

```sh
node -e "const fs=require('node:fs');const s=fs.readFileSync('.env.local','utf8');const m=s.match(/^NOMOYC_PASSWORD=(.*)$/m);const v=(m?.[1]||'').trim().replace(/^(\"|')|(\"|')$/g,'');if(!v||/^(hidden|\\*+|<hidden>)$/i.test(v))process.exit(1);console.log('OK: NOMOYC_PASSWORD is present')"
```

If `vercel env pull` masks `AUTH_SECRET`, use a separate local-only value; do not replace the production secret. This command replaces only a missing, blank, masked, or invalid local value, writes `.env.local` with mode `600`, and never prints the generated secret:

```sh
node --input-type=module <<'NODE'
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
const file = '.env.local';
if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error('.env.local must not be a symlink');
const lines = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/) : [];
const value = lines.find((line) => /^\s*AUTH_SECRET\s*=/.test(line))?.split('=').slice(1).join('=').trim().replace(/^(['"])(.*)\1$/, '$2') || '';
if (value.length >= 32 && !/^(hidden|\*+|<hidden>)$/i.test(value)) console.log('OK: local AUTH_SECRET is present');
else {
  const secret = randomBytes(48).toString('base64url');
  let replaced = false;
  const next = lines.flatMap((line) => {
    if (!/^\s*AUTH_SECRET\s*=/.test(line)) return [line];
    if (replaced) return [];
    replaced = true;
    return [`AUTH_SECRET=${secret}`];
  });
  if (!replaced) next.push(`AUTH_SECRET=${secret}`);
  writeFileSync(file, `${next.join('\n').replace(/\n*$/, '')}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  console.log('OK: local-only AUTH_SECRET generated; value not displayed');
}
NODE
```

Verify all three required local values without displaying them:

```sh
node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs';
const lines = readFileSync('.env.local', 'utf8').split(/\r?\n/);
const get = (name) => lines.find((line) => new RegExp(`^\\s*${name}\\s*=`).test(line))?.split('=').slice(1).join('=').trim().replace(/^(['"])(.*)\1$/, '$2') || '';
const auth = get('AUTH_SECRET');
const password = get('NOMOYC_PASSWORD');
const key = get('NOMOYC_CONTENT_KEY_V2');
const missing = [];
if (auth.length < 32 || /^(hidden|\*+|<hidden>)$/i.test(auth)) missing.push('AUTH_SECRET');
if (!password || /^(hidden|\*+|<hidden>)$/i.test(password)) missing.push('NOMOYC_PASSWORD');
if (!/^[a-f\d]{64}$/i.test(key)) missing.push('NOMOYC_CONTENT_KEY_V2');
if (missing.length) { console.error(`Missing or masked: ${missing.join(', ')}`); process.exit(1); }
console.log('OK: all three required local variables are present');
NODE
```

**Returning contributor with a linked project and local secrets, estimated 5–10 minutes:**

```sh
vercel dev
```

Open `http://localhost:3000/nomoyc`. The page should show session restoration, then a password form until the authenticated API confirms a valid session. The API needs the three environment variables above. Do not copy production secrets to a committed file; use Vercel's private local environment setup. Verify the direct API read without a session returns HTTP 401 with `Content-Type: application/problem+json` and `X-Robots-Tag: noindex, nofollow, noarchive`.

## API contract

| Operation | Method | Effect |
| --- | --- | --- |
| Read founder snapshot and documents | `GET` / `HEAD` | No customer-data writes; server rate-limit counter may increment. Requires valid session. |
| Create a founder session | `POST` `{ "password": "…" }` | Sets an HttpOnly, SameSite=Strict session cookie. |
| End the session | `POST` `{ "action": "logout" }` | Clears the session cookie. |

Errors are RFC 9457 `application/problem+json` with stable `code`, `type`, `title`, `status`, safe `detail`, `instance`, `doc_anchor`, `api_version`, `request_id`, and a bounded `retry` instruction. `X-Request-Id` repeats the correlation ID. Configuration errors name variables only. Logs correlate unexpected failures by request ID and redact configured secret values; response bodies never include stack traces, nested causes, cookies, key values, or credential-bearing URLs. Reads are retried once by an explicit user action; state-changing requests are not retried automatically. After a failed read retry, contact the page owner with the request ID.

Stable codes currently include `not_configured` (503), `rate_limited` (429), `no_session` (401), `bad_password` (401), `method_not_allowed` (405), `bad_origin` (403), `payload_too_large` (413), `private_content_unavailable` (503), and `internal_error` (500).

## Pilot economics worksheet

Before the first pilot is priced or its result is reviewed, founders must approve and date one labor-rate policy for all founders/operators. Prefer a fully loaded compensation rate: annual compensation plus employer taxes and benefits, divided by the documented annual productive hours for that role. If compensation data is unavailable, use a fixed founder-approved planning rate card by role, record its rationale and effective date, and hold it constant across every pilot in this experiment. Never choose or change rates after seeing pilot economics; if a rate change is unavoidable, close the experiment, preserve the old series, and start a separately labeled series. Record hours by role and show a sensitivity result only when reasonable rate uncertainty could change a pass/fail decision. Keep one-time R&D separate from repeatable delivery costs.

For every evaluated and paid pilot, record revenue and direct delivery cost by line item: onboarding and implementation, model/infrastructure, hardware amortization, external expert review, support, and founder/operator hours multiplied by the pre-agreed role rate. Use the same formula in each account: `(revenue − fully loaded direct delivery cost) / revenue`. Count a deployment toward repeatability only after the named buyer legal entity has accepted the agreed deliverable and payment has been collected; a signed proposal, invoice, unpaid trial, or refund does not count. Record the budget owner so repeat deployments are not mistaken for independent demand. The scale screen requires three consecutive paid, accepted deployments to three distinct buyer organizations; repeated purchases or subsidiaries under one budget owner count as one organization. This is a founder heuristic, not statistical market validation.

## Release checklist

1. Update canonical NOMO Markdown files and inspect their claims and source links.
2. Run the manifest `--check` command; resolve every mismatch.
3. If the docs changed, run `--write`, then rerun `--check`.
4. Run `node scripts/verify-nomoyc-api.mjs ~/.config/nomoyc/content-key-v2`; expected output is `OK: 20 NOMO API security assertions passed (isolated in-memory state; no production endpoint used)`. It covers unauthenticated and expired sessions, login/logout, bad origin, oversized bodies, rate limiting/`Retry-After`, ciphertext corruption, response headers, correlation IDs, and secret redaction.
5. Verify JavaScript syntax, chart links/denominators, mobile diagram readability, noindex, and no public navigation link or sitemap entry. The shared password is a temporary access gate, not individual founder identity. Before inviting cofounders, assign an owner for the credential in the approved password manager and rotate/revoke access when membership changes. Keep customer data and production credentials out of this founder page. If named-person access is required, use individual identity or deployment protection.
6. Confirm the recovery key is available to the named owner; restore it to a temporary protected file and run `--check` without exposing the value. Remove the temporary file after the check.
7. Commit only NOMO strategy files and the directly related DavidSak page/API/sync files. Never stage local environment files, the protected key, or unrelated work.
8. After deployment, check the production route and API again; do not describe a successful Git push as a successful deployment until Vercel reports the deployment ready.
