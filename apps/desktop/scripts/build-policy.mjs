import { execFileSync } from 'node:child_process';

/**
 * The distribution profiles this tree knows, and whether the artifact the
 * profile produces is published. A published artifact is notarized by Apple,
 * and Apple rejects an ad-hoc signature outright, so an ad-hoc fallback is a
 * hard error for those profiles instead of a warning.
 */
const DISTRIBUTION_PROFILES = {
  direct: { notarizes: false },
  store: { notarizes: true },
};

/**
 * Tauri's own notarization credentials. Their presence is a notarization run
 * whatever profile asked for it, and it is the only signal this tree has that
 * the operator intends to publish, so a set of them plus an ad-hoc signature is
 * refused rather than warned about.
 */
const NOTARIZATION_CREDENTIALS = [
  'APPLE_ID',
  'APPLE_PASSWORD',
  'APPLE_TEAM_ID',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
];

/**
 * Identity name prefixes in preference order. A `Developer ID Application`
 * identity is the distribution identity. `Apple Development` is stable across
 * rebuilds, which is what keeps the keychain allowed list alive, but Apple's own
 * documentation disqualifies it for notarization. Anything else the operator put
 * in the keychain (a self-signed code-signing identity, say) is stable too, and
 * is used last.
 */
const IDENTITY_PREFERENCE = [/^Developer ID Application:/u, /^Apple Development:/u];

/** The ad-hoc identity, and the only value codesign accepts for one. */
const ADHOC_IDENTITY = '-';

/**
 * Reads the code-signing identities the keychain already holds. This lists
 * identity hashes and names and nothing else: no key material is decrypted,
 * opened or printed, and the keychain is never written to.
 */
function listKeychainIdentities() {
  let output;
  try {
    output = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return [];
  }
  return [...output.matchAll(/^[ \t]*\d+\)[ \t]+([0-9A-Fa-f]{40})[ \t]+"(.*)"[ \t]*$/gmu)].map(match => ({
    hash: match[1],
    name: match[2],
  }));
}

/** Tests hand the policy names for speed; the live keychain parser returns entries. */
function asIdentityEntry(entry) {
  return typeof entry === 'string' ? { hash: null, name: entry } : entry;
}

/** Where a discovered name sits in the preference order; lower wins. */
function identityRank(name) {
  const index = IDENTITY_PREFERENCE.findIndex(pattern => pattern.test(name));
  return index === -1 ? IDENTITY_PREFERENCE.length : index;
}

export function resolveBuildPolicy({
  platform,
  distribution,
  env,
  listIdentities = listKeychainIdentities,
  warn = message => process.stderr.write(`${message}\n`),
}) {
  const selected = distribution ?? 'direct';
  const profile = DISTRIBUTION_PROFILES[selected];
  if (!profile) {
    throw new Error(`Unknown NOMO_DISTRIBUTION profile: ${selected}`);
  }
  if (platform === 'darwin' && selected === 'store') {
    throw new Error('Mac App Store packaging is not configured; use the direct-download profile until a separate signed sandbox/provisioning path exists.');
  }
  if (platform !== 'darwin') {
    return { distribution: selected, signingIdentity: undefined };
  }

  // 1. The operator's own choice, used verbatim and never second-guessed.
  const requested = env.APPLE_SIGNING_IDENTITY;
  if (typeof requested === 'string' && requested.trim() !== '') {
    return { distribution: selected, signingIdentity: requested, signingIdentitySource: 'environment' };
  }

  // 2. A stable identity this machine already has, discovered read-only.
  const entries = listIdentities().map(asIdentityEntry);
  const stable = [...new Set(entries.map(entry => entry.name.trim()).filter(Boolean))]
    .sort((left, right) => identityRank(left) - identityRank(right))[0];
  if (stable) {
    // codesign refuses an identity NAME when the keychain holds more than one
    // certificate under it ("ambiguous (matches ... and ... in keychain-db)"),
    // which is exactly the state a recreated Apple Development certificate
    // leaves behind. The SHA-1 the listing already showed reaches the same
    // certificate unambiguously, so a name held by several identities resolves
    // to the first listed hash and the build signs by it.
    const uniqueHashes = [
      ...new Set(
        entries
          .filter(entry => entry.name.trim() === stable && typeof entry.hash === 'string')
          .map(entry => entry.hash),
      ),
    ];
    if (uniqueHashes.length > 1) {
      warn(
        `warning: the keychain holds ${uniqueHashes.length} code-signing identities named "${stable}", ` +
        `which codesign refuses as ambiguous, so this build signs by the SHA-1 ${uniqueHashes[0]} of the first one. ` +
        'A previously built app that stops unlocking the workspace key after this switch starts a one-time ' +
        'keychain re-authorization; remove the older duplicate in Keychain Access, or set ' +
        'APPLE_SIGNING_IDENTITY to this hash, to stop the build choosing between the two.',
      );
      return { distribution: selected, signingIdentity: uniqueHashes[0], signingIdentitySource: 'keychain-hash' };
    }
    return { distribution: selected, signingIdentity: stable, signingIdentitySource: 'keychain' };
  }

  // 3. Ad-hoc, the last resort. Legitimate for a local build, fatal for a
  //    published one, and either way too quiet to leave to the runtime.
  if (profile.notarizes || NOTARIZATION_CREDENTIALS.some(name => env[name])) {
    const reason = profile.notarizes
      ? `the ${selected} profile expects a notarized artifact`
      : 'Apple notarization credentials are set';
    throw new Error(`Refusing an ad-hoc signature: ${reason}, and Apple does not accept an ad-hoc, Apple Development, Mac Distribution or local development certificate for notarization. Set APPLE_SIGNING_IDENTITY to a Developer ID Application identity.`);
  }
  warn(
    'warning: no stable macOS code-signing identity was found, so this build is signed ad-hoc (`-`).\n' +
    'An ad-hoc signature is different on every rebuild, and macOS binds the workspace key item\n' +
    '`dev.void.desktop.workspace` to the identity that created it, so the next rebuild will start\n' +
    'the app, fail to read that key and exit with "Cannot unlock the NOMO workspace key in macOS\n' +
    'Keychain" and no window, leaving the encrypted workspace unreadable. Set\n' +
    'APPLE_SIGNING_IDENTITY="<identity name>" to sign with a stable identity; the identities this\n' +
    'machine already has are listed by `security find-identity -v -p codesigning`.',
  );
  return { distribution: selected, signingIdentity: ADHOC_IDENTITY, signingIdentitySource: 'ad-hoc' };
}
