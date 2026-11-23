/** Import local credential sources only. Configuration is data, never code.
 *
 * Sources are discovered, not hardcoded to a fixed list: every entry in Prime's
 * `auth.json`, every live row in OMP's `agent.db` and the Claude Code
 * subscription file is offered when a preset or a manifest descriptor can carry
 * it. Discovery never contacts a provider, and no credential value reaches the
 * response: an operator sees an id, a name and whether it is available.
 */
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { PROVIDER_PRESETS } from '../../../packages/workbench/src/provider-defaults.ts';
import {
  isKnownProviderId,
  providerImportRoute,
} from '../../../packages/workbench/src/provider-catalog.ts';
import {
  oauthProfileFresh,
  parseClaudeCodeOAuth,
  parsePrimeOAuthEntry,
  type ProviderOAuthImport,
} from '../../../packages/workbench/src/provider-oauth.ts';
import type { ProviderAdapterConfig } from '../../../packages/workbench/src/provider-adapters/types.ts';
import {
  HOST_CLI_PROVIDERS,
  probeHostCli,
  type HostCliId,
} from '../../../packages/workbench/src/agent-runners/host-cli.ts';
import type { Workbench } from '../../../packages/workbench/src/index.ts';

type CredentialFormat =
  | 'opencode-config'
  | 'prime-models'
  | 'opencode-auth'
  | 'prime-auth'
  | 'claude-oauth'
  | 'omp'
  | 'host';

type CredentialSource = {
  readonly id: string;
  readonly name: string;
  readonly source: 'OpenCode' | 'Prime' | 'OMP' | 'Claude Code';
  readonly provider: string;
  readonly credential: 'api-key' | 'oauth' | 'host-subscription';
  readonly format: CredentialFormat;
  /** HOME-relative path, or '' for the OMP database and host sources. */
  readonly file: string;
  /** Entry name inside the file, or '' when the file has one credential. */
  readonly entry: string;
  /** The installed host that owns the login, for host-subscription sources. */
  readonly host?: HostCliId;
};

/** Sources whose ids the surfaces already use. They stay present even when the
 * file is missing or malformed, so a scan reports "unavailable" instead of
 * silently dropping a choice. */
const BASE_SOURCES: readonly CredentialSource[] = [
  { id: 'opencode:tokenrouter', name: 'TokenRouter', source: 'OpenCode', provider: 'tokenrouter', credential: 'api-key', format: 'opencode-config', file: '.config/opencode/opencode.jsonc', entry: 'tokenrouter' },
  { id: 'prime:tokenrouter', name: 'TokenRouter', source: 'Prime', provider: 'tokenrouter', credential: 'api-key', format: 'prime-models', file: '.prime/agent/models.json', entry: 'tokenrouter' },
  { id: 'opencode:zen', name: 'OpenCode Zen', source: 'OpenCode', provider: 'opencode-zen', credential: 'api-key', format: 'opencode-auth', file: '.local/share/opencode/auth.json', entry: 'opencode' },
  { id: 'prime:zen', name: 'OpenCode Zen', source: 'Prime', provider: 'opencode-zen', credential: 'api-key', format: 'prime-auth', file: '.prime/agent/auth.json', entry: 'opencode' },
  { id: 'opencode:openrouter', name: 'OpenRouter', source: 'OpenCode', provider: 'openrouter', credential: 'api-key', format: 'opencode-auth', file: '.local/share/opencode/auth.json', entry: 'openrouter' },
  { id: 'prime:openrouter', name: 'OpenRouter', source: 'Prime', provider: 'openrouter', credential: 'api-key', format: 'prime-auth', file: '.prime/agent/auth.json', entry: 'openrouter' },
  // Prime's own Anthropic subscription entry is OAuth-only, so it stays listed
  // even when absent and is never read through an API-key shape.
  { id: 'prime:anthropic', name: 'Anthropic', source: 'Prime', provider: 'anthropic', credential: 'oauth', format: 'prime-auth', file: '.prime/agent/auth.json', entry: 'anthropic' },
  { id: 'omp:nvidia', name: 'NVIDIA NIM', source: 'OMP', provider: 'nvidia', credential: 'api-key', format: 'omp', file: '', entry: '' },
  { id: 'omp:openrouter', name: 'OpenRouter', source: 'OMP', provider: 'openrouter', credential: 'api-key', format: 'omp', file: '', entry: '' },
];

