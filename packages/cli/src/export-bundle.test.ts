import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOperation } from './operations.ts';
import { devKeyProvider } from '../../ledger/src/sign.ts';
import { jsonlStore } from '../../ledger/src/store.ts';
import { reservedRecoveryVault } from '../../runtime/src/reserved-vault.ts';
import {
  BUNDLE_SECTIONS,
  MANIFEST_FILE,
  type BundleManifest,
} from './export-bundle.ts';
import type { MetricsReport } from './metrics.ts';
import type { KeyProvider } from '../../ledger/src/index.ts';

const WORKSPACE = 'test';

type Fixture = {
  readonly root: string;
  readonly stateDir: string;
  readonly ledgerPath: string;
  readonly journalPath: string;
  readonly bundleDir: string;
  readonly env: Readonly<Record<string, string>>;
  readonly signer: KeyProvider;
};

const operationEvent = (operationId: string, stage: string) => ({
  schema: 'void.operation.v1' as const,
  workspace: WORKSPACE,
  operationId,
  requestDigest: 'b'.repeat(64),
  adapterId: 'filesystem.managed',
  adapterVersion: '1',
  agentId: 'agent',
  runId: 'run',
  at: '2026-09-25T10:00:00.000Z',
  stage,
  data: null,
});

/** Ledger, journal and vault in the layout the recovery backup reads. */
async function fixture(t: { after: (fn: () => unknown) => void }): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'nomo-r14-bundle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, 'state');
  const ledgerDir = join(root, 'ledger');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await mkdir(ledgerDir, { recursive: true, mode: 0o700 });
  const signer = await devKeyProvider({ dir: join(stateDir, 'keys'), env: {} });
  const env = {
    NOMO_SIGNING_KEY: (
      await readFile(join(stateDir, 'keys', 'dev-ed25519.pkcs8'))
    ).toString('base64'),
  };
  const ledger = jsonlStore(signer, { dir: ledgerDir });
  for (const decision of ['allow', 'allow', 'deny'] as const)
    await ledger.append({
      workspace: WORKSPACE,
      at: '2026-09-25T10:00:00.000Z',
      tool: 'fixture.echo',
      klass: 'r0',
      decision,
      argsDigest: 'a'.repeat(64),
    });
  const journal = jsonlStore(signer, { dir: join(stateDir, 'journal') });
  for (const stage of ['received', 'authorized', 'prepared', 'dispatched', 'succeeded'] as const)
    await journal.append(operationEvent('op-1', stage));
  for (const stage of ['received', 'authorized', 'prepared', 'dispatched', 'unknown'] as const)
    await journal.append(operationEvent('op-2', stage));
  const vault = reservedRecoveryVault(
    join(stateDir, 'vault'),
    { local: randomBytes(32) },
    'local',
    { maxArtifactBytes: 4096, maxTotalBytes: 65_536 },
  );
  await vault.put(WORKSPACE, 'first artifact');
  await vault.put(WORKSPACE, 'second artifact');
  return {
    root,
    stateDir,
    signer,
    env,
    ledgerPath: join(ledgerDir, `${WORKSPACE}.jsonl`),
    journalPath: join(stateDir, 'journal', `${WORKSPACE}.jsonl`),
    bundleDir: join(root, 'bundle'),
  };
}

const run = async (
  command: string,
  argv: readonly string[],
  env: Readonly<Record<string, string>>,
): Promise<string[]> => {
  const out: string[] = [];
  assert.equal(await runOperation(command, argv, env, (text) => out.push(text)), 0);
  return out;
};

/** The command may emit one multi-line block; assertions work on lines. */
const lines = (emitted: readonly string[]): string[] =>
  emitted.join('\n').split('\n');

/** Export a bundle and return the manifest digest the operator has to record. */
const exportBundle = async (f: Fixture): Promise<string> => {
  const printed = lines(
    await run(
      'export',
      ['--ledger', f.ledgerPath, '--state', f.stateDir, '--bundle', f.bundleDir],
      f.env,
    ),
  );
  const anchor = printed.find((line) => line.startsWith('manifest sha256 '));
  assert.ok(anchor, `export printed no manifest digest: ${printed.join(' | ')}`);
  return anchor.split(' ')[2]!;
};

const manifestOf = async (dir: string): Promise<BundleManifest> =>
  JSON.parse(await readFile(join(dir, MANIFEST_FILE), 'utf8'));

/** The digest an operator would record after rewriting the manifest. */
const anchorOf = async (dir: string): Promise<string> =>
  createHash('sha256')
    .update(await readFile(join(dir, MANIFEST_FILE)))
    .digest('hex');

