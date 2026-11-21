import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { envValue, legacyEnvKey, normalizeEnv } from './env.mjs';
import { billingFromEnv } from './billing.mjs';
import { signupAllowed } from './account.mjs';

const POLAR_LEGACY = {
  NOMO_POLAR_ENVIRONMENT: 'sandbox',
  NOMO_POLAR_ACCESS_TOKEN: 'access',
  NOMO_POLAR_ORGANIZATION_ID: 'org',
  NOMO_POLAR_WEBHOOK_SECRET: 'webhook',
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
  const env = { NOMO_DATA_DIR: 'bar' };
  assert.strictEqual(envValue(env, 'NOMO_DATA_DIR'), 'bar');
});

test('envValue: NOMO wins', () => {
  const env = { NOMO_DATA_DIR: 'new', VOID_DATA_DIR: 'old' };
  assert.strictEqual(envValue(env, 'NOMO_DATA_DIR'), 'new');
});

test('envValue: empty NOMO wins', () => {
  const env = { NOMO_DATA_DIR: '', VOID_DATA_DIR: 'old' };
  assert.strictEqual(envValue(env, 'NOMO_DATA_DIR'), '');
});

test('envValue: neither set returns undefined', () => {
  const env = {};
  assert.strictEqual(envValue(env, 'NOMO_DATA_DIR'), undefined);
});

test('envValue: non-NOMO prefixed key throws', () => {
  assert.throws(() => envValue({}, 'FOO_BAR'), /must start with NOMO_/);
});

test('envValue: does not mutate input', () => {
  const env = Object.freeze({ NOMO_DATA_DIR: 'bar' });
  assert.strictEqual(envValue(env, 'NOMO_DATA_DIR'), 'bar');
});

test('legacyEnvKey: swaps only the prefix', () => {
  assert.strictEqual(legacyEnvKey('NOMO_ACCOUNT_SEAL_KEY'), 'VOID_ACCOUNT_SEAL_KEY');
  assert.strictEqual(legacyEnvKey('NOMO_DATA_DIR'), 'VOID_DATA_DIR');
});

test('normalizeEnv: returns new object with legacy values', () => {
  const env = { VOID_DATA_DIR: 'bar' };
  const normalized = normalizeEnv(env, ['NOMO_DATA_DIR']);
  assert.deepStrictEqual(normalized, { VOID_DATA_DIR: 'bar', NOMO_DATA_DIR: 'bar' });
  assert.notStrictEqual(normalized, env);
});

test('normalizeEnv: returns same object when nothing changes', () => {
  const env = { NOMO_DATA_DIR: 'bar' };
  const normalized = normalizeEnv(env, ['NOMO_DATA_DIR']);
  assert.strictEqual(normalized, env);
});

test('normalizeEnv: an empty current value is not replaced by the legacy one', () => {
  const normalized = normalizeEnv({ NOMO_DATA_DIR: '', VOID_DATA_DIR: 'old' }, ['NOMO_DATA_DIR']);
  assert.strictEqual(normalized.NOMO_DATA_DIR, '');
});

test('billingFromEnv: legacy Polar names alone still produce a service', () => {
  assert.ok(billingFromEnv({ ...POLAR_LEGACY, NOMO_POLAR_PRODUCT_TEAM: 'legacy-team' }));
});

test('billingFromEnv: the legacy product name is the one that counts', async () => {
  assert.strictEqual(
    await isSubscribed({ ...POLAR_LEGACY, NOMO_POLAR_PRODUCT_TEAM: 'legacy-team' }, 'legacy-team'),
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
  assert.strictEqual(signupAllowed({ NOMO_ACCOUNT_SIGNUP: '1' }), true);
  assert.strictEqual(signupAllowed({ NOMO_ACCOUNT_SIGNUP: '0', VOID_ACCOUNT_SIGNUP: '1' }), false);
});