/** Subscriptions that exist only behind an installed host login. They carry no
 * token, no file and no entry: the host owns the credential and NOMO only
 * probes whether the host can run the provider. */
const HOST_SOURCES: readonly CredentialSource[] = HOST_CLI_PROVIDERS.map(
  (provider) => ({
    id: provider.sourceId,
    name: provider.displayName,
    source: provider.host === 'prime-agent' ? 'Prime' : 'Claude Code',
    provider: provider.providerId,
    credential: 'host-subscription',
    format: 'host',
    file: '',
    entry: '',
    host: provider.host,
  }),
);

/** Auth files whose entries are enumerated. The entry name is the provider id
 * unless an alias says otherwise. */
const AUTH_FILES = [
  { prefix: 'opencode', file: '.local/share/opencode/auth.json', format: 'opencode-auth', source: 'OpenCode', apiKeyType: 'api' },
  { prefix: 'prime', file: '.prime/agent/auth.json', format: 'prime-auth', source: 'Prime', apiKeyType: 'api_key' },
] as const;

/** Local spellings that mean a catalog provider id. */
const PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  opencode: 'opencode-zen',
};

/** Entry names whose public source id predates dynamic discovery. */
const SOURCE_SLUGS: Readonly<Record<string, string>> = {
  opencode: 'zen',
};

const CLAUDE_CODE_CREDENTIALS = '.claude/.credentials.json';

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
}
function inside(root: string, path: string): boolean {
  const pathFromRoot = relative(root, path);
  return pathFromRoot === '' || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot));
}
function homeDirectory(env: Readonly<NodeJS.ProcessEnv>): string {
  const home = env.HOME ?? homedir();
  if (!isAbsolute(home)) throw new Error('unavailable');
  return home;
}
/** A key or token is an opaque header value: no whitespace, no environment or
 * file references, no command substitution. */
