import { readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { appendAnchor } from '../../ledger/src/anchor.ts';
import { attestLedger, parseAttestationDocument, storeAttestation } from '../../ledger/src/attest.ts';
import { devKeyProvider, retainedKeyProvider } from '../../ledger/src/sign.ts';
import { resolveVerificationKey, verificationKeyFromBase64, verificationKeyLine } from '../../ledger/src/verify-key.ts';
import { readLedgerEntries, verifyChain } from '../../ledger/src/verify.ts';
import { listPacks, loadPack } from '../../policy/src/packs.ts';
import { loadPolicy } from '../../policy/src/rules.ts';
import { createBundle, describeBundle, verifyBundle } from './export-bundle.ts';
import { collectMetrics, renderMetricsJson, renderMetricsText } from './metrics.ts';
import { resolveLedgerTarget } from './ledger-target.ts';

const LEDGER_FLAGS = ['--ledger', '--workspace'] as const;
const BUNDLE_FLAGS = [...LEDGER_FLAGS, '--state', '--bundle', '--anchor', '--attestation', '--key'] as const;
const ATTEST_FLAGS = [...LEDGER_FLAGS, '--anchor'] as const;
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
    if (flags.has(arg)) {
      throw new Error(`duplicate option ${arg}`);
    }
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value`);
    flags.set(arg, value);
  }
  return { flags, positional };
}

/**
 * `nomo export`, `nomo attest` and `nomo metrics` resolve their ledger through
 * the same helper `nomo verify` uses, so a missing path is answered the same
 * way everywhere instead of three times with three messages.
 */
function requestedWorkspace(flags: ReadonlyMap<string, string>): string {
  const requested = flags.get('--workspace') ?? 'default';
  if (!/^[A-Za-z0-9_-]+$/.test(requested)) throw new Error('invalid workspace');
  return requested;
}

/** Export and attest read one workspace, so a directory means its workspace file. */
async function ledgerPath(flags: ReadonlyMap<string, string>, env: Readonly<NodeJS.ProcessEnv>): Promise<{ ledger: string; workspace: string }> {
  const resolution = await resolveLedgerTarget({ mode: 'workspace', ledger: flags.get('--ledger'), workspace: requestedWorkspace(flags), env });
  if (!resolution.ok) throw new Error(resolution.message);
  return { ledger: resolution.path, workspace: basename(resolution.path, '.jsonl') };
}

export async function runOperation(command: string, argv: readonly string[], env: Readonly<NodeJS.ProcessEnv>, output: (text: string) => void, error: (text: string) => void = console.error): Promise<number> {
  if (command === 'policy') {
    if (argv.length === 0 || (argv.length === 1 && argv[0] === 'list')) { output(listPacks().join('\n')); return 0; }
    if (argv.length === 2 && argv[0] === 'show') { output(JSON.stringify(await loadPack(argv[1]!), null, 2)); return 0; }
    if (argv.length === 2 && argv[0] === 'validate') {
      const result = loadPolicy(await readFile(argv[1]!, 'utf8'));
      if (!result.ok) throw new Error(`Policy is invalid; fix its structure before starting the proxy: ${result.errors.join('; ')}`);
      output('Policy valid'); return 0;
    }
    throw new Error('usage: nomo policy list | show <strict|balanced|dev> | validate <file>');
  }
  if (command === 'metrics') {
    const { flags } = parse(argv, METRICS_FLAGS);
    const format = flags.get('--format');
    if (format !== undefined && format !== 'json' && format !== 'text')
      throw new Error('--format is json or text');
    // Metrics accept a ledger directory on purpose: a scan counts the ledgers
    // that do not verify, which is why it does not resolve to one workspace file.
    // A directory that is merely empty is therefore a measurement of zeroes, not
    // a refusal; what cannot be measured is a path that is absent or unreadable,
    // and that exits non-zero so a probe cannot record a healthy pipeline while
    // nothing was counted.
    const resolution = await resolveLedgerTarget({ mode: 'scan', ledger: flags.get('--ledger'), workspace: requestedWorkspace(flags), env });
    if (!resolution.ok) {
      error(`nomo metrics measured nothing\n  ${resolution.message}`);
      return 1;
    }
    const state = flags.get('--state');
    const signer = await devKeyProvider({ env });
    // A state directory without retained key material still yields metrics; the
    // report then says the journal was read without checking its signatures.
    const journal = state
      ? await retainedKeyProvider({ dir: join(state, 'keys') }).catch(() => null)
      : null;
    const report = await collectMetrics({
      ledgerPath: resolution.path,
      stateDir: state,
      publicKey: (id) => signer.publicKey(id),
      journalPublicKey: journal ? (id) => journal.publicKey(id) : undefined,
    });
    output(format === 'json' ? renderMetricsJson(report) : renderMetricsText(report));
    return 0;
  }
  const { flags, positional } = parse(
    argv,
    command === 'export' ? BUNDLE_FLAGS : command === 'attest' ? ATTEST_FLAGS : LEDGER_FLAGS,
  );
  const state = flags.get('--state');
  // A reviewer holds the bundle and the anchor, not a local ledger: bundle
  // verification is decided by the bundle's own bytes.
  if (command === 'export' && positional[0] === 'verify') {
    const bundleDir = flags.get('--bundle');
    const anchor = flags.get('--anchor');
    if (!bundleDir || !anchor || positional.length > 1)
      throw new Error('usage: nomo export verify --bundle <dir> --anchor <manifest-sha256> --key <base64-spki> [--attestation anchor.json] [--state <dir>]');
    // A reviewer holds a bundle and the key that signed it, not a local
    // ledger. `--key` is how that key is handed in, and it leads the remedy:
    // telling an unconfigured reviewer to run `nomo init --pin-verify-key`
    // mints a key of their own and pins that, which matches nothing and fails
    // confusingly later. A verifier must not mint key material either way, so
    // an unconfigured review is a refusal.
    const supplied = flags.get('--key');
    const reviewer = supplied === undefined
      ? await resolveVerificationKey({ env })
      : verificationKeyFromBase64(supplied, '--key');
    if (!reviewer) throw new Error('A verification key is required: pass --key <base64-spki>, or set NOMO_VERIFY_KEY. Do not run `nomo init --pin-verify-key` to get one: that mints a key of your own and pins it.');
    const journal = state ? await retainedKeyProvider({ dir: join(state, 'keys') }) : null;
    const attestation = flags.get('--attestation');
    const verification = await verifyBundle({
      bundleDir,
      anchor,
      publicKey: reviewer.publicKey,
      journalPublicKey: journal ? (id) => journal.publicKey(id) : undefined,
      attestation: attestation === undefined ? undefined : parseAttestationDocument(JSON.parse(await readFile(attestation, 'utf8')), attestation),
    });
    output([
      `workspace ${verification.workspace}`,
      `bundle ${bundleDir}`,
      ...verification.sections.map((item) => `section ${item.name} entries=${item.entries} bytes=${item.bytes} sha256=${item.sha256}`),
      `vault artifacts ${verification.vault.artifacts.length} (${verification.vault.store} store)`,
      `journal signatures ${verification.signed.journal ? 'checked' : 'not checked: pass --state <dir> holding the retained key'}`,
      verificationKeyLine(reviewer),
      `manifest sha256 ${verification.manifestDigest}`,
      'complete true',
    ].join('\n'));
    return 0;
  }
  const { ledger, workspace } = await ledgerPath(flags, env);
  const signer = await devKeyProvider({ env });
  // The recorder signs; a pinned public key verifies when there is one, and
  // the recorder's own key is the reported fallback rather than a silent one.
  const verification = await resolveVerificationKey({ env, allowDegraded: true, signingKey: async () => signer });
  if (!verification) throw new Error('No verification key is available; pin one with `nomo init --pin-verify-key`.');
  const entries = await readLedgerEntries(ledger);
  const result = await verifyChain(entries, { publicKey: verification.publicKey });
  if (!result.ok) throw new Error('Ledger verification failed; export and attestation refused.');
  if (command === 'attest') {
    if (positional.length > 0) throw new Error('usage: nomo attest [--ledger <file> | --workspace <name>] [--anchor <file>]');
    const doc = await attestLedger(dirname(ledger), workspace, signer);
    const retained = await storeAttestation(dirname(ledger), doc);
    output(JSON.stringify(doc, null, 2));
    output(verificationKeyLine(verification));
    output(`anchor: signed head ${doc.headSeq} ${doc.headHash} over ${doc.entriesCount} entries under ${doc.key_id}`);
    output(`retained copy: ${retained} (same trust domain as the ledger, so not an anchor on its own)`);
    const published = flags.get('--anchor');
    if (published === undefined)
      output('publish it out of band to anchor this head: nomo attest --anchor <a file the agent cannot write>');
    else {
      await appendAnchor(published, doc);
      output(`anchor appended: ${published}`);
      output('an anchor only protects this head if the agent process cannot rewrite that file; keep a copy you control');
    }
  }
  else if (command === 'export' && flags.has('--bundle')) {
    if (!state) throw new Error('--state is required: the journal and vault sections cannot be declared without it');
    if (positional.length > 0) throw new Error('usage: nomo export --ledger <file> --state <dir> --bundle <dir>');
    const journal = await retainedKeyProvider({ dir: join(state, 'keys') });
    const created = await createBundle({
      ledgerPath: ledger,
      stateDir: state,
      bundleDir: flags.get('--bundle')!,
      publicKey: verification.publicKey,
      journalPublicKey: (id) => journal.publicKey(id),
    });
    // The bundle was verified with the recorder's own key unless the operator
    // supplied one, and the summary says nothing about which. Reporting the
    // source is what makes the bundle's own manifest digest meaningful. It
    // goes inside the summary block, one line above the terminator: the block
    // is positionally meaningful, opening with `workspace` and closing with
    // `complete true`, so emitting it outside the block would displace one of
    // the two markers callers rely on.
    output(describeBundle(created, verificationKeyLine(verification)).join('\n'));
  }
  else if (command === 'export') {
    if (positional.length > 0) throw new Error('usage: nomo export [--ledger <file> | --workspace <name>]');
    output(entries.map(entry => JSON.stringify(entry)).join('\n'));
  }
  else throw new Error('unknown operation');
  return 0;
}