const counters = async (
  argv: readonly string[],
  f: Fixture,
): Promise<Map<string, number>> => {
  const out = await run('metrics', [...argv, '--format', 'json'], f.env);
  const counts = new Map<string, number>();
  for (const sample of (JSON.parse(out[0]!) as MetricsReport).samples) {
    const labels = Object.entries(sample.labels ?? {})
      .map(([key, value]) => `${key}="${value}"`)
      .join(',');
    counts.set(`${sample.name}${labels ? `{${labels}}` : ''}`, sample.value);
  }
  return counts;
};

test('an export bundle round-trips: four proved sections and a verified claim', async t => {
  const f = await fixture(t);
  const printed = lines(
    await run(
      'export',
      ['--ledger', f.ledgerPath, '--state', f.stateDir, '--bundle', f.bundleDir],
      f.env,
    ),
  );
  assert.equal(printed[0], `workspace ${WORKSPACE}`);
  assert.equal(printed.at(-1), 'complete true');
  const anchor = printed.find((line) => line.startsWith('manifest sha256 '))!.split(' ')[2]!;
  assert.match(anchor, /^[a-f0-9]{64}$/);

  const manifest = await manifestOf(f.bundleDir);
  assert.deepEqual(manifest.sections.map((item) => item.name), [...BUNDLE_SECTIONS]);
  assert.equal(manifest.complete, true);
  assert.deepEqual(
    Object.fromEntries(manifest.sections.map((item) => [item.name, item.entries])),
    { ledger: 3, journal: 10, 'vault-manifest': 2, capability: 7 },
  );
  assert.deepEqual(
    { first: manifest.sections[0]!.firstSeq, last: manifest.sections[0]!.lastSeq },
    { first: 1, last: 3 },
  );
  // Every declared digest and byte count is the one recomputed from the bytes.
  for (const item of manifest.sections) {
    const bytes = await readFile(join(f.bundleDir, item.file));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), item.sha256);
    assert.equal(bytes.length, item.bytes);
  }
  const exported = (await readFile(join(f.bundleDir, 'ledger.jsonl'), 'utf8'))
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as { hash: string });
  assert.equal(exported.length, 3);
  assert.equal(manifest.ledgerHead, exported[2]!.hash);

  const verified = lines(
    await run(
      'export',
      ['verify', '--bundle', f.bundleDir, '--anchor', anchor, '--state', f.stateDir],
      f.env,
    ),
  );
  assert.equal(verified.at(-1), 'complete true');
  assert.ok(verified.includes('journal signatures checked'));
  assert.ok(verified.includes('vault artifacts 2 (sqlite store)'));
  assert.ok(
    verified.includes(
      `section ledger entries=3 bytes=${manifest.sections[0]!.bytes} sha256=${manifest.sections[0]!.sha256}`,
    ),
  );
});

test('a section rewritten in place is refused by its digest', async t => {
  const f = await fixture(t);
  const anchor = await exportBundle(f);
  const vaultManifest = JSON.parse(
    await readFile(join(f.bundleDir, 'vault-manifest.json'), 'utf8'),
  ) as { artifacts: { contentDigest: string }[] };
  // Same length, still valid JSON, one flipped hex character: only the digest sees it.
  vaultManifest.artifacts[0]!.contentDigest = vaultManifest.artifacts[0]!.contentDigest.replace(
    /^./,
    (character) => (character === '0' ? '1' : '0'),
  );
  await writeFile(
    join(f.bundleDir, 'vault-manifest.json'),
    `${JSON.stringify(vaultManifest, null, 2)}\n`,
  );
  await assert.rejects(
    run('export', ['verify', '--bundle', f.bundleDir, '--anchor', anchor], f.env),
    /Section digest does not match the manifest/,
  );
});