function opaqueValue(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > 8192 || /\s|\$\{|^!|^\{env:|^\{file:/.test(value)) throw new Error('unavailable');
  return value;
}
function presetFor(providerId: string) {
  return PROVIDER_PRESETS.find(preset => preset.id === providerId);
}
function importableApiKey(providerId: string): boolean {
  return presetFor(providerId) !== undefined || providerImportRoute(providerId).status === 'api-key';
}
/** A discovered entry is offered when the catalog knows the provider, even if
 * no implemented transport can carry its credential: the scan then says so
 * instead of hiding a key the operator has on disk. */
function knownForApiKey(providerId: string): boolean {
  return presetFor(providerId) !== undefined || isKnownProviderId(providerId);
}
function displayName(providerId: string): string {
  return presetFor(providerId)?.name ?? providerId;
}
async function ompDatabasePath(home: string, env: Readonly<NodeJS.ProcessEnv>): Promise<string> {
  const homeDirectory = resolve(home);
  const profileValue = env.OMP_PROFILE !== undefined ? env.OMP_PROFILE : env.PI_PROFILE;
  const profile = profileValue && profileValue !== 'default' ? profileValue : undefined;
  const agentOverride = profile ? undefined : env.PI_CODING_AGENT_DIR;
  if (agentOverride) {
    const agentDirectory = resolve(agentOverride);
    if (!inside(homeDirectory, agentDirectory)) throw new Error('unavailable');
    return join(agentDirectory, 'agent.db');
  }
  const configDirectory = env.PI_CONFIG_DIR || '.omp';
  // OMP joins PI_CONFIG_DIR to HOME even when the supplied value begins with
  // a slash. Normalize that behavior, then enforce the importer's HOME fence.
  let root = resolve(join(homeDirectory, configDirectory));
  if (!inside(homeDirectory, root)) throw new Error('unavailable');
  if (profile) {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(profile)) throw new Error('unavailable');
    root = join(root, 'profiles', profile);
  }
  // OMP uses XDG data storage when its app root (and, for named profiles,
  // the profile directory) already exists. Restrict imported credentials to
  // a location under HOME; external XDG roots are intentionally not followed.
  if (
    env.XDG_DATA_HOME &&
    inside(homeDirectory, resolve(env.XDG_DATA_HOME))
  ) {
    const xdgRoot = join(resolve(env.XDG_DATA_HOME), 'omp');
    const xdgProfileRoot = profile ? join(xdgRoot, 'profiles', profile) : xdgRoot;
    try {
      if ((await lstat(xdgProfileRoot)).isDirectory())
        return profile
          ? join(xdgProfileRoot, 'agent.db')
          : join(xdgRoot, 'agent.db');
    } catch { /* Use OMP's config-root path. */ }
  }
  return join(root, 'agent', 'agent.db');
}
async function openOmpDatabase(home: string, env: Readonly<NodeJS.ProcessEnv>): Promise<DatabaseSync> {
  const path = await ompDatabasePath(home, env);
  const homeDirectory = await realpath(home);
  if (!inside(homeDirectory, await realpath(dirname(path)))) throw new Error('unavailable');
  const before = await lstat(path);
  if (!before.isFile() || before.size > 67_108_864) throw new Error('unavailable');
  const database = new DatabaseSync(path, { readOnly: true, timeout: 1_000 });
  const after = await lstat(path).catch(() => undefined);
  if (!after?.isFile() || after.dev !== before.dev || after.ino !== before.ino) {
    database.close();
    throw new Error('unavailable');
  }
  return database;
}
function ompCredentialAvailable(database: DatabaseSync, provider: string): boolean {
  const row = database.prepare(
    "SELECT 1 AS available FROM auth_credentials WHERE provider = ? AND credential_type = 'api_key' AND disabled_cause IS NULL AND length(data) BETWEEN 1 AND 16384 AND json_valid(data) = 1 AND json_type(data, '$.key') = 'text' AND length(json_extract(data, '$.key')) BETWEEN 1 AND 8192 AND (json_type(data, '$.source') IS NULL OR json_extract(data, '$.source') = 'login') ORDER BY updated_at DESC, id DESC LIMIT 1",
  ).get(provider) as { available?: unknown } | undefined;
  return row?.available === 1;
}
async function ompApiKey(home: string, env: Readonly<NodeJS.ProcessEnv>, provider: string): Promise<string> {
  const database = await openOmpDatabase(home, env);
  try {
    const row = database.prepare(
      "SELECT data FROM auth_credentials WHERE provider = ? AND credential_type = 'api_key' AND disabled_cause IS NULL AND length(data) BETWEEN 1 AND 16384 ORDER BY updated_at DESC, id DESC LIMIT 1",
    ).get(provider) as { data?: unknown } | undefined;
    const record = object(row && typeof row.data === 'string' ? JSON.parse(row.data) : undefined);
    const key = record.key;
    if (record.source !== undefined && record.source !== 'login') throw new Error('unavailable');
    return opaqueValue(key);
  } finally { database.close(); }
}
/** Read one credential file with the importer's fences: a regular file, opened
 * without following a link, the same dev/ino lstat described, bounded in size
 * both by the stat and by the read itself. */
async function readCredentialFile(path: string): Promise<string> {
  // constants.O_NOFOLLOW and constants.O_NONBLOCK are undefined on Windows, so the
  // flag set below collapses to a plain O_RDONLY open there and follows a symlink
  // without complaint. fstat cannot catch it afterwards either, because a followed
  // link reports its target as an ordinary file. lstat does not follow the final
  // component, so demanding a regular file is the check that actually refuses a
  // planted link on every platform.
  const before = await lstat(path);
  if (!before.isFile()) throw new Error('unavailable');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    // The handle must be the object lstat just described, otherwise the path was
    // swapped for a link inside that window. dev and ino are real on NTFS and on
    // every POSIX filesystem, and compare equal when a filesystem cannot tell
    // files apart, so this never refuses a legitimate credential.
    if (stat.dev !== before.dev || stat.ino !== before.ino) throw new Error('unavailable');
    if (!stat.isFile() || stat.size > 1_048_576) throw new Error('unavailable');
    // Bound the read as well as the stat, since another process may grow the file.
    const buffer = Buffer.alloc(1_048_577);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > 1_048_576) throw new Error('unavailable');
    return buffer.subarray(0, length).toString('utf8');
  } finally { await file.close(); }
}
async function readCredentialObject(path: string): Promise<ObjectValue> {
  return object(JSON.parse(await readCredentialFile(path)));
}
/** A preset speaks for itself; otherwise the pinned manifest names the endpoint
 * and the default model. Nothing here is invented: an unimportable provider
 * throws and the caller reports it as unavailable. */
