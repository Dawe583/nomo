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

test('Mac build policy keeps direct local ad-hoc builds and refuses App Store packaging', () => {
  assert.deepEqual(resolveBuildPolicy({ platform: 'darwin', distribution: undefined, env: {} }), {
    distribution: 'direct',
    signingIdentity: '-',
  });
  assert.deepEqual(resolveBuildPolicy({ platform: 'darwin', distribution: 'direct', env: {} }), {
    distribution: 'direct',
    signingIdentity: '-',
  });
  assert.deepEqual(resolveBuildPolicy({ platform: 'darwin', distribution: 'direct', env: { APPLE_SIGNING_IDENTITY: 'Developer ID Application: Example' } }), {
    distribution: 'direct',
    signingIdentity: 'Developer ID Application: Example',
  });
  assert.throws(
    () => resolveBuildPolicy({ platform: 'darwin', distribution: 'store', env: {} }),
    /Mac App Store packaging is not configured/,
  );
  assert.throws(
    () => resolveBuildPolicy({ platform: 'darwin', distribution: 'unknown', env: {} }),
    /Unknown VOID_DISTRIBUTION profile/,
  );
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