test('a truncated ledger section is refused, and so is a wrong anchor', async t => {
  const f = await fixture(t);
  const anchor = await exportBundle(f);
  await assert.rejects(
    run('export', ['verify', '--bundle', f.bundleDir, '--anchor', '0'.repeat(64)], f.env),
    /does not match the presented anchor/,
  );
  const lines = (await readFile(join(f.bundleDir, 'ledger.jsonl'), 'utf8')).split('\n');
  // A stalled history is still internally consistent, so the digest catches the cut.
  await writeFile(join(f.bundleDir, 'ledger.jsonl'), `${lines.slice(0, 2).join('\n')}\n`);
  await assert.rejects(
    run('export', ['verify', '--bundle', f.bundleDir, '--anchor', anchor], f.env),
    /Section digest does not match the manifest/,
  );
});
test('a re-declared manifest still has to agree with the bytes it describes', async t => {
  const f = await fixture(t);
  await exportBundle(f);
  // The attacker also controls the manifest and presents their own digest, which
  // is exactly what the section checks are for: a claim is not a measurement.
  const manifest = JSON.parse(
    await readFile(join(f.bundleDir, MANIFEST_FILE), 'utf8'),
  ) as { sections: { name: string; entries: number; lastSeq: number | null }[] };
  const ledger = manifest.sections.find((item) => item.name === 'ledger')!;
  ledger.lastSeq = 99;
  await writeFile(
    join(f.bundleDir, MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await assert.rejects(
    run(
      'export',
      ['verify', '--bundle', f.bundleDir, '--anchor', await anchorOf(f.bundleDir)],
      f.env,
    ),
    /sequence range does not match the manifest/,
  );
  const capability = manifest.sections.find((item) => item.name === 'capability')!;
  capability.entries = 6;
  ledger.lastSeq = 3;
  await writeFile(
    join(f.bundleDir, MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await assert.rejects(
    run(
      'export',
      ['verify', '--bundle', f.bundleDir, '--anchor', await anchorOf(f.bundleDir)],
      f.env,
    ),
    /record count does not match the manifest/,
  );
});

test('a missing section is refused and never counted as complete', async t => {
  const f = await fixture(t);
  const anchor = await exportBundle(f);
  await rm(join(f.bundleDir, 'capability.json'));
  await assert.rejects(
    run('export', ['verify', '--bundle', f.bundleDir, '--anchor', anchor], f.env),
    /Bundle section is missing/,
  );
  await assert.rejects(
    run('export', ['verify', '--bundle', f.bundleDir, '--anchor', 'nope'], f.env),
    /trusted manifest digest must be presented/,
  );
});

test('an export without a journal section fails closed and writes no claim', async t => {
  const f = await fixture(t);
  await rm(f.journalPath);
  await assert.rejects(
    run(
      'export',
      ['--ledger', f.ledgerPath, '--state', f.stateDir, '--bundle', f.bundleDir],
      f.env,
    ),
    /Operation journal for the workspace is unavailable/,
  );
  await assert.rejects(stat(f.bundleDir), /ENOENT/);
  await assert.rejects(
    run('export', ['--ledger', f.ledgerPath, '--bundle', f.bundleDir], f.env),
    /--state is required/,
  );
});

test('a journal the transition table rejects is refused', async t => {
  const f = await fixture(t);
  const journal = jsonlStore(f.signer, { dir: join(f.stateDir, 'journal') });
  await journal.append(operationEvent('op-3', 'imaginary'));
  await assert.rejects(
    run(
      'export',
      ['--ledger', f.ledgerPath, '--state', f.stateDir, '--bundle', f.bundleDir],
      f.env,
    ),
    /does not replay under the transition tables/,
  );
  await assert.rejects(stat(f.bundleDir), /ENOENT/);
});

test('a bundle is never written twice into the same directory', async t => {
  const f = await fixture(t);
  await exportBundle(f);
  await assert.rejects(
    run(
      'export',
      ['--ledger', f.ledgerPath, '--state', f.stateDir, '--bundle', f.bundleDir],
      f.env,
    ),
    /already exists/,
  );
});

test('a journal signed by another key is refused at export time', async t => {
  const f = await fixture(t);
  const other = await devKeyProvider({ dir: join(f.root, 'other-keys'), env: {} });
  assert.notEqual(await other.currentKeyId(), await f.signer.currentKeyId());
  // Same workspace, same event shape, a key the export does not hold.
  await rm(f.journalPath);
  const foreign = jsonlStore(other, { dir: join(f.stateDir, 'journal') });
  await foreign.append(operationEvent('op-1', 'received'));
  await assert.rejects(
    run(
      'export',
      ['--ledger', f.ledgerPath, '--state', f.stateDir, '--bundle', f.bundleDir],
      f.env,
    ),
    /Journal section could not be verified/,
  );
  await assert.rejects(stat(f.bundleDir), /ENOENT/);
});

test('a bundle verification without a state directory says what it did not check', async t => {
  const f = await fixture(t);
  const anchor = await exportBundle(f);
  const verified = lines(
    await run(
      'export',
      ['verify', '--bundle', f.bundleDir, '--anchor', anchor],
      f.env,
    ),
  );
  assert.ok(
    verified.includes(
      'journal signatures not checked: pass --state <dir> holding the retained key',
    ),
  );
  assert.equal(verified.at(-1), 'complete true');
});

test('metrics count a known fixture ledger, journal and vault exactly', async t => {
  const f = await fixture(t);
  const counts = await counters(['--ledger', f.ledgerPath, '--state', f.stateDir], f);
  assert.equal(counts.get('nomo_ledger_files_total'), 1);
  assert.equal(counts.get('nomo_ledger_files_verified_total'), 1);
  assert.equal(counts.get('nomo_ledger_files_unreadable_total'), 0);
  assert.equal(counts.get('nomo_ledger_files_rejected_total'), 0);
  assert.equal(counts.get('nomo_ledger_entries_total'), 3);
  assert.equal(counts.get('nomo_ledger_bytes_total'), (await stat(f.ledgerPath)).size);
  assert.equal(counts.get('nomo_ledger_decisions_total{decision="allow"}'), 2);
  assert.equal(counts.get('nomo_ledger_decisions_total{decision="deny"}'), 1);
  assert.equal(counts.get('nomo_ledger_decisions_total{decision="hold"}'), 0);
  assert.equal(counts.get('nomo_ledger_decisions_total{decision="other"}'), 0);
  // Stage universe and edge counts come from the journal transition table.
  assert.equal(counts.get('nomo_transition_operation_states_total'), 13);
  assert.equal(counts.get('nomo_transition_operation_edges_total'), 21);
  assert.equal(counts.get('nomo_transition_operation_terminal_states_total'), 5);
  assert.equal(counts.get('nomo_transition_recovery_job_states_total'), 9);
  assert.equal(counts.get('nomo_transition_recovery_job_edges_total'), 16);
  assert.equal(counts.get('nomo_transition_recovery_job_terminal_states_total'), 3);
  assert.equal(counts.get('nomo_journal_present'), 1);
  assert.equal(counts.get('nomo_journal_events_total'), 10);
  assert.equal(counts.get('nomo_journal_operation_stage_events_total{stage="received"}'), 2);
  assert.equal(counts.get('nomo_journal_operation_stage_events_total{stage="authorized"}'), 2);
  assert.equal(counts.get('nomo_journal_operation_stage_events_total{stage="prepared"}'), 2);
  assert.equal(counts.get('nomo_journal_operation_stage_events_total{stage="dispatched"}'), 2);
  assert.equal(counts.get('nomo_journal_operation_stage_events_total{stage="succeeded"}'), 1);
  assert.equal(counts.get('nomo_journal_operation_stage_events_total{stage="unknown"}'), 1);
  assert.equal(counts.get('nomo_journal_operation_stage_events_total{stage="denied"}'), 0);
  assert.equal(counts.get('nomo_journal_operation_stage_events_total{stage="conflict"}'), 0);
  assert.equal(counts.get('nomo_journal_recovery_job_stage_events_total{stage="planned"}'), 0);
  assert.equal(counts.get('nomo_vault_present'), 1);
  assert.equal(counts.get('nomo_vault_artifacts_total{store="sqlite"}'), 2);
  assert.ok((counts.get('nomo_vault_bytes_total') ?? 0) > 0);
  assert.equal(counts.get('nomo_vault_unsettled_total'), 0);
  // Every stage in the table is reported, so an unreached stage shows as zero.
  assert.equal(
    [...counts.keys()].filter((key) =>
      key.startsWith('nomo_journal_operation_stage_events_total'),
    ).length,
    13,
  );
  assert.equal(
    [...counts.keys()].filter((key) =>
      key.startsWith('nomo_journal_recovery_job_stage_events_total'),
    ).length,
    9,
  );
});

test('metrics count unreadable and rejected ledgers apart in a directory scan', async t => {
  const f = await fixture(t);
  const scan = join(f.root, 'scan');
  await mkdir(scan);
  await copyFile(f.ledgerPath, join(scan, 'good.jsonl'));
  await writeFile(
    join(scan, 'tampered.jsonl'),
    (await readFile(f.ledgerPath, 'utf8')).replace('"deny"', '"hold"'),
  );
  await writeFile(join(scan, 'broken.jsonl'), 'not a ledger line\n');
  const counts = await counters(['--ledger', scan], f);
  assert.equal(counts.get('nomo_ledger_files_total'), 3);
  assert.equal(counts.get('nomo_ledger_files_verified_total'), 1);
  assert.equal(counts.get('nomo_ledger_files_unreadable_total'), 1);
  assert.equal(counts.get('nomo_ledger_files_rejected_total'), 1);
  assert.equal(counts.get('nomo_ledger_entries_total'), 3);
  assert.equal(counts.get('nomo_ledger_decisions_total{decision="allow"}'), 2);
  assert.equal(counts.get('nomo_ledger_decisions_total{decision="hold"}'), 0);
});

test('metrics refuse a named ledger that does not verify', async t => {
  const f = await fixture(t);
  await writeFile(
    f.ledgerPath,
    (await readFile(f.ledgerPath, 'utf8')).replace('"deny"', '"hold"'),
  );
  await assert.rejects(
    run('metrics', ['--ledger', f.ledgerPath], f.env),
    /ledger chain invalid/,
  );
});