function providerConfig(providerId: string, apiKey: string) {
  const preset = presetFor(providerId);
  if (preset) return { baseUrl: preset.baseUrl, kind: preset.kind, apiKey };
  const route = providerImportRoute(providerId);
  if (route.status !== 'api-key') throw new Error('unavailable');
  const config: ProviderAdapterConfig = {
    providerId,
    transport: route.descriptor.transport,
    baseUrl: route.descriptor.endpoint,
    model: route.descriptor.model,
    auth: { kind: 'api-key', apiKey },
  };
  return config;
}
async function credential(source: CredentialSource, env: Readonly<NodeJS.ProcessEnv>) {
  // A host subscription has no token NOMO may read. The host runner, not this
  // importer, is the only path that can use it.
  if (source.credential === 'host-subscription') throw new Error('unavailable');
  const home = homeDirectory(env);
  if (source.format === 'omp')
    return providerConfig(source.provider, await ompApiKey(home, env, source.provider));
  let text = await readCredentialFile(join(home, source.file));
  if (source.format === 'opencode-config') {
    // JSONC comments/trailing commas only; preserve strings and never execute config.
    text = text.replace(/("(?:\\.|[^"\\])*")|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (match, quoted) => quoted ?? ' ');
    text = text.replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, closing) => closing ?? match);
  }
  const data = object(JSON.parse(text));
  const preset = presetFor(source.provider);
  let key: unknown;
  if (source.format === 'opencode-config') {
    // The endpoint on disk must be the pinned preset, never a URL a file chose.
    if (!preset) throw new Error('unavailable');
    const options = object(object(object(data.provider)[source.entry]).options);
    if (options.baseURL !== preset.baseUrl) throw new Error('unavailable');
    key = options.apiKey;
  } else if (source.format === 'prime-models') {
    if (!preset) throw new Error('unavailable');
    const entry = object(object(data.providers)[source.entry]);
    if (entry.baseUrl !== preset.baseUrl) throw new Error('unavailable');
    key = entry.apiKey;
  } else if (source.format === 'opencode-auth') {
    const entry = object(data[source.entry]);
    if (entry.type !== 'api') throw new Error('unavailable');
    key = entry.key;
  } else if (source.format === 'prime-auth') {
    const entry = object(data[source.entry]);
    if (entry.type !== 'api_key') throw new Error('unavailable');
    key = entry.key;
  } else {
    // OAuth and subscription sources are never API-key imports.
    throw new Error('unavailable');
  }
  return providerConfig(source.provider, opaqueValue(key));
}
/** Parse an OAuth source. Only Prime's auth.json and the Claude Code file carry
 * a shape this importer reads; other stores keep their token unused. */
