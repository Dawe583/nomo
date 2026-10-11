import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { envValue, legacyEnvKey, normalizeEnv } from './env.mjs';
import { readAuthConfig } from './auth.mjs';
import { billingFromEnv } from './billing.mjs';
import { signupAllowed } from './account.mjs';

const SEAL = 'a'.repeat(64);

// `APPWRITE_*` are Appwrite's own names and are not aliased, so every auth
// fixture carries them explicitly.
const APPWRITE = {
  APPWRITE_PROJECT_ID: 'project',
  APPWRITE_RUNTIME_KEY: 'runtime-key',
  APPWRITE_ENDPOINT: 'https://appwrite.example.test/v1',
};

const POLAR_LEGACY = {
  VOID_POLAR_ENVIRONMENT: 'sandbox',
  VOID_POLAR_ACCESS_TOKEN: 'access',
  VOID_POLAR_ORGANIZATION_ID: 'org',
  VOID_POLAR_WEBHOOK_SECRET: 'webhook',
};

const storedSubscription = (product) => ({
  status: 'active',
  product,
  currentPeriodEnd: '2027-01-01T00:00:00Z',
});

// The configured product id is not published, so it is observed through what it
// decides: a stored subscription counts only when it is for the product the
// deployment named, so which spelling named it is what the test pins.
const isSubscribed = async (env, product) => {
  const service = billingFromEnv(env, { read: async () => storedSubscription(product) });
  if (!service) return undefined;
  return (await service.entitlement('owner-1')).subscribed;
};

test('envValue: legacy only resolves', () => {
  const env = { VOID_FOO: 'bar' };
  assert.strictEqual(envValue(env, 'NOMO_FOO'), 'bar');
});

test('envValue: NOMO wins', () => {
  const env = { NOMO_FOO: 'new', VOID_FOO: 'old' };
  assert.strictEqual(envValue(env, 'NOMO_FOO'), 'new');
});

test('envValue: empty NOMO wins', () => {
  const env = { NOMO_FOO: '', VOID_FOO: 'old' };
  assert.strictEqual(envValue(env, 'NOMO_FOO'), '');
});

test('envValue: neither set returns undefined', () => {
  const env = {};
  assert.strictEqual(envValue(env, 'NOMO_FOO'), undefined);
});

test('envValue: non-NOMO prefixed key throws', () => {
  assert.throws(() => envValue({}, 'FOO_BAR'), /must start with NOMO_/);
});

test('envValue: does not mutate input', () => {
  const env = Object.freeze({ VOID_FOO: 'bar' });
  assert.strictEqual(envValue(env, 'NOMO_FOO'), 'bar');
});

test('legacyEnvKey: swaps only the prefix', () => {
  assert.strictEqual(legacyEnvKey('NOMO_ACCOUNT_SEAL_KEY'), 'VOID_ACCOUNT_SEAL_KEY');
  assert.strictEqual(legacyEnvKey('NOMO_FOO'), 'VOID_FOO');
});

test('normalizeEnv: returns new object with legacy values', () => {
  const env = { VOID_FOO: 'bar' };
  const normalized = normalizeEnv(env, ['NOMO_FOO']);
  assert.deepStrictEqual(normalized, { VOID_FOO: 'bar', NOMO_FOO: 'bar' });
  assert.notStrictEqual(normalized, env);
});

test('normalizeEnv: returns same object when nothing changes', () => {
  const env = { NOMO_FOO: 'bar' };
  const normalized = normalizeEnv(env, ['NOMO_FOO']);
  assert.strictEqual(normalized, env);
});

test('normalizeEnv: an empty current value is not replaced by the legacy one', () => {
  const normalized = normalizeEnv({ NOMO_FOO: '', VOID_FOO: 'old' }, ['NOMO_FOO']);
  assert.strictEqual(normalized.NOMO_FOO, '');
});

test('readAuthConfig: legacy seal key and public origin still configure auth', () => {
  const config = readAuthConfig({
    ...APPWRITE,
    VOID_AUTH_SEAL_KEY: SEAL,
    VOID_PUBLIC_ORIGIN: 'https://chat.example.test',
  });
  assert.strictEqual(config.sealKey, SEAL);
  assert.strictEqual(config.publicOrigin, 'https://chat.example.test');
});

test('readAuthConfig: a NOMO value wins over the legacy one', () => {
  const config = readAuthConfig({
    ...APPWRITE,
    NOMO_AUTH_SEAL_KEY: SEAL,
    VOID_AUTH_SEAL_KEY: 'b'.repeat(64),
    NOMO_PUBLIC_ORIGIN: 'https://new.example.test',
    VOID_PUBLIC_ORIGIN: 'https://old.example.test',
  });
  assert.strictEqual(config.sealKey, SEAL);
  assert.strictEqual(config.publicOrigin, 'https://new.example.test');
});

test('readAuthConfig: a legacy Appwrite name is not aliased', () => {
  assert.throws(
    () => readAuthConfig({ ...APPWRITE, VOID_APPWRITE_PROJECT_ID: 'project', VOID_PUBLIC_ORIGIN: 'https://chat.example.test' }),
    /NOMO_AUTH_SEAL_KEY/,
  );
});

test('readAuthConfig: the failure names the variables and never a value', () => {
  assert.throws(
    () => readAuthConfig({ ...APPWRITE, VOID_PUBLIC_ORIGIN: 'https://chat.example.test' }),
    (error) => {
      assert.match(error.message, /NOMO_AUTH_SEAL_KEY/);
      assert.doesNotMatch(error.message, /runtime-key/);
      return true;
    },
  );
});

test('billingFromEnv: legacy Polar names alone still produce a service', () => {
  assert.ok(billingFromEnv({ ...POLAR_LEGACY, VOID_POLAR_PRODUCT_TEAM: 'legacy-team' }));
});

test('billingFromEnv: the legacy product name is the one that counts', async () => {
  assert.strictEqual(
    await isSubscribed({ ...POLAR_LEGACY, VOID_POLAR_PRODUCT_TEAM: 'legacy-team' }, 'legacy-team'),
    true,
  );
});

test('billingFromEnv: a NOMO name wins over the legacy one', async () => {
  const env = {
    ...POLAR_LEGACY,
    NOMO_POLAR_PRODUCT_TEAM: 'current-team',
    VOID_POLAR_PRODUCT_TEAM: 'legacy-team',
  };
  assert.strictEqual(await isSubscribed(env, 'current-team'), true);
  assert.strictEqual(await isSubscribed(env, 'legacy-team'), false);
});

test('billingFromEnv: an empty NOMO secret does not fall back to the legacy one', () => {
  const service = billingFromEnv({ ...POLAR_LEGACY, NOMO_POLAR_WEBHOOK_SECRET: '' });
  assert.strictEqual(service, undefined);
});

test('signupAllowed: legacy name opens signup, current name closes it again', () => {
  assert.strictEqual(signupAllowed({ VOID_ACCOUNT_SIGNUP: '1' }), true);
  assert.strictEqual(signupAllowed({ NOMO_ACCOUNT_SIGNUP: '0', VOID_ACCOUNT_SIGNUP: '1' }), false);
});
