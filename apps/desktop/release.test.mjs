import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolveBuildPolicy } from './scripts/build-policy.mjs';

test('local Mac release metadata agrees on 1.0.1', async () => {
  const packageJson = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
  const tauri = JSON.parse(await readFile(new URL('./src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  const cargo = await readFile(new URL('./src-tauri/Cargo.toml', import.meta.url), 'utf8');
  const lock = await readFile(new URL('./src-tauri/Cargo.lock', import.meta.url), 'utf8');

  assert.equal(packageJson.version, '1.0.1');
  assert.equal(tauri.version, '1.0.1');
  assert.match(cargo, /^version = "1\.0\.1"$/m);
  // \r? on every line break: a CRLF checkout would otherwise fail this on the
  // line ending rather than on the version, which is the whole claim.
  assert.match(lock, /name = "nomo-desktop"\r?\nversion = "1\.0\.1"/);
});

/** A keychain with no code-signing identity, so the ad-hoc path is reachable. */
const noIdentities = () => [];

/** Collects the warnings the policy emits instead of writing them to stderr. */
function captureWarnings() {
  const warnings = [];
  return { warnings, warn: message => warnings.push(message) };
}

test('Mac build policy keeps direct local ad-hoc builds and refuses App Store packaging', () => {
  const { warnings, warn } = captureWarnings();
  assert.deepEqual(resolveBuildPolicy({ platform: 'darwin', distribution: undefined, env: {}, listIdentities: noIdentities, warn }), {
    distribution: 'direct',
    signingIdentity: '-',
    signingIdentitySource: 'ad-hoc',
  });
  assert.deepEqual(resolveBuildPolicy({ platform: 'darwin', distribution: 'direct', env: {}, listIdentities: noIdentities, warn }), {
    distribution: 'direct',
    signingIdentity: '-',
    signingIdentitySource: 'ad-hoc',
  });
  assert.deepEqual(resolveBuildPolicy({ platform: 'darwin', distribution: 'direct', env: { APPLE_SIGNING_IDENTITY: 'Developer ID Application: Example' }, listIdentities: noIdentities, warn }), {
    distribution: 'direct',
    signingIdentity: 'Developer ID Application: Example',
    signingIdentitySource: 'environment',
  });
  assert.throws(
    () => resolveBuildPolicy({ platform: 'darwin', distribution: 'store', env: {}, listIdentities: noIdentities, warn }),
    /Mac App Store packaging is not configured/,
  );
  assert.throws(
    () => resolveBuildPolicy({ platform: 'darwin', distribution: 'unknown', env: {}, listIdentities: noIdentities, warn }),
    /Unknown NOMO_DISTRIBUTION profile/,
  );
  assert.equal(warnings.length, 2, 'only the two ad-hoc resolutions warn');
});

test('Mac build policy prefers the operator identity over anything in the keychain', () => {
  assert.deepEqual(resolveBuildPolicy({
    platform: 'darwin',
    distribution: 'direct',
    env: { APPLE_SIGNING_IDENTITY: 'Developer ID Application: Example' },
    listIdentities: () => ['Apple Development: Someone (TEAMID)'],
  }), {
    distribution: 'direct',
    signingIdentity: 'Developer ID Application: Example',
    signingIdentitySource: 'environment',
  });
  // A blank override is not a usable identity, so it resolves like an unset one.
  assert.equal(
    resolveBuildPolicy({ platform: 'darwin', distribution: 'direct', env: { APPLE_SIGNING_IDENTITY: '   ' }, listIdentities: () => ['NOMO Local Signing'] }).signingIdentitySource,
    'keychain',
  );
});

test('Mac build policy signs with a stable keychain identity instead of ad-hoc', () => {
  const discovered = () => [
    'NOMO Local Signing',
    'Apple Development: Someone (TEAMID)',
    'Developer ID Application: Example (TEAMID)',
  ];
  const { warnings, warn } = captureWarnings();
  assert.deepEqual(resolveBuildPolicy({ platform: 'darwin', distribution: 'direct', env: {}, listIdentities: discovered, warn }), {
    distribution: 'direct',
    signingIdentity: 'Developer ID Application: Example (TEAMID)',
    signingIdentitySource: 'keychain',
  });
  // Without a Developer ID identity the next best stable name is used, and a
  // self-signed name is still stable enough to be preferred to ad-hoc.
  assert.equal(
    resolveBuildPolicy({ platform: 'darwin', distribution: 'direct', env: {}, listIdentities: () => ['NOMO Local Signing', 'Apple Development: Someone (TEAMID)'] }).signingIdentity,
    'Apple Development: Someone (TEAMID)',
  );
  assert.equal(
    resolveBuildPolicy({ platform: 'darwin', distribution: 'direct', env: {}, listIdentities: () => ['NOMO Local Signing'] }).signingIdentity,
    'NOMO Local Signing',
  );
  assert.equal(resolveBuildPolicy({ platform: 'darwin', distribution: 'direct', env: {}, listIdentities: () => ['NOMO Local Signing', 'NOMO Local Signing'] }).signingIdentitySource, 'keychain');
  assert.deepEqual(warnings, [], 'a stable identity is not a fallback and must stay quiet');
});

test('an identity name the keychain holds twice signs by hash, not by the ambiguous name', () => {
  // codesign fails the whole bundle step on an ambiguous name, measured at
  // "ambiguous (matches "..." and "..." in keychain-db)". The hash the
  // keychain listing already prints reaches one certificate unambiguously, so
  // the policy must use it instead of letting the build die after compile.
  const sharedName = 'Apple Development: Example Tester (TEAM)';
  const duplicated = () => [
    { hash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', name: sharedName },
    { hash: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', name: sharedName },
  ];
  const { warnings, warn } = captureWarnings();
  const resolved = resolveBuildPolicy({ platform: 'darwin', distribution: 'direct', env: {}, listIdentities: duplicated, warn });
  assert.deepEqual(resolved, {
    distribution: 'direct',
    signingIdentity: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    signingIdentitySource: 'keychain-hash',
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ambiguous/);
  assert.match(warnings[0], /APPLE_SIGNING_IDENTITY/);

  // A Developer ID name that also carries the duplicate still wins the rank
  // first, and its duplicates are resolved the same way.
  const rankedDuplicate = () => [
    { hash: 'C614CD528B7365B2CF07C47B4F920911B1BFE8C4', name: sharedName },
    { hash: '6B53226A8BC2DB19D8E155DB1194F7A981FB6D0D', name: sharedName },
    { hash: '1234567890123456789012345678901234567890', name: 'Developer ID Application: Example (TEAM)' },
    { hash: '9234567890123456789012345678901234567890', name: 'Developer ID Application: Example (TEAM)' },
  ];
  assert.equal(
    resolveBuildPolicy({ platform: 'darwin', distribution: 'direct', env: {}, listIdentities: rankedDuplicate, warn }).signingIdentity,
    '1234567890123456789012345678901234567890',
  );
});

test('an ad-hoc Mac fallback names the consequence and the override', () => {
  const { warnings, warn } = captureWarnings();
  resolveBuildPolicy({ platform: 'darwin', distribution: 'direct', env: {}, listIdentities: noIdentities, warn });
  assert.equal(warnings.length, 1);
  const [warning] = warnings;
  assert.match(warning, /ad-hoc/);
  assert.match(warning, /APPLE_SIGNING_IDENTITY="<identity name>"/);
  // The Keychain service name is durable user state. The migration rule
  // forbids renaming it silently, so the warning must name the item the app
  // actually reads, which is still the original service name.
  assert.match(warning, /dev\.void\.desktop\.workspace/);
  assert.match(warning, /Cannot unlock the NOMO workspace key in macOS/);
});

test('a notarised Mac run refuses an ad-hoc signature', () => {
  for (const credentials of [
    { APPLE_ID: 'someone@example.com', APPLE_PASSWORD: 'app-specific', APPLE_TEAM_ID: 'TEAMID' },
    { APPLE_API_KEY: '/path/AuthKey.p8', APPLE_API_KEY_ID: 'KEYID', APPLE_API_ISSUER: 'ISSUER' },
  ]) {
    assert.throws(
      () => resolveBuildPolicy({ platform: 'darwin', distribution: 'direct', env: credentials, listIdentities: noIdentities }),
      /Refusing an ad-hoc signature: Apple notarization credentials are set/,
    );
    // A stable identity satisfies the same run, and the credentials alone are
    // not a reason to reach for ad-hoc.
    assert.deepEqual(resolveBuildPolicy({ platform: 'darwin', distribution: 'direct', env: credentials, listIdentities: () => ['Developer ID Application: Example (TEAMID)'] }), {
      distribution: 'direct',
      signingIdentity: 'Developer ID Application: Example (TEAMID)',
      signingIdentitySource: 'keychain',
    });
  }
});

test('non-macOS platforms keep the Mac identity out of the policy', () => {
  const discovery = () => { throw new Error('the keychain must not be read off macOS'); };
  for (const platform of ['linux', 'win32']) {
    assert.deepEqual(resolveBuildPolicy({ platform, distribution: 'direct', env: { APPLE_SIGNING_IDENTITY: 'Developer ID Application: Example' }, listIdentities: discovery }), {
      distribution: 'direct',
      signingIdentity: undefined,
    });
    // The App Store profile is a macOS-only rejection and stays one.
    assert.doesNotThrow(() => resolveBuildPolicy({ platform, distribution: 'store', env: {}, listIdentities: discovery }));
  }
});