async function oauthEntry(source: CredentialSource, env: Readonly<NodeJS.ProcessEnv>): Promise<ProviderOAuthImport> {
  try {
    const home = homeDirectory(env);
    if (source.format === 'prime-auth') {
      const data = await readCredentialObject(join(home, source.file));
      return parsePrimeOAuthEntry(data[source.entry], Date.now());
    }
    if (source.format === 'claude-oauth')
      return parseClaudeCodeOAuth(await readCredentialObject(join(home, source.file)), Date.now());
    return { status: 'unavailable', reason: 'oauth-source-not-supported' };
  } catch {
    return { status: 'unavailable', reason: 'oauth-entry-malformed' };
  }
}
type SourceStatus = { readonly available: boolean; readonly reason?: string };
async function sourceStatus(source: CredentialSource, env: Readonly<NodeJS.ProcessEnv>): Promise<SourceStatus> {
  if (source.credential === 'host-subscription') {
    // The probe reports only availability and a fixed reason code. It never
    // returns an account name, a token or a credential path.
    if (!source.host) return { available: false, reason: 'host-probe-failed' };
    const probe = await probeHostCli(source.host, env);
    return probe.available
      ? { available: true }
      : { available: false, reason: probe.reason };
  }
  if (source.credential === 'oauth') {
    const imported = await oauthEntry(source, env);
    if (imported.status === 'unavailable') return { available: false, reason: imported.reason };
    if (!oauthProfileFresh(imported.profile, Date.now())) return { available: false, reason: 'oauth-expired' };
    // No transport accepts an OAuth profile yet, so the token stays unused
    // rather than being sent by a code path that cannot renew it.
    return { available: false, reason: 'oauth-transport-unimplemented' };
  }
  try {
    if (!importableApiKey(source.provider))
      return { available: false, reason: 'api-key-route-unavailable' };
    if (source.format === 'omp') {
      const database = await openOmpDatabase(homeDirectory(env), env);
      try { return { available: ompCredentialAvailable(database, source.provider) }; }
      finally { database.close(); }
    }
    await credential(source, env);
    return { available: true };
  } catch { return { available: false }; }
}
/** Every entry of an OMP database that a preset or descriptor can carry. */
async function discoveredOmpSources(home: string, env: Readonly<NodeJS.ProcessEnv>): Promise<CredentialSource[]> {
  const database = await openOmpDatabase(home, env);
  try {
    const rows = database.prepare(
      "SELECT provider, credential_type FROM auth_credentials WHERE disabled_cause IS NULL AND length(provider) BETWEEN 1 AND 128 AND length(data) BETWEEN 1 AND 16384 GROUP BY provider, credential_type ORDER BY provider, credential_type",
    ).all() as { provider?: unknown; credential_type?: unknown }[];
    const found: CredentialSource[] = [];
    for (const row of rows) {
      const provider = row.provider;
      if (typeof provider !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(provider)) continue;
      const credential = row.credential_type === 'api_key' ? 'api-key' : row.credential_type === 'oauth' ? 'oauth' : undefined;
      if (!credential) continue;
      if (credential === 'api-key' ? !knownForApiKey(provider) : !presetFor(provider) && !isKnownProviderId(provider)) continue;
      found.push({
        id: `omp:${provider}`,
        name: displayName(provider),
        source: 'OMP',
        provider,
        credential,
        format: 'omp',
        file: '',
        entry: '',
      });
    }
    return found;
  } finally { database.close(); }
}
async function discoverSources(env: Readonly<NodeJS.ProcessEnv>): Promise<readonly CredentialSource[]> {
  const found: CredentialSource[] = [];
  const ids = new Set<string>();
  const entries = new Set<string>();
  const add = (source: CredentialSource) => {
    if (ids.has(source.id)) return;
    ids.add(source.id);
    found.push(source);
  };
  for (const source of BASE_SOURCES) {
    add(source);
    if (source.file && source.entry) entries.add(`${source.format}:${source.entry}`);
  }
  // Host subscriptions are always listed so a missing host or login is a
  // visible "unavailable" state rather than a missing choice.
  for (const source of HOST_SOURCES) add(source);
  let home: string;
  try { home = homeDirectory(env); } catch { return found; }
  for (const declaration of AUTH_FILES) {
    let data: ObjectValue;
    try { data = await readCredentialObject(join(home, declaration.file)); }
    catch { continue; }
    for (const [entry, value] of Object.entries(data)) {
      if (entry.startsWith('mcp:') || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(entry)) continue;
      const key = `${declaration.format}:${entry}`;
      if (entries.has(key)) continue;
      const record = object(value);
      const provider = PROVIDER_ALIASES[entry] ?? entry;
      const isApiKey = record.type === declaration.apiKeyType;
      const isOauth = record.type === 'oauth';
      if (!isApiKey && !isOauth) continue;
      if (isApiKey ? !knownForApiKey(provider) : !presetFor(provider) && !isKnownProviderId(provider)) continue;
      add({
        id: `${declaration.prefix}:${SOURCE_SLUGS[entry] ?? entry}`,
        name: displayName(provider),
        source: declaration.source,
        provider,
        credential: isApiKey ? 'api-key' : 'oauth',
        format: declaration.format,
        file: declaration.file,
        entry,
      });
      entries.add(key);
    }
  }
  // The subscription credential file is read only when it already exists; the
  // macOS keychain is not queried, so a keychain-only login stays undiscovered.
  try {
    const stat = await lstat(join(home, CLAUDE_CODE_CREDENTIALS));
    if (stat.isFile() && stat.size <= 1_048_576)
      add({
        id: 'claude:anthropic',
        name: 'Claude Code (subscription)',
        source: 'Claude Code',
        provider: 'anthropic',
        credential: 'oauth',
        format: 'claude-oauth',
        file: CLAUDE_CODE_CREDENTIALS,
        entry: '',
      });
  } catch { /* No local subscription credential. */ }
  try {
    for (const source of await discoveredOmpSources(home, env)) add(source);
  } catch { /* The database is optional; base OMP choices stay listed. */ }
  return found;
}
function publicSource(source: CredentialSource, status: SourceStatus) {
  return {
    id: source.id,
    name: source.name,
    source: source.source,
    available: status.available,
    ...(status.reason ? { reason: status.reason } : {}),
    ...(source.credential === 'host-subscription'
      ? { authMethod: 'host-subscription' as const, host: source.host }
      : {}),
  };
}

