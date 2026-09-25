import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { attestLedger } from '../../ledger/src/attest.ts';
import { devKeyProvider, retainedKeyProvider } from '../../ledger/src/sign.ts';
import { readLedgerEntries, verifyChain } from '../../ledger/src/verify.ts';
import { listPacks, loadPack } from '../../policy/src/packs.ts';
import { loadPolicy } from '../../policy/src/rules.ts';
import { createBundle, describeBundle, verifyBundle } from './export-bundle.ts';
import { collectMetrics, renderMetricsJson, renderMetricsText } from './metrics.ts';

const LEDGER_FLAGS = ['--ledger', '--workspace'] as const;
const BUNDLE_FLAGS = [...LEDGER_FLAGS, '--state', '--bundle', '--anchor'] as const;
const METRICS_FLAGS = [...LEDGER_FLAGS, '--state', '--format'] as const;

type Invocation = {
  readonly flags: ReadonlyMap<string, string>;
  readonly positional: readonly string[];
};

/** Flags carry a value, a bare word is a subcommand, an unknown `--flag` is a refusal. */
function parse(argv: readonly string[], allowed: readonly string[]): Invocation {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (!allowed.includes(arg)) {
      if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
      positional.push(arg);
      continue;
    }
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value`);
    flags.set(arg, value);
  }
  return { flags, positional };
}

/** The ledger or ledger directory the operator named, or the default location. */
function ledgerTarget(flags: ReadonlyMap<string, string>, env: Readonly<NodeJS.ProcessEnv>): string {
  const requested = flags.get('--workspace') ?? 'default';
  if (!/^[A-Za-z0-9_-]+$/.test(requested)) throw new Error('invalid workspace');
  return flags.get('--ledger') ?? join(env.VOID_LEDGER_DIR ?? join(homedir(), '.void', 'ledger'), `${requested}.jsonl`);
}

/** Export and attest read one workspace, so a directory means its workspace file. */
async function ledgerPath(flags: ReadonlyMap<string, string>, env: Readonly<NodeJS.ProcessEnv>): Promise<{ ledger: string; workspace: string }> {
  const requested = flags.get('--workspace') ?? 'default';
  let ledger = ledgerTarget(flags, env);
  if ((await stat(ledger)).isDirectory()) ledger = join(ledger, `${requested}.jsonl`);
  return { ledger, workspace: basename(ledger, '.jsonl') };
}

export async function runOperation(command: string, argv: readonly string[], env: Readonly<NodeJS.ProcessEnv>, output: (text: string) => void): Promise<number> {
  if (command === 'policy') {
    if (argv.length === 0 || (argv.length === 1 && argv[0] === 'list')) { output(listPacks().join('\n')); return 0; }
    if (argv.length === 2 && argv[0] === 'show') { output(JSON.stringify(await loadPack(argv[1]!), null, 2)); return 0; }
    if (argv.length === 2 && argv[0] === 'validate') {
      const result = loadPolicy(await readFile(argv[1]!, 'utf8'));
      if (!result.ok) throw new Error('Policy is invalid; fix its structure before starting the proxy.');
      output('Policy valid'); return 0;
    }
    throw new Error('usage: void policy list | show <strict|balanced|dev> | validate <file>');
  }
  if (command === 'metrics') {
    const { flags } = parse(argv, METRICS_FLAGS);
    const format = flags.get('--format');
    if (format !== undefined && format !== 'json' && format !== 'text')
      throw new Error('--format is json or text');
    // Metrics accept a ledger directory on purpose: a scan counts the ledgers
    // that do not verify, which is why it does not resolve to one workspace file.
    const ledger = ledgerTarget(flags, env);
    const state = flags.get('--state');
    const signer = await devKeyProvider({ env });
    // A state directory without retained key material still yields metrics; the
    // report then says the journal was read without checking its signatures.
    const journal = state
      ? await retainedKeyProvider({ dir: join(state, 'keys') }).catch(() => null)
      : null;
    const report = await collectMetrics({
      ledgerPath: ledger,
      stateDir: state,
      publicKey: (id) => signer.publicKey(id),
      journalPublicKey: journal ? (id) => journal.publicKey(id) : undefined,
    });
    output(format === 'json' ? renderMetricsJson(report) : renderMetricsText(report));
    return 0;
  }
  const { flags, positional } = parse(argv, command === 'export' ? BUNDLE_FLAGS : LEDGER_FLAGS);
  const state = flags.get('--state');
  // A reviewer holds the bundle and the anchor, not a local ledger: bundle
  // verification is decided by the bundle's own bytes.
  if (command === 'export' && positional[0] === 'verify') {
    const bundleDir = flags.get('--bundle');
    const anchor = flags.get('--anchor');
    if (!bundleDir || !anchor || positional.length > 1)
      throw new Error('usage: void export verify --bundle <dir> --anchor <manifest-sha256> [--state <dir>]');
    const signer = await devKeyProvider({ env });
    const journal = state ? await retainedKeyProvider({ dir: join(state, 'keys') }) : null;
    const verification = await verifyBundle({
      bundleDir,
      anchor,
      publicKey: (id) => signer.publicKey(id),
      journalPublicKey: journal ? (id) => journal.publicKey(id) : undefined,
    });
    output([
      `workspace ${verification.workspace}`,
      `bundle ${bundleDir}`,
      ...verification.sections.map((item) => `section ${item.name} entries=${item.entries} bytes=${item.bytes} sha256=${item.sha256}`),
      `vault artifacts ${verification.vault.artifacts.length} (${verification.vault.store} store)`,
      `journal signatures ${verification.signed.journal ? 'checked' : 'not checked: pass --state <dir> holding the retained key'}`,
      `manifest sha256 ${verification.manifestDigest}`,
      'complete true',
    ].join('\n'));
    return 0;
  }
  const { ledger, workspace } = await ledgerPath(flags, env);
  const signer = await devKeyProvider({ env });
  const entries = await readLedgerEntries(ledger);
  const result = await verifyChain(entries, { publicKey: id => signer.publicKey(id) });
  if (!result.ok) throw new Error('Ledger verification failed; export and attestation refused.');
  if (command === 'attest') output(JSON.stringify(await attestLedger(dirname(ledger), workspace, signer), null, 2));
  else if (command === 'export' && flags.has('--bundle')) {
    if (!state) throw new Error('--state is required: the journal and vault sections cannot be declared without it');
    if (positional.length > 0) throw new Error('usage: void export --ledger <file> --state <dir> --bundle <dir>');
    const journal = await retainedKeyProvider({ dir: join(state, 'keys') });
    const created = await createBundle({
      ledgerPath: ledger,
      stateDir: state,
      bundleDir: flags.get('--bundle')!,
      publicKey: (id) => signer.publicKey(id),
      journalPublicKey: (id) => journal.publicKey(id),
    });
    output(describeBundle(created).join('\n'));
  }
  else if (command === 'export') {
    if (positional.length > 0) throw new Error('usage: void export [--ledger <file> | --workspace <name>]');
    output(entries.map(entry => JSON.stringify(entry)).join('\n'));
  }
  else throw new Error('unknown operation');
  return 0;
}
