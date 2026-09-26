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
  assert.match(lock, /name = "void-desktop"\nversion = "1\.0\.1"/);
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
    /Unknown VOID_DISTRIBUTION profile/,
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
    resolveBuildPolicy({ platform: 'darwin', distribution: 'direct', env: { APPLE_SIGNING_IDENTITY: '   ' }, listIdentities: () => ['VOID Local Signing'] }).signingIdentitySource,
    'keychain',
  );
});

test('Mac build policy signs with a stable keychain identity instead of ad-hoc', () => {
  const discovered = () => [
    'VOID Local Signing',
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
    resolveBuildPolicy({ platform: 'darwin', distribution: 'direct', env: {}, listIdentities: () => ['VOID Local Signing', 'Apple Development: Someone (TEAMID)'] }).signingIdentity,
    'Apple Development: Someone (TEAMID)',
  );
  assert.equal(
    resolveBuildPolicy({ platform: 'darwin', distribution: 'direct', env: {}, listIdentities: () => ['VOID Local Signing'] }).signingIdentity,
    'VOID Local Signing',
  );
  assert.equal(resolveBuildPolicy({ platform: 'darwin', distribution: 'direct', env: {}, listIdentities: () => ['VOID Local Signing', 'VOID Local Signing'] }).signingIdentitySource, 'keychain');
  assert.deepEqual(warnings, [], 'a stable identity is not a fallback and must stay quiet');
});

test('an ad-hoc Mac fallback names the consequence and the override', () => {
  const { warnings, warn } = captureWarnings();
  resolveBuildPolicy({ platform: 'darwin', distribution: 'direct', env: {}, listIdentities: noIdentities, warn });
  assert.equal(warnings.length, 1);
  const [warning] = warnings;
  assert.match(warning, /ad-hoc/);
  assert.match(warning, /APPLE_SIGNING_IDENTITY="<identity name>"/);
  assert.match(warning, /dev\.void\.desktop\.workspace/);
  assert.match(warning, /Cannot unlock the VOID workspace key in macOS/);
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

test('Mac release documentation names the exact local provenance and external blockers', async () => {
  const readme = await readFile(new URL('./README.md', import.meta.url), 'utf8');
  assert.match(readme, /1\.0\.1/);
  assert.match(readme, /apps\/desktop\/package\.json/);
  assert.match(readme, /apps\/desktop\/src-tauri\/Cargo\.toml/);
  assert.match(readme, /apps\/desktop\/src-tauri\/tauri\.conf\.json/);
  assert.match(readme, /ad-hoc signature/);
  assert.match(readme, /notarization/);
  assert.match(readme, /Mac App Store/);
  assert.match(readme, /diagnostic/);
  assert.match(readme, /smoke/);
});