export async function desktopSetup(env: Readonly<NodeJS.ProcessEnv>) {
  const discovered = await discoverSources(env);
  return {
    sources: await Promise.all(discovered.map(async source => publicSource(source, await sourceStatus(source, env)))),
    localDocuments: true,
    externalToolUndo: false,
  };
}

export async function ompProviderSources(env: Readonly<NodeJS.ProcessEnv>) {
  const discovered = (await discoverSources(env)).filter((source) => source.format === 'omp');
  return Promise.all(discovered.map(async source => publicSource(source, await sourceStatus(source, env))));
}

async function desktopProviderConfig(id: unknown, env: Readonly<NodeJS.ProcessEnv>) {
  if (typeof id !== 'string' || !id.length) throw new Error('Unsupported provider import.');
  const source = (await discoverSources(env)).find(candidate => candidate.id === id);
  if (!source) throw new Error('Unsupported provider import.');
  if (source.credential === 'host-subscription')
    throw new Error(
      `Host subscription ${source.id} is not imported as a token. Select it with /connect ${source.id}; the login stays in the host.`,
    );
  if (source.credential === 'oauth') {
    const imported = await oauthEntry(source, env);
    const reason = imported.status === 'unavailable'
      ? imported.reason
      : oauthProfileFresh(imported.profile, Date.now())
        ? 'oauth-transport-unimplemented'
        : 'oauth-expired';
    throw new Error(`OAuth subscription import is unavailable (${reason}).`);
  }
  if (!presetFor(source.provider)) {
    const route = providerImportRoute(source.provider);
    if (route.status !== 'api-key')
      throw new Error(`Provider import is unavailable (${route.reason}).`);
  }
  try { return await credential(source, env); }
  catch { throw new Error('Local API key unavailable. OAuth, command references and custom endpoints cannot be imported.'); }
}
export async function desktopProviderModels(id: unknown, env: Readonly<NodeJS.ProcessEnv>, workbench: Workbench) {
  const config = await desktopProviderConfig(id, env);
  return workbench.providerModelsForConfig(config);
}

export async function importDesktopProvider(
  id: unknown,
  env: Readonly<NodeJS.ProcessEnv>,
  workbench: Workbench,
  preferredModel?: string,
) {
  const config = await desktopProviderConfig(id, env);
  // Validation talks only to the fixed provider endpoint, never a URL from disk.
  try { await workbench.configure(config, preferredModel); }
  catch { throw new Error('Provider validation or local save failed. Check the provider and reopen NOMO before retrying.'); }
  return workbench.providerState();
}
