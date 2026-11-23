import { execFile, spawn } from 'node:child_process';
import { realpath, lstat, readFile, readdir, open, mkdir, writeFile, access, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { resolve, relative, sep, isAbsolute, join, dirname } from 'node:path';
import { d as dataDir, N as NO_VERIFICATION_KEY_NOTE, b as resolveVerificationKey, c as retainedKeyProvider, e as devKeyDir, v as verificationStatus, f as verificationKeyNote, g as readLedgerEntries, h as verifyChain, l as loadPending, w as writeDecision, i as PROVIDER_PRESETS, p as pad, j as fit, k as paint, m as visibleLength, s as sanitizeText, n as paintWithPalette, o as NOMO_PALETTE, u as unifiedDiff, q as splitDiffHunks, t as getSymbols, x as stripAnsi, y as getThemeConfig, z as detectCapabilities, B as loadLocalTabIcons, C as kittyTabIconLabel, D as kittyProviderIconLabel, E as COLOR_THEMES, S as SYMBOL_SETS, F as ProviderRequestError, G as activity, H as harnessSettingsView, I as harnessTextSettingsView, J as HARNESS_TEXT_SETTINGS, K as HARNESS_SETTINGS, L as mineLearnedRules, R as REGISTRY_DISCLAIMER, M as canonicalJson, O as renderHunkSelection, Q as resolveConfig, T as runDoctorCommand, V as runConformanceCommand, W as runInitCommand, X as loadPolicy, Y as DEFAULT_POLICY, Z as getPalette, _ as brandHeader, $ as compactBrandMark, a0 as kittySemanticIconLabel, a1 as paintUserMessage, a2 as modelCapabilityDisclosure, a3 as kittyActivityIconLabel, a4 as canonicalProjectRoot, a5 as LocalStorage, a6 as Workbench, a7 as projectSandboxConfig, a8 as kittyTabIconsCleanup, a9 as kittyProviderIconCleanup, aa as kittyTabIconsTransfer, ab as kittyProviderIconTransfer } from './dispatch.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { measureBoard, unmeasuredMetrics } from './harness-scores.mjs';
import { constants } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { emitKeypressEvents } from 'node:readline';
import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { normalizeOwnedEnv, envValue } from './env-keys.mjs';
import 'node:timers/promises';
import 'node:assert/strict';
import '@modelcontextprotocol/sdk/server/stdio.js';
import '@modelcontextprotocol/sdk/server/index.js';
import '@modelcontextprotocol/sdk/types.js';
import 'yaml';
import 'node:url';
import 'pg';
import 'node:readline/promises';
import 'node:perf_hooks';
import 'node:buffer';
import 'node:process';
import '@aws-sdk/credential-provider-node';
import 'node-sql-parser';

const PROJECT_SKILL_LIMITS = {
  count: 8,
  fileBytes: 32_768,
  totalBytes: 131_072,
  lockBytes: 131_072,
}         ;

                                    
                      
                        
                              
                              
                            
                           
  

                  
                             
                                
  

function parseLock(value         )                                                         {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Unsupported workspace skills lock: expected a JSON object.");
  const candidate = value                                                             ;
  if (candidate.version !== 1)
    throw new Error(`Unsupported workspace skills lock: version must be 1, got ${JSON.stringify(candidate.version)}.`);
  if (candidate.skills === null || typeof candidate.skills !== "object" || Array.isArray(candidate.skills))
    throw new Error(`Unsupported workspace skills lock: skills must be an object, got ${JSON.stringify(typeof candidate.skills)}.`);
  return {
    skills: candidate.skills                                     ,
  };
}

function lockEntry(value         , id        )            {
  if (value === undefined)
    throw new Error(`Skill ${id} is not present in the workspace lock.`);
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid lock entry for skill ${id}.`);
  const candidate = value     
                                 
                                    
   ;
  const skillPath = candidate.skillPath;
  const computedHash = candidate.computedHash;
  if (
    typeof skillPath !== "string" ||
    skillPath !== `skills/${id}/SKILL.md` ||
    isAbsolute(skillPath) ||
    typeof computedHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(computedHash)
  )
    throw new Error(`Invalid skill path or digest in workspace lock for ${id}.`);
  return { skillPath, computedHash };
}

async function regularFile(path        , maxBytes        , label        ) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile())
    throw new Error(`${label} must be a regular file, not a symlink.`);
  if (info.size > maxBytes) throw new Error(`${label} exceeds its size limit.`);
  return info;
}

/** Read only explicitly selected, lock-listed skills from this project. */
async function readProjectSkills(
  projectRoot        ,
  ids                   ,
)                                  {
  if (ids.length === 0) return [];
  if (ids.length > PROJECT_SKILL_LIMITS.count)
    throw new Error(`Select at most ${PROJECT_SKILL_LIMITS.count} workspace skills.`);
  const seen = new Set        ();
  for (const id of ids) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id))
      throw new Error("Invalid workspace skill ID.");
    if (seen.has(id)) throw new Error(`Duplicate workspace skill ${id}.`);
    seen.add(id);
  }

  const root = await realpath(projectRoot);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory()) throw new Error("Project root must be a directory.");
  const lockPath = resolve(root, "skills-lock.json");
  await regularFile(lockPath, PROJECT_SKILL_LIMITS.lockBytes, "Workspace skill lock");
  let lock         ;
  try {
    lock = JSON.parse(await readFile(lockPath, "utf8"));
  } catch {
    throw new Error("Workspace skills lock is unreadable or invalid JSON.");
  }
  const lockSkills = parseLock(lock).skills;

  const agentsRoot = resolve(root, ".agents");
  const agentsInfo = await lstat(agentsRoot);
  if (agentsInfo.isSymbolicLink() || !agentsInfo.isDirectory())
    throw new Error("Workspace .agents must be a real directory.");
  const canonicalAgents = await realpath(agentsRoot);
  if (canonicalAgents !== agentsRoot)
    throw new Error("Workspace .agents resolves outside the project.");

  const snapshots                         = [];
  let totalBytes = 0;
  for (const id of ids) {
    const entry = lockEntry(lockSkills[id], id);
    const path = resolve(agentsRoot, entry.skillPath);
    const pathFromRoot = relative(agentsRoot, path);
    if (
      pathFromRoot.startsWith(`..${sep}`) ||
      pathFromRoot === ".." ||
      isAbsolute(pathFromRoot)
    )
      throw new Error(`Skill path for ${id} escapes the workspace.`);

    const skillDirectory = resolve(agentsRoot, "skills", id);
    const skillsDirectory = resolve(agentsRoot, "skills");
    for (const [directory, label] of [
      [skillsDirectory, "Workspace skills directory"],
      [skillDirectory, `Skill directory ${id}`],
    ]         ) {
      const info = await lstat(directory);
      if (info.isSymbolicLink() || !info.isDirectory())
        throw new Error(`${label} must be a real directory.`);
    }

    const info = await regularFile(path, PROJECT_SKILL_LIMITS.fileBytes, `Skill ${id}`);
    const canonicalPath = await realpath(path);
    const canonicalRelative = relative(canonicalAgents, canonicalPath);
    if (
      canonicalRelative.startsWith(`..${sep}`) ||
      canonicalRelative === ".." ||
      isAbsolute(canonicalRelative)
    )
      throw new Error(`Skill ${id} resolves outside the project.`);
    const bytes = await readFile(path);
    if (bytes.byteLength > PROJECT_SKILL_LIMITS.fileBytes || bytes.byteLength !== info.size)
      throw new Error(`Skill ${id} changed while it was being read or exceeds its size limit.`);
    const content = bytes.toString("utf8");
    if (
      !Buffer.from(content, "utf8").equals(bytes) ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(content)
    )
      throw new Error(`Skill ${id} must be valid UTF-8 Markdown without control characters.`);
    totalBytes += bytes.byteLength;
    if (totalBytes > PROJECT_SKILL_LIMITS.totalBytes)
      throw new Error("Selected workspace skills exceed their aggregate size limit.");
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    snapshots.push({
      id,
      path: `.agents/${entry.skillPath}`,
      lockedHash: entry.computedHash,
      actualHash,
      drifted: actualHash !== entry.computedHash,
      content,
    });
  }
  return snapshots;
}


//# sourceURL=packages/workbench/src/project-skills.ts

/** Read the existing proxy stores; never instantiate a competing approval broker. */
class ProxyWorkspace {
           env                             ;
           ledgerDir        ;
           approvalDir        ;
  entries = new Map                      ();
  signed = false;
  /**
   * The source the signed boolean came from, and the note to render beside it.
   * A binary `signed` is not enough: "verified against a key this process
   * could also have replaced" and "verified against a key the operator
   * supplied" must not look the same on screen. `verificationKey` keeps the
   * facts so a headline can name the key rather than only caveat it, and
   * `verificationStatus` is that one-line claim.
   */
  degraded = true;
  verificationNote                    ;
  verificationKey                               ;
  verificationStatus = "no verification key";
  holds                   = [];
  errors           = [];
          checked = 0;
  constructor(env                             ) {
    this.env = env;
    const home = env.HOME ?? homedir();
    const base = env.NOMO_DATA_DIR ?? join(dataDir(home));
    this.ledgerDir = env.NOMO_LEDGER_DIR ?? join(base, "ledger");
    this.approvalDir =
      env.NOMO_APPROVALS_DIR ??
      join(base, "approvals", env.NOMO_WORKSPACE ?? "default");
  }
  async refresh(force = false) {
    if (!force && Date.now() - this.checked < 1000) return;
    this.checked = Date.now();
    this.errors = [];
    this.entries.clear();
    this.holds = [];
    this.signed = false;
    this.degraded = true;
    this.verificationKey = undefined;
    this.verificationStatus = "NOT VERIFIED: no verification key";
    this.verificationNote = NO_VERIFICATION_KEY_NOTE;
    // The same resolution every other verifier surface uses, so an operator
    // who did what the documentation says gets what the documentation says
    // here too. Reading the private key file directly, as this did, made the
    // TUI the one surface where a pin did nothing at all. `retainedKeyProvider`
    // keeps a refresh from minting a key as a side effect of looking.
    const key = await resolveVerificationKey({
      env: this.env,
      allowDegraded: true,
      signingKey: async () => {
        try {
          return await retainedKeyProvider({
            dir: devKeyDir(this.env.HOME ?? homedir()),
            env: this.env,
          });
        } catch (error) {
          if ((error                         ).code === "ENOENT") return undefined;
          throw error;
        }
      },
    }).catch((error         ) => {
      this.errors.push(
        `Invalid proxy verification key: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    });
    const publicKey                              = key?.publicKey;
    if (key !== undefined) {
      this.degraded = key.degraded;
      this.verificationKey = key;
      this.verificationStatus = verificationStatus(key);
      this.verificationNote = verificationKeyNote(key);
    }
    try {
      for (const file of await readdir(this.ledgerDir, {
        withFileTypes: true,
      })) {
        if (!file.isFile() || !/^[A-Za-z0-9_.-]+\.jsonl$/.test(file.name))
          continue;
        try {
          const entries = await readLedgerEntries(
            join(this.ledgerDir, file.name),
          );
          const result = await verifyChain(entries, { publicKey });
          if (!result.ok) throw Error("invalid");
          this.entries.set(file.name.slice(0, -6), entries);
        } catch {
          this.errors.push(`Invalid proxy ledger: ${file.name}`);
        }
      }
      this.signed = publicKey !== undefined;
    } catch (e) {
      if ((e                         ).code !== "ENOENT")
        this.errors.push("Cannot read the proxy ledger.");
    }
    try {
      this.holds = loadPending(this.approvalDir).filter(
        (h) => h.status === "pending" && h.expiresAt > Date.now(),
      );
    } catch (e) {
      if ((e                         ).code !== "ENOENT")
        this.errors.push("Cannot read proxy approvals.");
    }
  }
  decide(id        , kind                       , reason        ) {
    writeDecision(this.approvalDir, id, { kind, by: "tui-operator", reason });
  }
}


//# sourceURL=packages/cli/src/tui/workspace-proxy.ts

/** Import fixed local credential sources only. Configuration is data, never code. */
                                                                          

const sources = [
  { id: 'opencode:tokenrouter', name: 'TokenRouter', source: 'OpenCode', file: '.config/opencode/opencode.jsonc', provider: 'tokenrouter', entry: 'tokenrouter', config: true },
  { id: 'prime:tokenrouter', name: 'TokenRouter', source: 'Prime', file: '.prime/agent/models.json', provider: 'tokenrouter', entry: 'tokenrouter', models: true },
  { id: 'opencode:zen', name: 'OpenCode Zen', source: 'OpenCode', file: '.local/share/opencode/auth.json', provider: 'opencode-zen', entry: 'opencode' },
  { id: 'prime:zen', name: 'OpenCode Zen', source: 'Prime', file: '.prime/agent/auth.json', provider: 'opencode-zen', entry: 'opencode' },
  { id: 'opencode:openrouter', name: 'OpenRouter', source: 'OpenCode', file: '.local/share/opencode/auth.json', provider: 'openrouter', entry: 'openrouter' },
  { id: 'prime:openrouter', name: 'OpenRouter', source: 'Prime', file: '.prime/agent/auth.json', provider: 'openrouter', entry: 'openrouter' },
  { id: 'omp:nvidia', name: 'NVIDIA NIM', source: 'OMP', provider: 'nvidia', database: true },
  { id: 'omp:openrouter', name: 'OpenRouter', source: 'OMP', provider: 'openrouter', database: true },
]         ;

                                     
                                           
function object(value         )              {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value                : {};
}
function inside(root        , path        )          {
  const pathFromRoot = relative(root, path);
  return pathFromRoot === '' || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot));
}
async function ompDatabasePath(home        , env                             )                  {
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
async function openOmpDatabase(home        , env                             )                        {
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
function ompCredentialAvailable(database              , provider        )          {
  const row = database.prepare(
    "SELECT 1 AS available FROM auth_credentials WHERE provider = ? AND credential_type = 'api_key' AND disabled_cause IS NULL AND length(data) BETWEEN 1 AND 16384 AND json_valid(data) = 1 AND json_type(data, '$.key') = 'text' AND length(json_extract(data, '$.key')) BETWEEN 1 AND 8192 AND (json_type(data, '$.source') IS NULL OR json_extract(data, '$.source') = 'login') ORDER BY updated_at DESC, id DESC LIMIT 1",
  ).get(provider)                                       ;
  return row?.available === 1;
}
async function ompApiKey(home        , env                             , provider        )                  {
  const database = await openOmpDatabase(home, env);
  try {
    const row = database.prepare(
      "SELECT data FROM auth_credentials WHERE provider = ? AND credential_type = 'api_key' AND disabled_cause IS NULL AND length(data) BETWEEN 1 AND 16384 ORDER BY updated_at DESC, id DESC LIMIT 1",
    ).get(provider)                                  ;
    const record = object(row && typeof row.data === 'string' ? JSON.parse(row.data) : undefined);
    const key = record.key;
    if (record.source !== undefined && record.source !== 'login') throw new Error('unavailable');
    if (typeof key !== 'string' || !key.length || key.length > 8192 || /\s|\$\{|^!|^\{env:|^\{file:/.test(key)) throw new Error('unavailable');
    return key;
  } finally { database.close(); }
}
async function credential(source        , env                             ) {
  const home = env.HOME ?? homedir();
  if (!isAbsolute(home)) throw new Error('unavailable');
  const path = 'database' in source ? undefined : join(home, source.file);
  if ('database' in source) {
    const key = await ompApiKey(home, env, source.provider);
    const preset = PROVIDER_PRESETS.find(p => p.id === source.provider) ;
    return { baseUrl: preset.baseUrl, kind: preset.kind, apiKey: key };
  }
  if (!path) throw new Error('unavailable');
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
    let text = buffer.subarray(0, length).toString('utf8');
    if ('config' in source) {
      // JSONC comments/trailing commas only; preserve strings and never execute config.
      text = text.replace(/("(?:\\.|[^"\\])*")|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (match, quoted) => quoted ?? ' ');
      text = text.replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, closing) => closing ?? match);
    }
    const data = object(JSON.parse(text));
    const preset = PROVIDER_PRESETS.find(p => p.id === source.provider) ;
    let key         ;
    if ('config' in source) {
      const options = object(object(object(data.provider)[source.entry]).options);
      if (options.baseURL !== preset.baseUrl) throw new Error('unavailable');
      key = options.apiKey;
    } else if ('models' in source) {
      const entry = object(object(data.providers)[source.entry]);
      if (entry.baseUrl !== preset.baseUrl) throw new Error('unavailable');
      key = entry.apiKey;
    } else {
      const entry = object(data[source.entry]);
      if (entry.type !== (source.source === 'Prime' ? 'api_key' : 'api')) throw new Error('unavailable');
      key = entry.key;
    }
    if (typeof key !== 'string' || !key.length || key.length > 8192 || /\s|\$\{|^!|^\{env:|^\{file:/.test(key)) throw new Error('unavailable');
    return { baseUrl: preset.baseUrl, kind: preset.kind, apiKey: key };
  } finally { await file.close(); }
}

async function desktopSetup(env                             ) {
  return {
    sources: await Promise.all(sources.map(async source => {
      let available = false;
      try {
        if ('database' in source) {
          const home = env.HOME ?? homedir();
          if (!isAbsolute(home)) throw new Error('unavailable');
          const database = await openOmpDatabase(home, env);
          try { available = ompCredentialAvailable(database, source.provider); }
          finally { database.close(); }
        } else {
          await credential(source, env);
          available = true;
        }
      } catch { /* No paths or credentials in public diagnostics. */ }
      return { id: source.id, name: source.name, source: source.source, available };
    })),
    localDocuments: true,
    externalToolUndo: false,
  };
}

async function ompProviderSources(env                             ) {
  const ompSources = sources.filter((source) => 'database' in source);
  let database                          ;
  try {
    const home = env.HOME ?? homedir();
    if (!isAbsolute(home)) throw new Error('unavailable');
    database = await openOmpDatabase(home, env);
    return ompSources.map((source) => ({
      id: source.id,
      name: source.name,
      source: source.source,
      available: ompCredentialAvailable(database , source.provider),
    }));
  } catch {
    return ompSources.map((source) => ({
      id: source.id,
      name: source.name,
      source: source.source,
      available: false,
    }));
  } finally {
    database?.close();
  }
}

async function desktopProviderConfig(id         , env                             ) {
  const source = sources.find(source => source.id === id);
  if (!source) throw new Error('Unsupported provider import.');
  try { return await credential(source, env); }
  catch { throw new Error('Local API key unavailable. OAuth, command references and custom endpoints cannot be imported.'); }
}

async function desktopProviderModels(id         , env                             , workbench           ) {
  const config = await desktopProviderConfig(id, env);
  return workbench.providerModelsForConfig(config);
}

async function importDesktopProvider(
  id         ,
  env                             ,
  workbench           ,
  preferredModel         ,
) {
  const config = await desktopProviderConfig(id, env);
  // Validation talks only to the fixed provider endpoint, never a URL from disk.
  try { await workbench.configure(config, preferredModel); }
  catch { throw new Error('Provider validation or local save failed. Check the provider and reopen NOMO before retrying.'); }
  return workbench.providerState();
}


//# sourceURL=apps/control-plane/api/desktop-setup.ts

const DEFAULT_WORKSPACE_KEYBINDINGS = {
  redraw: { ctrl: true, name: "l", label: "Ctrl+L" },
  "toggle-tools": { ctrl: true, name: "o", label: "Ctrl+O" },
  "search-history": { ctrl: true, name: "r", label: "Ctrl+R" },
  stash: { ctrl: true, name: "s", label: "Ctrl+S" },
  "external-editor": { ctrl: true, name: "g", label: "Ctrl+G" },
  "show-todos": { ctrl: true, name: "t", label: "Ctrl+T" },
}         ;

                                                                                   
                                          
                            
                                             
  

const actions = Object.keys(DEFAULT_WORKSPACE_KEYBINDINGS)                               ;
const reserved = new Set(["a", "b", "c", "d", "e", "f", "h", "i", "j", "k", "m", "n", "p", "q", "u", "w", "x", "y", "z"]);

function parseWorkspaceKeybindings(
  raw                    ,
)                                                     {
  const defaults = { ...DEFAULT_WORKSPACE_KEYBINDINGS }                        ;
  if (!raw) return { bindings: defaults };
  try {
    const parsed          = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("expected a JSON object");
    const entries = Object.entries(parsed);
    const bindings = { ...defaults };
    for (const [action, value] of entries) {
      if (!actions.includes(action                             ))
        throw new Error(`unknown action ${action}`);
      if (typeof value !== "string" || !/^Ctrl\+[a-z]$/i.test(value))
        throw new Error(`${action} must use Ctrl+<letter>`);
      const name = value.slice(-1).toLowerCase();
      if (reserved.has(name) && !(action === "stash" && name === "s"))
        throw new Error(`${value} is reserved`);
      if (name === "s" && action !== "stash")
        throw new Error("Ctrl+S is reserved for terminal flow control");
      bindings[action                             ] = {
        ctrl: true,
        name,
        label: `Ctrl+${name.toUpperCase()}`,
      };
    }
    const seen = new Map                ();
    for (const action of actions) {
      const { name, label } = bindings[action];
      const previous = seen.get(name);
      if (previous) throw new Error(`${label} is assigned to both ${previous} and ${action}`);
      seen.set(name, action);
    }
    return { bindings };
  } catch (error) {
    return {
      bindings: defaults,
      error: `NOMO_TUI_KEYBINDINGS ignored: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}


//# sourceURL=packages/cli/src/tui/workspace-keybindings.ts

// Interactive command palette: fuzzy search over every slash command with
// a recognisable glyph per command, the way OMP/Prime democratised it.
// The old /command-palette was a static text dump; this module is the
// searchable model workspace.ts will drive (query keystrokes in, Enter runs
// the selected item). It owns no screen state and never touches raw mode,
// so it stays safe to unit test and to render inside any surface.
                                                       

                          
             
          
           
            
            
              
          
           

// A palette entry. The icons come from the command's own identity so the
// operator recognises a command by its glyph, the way OMP does.
                              
                      
                         
                        
                        
                               
                                       
 

                               
                         
                            
                           
                                                               
                                                                            
 

                              
                                    
                                         
                            
 

// Fixed section order. Groups with no items are omitted by
// paletteGroupsInOrder; the constant itself is exported for tests.
const PALETTE_GROUP_ORDER                          = [
  "session",
  "chat",
  "tools",
  "ledger",
  "agents",
  "settings",
  "help",
  "exit",
];

// Group glyphs. Every pick must stay a single terminal cell under the width
// table in layout.ts, which counts U+2600-U+27BF as two cells wide, so the
// gear (U+2699) and the power symbol are deliberately avoided here in favour
// of ASCII and Latin-1/pre-2600 glyphs. A two cell icon would misalign every
// row because pad() counts cells, not code units.
const PALETTE_ICONS                               = {
  session: "≡",
  chat: "●",
  tools: "+",
  ledger: "▪",
  agents: "◆",
  settings: "§",
  help: "?",
  exit: ">",
};

// First token of an id, lowercased, without arguments: "/connect
// opencode:zen" classifies as "/connect". Command specific icons are matched
// the same way so aliases and arguments never change the glyph.
function commandKey(id        )         {
  const first = id.trim().split(/\s+/)[0] ?? "";
  return first.toLowerCase();
}

// Icon for a specific command. Commands whose glyph carries meaning override
// the group default (undo arrow, help question mark, theme palette, mcp
// connector node, export arrow, verify root sign, stop square, exit marker);
// everything else falls back to the group icon so new commands still render.
function commandIcon(id        , group              )         {
  const key = commandKey(id);
  if (key === "/undo") return "↩";
  if (key === "/help" || key === "/keybindings") return "?";
  if (key === "/theme") return "◐";
  if (key === "/mcp") return "◉";
  if (key === "/export") return "↓";
  if (key === "/verify") return "√";
  if (key === "/stop") return "■";
  if (key === "/exit" || key === "/quit") return ">";
  return PALETTE_ICONS[group];
}

// Lowercase a match candidate. Aliases are matched slash agnostic, the same
// as ids, so an alias written either way behaves identically.
function matchText(value        )         {
  const lower = value.toLowerCase();
  return lower.startsWith("/") ? lower.slice(1) : lower;
}

// Score one candidate string against the normalised query. Tier gaps of 1000
// dwarf any length or position penalty, so a prefix match always outranks a
// substring, which always outranks a gapped subsequence, no matter how short
// the weaker candidate is. The length penalty uses the item id length for
// every candidate, so an alias match scores as if the id itself matched.
function scoreCandidate(
  candidate        ,
  idLength        ,
  query        ,
  idBonus        ,
)                     {
  if (candidate === query) return 5000 + idBonus - idLength;
  if (candidate.startsWith(query)) return 4000 + idBonus - idLength;
  const at = candidate.indexOf(query);
  if (at >= 0) return 2000 + idBonus - at - idLength;
  // Gapped subsequence: every query character in order. The penalty grows
  // with the span of skipped characters plus the start offset, so a tight
  // early match outranks a scattered late one within the tier.
  let cursor = 0;
  let first = -1;
  let last = -1;
  for (const point of query) {
    const found = candidate.indexOf(point, cursor);
    if (found < 0) return undefined;
    if (first < 0) first = found;
    last = found;
    cursor = found + 1;
  }
  if (first < 0 || last < 0) return undefined;
  const gaps = last - first + 1 - query.length;
  return 1000 + idBonus - gaps * 10 - first - idLength;
}

function fuzzyTextScore(
  query        ,
  candidates                   ,
)                     {
  const normalised = matchText(query.trim());
  if (normalised === "") return 0;
  let best                    ;
  for (const value of candidates) {
    const candidate = matchText(value);
    const score = scoreCandidate(
      candidate,
      candidate.length,
      normalised,
      0,
    );
    if (score !== undefined && (best === undefined || score > best))
      best = score;
  }
  return best;
}

function fuzzyScore(
  item             ,
  query        ,
)                     {
  const normalised = matchText(query.trim());
  // Empty query matches everything with a flat score so the palette opens
  // as a stable id sorted browser instead of an empty list.
  if (normalised === "") return 0;
  const id = matchText(item.id);
  const idLength = id.length;
  let best                    ;
  const consider = (score                    )       => {
    if (score !== undefined && (best === undefined || score > best))
      best = score;
  };
  // The id match carries a small bonus over an equal alias match, which is
  // what keeps "/help" above an alias-only hit without disturbing tiers.
  consider(scoreCandidate(id, idLength, normalised, 100));
  for (const alias of item.aliases ?? [])
    consider(scoreCandidate(matchText(alias), idLength, normalised, 0));
  return best;
}

/** Record a command execution for frecency. */
function recordPaletteCommand(
  state              ,
  commandId        ,
)               {
  const recent = new Map(state.recent);
  const now = Date.now();
  const existing = recent.get(commandId);
  recent.set(commandId, {
    count: (existing?.count ?? 0) + 1,
    lastUsed: now,
  });
  return { ...state, recent };
}

/** Score bonus for frecency: up to +500 for very recent/frequent commands. */
function frecencyBonus(
  recent                                                          ,
  id        ,
)         {
  const rec = recent.get(id);
  if (!rec) return 0;
  const ageMs = Date.now() - rec.lastUsed;
  const ageHours = ageMs / 3_600_000;
  // Decay: recent use gives big bonus, frequency gives smaller sustained bonus
  const recencyBoost = Math.max(0, 300 - ageHours * 10); // decays over ~30 hours
  const frequencyBoost = Math.min(rec.count * 15, 200); // caps at ~13 uses
  return recencyBoost + frequencyBoost;
}

function filterPalette(
  items                        ,
  query        ,
  recent                                                           ,
)                {
  const scored                                                                =
    [];
  for (const item of items) {
    const score = fuzzyScore(item, query);
    if (score !== undefined) {
      const bonus = recent ? frecencyBonus(recent, item.id) : 0;
      scored.push({ item, score: score + bonus });
    }
  }
  // Score descending for relevance, id ascending for a stable order the
  // operator can learn (and shorter ids already won ties inside the score).
  scored.sort((left, right) =>
    right.score !== left.score
      ? right.score - left.score
      : left.item.id < right.item.id
        ? -1
        : left.item.id > right.item.id
          ? 1
          : 0,
  );
  return scored.map((entry) => entry.item);
}

function paletteGroupsInOrder(
  items                        ,
)                 {
  const present = new Set              ();
  for (const item of items) present.add(item.group);
  return PALETTE_GROUP_ORDER.filter((group) => present.has(group));
}

function initialPaletteState(
  _items                        ,
)               {
  // Eight rows fit the overlay without covering the transcript; 0 would mean
  // "render all" and flood narrow terminals on open.
  return { query: "", selected: 0, visible: 8, recent: new Map() };
}

function advanceSelection(
  state              ,
  items                        ,
  delta        ,
)               {
  const count = items.length;
  if (count === 0) return { ...state, selected: 0 };
  // Wraparound over the whole filtered list. The visible window follows the
  // selection at render time (selecting past the window scrolls it), so no
  // offset needs to live in the state; the modulo also repairs a selection
  // left out of range by a query that shrank the list.
  const selected = (((state.selected + delta) % count) + count) % count;
  return { ...state, selected };
}

function typeInPalette(
  state              ,
  character        ,
)               {
  return { ...state, query: state.query + character, selected: 0 };
}

function backspaceInPalette(state              )               {
  if (state.query === "") return state;
  return { ...state, query: state.query.slice(0, -1), selected: 0 };
}

// Capabilities for the optional coloured overlay. The palette defaults to
// uncoloured output (pipe safe); colour is only painted on explicit request.
const PALETTE_CAPS                       = {
  ansi: true,
  colorDepth: 8};

function renderPalette(
  state              ,
  items                        ,
  width        ,
  options                      ,
)              {
  const filtered = filterPalette(items, state.query);
  const colour = options?.color === true;
  if (filtered.length === 0) {
    const line = pad(
      fit(`No matches for "${state.query}".`, Math.max(1, width)),
      Math.max(1, width),
    );
    return {
      lines: [colour ? paint(line, "muted", PALETTE_CAPS) : line],
      items: filtered,
      selected: 0,
    };
  }
  const selected =
    ((state.selected % filtered.length) + filtered.length) % filtered.length;
  // At compact widths the renderer only has room for one grouped result;
  // keep the active command on screen instead of clipping it below the body.
  const windowSize =
    width < 40
      ? 1
      : state.visible > 0
        ? state.visible
        : filtered.length;
  const offset =
    windowSize > 0 ? Math.floor(selected / windowSize) * windowSize : 0;
  const page = filtered.slice(offset, offset + windowSize);
  const groups = paletteGroupsInOrder(page);
  const lines           = [];
  for (const group of groups) {
    const header = pad(
      fit(`${PALETTE_ICONS[group]} ${group.toUpperCase()}`, Math.max(1, width)),
      Math.max(1, width),
    );
    lines.push(colour ? paint(header, "accent", PALETTE_CAPS, true) : header);
    for (const item of page) {
      if (item.group !== group) continue;
      const marker = item === filtered[selected] ? ">" : " ";
      const row = pad(
        fit(
          `${marker} ${item.icon} ${item.id}  ${item.hint}`,
          Math.max(1, width),
        ),
        Math.max(1, width),
      );
      // The selected row is marked twice (">" plus colour) so the choice
      // stays legible on a monochrome terminal with colour disabled.
      lines.push(
        colour && marker === ">"
          ? paint(row, "accent", PALETTE_CAPS, true)
          : row,
      );
    }
  }
  return { lines, items: filtered, selected };
}

// First token classifiers for paletteFromCommands. Only the listed commands
// map out of settings, so a newly added command lands visibly in settings
// instead of silently in the wrong section.
const SESSION_COMMANDS                      = new Set([
  "/new",
  "/clear",
  "/chat",
  "/resume",
  "/sessions",
]);

const CHAT_COMMANDS                      = new Set([
  "/rewind",
  "/recovery",
  "/queue",
  "/cancel",
  "/stop",
]);

const TOOLS_COMMANDS                      = new Set([
  "/undo",
  "/edit",
  "/history",
  "/branch",
  "/retry",
  "/tools",
  "/expand",
  "/mcp",
]);

const LEDGER_COMMANDS                      = new Set([
  "/ledger",
  "/approvals",
  "/verify",
  "/attest",
  "/export",
]);

const AGENTS_COMMANDS                      = new Set([
  "/agents",
  "/harness",
  "/agent",
]);

const SETTINGS_COMMANDS                      = new Set([
  "/settings",
  "/theme",
  "/models",
  "/usage",
  "/cost",
  "/context",
  "/login",
  "/logout",
  "/connect",
  "/providers",
  "/permissions",
  "/policy",
  "/config",
  "/projects",
]);

const HELP_COMMANDS                      = new Set(["/help", "/keybindings"]);

const EXIT_COMMANDS                      = new Set(["/exit", "/quit"]);

function defaultGroupOf(id        )               {
  const key = commandKey(id);
  if (SESSION_COMMANDS.has(key)) return "session";
  if (CHAT_COMMANDS.has(key)) return "chat";
  if (TOOLS_COMMANDS.has(key)) return "tools";
  if (LEDGER_COMMANDS.has(key)) return "ledger";
  if (AGENTS_COMMANDS.has(key)) return "agents";
  if (HELP_COMMANDS.has(key)) return "help";
  if (EXIT_COMMANDS.has(key)) return "exit";
  if (SETTINGS_COMMANDS.has(key)) return "settings";
  // Unknown commands default to settings: a visible bucket the operator
  // already checks, rather than a guessed group that misleads.
  return "settings";
}

// Builds palette items from the existing TUI_COMMANDS shape (id and hint
// tuples), so workspace.ts needs no parallel command registry.
function paletteFromCommands(
  commands                                        ,
  groupOf                               ,
)                {
  const classify = defaultGroupOf;
  return commands.map(([id, hint]) => {
    const group = classify(id);
    const item              = {
      id,
      label: id,
      hint,
      icon: commandIcon(id, group),
      group,
    };
    return item;
  });
}


//# sourceURL=packages/cli/src/tui/palette.ts

// A toast queue that never blocks the operator and never hides a safety
// state. OMP pairs desktop notifications with in TUI toasts; NOMO had only
// a single notice string, so a second event overwrote the first and a slow
// terminal could scroll the prompt away. This module caps the visible queue,
// keeps sticky safety toasts past every timer, and keeps every state legible
// as plain text so colour is decoration, never signal.

                                                                              

                        
                      
                           
                           
                        
                                                                               
                      
                                                                        
                       
 

                            
                                    
                                                                             
                                     
 

                              
                       
                              
 

// Four lines fit above the prompt on an 80x24 terminal without pushing
// input off screen; four seconds matches a readable glance, not a stare.
const DEFAULT_TOAST_LIMITS              = {
  max: 4,
  defaultTtl: 4000,
}         ;

// Single cell only. layout.ts counts U+2600 to U+27BF as two cells, so the
// pictographs that would be the obvious choices here (U+2715, U+2716) would
// misalign every fitted line; visibleLength below turns a bad table entry into
// a readable mark rather than a line that is one cell too wide. U+00D7 and
// U+25CF are Latin-1 and Geometric Shapes, both one cell everywhere.
const TOAST_ICONS                            = {
  info: "i",
  success: "●",
  warning: "!",
  danger: "×",
  pending: "◉",
};

function toastIcon(tone           )         {
  const icon = TOAST_ICONS[tone];
  // A corrupt table must not emit a wide or empty glyph into width math.
  return visibleLength(icon) === 1 ? icon : "?";
}

// Tones that carry a pending operator obligation. The cap may not evict
// these while any droppable toast remains.
function isSafetyTone(tone           )          {
  return tone === "danger" || tone === "pending";
}

// Normal toasts are expendable under pressure; warnings keep their slot
// because they also carry risk, just not an open obligation.
function isDroppableTone(tone           )          {
  return tone === "info" || tone === "success";
}

function toHost(toasts                  )            {
  const list                   = [...toasts];
  return { toasts: list, active: list[0] };
}

function raiseToast(
  host           ,
  toast       ,
  limits              = DEFAULT_TOAST_LIMITS,
)            {
  // A negative ttl is a caller asking for the default without knowing it;
  // 0 stays sticky and positive stays explicit, so only negatives map.
  const ttl         = toast.ttl < 0 ? limits.defaultTtl : toast.ttl;
  const raised        = { ...toast, ttl };
  // Replace by id first: one run state means one toast, and the newest
  // report moves to the front where the operator is looking.
  const rest          = host.toasts.filter((entry) => entry.id !== raised.id);
  const next          = [raised, ...rest];
  const cap         = Math.max(0, limits.max);
  // Evict from the oldest end. A safety toast at the cap boundary yields
  // its eviction to the oldest normal toast instead, so a pending approval
  // is never dropped silently by chatter. When nothing droppable remains,
  // the cap applies as written rather than growing the queue past the
  // prompt.
  while (next.length > cap) {
    const oldest                    = next[next.length - 1];
    if (oldest !== undefined && isSafetyTone(oldest.tone)) {
      let victim = -1;
      for (let index = next.length - 1; index >= 0; index -= 1) {
        if (isDroppableTone(next[index] .tone)) {
          victim = index;
          break;
        }
      }
      if (victim === -1) {
        next.pop();
        continue;
      }
      next.splice(victim, 1);
      continue;
    }
    next.pop();
  }
  return toHost(next);
}

function expireToasts(host           , now        )            {
  // Sticky toasts (ttl 0) carry open obligations such as a pending approval,
  // so a timer must never clear them; only positive ttl toasts age out.
  const kept          = host.toasts.filter(
    (entry) => entry.ttl === 0 || now - entry.at < entry.ttl,
  );
  if (kept.length === host.toasts.length) return host;
  return toHost(kept);
}

// Palette keys have no pending slot, so pending shares the warning colour;
// the text marker below stays authoritative in every mode.
const TOAST_PALETTE_KEY         
            
                                          
  = {
  info: "info",
  success: "success",
  warning: "warning",
  danger: "error",
  pending: "warning",
};

function renderToasts(
  host           ,
  width        ,
  options                      ,
)           {
  if (host.toasts.length === 0) return [];
  if (width <= 0) return [];
  const useColor          = options?.color === true;
  return host.toasts.map((entry) => {
    // Sanitize at render, not at raise: a host built by hand must still be
    // safe, and sanitizeText turns agent supplied controls into visible
    // marks instead of cursor movement. Newlines become "?" there too, so
    // one toast can never claim two lines.
    const icon = sanitizeText(entry.icon).slice(0, 1) || "?";
    const line = fit(
      `${icon} [${entry.tone.toUpperCase()}] ${sanitizeText(entry.message)}`,
      width,
    );
    if (!useColor) return line;
    return paintWithPalette(
      line,
      TOAST_PALETTE_KEY[entry.tone],
      NOMO_PALETTE,
      {
        ansi: true,
        colorDepth: 24,
        rows: host.toasts.length},
      isSafetyTone(entry.tone),
    );
  });
}


//# sourceURL=packages/cli/src/tui/toast.ts

// Motion and effects for the workspace frame.
//
// Two rules shape everything here. First, every animation is a pure function
// of a frame counter, so two renders at the same counter are byte identical
// and a paused frame is reproducible. That is what lets the test suite assert
// on motion output and what lets NOMO_TUI_MOTION=0 freeze the frame instead
// of degrading it. Second, no effect ever carries meaning that text does not
// already carry. A pulsing approval banner is fine; a pulsing one where the
// colour is the only signal is not, because colour and motion both fail the
// same way on a monochrome terminal and on a screen reader.

                        
                                        
                                      
                                              
                                                  
                                                  
               // scroll text horizontally

/** A frame counter. Every effect is a pure function of this. */
                                
                         
                                                                                 
                            
                                                                        
                            
 

function motionContext(
  frame        ,
  enabled = true,
  reduced = false,
)                {
  return { frame, enabled, reduced };
}

// Braille spinner: ten frames, one cell each, widely supported and slower
// than a block spinner so a busy run does not strobe.
const SPINNER = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
]         ;

/**
 * A spinner with a heavier cadence, for destructive states.
 *
 * Used where the next outcome is a refusal rather than a result, so the
 * motion is slower and the state reads as caution rather than as progress.
 */
const HEAVY_SPINNER = ["◐", "◓", "◑", "◒"]         ;

// The wave used by the running indicator. Reading it as a wave rather than as
// noise is why it stays: one lit cell per column, moving right.
const WAVE = [0, 0.25, 0.5, 0.75, 1, 0.75, 0.5, 0.25]         ;

function waveAt(column        , frame        , phase        )         {
  const position = (column + phase) % WAVE.length;
  return WAVE[position] ?? 0;
}

/**
 * A progress bar with a lit wave travelling across the filled portion.
 * The bar is plain text, so the shape is readable without colour and the
 * motion is decoration on top of a real measurement.
 */
function animatedBar(
  value        ,
  max        ,
  width        ,
  motion               ,
  options   
                         
                                                                          
    = {},
)         {
  const safeMax = Math.max(1, max);
  const cells = Math.max(
    0,
    Math.min(width, Math.round((value / safeMax) * width)),
  );
  const paint = options.paint ?? ((text        ) => text);
  const tone = options.tone ?? "accent";
  let bar = "";
  for (let column = 0; column < width; column += 1) {
    if (column >= cells) {
      bar += paint("░", "muted");
      continue;
    }
    const lit =
      motion.enabled && !motion.reduced
        ? waveAt(column, motion.frame, 0) > 0.6
        : column % 2 === 0;
    bar += lit ? paint("█", tone, true) : paint("▓", tone);
  }
  return bar;
}

/**
 * The running indicator. A spinner plus a moving caret reads as live work,
 * and the label beside it still states the phase in words.
 */
function runningIndicator(motion               )         {
  const index =
    motion.enabled && !motion.reduced ? motion.frame % SPINNER.length : 0;
  return SPINNER[index] ?? SPINNER[0] ;
}

/**
 * A pulsing marker for a pending approval. Pulse, never blink: blink reads as
 * an alarm, and an approval waiting on a human is not an error.
 */
function approvalPulse(motion               )         {
  const steps = ["◉", "◎", "○", "◎"]         ;
  const index =
    motion.enabled && !motion.reduced ? motion.frame % steps.length : 0;
  return steps[index] ?? steps[0] ;
}

/**
 * The marker for a state whose outcome is a refusal rather than a result.
 * Half the speed of the running spinner on purpose: a fast spinner next to a
 * pending refusal draws the eye to the decoration instead of the words.
 */
function cautionSpinner(motion               )         {
  const index =
    motion.enabled && !motion.reduced
      ? Math.floor(motion.frame / 2) % HEAVY_SPINNER.length
      : 0;
  return HEAVY_SPINNER[index] ?? HEAVY_SPINNER[0] ;
}

/**
 * A progress wave for the header. Returns one styled row: the mark, a phase
 * label, and the wave across the remaining width. The label is always present
 * so the motion never carries the meaning on its own.
 */
function phaseWave(
  label        ,
  width        ,
  motion               ,
  options   
                                                                          
    = {},
)         {
  const paint = options.paint ?? ((text        ) => text);
  const head = ` ${label} `;
  const tail = Math.max(0, width - visibleLength(head));
  let row = paint(head, "accent", true);
  for (let column = 0; column < tail; column += 1) {
    const level =
      motion.enabled && !motion.reduced
        ? waveAt(column, motion.frame, 2)
        : (column % 4) / 4;
    const glyph = level > 0.75 ? "━" : level > 0.4 ? "─" : "╌";
    row += paint(glyph, level > 0.75 ? "accent" : "muted");
  }
  return fit(row, width);
}

/**
 * A stable selection marker for list rows. Selection is structural state, not
 * activity: changing its glyph on every motion frame repaints a stationary
 * row twice a second and makes an otherwise static panel feel like it is
 * flickering. Reserve motion for live work indicators.
 */
function cursorMarker(
  selected         ,
  _motion               ,
)         {
  if (!selected) return "  ";
  return "▸ ";
}

/**
 * A breathing dot for idle attention. Slow sine, so it reads as calm rather
 * than as activity.
 */
function idleBreath(motion               )         {
  if (!motion.enabled || motion.reduced) return "·";
  const steps = ["·", "•", "●", "•"]         ;
  const index = Math.floor(motion.frame / 3) % steps.length;
  return steps[index] ?? "·";
}

/**
 * A sweeping highlight across a row, used when a result set changes. Returns
 * the row with the sweep applied, or the row unchanged when motion is off.
 * The sweep is bounded so it never widens the row.
 */
function sweepRow(
  row        ,
  width        ,
  motion               ,
  options   
                                                                          
    = {},
)         {
  if (!motion.enabled || motion.reduced) return fit(row, width);
  const paint = options.paint ?? ((text        ) => text);
  const span = Math.max(0, visibleLength(row));
  const cursor = motion.frame % (span + 4);
  const plain = [...row];
  return fit(
    plain
      .map((char, index) =>
        Math.abs(index - cursor) < 2 && char !== " "
          ? paint(char, "warning", true)
          : char,
      )
      .join(""),
    width,
  );
}

/** A padded status label. Its text stays meaningful without colour. */
function pill(
  label        ,
  tone      ,
  motion               ,
  options   
                                                                          
                              
    = {},
)         {
  const paint = options.paint ?? ((text        ) => text);
  const text = ` ${label} `;
  return paint(text, tone, options.filled === true);
}

/**
 * A completion ring for a verified object. The ring closes as the value
 * approaches its maximum, so the shape itself reports the measurement.
 */
function completionRing(
  value        ,
  max        ,
  _motion               ,
)         {
  const safeMax = Math.max(1, max);
  const filled = Math.max(0, Math.min(8, Math.round((value / safeMax) * 8)));
  const frames = ["◯", "◔", "◑", "◕", "●"]         ;
  const index = Math.min(
    frames.length - 1,
    Math.ceil((filled / 8) * (frames.length - 1)),
  );
  // A frozen frame still reports the measured completion; motion never
  // substitutes a generic empty ring for a completed or failed result.
  return frames[index] ?? frames[0] ;
}

/**
 * A separator that carries activity. A running session gets a lit separator
 * so the boundary between panes is visible while work is in flight.
 */
function separator(
  width        ,
  motion               ,
  active = false,
)         {
  if (!active) return "─".repeat(Math.max(0, width));
  const glyphs = ["╌", "─", "━", "─"]         ;
  const index =
    motion.enabled && !motion.reduced ? motion.frame % glyphs.length : 1;
  const glyph = glyphs[index] ?? "─";
  return glyph.repeat(Math.max(0, width));
}

/**
 * A bar that fills left to right and loops while a run is active. Used for an
 * indeterminate operation, where there is no honest percentage to show.
 */
function indeterminateBar(width        , motion               )         {
  const cells = Math.max(0, width);
  const head =
    motion.enabled && !motion.reduced ? motion.frame % (cells + 6) : 0;
  let bar = "";
  for (let column = 0; column < cells; column += 1) {
    const distance = column - head;
    bar +=
      distance >= 0 && distance < 4
        ? "█"
        : distance < 0 && distance > -4
          ? "░"
          : "·";
  }
  return bar;
}

/**
 * A stepper for multi-phase work. Each phase gets a glyph: done, active, or
 * pending. The active phase pulses, and the phase name is always printed
 * beside it so the ordering is readable as text.
 */
function stepper(
  phases                   ,
  current        ,
  motion               ,
)           {
  return phases.map((phase, index) => {
    if (index < current) return `[${phase}]`;
    if (index === current) {
      const marker =
        motion.enabled && !motion.reduced ? approvalPulse(motion) : "▸";
      return `<${marker} ${phase}>`;
    }
    return `  ${phase}  `;
  });
}

/**
 * A level meter for token or context usage. Segments rather than a bar, so a
 * high value is countable at a glance and the segments survive a narrow
 * terminal better than a continuous bar.
 */
function levelMeter(
  value        ,
  max        ,
  segments = 8,
  motion               ,
  options   
                                                                          
    = {},
)         {
  const paint = options.paint ?? ((text        ) => text);
  const safeMax = Math.max(1, max);
  const filled = Math.max(
    0,
    Math.min(segments, Math.round((value / safeMax) * segments)),
  );
  const ratio = value / safeMax;
  const tone       = ratio > 0.9 ? "r3" : ratio > 0.7 ? "r2" : "accent";
  const glyphs = motion.enabled && !motion.reduced ? ["▰", "▱"] : ["▰", "▱"];
  let out = "";
  for (let index = 0; index < segments; index += 1) {
    out +=
      index < filled ? paint(glyphs[0] , tone) : paint(glyphs[1] , "muted");
  }
  return out;
}

/**
 * A type-on cursor. The block cursor blinks on a slow cycle; a fast blink is
 * the most common source of visual noise in a terminal UI.
 */
function typeCursor(editing         , motion               )         {
  if (!editing) return " ";
  const cycle =
    motion.enabled && !motion.reduced ? Math.floor(motion.frame / 4) % 2 : 1;
  return cycle === 0 ? "▌" : "█";
}


//# sourceURL=packages/cli/src/tui/motion.ts

// Small inline charts for the status area: sparklines, labelled bars,
// proportional stacked bars, compact gauges and trend labels. OMP reports
// token usage, cost and context pressure as glanceable shapes beside the
// numbers; NOMO had numbers only, so a slow drift was invisible until it was
// a limit error. Every function here is plain text with the measurement also
// written out, so nothing is carried by colour or by a glyph alone, and every
// animated choice is a pure function of the motion frame per motion.ts.
                                                 

                         
                                     
                                                      
                                      
 

// Eight block levels from U+2581 to U+2588. They sit below the U+2600 to
// U+27BF range that layout.ts counts as two cells, so each level is exactly
// one cell and visibleLength agrees with the terminal. Eight is also the
// most steps a small status chart can show before adjacent levels blur.
const SPARK_LEVELS                    = [
  "▁",
  "▂",
  "▃",
  "▄",
  "▅",
  "▆",
  "▇",
  "█",
]         ;

// The level a flat series draws at: the middle of the scale, so a constant
// measurement reads as a present fact rather than as missing data.
const SPARK_MID         = SPARK_LEVELS[3] ;

// Base frame used when the caller passes no motion: the static shape, so a
// snapshot test and a motion-frozen terminal agree byte for byte.
const BASE_MOTION$1                = { frame: 0, enabled: false, reduced: true };

function resolveMotion$4(motion                           )                {
  return motion ?? BASE_MOTION$1;
}

// True only for a live frame: motion on and full motion allowed. Reduced
// motion holds the first frame, which is the base shape by construction.
function isLive(motion               )          {
  return motion.enabled && !motion.reduced;
}

function isFiniteNumber(value         )                  {
  return typeof value === "number" && Number.isFinite(value);
}

// Compact number text for chart labels. Integers stay exact; floats round to
// two decimals so a cost like 0.333333 does not eat the bar beside it.
function formatNumber(value        )         {
  if (Number.isNaN(value)) return "?";
  if (!Number.isFinite(value)) return value > 0 ? "+inf" : "-inf";
  if (Number.isInteger(value)) return String(value);
  return String(Math.round(value * 100) / 100);
}

function clamp01(value        )         {
  if (!isFiniteNumber(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

// Level 0 to 7 for a value inside [lo, hi]. Callers guarantee hi > lo.
function levelFor(value        , lo        , hi        )         {
  const ratio = clamp01((value - lo) / (hi - lo));
  return Math.round(ratio * (SPARK_LEVELS.length - 1));
}

/**
 * One row sparkline across the full width. The scale comes from the data
 * unless the caller passes min or max, because a forced zero baseline
 * flattens a series that moved a lot and reads as "nothing happened".
 */
function sparkline(
  series        ,
  width        ,
  options    
                          
                          
                                    
   ,
)         {
  const cells = Math.max(0, Math.floor(width));
  if (cells <= 0) return "";
  const values                    = series.values;
  if (values.length === 0) return pad("no data", cells);
  const finite           = values.filter(isFiniteNumber);
  if (finite.length === 0) return pad("no data", cells);
  let lo         =
    options?.min !== undefined && isFiniteNumber(options.min)
      ? options.min
      : Math.min(...finite);
  let hi         =
    options?.max !== undefined && isFiniteNumber(options.max)
      ? options.max
      : Math.max(...finite);
  // A caller supplied min above max is a swapped argument, not a request
  // for an inverted chart; honour the range, not the order.
  if (lo > hi) {
    const swap         = lo;
    lo = hi;
    hi = swap;
  }
  const motion                = resolveMotion$4(options?.motion);
  // A constant series is a fact worth showing. The middle level reads as a
  // level line; the bottom level would read as zero and the top as full.
  if (hi === lo) return SPARK_MID.repeat(cells);
  const count         = values.length;
  let row = "";
  for (let column = 0; column < cells; column += 1) {
    const sample         = values[Math.floor((column * count) / cells)] ;
    const base         = levelFor(isFiniteNumber(sample) ? sample : lo, lo, hi);
    // The newest sample is the live edge of the feed, so it alone pulses by
    // one level on alternate frames. The shape of history never moves.
    const live          =
      isLive(motion) && column === cells - 1 && motion.frame % 2 === 1;
    const level         = live ? (base < 7 ? base + 1 : base - 1) : base;
    row += SPARK_LEVELS[level] ;
  }
  return row;
}

/**
 * One labelled row per value, most recent first. The operator checks the
 * newest reading first, so it goes on top rather than at the foot of a
 * scroll. Bar fill is decoration: every row also prints its number.
 */
function barChart(
  series        ,
  width        ,
  options    
                          
                                    
   ,
)           {
  const cells = Math.max(0, Math.floor(width));
  const values                    = series.values;
  // One placeholder row, never zero rows: an empty series is still a state
  // the operator should see named rather than a missing panel.
  if (values.length === 0) return [cells <= 0 ? "" : pad("no data", cells)];
  if (cells <= 0) return values.map(() => "");
  const dataMax         = values.reduce(
    (top        , value        ) =>
      isFiniteNumber(value) ? Math.max(top, value) : top,
    0,
  );
  const optMax                     = options?.max;
  const ceiling         =
    optMax !== undefined && isFiniteNumber(optMax) ? optMax : dataMax;
  // A zero or negative ceiling means every value is zero or below, so any
  // positive divisor is honest; 1 keeps the bars empty and the numbers exact.
  const safeMax         = ceiling > 0 ? ceiling : dataMax > 0 ? dataMax : 1;
  const labels                    = series.labels ?? [];
  const cleanLabels           = values.map((_, index) =>
    sanitizeText(labels[index] ?? `#${index + 1}`),
  );
  const valueTexts           = values.map((value) =>
    isFiniteNumber(value) ? formatNumber(value) : "?",
  );
  const fullLabelWidth         = Math.max(
    1,
    ...cleanLabels.map((label) => visibleLength(label)),
  );
  const valueWidth         = Math.max(
    1,
    ...valueTexts.map((text) => visibleLength(text)),
  );
  // Preserve the historical layout when it fits. At narrow widths, shorten
  // labels before measurements; the bar is optional and never displaces them.
  const labelWidth         = Math.min(
    fullLabelWidth,
    Math.max(0, cells - valueWidth - 1),
  );
  const barCells         = Math.max(
    0,
    cells - labelWidth - valueWidth - (labelWidth > 0 ? 2 : 1),
  );
  const motion                = resolveMotion$4(options?.motion);
  const rows           = [];
  for (let order = values.length - 1; order >= 0; order -= 1) {
    const value         = values[order] ;
    const filled         = Math.max(
      0,
      Math.min(barCells, Math.round(clamp01(value / safeMax) * barCells)),
    );
    let bar = `${"█".repeat(filled)}${"░".repeat(barCells - filled)}`;
    // Only the newest row pulses, and only its leading filled cell, so the
    // eye finds the current reading without the history shimmering.
    if (
      isLive(motion) &&
      order === values.length - 1 &&
      filled > 0 &&
      motion.frame % 2 === 1
    ) {
      bar = `${"█".repeat(filled - 1)}▓${"░".repeat(barCells - filled)}`;
    }
    const label         =
      labelWidth > 0 ? `${pad(cleanLabels[order] , labelWidth)} ` : "";
    const text         = valueTexts[order] .padStart(valueWidth, " ");
    const suffix         = barCells > 0 ? ` ${bar}` : "";
    rows.push(`${label}${text}${suffix}`);
  }
  return rows;
}

/**
 * A compact bar with the value printed as text. The number is the signal
 * and the bar is the glance: a fill alone is unreadable monochrome.
 */
function gauge(
  value        ,
  max        ,
  options                                                               ,
)         {
  const head         =
    options?.label !== undefined && sanitizeText(options.label) !== ""
      ? `${sanitizeText(options.label)} `
      : "";
  // A zero or negative max leaves the scale undefined. Report the value and
  // say the scale is unknown rather than printing NaN or an empty bar.
  if (!isFiniteNumber(max) || max <= 0)
    return `${head}${isFiniteNumber(value) ? formatNumber(value) : "?"}/? (max unknown)`;
  if (!isFiniteNumber(value))
    return `${head}?/${formatNumber(max)} (value unknown)`;
  const ratio         = clamp01(value / max);
  const cells = 8;
  const filled         = Math.round(ratio * cells);
  let bar = `${"█".repeat(filled)}${"░".repeat(cells - filled)}`;
  const motion                = resolveMotion$4(options?.motion);
  if (
    isLive(motion) &&
    filled > 0 &&
    filled < cells &&
    motion.frame % 2 === 1
  ) {
    bar = `${"█".repeat(filled - 1)}▓${"░".repeat(cells - filled)}`;
  }
  const percent = `${Math.round(ratio * 100)}%`;
  return `${head}${bar} ${formatNumber(value)}/${formatNumber(max)} ${percent}`;
}

/**
 * A signed delta with the direction also stated as a word. The arrow is
 * redundant decoration: rising, falling, flat and unknown carry the meaning
 * for anyone who cannot see the glyph.
 */
function deltaLabel(
  current        ,
  previous        ,
  options                               ,
)         {
  const suffix         = options?.suffix;
  // No previous reading means no trend exists yet. Show the current number
  // when there is one, and always name the state unknown in words.
  if (!isFiniteNumber(current) || !isFiniteNumber(previous)) {
    const head         = isFiniteNumber(current)
      ? `${formatNumber(current)}${suffix} `
      : "";
    return `${head}? unknown`;
  }
  const diff         = current - previous;
  if (diff > 0) return `+${formatNumber(diff)}${suffix} ▲ rising`;
  if (diff < 0) return `${formatNumber(diff)}${suffix} ▼ falling`;
  return `±0${suffix} flat`;
}


//# sourceURL=packages/cli/src/tui/charts.ts

// OMP ships a diff review surface with hunk navigation and per hunk
// staging; NOMO had only a bare unified string plus number key hunk
// selection, so review state lived in the caller's head. This module owns
// the small immutable review state (cursor, staged flags, side) and the
// fitted panel render, reusing the layout.ts diff pipeline instead of
// reimplementing hunk splitting.

                                           

                                
                                              
                         
                                                           
                           
                                                       
                                   
 

                                
                          
                         
                          
                                           
                                                           
                                                    
 

function diffStats(rows                   )   
                         
                           
  {
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    // File headers and hunk headers are metadata, not changed lines: a
    // "---"/"+++" pair would otherwise inflate both counters by one each.
    if (row.startsWith("+++") || row.startsWith("---")) continue;
    if (row.startsWith("@@")) continue;
    if (row.startsWith("+")) added += 1;
    else if (row.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

function buildDiffView(
  before        ,
  after        ,
  options                                        ,
)                {
  const rows = unifiedDiff(before, after, 3);
  const chunks = splitDiffHunks(rows);
  // Every hunk starts staged so the default verdict covers the whole diff;
  // the operator narrows scope by toggling hunks off, not by opting in.
  const hunks                           = chunks.map((chunk, index) => ({
    index,
    staged: true,
    rows: [...chunk],
  }));
  return {
    before,
    after,
    side: options?.side ?? "unified",
    hunks,
    cursor: 0,
    scroll: 0,
  };
}

function toggleHunk(state               , index        )                {
  // A keypress can arrive after the file changed under the view, so an out
  // of range index is a stale event, not a crash: return the state as is.
  if (!Number.isInteger(index) || index < 0 || index >= state.hunks.length)
    return state;
  const hunks = state.hunks.map((hunk, hunkIndex) =>
    hunkIndex === index ? { ...hunk, staged: !hunk.staged } : hunk,
  );
  return { ...state, hunks };
}

function moveHunk(state               , delta        )                {
  if (state.hunks.length === 0) return state;
  // Wraparound keeps j/k usable without bounds checking at the call site;
  // hunk lists are short, so modulo navigation never loses the operator.
  const next =
    (((state.cursor + delta) % state.hunks.length) + state.hunks.length) %
    state.hunks.length;
  return { ...state, cursor: next };
}

function setSide(state               , side          )                {
  return { ...state, side };
}

// Hunk headers carry 1 based line numbers ("@@ -aStart,aLen +bStart,bLen
// @@"); the split gutter replays those numbers so each column reads like
// the file it came from. An unparsable header means hand built state, so
// fall back to origin rather than showing a misleading line number.
function parseHunkHeader(header        )                                     {
  const match = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header);
  if (!match) return { aStart: 0, bStart: 0 };
  return {
    aStart: Number.parseInt(match[1] ?? "0", 10),
    bStart: Number.parseInt(match[2] ?? "0", 10),
  };
}

function hunkHeaderLine(
  hunk               ,
  hunkIndex        ,
  total        ,
  isCursor         ,
)         {
  // ">>" versus two spaces marks the cursor, "[x]" versus "[ ]" marks the
  // staged flag: both are plain text because colour is redundant signal in
  // this product and the panel must read identically in mono.
  const cursorMark = isCursor ? ">>" : "  ";
  const stageMark = hunk.staged ? "[x]" : "[ ]";
  const header = sanitizeText(hunk.rows[0] ?? "@@");
  return `${cursorMark} ${stageMark} hunk ${hunkIndex + 1}/${total} ${header}`;
}

function unifiedBody(state               , compact = false)           {
  const out           = [];
  const total = state.hunks.length;
  state.hunks.forEach((hunk, hunkIndex) => {
    const isCursor = hunkIndex === state.cursor;
    out.push(hunkHeaderLine(hunk, hunkIndex, total, isCursor));
    // The cursor bar prefixes the row instead of replacing the diff sigil,
    // so "+" and "-" stay in column for scanning while the current hunk
    // still stands out without colour.
    const bar = isCursor ? ">" : " ";
    for (const row of hunk.rows.slice(1)) {
      if (!compact) {
        out.push(`${bar} ${sanitizeText(row)}`);
        continue;
      }
      const changed = row.startsWith("+") || row.startsWith("-");
      const marker = changed ? (row[0] ?? " ") : " ";
      const content = changed || row.startsWith(" ") ? row.slice(1) : row;
      out.push(`${marker}${sanitizeText(content)}`);
    }
  });
  return out;
}

function splitBody(state               , width        )           {
  const separator = width >= 20 ? " | " : "|";
  const leftWidth = Math.max(1, Math.floor((width - separator.length) / 2));
  const rightWidth = Math.max(1, width - separator.length - leftWidth);
  const out           = [];
  const total = state.hunks.length;
  state.hunks.forEach((hunk, hunkIndex) => {
    const isCursor = hunkIndex === state.cursor;
    out.push(hunkHeaderLine(hunk, hunkIndex, total, isCursor));
    const start = parseHunkHeader(hunk.rows[0] ?? "");
    let aLine = start.aStart;
    let bLine = start.bStart;
    const left           = [];
    const right           = [];
    for (const row of hunk.rows.slice(1)) {
      // Context lines exist in both files, so they appear in both columns
      // with their own line number; removed lines sit left, added right.
      // Unknown row kinds render as context to stay visible, never dropped.
      if (row.startsWith("-")) {
        left.push(`${aLine}:${sanitizeText(row.slice(1))}`);
        right.push("");
        aLine += 1;
      } else if (row.startsWith("+")) {
        left.push("");
        right.push(`${bLine}:${sanitizeText(row.slice(1))}`);
        bLine += 1;
      } else {
        const text = sanitizeText(row.startsWith(" ") ? row.slice(1) : row);
        left.push(`${aLine}:${text}`);
        right.push(`${bLine}:${text}`);
        aLine += 1;
        bLine += 1;
      }
    }
    const pairs = Math.max(left.length, right.length);
    for (let index = 0; index < pairs; index += 1) {
      out.push(
        `${pad(left[index] ?? "", leftWidth)}${separator}${fit(right[index] ?? "", rightWidth)}`,
      );
    }
  });
  return out;
}

function renderDiffPanel(
  state               ,
  width        ,
  height        ,
  options                      ,
)           {
  const safeWidth = Number.isFinite(width)
    ? Math.max(1, Math.floor(width))
    : 80;
  const safeHeight = Number.isFinite(height)
    ? Math.max(1, Math.floor(height))
    : 1;
  const useColor          = options?.color === true;
  const caps                       = {
    ansi: true,
    colorDepth: 24};
  const paint = (line        , tone                             )         =>
    useColor ? paintWithPalette(line, tone, NOMO_PALETTE, caps, true) : line;

  const total = state.hunks.length;
  const staged = state.hunks.filter((hunk) => hunk.staged).length;
  const counts = diffStats(state.hunks.flatMap((hunk) => hunk.rows));
  const compact = state.side === "split" && safeWidth < 3;
  const displaySide = compact ? "unified" : state.side;
  const header = paint(
    fit(
      `Diff [${displaySide}] staged ${staged}/${total} +${counts.added} -${counts.removed}`,
      safeWidth,
    ),
    "info",
  );
  if (safeHeight === 1) return [header];
  const footer = paint(
    fit("j/k move hunk  space toggle stage  s split  u unified", safeWidth),
    "muted",
  );
  if (safeHeight === 2) return [header, footer];

  // An unchanged pair yields zero hunks; say so explicitly so an empty
  // screen is never mistaken for a failed render.
  const fullBody                    =
    total === 0
      ? ["No differences: before and after are identical."]
      : state.side === "split" && !compact
        ? splitBody(state, safeWidth)
        : unifiedBody(state, compact);
  const bodyCount = safeHeight - 2;
  const scroll = Number.isFinite(state.scroll)
    ? Math.max(0, Math.floor(state.scroll))
    : 0;
  const visible = fullBody.slice(scroll, scroll + bodyCount);
  const body           = visible.map((line, index) => {
    const absolute = scroll + index;
    const hunkStart = isHunkHeaderRow(fullBody, absolute);
    const fitted =
      compact && hunkStart !== null
        ? hunkStart === state.cursor
          ? safeWidth === 1
            ? ">"
            : ">>"
          : " ".repeat(safeWidth)
        : compact && safeWidth === 1 && /^[+-]/.test(line)
          ? line[0] 
          : fit(line, safeWidth);
    return fitted;
  });
  // Fill short screens with blank rows so the panel keeps an exact height
  // for alternate screen repaint callers.
  while (body.length < bodyCount) body.push("");
  return [header, ...body, footer];
}

// Locate which hunk owns an absolute body row by scanning back to the
// nearest hunk header. Header rows are the only body rows starting with
// the cursor or idle hunk mark, so the scan cannot mistake a diff row.
function isHunkHeaderRow(
  body                   ,
  absolute        ,
)                {
  for (let index = absolute; index >= 0; index -= 1) {
    const line = body[index] ?? "";
    const headerMatch = /^(?:>>| {2}) \[[ x]\] hunk (\d+)\/\d+ /.exec(line);
    if (headerMatch) return Number.parseInt(headerMatch[1] ?? "1", 10) - 1;
  }
  return null;
}


//# sourceURL=packages/cli/src/tui/diff-panel.ts

// Structured inspector for detail views (session, document, ledger entry,
// tool). Detail views used to print raw pre-wrapped lines, which made long
// views unscannable; the inspector puts keys on aligned columns under
// uppercase section titles so the eye scans down instead of re-reading rows.

                       
                                                                   

                        
                         
                         
                            
                                                                     
                          
 

                          
                         
                                    
                                                                          
                                    
 

                                
                         
                             
                         
                                        
                                                  
                         
 

                                   
                         
                           
                                  
                                                                             
 

// The inspector speaks its own tone vocabulary so detail views never depend
// on palette names; the mapping happens only at the paint boundary, and with
// no paint callback every tone renders as identical plain text.
const FIELD_TONES                          = {
  default: "fg",
  muted: "muted",
  accent: "accent",
  success: "success",
  warning: "warning",
  error: "error",
};

function paintField(
  paint                           ,
  text        ,
  tone           ,
  bold          ,
)         {
  if (paint === undefined) return text;
  return paint(text, tone, bold);
}

// Cell based wrapper for one sanitized line. Local because layout.ts exposes
// no wrapper and workspace.ts is off limits (import cycle); the code point
// walk mirrors the workspace wrapper so wide glyphs never split mid cell.
function wrapCells$1(line        , width        )           {
  const safe = Math.max(1, width);
  const out           = [];
  let part = "";
  for (const point of line) {
    if (part !== "" && visibleLength(part + point) > safe) {
      out.push(part);
      part = "";
    }
    part += point;
  }
  out.push(part);
  return out;
}

// Splits a sanitized value so the first line fits beside the badge reserve
// and the rest use the full value column. Continuation chunks are measured
// against the value column start, never the label, so a wrapped second line
// cannot be misread as a new field.
function splitValue(
  text        ,
  firstWidth        ,
  restWidth        ,
)           {
  const chunks           = [];
  let part = "";
  let limit = Math.max(1, firstWidth);
  for (const point of text) {
    if (part !== "" && visibleLength(part + point) > limit) {
      chunks.push(part);
      part = "";
      limit = Math.max(1, restWidth);
    }
    part += point;
  }
  chunks.push(part);
  return chunks;
}

// A badge is a padded label (legible without colour) hung off a fixed two-cell
// rail of spaces after the value. The rail is constant and the badge
// trails the value, so adding or removing a badge never moves any value
// column. The badge is fitted and painted from its plain form: fitting
// after painting would strip the ANSI escapes that paint just added.
function badgeText(
  badge        ,
  tone           ,
  width        ,
  paint                           ,
  motion               ,
)         {
  const plain = pill(badge, FIELD_TONES[tone]);
  const fitted = fit(plain, Math.max(1, width));
  return paintField(paint, fitted, tone);
}

function renderField(
  field       ,
  cleanLabel        ,
  labelCol        ,
  width        ,
  paint                           ,
  motion               ,
)           {
  const tone            = field.tone ?? "default";
  // Padding is applied after painting the label so alignment spaces stay
  // unpainted: a paint callback that returns empty (used to prove tones are
  // the only difference) leaves the column skeleton intact.
  const labelCell = pad(
    paintField(paint, fit(cleanLabel, labelCol), "muted"),
    labelCol,
  );
  const valueWidth = width - labelCol - 2;
  const indent = " ".repeat(labelCol + 2);
  const rawBadge = field.badge === undefined ? "" : sanitizeText(field.badge);
  const valuePlain = sanitizeText(field.value);
  const paintChunk = (chunk        )         => paintField(paint, chunk, tone);
  const out           = [];
  if (rawBadge !== "") {
    const reserved =
      visibleLength(pill(rawBadge, FIELD_TONES[tone])) + 2;
    if (valueWidth - reserved >= 1) {
      // Badge fits beside the first value line; later lines use full width.
      const chunks = splitValue(valuePlain, valueWidth - reserved, valueWidth);
      const first = chunks[0] ?? "";
      out.push(
        `${labelCell}: ${paintChunk(first)}  ${badgeText(rawBadge, tone, reserved - 2, paint)}`,
      );
      for (const chunk of chunks.slice(1))
        out.push(`${indent}${paintChunk(chunk)}`);
    } else {
      // No room beside the value, so the badge drops to its own indented
      // line rather than truncating the value it annotates.
      const chunks = splitValue(valuePlain, valueWidth, valueWidth);
      const first = chunks[0] ?? "";
      out.push(`${labelCell}: ${paintChunk(first)}`);
      for (const chunk of chunks.slice(1))
        out.push(`${indent}${paintChunk(chunk)}`);
      out.push(
        `${indent}${badgeText(rawBadge, tone, valueWidth, paint)}`,
      );
    }
  } else {
    const chunks = splitValue(valuePlain, valueWidth, valueWidth);
    const first = chunks[0] ?? "";
    out.push(`${labelCell}: ${paintChunk(first)}`);
    for (const chunk of chunks.slice(1))
      out.push(`${indent}${paintChunk(chunk)}`);
  }
  // Trailing alignment spaces carry no meaning; strip them so narrow
  // terminals and pipe consumers never see invisible padding.
  return out.map((row) => row.replace(/\s+$/, ""));
}

function pushBody(
  rows          ,
  body                               ,
  width        ,
  paint                           ,
)       {
  if (body === undefined) return;
  for (const line of body) {
    for (const chunk of wrapCells$1(sanitizeText(line), width)) {
      rows.push(paintField(paint, chunk, "default"));
    }
  }
}

// Widths below four cells cannot fit even "L: v", so the inspector falls
// back to one fitted line per entry instead of aligned columns. The column
// path below assumes labelCol + ": " + one value cell fits.
function renderNarrow(
  spec               ,
  width        ,
  paint                           ,
  motion               ,
)           {
  const rows           = [];
  const title = sanitizeText(spec.title);
  rows.push(paintField(paint, fit(title, width), "accent", true));
  if (spec.subtitle !== undefined) {
    rows.push(
      paintField(paint, fit(sanitizeText(spec.subtitle), width), "muted"),
    );
  }
  rows.push("-".repeat(width));
  spec.sections.forEach((section, index) => {
    if (index > 0) rows.push("");
    rows.push(
      paintField(
        paint,
        fit(sanitizeText(section.title).toUpperCase(), width),
        "muted",
        true,
      ),
    );
    // "No entries." only when the section is genuinely empty. A section that
    // carries prose instead of fields has entries, and printing the marker
    // above its own content reads as a failure rather than as a heading.
    if (section.fields.length === 0 && (section.body?.length ?? 0) === 0) {
      rows.push(paintField(paint, "No entries.", "muted"));
    }
    for (const field of section.fields) {
      const badge =
        field.badge === undefined || sanitizeText(field.badge) === ""
          ? ""
          : ` [${sanitizeText(field.badge)}]`;
      const line = fit(
        `${sanitizeText(field.label)}: ${sanitizeText(field.value)}${badge}`,
        width,
      );
      rows.push(paintField(paint, line, field.tone ?? "default"));
    }
    pushBody(rows, section.body, width, paint);
  });
  pushHint(rows, spec.hint, width, paint);
  return rows;
}

function pushHint(
  rows          ,
  hint                    ,
  width        ,
  paint                           ,
)       {
  if (hint === undefined) return;
  const clean = sanitizeText(hint);
  // A truncated hint says nothing useful, so it is omitted unless whole.
  if (clean === "" || visibleLength(clean) > width) return;
  rows.push("");
  rows.push(paintField(paint, clean, "muted"));
}

function renderInspector(
  spec               ,
  options                  ,
)           {
  const width = Number.isFinite(options.width)
    ? Math.max(1, Math.floor(options.width))
    : 1;
  const paint = options.paint;
  // Static detail view: hold the first motion frame so two renders of the
  // same spec are byte identical and tests can assert on badge output.
  options.motion ?? motionContext(0, false, true);
  if (width < 4)
    return clipHeight(renderNarrow(spec, width, paint), options.height);
  const rows           = [];
  const iconClean = sanitizeText(spec.icon ?? "");
  // Only single cell icons are shown: layout.ts counts U+2600 to U+27BF as
  // two cells, and a wide icon would break the header fit math.
  const icon =
    iconClean.trim() !== "" && visibleLength(iconClean) === 1
      ? `${iconClean} `
      : "";
  // Sanitize first, fit second, paint last: paint inserts ANSI escapes and
  // sanitizing afterwards would strip or corrupt them.
  rows.push(
    paintField(
      paint,
      fit(`${icon}${sanitizeText(spec.title)}`, width),
      "accent",
      true,
    ),
  );
  if (spec.subtitle !== undefined) {
    rows.push(
      paintField(paint, fit(sanitizeText(spec.subtitle), width), "muted"),
    );
  }
  rows.push("-".repeat(width));
  spec.sections.forEach((section, index) => {
    if (index > 0) rows.push("");
    // Uppercase titles are what make a long inspector skimmable.
    rows.push(
      paintField(
        paint,
        fit(sanitizeText(section.title).toUpperCase(), width),
        "muted",
        true,
      ),
    );
    if (section.fields.length === 0) {
      // A missing title would read as a rendering failure, so an empty
      // section still names itself and says so explicitly. Not when it
      // carries prose instead, which is entries of a different shape.
      if ((section.body?.length ?? 0) === 0)
        rows.push(paintField(paint, "No entries.", "muted"));
    } else {
      // One label column per section, sized to its widest label, so every
      // value in the section starts at the same cell. Capped so at least
      // one value cell always survives, even at narrow widths.
      let widest = 1;
      const cleanLabels = section.fields.map((field) =>
        sanitizeText(field.label),
      );
      for (const label of cleanLabels) {
        widest = Math.max(widest, visibleLength(label));
      }
      const labelCol = Math.min(widest, width - 3);
      section.fields.forEach((field, fieldIndex) => {
        for (const row of renderField(
          field,
          cleanLabels[fieldIndex] ?? "",
          labelCol,
          width,
          paint)) {
          rows.push(row);
        }
      });
    }
    pushBody(rows, section.body, width, paint);
  });
  pushHint(rows, spec.hint, width, paint);
  // The header always pushes at least one row, even with no sections.
  return clipHeight(rows, options.height);
}

// Never returns more than height rows, but never clips to zero either: an
// empty render would read as a failure, so a zero height still shows one row.
function clipHeight(rows          , height                    )           {
  if (height === undefined || !Number.isFinite(height)) return rows;
  return rows.slice(0, Math.max(1, Math.floor(height)));
}


//# sourceURL=packages/cli/src/tui/inspector.ts

const DAMAGED_ANSI_SGR = /\?\[[0-?]*[ -/]*m/g;

function blockText(value        )         {
  return sanitizeText(stripAnsi(value).replace(DAMAGED_ANSI_SGR, ""));
}

// Titled transcript blocks: NOMO prints raw wrapped text while OMP renders
// each event as a block with a role marker, a timestamp, a collapsible body
// and a status footer. This module is that renderer, kept plain text first
// so every state stays legible without colour.

                       
                                                                            

                       
                                                                   

                             
                           
                                      
                        
                                                                 
                       
                                                          
                            
                                                       
                                                  
                                                                             
                               
                                                                  
                                 
                                                
                            
 

                               
                         
                                  
                                                                          
                                       
 

// Iconoir and HugeIcons ship vector artwork; role markers below are one-cell
// terminal analogues, never embedded SVGs. The adjacent role label is the
// readable source of meaning in every color and motion mode.

const ROLE_LABELS                            = {
  user: "USER",
  assistant: "ASSISTANT",
  tool: "TOOL",
  error: "ERROR",
  system: "SYSTEM",
  usage: "USAGE",
  thinking: "THINKING",
};

// The default heading tone per role. Words always carry the meaning beside
// the tone, so a monochrome terminal loses emphasis but never information.
const ROLE_TONES                               = {
  user: "accent",
  assistant: "default",
  tool: "success",
  error: "error",
  system: "muted",
  usage: "muted",
  thinking: "warning",
};

function roleIcon(
  role           ,
  preset               = "unicode",
)         {
  return getSymbols(preset).role[role];
}

function roleLabel(role           )         {
  return ROLE_LABELS[role];
}

// A heading is caller data, so blank or padded headings collapse to absent:
// invisible padding would break the heading scan without adding information.
function displayName(input            )         {
  return blockText(input.heading ?? "").trim();
}

function shortTime(at                    )         {
  // A full ISO timestamp is wider than most terminals and nobody reads the
  // date of the message they just sent, so the heading carries a short local
  // time. An absent or invalid timestamp prints nothing rather than a raw
  // exception value on screen.
  if (at === undefined || at.trim() === "") return "";
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return "";
  const date = new Date(ms);
  const hours = date.getHours();
  const minutes = date.getMinutes();
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return "";
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function lifecycleLabel(status                      )                     {
  if (status === "running") return "requested";
  if (status === "done") return "completed";
  if (status === "failed") return "failed";
  return undefined;
}

/** Heading row for one block: icon, role, action, state and timestamp. */
function blockHeading(
  input            ,
  width        ,
  preset               = "unicode",
)         {
  const safe = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
  const name = displayName(input);
  const role = roleLabel(input.role);
  const hasDistinctName =
    name !== "" && name.toLowerCase() !== role.toLowerCase();
  const state =
    input.role === "tool" ? lifecycleLabel(input.status) : undefined;
  // The tool icon already carries the role. Lead with its actual name to
  // avoid repeating the generic "TOOL" label beside "Tool" or "Bash".
  const identity =
    input.role === "tool" && hasDistinctName
      ? [name, ...(state ? [state] : [])].join(" · ")
      : [role, ...(state ? [state] : [])].join(" · ");
  const base = `${roleIcon(input.role, preset)} ${identity}`;
  const time = shortTime(
    input.at === undefined ? undefined : blockText(input.at),
  );
  if (time !== "" && visibleLength(`${base} ${time}`) <= safe)
    return `${base} ${time}`;
  // A heading broken across two lines stops being a heading, so it is
  // fitted to one row; the timestamp already dropped out above.
  return fit(base, safe);
}

// Cell based wrapper for one sanitized line. Local because layout.ts
// exposes no wrapper and workspace.ts is off limits (import cycle); it
// mirrors the inspector wrapper so wide glyphs never split mid cell.
function wrapCells(line        , width        )           {
  const safe = Math.max(1, width);
  const out           = [];
  let part = "";
  for (const point of line) {
    if (part !== "" && visibleLength(part + point) > safe) {
      out.push(part);
      part = "";
    }
    part += point;
  }
  out.push(part);
  return out;
}

function wrapBody(input            , width        )           {
  // sanitizeText maps newline to "?" (it guards terminal injection), so the
  // body is split into lines before sanitising; sanitising first would fuse
  // every multi-line body into one row of question marks.
  if (input.text === "") return [];
  const rows           = [];
  for (const raw of input.text.split("\n")) {
    // CRLF is a line ending, not body content, so the carriage return goes
    // before sanitising turns it into a visible question mark.
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    // Keep line shape intact, but remove terminal styling before sanitizing
    // control characters so damaged ANSI fragments cannot leak into the UI.
    for (const chunk of wrapCells(blockText(line), width)) rows.push(chunk);
  }
  return rows;
}

                         
                          
                         
                         
                          
 

function collapseBody(
  all                   ,
  maxRows        ,
  collapsible         ,
  width        ,
)                {
  const total = all.length;
  // An empty body is reported, never rendered as silence: a blank block
  // reads as a rendering failure rather than as an empty answer.
  if (total === 0) return { rows: ["(empty)"], shown: 0, total: 0, hidden: 0 };
  const asked = Number.isFinite(maxRows)
    ? Math.max(1, Math.floor(maxRows))
    : total;
  // A caller that marks a block non-collapsible takes responsibility for the
  // height; the budget is then advisory and the body prints whole.
  const budget = collapsible ? asked : total;
  if (budget >= total)
    return { rows: [...all], shown: total, total, hidden: 0 };
  const shown = Math.max(0, budget - 1);
  const hidden = total - shown;
  // The marker names the hidden count, so a cut body can never pass as a
  // short one; silently cutting the body is the defect this replaces.
  const marker = fit(
    `... ${hidden} more line${hidden === 1 ? "" : "s"}`,
    width,
  );
  return { rows: [...all.slice(0, shown), marker], shown, total, hidden };
}

// Motion glyphs are built plain and fitted before painting, the inspector
// badge pattern: fitting after painting would strip the escapes paint just
// inserted. Tool state is written in the heading; the footer carries measured
// duration or collapsed-row information only.
function footerPlain(
  input            ,
  body               ,
  width        ,
  motion               ,
)                     {
  if (input.role === "tool") {
    const details           = [];
    if (
      typeof input.durationMs === "number" &&
      Number.isFinite(input.durationMs)
    ) {
      const duration =
        input.durationMs < 1_000
          ? `${Math.round(input.durationMs)}ms`
          : `${(input.durationMs / 1_000).toFixed(1)}s`;
      details.push(`${duration} elapsed`);
    }
    if (body.hidden > 0) details.push(`${body.shown} of ${body.total} lines`);
    return details.length ? details.join(" · ") : undefined;
  }
  const counts =
    body.hidden > 0 ? ` · ${body.shown} of ${body.total} lines` : "";
  if (input.role === "error") {
    return `${completionRing(0, 1)} failed · see above${counts}`;
  }
  if (input.role === "thinking") {
    return `${cursorMarker(true)}thinking ${idleBreath(motion)}${counts}`;
  }
  if (input.role === "usage") {
    // The meter measures shown against total body rows: how much of the
    // report survived the row budget, a real measurement, not decoration.
    const meterText = levelMeter(
      body.shown,
      Math.max(1, body.total),
      8,
      motion,
    );
    return `${meterText} ${body.shown} of ${body.total} lines`;
  }
  if (body.hidden === 0) return undefined;
  // A collapsed body without a status role still reports progress: the bar
  // fills with shown over total rows and the words state the same count.
  const progress = `${body.shown} of ${body.total} lines`;
  const barWidth = Math.max(1, width - visibleLength(progress) - 1);
  return `${animatedBar(body.shown, Math.max(1, body.total), barWidth, motion)} ${progress}`;
}

/** The whole block: heading, body, optional footer. */
function renderBlock(
  input            ,
  options              ,
  maxRows         ,
)           {
  const width = Number.isFinite(options.width)
    ? Math.max(1, Math.floor(options.width))
    : 1;
  // Static detail frame by default, like the inspector: two renders of the
  // same block stay byte identical and tests can assert on footer output.
  const motion                = options.motion ?? motionContext(0, false, true);
  const symbolPreset = options.symbolPreset ?? "unicode";
  const paint = options.paint;
  // Sanitising happens inside the builders while the text is still plain;
  // paint runs last here, never the other way round.
  const paintLine = (text        , tone           , bold          )         =>
    paint === undefined ? text : paint(text, tone, bold);
  const rows           = [];
  const headingTone            =
    input.tone ??
    (input.role === "tool" && input.status === "failed"
      ? "error"
      : input.role === "tool" && input.status === "running"
        ? "warning"
        : ROLE_TONES[input.role]);
  rows.push(
    paintLine(
      fit(blockHeading(input, width, symbolPreset), width),
      headingTone,
      true,
    ),
  );
  const all = wrapBody(input, width);
  const budget = maxRows === undefined ? all.length : maxRows;
  const body = collapseBody(all, budget, input.collapsible !== false, width);
  body.rows.forEach((row, index) => {
    const marker = body.hidden > 0 && index === body.rows.length - 1;
    rows.push(paintLine(fit(row, width), marker ? "muted" : "default"));
  });
  const footer = footerPlain(input, body, width, motion);
  if (footer !== undefined)
    rows.push(
      paintLine(
        fit(footer, width),
        input.role === "tool" && input.status === "failed"
          ? "error"
          : ROLE_TONES[input.role],
      ),
    );
  // A block always says something, even at width 1 with an empty body.
  if (rows.length === 0)
    rows.push(paintLine(fit("(empty block)", width), "muted"));
  return rows;
}


//# sourceURL=packages/cli/src/tui/blocks.ts

// Class grouped browser for the tools tab: tools grouped by risk class,
// filterable, with the input schema stated as a property table.
//
// The tools tab used to list every tool as one flat row and dump the schema
// as raw JSON on Enter. A flat list hides the risk cut an operator reasons
// about first, and raw JSON is unscannable at a glance, so this module groups
// by class (low risk first) and states each schema property as name, type,
// required or optional, and description.
                                       

/** One tool as the browser sees it. Schemas stay unknown: they are read, never run. */
                              
                      
                        
                                                 
                         
                                                          
                          
                                
                                                   
                                  
                                                                             
                                 
 

                                  
                             
                                  
                                                                          
 

// ASCII only, so every icon is exactly one cell under layout.ts. Anything in
// U+2600 to U+27BF counts as two cells and would break the fixed gutter math,
// and a wider icon set would need a font the operator may not have.
const ICON_R0 = "o";
const ICON_R1 = "!";
const ICON_R2 = "x";
const ICON_UNKNOWN$1 = "?";

                                                                    

// The tone is decoration only: every call site pairs it with the class word
// and icon, so a monochrome terminal loses nothing when paint is identity.
function classTone(klass        )            {
  const key = klass.trim().toUpperCase();
  if (key === "R0") return "success";
  if (key === "R1") return "warning";
  if (key === "R2") return "error";
  return "default";
}

/** One cell for any input, including an empty or malformed class string. */
function classIcon(klass        )         {
  const key = klass.trim().toUpperCase();
  if (key === "R0") return ICON_R0;
  if (key === "R1") return ICON_R1;
  if (key === "R2") return ICON_R2;
  return ICON_UNKNOWN$1;
}

// classTone speaks the browser vocabulary ("default" is not a palette tone),
// so the mapping to a real palette tone happens only at the paint boundary.
function classPaletteTone(tone           )       {
  if (tone === "success" || tone === "warning" || tone === "error") return tone;
  return "muted";
}

// Code unit order, not locale order: localeCompare varies by machine, which
// would break the cross-frame determinism callers rely on.
function compareStrings$1(a        , b        )         {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// An operator reasoning about risk reads low risk first. R0, R1, R2 hold the
// first three bands in that order; an unrecognised class must not sort into a
// risk band it was never measured into, so it trails alphabetically.
function groupRank(klass        )         {
  const key = klass.trim().toUpperCase();
  if (key === "R0") return 0;
  if (key === "R1") return 1;
  if (key === "R2") return 2;
  return 3;
}

function safeWidth(width        )         {
  return Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
}

function resolveMotion$3(motion                           )                {
  // Static browser view: hold the first frame so two renders of the same
  // state are byte identical, matching the inspector convention.
  return motion ?? motionContext(0, false, true);
}

/** Group tools by class: R0, R1, R2 first, then anything else alphabetically. */
function groupTools(
  tools                        ,
)                                                                       {
  const byClass = new Map                       ();
  for (const tool of tools) {
    const list = byClass.get(tool.klass);
    if (list === undefined) byClass.set(tool.klass, [tool]);
    else list.push(tool);
  }
  const groups = [...byClass.entries()].map(([klass, members]) => ({
    klass,
    // Deterministic order means the row an operator remembered is still
    // there: sort by name, keep input order for exact ties (stable sort).
    tools: [...members].sort((a, b) => compareStrings$1(a.name, b.name)),
  }));
  groups.sort((a, b) => {
    const rank = groupRank(a.klass) - groupRank(b.klass);
    if (rank !== 0) return rank;
    return compareStrings$1(a.klass, b.klass);
  });
  return groups;
}

/** Match name, class, source and description, case insensitively. */
function filterTools(
  tools                        ,
  query        ,
)                {
  const needle = query.trim().toLowerCase();
  // An empty query is "no filter", not "match nothing": it returns every tool.
  if (needle === "") return [...tools];
  return tools.filter((tool) => {
    const haystacks                    = [
      tool.name,
      tool.klass,
      tool.source,
      tool.description ?? "",
    ];
    return haystacks.some((field) => field.toLowerCase().includes(needle));
  });
}

function undoLabel(tool             )         {
  return tool.capturedUndo === true ? "undo" : "no undo";
}

function undoCount(tools                        )         {
  let count = 0;
  for (const tool of tools) {
    if (tool.capturedUndo === true) count += 1;
  }
  return count;
}

// One group heading: icon plus the class word, so the class is never a glyph
// alone. The counts are words, never the ring alone: the completion ring is
// decoration on top of "undo k/n", which reads on a monochrome terminal.
function headingRow(
  klass        ,
  members                        ,
  width        ,
  motion               ,
  paint                                                        ,
)         {
  const tone = classTone(klass);
  const icon = paint(classIcon(klass), tone, true);
  const word = sanitizeText(klass.trim() === "" ? "unclassified" : klass);
  const count = members.length;
  const undone = undoCount(members);
  const ring = completionRing(undone, Math.max(1, count));
  const noun = count === 1 ? "tool" : "tools";
  return fit(
    `  ${icon} ${word} -- ${count} ${noun}, undo ${undone}/${count} ${ring}`,
    width,
  );
}

// One tool row: fixed two cell gutter (the cursor marker is always two cells,
// selected or not, so selecting a row never shifts the others), then name,
// source, and whether Undo was captured. The Undo fact is the one operators
// most often miss, so it rides on the row rather than only in the detail.
function toolRow(
  tool             ,
  selected         ,
  width        ,
  motion               ,
  paint                                                        ,
)         {
  const tone = classTone(tool.klass);
  const gutter = cursorMarker(selected);
  const icon = paint(classIcon(tool.klass), tone, selected);
  const name = paint(sanitizeText(tool.name), "default", selected);
  const source = paint(sanitizeText(tool.source), "muted");
  // The undo marker is an accented label when captured, plain words when not:
  // both states read without colour, and the label never shows
  // an invented state, only what the tool reported.
  const undo =
    tool.capturedUndo === true
      ? pill("undo", classPaletteTone(tone), motion, {
          paint: (text        , pillTone      , bold          ) =>
            paint(text, pillTone, bold),
        })
      : paint(undoLabel(tool), "muted");
  return fit(`${gutter}${icon} ${name} -- ${source} ${undo}`, width);
}

/**
 * Group headings plus one row per tool, every row fitted to width. The
 * selected index counts tool rows in display order (headings excluded), so it
 * matches the cursor the operator moves; negative or out of range selects
 * nothing. Never returns an empty array: no tools yields one line saying so.
 */
function toolRows(
  tools                        ,
  width        ,
  options                  ,
)           {
  const cells = safeWidth(width);
  const motion = resolveMotion$3(options?.motion);
  const paint = options?.paint ?? ((text        )         => text);
  if (tools.length === 0) return [fit("No tools.", cells)];
  const selected = options?.selected ?? -1;
  const groups = groupTools(tools);
  const rows           = [];
  let index = 0;
  for (const group of groups) {
    rows.push(headingRow(group.klass, group.tools, cells, motion, paint));
    for (const tool of group.tools) {
      rows.push(toolRow(tool, index === selected, cells, motion, paint));
      index += 1;
    }
  }
  return rows;
}

function isRecord$2(value         )                                   {
  return typeof value === "object" && value !== null;
}

function propertyType(schema         )         {
  if (!isRecord$2(schema)) return "unknown";
  const type          = schema["type"];
  if (typeof type === "string" && type.trim() !== "") return type;
  // A union such as ["string", "null"] is stated joined, never guessed: the
  // first entry alone would claim more than the tool declared.
  if (
    Array.isArray(type) &&
    type.every((entry)                  => typeof entry === "string")
  ) {
    const joined = type.filter((entry) => entry.trim() !== "").join("/");
    if (joined !== "") return joined;
  }
  return "unknown";
}

function propertyDescription(schema         )                     {
  if (!isRecord$2(schema)) return undefined;
  const description          = schema["description"];
  if (typeof description !== "string" || description.trim() === "") {
    return undefined;
  }
  return description;
}

function requiredSet(schema                         )              {
  const required          = schema["required"];
  if (!Array.isArray(required)) return new Set();
  const out = new Set        ();
  for (const entry of required) {
    if (typeof entry === "string") out.add(entry);
  }
  return out;
}

/**
 * The input schema as a property table via the shared inspector: one aligned
 * field per property (name, type, required or optional, description), never
 * raw JSON. A schema that is not an object, is a string, is null, or is
 * missing yields one line saying the tool declares no schema rather than
 * throwing. Every value passes through the inspector, which sanitises before
 * painting, so a description carrying control characters renders visibly
 * marked, never raw. Nothing from the schema is ever evaluated.
 */
function toolSchemaLines(tool             , width        )           {
  const cells = safeWidth(width);
  const schema          = tool.inputSchema;
  if (!isRecord$2(schema)) return [fit("Tool declares no input schema.", cells)];
  const properties          = schema["properties"];
  if (!isRecord$2(properties)) {
    return [fit("Tool declares no input properties.", cells)];
  }
  const names = Object.keys(properties);
  if (names.length === 0) {
    return [fit("Tool declares no input properties.", cells)];
  }
  // Code unit order, matching the browser row order rule: the property an
  // operator remembered stays where it was.
  const ordered = [...names].sort(compareStrings$1);
  const required = requiredSet(schema);
  let requiredCount = 0;
  const fields = ordered.map((name) => {
    const prop = properties[name];
    const isRequired = required.has(name);
    if (isRequired) requiredCount += 1;
    const type = propertyType(prop);
    const state = isRequired ? "required" : "optional";
    const description = propertyDescription(prop);
    // Sanitize before composing: the inspector sanitises again, and double
    // sanitising is idempotent, while composing raw would risk a control
    // character surviving if this line ever bypassed the inspector.
    const cleanType = sanitizeText(type);
    const value =
      description === undefined
        ? `${cleanType}, ${state}`
        : `${cleanType}, ${state} -- ${sanitizeText(description)}`;
    return {
      label: name,
      value,
      tone: (isRequired ? "accent" : "default")                        ,
    };
  });
  const motion = resolveMotion$3(undefined);
  // The meter is countable segments, so the required share reads without
  // colour; the words beside it state the same fact for a screen reader.
  const meter = levelMeter(
    requiredCount,
    Math.max(1, ordered.length),
    8,
    motion,
  );
  return renderInspector(
    {
      title: `Schema: ${tool.name}`,
      subtitle: `${tool.klass} -- ${tool.source}`,
      icon: classIcon(tool.klass),
      sections: [
        {
          title: "Tool",
          fields: [
            { label: "class", value: tool.klass },
            { label: "source", value: tool.source },
            { label: "undo", value: undoLabel(tool) },
            {
              label: "required",
              value: `${requiredCount} of ${ordered.length} ${meter}`,
            },
          ],
          body:
            tool.description === undefined || tool.description.trim() === ""
              ? undefined
              : [tool.description],
        },
        { title: "Properties", fields },
      ],
    },
    { width: cells },
  );
}


//# sourceURL=packages/cli/src/tui/tool-browser.ts

// One place to see whether the workspace is actually healthy. Today the
// operator checks the provider here, the ledger there and connectors
// somewhere else, and a corrupted ledger only surfaces as an error after a
// run. This panel checks every subsystem and says pass or fail with the
// reason, so a broken subsystem is visible before it costs a run.
                                                           
                                       

                                                                         

                        
                                                                  
                        
                                                   
                        
                              
                                                                 
                          
                                                         
                           
 

// Single cell under layout.ts, which counts U+2600 to U+27BF as two cells.
// Every state needs a distinct shape because colour alone is unreadable to
// part of the audience, and the shapes stay distinct at one cell.
const HEALTH_ICONS                              = {
  ok: "●",
  warn: "◔",
  fail: "×",
  unknown: "?",
  skipped: "▪",
};

// The word is the signal and the icon is decoration: a screen reader and a
// monochrome terminal both get the full meaning from the word alone.
const HEALTH_WORDS                              = {
  ok: "ok",
  warn: "warn",
  fail: "fail",
  unknown: "unknown",
  skipped: "skipped",
};

// unknown is muted, never success: a check that could not run is not a check
// that passed, and painting it the pass colour would convert an absence of
// information into an assurance. skipped is the neutral default tone: it is
// neither good nor bad, only not applicable on this host.
const HEALTH_TONES         
              
                                                       
  = {
  ok: "success",
  warn: "warning",
  fail: "error",
  unknown: "muted",
  skipped: "default",
};

/** The glyph for a state. Always paired with healthWord at the call site. */
function healthIcon(state             )         {
  return HEALTH_ICONS[state] ?? "?";
}

/** The word for a state. This is the signal; the icon is decoration. */
function healthWord(state             )         {
  return HEALTH_WORDS[state] ?? "unknown";
}

function healthTone(
  state             ,
)                                                        {
  return HEALTH_TONES[state] ?? "muted";
}

// A check that could not run outranks a known degradation: an unknown check
// can hide a failure, while a warn is confirmed working with a caveat.
// skipped outranks ok only because it is unmeasured, never because it is bad.
function severityRank(state             )         {
  switch (state) {
    case "fail":
      return 0;
    case "unknown":
      return 1;
    case "warn":
      return 2;
    case "skipped":
      return 3;
    case "ok":
      return 4;
  }
}

// Plain string order, never localeCompare: the sort must be byte identical
// on every host regardless of ICU locale data, which is what determinism
// means for an operator comparing two captures.
function compareText(a        , b        )         {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Checks ordered worst first, then by area. */
function orderChecks(checks                  )          {
  return checks
    .map((check, index) => ({ check, index }))
    .sort(
      (a, b) =>
        severityRank(a.check.state) - severityRank(b.check.state) ||
        compareText(sanitizeText(a.check.area), sanitizeText(b.check.area)) ||
        compareText(sanitizeText(a.check.name), sanitizeText(b.check.name)) ||
        a.index - b.index,
    )
    .map((entry) => entry.check);
}

// The inspector has no "default" tone key, so the neutral state maps to the
// same base text tone the inspector itself uses for it. The pill is built
// unpainted here and the inspector paints the field afterwards, so the tone
// only matters for painted output and never for the plain words.
function pillTone(state             )       {
  const tone = healthTone(state);
  return tone === "default" ? "fg" : tone;
}

// Every segment is sanitized before composing the value, because details can
// arrive from a server or an agent and sanitizing after paint would strip the
// escapes paint just inserted. An empty detail falls back to the state word,
// which the pill already carries, so a check with no explanation still says
// what state it is in instead of printing a blank. A missing remedy prints
// nothing at all, never an empty remedy line.
function buildValue(check       , motion               )         {
  const icon         = healthIcon(check.state);
  const statePill         = pill(
    healthWord(check.state),
    pillTone(check.state));
  const detail         = sanitizeText(check.detail).trim();
  const core         =
    detail !== "" ? `${icon} ${statePill} · ${detail}` : `${icon} ${statePill}`;
  const remedy         =
    check.remedy === undefined ? "" : sanitizeText(check.remedy).trim();
  return remedy !== "" ? `${core} (fix: ${remedy})` : core;
}

function checkLabel(check       , index        )         {
  const name         = sanitizeText(check.name).trim();
  return name !== "" ? name : `unnamed check ${index + 1}`;
}

function areaTitle(area        )         {
  const clean         = sanitizeText(area).trim();
  return clean !== "" ? clean : "general";
}

/** Grouped render, worst area first. */
function renderHealth(
  checks                  ,
  width        ,
  options    
                                    
                                                                            
                             
   ,
)           {
  const cells         = Number.isFinite(width)
    ? Math.max(0, Math.floor(width))
    : 0;
  // A health panel that renders nothing reads as a failure of the panel
  // itself, so even a zero width returns one (empty) row, never zero rows.
  if (cells <= 0) return [""];
  if (checks.length === 0)
    return [fit(sanitizeText("No health checks ran."), cells)];
  // Static view: the frozen first frame keeps two renders byte identical.
  // pill ignores the frame, so even a live motion context cannot move output.
  const motion                =
    options?.motion ?? motionContext(0, false, true);
  const ordered          = orderChecks(checks);
  // First appearance in worst-first order is the worst-area-first order:
  // every area's first row is its worst check, and areas are already sorted
  // by that row, so grouping below preserves the ordering for free.
  const areas                                                         = [];
  const seen = new Map                 ();
  ordered.forEach((check, position) => {
    const title         = areaTitle(check.area);
    let fields                      = seen.get(title);
    if (fields === undefined) {
      fields = [];
      seen.set(title, fields);
      areas.push({ title, fields });
    }
    fields.push({
      label: checkLabel(check, position),
      value: buildValue(check),
      tone: healthTone(check.state),
    });
  });
  const spec                = {
    title: "Health",
    subtitle: healthSummary(checks),
    sections: areas.map((area) => ({ title: area.title, fields: area.fields })),
  };
  // The inspector owns the columns: reusing it keeps one column renderer in
  // the codebase and guarantees every row fits the width, including the
  // wrapped continuation lines of long details. Height clips to at least one
  // row, so a cramped panel still names itself instead of going blank.
  return renderInspector(spec, {
    width: cells,
    height: options?.height,
    motion,
    paint: options?.paint,
  });
}

// Counts for the summary. skipped is tracked apart from passes: it is
// neither good nor bad, so folding it into either count would mislead.
function countBy(checks                  , state             )         {
  let total = 0;
  for (const check of checks) {
    if (check.state === state) total += 1;
  }
  return total;
}

// Names one check and its reason on a single line. The reason falls back to
// the state word when empty, for the same reason the renderer does: a blank
// names nothing to act on.
function nameWorst(check       )         {
  const name         =
    sanitizeText(check.name).trim() !== ""
      ? sanitizeText(check.name).trim()
      : "unnamed check";
  const detail         = sanitizeText(check.detail).trim();
  const reason         = detail !== "" ? detail : healthWord(check.state);
  return `${name} -- ${reason}`;
}

/** One sentence: is this workspace healthy, and if not what is wrong. */
function healthSummary(checks                  )         {
  if (checks.length === 0) return "No health checks ran.";
  const ordered          = orderChecks(checks);
  const worst        = ordered[0] ?? checks[0] ;
  const fails         = countBy(checks, "fail");
  if (fails > 0) {
    const extra         = fails > 1 ? ` (${fails - 1} more failing)` : "";
    return `Failing: ${nameWorst(worst)}${extra}`;
  }
  const unknowns         = countBy(checks, "unknown");
  if (unknowns > 0) {
    const extra         = unknowns > 1 ? ` (${unknowns - 1} more unknown)` : "";
    return `Unknown: ${nameWorst(worst)}${extra}`;
  }
  const warns         = countBy(checks, "warn");
  if (warns > 0) {
    const extra         = warns > 1 ? ` (${warns - 1} more warnings)` : "";
    return `Warning: ${nameWorst(worst)}${extra}`;
  }
  const skipped         = countBy(checks, "skipped");
  const passed         = countBy(checks, "ok");
  // All skipped is not healthy and not broken: nothing was measured, so the
  // summary says health is unverified rather than claiming a pass.
  if (passed === 0 && skipped > 0)
    return skipped === 1
      ? "1 check skipped; health unverified."
      : `All ${skipped} checks skipped; health unverified.`;
  if (skipped > 0)
    return `Healthy: ${passed} of ${checks.length} checks pass, ${skipped} skipped.`;
  if (passed === 1) return "Healthy: 1 check passes.";
  return `Healthy: all ${passed} checks pass.`;
}


//# sourceURL=packages/cli/src/tui/health.ts

// Discovery panel for the operator who knows five commands out of sixty
// seven. Commands are grouped by the task the operator arrived with, so a
// newcomer scans tasks instead of memorising slash names.

// The tasks a person actually arrives with, in arrival order. Newcomers
// think in tasks, not in declaration order, so groupedCommands follows
// this order rather than the order commands were registered in.
const DISCOVERY_GROUPS                    = [
  "starting",
  "reading",
  "writing",
  "running",
  "watching",
  "sharing",
  "configuring",
];

// One icon per group, each verified single cell. layout.ts counts U+2600
// to U+27BF as two cells, so these stay in the geometric and arrow ranges
// below U+2600 plus plain ASCII; a two cell icon would shift every column
// after it in the aligned inspector output.
const GROUP_ICONS                         = {
  starting: "▷",
  reading: "≡",
  writing: "+",
  running: "↻",
  watching: "◉",
  sharing: "⇥",
  configuring: "⌘",
};

// Plain language purpose per group. The overview row shows this instead of
// a command dump, because a newcomer first needs to know which task a
// group serves before learning any slash names.
const GROUP_BLURBS                         = {
  starting: "Start a session and find your way",
  reading: "Find and read what is already there",
  writing: "Change files and record why",
  running: "Run work and follow its progress",
  watching: "Check health, holds and history",
  sharing: "Bring other people and agents along",
  configuring: "Tune keys, models and defaults",
};

// Deliberate absences, matching what the workspace already tells the
// operator: background tasks, clipboard image paste and text paste, voice,
// and Vim editing have no NOMO equivalent. Each sentence says what to do instead, so an operator
// who expected the feature learns it is absent on purpose rather than
// assuming it is broken.
const ABSENT                    = [
  "Background tasks have no equivalent here -- keep the session open while a run works instead of parking it in the background.",
  "Clipboard paste has no shortcut beyond the operating system's normal terminal paste; clipboard image attachments are unsupported.",
  "Live voice and speech input have no NOMO TUI backend here.",
  "Vim editing has no equivalent here -- press Ctrl+G for the configured editor, or type directly at the prompt.",
];

/** One command, in the shape the panel needs. */
                               
                                                                          
                      
                                      
                           
                                                                      
                          
 

                                   
                         
                                  
                                                                          
 

function groupIcon(group        )         {
  const key = sanitizeText(group).trim().toLowerCase();
  const candidate = GROUP_ICONS[key] ?? "?";
  // Any input, including empty and malformed, must yield exactly one cell:
  // the lookup already falls back to "?", and this guard catches a future
  // icon edit that accidentally introduces a wide glyph.
  return visibleLength(candidate) === 1 ? candidate : "?";
}

function groupTitle(group        )         {
  const clean = sanitizeText(group);
  // Uppercase titles make a long grouped list skimmable. An unrecognised
  // group is returned unchanged rather than invented, because a made up
  // name would promise a task grouping that does not exist.
  if (DISCOVERY_GROUPS.includes(clean.trim().toLowerCase()))
    return clean.trim().toUpperCase();
  return clean;
}

// Normalise a raw group into its canonical bucket. Matching is case
// insensitive so "Reading" and "reading" do not split one task into two
// headings. Commands with no group land in "other" so they stay visible
// instead of vanishing from the panel.
function canonicalGroup(raw                    )         {
  const key = sanitizeText(raw ?? "")
    .trim()
    .toLowerCase();
  if (key === "") return "other";
  if (DISCOVERY_GROUPS.includes(key)) return key;
  return key;
}

/** Commands grouped, with a count per group. */
function groupedCommands(
  commands                         ,
)                                                                           {
  // An empty input still returns one named heading: an empty array reads as
  // "the list failed", while a named empty group lets the panel print an
  // honest "no commands" line under it.
  if (commands.length === 0)
    return [{ group: DISCOVERY_GROUPS[0] ?? "general", commands: [] }];
  const buckets = new Map                        ();
  for (const command of commands) {
    const key = canonicalGroup(command.group);
    const bucket = buckets.get(key);
    if (bucket !== undefined) bucket.push(command);
    else buckets.set(key, [command]);
  }
  const out   
                           
                                               
      = [];
  for (const known of DISCOVERY_GROUPS) {
    const bucket = buckets.get(known);
    // Empty headings cannot appear: a group is only pushed when at least
    // one command landed in it, so "none of this exists" never looks like
    // a rendering failure.
    if (bucket !== undefined && bucket.length > 0) {
      out.push({ group: known, commands: bucket });
      buckets.delete(known);
    }
  }
  // Anything unrecognised sorts last, alphabetically by code unit order
  // rather than locale order, so two runs in different locales agree byte
  // for byte.
  const rest = [...buckets.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  );
  for (const [name, bucket] of rest) {
    if (bucket.length > 0) out.push({ group: name, commands: bucket });
  }
  if (out.length === 0)
    return [{ group: DISCOVERY_GROUPS[0] ?? "general", commands: [] }];
  return out;
}

// Purpose line for a group heading. Unknown groups get a generic sentence
// rather than an invented task name, for the same reason groupTitle does
// not invent names.
function groupBlurb(group        )         {
  return GROUP_BLURBS[group] ?? "More commands outside the main tasks";
}

/** One line per group: how many commands and what the group is for. */
function discoveryRows(
  commands                         ,
  options                   ,
)           {
  const width = Number.isFinite(options?.width ?? 0)
    ? Math.max(1, Math.floor(options?.width ?? 0))
    : 1;
  // Frozen first frame by default, so two calls with the same input are
  // byte identical and the panel never animates unless asked to.
  const motion                =
    options?.motion ?? motionContext(0, false, true);
  const outerPaint = options?.paint;
  const paint =
    outerPaint === undefined
      ? undefined
      : (text        , tone           , bold          )         =>
          outerPaint(text, tone, bold);
  const total = commands.length;
  // The breathing dot marks the panel as live, while the words beside it
  // carry the meaning, so nothing is lost on a monochrome terminal.
  const icon = idleBreath(motion);
  if (commands.length === 0) {
    // One section with no fields and an explicit body line: the inspector
    // prints "No entries." plus the body, so the panel never renders empty.
    return renderInspector(
      {
        title: "Discovery",
        subtitle: "0 commands in 0 groups",
        icon,
        sections: [
          { title: "Groups", fields: [], body: ["No commands registered."] },
        ],
      },
      { width, motion, paint },
    );
  }
  const groups = groupedCommands(commands);
  const subtitle =
    total === 1
      ? "1 command in 1 group"
      : `${total} commands in ${groups.length} groups`;
  // One field per group: the inspector is the single column renderer, so
  // labels align without a second implementation. The count rides as a
  // padded badge, legible without colour; the meter beside the blurb
  // shows the group's share as shape, never as the only signal.
  const fields          = groups.map((entry) => ({
    label: `${groupIcon(entry.group)} ${groupTitle(entry.group)}`,
    value: `${groupBlurb(entry.group)} ${levelMeter(entry.commands.length, Math.max(1, total), 4, motion)}`,
    badge: `${entry.commands.length}`,
  }));
  return renderInspector(
    {
      title: "Discovery",
      subtitle,
      icon,
      sections: [{ title: "Groups", fields }],
      // The count of what this product deliberately lacks belongs on the
      // panel itself, so the operator meets it next to the counts of what
      // exists. Narrow terminals drop overlong hints by design.
      hint: `${ABSENT.length} capabilities deliberately absent -- see the absent list.`,
    },
    { width, motion, paint },
  );
}

/** The commands this product deliberately does not have, named and said. */
function absentCapabilities()           {
  // A fresh copy each call: callers can reorder or trim for display
  // without corrupting the module constant for the next caller.
  return [...ABSENT];
}


//# sourceURL=packages/cli/src/tui/discover.ts

// A run rendered as a timeline: which phase it is in, how long each phase
// took, and what each step cost. The run list elsewhere shows events and
// counters; this view answers the next question, where the time and the
// tokens went, in the same frame the operator is already watching.

                      
            
              
              
          
             
               
              
          
            
              

                               
                           
                                                                
                       
                                                             
                           
                                                        
                           
 

                                
                                          
                           
 

                                  
                                  
                                                                          
 

                                
                              
                                  
                                                                          
 

// ASCII only, so every icon is exactly one cell under layout.ts. Anything in
// U+2600 to U+27BF counts as two cells and would misalign the bar column, and
// a wider icon set would need a font the operator may not have.
const PHASE_ICONS                           = {
  queued: "+",
  starting: ">",
  thinking: "~",
  tool: "*",
  writing: "=",
  verifying: "v",
  settling: "-",
  done: "o",
  failed: "x",
  unknown: "?",
};

// The tone is decoration only: every row also prints the icon and the word,
// so a monochrome terminal loses nothing when paint is the identity.
function phaseTone(phase          )         {
  if (phase === "failed") return "r3";
  if (phase === "done") return "r0";
  if (phase === "unknown") return "muted";
  return "accent";
}

/** The glyph for a phase. Always paired with phaseLabel at the call site. */
function phaseIcon(phase          )         {
  return PHASE_ICONS[phase] ?? "?";
}

/** The word for a phase. This is the signal; the icon is decoration. */
function phaseLabel(phase          )         {
  return phase;
}

function isRecord$1(value         )                                   {
  return typeof value === "object" && value !== null;
}

function firstString(
  record                         ,
  keys                   ,
)                     {
  for (const key of keys) {
    const value          = record[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

function firstNumber(
  record                         ,
  keys                   ,
)                     {
  for (const key of keys) {
    const value          = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function eventTimestamp(record                         )                     {
  const numeric                     = firstNumber(record, [
    "ts",
    "timestamp",
    "time",
    "at",
  ]);
  if (numeric !== undefined) return numeric;

  const value          = record["at"];
  if (typeof value !== "string") return undefined;
  const timestamp         = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return new Date(timestamp).toISOString() === value ? timestamp : undefined;
}

// Map one event to a phase. Returns null for events with no type so the
// caller drops them: an event nobody typed is not a phase, it is noise.
function eventPhase(event                         )                  {
  const type          = event["type"];
  if (typeof type !== "string" || type === "") return null;
  if (type === "tool.started") return "tool";
  if (type === "message.delta") return "writing";
  if (type === "run.queued") return "queued";
  if (type === "run.started" || type === "run.starting") return "starting";
  if (
    type === "run.completed" ||
    type === "run.done" ||
    type === "run.finished"
  )
    return "done";
  if (type === "run.failed" || type === "run.error") return "failed";
  if (type === "run.status") {
    const status          = event["status"];
    if (status === "queued") return "queued";
    if (status === "starting" || status === "running") return "starting";
    if (status === "thinking") return "thinking";
    if (status === "tool") return "tool";
    if (status === "writing") return "writing";
    if (status === "verifying") return "verifying";
    if (status === "settling") return "settling";
    if (status === "done" || status === "completed") return "done";
    if (status === "failed" || status === "error") return "failed";
    return "unknown";
  }
  return "unknown";
}

/**
 * Derive phases from event objects with a `type` field. Events without a
 * type are ignored, unrecognised types become `unknown` rather than a guess,
 * and an empty array yields zero steps rather than a fabricated one.
 */
function buildTimeline(events                    )                {
  const steps                 = [];
  const stamps                         = [];
  for (const event of events) {
    if (!isRecord$1(event)) continue;
    const phase                  = eventPhase(event);
    if (phase === null) continue;
    const step               = { phase };
    const detail                     = firstString(event, [
      "detail",
      "tool",
      "name",
    ]);
    // The tool name is the detail an operator asks for first on a tool step.
    const withDetail               =
      detail !== undefined ? { ...step, detail } : step;
    const tokens                     = firstNumber(event, ["tokens"]);
    const withCost               =
      tokens !== undefined ? { ...withDetail, tokens } : withDetail;
    steps.push(withCost);
    stamps.push(eventTimestamp(event));
  }
  // A duration needs both neighbours stamped. A missing end stamp leaves ms
  // undefined: zero would read as instant, and instant is a claim.
  const timed                 = steps.map(
    (step              , index        ) => {
      const start                     = stamps[index];
      const end                     = stamps[index + 1];
      if (start === undefined || end === undefined || end < start) return step;
      const duration         = end - start;
      if (!Number.isFinite(duration)) return step;
      return { ...step, ms: duration };
    },
  );
  return { steps: timed, current: timed.length === 0 ? 0 : timed.length - 1 };
}

function resolveMotion$2(motion                           )                {
  return motion ?? motionContext(0, false, true);
}

// Durations are words, never the bar alone: a fill with no number is
// unreadable on a monochrome terminal. Undefined is named, not blanked,
// because a missing measurement must not read as zero.
function formatDuration(ms                    )         {
  if (ms === undefined || !Number.isFinite(ms)) return "time unknown";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${Math.round(ms / 100) / 10}s`;
  const minutes         = Math.floor(ms / 60000);
  const seconds         = Math.round((ms - minutes * 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/**
 * Render the phase row plus one row per step, capped at height. The phase row
 * comes from stepper so the timeline animates in phase with the rest of the
 * frame. A zero step state still returns one row naming the state.
 */
function renderTimeline(
  state               ,
  width        ,
  height        ,
  options                  ,
)           {
  const cells         = Math.max(0, Math.floor(width));
  const rows         = Math.max(0, Math.floor(height));
  if (rows <= 0) return [];
  if (cells <= 0) return new Array        (rows).fill("");
  const motion                = resolveMotion$2(options?.motion);
  const paint                                                         =
    options?.paint ?? ((text        ) => text);
  if (state.steps.length === 0) {
    return [fit(sanitizeText("no steps"), cells)];
  }
  const current         = Math.max(
    0,
    Math.min(state.current, state.steps.length - 1),
  );
  const labels                    = state.steps.map((step              ) =>
    sanitizeText(phaseLabel(step.phase)),
  );
  const phaseRow         = fit(
    sanitizeText(stepper(labels, current, motion).join(" ")),
    cells,
  );
  let slowest = -1;
  let top = -1;
  for (let index = 0; index < state.steps.length; index += 1) {
    const ms                     = state.steps[index]?.ms;
    if (ms !== undefined && Number.isFinite(ms) && ms > top) {
      top = ms;
      slowest = index;
    }
  }
  const maxMs         = top > 0 ? top : 1;
  const out           = [phaseRow];
  for (let index = 0; index < state.steps.length; index += 1) {
    const step               = state.steps[index] ;
    // Sanitize before painting: sanitizeText replaces ESC, so running it
    // after paint would corrupt the caller's ANSI sequences.
    const glyph         = sanitizeText(phaseIcon(step.phase));
    const icon         = paint(glyph, phaseTone(step.phase), index === current);
    const duration         = sanitizeText(formatDuration(step.ms));
    const detail         =
      step.detail !== undefined && step.detail !== ""
        ? sanitizeText(step.detail)
        : "";
    const mark         = index === slowest && slowest >= 0 ? " slowest" : "";
    const head         = `${glyph} ${labels[index]} ${duration}`;
    const tail         = `${detail !== "" ? ` ${detail}` : ""}${mark}`;
    // The bar takes whatever the words leave. At a cramped width that can be
    // nothing, and the words still carry the measurement on their own.
    const barWidth         = Math.max(
      0,
      cells - visibleLength(head) - visibleLength(tail) - 1,
    );
    const bar         = animatedBar(step.ms ?? 0, maxMs, barWidth, motion, {
      paint: (text        , tone        , bold          ) =>
        paint(text, tone, bold),
    });
    out.push(
      fit(
        `${icon} ${labels[index]} ${duration}${bar !== "" ? ` ${bar}` : ""}${tail}`,
        cells,
      ),
    );
  }
  return out.slice(0, rows);
}


//# sourceURL=packages/cli/src/tui/run-timeline.ts

// An activity strip for a conversation: one small mark per event so the
// SHAPE of a wall of events is visible without reading it. A flat transcript
// shows what was said; this answers the glanceable questions instead: when
// did it start, what did it do, where did it stop, what came in last.

                                
                        
                      
                                      
                         
                                                                         
                          
 

                                
                                            
                            
                           
 

                                  
                                  
                                                                          
                                       
                                                                 
                           
 

// A silence longer than this draws a visible break in the strip. Five minutes
// is past normal turn latency, so it usually means the operator was away or
// something stalled, which is exactly the gap worth seeing on return.
const GAP_THRESHOLD_MS = 5 * 60 * 1000;

// Event roles share the block glyph catalog, while unknown/timestamp states
// retain their run-timeline marks. All role glyphs remain one terminal cell.
function markFor(kind        , timed         , symbols           )         {
  if (!timed) return "?";
  if (kind === "error") return symbols.role.error;
  if (kind === "unknown") return phaseIcon("unknown");
  if (kind === "user") return symbols.role.user;
  if (kind === "assistant") return symbols.role.assistant;
  if (kind === "tool") return symbols.role.tool;
  if (kind === "usage") return symbols.role.usage;
  return "?";
}

// A silence break inside the strip. Distinct from every event mark so a gap
// never reads as one more event of some kind.
const GAP_MARK = "|";

function isRecord(value         )                                   {
  return typeof value === "object" && value !== null;
}

function firstText(
  record                         ,
  keys                   ,
)                     {
  for (const key of keys) {
    const value          = record[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

// Canonical role from a free-form kind or type string. Anything unrecognised
// becomes "unknown" rather than a guess, and the raw word stays out of the
// kind so the strip marks stay a closed set the legend can name.
function canonicalKind(raw        )         {
  const word         = raw.trim().toLowerCase();
  if (word === "user" || word === "human" || word === "prompt") return "user";
  if (
    word === "assistant" ||
    word === "agent" ||
    word === "model" ||
    word === "ai" ||
    word === "message" ||
    word === "message.delta" ||
    word === "reply"
  )
    return "assistant";
  if (
    word === "tool" ||
    word === "tool.started" ||
    word === "tool.result" ||
    word === "function" ||
    word === "call"
  )
    return "tool";
  if (
    word === "error" ||
    word === "failed" ||
    word === "failure" ||
    word === "run.failed" ||
    word === "run.error"
  )
    return "error";
  if (
    word === "usage" ||
    word === "tokens" ||
    word === "token" ||
    word === "cost"
  )
    return "usage";
  return "unknown";
}

// A timestamp is valid only when it parses to a finite epoch. Numbers are
// accepted as epoch millis because some producers stamp numerically; the
// canonical stored form is always ISO so the summary prints one shape.
function parseAt(
  value         ,
)                                                       {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    const ms         = date.getTime();
    if (!Number.isFinite(ms)) return null;
    return { iso: date.toISOString(), ms };
  }
  if (typeof value === "string" && value !== "") {
    const ms         = Date.parse(value);
    if (!Number.isFinite(ms)) return null;
    return { iso: new Date(ms).toISOString(), ms };
  }
  return null;
}

/**
 * Normalise loose event objects into a strip. Nothing is dropped: events
 * with no timestamp, an invalid timestamp, or an unrecognised kind still
 * appear, marked "?" in the strip, because dropping them would hide events
 * from the shape the operator is trying to read.
 */
function buildActivity(
  events            
                   
                   
                 
                   
     ,
)                {
  const out                  = [];
  let previousMs                    ;
  let firstAt                    ;
  let lastAt                    ;
  for (const input of events) {
    const record                          = isRecord(input)
      ? (input                           )
      : {};
    const rawKind         =
      firstText(record, ["kind", "type", "role"]) ?? "unknown";
    const kind         = canonicalKind(rawKind);
    const stamp = parseAt(
      record["at"] ?? record["ts"] ?? record["timestamp"] ?? record["time"],
    );
    // gapMs needs both neighbours stamped. A missing stamp leaves it
    // undefined: zero would read as instant, and instant is a claim.
    const gapMs                     =
      stamp !== null && previousMs !== undefined
        ? stamp.ms - previousMs
        : undefined;
    if (stamp !== null) {
      if (firstAt === undefined) firstAt = stamp.iso;
      lastAt = stamp.iso;
      previousMs = stamp.ms;
    }
    const rawLabel          = record["text"] ?? record["label"];
    // First line only and capped: the label is a caption for the summary,
    // not a second copy of the transcript.
    const label         =
      typeof rawLabel === "string" && rawLabel.trim() !== ""
        ? rawLabel.split("\n")[0] .trim().slice(0, 160)
        : kind;
    const event                =
      gapMs === undefined
        ? { kind, at: stamp?.iso ?? "", label }
        : { kind, at: stamp?.iso ?? "", label, gapMs };
    out.push(event);
  }
  const strip                =
    firstAt === undefined
      ? { events: out }
      : lastAt !== undefined && lastAt !== firstAt
        ? { events: out, firstAt, lastAt }
        : { events: out, firstAt, lastAt: firstAt };
  return strip;
}

// One mark per event plus a break mark for each long silence, in order. Gap
// breaks are part of the shape: a flat run of marks hides the hour the
// operator was away, and that hour is often where something went wrong.
                        
                        
                                     
 

function stripMarks(strip               , symbols           )                 {
  const marks                 = [];
  strip.events.forEach((event, eventIndex) => {
    if (
      event.gapMs !== undefined &&
      Number.isFinite(event.gapMs) &&
      event.gapMs > GAP_THRESHOLD_MS
    ) {
      marks.push({ text: GAP_MARK, eventIndex: null });
    }
    marks.push({
      text: markFor(event.kind, event.at !== "", symbols),
      eventIndex,
    });
  });
  return marks;
}

function resolveMotion$1(motion                           )                {
  return motion ?? motionContext(0, false, true);
}

/**
 * One row of small marks, one per event, so a conversation's shape is
 * visible without reading it. Never empty: no events names the empty state.
 * Overflow keeps the newest marks, because the end is where the
 * conversation is now, and prefixes how many events folded away so nothing
 * is silently dropped.
 */
function activityStrip(
  strip               ,
  width        ,
  options    
                                    
                                         
   ,
)         {
  const cells         = Number.isFinite(width) ? Math.floor(width) : 0;
  const symbols = getSymbols(options?.symbolPreset ?? "ascii");
  const motion                = resolveMotion$1(options?.motion);
  if (strip.events.length === 0) {
    // The breath dot is decoration on a named state, so a frozen frame and
    // a monochrome terminal still read the words.
    const text         = sanitizeText(`no activity yet ${idleBreath(motion)}`);
    return cells <= 0 ? text : fit(text, cells);
  }
  // Degenerate widths cannot bound anything, so the newest mark at least
  // keeps the return non-empty rather than honest about width.
  if (cells <= 0) {
    const marks                          = stripMarks(strip, symbols);
    return sanitizeText(marks[marks.length - 1]?.text ?? "?");
  }
  const marks                 = stripMarks(strip, symbols);
  const row         = marks.map((mark) => mark.text).join("");
  if (visibleLength(row) <= cells) return fit(sanitizeText(row), cells);
  // Compression keeps the newest marks, because the end is where the
  // conversation is now, and counts the folded head. The count is events,
  // not marks, because gap breaks fold with their neighbours and the
  // operator thinks in events. The widest fitting tail wins; a width too
  // narrow for any prefix still names the total rather than going silent.
  const maxShown         = Math.min(marks.length - 1, cells);
  for (let shown = maxShown; shown >= 1; shown -= 1) {
    const tail                          = marks.slice(marks.length - shown);
    const visibleEvents              = new Set(
      tail.flatMap((mark) =>
        mark.eventIndex === null ? [] : [mark.eventIndex],
      ),
    );
    const folded         = strip.events.length - visibleEvents.size;
    const prefix         = `+${folded} `;
    if (visibleLength(prefix) + shown <= cells) {
      return fit(
        sanitizeText(`${prefix}${tail.map((mark) => mark.text).join("")}`),
        cells,
      );
    }
  }
  return fit(sanitizeText(`+${strip.events.length}`), cells);
}

function formatSpan(ms        )         {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const totalSeconds         = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes         = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    const seconds         = totalSeconds - totalMinutes * 60;
    return seconds === 0 ? `${totalMinutes}m` : `${totalMinutes}m ${seconds}s`;
  }
  const hours         = Math.floor(totalMinutes / 60);
  const minutes         = totalMinutes - hours * 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

// The last event in words. The word carries it, never the glyph alone, so a
// monochrome reader gets the same sentence.
function kindWords(kind        )         {
  if (kind === "user") return "a user message";
  if (kind === "assistant") return "an assistant reply";
  if (kind === "tool") return "a tool call";
  if (kind === "error") return "an error";
  if (kind === "usage") return "a usage report";
  return "an event of unknown kind";
}

/**
 * One sentence describing where the conversation is in time: both the span
 * and the recency, because an operator returning after an hour wants both.
 * Without `now` there is no honest age, so the sentence states the span and
 * the last kind instead of inventing one. Stamps after `now` are reported
 * as future time, never as a negative age.
 */
function activitySummary(strip               , now         )         {
  const count         = strip.events.length;
  if (count === 0) return sanitizeText("no activity yet");
  const noun         = count === 1 ? "1 event" : `${count} events`;
  const last                = strip.events[strip.events.length - 1] ;
  const lastWords         = kindWords(last.kind);
  const firstMs         =
    strip.firstAt !== undefined ? Date.parse(strip.firstAt) : NaN;
  const lastMs         =
    strip.lastAt !== undefined ? Date.parse(strip.lastAt) : NaN;
  const timed          = Number.isFinite(firstMs) && Number.isFinite(lastMs);
  const span         = timed
    ? formatSpan(Math.max(0, (lastMs          ) - (firstMs          )))
    : "?";
  {
    return sanitizeText(
      timed
        ? `${noun} over ${span}, last ${lastWords}`
        : `${noun}, last ${lastWords}`,
    );
  }
}

// The legend pairs every mark with its word, so the strip stays legible
// without colour and without memorising glyphs.
function legendRow(symbols           )         {
  return sanitizeText(
    `${symbols.role.user} user ${symbols.role.assistant} assistant ${symbols.role.tool} tool ${symbols.role.error} error ${symbols.role.usage} usage ? unknown/time | gap 5m+`,
  );
}

/**
 * The strip plus its pacing and its sentence: a sparkline of the gaps
 * between timed events, then the summary, then the legend. Always at least
 * one row; capped at `height` when given, newest-first importance would put
 * the strip first so the cap keeps the shape over the explanation.
 */
function renderActivity(
  strip               ,
  width        ,
  options                  ,
)           {
  const cells         = Number.isFinite(width) ? Math.floor(width) : 0;
  const height         =
    options?.height !== undefined && Number.isFinite(options.height)
      ? Math.floor(options.height)
      : 0;
  const motion                = resolveMotion$1(options?.motion);
  // Sanitize before painting: sanitizeText replaces ESC, so running it after
  // paint would corrupt the caller's ANSI sequences.
  const paint                                                         =
    options?.paint ?? ((text        ) => text);
  const rows           = [];
  const stripRow         = activityStrip(strip, Math.max(cells, 1), {
    motion,
    symbolPreset: options?.symbolPreset,
  });
  rows.push(
    cells <= 0
      ? stripRow
      : fit(paint(sanitizeText(stripRow), "accent", true), cells),
  );
  const gaps           = [];
  for (const event of strip.events) {
    if (event.gapMs !== undefined && Number.isFinite(event.gapMs)) {
      gaps.push(Math.max(0, event.gapMs) / 1000);
    }
  }
  if (gaps.length > 0 && (height <= 0 || rows.length < height)) {
    const label         = sanitizeText("pace ");
    const chart         = sparkline(
      { values: gaps },
      Math.max(0, cells - visibleLength(label)),
      {
        motion,
      },
    );
    rows.push(
      cells <= 0
        ? `${label}${chart}`
        : fit(paint(sanitizeText(`${label}${chart}`), "muted"), cells),
    );
  }
  if (height <= 0 || rows.length < height) {
    const summary         = sanitizeText(activitySummary(strip));
    rows.push(cells <= 0 ? summary : fit(paint(summary, "muted"), cells));
  }
  if (height <= 0 || rows.length < height) {
    const symbols = getSymbols(options?.symbolPreset ?? "ascii");
    rows.push(cells <= 0 ? legendRow(symbols) : fit(legendRow(symbols), cells));
  }
  if (rows.length === 0)
    return [cells <= 0 ? "?" : fit(sanitizeText("?"), cells)];
  return height > 0 ? rows.slice(0, height) : rows;
}


//# sourceURL=packages/cli/src/tui/activity.ts

// The keys below are restated here rather than derived from
// shortcutHintsFor in shortcuts.ts. The legend groups hints by presentation
// category (nav, edit, action, mode, panel, approval) while this sheet groups
// by situation (always, editing, running, review), so deriving one from the
// other would silently misfile keys every time the legend gains a hint.
const ALWAYS_BINDINGS                     = [
  {
    keys: "Tab",
    action: "complete Chat suggestions, focus composer, or return from a panel",
    when: "always",
  },
  { keys: "Shift+Tab", action: "cycle local mode", when: "always" },
  {
    keys: "Enter",
    action: "inspect selected row; tree groups and folders toggle",
    when: "always",
  },
  { keys: "u", action: "undo last change", when: "always" },
  {
    keys: "Alt+M",
    action: "open the connected-provider model picker",
    when: "always",
  },
  {
    keys: "Alt+P",
    action: "choose a model for the current conversation",
    when: "always",
  },
  { keys: "Alt+A", action: "open the Agents panel", when: "always" },
  { keys: "Alt+L", action: "redraw the current terminal view", when: "always" },
  { keys: "?", action: "this cheat sheet", when: "always" },
];

const EDITING_BINDINGS                     = [
  {
    keys: "Shift+Enter",
    action: "insert newline",
    when: "editing",
    also: ["Ctrl+J"],
  },
  { keys: "Ctrl+R", action: "search composer", when: "editing" },
  { keys: "Ctrl+T", action: "transpose adjacent characters", when: "editing" },
  {
    keys: "Ctrl+] / Ctrl+Alt+], then a character",
    action: "jump to the next or previous match",
    when: "editing",
  },
  {
    keys: "Alt+D / Alt+Delete",
    action: "delete the next word",
    when: "editing",
  },
  {
    keys: "Alt+Backspace / Ctrl+Backspace / Ctrl+W",
    action: "delete the previous word",
    when: "editing",
  },
  { keys: "Ctrl+K", action: "delete to end of prompt", when: "editing" },
  { keys: "Ctrl+U", action: "delete to start of prompt", when: "editing" },
  { keys: "Ctrl+P", action: "command palette", when: "editing" },
  { keys: "Alt+Shift+C", action: "copy the Chat prompt", when: "editing" },
  { keys: "Alt+Shift+P", action: "toggle local plan mode", when: "editing" },
  { keys: "/", action: "command menu", when: "editing" },
];

const RUNNING_BINDINGS                     = [
  { keys: "/queue", action: "queue next prompt", when: "running" },
];

const REVIEW_BINDINGS                     = [
  { keys: "y", action: "accept hunk", when: "review" },
  { keys: "n", action: "reject hunk", when: "review" },
  { keys: "a", action: "approve call", when: "review" },
  { keys: "d", action: "deny call", when: "review" },
  { keys: "PgUp/PgDn", action: "scroll diff", when: "review" },
  { keys: "1-9", action: "toggle hunks", when: "review" },
];

// One Esc key with one current meaning. The legend resolves Esc the same way
// (review, then run, then back), so the sheet agrees with the bar at the
// bottom of the frame instead of listing the same key twice with conflicting
// actions.
function escBindingFor(context   
                            
                            
                              
                              
 )          {
  if (context.reviewing)
    return { keys: "Esc", action: "cancel review", when: "review" };
  if (context.backable)
    return {
      keys: "Esc",
      action: "close the current overlay, detail or filter",
      when: "always",
    };
  if (context.running)
    return { keys: "Esc", action: "stop run", when: "running" };
  return { keys: "Esc", action: "back", when: "always" };
}

function bindingsFor(context   
                            
                            
                                      
                            
                               
                              
                              
                        
 )            {
  const enterAction =
    context.editing && context.tab === "chat"
      ? "send the Chat prompt; modified Enter inserts a newline"
      : context.editing
        ? "run the typed command or prompt"
        : context.tab === "sessions"
          ? "open selected conversation in Chat; tree groups toggle"
          : context.tab === "documents"
            ? "preview selected document; folders toggle"
            : context.tab === "models"
              ? "set selected model for new conversations"
              : context.tab === "approvals"
                ? "inspect the selected approval before deciding"
                : "inspect selected row; tree groups toggle";
  const always = ALWAYS_BINDINGS.map((binding) =>
    binding.keys === "Enter" ? { ...binding, action: enterAction } : binding,
  );
  const out            = [...always, escBindingFor(context)];
  out.push({
    keys: "Ctrl+O",
    action:
      "cycle compact, details and expanded agent activity only during a run; never resizes the composer",
    when: "running",
  });
  if (context.suspendSupported !== false)
    out.push({
      keys: "Ctrl+Z",
      action: "suspend NOMO to the shell; resume with fg",
      when: "always",
    });
  if (context.tab !== undefined && context.tab !== "chat" && !context.editing)
    out.push(
      {
        keys: "Ctrl+P",
        action: "move selection up",
        when: "always",
      },
      {
        keys: "Ctrl+N",
        action: "move selection down",
        when: "always",
      },
    );
  if (!context.editing)
    out.push({
      keys: "Ctrl+T",
      action: "show todos from the selected conversation",
      when: "always",
    });
  if (context.editing) out.push(...EDITING_BINDINGS);
  if (context.running) out.push(...RUNNING_BINDINGS);
  if (context.running && context.editing && context.tab === "chat")
    out.push({
      keys: "Ctrl+Q / Ctrl+Enter",
      action: "queue the Chat draft behind the active turn",
      when: "running",
    });
  if (context.queued)
    out.push({
      keys: "Alt+Up / Shift+Up",
      action: "restore the queued prompt to Chat and keep the current draft",
      when: "running",
    });
  if (context.retryable)
    out.push({
      keys: "F5 / Alt+R",
      action: "retry the failed prompt in a new branch after confirmation",
      when: "always",
    });
  if (context.reviewing) out.push(...REVIEW_BINDINGS);
  return out;
}

function filterBindings(
  bindings                    ,
  query        ,
)            {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...bindings];
  // Keys, actions and alternatives share one haystack so an operator who
  // remembers any of them finds the row. Lowercase both sides for case
  // insensitive matching; an empty result is honest and the caller says so.
  return bindings.filter((binding) =>
    [binding.keys, binding.action, ...(binding.also ?? [])]
      .join(" ")
      .toLowerCase()
      .includes(needle),
  );
}

const GROUP_ORDER                             = [
  "always",
  "editing",
  "running",
  "review",
];

const GROUP_TITLES                                  = {
  always: "Always",
  editing: "Editing",
  running: "Running",
  review: "Review",
};

// Alternatives sit beside the primary key in parentheses so the row is found
// by either name without ever hiding the canonical key.
function bindingField(binding         )        {
  const keys =
    binding.also === undefined || binding.also.length === 0
      ? binding.keys
      : `${binding.keys} (${binding.also.join(", ")})`;
  return { label: keys, value: binding.action };
}

/** One line: how many bindings are shown out of how many exist. */
function cheatSheetCount(
  bindings                    ,
  shown        ,
)         {
  const total = bindings.length;
  const safeShown = Math.max(0, Math.floor(shown));
  return `${safeShown} of ${total} bindings`;
}

function renderCheatSheet(
  state                                                                   ,
  options                   ,
)           {
  const width = Number.isFinite(options.width)
    ? Math.max(1, Math.floor(options.width))
    : 1;
  // Frozen first frame unless the caller passes motion: two renders of the
  // same state stay byte identical and tests can assert on the output.
  const motion                = options.motion ?? motionContext(0, false, true);
  const outerPaint = options.paint;
  const paint =
    outerPaint === undefined
      ? undefined
      : (text        , tone           , bold          )         =>
          outerPaint(text, tone, bold);
  // Sanitize before echo: the query is typed by the operator and could carry
  // control characters that would otherwise reach the terminal raw. The
  // inspector sanitizes again on render, which is harmless.
  const cleanQuery = sanitizeText(state.query.trim());
  const sections            = [];
  if (state.bindings.length === 0) {
    // Never a blank sheet: an empty render reads as a failure, so the sheet
    // says in words that there is nothing to show and why.
    sections.push({
      title: "Results",
      fields: [],
      body: [
        cleanQuery === ""
          ? "No bindings to show."
          : `No bindings match "${cleanQuery}".`,
      ],
    });
  } else {
    // Groups in fixed order so the keys that matter right now come first
    // and the sheet has the same shape in every context.
    for (const when of GROUP_ORDER) {
      const group = state.bindings.filter((binding) => binding.when === when);
      if (group.length === 0) continue;
      sections.push({
        title: GROUP_TITLES[when],
        fields: group.map(bindingField),
      });
    }
  }
  const count = cheatSheetCount(state.bindings, state.bindings.length);
  const spec                = {
    title: "Cheat sheet",
    subtitle: cleanQuery === "" ? count : `Filter "${cleanQuery}" .. ${count}`,
    icon: "?",
    sections,
    // The breathing dot is decoration only: the words beside it carry the
    // guidance, so the hint survives a monochrome terminal.
    hint: `Type to filter. Esc closes. ${idleBreath(motion)}`,
  };
  // The inspector owns width fitting and height clipping, so this render
  // inherits its guarantees: every row fits and the result is at least one
  // row and at most height when height is given.
  return renderInspector(spec, {
    width,
    height: options.height,
    motion,
    paint,
  });
}


//# sourceURL=packages/cli/src/tui/cheatsheet.ts

// A collapsible tree for grouped rows. NOMO's item lists were flat strings,
// so forty documents meant forty rows to scroll past with no way to fold away
// the folders that did not matter. This owns the fold state and the window,
// and nothing else: no screen state, no raw mode, so it stays safe to unit
// test and to render inside any surface.
//
// Motion follows the motion.ts discipline: every animated choice is a pure
// function of the frame counter, and every marker already reads as text with
// motion off. A filterable list lived here too and was removed: items() in
// workspace.ts already filters, and a second filter on top of it would have
// narrowed the rows twice.

                           
                      
                         
                         
                                
                              
                                          
 

                            
                                    
                                         
                                               
                          
 

                                
                                  
                                                                          
                                       
 

// Base frame used when the caller passes no motion: the static marker, so a
// snapshot test and a motion-frozen terminal agree byte for byte.
const BASE_MOTION                = { frame: 0, enabled: false, reduced: true };

function resolveMotion(options                           )                {
  return options?.motion ?? BASE_MOTION;
}

function resolvePaint(
  options                           ,
)                                                         {
  return options?.paint ?? ((text        )         => text);
}

// Depth-first walk that emits only nodes whose ancestors are all expanded.
// Collapsed children are absent from the output rather than flagged hidden,
// so a caller can trust the list is complete and index into it directly.
function flattenTree(
  nodes                     ,
  state           ,
)             {
  const out             = [];
  const visit = (list                     )       => {
    for (const node of list) {
      out.push(node);
      if (
        node.children !== undefined &&
        node.children.length > 0 &&
        state.expanded.has(node.id)
      ) {
        visit(node.children);
      }
    }
  };
  visit(nodes);
  return out;
}

function findTreeNode(
  nodes                     ,
  id        ,
)                       {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.children !== undefined) {
      const found = findTreeNode(node.children, id);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

// A leaf carries no expandable entry: toggling it returns the state
// unchanged so a keystroke on a leaf never grows the expanded set forever.
// An unknown id is also a no-op rather than an invented entry.
function toggleTreeNode(
  state           ,
  id        ,
  nodes                     ,
)            {
  const node = findTreeNode(nodes, id);
  if (node === undefined) return state;
  const expandable =
    node.hasChildren ||
    (node.children !== undefined && node.children.length > 0);
  if (!expandable) return state;
  const expanded = new Set(state.expanded);
  if (expanded.has(id)) expanded.delete(id);
  else expanded.add(id);
  const next            = { expanded, cursor: state.cursor };
  const flat = flattenTree(nodes, next);
  if (flat.length === 0) return { expanded, cursor: 0 };
  return {
    expanded,
    cursor: Math.max(0, Math.min(next.cursor, flat.length - 1)),
  };
}

// Wrap-around movement against the live flattened length, which changes as
// nodes expand and collapse, so moving after a collapse never lands the
// cursor past the end of the visible list.
function moveTree(
  state           ,
  delta        ,
  nodes                     ,
)            {
  const flat = flattenTree(nodes, state);
  if (flat.length === 0) return { expanded: state.expanded, cursor: 0 };
  const next =
    (((state.cursor + delta) % flat.length) + flat.length) % flat.length;
  return { expanded: state.expanded, cursor: next };
}

// Expand markers are bracketed text ([-], [+]) rather than a bare glyph, so
// expanded, collapsed, and leaf rows stay distinguishable on a monochrome
// terminal and under a screen reader. ASCII keeps every marker one cell.
function treeExpandMarker(node          , expanded         )         {
  const expandable =
    node.hasChildren ||
    (node.children !== undefined && node.children.length > 0);
  if (!expandable) return "   ";
  return expanded ? "[-]" : "[+]";
}

function renderTree(
  nodes                     ,
  state           ,
  width        ,
  height        ,
  options                ,
)           {
  resolveMotion(options);
  const paint = resolvePaint(options);
  const symbols = getSymbols(options?.symbolPreset ?? "ascii");
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const flat = flattenTree(nodes, state);
  if (flat.length === 0) return [pad("No nodes.", safeWidth)];
  const cursor = Math.max(0, Math.min(state.cursor, flat.length - 1));
  // Minimum scroll: the window starts at zero until the cursor runs past the
  // bottom, then follows by exactly the overflow, so the cursor row is always
  // visible and steady rows never jump.
  const start =
    cursor < safeHeight
      ? 0
      : Math.min(cursor - safeHeight + 1, flat.length - 1);
  const rows           = [];
  const end = Math.min(flat.length, start + safeHeight);
  for (let index = start; index < end; index += 1) {
    const node = flat[index] ;
    const selected = index === cursor;
    const marker = cursorMarker(selected);
    const expand = treeExpandMarker(node, state.expanded.has(node.id));
    // One guide segment per depth level, drawn as text so nesting survives
    // without colour. Depth is clamped at zero against malformed input.
    const guide = `${symbols.frame.v} `.repeat(Math.max(0, node.depth));
    const label = sanitizeText(node.label);
    const row = pad(`${marker}${expand} ${guide}${label}`, safeWidth);
    rows.push(selected ? paint(row, "accent", true) : row);
  }
  return rows;
}


//# sourceURL=packages/cli/src/tui/widgets.ts

// Grouping layer for the documents and sessions tabs: flat entry lists become
// collapsible trees through widgets.ts, so an operator with dozens of rows can
// hide the folders they do not care about. This module builds trees only and
// owns no screen state, which keeps it unit testable and safe to call from any
// surface. It must not import workspace.ts: the workspace imports this module,
// so that direction would be an import cycle.

/** A session or document as the tree builder sees it. */
                            
                      
                                                 
                        
                                          
                           
                                               
                         
                                                                            
                                 
                              
 

                               
                                                                           
                                       
 

// Single cell icons mirroring the workspace row glyphs. workspace.ts owns the
// canonical set but cannot be imported here (cycle), so these are local copies
// restricted to glyphs layout.ts counts as one cell. Icons are decoration
// only: the trailing slash on folders is the signal that survives monochrome.
const FOLDER_ICON = "+";
const FILE_ICON = "▤";
const ICON_RUNNING = "◉";
const ICON_SETTLED = "●";
const ICON_FAILED = "×";
const ICON_QUEUED = "◔";
const ICON_ARCHIVED = "□";
const ICON_UNKNOWN = "?";

// Same keyword mapping as the workspace state icon, duplicated here to avoid
// the import cycle. An unrecognised state gets the question mark rather than
// a guessed dot, so the terminal never states a fact it was not told.
function kindIcon(kind                    )         {
  const key = (kind ?? "").toLowerCase();
  if (key.includes("run") || key.includes("active")) return ICON_RUNNING;
  if (key.includes("fail") || key.includes("error")) return ICON_FAILED;
  if (key.includes("queue") || key.includes("pending")) return ICON_QUEUED;
  if (key.includes("archiv")) return ICON_ARCHIVED;
  if (key.includes("settl") || key.includes("done") || key.includes("complet"))
    return ICON_SETTLED;
  return ICON_UNKNOWN;
}

                    
                      
                                    
                            
                                      
                                            
                                         
 

                       
                      
                         
                                            
                                         
 

                         
                      
                        
                         
                        
                                                
                                 
 

// Code unit order, not locale order: localeCompare varies by machine, which
// would break the cross-frame determinism callers rely on.
function compareStrings(a        , b        )         {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function plural(count        , one        , many        )         {
  return count === 1 ? one : many;
}

function isExpandable(node          )          {
  return (
    node.hasChildren ||
    (node.children !== undefined && node.children.length > 0)
  );
}

// A path with no segments ("" or "///") still names one row from the entry id,
// so no input silently vanishes from the tree.
function splitPath(path        , fallback        )           {
  const parts = path.split("/").filter((part) => part !== "");
  if (parts.length === 0) return [fallback === "" ? "unnamed" : fallback];
  return parts;
}

// " -- " matches the renderList hint separator, so tree leaves and flat list
// rows read the same way when motion and colour are off.
function leafLabel(
  icon        ,
  base        ,
  detail                    ,
)         {
  const text =
    detail === undefined || detail === "" ? base : `${base} -- ${detail}`;
  return `${icon} ${text}`;
}

function makeFolder(
  id        ,
  name        ,
  depth        ,
  icon        ,
)                {
  return { id, name, depth, icon, children: new Map(), leaves: [] };
}

// Folders sort by path. Leaves use a caller's recency key when supplied;
// other trees retain stable id order.
function freezeChildren(folder               )             {
  const folders = [...folder.children.values()].sort((a, b) =>
    compareStrings(a.id, b.id),
  );
  const leaves = [...folder.leaves].sort((a, b) => {
    const aPriority = Number.isFinite(a.sortPriority)
      ? a.sortPriority
      : undefined;
    const bPriority = Number.isFinite(b.sortPriority)
      ? b.sortPriority
      : undefined;
    if (aPriority !== undefined || bPriority !== undefined) {
      if (aPriority === undefined) return 1;
      if (bPriority === undefined) return -1;
      if (aPriority !== bPriority) return bPriority - aPriority;
    }
    const aOrder = Number.isFinite(a.sortOrder) ? a.sortOrder : undefined;
    const bOrder = Number.isFinite(b.sortOrder) ? b.sortOrder : undefined;
    if (aOrder !== undefined || bOrder !== undefined) {
      if (aOrder === undefined) return 1;
      if (bOrder === undefined) return -1;
      if (aOrder !== bOrder) return bOrder - aOrder;
    }
    return compareStrings(a.id, b.id);
  });
  const out             = [];
  for (const child of folders) {
    const children = freezeChildren(child);
    out.push({
      id: child.id,
      // Trailing slash is the monochrome folder signal: it survives a
      // terminal with no colour and no glyph support.
      label: `${child.icon} ${child.name}/`,
      depth: child.depth,
      hasChildren: true,
      children,
    });
  }
  for (const leaf of leaves) {
    out.push({
      id: leaf.id,
      label: leaf.label,
      depth: folder.depth + 1,
      hasChildren: false,
    });
  }
  return out;
}

// Shared path-grouping core. idPrefix scopes every descendant id under one
// root ("" for documents, "status/" for sessions) so two entries with the
// same path in different scopes never share a node id and select together.
function buildPathNodes(
  rows                     ,
  parentDepth        ,
  idPrefix        ,
)             {
  const fullId = (parts                   )         =>
    idPrefix + parts.join("/");
  // Documents from separate sessions can share a visible path where one is a
  // file and another is a folder, so derived folders may coexist with
  // session-scoped source leaves.
  // Fewest segments first creates parent folders before descendants; sorting
  // by path makes the tree stable regardless of input order.
  const ordered = [...rows].sort((a, b) => {
    if (a.parts.length !== b.parts.length)
      return a.parts.length - b.parts.length;
    return compareStrings(fullId(a.parts), fullId(b.parts));
  });
  const root                = makeFolder(
    idPrefix,
    "",
    parentDepth,
    FOLDER_ICON,
  );
  const byId = new Map                       ([[idPrefix, root]]);
  const seen = new Set        ();
  for (const row of ordered) {
    fullId(row.parts);
    // Duplicate source ids collapse, but identical paths from different
    // conversations remain separate selectable rows.
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    for (let level = 1; level < row.parts.length; level += 1) {
      const folderId = fullId(row.parts.slice(0, level));
      if (!byId.has(folderId)) {
        const parent = byId.get(fullId(row.parts.slice(0, level - 1))) ;
        const folder = makeFolder(
          folderId,
          row.parts[level - 1] ,
          parentDepth + level,
          FOLDER_ICON,
        );
        parent.children.set(folderId, folder);
        byId.set(folderId, folder);
      }
    }
    const parent = byId.get(fullId(row.parts.slice(0, row.parts.length - 1))) ;
    const base = row.parts[row.parts.length - 1] ;
    parent.leaves.push({
      id: row.id,
      label: leafLabel(row.leafIcon, base, row.detail),
      sortPriority: row.sortPriority,
      sortOrder: row.sortOrder,
    });
  }
  return freezeChildren(root);
}

function buildDocumentTree(
  entries                      ,
  options               ,
)             {
  if (entries.length === 0) return [];
  const rows             = entries.map((entry) => ({
    id: entry.id,
    parts: splitPath(entry.path, entry.id),
    leafIcon: FILE_ICON,
    detail: entry.detail,
    sortPriority: undefined,
    sortOrder: undefined,
  }));
  return buildPathNodes(rows, -1, "");
}

function buildSessionTree(
  entries                      ,
  options               ,
)             {
  if (entries.length === 0) return [];
  // Sessions carry no folder structure worth inventing, so status is the
  // useful cut. A blank kind joins "other" rather than forming an empty group.
  const groups = new Map                    ();
  for (const entry of entries) {
    const raw = (entry.kind ?? "").trim();
    const key = raw === "" ? "other" : raw;
    const row           = {
      id: entry.id,
      // A conversation title is a label, not a directory path. Keep slashes
      // inside the title instead of inventing nested session folders.
      parts: [entry.path || entry.id],
      leafIcon: kindIcon(entry.kind),
      detail: entry.detail,
      sortPriority: entry.sortPriority,
      sortOrder: entry.sortOrder,
    };
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [row]);
    else list.push(row);
  }
  const groupOrder = [
    "running",
    "queued",
    "failed",
    "settled",
    "archived",
    "other",
  ];
  const keys = [...groups.keys()].sort((a, b) => {
    const aIndex = groupOrder.indexOf(a);
    const bIndex = groupOrder.indexOf(b);
    if (aIndex >= 0 || bIndex >= 0) {
      if (aIndex < 0) return 1;
      if (bIndex < 0) return -1;
      if (aIndex !== bIndex) return aIndex - bIndex;
    }
    return compareStrings(a, b);
  });
  const out             = [];
  for (const key of keys) {
    const children = buildPathNodes(groups.get(key) , 0, `${key}/`);
    out.push({
      id: key,
      label: `${kindIcon(key)} ${key}/`,
      depth: 0,
      hasChildren: true,
      children,
    });
  }
  return out;
}

function initialTreeState(
  nodes                     ,
  options               ,
)            {
  const threshold = 1;
  const expanded = new Set        ();
  const visit = (list                     )       => {
    for (const node of list) {
      if (isExpandable(node) && node.depth < threshold) expanded.add(node.id);
      if (node.children !== undefined) visit(node.children);
    }
  };
  visit(nodes);
  return { expanded, cursor: 0 };
}

/**
 * One line: how many groups are collapsed and how many rows are hidden.
 *
 * The nouns come from the caller. A summary saying "3 documents hidden"
 * above a list of conversations is wrong in a way an operator has to stop
 * and parse, which is the whole cost this line is supposed to avoid.
 */
function collapsedSummary(
  state           ,
  nodes                     ,
  nouns                                                   = {
    group: "folder",
    row: "document",
  },
)         {
  let collapsedGroups = 0;
  let totalLeaves = 0;
  const visit = (list                     )       => {
    for (const node of list) {
      if (isExpandable(node)) {
        if (!state.expanded.has(node.id)) collapsedGroups += 1;
      } else {
        totalLeaves += 1;
      }
      if (node.children !== undefined) visit(node.children);
    }
  };
  visit(nodes);
  // flattenTree lists only rows visible under the current expansion, so hidden
  // leaves are the total minus the visible with no extra bookkeeping.
  let visibleLeaves = 0;
  for (const node of flattenTree(nodes, state)) {
    if (!isExpandable(node)) visibleLeaves += 1;
  }
  const hidden = totalLeaves - visibleLeaves;
  // Zero counts keep the same sentence shape: an empty string would render as
  // a broken blank row, and the steady form compares cleanly across frames.
  return (
    `${collapsedGroups} ${plural(collapsedGroups, nouns.group, `${nouns.group}s`)} collapsed, ` +
    `${hidden} ${plural(hidden, nouns.row, `${nouns.row}s`)} hidden`
  );
}


//# sourceURL=packages/cli/src/tui/session-tree.ts

const WORKSPACE_TABS = [
  "chat",
  "sessions",
  "runs",
  "documents",
  "ledger",
  "approvals",
  "policy",
  "tools",
  "mcp",
  "status",
  "models",
  "usage",
  "help",
]         ;
function workspaceTab(value        )                           {
  return WORKSPACE_TABS.includes(value                )
    ? (value                )
    : undefined;
}
                                   
                      
                        
                             
                                                           
                                           
                                   
  
                                
                      
                                        
                                            
                                                     
                         
                          
                            
                                 
                               
                                               
                                                                       
                                                                                      
                                        
                                     
                                          
  
                    
                      
                        
                                  
                               
                                
                                            
                              
  
const modelPickerMatchCache = new WeakMap 
         
                                                                      
 ();
function modelPickerMatches(
  models                        ,
  query        ,
)                         {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return models;
  const cached = modelPickerMatchCache.get(models);
  if (cached?.query === normalizedQuery) return cached.matches;
  const matches = models
    .map((model, index) => ({
      model,
      index,
      score: fuzzyTextScore(normalizedQuery, [model.name, model.id]),
    }))
    .filter(
      (entry)                                            =>
        entry.score !== undefined,
    )
    .sort((left, right) =>
      right.score !== left.score
        ? right.score - left.score
        : left.index - right.index,
    )
    .map(({ model }) => model);
  modelPickerMatchCache.set(models, { query: normalizedQuery, matches });
  return matches;
}
             
             
                
                  
                     
                
                       
                  
     
                                                                         
                                                                             
                                                                   
                                                                   
     
        
             
             
               
             
               
            
             
                     
                                                                             
                                                                               
          
                   
                      
                                                                 
    
     
                                                                             
                                                                              
                                     
     
               
               
                  
                             
                         
    
     
                                                                              
                                                                                
    
                                                                              
                                                                             
                                                      
     
           
               
                  
                      
                
                      
                          
                          
                           
                    
    
                                              
                
  
                     
                
                  
                                                                          
                                                                             
                                                      
                      
                             
  
const json = (value         ) =>
  JSON.stringify(value, null, 2)?.split("\n") ?? [];
/**
 * A token count as a number, or the word unknown.
 *
 * The activity layer types token counts as unknown because a run that never
 * reported them has none, and absent is not zero. Rendering the absence as 0
 * would make a conversation that spent nothing look identical to one whose
 * costs were never recorded.
 */
function numberOr(value         , absent        )         {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString("en-US")
    : absent;
}
/** Median of a non-empty numeric list. The mean of a run that includes one
 * outlier hides the outlier, and the median is what an operator comparing
 * typical runs actually wants to see. */
function median(values                   )         {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[middle] 
    : Math.round((sorted[middle - 1]  + sorted[middle] ) / 2);
}
const text = (value         ) => String(value ?? "unknown");
/** Operator-authored and model-authored text reaches the ledger tab through
 * proposal rows. A control character in it would move the cursor and rewrite
 * rows the operator is reading, so it is escaped before paint, not after. */
const escapeTerminalText = (value        ) =>
  value.replace(
    /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/gu,
    (character) =>
      `\\u${character.codePointAt(0) .toString(16).padStart(4, "0")}`,
  );
/** A workspace chain is one score case, even when several sessions display it. */
const verifiedScoreCases = (
  proofs                                            ,
)                 => {
  const cases = new Map                      ();
  for (const [sessionId, entries] of proofs) {
    const workspace = entries[0]?.workspace ?? sessionId;
    if (!cases.has(workspace)) cases.set(workspace, [...entries]);
  }
  return [...cases.values()];
};
/** Hook commands are operator-supplied config, but they routinely carry
 * credentials inline (curl -H "Authorization: ...", --token=...). The
 * ledger tab prints them, so redact before bounding and rendering, the
 * same bound agentsLines applies to a system prompt. */
const redactSecrets = (value        )         =>
  value
    .replace(/-H\s+"Authorization:[^"]*"/gi, "[redacted]")
    .replace(/Authorization:\s*\S+/gi, "[redacted]")
    .replace(/Bearer\s+\S+/g, "[redacted]")
    .replace(/\b(?:token|key|password)=\S+/gi, "[redacted]");
const boundedHookCommand = (command        )         => {
  const clean = redactSecrets(command.trim());
  if (!clean) return "(empty)";
  return clean.length > 160
    ? `${clean.slice(0, 160)}… (+${clean.length - 160} chars)`
    : clean;
};
/** The one next step per consent state. A staged connector has no catalog, a
 * probed one has tools nobody agreed to, and a confirmed one is in use. */
const MCP_NEXT = {
  staged: (id        ) => `/mcp probe ${id}`,
  probed: (id        ) => `/mcp confirm ${id}`,
  confirmed: () => "in use by new conversations",
}         ;
const MCP_COMMANDS                    = [
  "inspect",
  "add",
  "probe",
  "confirm",
  "rename",
  "remove",
];
/** A policy is YAML in the record, so the view counts its rules instead of
 * printing it: the line keeps the 80 column budget and stays comparable
 * between connectors. */
function policySummary(value                    ) {
  if (!value) return "default";
  const loaded = loadPolicy(value);
  if (!loaded.ok) return "unreadable policy";
  return (
    `${loaded.policy.rules.length} rules, ` +
    loaded.policy.rules
      .map((rule) => {
        const scope = String(rule.match.class ?? "any");
        return rule.decision === "hold"
          ? `${scope} hold ${rule.seconds ?? 0}s`
          : `${scope} ${rule.decision}`;
      })
      .join(", ")
  );
}
function modelPickerWindowStart(
  selected        ,
  count        ,
  visibleRows        ,
  requestedStart         ,
)         {
  const capacity = Math.max(1, visibleRows);
  const start = requestedStart ?? selected - Math.floor(capacity / 2);
  return Math.max(0, Math.min(Math.max(0, count - capacity), start));
}

function modelPickerSelectionWindowStart(
  previousSelected        ,
  selected        ,
  count        ,
  visibleRows        ,
  requestedStart         ,
)         {
  const capacity = Math.max(1, visibleRows);
  const start = modelPickerWindowStart(
    previousSelected,
    count,
    capacity,
    requestedStart,
  );
  const nextStart =
    selected < start
      ? selected
      : selected >= start + capacity
        ? selected - capacity + 1
        : start;
  return modelPickerWindowStart(selected, count, capacity, nextStart);
}

/** One row of the /mcp view. The builtin document workspace has no endpoint,
 * so the view flattens both record shapes into this before rendering. */
                     
             
               
                   
                                             
                  
                   
                  
                                           
                                   
  

                                                   
                                                                 
                                             
const DEFAULT_CHAT_COMPOSER_HEIGHT_PX = 123;
const MIN_CHAT_COMPOSER_HEIGHT_PX = 72;
const MAX_CHAT_COMPOSER_HEIGHT_PX = 320;
                         
                        
                       
                      
                           
  
                                
                         
                             
                            
                           
                          
                               
                       
                          
                   
  
                        
              
                                                                           
                
               
                
                      
                              
                  
               
               
                 
                     
  

function settingsCursorWindow(value        , cursor        , width        ) {
  if (width <= 1) return "▏";
  const points = [...value];
  const focus = Math.max(0, Math.min(points.length, cursor));
  const budget = width - 1;
  let start = focus;
  let end = focus;
  let used = 0;
  while (start > 0 && used + visibleLength(points[start - 1] ) <= budget) {
    used += visibleLength(points[--start] );
  }
  while (end < points.length && used + visibleLength(points[end] ) <= budget) {
    used += visibleLength(points[end++] );
  }
  return `${points.slice(start, focus).join("")}▏${points.slice(focus, end).join("")}`;
}

function chatPanelVisualsFrom(
  env                             ,
)                   {
  const frame = env.NOMO_TUI_CHAT_FRAME?.toLowerCase();
  const density = env.NOMO_TUI_CHAT_DENSITY?.toLowerCase();
  const timestamps = env.NOMO_TUI_CHAT_TIMESTAMPS?.toLowerCase();
  const composerHeightPx = Number(env.NOMO_TUI_CHAT_COMPOSER_HEIGHT_PX);
  return {
    frame:
      frame === "filled" ||
      frame === "rounded" ||
      frame === "square" ||
      frame === "double"
        ? frame
        : "rounded",
    density: density === "compact" ? "compact" : "comfortable",
    timestamps:
      timestamps === "on" || timestamps === "true" || timestamps === "1",
    composerHeightPx:
      Number.isSafeInteger(composerHeightPx) &&
      composerHeightPx >= MIN_CHAT_COMPOSER_HEIGHT_PX &&
      composerHeightPx <= MAX_CHAT_COMPOSER_HEIGHT_PX
        ? composerHeightPx
        : DEFAULT_CHAT_COMPOSER_HEIGHT_PX,
  };
}
const TUI_MODES                     = ["normal", "accept", "plan"];

/** Double Escape in a short window opens the checkpoint list. */
function isDoubleEscape(now        , last        , windowMs = 800) {
  return last > 0 && now - last >= 0 && now - last <= windowMs;
}

/** Approval rows show class, radius and the matched case, never a bare tool name.
 * An unmeasured radius prints as unknown, because unknown is not zero. */
function approvalLabel(hold   
                 
                 
                                                                                
 )         {
  const klass = hold.call.klass ? ` [${hold.call.klass.toUpperCase()}]` : "";
  const radius =
    hold.call.blastRadius === undefined
      ? " radius unknown"
      : ` radius ${hold.call.blastRadius}`;
  const reason = hold.call.reason ? ` ${hold.call.reason}` : "";
  return `[${hold.status}]${klass} ${hold.call.tool} ${hold.holdId.slice(0, 8)}${radius}${reason}`;
}

/**
 * How consequential a hold is, highest first.
 *
 * The approvals tab listed holds in whatever order the backend returned
 * them, which put a read next to a write and let an operator approve three
 * harmless calls before reaching the one that touches every document. The
 * order is by blast radius, then by whether the hold has an expiry, because
 * a hold that expires is one the operator has to answer soon.
 *
 * An unmeasured radius sorts last rather than first: unknown is not zero, and
 * sorting it to the top would claim it is the most dangerous thing here.
 */
function holdSeverity(hold   
                          
                  
                            
                                  
    
                              
 )         {
  // A decided hold is not waiting on anyone, so it sorts below everything
  // that is. Weighting it upward would put an answer the operator already
  // gave at the top of the list of things to answer.
  const settled = /reject|deny|expir|approv|grant/i.test(hold.status) ? 1 : 0;
  const radius = hold.call.blastRadius;
  // An unknown radius scores below every known one, including zero.
  const measured = radius === undefined ? -1 : radius;
  return (measured + 1) * 1e6 + (hold.expiresAt ? 1 : 0) - settled * 1e9;
}

/**
 * The approval detail, as fields an operator can read before deciding.
 *
 * The raw JSON it replaces buried the one thing the decision turns on, which
 * is what the call touches, under a dozen keys nobody scans. The JSON is kept
 * below the fields: it is the record, not the reading.
 */
function approvalInspectLines(
  hold   
                   
                      
           
                   
                     
                           
                      
      
   ,
  raw                   ,
  width = 76,
)           {
  const radius =
    hold.call.blastRadius === undefined
      ? "unknown"
      : String(hold.call.blastRadius);
  // Approval state is durable and call arguments can carry secrets, so it
  // never stores them: the args exist only on the live HeldCall inside the
  // proxy process, which the CLI approver renders. The detail calls the
  // omission by name instead of printing a field that is always empty.
  const args = "not recorded: approval state does not store call arguments";
  return renderInspector(
    {
      title: hold.call.tool,
      subtitle: hold.status,
      icon: ROW_ICONS.approval,
      sections: [
        {
          title: "decision",
          fields: [
            {
              label: "status",
              value: hold.status,
              tone: /reject|deny|expir/i.test(hold.status)
                ? "muted"
                : "warning",
            },
            {
              label: "class",
              value: hold.call.klass ?? "unknown",
              // An unknown class is not a low class. It says nothing about
              // what the call may do, which is the opposite of low risk.
              tone: hold.call.klass ? "default" : "error",
            },
            {
              label: "blast radius",
              value: radius,
              tone:
                hold.call.blastRadius === undefined
                  ? "error"
                  : hold.call.blastRadius > 1
                    ? "warning"
                    : "default",
            },
            {
              label: "expires",
              value: Number.isFinite(hold.expiresAt)
                ? new Date(hold.expiresAt).toISOString()
                : "never",
              tone: "muted",
            },
            {
              label: "arguments",
              value: args,
              tone: "default",
            },
          ],
        },
        {
          title: "why it is waiting",
          fields: [],
          body: [
            hold.call.reason ?? "The server supplied no reason for this hold.",
          ],
        },
      ],
      hint: "Use /approve ID or /reject ID to open a review.",
    },
    { width },
  ).concat(["", "RAW RECORD", ...raw]);
}

/**
 * How long a hold can still be answered, in seconds, or null when it has no
 * deadline.
 *
 * A hold without an expiry is not an eternal one, it is a hold whose deadline
 * the server did not send. Printing a countdown for it would invent a number
 * the terminal was never given.
 */
function holdSecondsLeft(
  hold                                 ,
  now        ,
)                {
  if (!Number.isFinite(hold.expiresAt)) return null;
  return Math.max(0, Math.round(((hold.expiresAt          ) - now) / 1000));
}

/** The window in which a hold is announced as about to close. */
const EXPIRY_WARNING_SECONDS = 60;

/**
 * The glyph for an approval row. A hold the operator already answered is not
 * an open obligation, so it does not carry the pending mark. The status word
 * beside it stays authoritative either way.
 */
/**
 * The glyph for a provider state.
 *
 * The state word is printed beside it in every use, so the glyph is only for
 * scanning a column. A state this table does not name gets the failed mark
 * rather than the ready one, because an unrecognised state has never been
 * shown to be working.
 */
/**
 * Group headings for a tab that mixes several kinds of record.
 *
 * The order is the order an operator reasons in: what was signed, then what
 * the chain taught, then the machinery that produced it. Signed entries come
 * first because they are the only ones that are evidence of anything.
 */
const LEDGER_GROUP_ORDER = [
  "verification",
  "entry",
  "proxy",
  "learned",
  "score",
  "harness",
  "agent",
  "hook",
]         ;

const LEDGER_GROUP_TITLE                         = {
  verification: "VERIFICATION",
  entry: "SIGNED ENTRIES",
  proxy: "PROXY ENTRIES",
  learned: "LEARNED FROM THE CHAIN",
  score: "HARNESS SCORE",
  harness: "HARNESS",
  agent: "AGENTS",
  hook: "HOOKS",
};

const LEDGER_GROUP_ICON                         = {
  verification: "◕",
  entry: "▪",
  proxy: "▫",
  learned: "◇",
  score: "▰",
  harness: "◈",
  agent: "◆",
  hook: "◔",
};

function providerStatusIcon(status        )         {
  if (status === "ready") return ROW_ICONS.settled;
  if (status === "setup-required" || status === "rate-limited")
    return ROW_ICONS.queued;
  return ROW_ICONS.failed;
}

function holdRowIcon(hold                    )         {
  return /reject|deny/i.test(hold.status)
    ? ROW_ICONS.rejected
    : ROW_ICONS.approval;
}

/**
 * The trailing countdown on an approval row.
 *
 * A hold with no deadline gets nothing: that means the server sent no
 * deadline, not that it never closes. A hold already past its deadline says
 * so in a word, because "0s left" reads like a value that is about to change.
 */
function expirySuffix(hold                        , now        )         {
  const left = holdSecondsLeft(hold, now);
  if (left === null) return "";
  if (left <= 0) return "EXPIRED | ";
  return `${left}s left | `;
}

/**
 * The glyph for a connector's consent state.
 *
 * The state word is printed beside it in every case, so the glyph is only
 * there to let a column of connectors be scanned by shape. An unknown state
 * gets the question mark rather than one of the known marks: it was never
 * measured into a state, and showing a check for it would claim it is ready.
 */
function connectorConsentIcon(consent        )         {
  if (consent === "confirmed") return "●";
  if (consent === "probed") return "◐";
  if (consent === "staged") return "○";
  return "?";
}

/** The group a conversation is filed under on the sessions tab.
 *
 * Archived conversations get their own group rather than being mixed into a
 * status: an archived conversation is not idle, it was put away on purpose,
 * and a list that hides the distinction will have somebody re-open one and
 * wonder why it did not continue.
 */
function sessionGroup(status        , archived         )         {
  if (archived) return "archived";
  const key = status.toLowerCase();
  if (key.includes("run") || key.includes("active")) return "running";
  if (key.includes("fail") || key.includes("error")) return "failed";
  if (key.includes("queue") || key.includes("pending")) return "queued";
  // "idle" is what a settled conversation that nobody is looking at reports.
  // Filing it under other would put every finished conversation in a bucket
  // named after the states that are not happening.
  if (key.includes("idle") || key.includes("settl") || key.includes("done"))
    return "settled";
  if (key.includes("complet") || key.includes("archiv")) return "settled";
  return "other";
}

function sessionTimestamp(value                    )         {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp)
    ? `${new Date(timestamp).toISOString().slice(0, 16).replace("T", " ")} UTC`
    : "unknown";
}

/** One line banner for the oldest pending hold, pinned above every tab so
 * an approval is never hidden behind a panel switch. The status bar badge
 * keeps the count; this banner keeps the decision and its keys. */
function approvalBannerLines(
  holds            
                            
                                                                      
     ,
  width        ,
  decisionKeys = true,
)           {
  if (!holds.length) return [];
  const first = holds[0] ;
  const klass = first.call.klass ? ` [${first.call.klass.toUpperCase()}]` : "";
  const rest =
    holds.length > 1
      ? ` (+${holds.length - 1} more, /approvals)`
      : " (/approvals)";
  return [
    fit(
      sanitizeText(
        `[!] APPROVAL PENDING${klass} ${first.call.tool} ${first.holdId.slice(0, 8)}${decisionKeys ? " | [a] approve [d] deny" : ""}${rest}`,
      ),
      width,
    ),
  ];
}

/** The TUI mode is a local prompt prefix only. No server readiness channel
 * exists behind this UI yet, so the label always says local only, the same
 * way the control plane labels an unenforced preset. */
function modeAuthorityLabel(mode         )         {
  return `mode: ${mode} (local only, not enforced)`;
}

const APPROVAL_EVIDENCE_LABELS = {
  tool: "tool           ",
  class: "class          ",
  blastRadius: "blast radius   ",
  matchedRule: "matched rule   ",
  precondition: "precondition   ",
  postcondition: "postcondition  ",
}         ;
const UNDO_OPERATION_LABEL = "Operation: ";

/** Approval evidence for the decision screen. Tool, class, radius and the
 * matched registry case prose come from the hold when the server supplies
 * them. Rule id, precondition details and postcondition render as unknown
 * when the server did not supply them, never invented. */
function approvalEvidenceLines(hold   
                          
                  
                            
                             
                                   
                              
                                 
                                 
                                  
                                    
                                     
    
                               
                                 
 )           {
  const call = hold.call ?? {};
  const textOf = (value         )                     =>
    typeof value === "string" && value ? value : undefined;
  const tool = textOf(call.tool) ?? "unknown tool";
  const klass =
    typeof call.klass === "string" && call.klass
      ? call.klass.toUpperCase()
      : "unknown class";
  const radius =
    typeof call.blastRadius === "number" &&
    Number.isSafeInteger(call.blastRadius) &&
    call.blastRadius >= 0
      ? `${call.blastRadius} targets, measured`
      : "radius unknown";
  // The workbench hold keeps the matched registry case prose in reason, so
  // that prose is the precondition evidence. Anything else is unknown.
  const precondition =
    textOf(call.precondition) ??
    textOf(call.reason) ??
    "unknown (the server did not supply a precondition)";
  const postcondition =
    textOf(call.postcondition) ??
    "unknown (the server does not report a postcondition)";
  const ruleIndex =
    typeof hold.ruleIndex === "number"
      ? `policy rule ${hold.ruleIndex}`
      : (textOf(hold.matchedRule) ??
        textOf(call.policyRule) ??
        "unknown (the server did not supply a matched rule id)");
  return [
    `${APPROVAL_EVIDENCE_LABELS.tool}${sanitizeText(tool)}`,
    `${APPROVAL_EVIDENCE_LABELS.class}${sanitizeText(klass)}`,
    `${APPROVAL_EVIDENCE_LABELS.blastRadius}${sanitizeText(radius)}`,
    `${APPROVAL_EVIDENCE_LABELS.matchedRule}${sanitizeText(ruleIndex)}`,
    `${APPROVAL_EVIDENCE_LABELS.precondition}${sanitizeText(precondition)}`,
    `${APPROVAL_EVIDENCE_LABELS.postcondition}${sanitizeText(postcondition)}`,
  ];
}

/** Diff rows carried by a hold, when a future server supplies them. Today
 * neither the workbench nor the proxy hold carries a diff, so approvals
 * review the full call scope. */
function holdDiffRows(hold   
                  
                            
                            
                              
                             
    
 )                       {
  const call = hold.call ?? {};
  if (typeof call.diff === "string" && call.diff) return call.diff.split("\n");
  if (typeof call.before === "string" && typeof call.after === "string")
    return unifiedDiff(call.before, call.after);
  return undefined;
}

/** Review lines for an approval: evidence first, then an optional
 * selectable diff. Module level so tests can drive it without a running
 * session; the class keeps a private alias for the same builders. */
function approvalReview(hold   
                          
                  
                            
                             
                                   
                              
                                 
                                 
                                  
                                    
                                     
                            
                              
                             
    
                               
                                 
 )   
                           
                                                               
                               
  {
  const evidence = approvalEvidenceLines(
    hold                                               ,
  );
  const diffRows = holdDiffRows(hold);
  const chunks = diffRows ? splitDiffHunks(diffRows) : [];
  if (!chunks.length) return { lines: [...evidence, ""] };
  const selected = chunks.map(() => true);
  const hunkBase = [
    ...evidence,
    "",
    "DIFF SCOPE, client side: press 1-9 to toggle a hunk.",
    "The server applies the full call until scope is enforced.",
  ];
  return {
    lines: [...hunkBase, ...renderHunkSelection(chunks, selected)],
    hunks: { chunks, selected },
    hunkBase,
  };
}

/** Tabs where typing filters the list, like a finder. Chat,
 * policy text and help take no filter; every other tab lists items. */
const FILTER_TABS                          = [
  "sessions",
  "runs",
  "documents",
  "ledger",
  "approvals",
  "policy",
  "tools",
  "mcp",
  "status",
  "models",
  "usage",
];

/** OMP-style selectors search on every printable character. */
function filterKeyForTab(
  value                    ,
  key                                                   ,
  tab              ,
)                     {
  if (!FILTER_TABS.includes(tab)) return undefined;
  if (!value || [...value].length !== 1 || key.ctrl || key.meta)
    return undefined;
  if (/[\x00-\x1f\x7f-\x9f]/.test(value)) return undefined;
  return value;
}

/** Reverse history search over sent prompts, most recent first. */
function searchHistoryPrompts(
  prompts                   ,
  query        ,
)           {
  const needle = query.toLocaleLowerCase();
  if (!needle) return [...prompts];
  return prompts.filter((item) => item.toLocaleLowerCase().includes(needle));
}

/** Checklist items are read from real messages, never invented. */
                          
                         
                        
                       
 
function extractTodos(
  events            
                
                 
                  
                 
     ,
)            {
  const out            = [];
  for (const event of events) {
    if (event.kind === "user") {
      out.length = 0;
      continue;
    }
    if (event.type && event.type !== "message.completed") continue;
    if (event.kind !== "assistant") continue;
    const checklist            = [];
    let fence = "";
    for (const line of event.text.split("\n")) {
      const marker = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (
        marker &&
        (!fence ||
          (marker[1] [0] === fence[0] &&
            marker[1] .length >= fence.length &&
            !marker[2] .trim()))
      ) {
        fence = fence ? "" : marker[1] ;
        continue;
      }
      if (fence) continue;
      const found = /^\s*[-*+]\s*\[( |x|X)\]\s+(.+)$/.exec(line);
      if (found)
        checklist.push({
          done: found[1] !== " ",
          text: found[2] .trim().slice(0, 200),
          seq: event.seq,
        });
    }
    if (checklist.length) out.splice(0, out.length, ...checklist);
  }
  return out;
}

                                  
                            
                             
                                  
                     
                    
                     
   

const LOCAL_ICON_TABS                    = [
  "overview",
  "chat",
  "sessions",
  "documents",
  "ledger",
  "approvals",
  "policy",
  "tools",
  "models",
  "usage",
  "help",
];
const LOCAL_ICON_SEMANTICS = [
  "subagents",
  "heartbeats",
  "shells",
  "appearance",
  "interaction",
  "composer",
  "timestamps",
  "context",
  "queue",
  "network",
  "run",
  "retry",
  "refinement",
  "search",
  "settings",
  "timeout",
]         ;
const localIconLabelCache = new WeakMap 
                
                                    
 ();
const localIconPatternCache = new WeakMap                           ();

function trustedLocalIconLabels(
  icons                           ,
  theme            ,
)                    {
  if (!icons) return [];
  let byTheme = localIconLabelCache.get(icons);
  if (!byTheme) {
    byTheme = new Map();
    localIconLabelCache.set(icons, byTheme);
  }
  const cached = byTheme.get(theme);
  if (cached) return cached;
  const labels = new Set        ();
  for (const tab of LOCAL_ICON_TABS) {
    const label = kittyTabIconLabel(tab, icons, theme);
    if (label) labels.add(label);
  }
  for (const semantic of LOCAL_ICON_SEMANTICS) {
    const label = kittySemanticIconLabel(semantic, icons, theme);
    if (label) labels.add(label);
  }
  const provider = kittyProviderIconLabel(icons, theme);
  if (provider) labels.add(provider);
  const result = [...labels].sort((left, right) => right.length - left.length);
  byTheme.set(theme, result);
  return result;
}

function trustedIconPattern(labels                   )                     {
  if (!labels.length) return undefined;
  let cached = localIconPatternCache.get(labels);
  if (!cached) {
    const escaped = labels.map((label) =>
      label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    );
    cached = new RegExp(escaped.join("|"), "g");
    localIconPatternCache.set(labels, cached);
  }
  return cached;
}

function sanitizeRendererText(value        )         {
  // Renderer-owned icon labels may have passed through an older sanitizer
  // that replaced ESC with "?", leaving visible fragments like `?[38;2…m`.
  // Strip complete ANSI first, then remove only those damaged SGR remnants.
  return sanitizeText(stripAnsi(value).replace(/\?\[[0-?]*[ -/]*m/g, ""));
}

/** Split only exact, locally generated Kitty icon labels out of untrusted text. */
function safeTextUnits(
  value        ,
  trustedIcons                   ,
)           {
  const pattern = trustedIconPattern(trustedIcons);
  if (!pattern) return [...sanitizeRendererText(value)];
  const units           = [];
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const start = match.index ?? cursor;
    units.push(...sanitizeRendererText(value.slice(cursor, start)));
    units.push(match[0]);
    cursor = start + match[0].length;
  }
  units.push(...sanitizeRendererText(value.slice(cursor)));
  return units;
}

function fitWithTrustedIcons(
  value        ,
  width        ,
  trustedIcons                   ,
  side                   = "right",
)         {
  if (width <= 0) return "";
  const units = safeTextUnits(value, trustedIcons);
  const safe = units.join("");
  if (visibleLength(safe) <= width) return safe;
  if (width === 1) return ".";
  const kept           = [];
  let used = 0;
  const ordered = side === "left" ? [...units].reverse() : units;
  for (const unit of ordered) {
    const cells = visibleLength(unit);
    if (used + cells > width - 1) break;
    kept.push(unit);
    used += cells;
  }
  const content = side === "left" ? kept.reverse().join("") : kept.join("");
  return side === "left" ? `.${content}` : `${content}.`;
}

const chatEventSummaries = new WeakMap 
                          
                  
 ();
const chatEventPrefixSummaries = new WeakMap                                ();

function chatEventSummary(events                         )                   {
  const cached = chatEventSummaries.get(events);
  if (cached) return cached;
  let prefix                              ;
  let prefixEnd = 0;
  // Workbench appends immutable events while a response streams. Reuse the
  // longest cached prefix so each new delta costs only the newly appended tail,
  // rather than rescanning the full conversation on every render.
  for (let index = events.length - 1; index >= 0; index--) {
    const candidate = chatEventPrefixSummaries.get(events[index] );
    if (candidate?.eventCount === index + 1) {
      prefix = candidate;
      prefixEnd = index + 1;
      break;
    }
  }
  let latestUser = prefix?.latestUser;
  let lastVisible = prefix?.lastVisible;
  let usage = prefix?.usage;
  let totalTodos = prefix?.totalTodos ?? 0;
  let openTodos = prefix?.openTodos ?? 0;
  for (let index = prefixEnd; index < events.length; index++) {
    const event = events[index] ;
    if (event.kind === "user") {
      latestUser = event;
      totalTodos = 0;
      openTodos = 0;
    }
    if (event.type !== "run.status" && event.kind !== "usage")
      lastVisible = event;
    if (event.kind === "usage") usage = event.payload;
    if (
      (event.type === undefined || event.type === "message.completed") &&
      event.kind === "assistant"
    ) {
      const checklist = extractTodos([event]);
      if (checklist.length) {
        totalTodos = checklist.length;
        openTodos = checklist.filter((item) => !item.done).length;
      }
    }
    chatEventPrefixSummaries.set(event, {
      latestUser,
      lastVisible,
      usage,
      totalTodos,
      openTodos,
      eventCount: index + 1,
    });
  }
  const summary = {
    latestUser,
    lastVisible,
    usage,
    totalTodos,
    openTodos,
    eventCount: events.length,
  };
  chatEventSummaries.set(events, summary);
  return summary;
}

/** @path completion reads managed document paths of live sessions. */
function mentionCandidates(
  prefix        ,
  paths                   ,
)           {
  const needle = prefix.toLocaleLowerCase();
  return paths
    .filter((item) => item.toLocaleLowerCase().startsWith(needle))
    .slice(0, 8);
}
/** The @ token right before the cursor, if the operator typed one. */
function mentionToken(
  value        ,
  cursor        ,
)                     {
  const before = [...value].slice(0, cursor).join("");
  const found = /@([^\s@]*)$/.exec(before);
  return found ? (found[1] ?? "") : undefined;
}

/** External harness CLIs detected on PATH, never executed by this check. */
async function detectHarnesses(
  env                             ,
)                                                 {
  const found                                        = [];
  const pathEnv = env.PATH ?? "";
  for (const id of ["prime-agent", "opencode"]) {
    let path                = null;
    for (const dir of pathEnv.split(":")) {
      if (!dir) continue;
      const candidate = join(dir, id);
      try {
        await access(candidate);
        path = candidate;
        break;
      } catch {
        continue;
      }
    }
    found.push({ id, path });
  }
  return found;
}

/** Gated shell escape refuses anything that can carry key material. */
const SHELL_REFUSALS = [
  /\$[A-Za-z_]*(KEY|TOKEN|SECRET|PASSWORD)/,
  /api[_-]?key/i,
  /tokenharbor|tokenrouter/i,
  /secret|password|passwd|authorization|bearer/i,
  /private[_-]?key|id_rsa|\.pem\b/i,
  /\.env\b|\.nomo|keychain/i,
];
const runShellFile = promisify(execFile);

const STARTER_DOC = `# Plan

## Goal

Describe what this workspace should achieve.

## Steps

- [ ] First concrete step
- [ ] Second concrete step

## Notes

Decisions and open questions live here.
`;

const COMMAND_PALETTE_NOTICE =
  "Palette: type to filter, Up/Down select, Enter run, Esc close.";

function documentPreviewLayout(columns        , viewportHeight        ) {
  const width = Math.max(1, Math.floor(columns));
  const height = Math.max(1, viewportHeight);
  const sideBySide = width >= 72 && height >= 6;
  return {
    width,
    height,
    sideBySide,
    treeWidth: sideBySide
      ? Math.max(28, Math.floor((width - 2) * 0.45))
      : width,
  };
}

function sessionInspectorLayout(columns        , viewportHeight        ) {
  const width = Math.max(1, Math.floor(columns));
  const height = Math.max(1, Math.floor(viewportHeight));
  const sideBySide = width >= 100 && height >= 18;
  const paneHeight = Math.max(1, height - 2);
  const treeHeight = sideBySide
    ? paneHeight
    : Math.max(1, Math.min(paneHeight, Math.floor(paneHeight * 0.4)));
  return {
    width,
    height,
    paneHeight,
    sideBySide,
    treeHeight,
    treeWidth: sideBySide
      ? Math.min(42, Math.max(30, Math.floor((width - 3) * 0.32)))
      : width,
  };
}

function findTreeAncestors(
  nodes                     ,
  targetId        ,
  ancestors                    = [],
)                                {
  for (const node of nodes) {
    if (node.id === targetId) return ancestors;
    if (node.children?.length) {
      const found = findTreeAncestors(node.children, targetId, [
        ...ancestors,
        node.id,
      ]);
      if (found) return found;
    }
  }
  return undefined;
}

function refreshedTreeState(
  previous 
                                                                        
               ,
  nodes                     ,
)            {
  const initial = initialTreeState(nodes);
  if (!previous || nodes.length === 0) return initial;

  // Session status, recency and message-count changes rebuild the rows while
  // a conversation is running. Keep the operator's expansion and cursor
  // anchored to the same stable node id across that refresh.
  const previousNode = flattenTree(previous.nodes, previous.state)[
    previous.state.cursor
  ];
  const expandable = new Set        ();
  const collectExpandable = (entries                     ) => {
    for (const node of entries) {
      if (node.hasChildren || (node.children?.length ?? 0) > 0)
        expandable.add(node.id);
      if (node.children?.length) collectExpandable(node.children);
    }
  };
  collectExpandable(nodes);
  const expanded = new Set(
    [...previous.state.expanded].filter((id) => expandable.has(id)),
  );
  if (previousNode) {
    for (const ancestor of findTreeAncestors(nodes, previousNode.id) ?? [])
      expanded.add(ancestor);
  }
  const visible = flattenTree(nodes, { expanded});
  const selected = previousNode
    ? visible.findIndex((node) => node.id === previousNode.id)
    : -1;
  return {
    expanded,
    cursor:
      selected >= 0
        ? selected
        : Math.max(0, Math.min(previous.state.cursor, visible.length - 1)),
  };
}

/** Same persistent workbench as the web. Rendering never grants tool authority. */
class WorkspaceTui {
           workbench           ;
           proxy                ;
           env                             ;
  tab               = "chat";
  tabHitTargets         
                      
                
                  
                
     = [];
  rowHitTargets        
                                                                              
                                                                              
       
                    
                      
                    
                         
                      
       
                                                                               
       
                    
                      
                    
                        
                      
       
    = [];
  hoveredRow    
                                                                      
                           
   ;
  selected = 0;
  scroll = 0;
  viewport                                                                    =
    {
      offset: 0,
      height: 1,
      total: 0,
      width: 76,
    };
  /** Current content width for list details built before the next draw. */
  layoutColumns = 76;
  /** Viewport offsets of user prompt rows, for { and } jumps. */
  promptRows           = [];
  sessionId         ;
  documentPath         ;
  projectId         ;
  agentId         ;
  lastRecoveryJob                                       ;
  model = "";
  activeShellCommands = 0;
  filter = "";
  /**
   * The filter typed into the /keybindings table. Separate from filter above
   * because that one narrows the item list, and sharing one field would let a
   * keystroke meant for a table row silently hide list items instead.
   */
  keybindingQuery = "";
  /** True while the visible detail is the keybinding table. */
  keybindingDetail = false;
  /**
   * The cheat sheet, summoned from anywhere.
   *
   * Separate from keybindingDetail on purpose. The keybinding table is a page
   * an operator visits to read every binding, and it renders into the detail
   * pane. The cheat sheet answers "that key did not do what I expected",
   * which is a question about right now, and it opens over whatever was on
   * screen. It still renders into detail because that pane is the only thing
   * in the frame that does not disturb the body behind it, and re-laying the
   * body would drop the scroll position the operator was reading at.
   */
  cheatSheet = false;
  /**
   * The filter typed into the cheat sheet. Its own field, not keybindingQuery,
   * for the reason the keybinding query has its own field: two overlays sharing
   * one filter would let a keystroke meant for one narrow the other.
   */
  cheatQuery = "";
  /** Terminal width the cheat sheet was last laid out for. */
  cheatWidth = 0;
  /**
   * Grouping for the documents and sessions tabs. Present only while one of
   * those is open, which is what makes its presence the signal that the tree
   * keys are live rather than another meaning for left and right.
   */
  groupTree                                          ;
          groupTreeKey         ;
  /** Terminal width the keybinding table was last laid out for. */
  keybindingWidth = 0;
  /**
   * Animation frame counter, published by the renderer before it asks for
   * lines. The list rows are built by the model, which has no access to the
   * frame otherwise, and the viewport and prompt rows are already published
   * the same way for the same reason.
   */
  frame = 0;
  /**
   * Whether the composer is taking typing, published by the renderer.
   *
   * The runner owns that state as input.editing and the model has no other way
   * to see it. Published the same way as frame, for the same reason: the
   * cheat sheet asks which keys apply now, and "now" includes whether the
   * keyboard belongs to the prompt.
   */
  editingInput = false;
  toolActivityMode                   = "details";
  hideToolActivity = false;
  mode          = "normal";
          modeBeforePlan          ;
  /** Runtime theme overrides. Undefined keeps the NOMO_TUI_* environment. */
  colorOverride          ;
  motionOverride          ;
  themeConfig             ;
  chatPanelVisuals                  ;
  keybindingsOverride         ;
           localTabIcons                           ;
  queuedPrompt                = null;
  queuedPromptPaused = false;
  /** Live command palette. Present means the overlay owns the keyboard. */
  palette               ;
  /** Frecency state persists across palette opens. */
  paletteState                                                               ;
  /**
   * Transient events that must be seen but not re-read. The sticky approval
   * banner stays authoritative, so nothing safety related is raised here.
   */
  toasts            = { toasts: [], active: undefined };
  /** Which outstanding operation the /diff panel is showing. */
  diffIndex = 0;
  /**
   * Review state for the visible diff panel: cursor, staged hunks and side.
   * Present only while /diff is on screen, so its presence is the signal that
   * the review keys are live rather than another meaning for the same letters.
   */
  diffView                ;
  notice = "Ready";
  detail           ;
  settingsOpen = false;
  settingsSelected = 0;
  settingsQuery = "";
  settingsQueryCursor = 0;
  settingsRowLines           = [];
  settingsEdit                                                 ;
  confirmation               ;
          branchIntent    
                      
                
                                
                
   ;
  provider                                                  ;
  modelProjection                                                    = {
    activeProviderId: null,
    providers: [],
  };
  modelPicker                   ;
                   pendingModelCatalogs = new Set        ();
          modelPickerGeneration = 0;
          modelCatalogKey(providerId        )         {
    return `${this.modelPickerGeneration}:${providerId}`;
  }
  /**
   * Provider catalog metadata can arrive through an on-demand model lookup,
   * while the Workbench's passive state snapshot still carries an older
   * catalog. Retain only verified context capacities so a refresh cannot
   * erase a known value from the chat rail.
   */
                   modelContextWindows = new Map 
           
                               
   ();
          rememberModelContextWindows(
    providerIds                                        ,
    models                                                                     ,
    replace = false,
  ) {
    const contexts = new Map                ();
    for (const model of models) {
      if (
        typeof model.contextWindow === "number" &&
        Number.isSafeInteger(model.contextWindow) &&
        model.contextWindow > 0
      )
        contexts.set(model.id, model.contextWindow);
    }
    for (const providerId of new Set(
      providerIds.filter((id)               => Boolean(id)),
    )) {
      const previous = this.modelContextWindows.get(providerId);
      if (!replace && previous) {
        const merged = new Map(previous);
        for (const [modelId, contextWindow] of contexts)
          merged.set(modelId, contextWindow);
        this.modelContextWindows.delete(providerId);
        this.modelContextWindows.set(providerId, merged);
      } else if (contexts.size) {
        this.modelContextWindows.delete(providerId);
        this.modelContextWindows.set(providerId, contexts);
      } else if (replace) {
        this.modelContextWindows.delete(providerId);
      }
    }
    while (this.modelContextWindows.size > 32)
      this.modelContextWindows.delete(
        this.modelContextWindows.keys().next().value ,
      );
  }
  modelContextWindow(
    providerId                    ,
    modelIds                     ,
  )                     {
    if (!providerId) return undefined;
    const contexts = this.modelContextWindows.get(providerId);
    if (!contexts) return undefined;
    for (const modelId of modelIds) {
      const contextWindow = contexts.get(modelId);
      if (contextWindow !== undefined) return contextWindow;
    }
    return undefined;
  }
  /** True only for the passive document preview shown while browsing its tree. */
  documentPreview = false;
  modelCatalogStatus                                   = "idle";
  proofs = new Map                      ();
  proofErrors = new Map                ();
  /**
   * The key the workbench verified the managed ledger with, and the claim it
   * supports. The managed proofs are read through `Workbench.ledger`, which
   * resolves its own key, so the TUI has to carry that resolution out to the
   * record view rather than assert "verified" with nothing behind it.
   */
  managedVerificationStatus                    ;
  managedVerificationNote                    ;
          proofStamp = "";
          verifiedLedgerRevision = -1;
                   proofEventSequences = new Map 
           
                                          
   ();
          renderedChatRows    
                      
                                    
                  
                                   
                              
                         
                        
                               
                        
                          
                        
                    
   ;
  constructor(
    workbench           ,
    env                              = process.env,
  ) {
    this.workbench = workbench;
    this.env = env;
    this.proxy = new ProxyWorkspace(env);
    this.themeConfig = getThemeConfig(env);
    this.chatPanelVisuals = chatPanelVisualsFrom(env);
    this.keybindingsOverride = env.NOMO_TUI_KEYBINDINGS;
    this.localTabIcons =
      detectCapabilities(env).ansi &&
      env.TERM_PROGRAM === "ghostty" &&
      env.TERM === "xterm-ghostty"
        ? loadLocalTabIcons(env)
        : undefined;
  }
          providerGlyph(id        , name = "")         {
    const isLocal =
      /\b(?:local|ollama|lm[ -]?studio)\b|localhost|127\.0\.0\.1|::1/i.test(
        `${id} ${name}`,
      );
    return this.localTabIcons
      ? (isLocal
          ? kittyTabIconLabel(
              "models",
              this.localTabIcons,
              this.themeConfig.colorTheme,
            )
          : kittyProviderIconLabel(
              this.localTabIcons,
              this.themeConfig.colorTheme,
            )) || modelProviderIcon(id, name)
      : modelProviderIcon(id, name);
  }
          modelGlyph()         {
    return this.localTabIcons
      ? kittyTabIconLabel(
          "models",
          this.localTabIcons,
          this.themeConfig.colorTheme,
        ) || ROW_ICONS.model
      : ROW_ICONS.model;
  }
  async initialize() {
    try {
      this.provider = await this.workbench.providerState();
      this.modelProjection = this.workbench.providerModelsProjection();
      this.rememberModelContextWindows(
        [this.provider.baseUrl, this.modelProjection.activeProviderId],
        this.provider.models,
      );
      this.model = this.provider.defaultModel ?? "";
      this.modelCatalogStatus =
        this.provider.connected && this.provider.models.length > 0
          ? "ready"
          : "unavailable";
    } catch (error) {
      this.modelCatalogStatus = "unavailable";
      this.notice = message(error);
    }
    await this.refresh(true);
  }
  async refresh(force = false) {
    await this.proxy.refresh(force);
    const stamp = this.workbench
      .allViews()
      .map((session) => {
        // Deltas do not change signed evidence. Remember the latest stable
        // sequence and inspect only newly appended events during a stream;
        // rescanning a long delta tail every refresh made long runs quadratic.
        const lastSeq = session.events.at(-1)?.seq ?? 0;
        const prior = this.proofEventSequences.get(session.id);
        let stableSeq = prior?.stableSeq ?? 0;
        if (!prior || lastSeq < prior.lastSeq) {
          stableSeq = 0;
          for (let index = session.events.length - 1; index >= 0; index--) {
            const event = session.events[index] ;
            if (event.type !== "message.delta") {
              stableSeq = event.seq;
              break;
            }
          }
        } else if (lastSeq > prior.lastSeq) {
          for (let index = session.events.length - 1; index >= 0; index--) {
            const event = session.events[index] ;
            if (event.seq <= prior.lastSeq) break;
            if (event.type !== "message.delta") {
              stableSeq = event.seq;
              break;
            }
          }
        }
        this.proofEventSequences.set(session.id, { lastSeq, stableSeq });
        return `${session.id}:${stableSeq}:${session.status}`;
      })
      .join("|");
    const ledgerRevision = this.workbench.ledgerRevision();
    if (
      !force &&
      stamp === this.proofStamp &&
      ledgerRevision === this.verifiedLedgerRevision
    )
      return;
    this.proofStamp = stamp;
    this.provider = await this.workbench.providerState();
    this.modelProjection = this.workbench.providerModelsProjection();
    this.rememberModelContextWindows(
      [this.provider.baseUrl, this.modelProjection.activeProviderId],
      this.provider.models,
    );
    this.modelCatalogStatus =
      this.provider.connected && this.provider.models.length > 0
        ? "ready"
        : "unavailable";
    if (force || ledgerRevision !== this.verifiedLedgerRevision) {
      this.proofs.clear();
      this.proofErrors.clear();
      // Every managed workspace verifies with the same resolved key, so the
      // last one read is the one that verified them all. Recording it is what
      // lets the record view name the key instead of only asserting a result.
      this.managedVerificationStatus = undefined;
      this.managedVerificationNote = undefined;
      for (const session of this.workbench.list()) {
        try {
          const proof = await this.workbench.ledger(session.workspace);
          if (proof) {
            this.proofs.set(session.id, [...proof.entries]);
            this.managedVerificationStatus = verificationStatus(
              proof.verification,
            );
            this.managedVerificationNote = verificationKeyNote(
              proof.verification,
            );
          }
        } catch {
          this.proofErrors.set(
            session.id,
            "Signature / integrity ERROR. Recovery and export cannot be considered verified.",
          );
        }
      }
      this.verifiedLedgerRevision = ledgerRevision;
    }
    this.selected = Math.min(
      this.selected,
      Math.max(0, this.items().length - 1),
    );
  }
  applySavedSettings(value         ) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const saved = value                             ;
    if (
      this.env.NOMO_TUI_THEME === undefined &&
      typeof saved.colorTheme === "string" &&
      Object.hasOwn(COLOR_THEMES, saved.colorTheme)
    )
      this.themeConfig = {
        ...this.themeConfig,
        colorTheme: saved.colorTheme,
      };
    if (
      this.env.NOMO_TUI_SYMBOLS === undefined &&
      typeof saved.symbolPreset === "string" &&
      Object.hasOwn(SYMBOL_SETS, saved.symbolPreset)
    )
      this.themeConfig = {
        ...this.themeConfig,
        symbolPreset: saved.symbolPreset,
      };
    if (
      this.env.NOMO_TUI_CHAT_FRAME === undefined &&
      ["filled", "rounded", "square", "double"].includes(saved.chatFrame ?? "")
    )
      this.chatPanelVisuals = {
        ...this.chatPanelVisuals,
        // Older local state persisted the former default. Adopt the current
        // Prime/OMP hybrid default once; the filled style remains selectable.
        frame: saved.chatFrame === "filled" ? "rounded" : saved.chatFrame ,
      };
    if (
      this.env.NOMO_TUI_CHAT_DENSITY === undefined &&
      ["comfortable", "compact"].includes(saved.chatDensity ?? "")
    )
      this.chatPanelVisuals = {
        ...this.chatPanelVisuals,
        density: saved.chatDensity ,
      };
    if (
      this.env.NOMO_TUI_CHAT_TIMESTAMPS === undefined &&
      typeof saved.chatTimestamps === "boolean"
    )
      this.chatPanelVisuals = {
        ...this.chatPanelVisuals,
        timestamps: saved.chatTimestamps,
      };
    if (
      this.env.NOMO_TUI_CHAT_COMPOSER_HEIGHT_PX === undefined &&
      Number.isSafeInteger(saved.chatComposerHeightPx) &&
      saved.chatComposerHeightPx  >= MIN_CHAT_COMPOSER_HEIGHT_PX &&
      saved.chatComposerHeightPx  <= MAX_CHAT_COMPOSER_HEIGHT_PX
    )
      this.chatPanelVisuals = {
        ...this.chatPanelVisuals,
        composerHeightPx: saved.chatComposerHeightPx ,
      };
    if (
      this.env.NOMO_TUI_COLOR === undefined &&
      typeof saved.terminalColor === "boolean"
    )
      this.colorOverride = saved.terminalColor;
    if (
      this.env.NOMO_TUI_MOTION === undefined &&
      typeof saved.motion === "boolean"
    )
      this.motionOverride = saved.motion;
    if (
      this.env.NOMO_TUI_KEYBINDINGS === undefined &&
      typeof saved.keybindings === "string" &&
      !parseWorkspaceKeybindings(saved.keybindings).error
    )
      this.keybindingsOverride = saved.keybindings || undefined;
  }
  localSettings()                   {
    return {
      colorTheme: this.themeConfig.colorTheme,
      symbolPreset: this.themeConfig.symbolPreset,
      chatFrame: this.chatPanelVisuals.frame,
      chatDensity: this.chatPanelVisuals.density,
      chatTimestamps: this.chatPanelVisuals.timestamps,
      chatComposerHeightPx: this.chatPanelVisuals.composerHeightPx,
      ...(this.keybindingsOverride === undefined
        ? {}
        : { keybindings: this.keybindingsOverride }),
      ...(this.colorOverride === undefined
        ? {}
        : { terminalColor: this.colorOverride }),
      ...(this.motionOverride === undefined
        ? {}
        : { motion: this.motionOverride }),
    };
  }
  choose(requestedTab                           ) {
    // Keep old callers source-compatible while routing the retired landing
    // panel to Chat. It is not part of the visible panel registry.
    const tab               =
      requestedTab === "overview" ? "chat" : requestedTab;
    this.tab = tab;
    this.settingsOpen = false;
    this.settingsEdit = undefined;
    this.settingsRowLines = [];
    this.modelPickerGeneration += 1;
    this.modelPicker = undefined;
    this.hoveredRow = undefined;
    if (tab === "models")
      this.modelCatalogStatus =
        this.provider?.connected && this.provider.models.length > 0
          ? "ready"
          : "unavailable";
    this.selected = 0;
    this.scroll = tab === "chat" ? -1 : 0;
    this.detail = undefined;
    this.documentPreview = false;
    // Cleared here rather than at each of the other five places that drop the
    // detail view, because a stale flag would make ordinary typing filter a
    // table that is no longer on screen.
    this.keybindingDetail = false;
    // Same reason, same hazard: the sheet is filtered by ordinary typing, so a
    // flag left set after the panel changed would eat every letter typed next.
    this.cheatSheet = false;
    this.cheatQuery = "";
    // The tree belongs to Sessions and Documents. Left on elsewhere it would
    // let the arrow keys fold a tree the operator is not even looking at.
    this.groupTree = undefined;
    this.groupTreeKey = undefined;
    this.filter = "";
  }
  cycle(direction        ) {
    this.choose(
      WORKSPACE_TABS[
        (WORKSPACE_TABS.indexOf(this.tab) + direction + WORKSPACE_TABS.length) %
          WORKSPACE_TABS.length
      ] ,
    );
  }
          activeModelCatalog() {
    if (this.modelCatalogStatus !== "ready") return [];
    const provider = this.modelProjection.providers.find(
      (candidate) => candidate.id === this.modelProjection.activeProviderId,
    );
    return provider?.catalogStatus === "ready" ? provider.models : [];
  }
  async openModelPicker(selection                        = "default") {
    const generation = ++this.modelPickerGeneration;
    const session = selection === "session" ? this.session() : undefined;
    if (selection === "session" && !session)
      throw new Error(
        "Start or resume a conversation before choosing its model.",
      );
    const sessionCatalog = session
      ? await this.workbench.sessionModelCatalog(session.id)
      : undefined;
    if (
      generation !== this.modelPickerGeneration ||
      (session && this.sessionId !== session.id)
    )
      return;
    if (sessionCatalog)
      this.rememberModelContextWindows(
        [sessionCatalog.providerId, session?.provider],
        sessionCatalog.models,
        true,
      );
    if (
      sessionCatalog &&
      sessionCatalog.providerId ===
        this.workbench.providerModelsProjection().activeProviderId &&
      this.provider
    ) {
      this.provider = { ...this.provider, models: sessionCatalog.models };
    }
    const imports =
      selection === "default" ? await ompProviderSources(this.env) : [];
    if (
      generation !== this.modelPickerGeneration ||
      (session && this.sessionId !== session.id)
    )
      return;
    const providers                        = sessionCatalog
      ? [
          {
            id: sessionCatalog.providerId,
            name:
              this.modelProjection.providers.find(
                (provider) => provider.id === sessionCatalog.providerId,
              )?.name ??
              session?.provider ??
              sessionCatalog.providerId,
            attached: true,
            catalogStatus: sessionCatalog.models.length
              ? "ready"
              : "unavailable",
            models: sessionCatalog.models,
          },
        ]
      : this.modelProjection.providers.map(
          ({ id, name, attached, catalogStatus, models }) => ({
            id,
            name,
            attached,
            catalogStatus,
            models,
          }),
        );
    for (const source of imports) {
      if (!source.available) continue;
      const providerId = source.id === "omp:nvidia" ? "nvidia" : "openrouter";
      const preset = PROVIDER_PRESETS.find((entry) => entry.id === providerId);
      if (
        !preset ||
        providers.some((provider) => provider.id === preset.baseUrl)
      )
        continue;
      providers.push({
        id: preset.baseUrl,
        name: preset.name,
        attached: false,
        catalogStatus: "idle",
        importSourceId: source.id,
      });
    }
    const providerIndex = sessionCatalog
      ? 0
      : Math.max(
          0,
          providers.findIndex(
            (provider) => provider.id === this.modelProjection.activeProviderId,
          ),
        );
    const provider = providers[providerIndex];
    const activeModels =
      provider?.attached && provider.catalogStatus === "ready"
        ? (provider.models ?? [])
        : [];
    const selectedModelId =
      selection === "session"
        ? session?.model
        : provider?.id === this.modelProjection.activeProviderId
          ? this.model
          : undefined;
    const models = [...activeModels];
    this.modelPicker = {
      open: true,
      origin: this.tab === "chat" ? "chat" : "workspace",
      selection,
      providers,
      query: "",
      cursor: 0,
      selected: Math.max(
        0,
        models.findIndex((model) => model.id === selectedModelId),
      ),
      providerIndex,
      ...(provider ? { providerId: provider.id } : {}),
      focusedPane: models.length ? "models" : "providers",
      catalogStatus:
        provider?.catalogStatus === "ready"
          ? "ready"
          : provider?.attached
            ? "unavailable"
            : "idle",
      models,
    };
    if (
      provider?.id ===
      this.workbench.providerModelsProjection().activeProviderId
    ) {
      // Refresh a missing live context window in the background; opening the
      // picker stays immediate and the ordinary redraw picks up the result.
      void this.loadModelPickerProvider(provider.id);
    }
    if (selection === "session" && !models.length)
      this.notice = "This conversation's provider has no available models.";
    else if (this.modelCatalogStatus !== "ready")
      this.notice = providers.some((provider) => provider.importSourceId)
        ? "An OMP provider key is available. Choose its provider row and press Right to load models."
        : providers.length
          ? "Choose a configured provider row and press Right to load its models."
          : "Use /sources and /connect SOURCE-ID to connect a provider before choosing a model.";
  }
  closeModelPicker() {
    this.modelPickerGeneration += 1;
    this.modelPicker = undefined;
  }
  selectModelPickerProvider(index        ) {
    const picker = this.modelPicker;
    if (!picker?.open) return;
    const providers = picker.providers;
    if (!providers.length) return;
    const providerIndex = Math.max(0, Math.min(providers.length - 1, index));
    const provider = providers[providerIndex] ;
    const columns = Math.max(1, (this.viewport.width ?? 80) - 4);
    const visibleRows = Math.max(
      1,
      this.viewport.height - (columns >= 88 ? 2 : 5),
    );
    const providerWindowStart = modelPickerSelectionWindowStart(
      picker.providerIndex,
      providerIndex,
      providers.length,
      visibleRows,
      picker.providerWindowStart,
    );
    const ready =
      provider.catalogStatus === "ready" && !!provider.models?.length;
    const loading = this.pendingModelCatalogs.has(
      this.modelCatalogKey(provider.id),
    );
    this.modelPicker = {
      ...picker,
      providerIndex,
      providerId: provider.id,
      focusedPane: "providers",
      query: "",
      cursor: 0,
      selected: 0,
      providerWindowStart,
      modelWindowStart: undefined,
      catalogStatus: ready
        ? "ready"
        : loading
          ? "loading"
          : provider.catalogStatus,
      models: ready ? (provider.models ?? []) : [],
    };
  }
  async loadModelPickerProvider(providerId        ) {
    const generation = this.modelPickerGeneration;
    const pendingKey = this.modelCatalogKey(providerId);
    const picker = this.modelPicker;
    const pickerSessionId =
      picker?.selection === "session" ? this.sessionId : undefined;
    const provider = picker?.providers.find(
      (candidate) => candidate.id === providerId,
    );
    if (!picker?.open || picker.providerId !== providerId || !provider) return;
    const selectedModel =
      picker.selection === "session" ? this.session()?.model : this.model;
    const activeOpenRouterContextMissing =
      providerId === this.modelProjection.activeProviderId &&
      this.provider?.providerId === "openrouter" &&
      typeof selectedModel === "string" &&
      selectedModel.length > 0 &&
      !this.provider.models.some(
        (model) =>
          model.id === selectedModel &&
          typeof model.contextWindow === "number" &&
          Number.isSafeInteger(model.contextWindow) &&
          model.contextWindow > 0,
      );
    if (
      provider.catalogStatus === "ready" &&
      provider.models?.length &&
      !activeOpenRouterContextMissing
    ) {
      this.modelPicker = {
        ...picker,
        focusedPane: "models",
        catalogStatus: "ready",
        models: provider.models ?? [],
      };
      return;
    }
    if (this.pendingModelCatalogs.has(pendingKey)) {
      this.modelPicker = {
        ...picker,
        focusedPane: "models",
        catalogStatus: "loading",
        models: [],
      };
      return;
    }
    this.pendingModelCatalogs.add(pendingKey);
    this.modelPicker = {
      ...picker,
      focusedPane: "models",
      selected: 0,
      modelWindowStart: undefined,
      catalogStatus: "loading",
      models: [],
    };
    try {
      let catalog            
                            
                              
                                        
         ;
      if (provider.importSourceId) {
        catalog = await desktopProviderModels(
          provider.importSourceId,
          this.env,
          this.workbench,
        );
      } else {
        catalog = await this.workbench.providerModels(providerId);
      }
      const currentPicker = this.modelPicker;
      if (
        generation !== this.modelPickerGeneration ||
        (pickerSessionId !== undefined && this.sessionId !== pickerSessionId) ||
        !currentPicker?.open ||
        !currentPicker.providers.some(
          (candidate) => candidate.id === providerId,
        )
      )
        return;
      const activeProjection = this.workbench.providerModelsProjection();
      if (
        providerId === activeProjection.activeProviderId &&
        !provider.importSourceId
      ) {
        const refreshedProvider = await this.workbench.providerState({
          probeEnvironment: false,
        });
        const latestProjection = this.workbench.providerModelsProjection();
        if (
          generation === this.modelPickerGeneration &&
          (pickerSessionId === undefined ||
            this.sessionId === pickerSessionId) &&
          latestProjection.activeProviderId === providerId
        ) {
          this.provider = { ...refreshedProvider, models: catalog };
          this.modelProjection = latestProjection;
        }
      }
      const refreshedPicker = this.modelPicker;
      if (
        generation !== this.modelPickerGeneration ||
        (pickerSessionId !== undefined && this.sessionId !== pickerSessionId) ||
        !refreshedPicker?.open ||
        !refreshedPicker.providers.some(
          (candidate) => candidate.id === providerId,
        )
      )
        return;
      this.rememberModelContextWindows(
        [
          providerId,
          providerId === activeProjection.activeProviderId
            ? this.provider?.baseUrl
            : undefined,
          refreshedPicker.selection === "session"
            ? this.session()?.provider
            : undefined,
        ],
        catalog,
        true,
      );
      const models = catalog
        .filter(
          (model, index, all) =>
            all.findIndex((candidate) => candidate.id === model.id) === index,
        )
        .map((model) => ({ ...model }));
      const providers                        = refreshedPicker.providers.map(
        (candidate) =>
          candidate.id === providerId
            ? {
                ...candidate,
                catalogStatus: models.length ? "ready" : "unavailable",
                models,
              }
            : candidate,
      );
      if (refreshedPicker.providerId !== providerId) {
        this.modelPicker = { ...refreshedPicker, providers };
        return;
      }
      const matches = modelPickerMatches(models, refreshedPicker.query);
      this.modelPicker = {
        ...refreshedPicker,
        providers,
        selected: Math.max(
          0,
          matches.findIndex(
            (model) =>
              model.id ===
              (refreshedPicker.selection === "session"
                ? this.session()?.model
                : providerId === this.modelProjection.activeProviderId
                  ? this.model
                  : undefined),
          ),
        ),
        modelWindowStart: undefined,
        catalogStatus: models.length ? "ready" : "unavailable",
        models,
      };
      if (!models.length)
        this.notice = "This provider has no available models.";
    } catch (error) {
      const currentPicker = this.modelPicker;
      if (
        generation !== this.modelPickerGeneration ||
        (pickerSessionId !== undefined && this.sessionId !== pickerSessionId) ||
        !currentPicker?.open ||
        !currentPicker.providers.some(
          (candidate) => candidate.id === providerId,
        )
      )
        return;
      const providers                        = currentPicker.providers.map(
        (candidate) =>
          candidate.id === providerId
            ? { ...candidate, catalogStatus: "unavailable", models: [] }
            : candidate,
      );
      const isStillSelected = currentPicker.providerId === providerId;
      this.modelPicker = {
        ...currentPicker,
        providers,
        ...(isStillSelected
          ? { catalogStatus: "unavailable"         , models: [] }
          : {}),
      };
      if (isStillSelected) {
        this.notice =
          error instanceof ProviderRequestError
            ? error.message
            : "Provider catalog unavailable. Check credentials or reconnect with /connect.";
      }
    } finally {
      this.pendingModelCatalogs.delete(pendingKey);
    }
  }
  async selectModel(modelId        ) {
    const picker = this.modelPicker;
    const generation = this.modelPickerGeneration;
    if (!picker?.open)
      throw new Error("Open /models before selecting a model.");
    if (
      !picker.providerId ||
      !picker.models.some((entry) => entry.id === modelId)
    )
      throw new Error("Model is not in the selected provider catalog.");
    if (picker.selection === "session") {
      const session = this.session();
      if (!session)
        throw new Error("The selected conversation is unavailable.");
      await this.workbench.selectSessionModel(session.id, modelId);
      if (generation === this.modelPickerGeneration) {
        this.closeModelPicker();
        this.notice = `This conversation now uses ${modelId}; other conversations keep their model.`;
      }
      return;
    }
    const provider = picker.providers.find(
      (candidate) => candidate.id === picker.providerId,
    );
    if (provider?.importSourceId) {
      this.provider = await importDesktopProvider(
        provider.importSourceId,
        this.env,
        this.workbench,
        modelId,
      );
    } else {
      await this.workbench.selectProviderModel(picker.providerId, modelId);
    }
    this.provider = await this.workbench.providerState({
      probeEnvironment: false,
    });
    this.modelProjection = this.workbench.providerModelsProjection();
    this.modelCatalogStatus =
      this.provider.connected && this.provider.models.length > 0
        ? "ready"
        : "unavailable";
    this.model = modelId;
    if (generation === this.modelPickerGeneration) {
      this.closeModelPicker();
      this.notice =
        "Future conversations use this model; active conversations keep their model.";
    }
  }
  cycleMode() {
    const previous = this.mode;
    const next =
      TUI_MODES[(TUI_MODES.indexOf(this.mode) + 1) % TUI_MODES.length] ;
    this.mode = next;
    this.modeBeforePlan = next === "plan" ? previous : undefined;
    this.notice =
      next === "plan"
        ? "Plan mode. Prompts ask for a plan before any tool runs."
        : next === "accept"
          ? "Accept mode. Shorter edit keys, approvals stay explicit."
          : "Normal mode. Every change and approval needs your key.";
  }
          setPlanMode() {
    if (this.mode !== "plan") this.modeBeforePlan = this.mode;
    this.mode = "plan";
    this.notice = "Plan mode. Prompts ask for a plan before any tool runs.";
  }
  togglePlanMode() {
    if (this.mode === "plan") {
      this.mode = this.modeBeforePlan ?? "normal";
      this.modeBeforePlan = undefined;
      this.notice =
        this.mode === "accept"
          ? "Accept mode restored. Tool approvals stay explicit."
          : "Normal mode restored. Every change and approval needs your key.";
      return;
    }
    this.setPlanMode();
  }
  queuePrompt(value                    ) {
    this.queuedPromptPaused = false;
    if (value === undefined) {
      this.queuedPrompt = null;
      this.notice = "Queued prompt cancelled.";
      return;
    }
    this.queuedPrompt = [...value].slice(0, 32000).join("");
    this.notice =
      "Run is active. The prompt is queued and sends when it stops.";
  }
  queueFollowUpPrompt(value        )          {
    if (!value.trim()) {
      this.notice = "Type a prompt before queueing it.";
      return false;
    }
    if (this.queuedPrompt !== null) {
      this.notice = this.queuedPromptPaused
        ? "A queued prompt is paused. Resume or cancel it before queueing another."
        : "A prompt is already queued. Restore or cancel it before queueing another.";
      return false;
    }
    this.queuePrompt(value);
    return true;
  }
  dequeueQueuedPrompt()                {
    if (!this.queuedPrompt) return null;
    if (this.queuedPromptPaused) {
      this.notice =
        "Queued prompt is paused after recovery. Reconcile the outcome, then use /queue resume.";
      return null;
    }
    const queued = this.queuedPrompt;
    this.queuedPrompt = null;
    this.notice = "Queued prompt restored to the composer.";
    return queued;
  }
          queueBlockedByRuntime() {
    return (
      this.workbench.running() ||
      this.workbench
        .runs()
        .some(
          (run) =>
            run.sessionId === this.sessionId &&
            ["unknown", "stopping", "paused"].includes(run.state),
        )
    );
  }
  takeQueued()                {
    if (
      !this.queuedPrompt ||
      this.confirmation ||
      this.queuedPromptPaused ||
      this.queueBlockedByRuntime()
    )
      return null;
    const next = this.queuedPrompt;
    this.queuedPrompt = null;
    return next;
  }
  /**
   * Raise a transient notice. Toasts carry events that would otherwise be
   * missed in the scrollback: a finished save, a dropped connector, a run
   * that stopped. Anything an operator must act on stays in the sticky
   * approval banner instead, because a toast can expire.
   */
  notify(
    id        ,
    tone                                                       ,
    message        ,
    ttl = DEFAULT_TOAST_LIMITS.defaultTtl,
  ) {
    this.toasts = raiseToast(
      this.toasts,
      {
        id,
        tone,
        message,
        icon: toastIcon(tone),
        at: Date.now(),
        ttl,
      },
      DEFAULT_TOAST_LIMITS,
    );
  }
  /**
   * Set the one line notice and raise a toast for the same event.
   *
   * The notice is overwritten by the next keystroke, so an event that matters
   * after the operator looks away needs a second home. The id is stable per
   * event kind, so repeating the event updates the existing toast rather than
   * stacking a new one on every keypress.
   *
   * A danger or pending tone gets ttl 0 and therefore never expires: an event
   * the operator has to act on must not be allowed to time out while they are
   * looking at something else.
   */
  announce(
    id        ,
    tone                                                       ,
    message        ,
  ) {
    this.notice = message;
    this.notify(
      id,
      tone,
      message,
      tone === "danger" || tone === "pending"
        ? 0
        : DEFAULT_TOAST_LIMITS.defaultTtl,
    );
  }
  /**
   * Every subsystem, checked, with the reason it is in that state.
   *
   * The point of this is a single answer to "is this workspace actually
   * working", which until now meant checking the provider here, the ledger
   * there, and connectors somewhere else, and noticing a corrupted ledger only
   * after a run had already failed on it.
   *
   * A check that could not run is reported as unknown and never as ok. A panel
   * that says a subsystem it could not reach is healthy turns an absence of
   * information into an assurance, which is strictly worse than no panel.
   */
  healthChecks()          {
    const checks          = [];
    const add = (
      name        ,
      area        ,
      state             ,
      detail        ,
      remedy         ,
    ) => checks.push({ name, area, state, detail, remedy });

    // Provider. It is undefined only when providerState threw, and that is
    // exactly the case that must not read as fine.
    if (!this.provider) {
      add(
        "provider",
        "runtime",
        "unknown",
        "Provider state has not been read yet.",
        "Run /connect, or r to retry.",
      );
    } else {
      const connected = this.provider.connected;
      const status = this.provider.status;
      const setupRequired = status === "setup-required";
      const rateLimited = status === "rate-limited";
      const detail =
        status === "ready"
          ? `Connected to ${this.provider.providerId ?? "a provider"}.`
          : `${status}: ${this.provider.detail ?? (setupRequired ? "No provider credential is configured." : "Provider is not ready.")}${this.provider.retryAt ? ` Retry at ${this.provider.retryAt}.` : ""}`;
      add(
        "provider",
        "runtime",
        status === "ready" && connected
          ? "ok"
          : setupRequired || rateLimited
            ? "warn"
            : "fail",
        detail,
        setupRequired
          ? "Run /connect to show credential setup."
          : rateLimited
            ? "Retry when the provider rate limit clears."
            : status === "unavailable"
              ? "Review the configured credential and endpoint; confirm provider availability before retrying."
              : connected
                ? undefined
                : "Run /connect to attach one.",
      );
      const models = this.provider.models?.length ?? 0;
      add(
        "models",
        "runtime",
        connected && models === 0 ? "warn" : "ok",
        connected
          ? models === 0
            ? "Connected, but no model is listed."
            : `${models} model(s) available.`
          : "Not listed until a provider is connected.",
        connected && models === 0
          ? "Reconnect to refresh the model list."
          : undefined,
      );
    }

    // Ledger. A proof error is the one failure that invalidates recovery and
    // export, so it is a fail and not a warn.
    if (this.proofErrors.size) {
      for (const [id, error] of this.proofErrors)
        add(
          `ledger ${id.slice(0, 8)}`,
          "records",
          "fail",
          error,
          "Run /verify, then /rewind to inspect what the chain lost.",
        );
    } else if (this.managedVerificationStatus) {
      add(
        "ledger",
        "records",
        this.managedVerificationStatus.startsWith("verified") ||
          /verified/i.test(this.managedVerificationStatus)
          ? "ok"
          : "warn",
        `Hash chain ${this.managedVerificationStatus}.`,
        this.managedVerificationNote,
      );
    } else {
      add(
        "ledger",
        "records",
        "unknown",
        "No managed workspace has been verified yet.",
        "Run /verify.",
      );
    }

    // Runs needing reconciliation are work that stopped without a decision.
    const stuck = this.workbench.runs().filter((run) => run.reconcileRequired);
    add(
      "runs",
      "records",
      stuck.length ? "warn" : "ok",
      stuck.length
        ? `${stuck.length} run(s) need reconciliation.`
        : "No run needs reconciliation.",
      stuck.length ? "Open /runs to decide each one." : undefined,
    );

    // Connectors, by consent state. An unconfirmed connector is skipped, not
    // failed: it has not been asked for anything yet.
    const connectors = this.workbench.connectionState().connectors;
    const unconfirmed = connectors.filter(
      (c) => "consentState" in c && c.consentState !== "confirmed",
    );
    add(
      "connectors",
      "integrations",
      unconfirmed.length ? "warn" : "ok",
      connectors.length
        ? `${connectors.length} connector(s), ${unconfirmed.length} not confirmed.`
        : "No connector configured.",
      unconfirmed.length ? "Confirm the ones you intend to use." : undefined,
    );

    // Workspace storage. An init that never ran is the difference between a
    // workspace that survives a restart and one that does not.
    const storage = this.workbench.allViews().length;
    add(
      "storage",
      "runtime",
      storage ? "ok" : "warn",
      storage
        ? `${storage} workspace view(s) on disk.`
        : "No workspace view has been created.",
      storage ? undefined : "Run /init to set up workspace storage.",
    );

    return checks;
  }
  /**
   * The health panel body, plus a line saying which way to read it.
   *
   * The summary comes first because a panel an operator has to read to the
   * bottom before finding out whether anything is wrong is a panel they will
   * not open twice.
   */
  healthLines()           {
    const checks = this.healthChecks();
    return [
      ...renderHealth(checks, 72, {
        motion: motionContext(this.frame),
      }),
      "",
      healthSummary(checks),
    ];
  }
  /**
   * Fold or unfold the group under the cursor in a Sessions or Documents tree.
   *
   * Returns false when there is no tree or no folder at the cursor, so the
   * caller falls back to the normal arrow behaviour. Returning true only
   * when a folder actually moved is what keeps the arrows meaning one thing
   * at a time.
   */
  collapseOrExpand(open         )          {
    const tree = this.groupTree;
    if (!tree) return false;
    const visible = flattenTree(tree.nodes, tree.state);
    const node = visible[tree.state.cursor];
    if (!node?.hasChildren) return false;
    tree.state = toggleTreeNode(tree.state, node.id, tree.nodes);
    this.notice = `${open ? "Opened" : "Collapsed"} ${node.label}.`;
    return true;
  }
  /** Activate the visible tree cursor: expand groups or select their leaf row. */
  activateTreeCursor()                              {
    const tree = this.groupTree;
    if (!tree) return undefined;
    const node = flattenTree(tree.nodes, tree.state)[tree.state.cursor];
    if (!node) return undefined;
    if (node.hasChildren) {
      this.collapseOrExpand(!tree.state.expanded.has(node.id));
      this.detail = undefined;
      this.documentPreview = false;
      this.scroll = 0;
      return "group";
    }
    const selected = this.items().findIndex((row) => row.id === node.id);
    if (selected < 0) return undefined;
    this.selected = selected;
    return "row";
  }
  /**
   * Move the Sessions or Documents tree cursor. Returns false when there is
   * no tree, so the caller falls back to moving through the flat item list.
   */
  moveTreeCursor(delta        )          {
    const tree = this.groupTree;
    if (!tree) return false;
    tree.state = moveTree(tree.state, delta, tree.nodes);
    this.syncTreeCursorSelection();
    return true;
  }
  /** Page a tree without wrapping, matching OMP's selector paging. */
  moveTreeCursorByPage(direction        , pageSize        )          {
    const tree = this.groupTree;
    if (!tree) return false;
    const visible = flattenTree(tree.nodes, tree.state);
    if (!visible.length) return true;
    tree.state = {
      ...tree.state,
      cursor: Math.max(
        0,
        Math.min(
          visible.length - 1,
          tree.state.cursor + direction * Math.max(1, pageSize),
        ),
      ),
    };
    this.syncTreeCursorSelection();
    return true;
  }
  /** Put the grouped selector cursor on an exact visible row, as a mouse hit does. */
  selectTreeCursor(index        )          {
    const tree = this.groupTree;
    if (!tree) return false;
    const visible = flattenTree(tree.nodes, tree.state);
    if (!visible.length) return true;
    tree.state = {
      ...tree.state,
      cursor: Math.max(0, Math.min(visible.length - 1, index)),
    };
    this.syncTreeCursorSelection();
    return true;
  }
          syncTreeCursorSelection()       {
    const tree = this.groupTree;
    if (!tree) return;
    const visible = flattenTree(tree.nodes, tree.state);
    const node = visible[tree.state.cursor];
    const selected = node?.hasChildren
      ? -1
      : this.items().findIndex((row) => row.id === node?.id);
    if (selected >= 0) this.selected = selected;
    // Live document preview: when cursor lands on a document (leaf), show
    // a preview in the detail pane without requiring Enter. The operator
    // can scan documents with arrow keys and see content instantly.
    if (this.tab === "documents") {
      this.detail = undefined;
      this.documentPreview = false;
      if (node && !node.hasChildren && node.id) {
        const separator = node.id.indexOf(":");
        const sessionId = separator < 0 ? "" : node.id.slice(0, separator);
        const path = separator < 0 ? "" : node.id.slice(separator + 1);
        if (sessionId && path) {
          const doc = this.workbench.document(sessionId, path);
          if (doc) {
            this.documentPreview = true;
            const preview = doc.content
              ? doc.content.split("\n").slice(0, 20).join("\n")
              : "(empty)";
            this.detail = [
              ...renderInspector(
                {
                  title: path,
                  subtitle: `${sessionId.slice(0, 8)} · ${doc.bytes} B`,
                  icon: ROW_ICONS.document,
                  sections: [
                    {
                      title: "preview (first 20 lines)",
                      fields: [
                        {
                          label: "content",
                          value: preview,
                          tone: "muted",
                        },
                      ],
                    },
                  ],
                  hint: "Up/Down moves through files. PageUp/Down or Left/Right pages the tree. Enter toggles folders. /document path opens it.",
                },
                { width: this.layoutColumns },
              ),
            ];
            this.scroll = 0;
          }
        }
      } else {
        this.detail = undefined;
        this.documentPreview = false;
        this.scroll = 0;
      }
    }
  }
  /** Move a grouped tree to its first or last currently visible row. */
  moveTreeCursorToBoundary(end         )          {
    const tree = this.groupTree;
    if (!tree) return false;
    const visible = flattenTree(tree.nodes, tree.state);
    if (!visible.length) return true;
    tree.state = { ...tree.state, cursor: end ? visible.length - 1 : 0 };
    this.syncTreeCursorSelection();
    return true;
  }
  /**
   * Announce holds that are about to close, or already have.
   *
   * An expired approval cannot release its tool, so silence is the one
   * response that is actively misleading: the operator sees a pending row,
   * presses the key, and only then learns the window closed. Keyed by hold id
   * so one hold raises one notice that updates in place, rather than a new
   * line on every refresh tick.
   *
   * Sticky in both cases. A hold closing in twenty seconds and one that
   * closed a minute ago are both things the operator has to see, and neither
   * should time out while they are looking somewhere else.
   */
  watchHoldsForExpiry(now = Date.now()) {
    for (const hold of this.workbench.pending()) {
      const left = holdSecondsLeft(hold                          , now);
      if (left === null) continue;
      const tool = String(
        (hold.call                                  )?.tool ?? "tool",
      );
      if (left <= 0) {
        this.notify(
          `expiry:${hold.holdId}`,
          "danger",
          `Approval for ${tool} expired. It can no longer release the tool.`,
          0,
        );
        continue;
      }
      if (left <= EXPIRY_WARNING_SECONDS)
        this.notify(
          `expiry:${hold.holdId}`,
          "warning",
          `Approval for ${tool} closes in ${left}s.`,
          0,
        );
    }
  }

  /** Drop expired toasts. A sticky one survives any amount of elapsed time. */
  expireToasts(now = Date.now()) {
    this.toasts = expireToasts(this.toasts, now);
  }
  /**
   * Whether the visible detail is still the keybinding table.
   *
   * Checked against the rendered content rather than trusted from the flag
   * alone, because several command paths replace detail with something else
   * without knowing a flag exists. A stale flag would make ordinary typing
   * filter a table that is no longer on screen, and the keystrokes would
   * vanish with nothing to show for it.
   */
  get showingKeybindings()          {
    return (
      this.keybindingDetail && !!this.detail?.[0]?.startsWith("KEYBINDINGS")
    );
  }
  /**
   * Re-render the keybinding table after the query changes, or after the
   * terminal changed width. The table is sized to the terminal rather than to
   * a constant, because a fixed width truncates the action column on a wide
   * terminal and wastes the space on a narrow one.
   */
  refreshKeybindings(width = 72) {
    this.detail = keybindingLines(this.keybindingQuery, width);
    this.keybindingWidth = width;
    this.scroll = 0;
  }
  /**
   * True while the cheat sheet is the visible detail.
   *
   * The flag is checked together with a content test, same as the keybinding
   * table. Roughly a dozen command paths replace detail with something else
   * without knowing an overlay flag exists, and a stale flag would leave the
   * ordinary typing keys filtering a sheet nobody can see.
   */
  get showingCheatSheet()          {
    return (
      this.cheatSheet && this.detail?.[0]?.startsWith("? Cheat sheet") === true
    );
  }
  /**
   * Which bindings apply right now.
   *
   * The context is read from published fields rather than passed in, because
   * the runner knows the keyboard state and the model knows what is on screen,
   * and neither of them alone can answer "which keys work now".
   */
  liveBindings() {
    return bindingsFor({
      editing: this.editingInput,
      running: this.session()?.status === "running",
      suspendSupported: process.platform !== "win32",
      queued: !!this.queuedPrompt && !this.queuedPromptPaused,
      retryable: this.canRetryLastTurn(),
      reviewing: !!this.diffView || !!this.confirmation,
      backable:
        this.cheatSheet ||
        this.keybindingDetail ||
        (this.tab !== "chat" && !!this.detail) ||
        !!this.filter ||
        !!this.palette ||
        this.modelPicker?.open === true,
      tab: this.tab,
    });
  }
  canRetryLastTurn()          {
    const session = this.session();
    if (!session || session.status !== "failed") return false;
    let lastUserIndex = -1;
    for (let index = session.events.length - 1; index >= 0; index -= 1) {
      if (session.events[index]?.kind === "user") {
        lastUserIndex = index;
        break;
      }
    }
    return (
      lastUserIndex >= 0 &&
      session.events
        .slice(lastUserIndex + 1)
        .some((event) => event.kind === "error")
    );
  }
  /** Open the cheat sheet, optionally with a filter already typed. */
  openCheatSheet(query = "") {
    this.cheatSheet = true;
    this.cheatQuery = query;
    this.refreshCheatSheet();
  }
  /**
   * Close it and hand the frame back to whatever was on screen.
   *
   * The detail is dropped rather than restored, because nothing under it
   * changed while the sheet was open, so re-deriving it would cost a render
   * pass to produce a result identical to the one already in the body rows.
   */
  closeCheatSheet() {
    this.cheatSheet = false;
    this.cheatQuery = "";
    this.detail = undefined;
    this.scroll = 0;
    this.notice = "Cheat sheet closed.";
  }
  /** Re-lay the cheat sheet after a keystroke or a terminal width change. */
  refreshCheatSheet(width = 72) {
    const all = this.liveBindings();
    const shown = filterBindings(all, this.cheatQuery);
    this.detail = renderCheatSheet(
      { bindings: shown, query: this.cheatQuery },
      { width },
    );
    this.cheatWidth = width;
    this.scroll = 0;
  }
  reject() {
    if (!this.confirmation) return;
    this.confirmation = undefined;
    this.scroll = 0;
    this.notice = "Rejected. Nothing was applied.";
  }
  /** Previous user prompts of this conversation, most recent first. */
  promptHistory()           {
    return (this.session()?.events ?? [])
      .filter(
        (event) =>
          event.kind === "user" &&
          (!event.type || event.type === "message.completed"),
      )
      .map((event) => event.text)
      .reverse();
  }
  documentPaths()           {
    return [
      ...new Set(this.workbench.documentsList().map((item) => item.path)),
    ];
  }
  /** Transcript size and cumulative usage are not the model's context window. */
  contextNumbers() {
    const session = this.session();
    const events = session?.events ?? [];
    const messages = events.filter(
      (event) => event.kind === "user" || event.kind === "assistant",
    ).length;
    const usageEvents = events.filter((event) => event.kind === "usage");
    const known = usageEvents.some(
      (event) => typeof event.payload?.total_tokens === "number",
    );
    const tokens = usageEvents.reduce(
      (sum, event) =>
        sum +
        (typeof event.payload?.total_tokens === "number"
          ? (event.payload.total_tokens          )
          : 0),
      0,
    );
    let docs = 0;
    if (session) {
      try {
        docs = Object.keys(
          this.workbench.workspace(session.id).files ?? {},
        ).length;
      } catch {
        docs = 0;
      }
    }
    const contextMessages = session?.contextMessages ?? null;
    // The ceiling is the agent profile's own limit, not a guess. A meter drawn
    // against an invented maximum would report the context as half full when
    // the only honest answer is that no limit has been declared.
    const limit = session
      ? (this.workbench.agents().profiles.find((p) => p.maxContextTokens > 0)
          ?.maxContextTokens ?? null)
      : null;
    return {
      messages,
      contextMessages,
      tokens: known ? tokens : null,
      docs,
      contextUsed: known ? tokens : null,
      contextTokens: limit,
    };
  }
          redactSecrets(value        ) {
    let out = value;
    for (const key of [
      "TOKENHARBOR_API_KEY",
      "TOKENROUTER_API_KEY",
      "NVIDIA_API_KEY",
      "OPENROUTER_API_KEY",
      "NOMO_SIGNING_KEY",
      "NOMO_VERIFY_KEY",
      "NOMO_WORKSPACE_KEY",
    ]) {
      const secret = this.env[key];
      if (secret) out = out.split(secret).join("[redacted]");
    }
    return out;
  }
  async runShell(raw        ) {
    const cmd = raw.slice(1).trim();
    if (!cmd) throw Error("Usage: !command (local shell, 10 s limit)");
    if (SHELL_REFUSALS.some((re) => re.test(cmd)))
      throw Error(
        "Refused: the command references credentials or key material.",
      );
    this.activeShellCommands += 1;
    try {
      let out        ;
      try {
        // The shell is the operator's, so name it per platform rather than
        // assuming sh: on Windows there is no sh on PATH without Git Bash, which
        // made every !command fail with ENOENT. PATH stays narrowed on both
        // sides, because the point is to expose a small tool set and not the
        // operator's whole environment.
        const windows = process.platform === "win32";
        const shell = windows ? (process.env.ComSpec ?? "cmd.exe") : "sh";
        // cmd needs /c to run anything at all; /d only turns AutoRun off and
        // /s strips the surrounding quotes. Without /c it starts an interactive
        // prompt and the 10 s timeout is what ends it.
        const args = windows ? ["/d", "/s", "/c", cmd] : ["-c", cmd];
        const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
        const result = await runShellFile(shell, args, {
          env: windows
            ? {
                PATH: `${systemRoot}\\System32`,
                SystemRoot: systemRoot,
                ComSpec: shell,
              }
            : { PATH: "/usr/bin:/bin", LANG: "C" },
          timeout: 10000,
          maxBuffer: 1024 * 64,
        });
        const r = result                                      ;
        out = `${r.stdout ?? ""}` + (r.stderr ? `\n[stderr]\n${r.stderr}` : "");
      } catch (error) {
        const failed = error                                          ;
        const partial = `${failed.stdout ?? ""}${failed.stderr ?? ""}`.trim();
        throw Error(
          partial
            ? "Local command failed. Partial output stays out of the ledger."
            : `Local command failed. ${this.redactSecrets(message(error))}`,
        );
      }
      const shown = this.redactSecrets(out).slice(0, 4000) || "(no output)";
      this.detail = [
        `LOCAL SHELL, not stored in the ledger (exit 0): ${this.redactSecrets(cmd).slice(0, 120)}`,
        "",
        ...shown.split("\n"),
      ];
      this.scroll = 0;
      this.notice = "Shell output is shown once and never persisted.";
    } finally {
      this.activeShellCommands = Math.max(0, this.activeShellCommands - 1);
    }
  }
  /** @path tokens quote managed document content into the prompt. */
  expandMentions(prompt        , sessionId        ) {
    let paths = new Set        ();
    try {
      paths = new Set(
        Object.keys(this.workbench.workspace(sessionId).files ?? {}),
      );
    } catch {
      paths = new Set();
    }
    const missing           = [];
    const hasBinary = (path        ) => {
      const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
      return [".pdf", ".exe", ".dll", ".so", ".dylib", ".bin", ".dat"].includes(
        ext,
      );
    };
    const expanded = prompt.replace(
      /@([^\s@][^\s]*)/g,
      (token, path        ) => {
        if (!paths.has(path)) {
          if (!missing.includes(path)) missing.push(path);
          return token;
        }
        const doc = this.workbench.document(sessionId, path);
        const isBinary = hasBinary(path);
        if (isBinary) {
          return `${path} [binary file — capability check required]`;
        }
        return `${path} (quoted context):
${(doc.content ?? "").slice(0, 2000)}`;
      },
    );
    return { expanded, missing };
  }
  prepareCompact() {
    const session = this.session();
    if (!session) throw Error("Select a conversation to compact.");
    const lastSeq = session.events.at(-1)?.seq;
    this.confirmation = {
      title: `COMPACT CONTEXT ${session.title ?? session.id}?`,
      lines: [
        "This changes the context sent to the model on the next turn.",
        "The Workbench chooses which messages to retain and summarizes older context.",
        "The complete transcript, documents and signed ledger remain unchanged.",
        "Token savings are unknown. No provider summarization is promised.",
      ],
      apply: async () => {
        this.confirmation = undefined;
        if (this.workbench.get(session.id)?.events.at(-1)?.seq !== lastSeq)
          throw Error("The conversation changed. Request /compact again.");
        const result = this.workbench.compact(session.id);
        this.detail = [
          "CONTEXT COMPACTION RESULT",
          `Omitted messages: ${result.omittedMessageCount}`,
          `Created: ${result.createdAt}`,
          "Retained message IDs:",
          ...result.retainedMessageIds,
          "",
          "Summary:",
          result.summary || "No messages needed compaction.",
          "",
          "Transcript and ledger preserved. /context shows reported counts.",
        ];
        this.notice = result.omittedMessageCount
          ? "Context compacted. The next turn uses the retained context."
          : "Context unchanged. No messages needed compaction.";
      },
    };
    this.scroll = 0;
  }
  /**
   * Outstanding operations, newest last. /diff steps through this list one
   * operation at a time. The helper exists so /diff and /diff-next agree on
   * what "outstanding" means; a second definition would let them disagree and
   * show an index that does not exist.
   */
  openOperations() {
    if (!this.sessionId) return [];
    const ops = this.workbench.workspace(this.sessionId).operations;
    const undone = new Set(ops.flatMap((o) => (o.undoes ? [o.undoes] : [])));
    return ops.filter(
      (o) =>
        o.kind !== "undo" &&
        !undone.has(o.id) &&
        (!this.documentPath || o.path === this.documentPath),
    );
  }
  /**
   * Every operation in this workspace as recovery rows, settled ones included.
   *
   * openOperations answers "what can I still undo", which is the diff panel's
   * question. This answers "what happened to this workspace and what is still
   * open", which nobody could answer before. Same source, different filter,
   * and the reason for that filter is named rather than left in the reader.
   */
  recoveryRows()                {
    if (!this.sessionId) return [];
    const ops = this.workbench.workspace(this.sessionId).operations;
    const undone = new Set(ops.flatMap((o) => (o.undoes ? [o.undoes] : [])));
    return ops.map((o) => {
      const settled = o.kind === "undo" || undone.has(o.id);
      return {
        id: o.id,
        kind:
          o.kind === "undo"
            ? ("undo"         )
            : o.kind === "delete"
              ? ("delete"         )
              : ("edit"         ),
        path: o.path,
        seq: 0,
        // A decided operation is not something to act on. An operation still
        // open is recoverable, because the captured state is what makes it so.
        recoverable: settled
          ? o.kind === "undo"
            ? "already-undone"
            : "kept"
          : "recoverable",
        // The workspace record carries no timestamp and no reason. Both are
        // left undefined rather than derived: an age the terminal worked out
        // itself would not be the age the system recorded.
        at: undefined,
        undoesId: typeof o.undoes === "string" ? o.undoes : undefined,
      };
    });
  }
  /** The /diff panel body for the currently selected operation. */
  diffDetailLines(
    open            
                 
                   
                   
                             
                            
       ,
    width = Math.max(1, (this.viewport.width ?? 76) - 4),
    height = this.viewport.height,
  ) {
    const operation = open[this.diffIndex];
    if (!operation) {
      this.diffView = undefined;
      return ["No outstanding changes. Every edit is undone or kept."];
    }
    // The state is built once and kept, so j/k, space and s mutate a value
    // rather than re-deriving one. Rebuilding on every keypress would reset
    // the cursor and silently drop the staged flags the operator just set.
    this.diffView ??= buildDiffView(
      operation.before ?? "[does not exist]",
      operation.after ?? "[does not exist]",
    );
    return [
      `DIFF ${this.diffIndex + 1} of ${open.length}: ${operation.path} (${operation.kind} ${operation.id.slice(0, 8)})`,
      "",
      ...renderDiffPanel(this.diffView, width, height),
      "",
      "Esc closes diff review.",
      "/diff-next steps to the next outstanding operation.",
      "/undo ID for reviewed Undo of one operation.",
      "a sets all hunks staged; when all are staged, it clears them.",
    ];
  }
  /**
   * Re-render the diff panel from its state after a review key. The panel
   * keeps its cursor and staged flags because they live in diffView, not in
   * the lines that were printed.
   */
  rediff() {
    if (!this.diffView) return;
    this.detail = this.diffDetailLines(this.openOperations());
    // Cursor moves inside the body, so the scroll has to follow it or the
    // hunk the operator just moved to may be off screen.
    this.scroll = Math.max(0, this.detail.length - 1);
  }
  /**
   * The confirmation behind `/harness approve` and `/harness reject`.
   *
   * The operator sees the complete proposal before anything is decided: the
   * summary, the rationale, the expected outcome, the full digest, the cited
   * chain position and the exact diff. The approve path is the only one in
   * this file that changes the prompt every later conversation runs under,
   * so it is the one path that never acts on a list row or a bare command.
   */
  async prepareHarnessDecision(
    digestPrefix        ,
    decision                      ,
  ) {
    if (!this.sessionId) throw Error("Select a conversation.");
    if (!/^[a-f0-9]{8,64}$/.test(digestPrefix))
      throw Error("Enter at least 8 hexadecimal digest characters.");
    const pending = await this.workbench.pendingApprovalsFor(this.sessionId);
    const matches = pending.filter((proposal) =>
      proposal.digest.startsWith(digestPrefix),
    );
    if (matches.length !== 1)
      throw Error(
        matches.length > 1
          ? `Digest prefix ${digestPrefix} is ambiguous. Enter more characters.`
          : pending.length
            ? `No pending proposal starts with ${digestPrefix}. /harness lists them.`
            : "No Harness proposal is awaiting an operator decision.",
      );
    const match = matches[0] ;
    const sessionId = this.sessionId;
    // Proposal text is operator- and model-authored and lands in terminal
    // rows, so control characters are escaped before paint, not after.
    const proposalLines = escapeTerminalText(
      JSON.stringify(match.proposal, null, 2),
    ).split("\n");
    this.confirmation = {
      title: `${decision === "approve" ? "APPROVE" : "REJECT"} HARNESS PROPOSAL ${match.digest.slice(0, 8)}?`,
      lines: [
        decision === "approve"
          ? "This applies the exact proposal after checking its digest and provenance."
          : "This records rejection and activates none of the proposed edits.",
        "",
        `Summary: ${escapeTerminalText(match.summary)}`,
        `Rationale: ${escapeTerminalText(match.proposal.rationale)}`,
        `Expected outcome: ${escapeTerminalText(match.proposal.expectedOutcome)}`,
        `Full digest: ${match.digest}`,
        `Cited chain position: ${match.atSeq}.`,
        "",
        "Full proposal:",
        ...proposalLines,
        "",
        "This changes no policy, permissions, tool catalog, or credentials.",
      ],
      apply: async () => {
        this.confirmation = undefined;
        if (decision === "approve") {
          const result = await this.workbench.approveHarnessProposal(
            sessionId,
            match.digest,
          );
          this.notice = `Harness proposal approved: ${result.applied.length} edit(s) activated.`;
          this.detail = [
            "HARNESS PROPOSAL ACTIVATED",
            `Digest: ${match.digest}`,
            `Summary: ${escapeTerminalText(match.summary)}`,
            "The signed chain records the approval and activation.",
          ];
        } else {
          await this.workbench.rejectHarnessProposal(sessionId, match.digest);
          this.notice = `Harness proposal rejected: ${match.digest.slice(0, 8)}.`;
          this.detail = [
            "HARNESS PROPOSAL REJECTED",
            `Digest: ${match.digest}`,
            `Summary: ${escapeTerminalText(match.summary)}`,
            "The signed chain records the rejection. No edit was activated.",
          ];
        }
        await this.refresh(true);
      },
    };
    this.scroll = 0;
  }
  costLines() {
    const usage = activity(this.workbench.allViews());
    const lines = [
      "COST AND USAGE, provider reported, never estimated",
      "",
      `Sessions: ${usage.overview.sessions} | Runs: ${usage.overview.runs} | ` +
        `Records: ${usage.overview.usageRecords}`,
      `Total tokens: ${usage.overview.totalTokens ?? "unknown"} | Cost: unknown`,
      "",
    ];
    // The shape of the spend is the first thing an operator wants and a table
    // of twenty rows buries it. The sparkline reads from the data rather than
    // from zero, because a series that tripled still looks flat on a zero
    // baseline, and "flat" would be the wrong conclusion to draw from it.
    const recent = usage.usage.slice(-24);
    const totals = recent
      .map((record) => record.totalTokens)
      .filter((value)                  => typeof value === "number");
    if (totals.length > 1) {
      const sparkLabel =
        this.layoutColumns >= 30 ? "tokens per run  " : "tok/run ";
      const sparkWidth = Math.max(
        0,
        this.layoutColumns - visibleLength(sparkLabel),
      );
      lines.push(
        `${sparkLabel}${sparkline({ values: totals }, sparkWidth)}`,
        "  sparkline scaled to the series, not to zero",
        "",
      );
    }
    if (totals.length)
      lines.push(
        `peak ${Math.max(...totals)} tok / median ${median(totals)} tok`,
        // How the latest run compares with the one before it. The direction
        // is a word as well as a glyph, because an arrow is the only signal
        // for anyone who cannot see it.
        `latest vs previous  ${deltaLabel(
          totals[totals.length - 1] ?? 0,
          totals[totals.length - 2] ?? 0,
          { suffix: " tok" },
        )}`,
        "",
      );
    // A bar per run, newest first, because the most recent run is the one an
    // operator looks at. The number sits before the bar so a narrow terminal
    // truncates the fill rather than the measurement.
    if (totals.length > 1)
      lines.push(
        ...barChart(
          { values: totals.slice(-10) },
          Math.max(1, this.layoutColumns - 2),
        ).map((row) => "  " + row),
        "",
      );
    // Context pressure as a gauge, but only against a declared ceiling. A
    // gauge drawn against an invented maximum would report pressure where
    // the only honest answer is that no limit was declared.
    const context = this.contextNumbers();
    const limit = context.contextTokens;
    const used = context.contextUsed;
    if (typeof limit === "number" && limit > 0 && typeof used === "number")
      lines.push(
        `context  ${gauge(used, limit, { label: `${used} / ${limit}` })}`,
        "",
      );
    for (const record of recent.slice(-20))
      lines.push(
        `${record.sessionId.slice(0, 8)} ${record.model} ` +
          `in ${record.inputTokens ?? "?"} out ${record.outputTokens ?? "?"} ` +
          `total ${record.totalTokens ?? "unknown"}`,
      );
    if (!usage.usage.length)
      lines.push("No usage records yet. Send a prompt first.");
    return lines;
  }
  /**
   * The provider as one line, for the panes that have other things to say.
   *
   * The provider is one line here; /status owns the full inspector.
   */
  providerSummary()         {
    const provider = this.provider;
    const status = String(provider?.status ?? "unavailable");
    return `${providerStatusIcon(status)} Provider ${provider?.providerId ?? "unknown"} | ${status}`;
  }
  providerLines() {
    const provider = this.provider;
    // The provider is the single most common source of a run that silently
    // does nothing, and it used to be one loose line of text in a column of
    // many. As fields it is the thing an operator looks for by name, and the
    // status carries a tone rather than only a word.
    const status = String(provider?.status ?? "unavailable");
    const tone =
      status === "ready"
        ? "success"
        : status === "rate-limited"
          ? "warning"
          : status === "setup-required"
            ? "warning"
            : "error";
    return [
      ...renderInspector(
        {
          title: provider?.providerId ?? "unknown provider",
          subtitle: status,
          icon:
            tone === "success"
              ? ROW_ICONS.settled
              : tone === "error"
                ? ROW_ICONS.failed
                : ROW_ICONS.unknown,
          sections: [
            {
              title: "provider",
              fields: [
                {
                  label: "status",
                  value: status,
                  // Colour is decoration: the word says the same thing on a
                  // monochrome terminal and to a screen reader.
                  tone,
                },
                {
                  label: "model",
                  value: this.session()?.model || this.model || "not selected",
                },
                ...(provider?.retryAt
                  ? [{ label: "retry at", value: provider.retryAt }]
                  : []),
              ],
              body: provider?.detail ? [provider.detail] : [],
            },
            ...(provider?.status === "setup-required"
              ? [
                  {
                    title: "what to do",
                    fields: []         ,
                    body: [
                      "/connect shows credential setup.",
                      "Never type a key into the terminal.",
                    ],
                  },
                ]
              : []),
          ],
        },
        { width: this.layoutColumns },
      ),
    ];
  }
  statusLines() {
    const session = this.session();
    const usage = chatEventSummary(session?.events ?? []).usage;
    const tokens =
      typeof usage?.total_tokens === "number"
        ? String(usage.total_tokens)
        : "?";
    const cost =
      typeof usage?.cost === "number" ? `$${usage.cost.toFixed(4)}` : "?";
    const runs = this.workbench
      .runs()
      .filter((run) => run.sessionId === this.sessionId);
    const run =
      runs.find((item) => item.runId === session?.runId) ?? runs.at(-1);
    return [
      ...this.providerLines(),
      `Model: ${session?.model || this.model || "-"}`,
      `Usage: ${tokens} tokens | cost: ${cost}`,
      `State: ${run?.state ?? "unknown"}${run?.reconcileRequired ? " | reconciliation required" : ""}`,
      `Run: ${run?.state ?? "unavailable"}${run?.reconcileRequired ? " | reconciliation required" : ""}`,
      session ? "" : "No conversation selected.",
      `Conversations: ${this.workbench.list().length} | ` +
        `Pending: ${this.workbench.pending().length + this.proxy.holds.length}`,
      this.queuedPrompt
        ? this.queuedPromptPaused
          ? "One prompt is paused after recovery. Inspect /queue before resuming."
          : "One prompt is queued for the end of the run."
        : "No queued prompt.",
    ];
  }
  agentsLines() {
    const catalog = this.workbench.agents();
    const rows = [...this.workbench.list()].reverse();
    // An agent profile is a set of limits, and an operator checking one is
    // reading numbers, not prose. The system prompt stays last and bounded,
    // because it is the one field that is text rather than a limit.
    return [
      ...renderInspector(
        {
          title: "AGENTS",
          subtitle: `selected: ${this.agentId ?? "runtime default"}`,
          icon: ROW_ICONS.agent,
          sections: [
            {
              title: "runtime catalog",
              fields: catalog.agents.map((agent) => ({
                label: agent.id,
                value: agent.description,
                badge: agent.id === this.agentId ? "selected" : undefined,
                tone: agent.id === this.agentId ? "success" : "default",
              })),
            },
            {
              title: "profiles and their limits",
              fields: catalog.profiles.flatMap((profile) => [
                { label: profile.id, value: `policy ${profile.policyProfile}` },
                {
                  label: `  max turns`,
                  value: String(profile.maxTurns),
                },
                {
                  label: `  max context`,
                  value: `${profile.maxContextTokens} tokens`,
                },
                {
                  label: `  tools`,
                  value: profile.allowedTools.join(", ") || "none",
                  tone: profile.allowedTools.length ? "default" : "warning",
                },
              ]),
            },
            {
              title: "available policy profiles",
              fields: [
                {
                  label: "profiles",
                  value: catalog.policyProfiles.join(", ") || "none",
                },
              ],
            },
            {
              // The prompt is the one field that is text rather than a limit,
              // and this view names it as saveable, so not printing it left
              // the operator unable to check what a profile actually says to
              // the model. Bounded because a prompt is prose, and the marker
              // says it was cut rather than letting a truncated prompt read
              // as the whole one.
              title: "system prompts",
              fields: catalog.profiles.map((profile) => {
                const prompt = profile.systemPrompt.trim();
                return {
                  // The label keeps the field's own name. This view tells the
                  // operator that systemPrompt is saveable, so the row has to
                  // be findable by that word and not only by the profile id.
                  label: `System prompt / ${profile.id}`,
                  value: !prompt
                    ? "(empty)"
                    : prompt.length > 160
                      ? `${prompt.slice(0, 160)}… (+${prompt.length - 160} chars)`
                      : prompt,
                  tone: prompt ? ("default"         ) : ("warning"         ),
                };
              }),
            },
          ],
          hint: "/agent ID selects. Existing conversations keep their own snapshot.",
        },
        { width: this.layoutColumns },
      ),
      "",
      "Prompt text does not grant tool or policy authority.",
      "/agent-file path.json reviews a custom profile before saving.",
      "File fields: id, name, systemPrompt, allowedTools, policyProfile, maxTurns, maxContextTokens.",
      "",
      "CONVERSATIONS",
      ...(rows.length
        ? rows.map(
            (item) =>
              `${stateIcon(item.status)} [${item.status}] ${item.title ?? item.id} ${item.id.slice(0, 8)} ${item.model}${item.parentId ? ` [child of ${item.parentId.slice(0, 8)}]` : ""}`,
          )
        : ["No conversations yet."]),
      "",
      ...this.workbench
        .connectionState()
        .connectors.map(
          (item) =>
            `${ROW_ICONS.connector} connector: ${item.name} (${item.tools.length} tools)`,
        ),
    ];
  }
  memoryLines() {
    const views = this.workbench.allViews();
    const events = views.reduce((sum, item) => sum + item.events.length, 0);
    const drafts = this.workbench.documentsList().length;
    // This view listed two totals and four sentences. An operator opening it
    // wants to know what they have and where it is, so both are now said
    // plainly and the per-conversation breakdown follows.
    const byConversation = views
      .map((view) => ({ view, count: view.events.length }))
      .sort((a, b) => b.count - a.count);
    return [
      ...renderInspector(
        {
          title: "MEMORY",
          subtitle: "retained local history, encrypted at rest",
          icon: ROW_ICONS.learned,
          sections: [
            {
              title: "what is stored",
              fields: [
                { label: "conversations", value: String(views.length) },
                { label: "events", value: String(events) },
                { label: "managed documents", value: String(drafts) },
                {
                  label: "location",
                  value: this.env.NOMO_DATA_DIR ?? "~/.nomo/workbench",
                  tone: this.env.NOMO_DATA_DIR ? "default" : "warning",
                },
              ],
            },
            {
              title: "what is kept",
              fields: [],
              body: [
                "Drafts persist per conversation between runs.",
                "Conversations retain their provider and model snapshot.",
                "Unreported cost stays unknown rather than being estimated.",
                "Nothing is read from private cloud conversations.",
              ],
            },
          ],
        },
        { width: this.layoutColumns },
      ),
      "",
      "LARGEST CONVERSATIONS",
      ...(byConversation.length
        ? byConversation
            .slice(0, 10)
            .map(
              ({ view, count }) =>
                `  ${ROW_ICONS.session} ${view.id.slice(0, 8)} ${String(count).padStart(4)} events  ${view.status}`,
            )
        : ["  No conversations yet."]),
    ];
  }
  settingsControls()                    {
    const icons = getSymbols(this.themeConfig.symbolPreset).icons;
    const limits = harnessSettingsView(this.workbench.harnessSettings());
    const appearance                    = [
      {
        key: "terminal.color",
        group: "Appearance",
        label: "Terminal color",
        icon: icons.appearance,
        value:
          this.colorOverride === undefined
            ? this.env.NOMO_TUI_COLOR === "0"
              ? "off"
              : "on"
            : this.colorOverride
              ? "on"
              : "off",
        options: ["on", "off"],
        description:
          "Use terminal color when supported. NOMO_TUI_COLOR=0 overrides the saved preference and suppresses color.",
      },
      {
        key: "terminal.motion",
        group: "Appearance",
        label: "Motion effects",
        icon: icons.heartbeat,
        value:
          this.motionOverride === undefined
            ? this.env.NOMO_TUI_MOTION === "0" || this.env.TERM === "dumb"
              ? "off"
              : "on"
            : this.motionOverride
              ? "on"
              : "off",
        options: ["on", "off"],
        description:
          "Enable subtle motion effects. NOMO_TUI_MOTION=0 overrides the saved preference.",
      },
      {
        key: "theme.color",
        group: "Appearance",
        label: "Color theme",
        icon: icons.appearance,
        value: this.themeConfig.colorTheme,
        options: Object.keys(COLOR_THEMES),
        description:
          "Terminal foreground palette. Saved locally; NOMO_TUI_THEME overrides it. The terminal background stays inherited.",
      },
      {
        key: "theme.symbols",
        group: "Appearance",
        label: "Symbol set",
        icon: icons.appearance,
        value: this.themeConfig.symbolPreset,
        options: Object.keys(SYMBOL_SETS),
        description:
          "Semantic TUI glyphs. Saved locally; NOMO_TUI_SYMBOLS overrides it. Nerd needs a compatible patched font.",
      },
      {
        key: "chat.frame",
        group: "Appearance",
        label: "Composer surface",
        icon: icons.composer,
        value: this.chatPanelVisuals.frame,
        options: ["filled", "rounded", "square", "double"],
        description:
          "Choose the Chat composer surface. Rounded is the default and shows context on its top rail; filled, square and double remain available. No full-screen Chat frame is added.",
      },
      {
        key: "chat.density",
        group: "Appearance",
        label: "Chat spacing",
        icon: icons.context,
        value: this.chatPanelVisuals.density,
        options: ["comfortable", "compact"],
        description:
          "Choose spacing between transcript messages. Saved locally; NOMO_TUI_CHAT_DENSITY overrides it.",
      },
      {
        key: "chat.timestamps",
        group: "Appearance",
        label: "Message timestamps",
        icon: icons.time,
        value: this.chatPanelVisuals.timestamps ? "on" : "off",
        options: ["off", "on"],
        description:
          "Show or hide message timestamps. Saved locally; NOMO_TUI_CHAT_TIMESTAMPS overrides it.",
      },
      {
        key: "chat.composerHeightPx",
        group: "Appearance",
        label: "Composer height",
        icon: icons.composer,
        value: `${this.chatPanelVisuals.composerHeightPx} px`,
        number: this.chatPanelVisuals.composerHeightPx,
        min: MIN_CHAT_COMPOSER_HEIGHT_PX,
        max: MAX_CHAT_COMPOSER_HEIGHT_PX,
        description:
          "Target outer composer height in physical pixels. Converted to whole terminal cells; terminals without pixel metrics use a documented 24 px per row fallback. Saved locally; NOMO_TUI_CHAT_COMPOSER_HEIGHT_PX overrides it.",
      },
      {
        key: "tool.activity",
        group: "Appearance",
        label: "Tool activity",
        icon: icons.tool,
        value: this.hideToolActivity ? "hidden" : "visible",
        options: ["visible", "hidden"],
        description:
          "Show tool activity in the Chat transcript. Saved in local TUI state; Ctrl+Shift+O also toggles it.",
      },
    ];
    const interaction                    = [
      {
        key: "terminal.keybindings",
        group: "Interaction",
        label: "Workspace shortcuts",
        icon: icons.key,
        value: this.keybindingsOverride || "built-in defaults",
        description:
          "JSON object mapping supported actions to Ctrl+letter shortcuts. Blank restores defaults. Reserved and duplicate keys are rejected. Saved locally; NOMO_TUI_KEYBINDINGS overrides it.",
        text: true,
        maxLength: 512,
      },
    ];
    const harnessIconBySetting                                     = {
      maxTurns: "run",
      maxOutputTokens: "tokens",
      maxPromptCharacters: "composer",
      maxQueuedRuns: "queue",
      maxRequestBytes: "network",
      maxRunTimeoutMs: "time",
      maxToolCallsPerTurn: "tool",
      hookTimeoutMs: "hook",
      retryAttempts: "retry",
      retryBaseDelayMs: "retry",
      maxConcurrentRuns: "agent",
      maxContinuations: "run",
      maxRunTokens: "tokens",
      retryMaxDelayMs: "retry",
      contextEntryLimit: "context",
      contextCharsPerEntry: "context",
      refinementEnabled: "refinement",
      refinementTurnInterval: "refinement",
      refinementCooldownMs: "time",
      refinementLensCount: "refinement",
    };
    const runtime                    = limits.map((row) => ({
      key: row.key,
      group: "Harness",
      label: row.label,
      icon: icons[harnessIconBySetting[row.key] ?? "settings"],
      value:
        row.key === "refinementEnabled"
          ? row.value
            ? "on"
            : "off"
          : String(row.value),
      description: `${row.description} Consumer: ${row.consumer}.`,
      ...(row.key === "refinementEnabled"
        ? { options: ["off", "on"] }
        : { number: row.value, min: row.min, max: row.max }),
    }));
    const selections                    = harnessTextSettingsView(
      this.workbench.harnessTextSettings(),
    ).map((row) => ({
      key: row.key,
      group: row.key === "refinementModel" ? "Models and Providers" : "Harness",
      label: row.label,
      icon: icons.model,
      value: row.value || "inherit conversation model",
      description: `${row.description} Consumer: ${row.consumer}.`,
      text: true,
      maxLength: HARNESS_TEXT_SETTINGS[row.key].maxLength,
    }));
    return [...appearance, ...interaction, ...runtime, ...selections];
  }
  visibleSettingsControls()                    {
    const controls = this.settingsControls();
    const query = this.settingsQuery.trim();
    if (!query) return controls;
    return controls.filter(
      (control) =>
        fuzzyTextScore(query, [
          control.group,
          control.label,
          control.key,
          control.description,
        ]) !== undefined,
    );
  }
  settingsTextValue(key        )         {
    if (key === "terminal.keybindings") return this.keybindingsOverride ?? "";
    if (key === "refinementModel")
      return this.workbench.harnessTextSettings().refinementModel;
    return "";
  }
  settingsLines() {
    const controls = this.visibleSettingsControls();
    const symbols = getSymbols(this.themeConfig.symbolPreset);
    const icons = symbols.icons;
    const width = Math.max(1, this.layoutColumns);
    const trustedIcons = trustedLocalIconLabels(
      this.localTabIcons,
      this.themeConfig.colorTheme,
    );
    const fitSettingLine = (value        , limit = width) =>
      fitWithTrustedIcons(value, limit, trustedIcons);
    const iconoir = (key        , fallback        ) => {
      if (!this.localTabIcons || width < 48) return fallback;
      return (
        kittySemanticIconLabel(
          key,
          this.localTabIcons,
          this.themeConfig.colorTheme,
        ) ||
        (key === "models" || key === "tools" || key === "help"
          ? kittyTabIconLabel(
              key,
              this.localTabIcons,
              this.themeConfig.colorTheme,
            )
          : "") ||
        fallback
      );
    };
    const iconBySetting                                   = {
      "terminal.color": "appearance",
      "terminal.motion": "heartbeats",
      "theme.color": "appearance",
      "theme.symbols": "appearance",
      "chat.frame": "composer",
      "chat.density": "composer",
      "chat.timestamps": "timestamps",
      "chat.composerHeightPx": "composer",
      "tool.activity": "tools",
      "terminal.keybindings": "interaction",
      maxTurns: "run",
      maxOutputTokens: "context",
      maxPromptCharacters: "composer",
      maxQueuedRuns: "queue",
      maxRequestBytes: "network",
      maxRunTimeoutMs: "timeout",
      maxToolCallsPerTurn: "tools",
      hookTimeoutMs: "timeout",
      retryAttempts: "retry",
      retryBaseDelayMs: "retry",
      maxConcurrentRuns: "subagents",
      maxContinuations: "run",
      maxRunTokens: "context",
      retryMaxDelayMs: "retry",
      contextEntryLimit: "context",
      contextCharsPerEntry: "context",
      refinementEnabled: "refinement",
      refinementTurnInterval: "refinement",
      refinementCooldownMs: "timeout",
      refinementLensCount: "refinement",
      refinementModel: "models",
    };
    const selected = controls[this.settingsSelected] ?? controls[0];
    const groupIcons                                           = {
      Appearance: iconoir("appearance", icons.appearance),
      Interaction: iconoir("interaction", icons.key),
      "Models and Providers": iconoir("models", icons.model),
      Harness: iconoir("subagents", icons.agent),
    };
    const groupCounts = new Map                                  ();
    for (const control of controls)
      groupCounts.set(control.group, (groupCounts.get(control.group) ?? 0) + 1);
    const activeGroup = selected?.group;
    const settingsCategoryRail = activeGroup
      ? width >= 80
        ? (
            [
              "Appearance",
              "Interaction",
              "Models and Providers",
              "Harness",
            ]         
          )
            .map((group) => {
              const label =
                width >= 112
                  ? group.toUpperCase()
                  : group === "Appearance"
                    ? "VISUALS"
                    : group === "Interaction"
                      ? "INPUT"
                      : group === "Models and Providers"
                        ? "MODELS"
                        : "LIMITS";
              return `${activeGroup === group ? "›" : " "} ${groupIcons[group]} ${label} ${groupCounts.get(group) ?? 0}`;
            })
            .join("  ·  ")
        : `${groupIcons[activeGroup]} ${activeGroup.toUpperCase()} · ${groupCounts.get(activeGroup) ?? 0} settings`
      : "No settings match this filter.";
    const selectedDescription = selected
      ? `${iconoir("help", icons.help)} ${selected.description}${
          selected.number !== undefined
            ? ` Range: ${selected.min}–${selected.max}; use ←/→ or Enter to edit.`
            : selected.text
              ? selected.key === "terminal.keybindings"
                ? ` Maximum ${selected.maxLength} characters; Enter saves valid JSON, or leave empty for built-in shortcuts.`
                : ` Maximum ${selected.maxLength} characters; Enter saves, or leave empty to inherit the conversation model.`
              : ""
        }`
      : "";
    // Settings rows keep one physical line at every terminal width. Details
    // are clipped in-place instead of wrapping into the next control row.
    const selectedDescriptionLines = selected
      ? [fitSettingLine(selectedDescription)]
      : [""];
    const actionHelp =
      width >= 80
        ? "↑/↓ select · ←/→ change · Enter edit/save · Space apply · type filter · Esc clear/back"
        : width >= 64
          ? "↑/↓ select · ←/→ change · Enter/Space apply · type filter"
          : width >= 48
            ? "↑↓ select · ←→ set · Enter/Space apply"
            : width >= 32
              ? "↑↓ move · ←→ set · Enter/Space"
              : "↑↓ move · Enter apply";
    const navigationHelp = this.settingsQuery
      ? width >= 80
        ? "Ctrl+←/→ filter cursor · Home/End select · PgUp/PgDn · click · double-click apply · wheel · Esc clear"
        : width >= 64
          ? "Ctrl+←/→ filter cursor · Esc clears filter"
          : width >= 48
            ? "Ctrl←/→ filter cursor · Esc clears filter"
            : "Ctrl←/→ cursor · Esc clear"
      : width >= 80
        ? "Ctrl+←/→ groups · Home/End · PgUp/PgDn · click select · double-click apply · wheel"
        : width >= 64
          ? "Ctrl+←/→ groups · Home/End · PgUp/PgDn · wheel"
          : width >= 48
            ? "Type filter · Esc back · Ctrl+←/→ groups"
            : width >= 32
              ? "Type · Esc · Ctrl←/→ groups"
              : "←→ set · Esc filter";
    this.settingsRowLines = [];
    const lines = [
      fitSettingLine(
        `${iconoir("settings", icons.settings)} SETTINGS · ${controls.length ? this.settingsSelected + 1 : 0}/${controls.length} · ${selected?.group.toUpperCase() ?? "NO MATCHES"}`,
      ),
      fitSettingLine(settingsCategoryRail),
      fitSettingLine(
        `${iconoir("search", icons.search)} ${
          this.settingsQuery
            ? settingsCursorWindow(
                this.settingsQuery,
                this.settingsQueryCursor,
                Math.max(
                  1,
                  width - visibleLength(iconoir("search", icons.search)) - 1,
                ),
              )
            : "> Type to filter settings…"
        }`,
      ),
      fitSettingLine(actionHelp),
      fitSettingLine(navigationHelp),
      ...(selected ? [] : [fitSettingLine("No settings match this filter.")]),
      ...selectedDescriptionLines,
    ];
    for (const [index, control] of controls.entries()) {
      if (index === 0 || control.group !== controls[index - 1] .group)
        lines.push(
          ...(index > 0 ? [""] : []),
          fitSettingLine(
            `${groupIcons[control.group]} ${control.group.toUpperCase()} · ${groupCounts.get(control.group) ?? 0}`,
          ),
        );
      // Keep the focus marker independent of the optional Nerd Font preset.
      // A private-use glyph can disappear on terminals without that font.
      const prefix = `${index === this.settingsSelected ? ">" : " "} ${iconoir(iconBySetting[control.key] ?? "", control.icon)} `;
      const edit =
        this.settingsEdit?.key === control.key ? this.settingsEdit : undefined;
      const shownValue = edit
        ? `${this.settingsEdit .draft.slice(0, this.settingsEdit .cursor)}▏${this.settingsEdit .draft.slice(this.settingsEdit .cursor)}`
        : control.value;
      const value = control.options
        ? `‹ ${shownValue} ›`
        : edit
          ? `[${shownValue}]`
          : `= ${control.value}`;
      this.settingsRowLines.push(lines.length);
      if (width < 48) {
        const compactValue =
          edit && control.text
            ? `[${settingsCursorWindow(
                edit.draft,
                edit.cursor,
                Math.max(1, Math.floor((width - visibleLength(prefix)) / 3)),
              )}]`
            : edit
              ? shownValue
              : control.value;
        const remainingWidth = Math.max(1, width - visibleLength(prefix));
        const separatorWidth = remainingWidth > 1 ? 1 : 0;
        const labelWidth = Math.min(
          visibleLength(control.label),
          Math.max(
            1,
            Math.min(
              remainingWidth - separatorWidth,
              Math.ceil((remainingWidth - separatorWidth) * 0.62),
            ),
          ),
        );
        const valueWidth = Math.max(
          0,
          remainingWidth - labelWidth - separatorWidth,
        );
        lines.push(
          fitSettingLine(
            `${prefix}${fit(control.label, labelWidth)}${
              valueWidth
                ? `${separatorWidth ? " " : ""}${fit(compactValue, valueWidth)}`
                : ""
            }`,
          ),
        );
      } else if (edit && control.text) {
        const labelWidth = Math.min(
          visibleLength(control.label),
          Math.max(1, Math.floor((width - visibleLength(prefix)) / 3)),
        );
        const editorWidth = Math.max(
          1,
          width - visibleLength(prefix) - labelWidth - 3,
        );
        lines.push(
          fitSettingLine(
            `${prefix}${fit(control.label, labelWidth)} [${settingsCursorWindow(edit.draft, edit.cursor, editorWidth)}]`,
          ),
        );
      } else {
        const labelWidth = Math.max(
          1,
          width - visibleLength(prefix) - visibleLength(value) - 1,
        );
        lines.push(
          fitSettingLine(`${prefix}${fit(control.label, labelWidth)} ${value}`),
        );
      }
    }
    lines.push(
      "",
      "Appearance and shortcut choices save locally; explicit NOMO_TUI_* values override them.",
      "Tool visibility saves in local TUI state. Harness settings save in the local Workbench store.",
    );
    return lines;
  }
  refreshSettingsPanel() {
    this.settingsOpen = true;
    this.settingsSelected = Math.max(
      0,
      Math.min(
        this.settingsSelected,
        this.visibleSettingsControls().length - 1,
      ),
    );
    this.detail = this.settingsLines();
  }
  selectSetting(index        ) {
    const controls = this.visibleSettingsControls();
    if (!controls.length) {
      this.settingsSelected = 0;
      this.detail = this.settingsLines();
      return;
    }
    const next = Math.max(0, Math.min(controls.length - 1, index));
    if (next !== this.settingsSelected && this.settingsEdit) {
      this.settingsEdit = undefined;
      this.notice = "Setting edit cancelled.";
    }
    this.settingsSelected = next;
    this.hoveredRow = undefined;
    this.detail = this.settingsLines();
    const line = this.settingsRowLines[this.settingsSelected] ?? 0;
    const height = Math.max(1, this.viewport.height);
    if (line < this.scroll) this.scroll = line;
    else if (line >= this.scroll + height) this.scroll = line - height + 1;
  }
  applySetting(key        , raw        ) {
    const value = raw.toLowerCase();
    if (key === "terminal.color") {
      if (value !== "on" && value !== "off")
        throw Error("Terminal color accepts on or off.");
      this.colorOverride = value === "on";
      this.notice =
        value === "off"
          ? "Terminal color is off and saved locally. An explicit NOMO_TUI_COLOR value overrides it on the next launch."
          : "Terminal color is on and saved locally. An explicit NOMO_TUI_COLOR value overrides it on the next launch.";
    } else if (key === "terminal.motion") {
      if (value !== "on" && value !== "off")
        throw Error("Motion effects accept on or off.");
      this.motionOverride = value === "on";
      this.notice =
        value === "off"
          ? "Motion effects are off and saved locally. NOMO_TUI_MOTION=0 overrides them on the next launch."
          : "Motion effects are on and saved locally. NOMO_TUI_MOTION=0 overrides them on the next launch.";
    } else if (key === "theme.color") {
      if (!Object.hasOwn(COLOR_THEMES, value))
        throw Error(`Unknown color theme: ${raw}.`);
      this.themeConfig = {
        ...this.themeConfig,
        colorTheme: value              ,
      };
      this.notice = `Color theme ${value} saved locally. NOMO_TUI_THEME overrides it on the next launch.`;
    } else if (key === "theme.symbols") {
      if (!Object.hasOwn(SYMBOL_SETS, value))
        throw Error(`Unknown symbol set: ${raw}.`);
      this.themeConfig = {
        ...this.themeConfig,
        symbolPreset: value                ,
      };
      this.notice = `Symbol set ${value} saved locally. NOMO_TUI_SYMBOLS overrides it on the next launch.`;
    } else if (key === "chat.frame") {
      if (!(
        value === "filled" ||
        value === "rounded" ||
        value === "square" ||
        value === "double"
      ))
        throw Error(
          "Composer surface accepts filled, rounded, square or double.",
        );
      this.chatPanelVisuals = { ...this.chatPanelVisuals, frame: value };
      this.notice = `Composer surface ${value} saved locally. NOMO_TUI_CHAT_FRAME overrides it on the next launch.`;
    } else if (key === "chat.density") {
      if (!(value === "comfortable" || value === "compact"))
        throw Error("Chat spacing accepts comfortable or compact.");
      this.chatPanelVisuals = { ...this.chatPanelVisuals, density: value };
      this.notice = `Chat spacing ${value} saved locally. NOMO_TUI_CHAT_DENSITY overrides it on the next launch.`;
    } else if (key === "chat.timestamps") {
      if (!(value === "on" || value === "off"))
        throw Error("Message timestamps accept on or off.");
      this.chatPanelVisuals = {
        ...this.chatPanelVisuals,
        timestamps: value === "on",
      };
      this.notice = `Message timestamps ${value} saved locally. NOMO_TUI_CHAT_TIMESTAMPS overrides them on the next launch.`;
    } else if (key === "chat.composerHeightPx") {
      const height = Number(raw);
      if (
        !Number.isSafeInteger(height) ||
        height < MIN_CHAT_COMPOSER_HEIGHT_PX ||
        height > MAX_CHAT_COMPOSER_HEIGHT_PX
      )
        throw Error(
          `Composer height must be a whole number from ${MIN_CHAT_COMPOSER_HEIGHT_PX} to ${MAX_CHAT_COMPOSER_HEIGHT_PX} pixels.`,
        );
      this.chatPanelVisuals = {
        ...this.chatPanelVisuals,
        composerHeightPx: height,
      };
      this.notice = `Composer height ${height} px saved locally. NOMO_TUI_CHAT_COMPOSER_HEIGHT_PX overrides it on the next launch.`;
    } else if (key === "tool.activity") {
      if (!(value === "visible" || value === "hidden"))
        throw Error("Tool activity accepts visible or hidden.");
      this.hideToolActivity = value === "hidden";
      this.notice = `Tool activity is now ${value}.`;
    } else if (key === "terminal.keybindings") {
      const candidate = raw.trim();
      const parsed = parseWorkspaceKeybindings(candidate || undefined);
      if (parsed.error)
        throw Error(
          parsed.error.replace(/^NOMO_TUI_KEYBINDINGS ignored: /, ""),
        );
      this.keybindingsOverride = candidate || undefined;
      this.notice = candidate
        ? "Workspace shortcuts saved locally and applied. NOMO_TUI_KEYBINDINGS overrides them on the next launch."
        : "Built-in workspace shortcuts restored and saved locally.";
    } else if (Object.hasOwn(HARNESS_TEXT_SETTINGS, key)) {
      const stored = this.workbench.patchHarnessTextSettings({ [key]: raw });
      const applied = harnessTextSettingsView(stored).find(
        (row) => row.key === key,
      );
      this.notice = `${applied?.label ?? key} is now ${applied?.value || "inherited from the conversation"}.`;
    } else if (key === "refinementEnabled") {
      if (!(
        value === "on" ||
        value === "off" ||
        value === "1" ||
        value === "0"
      ))
        throw Error("Harness refinement accepts on or off.");
      const stored = this.workbench.patchHarnessSettings({
        refinementEnabled: value === "on" || value === "1" ? 1 : 0,
      });
      const applied = harnessSettingsView(stored).find(
        (row) => row.key === key,
      );
      this.notice = `${applied?.label ?? key} is now ${stored.refinementEnabled ? "on" : "off"}.`;
    } else {
      if (!Object.hasOwn(HARNESS_SETTINGS, key))
        throw Error(
          `Unknown setting: ${key}. Use /settings to browse supported values.`,
        );
      const numeric = Number(raw);
      if (!Number.isFinite(numeric))
        throw Error(`/settings ${key}: ${raw} is not a number.`);
      const stored = this.workbench.patchHarnessSettings({ [key]: numeric });
      const applied = harnessSettingsView(stored).find(
        (row) => row.key === key,
      );
      this.notice = `${applied?.label ?? key} is now ${applied?.value ?? numeric}.`;
    }
    this.refreshSettingsPanel();
  }
  adjustSetting(direction        , multiplier = 1) {
    const control = this.visibleSettingsControls()[this.settingsSelected];
    if (!control) return;
    if (control.options?.length) {
      const index = control.options.indexOf(control.value);
      const next =
        (index + direction + control.options.length) % control.options.length;
      this.applySetting(control.key, control.options[next] );
      return;
    }
    if (control.text) {
      const value = this.settingsTextValue(control.key);
      this.settingsEdit = {
        key: control.key,
        draft: value,
        cursor: value.length,
      };
      this.detail = this.settingsLines();
      this.notice = `Edit ${control.label}; Enter saves, Esc cancels.`;
      return;
    }
    if (
      control.number === undefined ||
      control.min === undefined ||
      control.max === undefined
    )
      return;
    if (control.min === control.max) {
      this.notice = `${control.label} is fixed at ${control.value} by the active run contract.`;
      return;
    }
    const span = control.max - control.min;
    const step =
      span >= 100_000 ? 1_000 : span >= 10_000 ? 100 : span >= 1_000 ? 10 : 1;
    const next = Math.max(
      control.min,
      Math.min(control.max, control.number + direction * step * multiplier),
    );
    this.applySetting(control.key, String(next));
  }
  activateSetting() {
    const control = this.visibleSettingsControls()[this.settingsSelected];
    if (!control) return;
    if (control.options?.length) {
      this.adjustSetting(1);
      return;
    }
    if (control.text) {
      const value = this.settingsTextValue(control.key);
      this.settingsEdit = {
        key: control.key,
        draft: value,
        cursor: value.length,
      };
      this.detail = this.settingsLines();
      this.notice = `Edit ${control.label}; Enter saves, Esc cancels.`;
      return;
    }
    if (
      control.number === undefined ||
      control.min === undefined ||
      control.max === undefined
    )
      return;
    if (control.min === control.max) {
      this.notice = `${control.label} is fixed at ${control.value} by the active run contract.`;
      return;
    }
    this.settingsEdit = {
      key: control.key,
      draft: String(control.number),
      cursor: String(control.number).length,
    };
    this.detail = this.settingsLines();
    this.notice = `Edit ${control.label}; Enter saves, Esc cancels.`;
  }
  insertSettingsText(text        ) {
    const edit = this.settingsEdit;
    if (!edit) {
      const inserted = sanitizeText(stripAnsi(text).replace(/[\r\n\t]+/g, " "));
      const points = [...this.settingsQuery];
      const remaining = Math.max(0, 80 - points.length);
      const next = [...inserted].slice(0, remaining);
      if (!next.length) return;
      points.splice(this.settingsQueryCursor, 0, ...next);
      this.settingsQuery = points.join("");
      this.settingsQueryCursor += next.length;
      this.settingsSelected = 0;
      this.scroll = 0;
      this.detail = this.settingsLines();
      return;
    }
    const control = this.settingsControls().find((row) => row.key === edit.key);
    const maxLength = control?.maxLength ?? 12;
    const available = Math.max(0, maxLength - edit.draft.length);
    const allowedText =
      control?.key === "terminal.keybindings"
        ? /[^\x20-\x7e]/g
        : /[^A-Za-z0-9._:@/-]/g;
    const inserted = sanitizeText(text)
      .replace(control?.text ? allowedText : /[^0-9]/g, "")
      .slice(0, available);
    if (!inserted) return;
    const before = edit.draft.slice(0, edit.cursor);
    const after = edit.draft.slice(edit.cursor);
    this.settingsEdit = {
      ...edit,
      draft: `${before}${inserted}${after}`,
      cursor: edit.cursor + inserted.length,
    };
    this.detail = this.settingsLines();
  }
  handleSettingsKey(
    value                    ,
    key                                                   ,
  ) {
    if (!this.settingsOpen) return false;
    if (key.ctrl && ["c", "d"].includes(key.name ?? "")) return false;
    const edit = this.settingsEdit;
    if (edit) {
      const control = this.settingsControls().find(
        (row) => row.key === edit.key,
      );
      if (key.name === "escape") {
        this.settingsEdit = undefined;
        this.notice = "Setting edit cancelled.";
      } else if (key.ctrl && key.name === "a") {
        this.settingsEdit = { ...edit, draft: "", cursor: 0 };
      } else if (key.name === "left") {
        this.settingsEdit = { ...edit, cursor: Math.max(0, edit.cursor - 1) };
      } else if (key.name === "right") {
        this.settingsEdit = {
          ...edit,
          cursor: Math.min(edit.draft.length, edit.cursor + 1),
        };
      } else if (key.name === "home") {
        this.settingsEdit = { ...edit, cursor: 0 };
      } else if (key.name === "end") {
        this.settingsEdit = { ...edit, cursor: edit.draft.length };
      } else if (key.name === "backspace") {
        if (edit.cursor > 0) {
          this.settingsEdit = {
            ...edit,
            draft: `${edit.draft.slice(0, edit.cursor - 1)}${edit.draft.slice(edit.cursor)}`,
            cursor: edit.cursor - 1,
          };
        }
      } else if (key.name === "delete") {
        this.settingsEdit = {
          ...edit,
          draft: `${edit.draft.slice(0, edit.cursor)}${edit.draft.slice(edit.cursor + 1)}`,
        };
      } else if (key.name === "enter" || key.name === "return") {
        if (!control?.text) {
          if (
            !/^\d+$/.test(edit.draft) ||
            !Number.isSafeInteger(Number(edit.draft))
          ) {
            this.notice = "Enter a whole number within the displayed range.";
            return true;
          }
        }
        try {
          this.applySetting(edit.key, edit.draft);
          this.settingsEdit = undefined;
        } catch (error) {
          this.notice = message(error);
        }
      } else if (
        value &&
        !key.ctrl &&
        !key.meta &&
        edit.draft.length < (control?.maxLength ?? 12) &&
        (control?.text
          ? control.key === "terminal.keybindings"
            ? /^[\x20-\x7e]$/.test(value)
            : /^[A-Za-z0-9._:@/-]$/.test(value)
          : /^\d$/.test(value))
      ) {
        this.insertSettingsText(value);
      }
      this.detail = this.settingsLines();
      return true;
    }
    const controls = this.visibleSettingsControls();
    const page = Math.max(1, this.viewport.height - 3);
    if (key.name === "escape") {
      if (this.settingsQuery) {
        this.settingsQuery = "";
        this.settingsQueryCursor = 0;
        this.settingsSelected = 0;
        this.scroll = 0;
        this.detail = this.settingsLines();
        this.notice = "Settings filter cleared.";
      } else {
        this.choose("chat");
        this.notice = "Returned to Chat.";
      }
    } else if (key.ctrl && (key.name === "u" || key.name === "a")) {
      this.settingsQuery = "";
      this.settingsQueryCursor = 0;
      this.settingsSelected = 0;
      this.scroll = 0;
      this.detail = this.settingsLines();
    } else if (key.name === "backspace" || key.name === "delete") {
      const points = [...this.settingsQuery];
      if (key.name === "backspace" && this.settingsQueryCursor > 0) {
        points.splice(this.settingsQueryCursor - 1, 1);
        this.settingsQueryCursor -= 1;
      } else if (
        key.name === "delete" &&
        this.settingsQueryCursor < points.length
      ) {
        points.splice(this.settingsQueryCursor, 1);
      }
      if (points.join("") !== this.settingsQuery) {
        this.settingsQuery = points.join("");
        this.settingsSelected = Math.min(
          this.settingsSelected,
          Math.max(0, this.visibleSettingsControls().length - 1),
        );
        this.scroll = 0;
        this.detail = this.settingsLines();
      }
    } else if (key.ctrl && (key.name === "left" || key.name === "right")) {
      if (this.settingsQuery) {
        this.settingsQueryCursor = Math.max(
          0,
          Math.min(
            [...this.settingsQuery].length,
            this.settingsQueryCursor + (key.name === "left" ? -1 : 1),
          ),
        );
      } else if (controls.length) {
        const groups = [...new Set(controls.map((control) => control.group))];
        const currentGroup = controls[this.settingsSelected]?.group;
        const currentIndex = Math.max(0, groups.indexOf(currentGroup ));
        const nextIndex =
          (currentIndex + (key.name === "left" ? -1 : 1) + groups.length) %
          groups.length;
        const target = controls.findIndex(
          (control) => control.group === groups[nextIndex],
        );
        if (target >= 0) {
          this.selectSetting(target);
          return true;
        }
      }
      this.detail = this.settingsLines();
    } else if (!controls.length) {
      this.detail = this.settingsLines();
    } else if (key.name === "up" || (key.ctrl && key.name === "p")) {
      this.selectSetting(
        (this.settingsSelected - 1 + controls.length) % controls.length,
      );
    } else if (key.name === "down" || (key.ctrl && key.name === "n")) {
      this.selectSetting((this.settingsSelected + 1) % controls.length);
    } else if (key.name === "home") {
      this.selectSetting(0);
    } else if (key.name === "end") {
      this.selectSetting(controls.length - 1);
    } else if (key.name === "pageup") {
      this.selectSetting(Math.max(0, this.settingsSelected - page));
    } else if (key.name === "pagedown") {
      this.selectSetting(
        Math.min(controls.length - 1, this.settingsSelected + page),
      );
    } else if (key.name === "left" || key.name === "right") {
      this.adjustSetting(key.name === "left" ? -1 : 1);
    } else if (key.name === "enter" || key.name === "return") {
      this.activateSetting();
    } else if (value === " " && !key.ctrl && !key.meta) {
      this.activateSetting();
    }
    return true;
  }
  session() {
    return this.sessionId ? this.workbench.get(this.sessionId) : undefined;
  }
  renderChatRows(events                         , width        ) {
    const cached = this.renderedChatRows;
    const cacheMatches = !!(
      cached &&
      cached.sessionId === this.sessionId &&
      cached.width === width &&
      cached.activityMode === this.toolActivityMode &&
      cached.hideToolActivity === this.hideToolActivity &&
      cached.density === this.chatPanelVisuals.density &&
      cached.timestamps === this.chatPanelVisuals.timestamps &&
      cached.symbolPreset === this.themeConfig.symbolPreset
    );
    if (cacheMatches && cached.events === events) return cached.rows;
    let stableCount = events.length;
    while (stableCount > 0 && events[stableCount - 1]?.type === "message.delta")
      stableCount--;
    // Workbench appends immutable delta events during a streamed response.
    // Reuse the settled transcript prefix until a non-delta event arrives.
    const canReusePrefix = !!(
      cacheMatches &&
      cached.stableCount === stableCount &&
      (stableCount === 0 ||
        events[stableCount - 1] === cached.events[stableCount - 1])
    );
    const render = (slice                         ) =>
      chatRows(
        slice,
        width,
        this.toolActivityMode,
        this.chatPanelVisuals.density,
        this.chatPanelVisuals.timestamps,
        this.hideToolActivity,
        this.themeConfig.symbolPreset,
      );
    const stableRows = canReusePrefix
      ? cached.stableRows
      : render(events.slice(0, stableCount));
    const appendOnlyDeltaTail = !!(
      cacheMatches &&
      cached.stableCount === stableCount &&
      events.length >= cached.events.length &&
      (stableCount === 0 ||
        events[stableCount - 1] === cached.events[stableCount - 1]) &&
      (cached.events.length === stableCount ||
        events[cached.events.length - 1] ===
          cached.events[cached.events.length - 1])
    );
    const partialText = appendOnlyDeltaTail
      ? cached.partialText +
        events
          .slice(cached.events.length)
          .map((event) => event.text)
          .join("")
      : events
          .slice(stableCount)
          .map((event) => event.text)
          .join("");
    const tailRows = appendOnlyDeltaTail
      ? stableCount < events.length
        ? render([{ ...events.at(-1) , text: partialText }])
        : []
      : render(events.slice(stableCount));
    const rows = [...stableRows, ...tailRows];
    this.renderedChatRows = {
      sessionId: this.sessionId ?? "",
      events,
      width,
      activityMode: this.toolActivityMode,
      hideToolActivity: this.hideToolActivity,
      density: this.chatPanelVisuals.density,
      timestamps: this.chatPanelVisuals.timestamps,
      symbolPreset: this.themeConfig.symbolPreset,
      stableCount,
      stableRows,
      partialText: stableCount < events.length ? partialText : "",
      rows,
    };
    return rows;
  }
          useSession(id        ) {
    if (!this.workbench.get(id)) throw Error("Conversation not found.");
    this.sessionId = id;
    this.documentPath = undefined;
  }
  items()         {
    let rows         = [];
    const sessionIcons = getSymbols(this.themeConfig.symbolPreset).icons;
    if (this.tab === "sessions")
      rows = [...this.workbench.list()]
        .sort((a, b) => {
          const pinnedOrder = Number(!!b.pinned) - Number(!!a.pinned);
          if (pinnedOrder !== 0) return pinnedOrder;
          const aTime = Date.parse(a.updatedAt ?? a.createdAt ?? "");
          const bTime = Date.parse(b.updatedAt ?? b.createdAt ?? "");
          const aValid = Number.isFinite(aTime);
          const bValid = Number.isFinite(bTime);
          if (aValid !== bValid) return aValid ? -1 : 1;
          if (aValid && bValid && aTime !== bTime) return bTime - aTime;
          return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        })
        .map((s) => ({
          id: s.id,
          sessionId: s.id,
          label: `${s.archived ? ROW_ICONS.archived : stateIcon(s.status)} ${s.status} · ${s.pinned ? "pinned · " : ""}${s.title ?? s.id}`,
          lines: [
            `${sessionIcons.session} Conversation: ${s.title ?? s.id}`,
            `${stateIcon(s.status)} Status: ${s.status}${s.archived ? " · archived" : ""}${s.pinned ? " · pinned" : ""}`,
            `${sessionIcons.model} Model: ${s.model || "unknown"}`,
            `${sessionIcons.provider} Provider: ${s.provider ?? "unknown"}`,
            `${sessionIcons.document} Workspace: ${s.workspace || "not set"}`,
            `${sessionIcons.document} Project: ${s.project || "not recorded"}`,
            `${sessionIcons.agent} Agent profile: ${s.agent ?? "not recorded"}`,
            `${sessionIcons.time} Updated: ${sessionTimestamp(s.updatedAt ?? s.createdAt)}`,
            `${sessionIcons.time} Created: ${sessionTimestamp(s.createdAt)}`,
            `${sessionIcons.session} Messages: ${numberOr(s.contextMessages, "unknown")}`,
            `${sessionIcons.run} Run: ${s.runId ?? "none"} · ${s.state ?? "unknown"}`,
            `${sessionIcons.tokens} Run tokens: ${s.runTokenCount}`,
            `${sessionIcons.retry} Continuations: ${s.continuationCount}`,
            `${sessionIcons.usage} Retained events: ${s.events.length}`,
            ...(s.parentId ? [`Parent conversation: ${s.parentId}`] : []),
          ],
        }));
    if (this.tab === "runs")
      rows = [...this.workbench.runs()]
        .sort((left, right) => {
          const leftTime = Date.parse(left.updatedAt ?? left.createdAt);
          const rightTime = Date.parse(right.updatedAt ?? right.createdAt);
          const leftValid = Number.isFinite(leftTime);
          const rightValid = Number.isFinite(rightTime);
          if (leftValid !== rightValid) return leftValid ? -1 : 1;
          if (leftValid && rightValid && leftTime !== rightTime)
            return rightTime - leftTime;
          return left.runId < right.runId
            ? -1
            : left.runId > right.runId
              ? 1
              : 0;
        })
        .map((run) => {
          const progress =
            typeof run.progress === "number" &&
            Number.isFinite(run.progress) &&
            run.progress >= 0 &&
            run.progress <= 1
              ? `${Math.round(run.progress * 100)}%`
              : "progress not reported";
          const duration =
            typeof run.durationMs === "number" &&
            Number.isFinite(run.durationMs) &&
            run.durationMs >= 0
              ? `${Math.round(run.durationMs / 100) / 10}s`
              : "time unknown";
          return {
            id: `${run.sessionId}:${run.runId}`,
            sessionId: run.sessionId,
            run,
            label: `${stateIcon(run.state)} ${sanitizeText(run.state)} · ${sanitizeText(run.model)} · ${progress} · ${run.sessionId.slice(0, 8)}`,
            lines: [
              `${sessionIcons.run} Run: ${sanitizeText(run.runId)}`,
              `${stateIcon(run.state)} State: ${sanitizeText(run.state)} · provider status ${sanitizeText(run.status)}`,
              `${sessionIcons.model} Model: ${sanitizeText(run.model)}`,
              `${sessionIcons.provider} Provider: ${sanitizeText(run.provider ?? "not reported")}`,
              `${sessionIcons.session} Conversation: ${run.sessionId}`,
              `${sessionIcons.usage} Progress: ${progress}`,
              `${sessionIcons.tool} Tool steps: ${run.steps}`,
              `${sessionIcons.time} Duration: ${duration}`,
              `${sessionIcons.time} Started: ${sessionTimestamp(run.createdAt)}`,
              `${sessionIcons.time} Updated: ${sessionTimestamp(run.updatedAt)}`,
              `${sessionIcons.retry} Record: ${run.legacy ? "legacy event stream" : "run-scoped event stream"}`,
              `${run.reconcileRequired ? ROW_ICONS.queued : ROW_ICONS.settled} Reconciliation: ${run.reconcileRequired ? "required before treating outcome as settled" : "not required by current run state"}`,
            ],
          };
        });
    if (this.tab === "documents")
      rows = this.workbench.documentsList().map((d) => ({
        id: `${d.sessionId}:${d.path}`,
        sessionId: d.sessionId,
        path: d.path,
        label: `${ROW_ICONS.document} ${d.path}  ${d.bytes} B  ${d.sessionId.slice(0, 8)}`,
        lines: json(d),
      }));
    if (this.tab === "ledger") {
      for (const [id, entries] of this.proofs)
        for (const e of entries) {
          const b = e.body                           ;
          rows.push({
            id: `${id}:${e.seq}`,
            sessionId: id,
            ...(typeof b.operationId === "string"
              ? { operationId: b.operationId }
              : {}),
            kind: "entry",
            label: `${ROW_ICONS.ledgerEntry} ${id.slice(0, 8)} #${e.seq} [${text(b.klass)}] ${text(b.decision)} ${text(b.tool)}`,
            lines: [
              this.managedVerificationStatus === undefined
                ? "[OK] Hash chain and signature verified"
                : `[OK] Hash chain and signature verified, ${this.managedVerificationStatus}`,
              ...(this.managedVerificationNote === undefined
                ? []
                : [`Verification key: ${this.managedVerificationNote}`]),
              ...json(e),
            ],
          });
        }
      for (const [workspace, entries] of this.proxy.entries)
        for (const e of entries) {
          const b = e.body                           ;
          rows.push({
            id: `proxy:${workspace}:${e.seq}`,
            kind: "proxy",
            label: `${ROW_ICONS.proxyEntry} proxy:${workspace} #${e.seq} [${text(b.klass)}] ${text(b.decision)} ${text(b.tool)}`,
            lines: [
              this.proxy.signed
                ? `[OK] Proxy signatures and hash chain verified, ${this.proxy.verificationStatus}`
                : "[!] Proxy: hash integrity only, signature NOT VERIFIED",
              ...(this.proxy.verificationNote
                ? [`Verification key: ${this.proxy.verificationNote}`]
                : []),
              ...json(e),
            ],
          });
        }
      // What the chain taught, as rows of its own. The rules are mined from
      // these same verified entries rather than recomputed from a snapshot, so
      // an unverified refusal cannot appear here as if it had authority.
      for (const [id, entries] of this.proofs) {
        const learned = mineLearnedRules(entries);
        // A workspace that taught nothing still gets a record, because
        // "nothing was mined here" and "this row was never built" are
        // indistinguishable on screen. An operator who sees no learning row
        // cannot otherwise tell a chain that was read and found no pattern
        // from a chain that was never consulted. Those are different facts,
        // so they get different wording: verified entries with no recurring
        // refusal is a *result*, while no entries at all is simply nothing
        // observed yet.
        if (learned.length === 0) {
          rows.push({
            id: `learned:${id}:none`,
            sessionId: id,
            kind: "learned",
            label: `${ROW_ICONS.learned} learned ${id.slice(0, 8)} nothing learned`,
            lines: [
              entries.length
                ? `0 recurring refusals across ${entries.length} verified ${entries.length === 1 ? "entry" : "entries"}.`
                : "0 verified entries, so no refusal has been observed and no rule was mined.",
              "Mined from the verified chain.",
            ],
          });
        }
        for (const rule of learned) {
          rows.push({
            // The class belongs in the identity as well as the label: the
            // same tool refused under two different classes is two separate
            // patterns, and an id built from the tool alone collides them.
            id: `learned:${id}:${String(rule.match.tool)}:${String(rule.match.class)}`,
            sessionId: id,
            kind: "learned",
            label: `${ROW_ICONS.learned} learned ${id.slice(0, 8)} ${text(rule.match.tool)} [${text(rule.match.class)}] -> ${rule.decision}`,
            lines: [
              this.managedVerificationStatus === undefined
                ? "[OK] Mined from the verified chain"
                : `[OK] Mined from the verified chain, ${this.managedVerificationStatus}`,
              ...(this.managedVerificationNote === undefined
                ? []
                : [`Verification key: ${this.managedVerificationNote}`]),
              rule.rationale ?? "",
              "A learned rule is evidence, not authority: it is appended after the operator's own rules, and under the mandatory terminal catch-all it never binds.",
            ],
          });
        }
      }
      // With no verified workspace at all there is no loop iteration to hang
      // the empty record on, and the tab would otherwise show nothing, which
      // an operator reads as "no learning record exists" rather than "nothing
      // has been verified yet". Same distinction as above, one level up.
      if (this.proofs.size === 0)
        rows.push({
          id: "learned:none",
          label: `${ROW_ICONS.learned} learned nothing learned`,
          lines: [
            "0 verified entries, so no refusal has been observed and no rule was mined.",
            "Mined from the verified chain.",
          ],
        });
      // What the chain costs a human, measured rather than asserted. The
      // figures are descriptive: they print beside the records they were
      // measured from and reach no gate, policy or permission. A metric the
      // chain cannot support is reported as unavailable instead of being
      // rendered as a number nobody checked.
      {
        // Score only the managed chains above: each verified workspace chain
        // is one case. Proxy chains have a separate verification state and are
        // not mixed into this descriptive, non-authoritative report.
        const scoreBoard = measureBoard(
          verifiedScoreCases(this.proofs),
          new Date().toISOString(),
        );
        const firstPass = scoreBoard.metrics.first_pass_rate;
        const firstPassValue =
          firstPass.mean === null
            ? "unmeasured"
            : `${(firstPass.mean * 100).toFixed(1)}%`;
        const firstPassCi =
          firstPass.half === null
            ? "unavailable"
            : `±${(firstPass.half * 100).toFixed(1)}%`;
        rows.push({
          id: "harness:scores",
          kind: "score",
          label: `${ROW_ICONS.harness} harness score ${scoreBoard.verdict}`,
          lines: [
            `Verdict: ${scoreBoard.verdict}.`,
            `First-pass rate: ${firstPassValue}.`,
            `95% CI: ${firstPassCi}; ${firstPass.n} first-pass samples across ${scoreBoard.caseCount} cases.`,
            // The verdict is a sentence, not a grade: "flat" means nothing was
            // compared, which reads as "measured and unchanged" unless the
            // reason is printed next to it.
            `Reason: ${scoreBoard.reasons.join("; ")}.`,
            ...unmeasuredMetrics(scoreBoard).map(
              (key) => `${key}: no sample, so no rate can be computed.`,
            ),
            "Descriptive only; never changes a decision or permission.",
          ],
        });
      }
      // The ring closes as the chain verifies. Its shape reports how far the
      // check got, so an operator can see progress without reading a count,
      // and the word beside it stays authoritative.
      {
        const total = [...this.proofs.values()].reduce(
          (sum, entries) => sum + entries.length,
          0,
        );
        const failed = this.proofErrors.size + this.proxy.errors.length;
        const ok = Math.max(0, total - failed);
        rows.push({
          id: "ledger:verification",
          kind: "verification",
          label: `${completionRing(ok, Math.max(1, total), motionContext(this.frame))} ${ok} of ${total} ledger entries verified`,
          lines: [
            failed
              ? `${failed} entries could not be verified.`
              : "Every entry in the chain verified.",
            "The ring is the shape of the check, not a score.",
          ],
        });
      }
      // The harness that produced this chain: which runtime is the default,
      // which profile new conversations get, and what hooks are wired.
      // /harness and /hooks print the same facts on demand; this is where
      // the chain itself is shown, so the chain and its producer stay
      // together on one tab.
      const harnessCatalog = this.workbench.agents();
      const prefs = this.workbench.getPreferences();
      rows.push({
        id: "harness:current",
        kind: "harness",
        label: `${ROW_ICONS.harness} harness ${prefs.defaultAgent ?? "cloud"}`,
        lines: [
          `Default for new conversations: ${prefs.defaultAgent ?? "cloud"}.`,
          `Selected agent profile: ${this.agentId ?? "runtime default"}.`,
          harnessCatalog.hooksSupported
            ? `Hooks are executable; ${harnessCatalog.hooks.length} saved.`
            : "Hook execution unsupported on this host: none can run.",
        ],
      });
      for (const hook of harnessCatalog.hooks) {
        rows.push({
          id: `hook:${hook.id}`,
          kind: "hook",
          label: `${hook.enabled ? ROW_ICONS.hook : ROW_ICONS.archived} hook ${hook.id} ${hook.enabled ? "on" : "off"}`,
          lines: [
            `Event: ${hook.event}.`,
            `Command: ${boundedHookCommand(hook.command)}`,
            "/hook enable|disable <id> toggles it; /hook-file reviews a save.",
          ],
        });
      }
      if (harnessCatalog.hooks.length === 0)
        rows.push({
          id: "hook:none",
          kind: "hook",
          label: `${ROW_ICONS.hook} hook none saved`,
          lines: [
            harnessCatalog.hooksSupported
              ? "No hooks saved. /hook-file path.json reviews a save."
              : "No hooks saved, and execution is unsupported on this host.",
          ],
        });
      // One row per selectable agent, presets and saved profiles alike: the
      // harness row above says which profile is selected, and these rows are
      // the panel it is selected from. The label carries the selection so it
      // is visible without opening anything, and Enter makes the same
      // assignment /agent <id> makes, so selection never leaves the tab.
      for (const agent of harnessCatalog.agents) {
        const profile = harnessCatalog.profiles.find(
          (candidate) => candidate.id === agent.id,
        );
        const selected = agent.id === this.agentId;
        // Same bound as /agents prints: a prompt is prose, and the marker
        // says it was cut rather than letting a truncated prompt read as
        // the whole one.
        const prompt = profile?.systemPrompt.trim() ?? "";
        const shown = !prompt
          ? "(empty)"
          : prompt.length > 160
            ? `${prompt.slice(0, 160)}… (+${prompt.length - 160} chars)`
            : prompt;
        rows.push({
          id: `agent:${agent.id}`,
          kind: "agent",
          label: `◆ agent ${agent.id}${selected ? " [selected]" : ""}`,
          lines: [
            ...(profile
              ? [
                  `Profile ${profile.id}: policy ${profile.policyProfile}, max turns ${profile.maxTurns}, max context tokens ${profile.maxContextTokens}`,
                  `Allowed tools: ${profile.allowedTools.join(", ") || "none"}`,
                  `System prompt: ${shown}`,
                ]
              : [`Preset ${agent.id}: ${agent.name}. ${agent.description}`]),
            selected
              ? "Selected for new conversations."
              : "Enter selects it for new conversations; Enter again returns to the runtime default.",
            "Existing conversations keep their profile snapshot. /agent-file path.json reviews a save.",
          ],
        });
      }
      rows.reverse();
      // Grouped by kind, in the order an operator reasons in. Without this
      // the groups rendered in whatever order the records happened to be
      // built in, so agents came before the signed entries they relate to.
      // Sorting the rows themselves rather than the rendered lines is what
      // keeps the printed numbers matching the selection index.
      rows.sort(
        (a, b) =>
          LEDGER_GROUP_ORDER.indexOf(
            (a.kind ?? "entry")                                       ,
          ) -
          LEDGER_GROUP_ORDER.indexOf(
            (b.kind ?? "entry")                                       ,
          ),
      );
    }
    if (this.tab === "approvals")
      rows = this.workbench
        .approvals()
        .map((value) => {
          const h = value     
                           
                           
                   
                           
                             
                                   
                              
              
                              
           ;
          return {
            id: h.holdId,
            hold: h,
            // A rejected hold is not an open obligation, so it gets a
            // different glyph from a pending one. The status word beside it
            // stays authoritative either way.
            // The countdown rides on the row because the row is what the
            // operator is looking at when they decide whether to read the
            // detail first. A hold with no deadline prints nothing: that
            // means the server sent no deadline, not that it never closes.
            label:
              expirySuffix(h, Date.now()) +
              holdRowIcon(h) +
              " " +
              approvalLabel(h),
            lines: json(h),
          };
        })
        // Most consequential first, not newest first. The list used to
        // arrive in backend order, which put a read next to a write and let
        // an operator clear three harmless holds before reaching the one
        // that touches every document.
        .sort((a, b) => holdSeverity(b.hold) - holdSeverity(a.hold));
    if (this.tab === "approvals")
      rows.push(
        ...this.proxy.holds.map(({ decisionToken, ...h }) => ({
          id: `proxy:${h.holdId}`,
          label: `${ROW_ICONS.approval} [proxy pending] ${h.call.tool} ${h.holdId}`,
          lines: json(h),
        })),
      );
    if (this.tab === "tools")
      rows = this.workbench
        .availableTools(this.sessionId)
        .tools.map((tool) => ({
          id: tool.id,
          // The Undo marker is decoration on top of a label that already
          // states the fact in words, so a monochrome terminal and a screen
          // reader lose nothing by not seeing the glyph.
          label:
            `${ROW_ICONS.tool} ${tool.klass.toUpperCase()} ${tool.name} / ${tool.source}` +
            `${
              tool.capturedUndo ? " / ↩ captured Undo" : " / no captured Undo"
            }`,
          // The detail is the schema as a property table rather than as JSON.
          // Raw JSON buried the two facts the operator actually reads, which
          // property is required and what the call does, under a dozen keys
          // nobody scans.
          lines: [
            ...toolSchemaLines(
              {
                id: tool.id,
                name: tool.name,
                klass: tool.klass,
                source: tool.source,
                description: tool.description,
                capturedUndo: tool.capturedUndo,
                inputSchema: tool.inputSchema,
              },
              this.layoutColumns,
            ),
            "",
            `Scope: ${this.sessionId ? "current conversation" : "new conversations"}`,
            tool.capturedUndo
              ? "Captured document Undo available."
              : "Undo is not guaranteed for this tool.",
            "",
            "The model requests tools through NOMO policy and approvals.",
            "",
            REGISTRY_DISCLAIMER,
          ],
        }));
    if (this.tab === "mcp")
      rows = this.connectorRows().map((connector) => ({
        id: connector.id,
        connector: {
          id: connector.id,
          name: connector.name,
          tools: connector.tools,
          consentState: connector.consent,
        },
        label: `${connectorConsentIcon(connector.consent)} ${connector.consent.toUpperCase()} · ${sanitizeText(connector.name)} · ${connector.tools.length} tools`,
        lines: [
          `id ${sanitizeText(connector.id)}`,
          `endpoint ${sanitizeText(connector.endpoint)}`,
          `consent ${connector.consent}`,
          `tools ${connector.tools.length}: ${this.toolNames(connector.tools)}`,
          `policy ${policySummary(connector.policy)}`,
        ],
      }));
    if (this.tab === "policy")
      rows = this.workbench.connectionState().connectors.map((c) => ({
        id: c.id,
        label: `${ROW_ICONS.connector} ${c.name} (${c.tools.length} tools)`,
        connector: {
          id: c.id,
          name: c.name,
          tools: c.tools,
          consentState: c.consentState,
        },
        lines: json(c),
      }));
    if (this.tab === "status")
      rows = orderChecks(this.healthChecks()).map((check) => ({
        id: `${check.area}:${check.name}`,
        check,
        label: `${healthIcon(check.state)} ${healthWord(check.state).toUpperCase()} · ${sanitizeText(check.area)} · ${sanitizeText(check.name)}`,
        lines: [
          sanitizeText(check.detail),
          ...(check.remedy ? [`Next step: ${sanitizeText(check.remedy)}`] : []),
        ],
      }));
    if (this.tab === "models")
      rows = this.activeModelCatalog().map((m) => ({
        id: m.id,
        // The [*] marker is what says which model new conversations get. The
        // glyph in front is only a shape to scan by; the marker stays.
        label: `${this.providerGlyph(this.provider?.baseUrl ?? "", this.provider?.providerId ?? "")} ${this.modelGlyph()} ${m.id === this.model ? "[*]" : "[ ]"} ${m.name}  ${m.id}`,
        lines: json(m),
      }));
    if (this.tab === "usage")
      rows = activity(this.workbench.allViews()).usage.map((r) => ({
        id: r.id,
        sessionId: r.sessionId,
        label: `${ROW_ICONS.ledgerEntry} ${r.model} ${r.sessionId.slice(0, 8)} | tokens ${r.totalTokens ?? "unknown"} | cost unknown`,
        // The row's own numbers stay on the row. The detail repeats them in a
        // readable block rather than leaving the operator to find them inside
        // a JSON dump, which is where they used to be.
        usage: r,
        lines: json(r),
      }));
    const filteredRows = this.filter
      ? rows.filter((r) =>
          `${r.label} ${r.lines.join(" ")}`
            .toLowerCase()
            .includes(this.filter.toLowerCase()),
        )
      : rows;
    if (this.tab === "documents" || this.tab === "sessions") {
      const treeKey =
        `${this.tab}\0${this.filter.toLowerCase()}\0` +
        filteredRows
          .map(
            (row) =>
              // Session details and recency change without changing the
              // title/status label; include them so tree rows stay fresh.
              `${row.id}\0${row.label}\0${this.tab === "sessions" ? row.lines.join("\0") : ""}`,
          )
          .join("\u0001");
      if (!this.groupTree || this.groupTreeKey !== treeKey) {
        const matchingIds = new Set(filteredRows.map((row) => row.id));
        const nodes =
          this.tab === "documents"
            ? buildDocumentTree(
                this.workbench
                  .documentsList()
                  .filter((document) =>
                    matchingIds.has(`${document.sessionId}:${document.path}`),
                  )
                  .map((document) => ({
                    id: `${document.sessionId}:${document.path}`,
                    path: document.path,
                    detail: `${document.bytes} B · ${document.sessionId.slice(0, 8)}`,
                    kind: "document",
                  })),
              )
            : buildSessionTree(
                this.workbench
                  .list()
                  .filter((session) => matchingIds.has(session.id))
                  .map((session) => {
                    const updatedAt = session.updatedAt ?? session.createdAt;
                    const sortOrder = Date.parse(updatedAt ?? "");
                    return {
                      id: session.id,
                      // State is the useful grouping; NOMO has no folder tree
                      // for conversations. Recent conversations lead each group.
                      path: `${session.pinned ? "pinned · " : ""}${session.title ?? session.id}`,
                      detail:
                        `${sessionIcons.provider} ${session.provider ?? "unknown provider"} · ` +
                        `${sessionIcons.model} ${session.model || "unknown model"} · ` +
                        `${sessionIcons.session} ${numberOr(session.contextMessages, "unknown")} messages · ` +
                        `${sessionIcons.tokens} ${session.runTokenCount} run tokens · ` +
                        sessionTimestamp(updatedAt),
                      kind: sessionGroup(
                        session.status,
                        session.archived === true,
                      ),
                      sortPriority: session.pinned ? 1 : 0,
                      ...(Number.isFinite(sortOrder) ? { sortOrder } : {}),
                    };
                  }),
              );
        this.groupTree = {
          nodes,
          state: refreshedTreeState(this.groupTree, nodes),
        };
        this.groupTreeKey = treeKey;
      }
    }
    return filteredRows;
  }
  /**
   * How many existing conversations already ran on a model.
   *
   * Switching does not move a conversation: a conversation keeps the model
   * it started on. An operator about to switch needs to know how much of
   * their history that leaves behind, and the honest answer is a count rather
   * than a reassurance.
   */
  conversationsOnModel(modelId        )         {
    const count = this.workbench
      .list()
      .filter((s) => s.model === modelId).length;
    if (!count) return "no existing conversation";
    return `${count} existing conversation${count === 1 ? "" : "s"} (they keep their own model)`;
  }

  async openSelected() {
    const row = this.items()[this.selected];
    if (!row) return;
    // Enter on a conversation resumes it in Chat, matching the session
    // selector interaction used by OMP.
    if (this.tab === "sessions") {
      this.useSession(row.sessionId );
      this.choose("chat");
      return;
    }
    if (this.tab === "documents") {
      this.documentPreview = false;
      this.useSession(row.sessionId );
      this.documentPath = row.path;
      this.showDocument();
      return;
    }
    if (this.tab === "runs" && row.run) {
      const run = row.run;
      const session = this.workbench.get(run.sessionId);
      const events = (session?.events ?? []).filter(
        (event) =>
          event.runId === run.runId ||
          (run.legacy && event.runId === undefined),
      );
      const runUsage = activity(this.workbench.allViews()).usage.filter(
        (entry) => entry.runId === run.runId,
      );
      const reportedTokens = runUsage
        .map((entry) => entry.totalTokens)
        .filter(
          (value)                  =>
            typeof value === "number" && Number.isFinite(value) && value >= 0,
        );
      const progress =
        typeof run.progress === "number" &&
        Number.isFinite(run.progress) &&
        run.progress >= 0 &&
        run.progress <= 1
          ? `${Math.round(run.progress * 100)}%`
          : "not reported";
      const duration =
        typeof run.durationMs === "number" &&
        Number.isFinite(run.durationMs) &&
        run.durationMs >= 0
          ? `${Math.round(run.durationMs / 100) / 10}s`
          : "time unknown";
      const timeline = buildTimeline(
        events.map((event) => ({
          type: event.type ?? event.kind,
          at: event.at,
          tool:
            typeof event.payload?.tool === "string"
              ? event.payload.tool
              : undefined,
          detail:
            typeof event.payload?.name === "string"
              ? event.payload.name
              : undefined,
        })),
      );
      this.detail = [
        ...renderInspector(
          {
            title: `RUN ${sanitizeText(run.state).toUpperCase()}`,
            subtitle: run.runId,
            icon: ROW_ICONS.run,
            sections: [
              {
                title: "run",
                fields: [
                  {
                    label: "state",
                    value: run.state,
                    tone:
                      run.state === "failed"
                        ? "error"
                        : run.state === "running"
                          ? "accent"
                          : "default",
                  },
                  { label: "provider status", value: run.status },
                  { label: "model", value: run.model },
                  { label: "provider", value: run.provider ?? "not reported" },
                  { label: "run id", value: run.runId },
                  {
                    label: "record",
                    value: run.legacy
                      ? "legacy event stream"
                      : "run-scoped event stream",
                  },
                ],
              },
              {
                title: "execution",
                fields: [
                  { label: "progress", value: progress },
                  { label: "tool steps", value: String(run.steps) },
                  { label: "duration", value: duration },
                  { label: "started", value: sessionTimestamp(run.createdAt) },
                  { label: "updated", value: sessionTimestamp(run.updatedAt) },
                  { label: "events", value: String(events.length) },
                ],
              },
              {
                title: "conversation",
                fields: [
                  { label: "id", value: run.sessionId },
                  { label: "title", value: session?.title ?? "not recorded" },
                  {
                    label: "workspace",
                    value: session?.workspace || "not set",
                  },
                  {
                    label: "project",
                    value: session?.project || "not recorded",
                  },
                  {
                    label: "agent profile",
                    value: session?.agent ?? "not recorded",
                  },
                ],
              },
              {
                title: "usage and recovery",
                fields: [
                  {
                    label: "reported tokens",
                    value: reportedTokens.length
                      ? reportedTokens
                          .reduce((sum, value) => sum + value, 0)
                          .toLocaleString("en-US")
                      : "not reported",
                  },
                  {
                    label: "reconciliation",
                    value: run.reconcileRequired
                      ? "required"
                      : "not required by current state",
                    tone: run.reconcileRequired ? "warning" : "success",
                  },
                  { label: "resume", value: `/resume ${run.sessionId}` },
                  ...(run.reconcileRequired
                    ? [
                        {
                          label: "recovery",
                          value:
                            "/recovery refreshes the recorded recovery state",
                          tone: "warning"         ,
                        },
                      ]
                    : []),
                ],
              },
            ],
            hint: "Esc returns to Runs · Enter on a run opens this read-only inspector",
          },
          { width: this.layoutColumns, motion: motionContext(this.frame) },
        ),
        "",
        `${getSymbols(this.themeConfig.symbolPreset).icons.run} RECORDED ACTIVITY`,
        ...renderTimeline(timeline, this.layoutColumns, 10, {
          motion: motionContext(this.frame),
        }),
        "",
        "Only recorded run metadata is shown; code and tool output remain in the Chat activity stream.",
      ];
      this.scroll = 0;
      return;
    }
    // An approval is the one row where Enter should read as "show me what I
    // am about to decide", not as raw JSON. The hold is already carried on the
    // row for ordering, so this reads the same object the list sorted by.
    if (this.tab === "approvals" && row.hold) {
      this.detail = approvalInspectLines(
        row.hold,
        row.lines,
        this.layoutColumns,
      );
      this.scroll = 0;
      return;
    }
    if (this.tab === "mcp" && row.connector) {
      const connector = this.connectorRows().find(
        (candidate) => candidate.id === row.connector?.id,
      );
      if (!connector) throw Error("Connector changed. Refresh the MCP list.");
      this.detail = this.connectorInspect(connector);
      this.notice = `${connector.name} is ${connector.consent}.`;
      this.scroll = 0;
      return;
    }
    if (this.tab === "status" && row.check) {
      const check = row.check;
      this.detail = renderInspector(
        {
          title: sanitizeText(check.name),
          subtitle: `${check.area} · ${healthWord(check.state)}`,
          icon: healthIcon(check.state),
          sections: [
            {
              title: "health state",
              fields: [
                {
                  label: "state",
                  value: healthWord(check.state),
                  tone: healthTone(check.state),
                },
                { label: "subsystem", value: sanitizeText(check.area) },
              ],
            },
            {
              title: "evidence",
              fields: [
                { label: "current result", value: sanitizeText(check.detail) },
              ],
            },
            {
              title: "next step",
              fields: [
                {
                  label: "remedy",
                  value: sanitizeText(check.remedy ?? "No action is recorded."),
                  tone: check.remedy ? "warning" : "muted",
                },
                { label: "execution", value: "Read-only status inspection" },
              ],
            },
          ],
          hint: "Esc returns to Status · this inspection does not run the suggested action",
        },
        { width: this.layoutColumns, motion: motionContext(this.frame) },
      );
      this.scroll = 0;
      return;
    }
    // Same reasoning for a connector. What the operator came to this tab to
    // find out is what a connector is allowed to do and whether they have
    // agreed to it, and both are two lines down inside the JSON dump they used
    // to get.
    if (this.tab === "policy" && row.connector) {
      const c = row.connector;
      const confirmed = c.consentState === "confirmed";
      this.detail = [
        ...renderInspector(
          {
            title: c.name || c.id,
            subtitle: c.id,
            icon: ROW_ICONS.connector,
            sections: [
              {
                title: "consent",
                fields: [
                  {
                    label: "state",
                    value: c.consentState,
                    // Not confirmed is not a warning about the connector. It
                    // is a statement that nothing has been granted yet, and
                    // colouring it as a problem would imply otherwise.
                    badge: confirmed ? "granted" : "not granted",
                    tone: confirmed ? "success" : "muted",
                  },
                  {
                    label: "means",
                    value: confirmed
                      ? "Calls go through without asking again."
                      : "Calls ask before they run. /connector-file confirms it.",
                  },
                  {
                    label: "tools",
                    value: `${c.tools.length}`,
                    tone: c.tools.length ? "default" : "warning",
                  },
                ],
              },
              {
                title: "tool list",
                fields: c.tools.map((tool) => ({
                  label: tool,
                  value: "available through this connector",
                  tone: "muted",
                })),
              },
            ],
            hint: "/mcp lists connectors; /connector-file reviews a save.",
          },
          { width: this.layoutColumns },
        ),
        "",
        "RAW RECORD",
        ...row.lines,
      ];
      this.scroll = 0;
      return;
    }
    // And for usage. The row carries one number; the detail breaks it into
    // where it went, which is the question the row cannot answer at a glance.
    if (this.tab === "usage" && row.usage) {
      const u = row.usage;
      const total = numberOr(u.totalTokens, "unknown");
      const input = numberOr(u.inputTokens, "unknown");
      const output = numberOr(u.outputTokens, "unknown");
      this.detail = [
        ...renderInspector(
          {
            title: u.model,
            subtitle: u.sessionId.slice(0, 8),
            icon: ROW_ICONS.ledgerEntry,
            sections: [
              {
                title: "tokens",
                fields: [
                  { label: "total", value: total, badge: "all calls" },
                  { label: "in", value: input },
                  { label: "out", value: output },
                  {
                    label: "cost",
                    // Not computed anywhere. Printing a currency figure from
                    // a price this software does not hold would be a number
                    // with no source behind it.
                    value: "unknown, this build does not price",
                    tone: "muted",
                  },
                ],
              },
              {
                title: "where it came from",
                fields: [
                  { label: "provider", value: u.provider ?? "unknown" },
                  { label: "source", value: u.source ?? "unknown" },
                  { label: "at", value: u.at ?? "not stamped" },
                ],
              },
            ],
            hint: "Every number here is what the provider recorded, not an estimate.",
          },
          { width: this.layoutColumns },
        ),
        "",
        "RAW RECORD",
        ...row.lines,
      ];
      this.scroll = 0;
      return;
    }
    if (this.tab === "models") {
      await this.command(`/model ${row.id}`);
      return;
    }
    // A hook row on the ledger tab is the saved hook, so Enter toggles it
    // through the same upsertHook path /hook uses rather than opening
    // details: the id ties a hook to its runs, and the operator allowlist
    // is re-checked on the write either way.
    const hookId = /^hook:(?!none$)(.+)$/.exec(row.id)?.[1];
    if (this.tab === "ledger" && hookId) {
      const hook = this.workbench
        .agents()
        .hooks.find((candidate) => candidate.id === hookId);
      if (!hook) throw Error("Hook not saved. Use /hooks for ids.");
      const saved = this.workbench.upsertHook({
        ...hook,
        enabled: !hook.enabled,
      });
      this.detail = [
        `HOOK ${saved.enabled ? "ENABLED" : "DISABLED"}`,
        ...json(saved),
      ];
      this.notice = `Hook ${saved.id} is now ${saved.enabled ? "on" : "off"}. Existing conversations keep their hook snapshot.`;
      this.scroll = 0;
      return;
    }
    // An agent row is the profile itself, so Enter makes the same selection
    // /agent <id> makes rather than only opening details: new conversations
    // get the profile, existing ones keep theirs, and Enter on the selected
    // row clears the selection back to the runtime default.
    const agentRowId = /^agent:(.+)$/.exec(row.id)?.[1];
    if (this.tab === "ledger" && agentRowId) {
      const agent = this.workbench
        .agents()
        .agents.find((candidate) => candidate.id === agentRowId);
      if (!agent) throw Error("Agent not found. Use /agents for ids.");
      const selected = this.agentId !== agent.id;
      this.agentId = selected ? agent.id : undefined;
      this.detail = [
        selected
          ? `AGENT PROFILE ${agent.id} SELECTED`
          : "AGENT PROFILE CLEARED",
        ...row.lines,
      ];
      this.notice = selected
        ? `Agent profile ${agent.id} selected for new conversations. Existing conversations keep their profile.`
        : "Agent profile cleared. New conversations use the runtime default.";
      this.scroll = 0;
      return;
    }
    // A ledger entry or proxy entry is the core record. Enter reads it as
    // an aligned inspector rather than a JSON dump. The row already carries
    // the parsed body in lines, so we render it the same way approvals do.
    if (
      this.tab === "ledger" &&
      (row.kind === "entry" || row.kind === "proxy")
    ) {
      const b = row.lines[0] ? JSON.parse(row.lines.slice(2).join("\n")) : {};
      const isProxy = row.kind === "proxy";
      const workspace = isProxy ? row.id.split(":")[1] : row.sessionId;
      this.detail = [
        ...renderInspector(
          {
            title: isProxy
              ? `PROXY LEDGER ${workspace}`
              : `MANAGED LEDGER ${workspace?.slice(0, 8)}`,
            subtitle: row.id,
            icon: isProxy ? ROW_ICONS.proxyEntry : ROW_ICONS.ledgerEntry,
            sections: [
              {
                title: "record",
                fields: [
                  {
                    label: "kind",
                    value: text(b.klass),
                    tone: "muted",
                  },
                  {
                    label: "decision",
                    value: text(b.decision),
                    tone:
                      text(b.decision) === "approved"
                        ? "success"
                        : text(b.decision) === "denied"
                          ? "error"
                          : "warning",
                  },
                  {
                    label: "tool",
                    value: text(b.tool) || "unknown",
                  },
                  {
                    label: "operation",
                    value: row.operationId ?? "n/a",
                    tone: "muted",
                  },
                  {
                    label: "sequence",
                    value: row.id.split(":").pop() ?? "?",
                  },
                ],
              },
              {
                title: isProxy ? "proxy verification" : "managed verification",
                fields: [
                  {
                    label: isProxy ? "status" : "hash chain",
                    value: isProxy
                      ? this.proxy.signed
                        ? "verified"
                        : "integrity only"
                      : (this.managedVerificationStatus ?? "unknown"),
                    tone: isProxy
                      ? this.proxy.signed
                        ? "success"
                        : "warning"
                      : this.managedVerificationStatus?.startsWith("verified")
                        ? "success"
                        : "muted",
                  },
                  {
                    label: isProxy ? "verification key" : "verification note",
                    value: isProxy
                      ? (this.proxy.verificationNote ?? "unknown")
                      : (this.managedVerificationNote ?? "unknown"),
                    tone: "muted",
                  },
                ],
              },
            ],
            hint: "Enter on a hook or agent row acts on it. Other rows are read only.",
          },
          { width: this.layoutColumns },
        ),
        "",
        "RAW RECORD",
        ...row.lines,
      ];
      this.scroll = 0;
      return;
    }
    this.detail = row.lines;
    this.scroll = 0;
  }
  showDocument() {
    if (!this.sessionId || !this.documentPath)
      throw Error("Select a document with Enter or /document path.");
    const d = this.workbench.document(this.sessionId, this.documentPath);
    // The identity of the document renders as aligned fields and the content
    // follows as body. Printing "Revision: x" as a loose line made it look
    // like part of the document rather than a fact about it.
    this.detail = [
      ...renderInspector(
        {
          title: this.documentPath,
          subtitle: `revision ${d.revision?.slice(0, 8) ?? "new"}`,
          icon: ROW_ICONS.document,
          sections: [
            {
              title: "document",
              fields: [
                {
                  label: "revision",
                  value: d.revision ?? "new document",
                  tone: d.revision ? "default" : "warning",
                },
                {
                  label: "size",
                  value: `${(d.content ?? "").length} characters`,
                },
                {
                  label: "conversation",
                  value: this.sessionId ?? "none",
                },
              ],
              // The content is the reason this view exists, so it is body
              // under the facts rather than another field.
              body: (d.content ?? "").split("\n"),
            },
          ],
          hint: "/edit edit · /history revisions · /undo preview recovery · /export document",
        },
        { width: this.layoutColumns },
      ),
    ];
    this.scroll = 0;
  }
  editTarget() {
    if (!this.sessionId || !this.documentPath)
      throw Error("Select a document first.");
    const d = this.workbench.document(this.sessionId, this.documentPath);
    return {
      sessionId: this.sessionId,
      path: this.documentPath,
      revision: d.revision,
      content: d.content ?? "",
    };
  }
  prepareEdit(target                                        , content        ) {
    if (content === target.content) {
      this.notice = "Document unchanged.";
      return;
    }
    this.confirmation = {
      title: `SAVE ${target.path}?`,
      lines: unifiedDiff(target.content, content),
      apply: async () => {
        await this.workbench.editDocument(
          target.sessionId,
          { path: target.path, content, expectedRevision: target.revision },
          "tui-operator",
        );
        this.useSession(target.sessionId);
        this.documentPath = target.path;
        this.showDocument();
        this.announce(
          "saved",
          "success",
          "Saved. The signed change and Undo are in the ledger.",
        );
      },
    };
    this.scroll = 0;
  }
  async prepareUndo(id         ) {
    this.queuedPromptPaused = true;
    const selected = this.items()[this.selected];
    if (this.tab === "ledger" && selected?.operationId && !id) {
      this.useSession(selected.sessionId );
      id = selected.operationId;
    }
    // The documents list is the one tab where the selection is already the
    // undo target: Enter inspects on purpose (reading a document is not
    // aiming an undo), so documentPath would otherwise still name whatever
    // an earlier command opened, and u would undo the wrong file or nothing.
    if (this.tab === "documents" && selected?.path && !id) {
      this.useSession(selected.sessionId );
      this.documentPath = selected.path;
    }
    if (!this.sessionId) throw Error("Select a conversation or ledger entry.");
    const sessionId = this.sessionId;
    const ops = this.workbench.workspace(sessionId).operations;
    const undone = new Set(ops.flatMap((o) => (o.undoes ? [o.undoes] : [])));
    id ??= [...ops]
      .reverse()
      .find(
        (o) =>
          o.path === this.documentPath &&
          o.kind !== "undo" &&
          !undone.has(o.id),
      )?.id;
    if (!id)
      throw Error(
        "Select a document with an outstanding change or use /undo ID.",
      );
    const operationId = id,
      preview = await this.workbench.undoPreview(sessionId, operationId);
    if (!preview.canApply) throw Error(preview.reason);
    this.confirmation = {
      title: `UNDO ${preview.path}?`,
      lines: [
        `Operation: ${operationId}`,
        "Drift check passed: the document still matches the captured image,",
        "and no newer change to this document exists. The preview is",
        "rechecked before anything is applied.",
        ...unifiedDiff(
          preview.before ?? "[does not exist]",
          preview.after ?? "[does not exist]",
        ),
      ],
      apply: async () => {
        this.confirmation = undefined;
        const current = await this.workbench.undoPreview(
          sessionId,
          operationId,
        );
        if (canonicalJson(current) !== canonicalJson(preview)) {
          this.detail = [
            `UNDO PREVIEW CHANGED: ${preview.path}`,
            `Operation: ${operationId}`,
            current.reason ||
              "The captured state no longer matches this review.",
            "Refresh the document and request /undo again. No change was applied.",
            "Latest preview:",
            ...json(current),
          ];
          this.scroll = 0;
          throw Error("The preview changed. Refresh and request /undo again.");
        }
        await this.workbench.undo(sessionId, operationId, "tui-operator");
        this.detail = undefined;
        // An Undo rewrites a managed document and signs the change. It is the
        // most consequential thing the TUI does on its own, so it gets a toast
        // rather than a notice the next keystroke replaces.
        this.announce(
          "undo-done",
          "success",
          "Undo completed and signed. History is preserved.",
        );
      },
    };
    this.scroll = 0;
  }
  async prepareRecovery(
    selection                                                          ,
  ) {
    if (!this.sessionId) throw Error("Select a conversation for recovery.");
    this.queuedPromptPaused = true;
    const sessionId = this.sessionId;
    this.confirmation = undefined;
    const plan = await this.workbench.planRecoveryJob(sessionId, {
      jobId: randomUUID(),
      selection,
    });
    this.lastRecoveryJob = { sessionId, jobId: plan.jobId };
    const lines = [
      `Job: ${plan.jobId}`,
      `Plan digest: ${plan.planDigest}`,
      `Conversation: ${sessionId}`,
      ...(plan.selection.kind === "run"
        ? [`Requested run: ${plan.selection.runId}`]
        : []),
      `Boundary sequence: ${plan.boundary.sequence}`,
      `Boundary digest: ${plan.boundary.digest}`,
      "",
      "Server-verified recovery order:",
      ...plan.steps.flatMap((step) => [
        `#${step.sequence} ${step.operationId}`,
        `Scope: ${step.scope}`,
        ...step.resources.map((resource) => `Resource: ${resource}`),
      ]),
      "",
      "Residuals:",
      ...json(plan.residuals),
      "",
      "Changed resources pause recovery. No automatic retry or historical tool replay.",
      `/recovery ${plan.jobId} refreshes status without applying anything.`,
    ];
    this.detail = ["RECOVERY PREVIEW", ...lines];
    this.scroll = 0;
    if (!plan.steps.length) {
      this.notice =
        "No recoverable steps. Review residuals; no change was applied.";
      return;
    }
    this.confirmation = {
      title: `RECOVER ${plan.steps.length} OPERATIONS?`,
      lines,
      apply: async () => {
        this.confirmation = undefined;
        const current = await this.workbench.recoveryJobStatus(
          sessionId,
          plan.jobId,
        );
        if (canonicalJson(current) !== canonicalJson(plan)) {
          this.detail = [
            "RECOVERY PREVIEW CHANGED",
            ...json(current),
            `/recovery ${plan.jobId} refreshes status only. Request /rewind again for a new review.`,
          ];
          throw Error(
            "The recovery preview changed. Refresh before another action.",
          );
        }
        let result;
        try {
          result = await this.workbench.applyRecoveryJob(
            sessionId,
            {
              jobId: plan.jobId,
              planDigest: plan.planDigest,
              approved: true,
            },
            "tui-operator",
          );
        } catch (error) {
          this.detail = [
            "RECOVERY OUTCOME UNCONFIRMED",
            message(error),
            "",
            ...lines,
            "Refresh status and reconcile before any further action.",
          ];
          throw error;
        }
        this.detail = [
          "RECOVERY RESULT",
          ...json(result),
          "",
          "No automatic retry. Unknown outcomes require reconciliation.",
          `/recovery ${plan.jobId} refreshes status only.`,
          "Request /rewind with explicit operation IDs for a new review.",
        ];
        this.notice = `Recovery ${result.status}. Review outcomes and residuals before any further action.`;
      },
    };
  }
  async showRecovery(jobId         ) {
    const sessionId = jobId ? this.sessionId : this.lastRecoveryJob?.sessionId;
    jobId ||= this.lastRecoveryJob?.jobId;
    if (!sessionId || !jobId)
      throw Error("Select a conversation and use /recovery job-ID.");
    this.confirmation = undefined;
    this.queuedPromptPaused = true;
    const result = await this.workbench.recoveryJobStatus(sessionId, jobId);
    this.useSession(sessionId);
    this.lastRecoveryJob = { sessionId, jobId };
    this.detail = [
      "RECOVERY STATUS",
      ...json(result),
      "",
      "Read-only refresh. No automatic retry. Unknown outcomes require reconciliation.",
      "Request /rewind with explicit operation IDs for a new review.",
    ];
    this.scroll = 0;
  }
  /** Toggle one diff hunk in the open review. Number keys drive this;
   * out of range input only renames the notice, never the selection. */
  toggleHunk(index        ) {
    const confirmation = this.confirmation;
    const hunks = confirmation?.hunks;
    if (!confirmation || !hunks || !hunks.chunks.length) {
      this.notice = "This review has no diff hunks to toggle.";
      return;
    }
    if (!Number.isInteger(index) || index < 0 || index >= hunks.chunks.length) {
      this.notice = `No hunk ${index + 1}. This review has ${hunks.chunks.length}.`;
      return;
    }
    hunks.selected[index] = !hunks.selected[index];
    confirmation.lines = [
      ...(confirmation.hunkBase ?? []),
      ...renderHunkSelection(hunks.chunks, hunks.selected),
    ];
    this.scroll = 0;
    this.notice = hunks.selected.some(Boolean)
      ? `Hunk ${index + 1} ${hunks.selected[index] ? "selected" : "deselected"}. The scope rides with the decision.`
      : "No hunks selected. The decision still covers the full call until the server enforces scope.";
  }
  /** Client side diff scope for the decision reason. Shape: full when the
   * review carries no diff, otherwise hunks:a,b/N. The server does not
   * enforce this yet (another lane); it is recorded so the ledger shows
   * which hunks the operator reviewed. */
  hunkScopeSuffix()         {
    const hunks = this.confirmation?.hunks;
    if (!hunks || !hunks.chunks.length) return "";
    const picked = hunks.selected
      .map((keep, index) => (keep ? index + 1 : -1))
      .filter((index) => index > 0);
    return `[diff-scope: hunks ${picked.length ? picked.join(",") : "none"}/${hunks.chunks.length}]`;
  }
  /** Build the review lines for an approval: evidence first, then an
   * optional selectable diff, then the raw record. Module level so tests
   * can drive it without a running session. */
          approvalReviewLines = approvalReview;
  prepareApproval(kind                       , id         , reason = "") {
    id ??= this.items()[this.selected]?.id;
    if (id?.startsWith("proxy:")) {
      const hold = this.proxy.holds.find((h) => `proxy:${h.holdId}` === id);
      if (!hold) throw Error("Proxy hold is no longer active.");
      const review = this.approvalReviewLines(
        hold                                        ,
      );
      this.confirmation = {
        title: `PROXY ${kind === "approved" ? "APPROVE" : "DENY"}?`,
        lines: review.lines,
        hunks: review.hunks,
        hunkBase: review.hunkBase ? [...review.hunkBase] : undefined,
        apply: async () => {
          const suffix = this.hunkScopeSuffix();
          this.proxy.decide(
            hold.holdId,
            kind,
            suffix ? `${reason} ${suffix}`.trim() : reason,
          );
          this.notice =
            "Decision queued for the proxy. Completion is not yet confirmed.";
        },
      };
      this.scroll = 0;
      return;
    }
    const hold = this.workbench.pending().find((h) => h.holdId === id);
    if (!hold) throw Error("Approval is no longer active. Refresh /approvals.");
    const review = this.approvalReviewLines(
      hold                                        ,
    );
    this.confirmation = {
      title: `${kind === "approved" ? "APPROVE" : "DENY"} TOOL?`,
      lines: [
        ...review.lines,
        "",
        `Reason: ${reason || "(not provided)"}`,
        "External effects may not support Undo.",
      ],
      hunks: review.hunks,
      hunkBase: review.hunkBase
        ? [
            ...review.hunkBase,
            "",
            `Reason: ${reason || "(not provided)"}`,
            "External effects may not support Undo.",
          ]
        : undefined,
      apply: async () => {
        const suffix = this.hunkScopeSuffix();
        if (
          !this.workbench.decide(hold.holdId, {
            kind,
            by: "tui-operator",
            reason: suffix ? `${reason} ${suffix}`.trim() : reason,
          })
        )
          throw Error("Approval expired or was already resolved.");
        this.notice =
          "Decision accepted. Check the ledger for tool completion.";
        this.detail = undefined;
      },
    };
    this.scroll = 0;
  }
  prepareProjectAccess(
    root        ,
    skills                                 ,
    sandboxConfigured        ,
  ) {
    const drifted = skills.filter((skill) => skill.drifted);
    this.confirmation = {
      title: "ALLOW THIS PROJECT TO REACH THE SELECTED MODEL?",
      lines: [
        `Canonical project: ${root}`,
        `Workspace skills: ${skills.length ? skills.map((skill) => skill.id).join(", ") : "none"}`,
        ...(drifted.length
          ? [
              `Lock drift: ${drifted.map((skill) => skill.id).join(", ")}`,
              ...drifted.map(
                (skill) =>
                  `  ${skill.id}: locked ${skill.lockedHash}; current ${skill.actualHash}`,
              ),
            ]
          : ["Lock drift: none"]),
        `Sandbox runtime: ${sandboxConfigured}`,
        "WARNING: project files, selected skill text, command arguments, and command output may be sent to the configured model and retained in local session history.",
        "Secrets inside this project are not protected from the model. The container blocks network and host paths, but can print any mounted project file.",
        "The project tool still requires an explicitly configured custom profile, R3 policy approval, and a local immutable sandbox image.",
      ],
      apply: async () => {
        const result = await this.workbench.confirmProjectAccess(root, skills);
        this.notice = `Project access confirmed. ${result.restoredSessions} matching saved session(s) restored.`;
        this.detail = undefined;
      },
    };
    this.scroll = 0;
  }
  async confirm() {
    const value = this.confirmation;
    if (!value) return;
    // Keep the review available if persistence or revision validation fails.
    await value.apply();
    this.confirmation = undefined;
    this.scroll = 0;
    await this.refresh(true);
  }
  /** Host and path only. A connector URL is operator supplied and this view
   * is a screen that gets shared, so a query string never reaches it. */
          endpoint(value                    ) {
    if (!value) return "builtin";
    try {
      const url = new URL(value);
      return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
    } catch {
      return "(unreadable endpoint)";
    }
  }
  /** The built in document workspace and external servers arrive in one list
   * but only external ones carry an endpoint, so the view reads a uniform row
   * instead of narrowing at every access. */
          connectorRows()                 {
    return this.workbench.connectionState().connectors.map((c) => ({
      id: c.id,
      name: c.name || c.id,
      builtin: "builtin" in c,
      consent: c.consentState,
      tools: [...c.tools],
      endpoint: "url" in c ? this.endpoint(c.url) : "builtin",
      policy: "policy" in c ? c.policy : undefined,
      facts: "facts" in c ? c.facts : undefined,
      mapping: "mapping" in c ? c.mapping : undefined,
    }));
  }
  /** A catalog can carry 100 tools, so the view names a few and counts the
   * rest rather than growing a line past the 80 column budget. */
          toolNames(tools                   , width = 60) {
    if (!tools.length) return "none";
    const shown = tools.slice(0, 6).join(", ");
    return tools.length > 6
      ? `${fit(shown, width - 8)} +${tools.length - 6}`
      : fit(shown, width);
  }
  /** What this connector's policy would do to each tool it lists, read from
   * the same classify-then-decide path a call takes. The blast radius is
   * unknown until a measured probe produces one, and this says so rather
   * than implying a count NOMO does not have. */
          policyPreviewLines(c              ) {
    const preview = this.workbench.policyPreview(c.id);
    return [
      `  decisions ${preview.counts.allow} allow, ${preview.counts.hold} held, ${preview.counts.deny} denied`,
      ...preview.tools.map(
        (tool) =>
          `    ${fit(tool.tool, 20)} ${tool.decision.padEnd(5)} ${tool.klass} ${fit(tool.mapped, 28)}  radius ${tool.blastRadius}`,
      ),
    ];
  }
          connectorList() {
    // Grouped by consent state, because the question an operator opens this
    // view with is "what can I actually use yet", and the answer is one group
    // rather than a consent word repeated down a column. Confirmed comes
    // first because it is the only state that grants a conversation tools.
    const order = ["confirmed", "probed", "staged"]         ;
    const rows = this.connectorRows();
    const groups                                                 = order
      .map((consent) => ({
        consent: String(consent),
        members: rows.filter((c) => c.consent === consent),
      }))
      .filter((group) => group.members.length);
    // Anything the server reports in a state this list does not name still
    // gets shown. An unknown state is not "none".
    const known = new Set(order.map((c) => String(c)));
    const other = rows.filter((c) => !known.has(String(c.consent)));
    if (other.length) groups.push({ consent: "other", members: other });
    return [
      `${ROW_ICONS.connector} CONNECTORS · confirmed connectors expose tools to conversations`,
      "",
      ...groups.flatMap((group) => [
        `${connectorConsentIcon(group.consent)} ${String(group.consent).toUpperCase()} / ${group.members.length}`,
        ...group.members.flatMap((c) => [
          `  ${pad(c.name, 22)} ${String(c.tools.length).padStart(3)} tools  ${fit(c.endpoint, 34)}`,
          `    id ${c.id}`,
          c.builtin
            ? "    in use: the NOMO document workspace"
            : `    next: ${MCP_NEXT[c.consent                         ]?.(c.id) ?? "/mcp inspect " + c.id}`,
        ]),
        "",
      ]),
      "/mcp inspect ID | /mcp add URL [name] | /mcp probe ID",
      "/mcp confirm ID | /mcp rename ID name | /mcp remove ID",
      "Only /mcp probe contacts a server, and only after confirmation.",
    ];
  }
          connectorInspect(c              ) {
    const facts = Object.entries(c.facts ?? {})
        .map(([k, v]) => `${k} -> ${v}`)
        .join(", "),
      mapping = Object.entries(c.mapping ?? {})
        .map(([k, v]) => `${k} -> ${v}`)
        .join(", ");
    return [
      `CONNECTOR ${fit(c.name, 40)}`,
      `  id ${c.id}`,
      `  endpoint ${fit(c.endpoint, 60)}`,
      `  consent ${c.consent}`,
      `  policy ${fit(policySummary(c.policy), 60)}`,
      `  facts ${fit(facts || "none", 60)}`,
      `  mapping ${fit(mapping || "none", 60)}`,
      `  tools ${c.tools.length}: ${this.toolNames(c.tools, 48)}`,
      "",
      ...(c.builtin || !c.tools.length ? [] : this.policyPreviewLines(c)),
      c.builtin
        ? "The document workspace is built in and always in use."
        : `next: ${MCP_NEXT[c.consent](c.id)}`,
    ];
  }
  /** An unknown id or subcommand answers with the usage block, so a mistyped
   * id never reads as a connector that quietly does nothing. */
          mcpUsage(headline        ) {
    this.detail = [
      fit(headline, this.layoutColumns),
      "",
      "CONNECTOR COMMANDS",
      "/mcp lists connectors and the next step for each.",
      "/mcp inspect ID",
      "/mcp add URL [name] stages one and contacts nothing.",
      "/mcp probe ID is the only request, and only on confirmation.",
      "/mcp confirm ID | /mcp rename ID name | /mcp remove ID",
      "",
      "KNOWN CONNECTORS",
      ...this.connectorRows().map((c) => `  ${c.id}  ${c.consent}`),
    ];
    this.scroll = 0;
    this.notice = "Nothing matched that. The usage block is on screen.";
  }
  /** Both staging paths say the same thing, because neither one contacted
   * anything and the next step is the same explicit probe. */
          stagedView(c   
               
                  
                 
                         
   ) {
    return [
      `STAGED ${fit(c.name || c.id, 40)}`,
      `  id ${c.id}`,
      `  endpoint ${fit(this.endpoint(c.url), 60)}`,
      `  consent ${c.consentState}`,
      "",
      "Nothing was contacted. Staging is a local write.",
      `next: /mcp probe ${c.id}`,
    ];
  }
          async mcpCommand(arg        ) {
    this.choose("mcp");
    const space = arg.indexOf(" "),
      verb = (space < 0 ? arg : arg.slice(0, space)).toLowerCase(),
      rest = space < 0 ? "" : arg.slice(space + 1).trim(),
      // rename carries a second argument, so its id is only the first token.
      id = (verb === "rename" ? (rest.split(" ")[0] ?? "") : rest).trim();
    if (!verb) {
      this.notice = "Only a confirmed connector gives a conversation tools.";
      return;
    }
    if (!MCP_COMMANDS.includes(verb))
      return this.mcpUsage(`Unknown connector command: ${verb}`);
    if (verb === "inspect") {
      const c = this.connectorRows().find((row) => row.id === id);
      if (!c) return this.mcpUsage(`Unknown connector: ${id}`);
      this.detail = this.connectorInspect(c);
      this.scroll = 0;
      this.notice = `${c.name} is ${c.consent}.`;
      return;
    }
    if (verb === "add") {
      const [url = "", ...name] = rest.split(/\s+/);
      if (!/^https?:\/\/\S+$/i.test(url))
        throw Error("/mcp add https://host/mcp [name]");
      const staged = (
        await this.workbench.addConnector({
          url,
          ...(name.length ? { name: name.join(" ") } : {}),
        })
      ).connectors.at(-1) ;
      this.detail = [...this.stagedView(staged), "", ...this.connectorList()];
      this.scroll = 0;
      this.notice = `Staged ${staged.name || staged.id}. No request was made.`;
      return;
    }
    const c = this.connectorRows().find((row) => row.id === id);
    if (!c) return this.mcpUsage(`Unknown connector: ${id}`);
    if (c.builtin)
      throw Error(
        "The document workspace is built in. /mcp add stages an external one.",
      );
    if (verb === "probe") {
      this.confirmation = {
        title: `PROBE ${c.name}?`,
        lines: [
          `This is the only request NOMO makes, and it goes to ${c.endpoint}.`,
          "",
          c.consent === "confirmed"
            ? "A confirmed connector returns to probed and needs confirming again."
            : "A staged connector is probed in place. Nothing else is written.",
          "The catalog is kept only if you confirm it with /mcp confirm.",
          "Declining sends no request.",
        ],
        apply: async () => {
          try {
            await this.workbench.probeConnector(c.id);
            const probed = this.connectorRows().find((r) => r.id === c.id) ;
            this.detail = this.connectorInspect(probed);
            this.notice =
              `${probed.name} listed ${probed.tools.length} tools. ` +
              "Confirm it before a conversation may use them.";
          } catch (error) {
            const why = this.redactSecrets(message(error));
            this.detail = [
              `PROBE ${fit(c.name, 40)} REFUSED`,
              "",
              why,
              "",
              `${c.name} stays ${c.consent}. No catalog was kept.`,
            ];
            this.notice = `Probe refused: ${why}`;
          }
          this.scroll = 0;
        },
      };
      this.scroll = 0;
      return;
    }
    if (verb === "confirm") {
      if (c.consent !== "probed")
        throw Error(
          `${c.name} is ${c.consent}. Only a probed catalog can be confirmed.`,
        );
      this.confirmation = {
        title: `CONFIRM ${c.name}?`,
        lines: [
          `New conversations may call ${c.tools.length} tools from ${c.endpoint}.`,
          "",
          ...c.tools.slice(0, 8).map((t) => `  ${fit(t, 60)}`),
          ...(c.tools.length > 8 ? [`  and ${c.tools.length - 8} more`] : []),
          "",
          "A conversation that already started keeps the tools it snapshotted.",
        ],
        apply: async () => {
          await this.workbench.confirmConnector(c.id);
          this.detail = this.connectorList();
          this.scroll = 0;
          this.notice = `${c.name} is confirmed for new conversations.`;
        },
      };
      this.scroll = 0;
      return;
    }
    if (verb === "rename") {
      const name = rest.slice(id.length).trim();
      if (!id || !name) throw Error("/mcp rename connector-ID new-name");
      const renamed = await this.workbench.updateConnector(c.id, { name });
      this.detail = this.connectorList();
      this.scroll = 0;
      this.notice =
        `Renamed to ${renamed.name || name}. It is staged again, ` +
        "so it must be probed before use.";
      return;
    }
    this.confirmation = {
      title: `REMOVE ${c.name}?`,
      lines: [
        `${c.name} and its probed catalog are deleted from this workspace.`,
        "",
        "New conversations will not see it.",
        "A conversation that already started keeps the tools it snapshotted.",
      ],
      apply: async () => {
        this.workbench.removeConnector(c.id);
        this.detail = this.connectorList();
        this.scroll = 0;
        this.notice = `${c.name} removed. New conversations will not see it.`;
      },
    };
    this.scroll = 0;
  }
  async command(raw        )                                  {
    const value = raw.trim();
    if (!value) return;
    const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(value);
    if (!match) {
      if (value.startsWith("!")) {
        await this.runShell(value);
        return;
      }
      if (this.workbench.running()) {
        this.queuePrompt(raw);
        return;
      }
      let prompt = raw;
      if (this.sessionId) {
        const mentions = this.expandMentions(raw, this.sessionId);
        if (mentions.missing.length)
          throw Error(
            `Unknown @path: ${mentions.missing.join(", ")}. Mention a managed document.`,
          );
        prompt = mentions.expanded;
      }
      if (this.mode === "plan")
        prompt =
          "Plan only. Describe the steps and the documents that would " +
          `change. Do not request state changing tools yet.\n\n${prompt}`;
      if (this.sessionId)
        this.workbench.send(this.sessionId, prompt, randomUUID());
      else
        this.useSession(
          (
            await this.workbench.start(
              prompt,
              this.model || undefined,
              randomUUID(),
              this.projectId,
              this.agentId,
            )
          ).id,
        );
      this.choose("chat");
      return;
    }
    const cmd = match[1] ,
      arg = match[2]?.trim() ?? "";
    // Record frecency for palette (slash commands only, not shell or prompts).
    const fullCmd = "/" + cmd;
    const baseState               = {
      query: "",
      selected: 0,
      visible: 8,
      recent: this.paletteState?.recent ?? new Map(),
    };
    const updated = recordPaletteCommand(baseState, fullCmd);
    this.paletteState = { recent: new Map(updated.recent) };
    if (cmd === "runs") {
      this.choose("runs");
      this.filter = arg;
      return;
    }
    if (cmd === "mcp") {
      await this.mcpCommand(arg);
      return;
    }
    const tab = workspaceTab(cmd);
    if (cmd === "models") {
      await this.openModelPicker();
      return;
    }
    if (tab) {
      this.choose(tab);
      this.filter = arg;
      return;
    }
    if (cmd === "expand") {
      this.toolActivityMode = nextToolActivityMode(this.toolActivityMode);
      this.notice = `Agent activity: ${this.toolActivityMode}.`;
      return;
    }
    if (cmd === "quit" || cmd === "exit") return "quit";
    if (cmd === "cancel") {
      this.queuePrompt(undefined);
      this.notice = "Queued prompt cancelled.";
      return;
    }
    if (cmd === "plan") {
      this.setPlanMode();
      return;
    }
    if (cmd === "stats") {
      this.choose("usage");
      this.detail = this.costLines();
      this.scroll = 0;
      return;
    }
    if (cmd === "diff") {
      if (!this.sessionId) throw Error("Select a conversation.");
      // openOperations, not a second copy of the filter: /diff, /diff-next and
      // rediff all have to agree on which changes are outstanding, and three
      // copies of that predicate is how one of them ends up out of step.
      const open = this.openOperations();
      if (!open.length) {
        this.diffView = undefined;
        this.detail = ["No outstanding changes. Every edit is undone or kept."];
        this.scroll = 0;
        return;
      }
      // Each operation gets its own panel rather than one concatenated
      // diff. A single stream of hunks from several files is impossible to
      // review, because a line number means nothing without knowing which
      // file it came from.
      this.diffIndex = 0;
      this.diffView = undefined;
      this.detail = this.diffDetailLines(open);
      this.scroll = 0;
      return;
    }
    if (cmd === "diff-next") {
      const open = this.openOperations();
      if (!open.length) throw Error("No outstanding changes to step through.");
      this.diffIndex = (this.diffIndex + 1) % open.length;
      // A different operation is a different document, so the cursor and the
      // staged flags from the previous one do not carry over.
      this.diffView = undefined;
      this.detail = this.diffDetailLines(open);
      this.scroll = 0;
      this.notice = `Diff ${this.diffIndex + 1} of ${open.length}.`;
      return;
    }
    if (cmd === "keybindings") {
      this.keybindingQuery = arg ?? "";
      this.keybindingDetail = true;
      this.detail = keybindingLines(this.keybindingQuery, 72);
      this.scroll = 0;
      if (this.notice === COMMAND_PALETTE_NOTICE) this.notice = "";
      return;
    }
    if (cmd === "theme") {
      // /theme [color-theme] [symbol-preset] | list | preview | reset
      // Choices are saved in local TUI state by the command submit path;
      // explicit environment values remain higher-priority overrides.
      const themes = Object.keys(COLOR_THEMES)                ;
      const symbols = Object.keys(SYMBOL_SETS)                  ;

      if (!arg) {
        this.detail = [
          `THEME: ${this.themeConfig.colorTheme} + ${this.themeConfig.symbolPreset}`,
          "",
          "Usage: /theme <color-theme> [symbol-preset] | preview <color-theme> [symbol-preset] | list | reset",
          "Theme choices save locally. NOMO_TUI_THEME and NOMO_TUI_SYMBOLS override them on the next launch.",
          "",
          "Color themes:",
          ...themes.map(
            (t) => `  ${t === this.themeConfig.colorTheme ? "▸" : " "} ${t}`,
          ),
          "",
          "Symbol presets:",
          ...symbols.map(
            (s) => `  ${s === this.themeConfig.symbolPreset ? "▸" : " "} ${s}`,
          ),
          "",
          "The nerd preset uses Codicons glyphs and requires a compatible Nerd Font.",
          "Examples: /theme paper unicode  |  /theme dark  |  /theme preview solarized-dark classic",
        ];
        this.scroll = 0;
        return;
      }

      const parts = arg.split(/\s+/);
      const sub = parts[0].toLowerCase();

      if (sub === "list") {
        this.detail = [
          "COLOR THEMES:",
          ...themes.map((t) => `  ${t}`),
          "",
          "SYMBOL PRESETS:",
          ...symbols.map((s) => `  ${s}`),
        ];
        this.scroll = 0;
        return;
      }

      if (sub === "preview") {
        const color = (parts[1] ?? "").toLowerCase()              ;
        const symbol = (parts[2] ?? "").toLowerCase()                ;
        if (!themes.includes(color) || !symbols.includes(symbol)) {
          throw Error(
            `Unknown theme or preset. Use: /theme preview <color> <symbol>`,
          );
        }
        this.themeConfig;
        this.themeConfig = { colorTheme: color, symbolPreset: symbol };
        this.notice = `Preview: ${color} + ${symbol}. ${symbol === "nerd" ? "A compatible Nerd Font is required. " : ""}Press Enter to keep, /theme reset to revert.`;
        this.scroll = 0;
        return;
      }

      if (sub === "reset") {
        this.themeConfig = getThemeConfig(this.env);
        this.notice = `Theme reset to environment defaults (${this.themeConfig.colorTheme} + ${this.themeConfig.symbolPreset}).`;
        this.scroll = 0;
        return;
      }

      const color = sub              ;
      const symbol = (parts[1] ?? "").toLowerCase()                ;

      if (!themes.includes(color))
        throw Error(`Unknown color theme: ${color}. Run /theme list.`);
      if (symbol && !symbols.includes(symbol))
        throw Error(`Unknown symbol preset: ${symbol}. Run /theme list.`);

      this.themeConfig = {
        colorTheme: color,
        symbolPreset: symbol ?? this.themeConfig.symbolPreset,
      };
      this.notice = `Theme ${this.themeConfig.colorTheme} + ${this.themeConfig.symbolPreset} saved locally.${this.themeConfig.symbolPreset === "nerd" ? " A compatible Nerd Font is required." : ""} Explicit NOMO_TUI_THEME/NOMO_TUI_SYMBOLS values override it on the next launch.`;
      this.scroll = 0;
      return;
    }
    if (cmd === "status") {
      this.choose("status");
      this.notice = healthSummary(this.healthChecks());
      return;
    }
    if (cmd === "health") {
      this.choose("status");
      this.notice = healthSummary(this.healthChecks());
      return;
    }
    if (cmd === "discover") {
      this.choose("help");
      this.detail = discoverLines(this.layoutColumns);
      this.scroll = 0;
      return;
    }
    if (cmd === "context") {
      if (!this.sessionId) {
        this.choose("documents");
        this.notice = "Select a conversation for live context numbers.";
        return;
      }
      const ctx = this.contextNumbers();
      this.choose("documents");
      this.detail = [
        `CONTEXT ${this.session()?.title ?? this.sessionId}`,
        "",
        `Model: ${this.session()?.model ?? this.model}`,
        `Messages: ${ctx.messages} in the complete transcript`,
        `Retained context messages: ${ctx.contextMessages ?? "unknown"}`,
        "Context token use and model limit: unknown",
        `Cumulative provider tokens: ${ctx.tokens ?? "unknown"}`,
        "Cost: unknown",
        `Managed documents: ${ctx.docs}`,
        "",
        ...this.workbench
          .documentsList()
          .filter((item) => item.sessionId === this.sessionId)
          .map((item) => `${item.path} ${item.bytes} B`),
      ];
      this.scroll = 0;
      return;
    }
    if (cmd === "permissions") {
      this.choose("policy");
      this.notice =
        "Connector policy stays authoritative. Use /tools for the catalog.";
      return;
    }
    if (cmd === "clear") {
      this.sessionId = undefined;
      this.documentPath = undefined;
      this.choose("chat");
      this.notice =
        "New conversation. Prior history remains available in /sessions.";
      return;
    }
    if (cmd === "cost") {
      this.choose("usage");
      this.detail = this.costLines();
      this.scroll = 0;
      return;
    }
    if (cmd === "queue") {
      if (arg && arg !== "resume") throw Error("/queue [resume]");
      if (arg === "resume") {
        if (this.confirmation)
          throw Error(
            "Finish or cancel the review before resuming queued text.",
          );
        if (this.queueBlockedByRuntime())
          throw Error(
            "The runtime is not ready. Reconcile unknown or stopping work before resuming queued text.",
          );
        if (this.lastRecoveryJob) {
          const status = await this.workbench.recoveryJobStatus(
            this.lastRecoveryJob.sessionId,
            this.lastRecoveryJob.jobId,
          );
          if ("status" in status && status.status === "unknown")
            throw Error(
              "Recovery outcome is unknown. Reconcile it before resuming queued text.",
            );
        }
        this.queuedPromptPaused = false;
      }
      const queued = this.queuedPrompt;
      this.detail = [
        "QUEUED MESSAGE",
        "",
        queued ? `Pending: ${queued}` : "No queued prompt.",
        "",
        this.queuedPromptPaused
          ? "Paused after recovery. Reconcile the outcome, then use /queue resume explicitly."
          : "The queued prompt waits for runtime dispatch to be allowed and for all reviews to close.",
        "Use /cancel to cancel the queued prompt.",
        "",
        ...(queued
          ? ["⚠️ Queued prompt is active - use /cancel to remove it."]
          : []),
      ];
      this.scroll = 0;
      return;
    }
    if (cmd === "compact") {
      this.prepareCompact();
      return;
    }
    if (cmd === "todos") {
      const session = this.session();
      if (!session) throw Error("Select a conversation.");
      const todos = extractTodos(session.events);
      const open = todos.filter((item) => !item.done).length;
      this.detail = [
        `Latest agent checklist, ${open} open of ${todos.length}`,
        "",
        ...(todos.length
          ? todos.map(
              (item) =>
                `${item.done ? "[x]" : "[ ]"} ${item.text} (#${item.seq})`,
            )
          : ["No checklist items in this conversation yet."]),
      ];
      this.scroll = 0;
      return;
    }
    if (cmd === "projects" || cmd === "project") {
      if (cmd === "project" && arg) {
        const project = this.workbench
          .listProjects()
          .find((item) => item.id === arg);
        if (arg !== "none" && !project)
          throw Error("Unknown project. Use /projects for IDs.");
        this.projectId = project?.id;
      }
      this.detail = [
        "PROJECTS",
        `Selected for new conversations: ${this.projectId ?? "none"}`,
        ...this.workbench
          .listProjects()
          .map(
            (item) =>
              `${item.id === this.projectId ? ">" : " "} ${item.id}: ${item.name} / ${item.root}`,
          ),
        "",
        "/project ID selects; /project none clears. Existing conversations do not change.",
        "/project-file path.json creates or updates a project after review.",
        'File fields: {"name":"Project name","root":"/descriptive/root"}',
        "A project root is descriptive. It grants no access to host files.",
      ];
      this.scroll = 0;
      return;
    }
    if (cmd === "project-file") {
      if (!arg) throw Error("/project-file path.json");
      const input = JSON.parse(await readFile(resolve(arg), "utf8"));
      this.confirmation = {
        title: "SAVE PROJECT?",
        lines: [...json(input), "Project roots grant no filesystem authority."],
        apply: async () => {
          const project = this.workbench.upsertProject(input);
          this.projectId = project.id;
          this.detail = ["PROJECT SAVED", ...json(project)];
          this.notice = "Project selected for new conversations only.";
        },
      };
      this.scroll = 0;
      return;
    }
    if (cmd === "agent-file" || cmd === "hook-file") {
      const catalog = this.workbench.agents();
      if (cmd === "hook-file" && !catalog.hooksSupported)
        throw Error(
          "Hook execution is unsupported on this host. No operator allowlist is enabled.",
        );
      if (!arg) throw Error(`/${cmd} path.json`);
      const input = JSON.parse(await readFile(resolve(arg), "utf8"));
      this.confirmation = {
        title: cmd === "agent-file" ? "SAVE AGENT PROFILE?" : "SAVE HOOK?",
        lines: [
          ...json(input),
          "",
          "The Workbench validates tool access, policy and operator allowlists.",
          "Existing conversations keep their profile snapshot.",
        ],
        apply: async () => {
          this.confirmation = undefined;
          if (cmd === "agent-file") {
            const profile = this.workbench.upsertAgent(input);
            this.agentId = profile.id;
            this.detail = ["AGENT PROFILE SAVED", ...json(profile)];
            this.notice = "Profile selected for new conversations only.";
          } else {
            const hook = this.workbench.upsertHook(input);
            this.detail = ["HOOK SAVED", ...json(hook)];
            this.notice = "Hook configuration saved by the Workbench.";
          }
        },
      };
      this.scroll = 0;
      return;
    }
    if (cmd === "hooks") {
      const catalog = this.workbench.agents();
      this.detail = [
        "HOOKS",
        catalog.hooksSupported
          ? "Hooks are validated against the runtime operator allowlist."
          : "Hook execution is unsupported on this host. No operator allowlist is enabled.",
        `Allowed commands: ${catalog.hookCommands.join(", ") || "none"}`,
        ...json(catalog.hooks),
        ...(catalog.hooksSupported
          ? ["/hook-file path.json reviews a hook before saving."]
          : []),
      ];
      this.scroll = 0;
      return;
    }
    if (cmd === "hook") {
      const [action, id] = (arg ?? "").split(/\s+/).filter(Boolean);
      if (action !== "enable" && action !== "disable")
        throw Error("/hook enable id | /hook disable id");
      const catalog = this.workbench.agents();
      const hook = catalog.hooks.find((item) => item.id === id);
      if (!hook) throw Error("Unknown hook. Use /hooks for ids.");
      // Re-saving the same hook with the flag flipped rather than adding one:
      // the id is what ties a hook to its runs, and `upsertHook` re-checks the
      // operator allowlist on the way through either way.
      const saved = this.workbench.upsertHook({
        ...hook,
        enabled: action === "enable",
      });
      this.detail = [`HOOK ${action.toUpperCase()}D`, ...json(saved)];
      this.notice = `Hook ${action}d. Existing conversations keep their hook snapshot.`;
      this.scroll = 0;
      return;
    }
    if (cmd === "agents" || cmd === "agent") {
      if (cmd === "agent" && arg) {
        const agent = this.workbench
          .agents()
          .agents.find((item) => item.id === arg);
        if (!agent) throw Error("Unknown agent. Use /agents for IDs.");
        this.agentId = agent.id;
      }
      this.detail = this.agentsLines();
      this.scroll = 0;
      return;
    }
    if (cmd === "learned") {
      // The rules are mined from the verified chain, not recomputed from a
      // snapshot: `proofs` only ever holds entries `ledger()` returned as
      // verified, so an unverified or tampered refusal cannot teach a rule.
      // Every visible workspace, not just the selected one: a rule learned in
      // one conversation is still in force in the next, and an operator asking
      // what NOMO has learned is asking about the ledger as a whole.
      const learned = [...this.proofs.entries()].flatMap(([id, entries]) =>
        mineLearnedRules(entries).map((rule) => ({ id, rule })),
      );
      const verified = [...this.proofs.values()].reduce(
        (sum, e) => sum + e.length,
        0,
      );
      // Per workspace, mirror the ledger tab's rule rows: a workspace that
      // taught nothing still speaks, and in the tab's words, so the command
      // and the tab cannot disagree about what "nothing observed" means.
      const perWorkspace = [...this.proofs.entries()].flatMap(
        ([id, entries]) => {
          const rules = mineLearnedRules(entries);
          return rules.length
            ? rules.flatMap((rule) => [
                `${id.slice(0, 8)} ${rule.match.tool} (${rule.match.class}) -> ${rule.decision}`,
                `  ${rule.rationale ?? "no rationale recorded"}`,
              ])
            : [
                entries.length
                  ? `0 recurring refusals across ${entries.length} verified ${entries.length === 1 ? "entry" : "entries"}.`
                  : "0 verified entries, so no refusal has been observed and no rule was mined.",
              ];
        },
      );
      this.detail = [
        "LEARNED RULES, mined from the verified chain",
        "",
        ...(verified
          ? [
              `${verified} verified entries, ${learned.length} recurring refusals.`,
              "",
            ]
          : this.proofs.size === 0
            ? [
                "0 verified entries, so no refusal has been observed and no rule was mined.",
                "",
              ]
            : []),
        ...perWorkspace,
        ...(perWorkspace.length ? [""] : []),
        "A learned rule is evidence, not authority: it is appended after the",
        "operator's own rules, and under the mandatory terminal catch-all it never binds.",
      ];
      this.scroll = 0;
      return;
    }
    if (cmd === "config") {
      this.detail = [
        "CONFIG, secret values never print",
        "",
        ...resolveConfig(this.env).map(
          (entry) => `${entry.key}: ${entry.value} [${entry.source}]`,
        ),
      ];
      this.scroll = 0;
      return;
    }
    if (cmd === "settings") {
      const [key, raw] = arg.split(/\s+/).filter(Boolean);
      if (!key) {
        this.settingsOpen = true;
        this.settingsEdit = undefined;
        this.settingsQuery = "";
        this.settingsQueryCursor = 0;
        this.settingsSelected = Math.max(
          0,
          Math.min(this.settingsSelected, this.settingsControls().length - 1),
        );
        this.detail = this.settingsLines();
        this.scroll = 0;
        return;
      }
      if (raw === undefined)
        throw Error("/settings key value, or /settings alone to list them.");
      this.applySetting(key, raw);
      const selected = this.settingsControls().findIndex(
        (row) => row.key === key,
      );
      if (selected >= 0) this.selectSetting(selected);
      this.scroll = 0;
      return;
    }
    if (cmd === "memory") {
      this.detail = this.memoryLines();
      this.scroll = 0;
      return;
    }
    if (cmd === "vim" || cmd === "terminal-setup" || cmd === "output-style")
      throw Error(
        `/${cmd} has no NOMO equivalent. Use /expand for tool output style.`,
      );
    if (cmd === "resume") {
      if (!arg) {
        this.choose("sessions");
        this.notice =
          "Enter opens a conversation. Use /resume NUMBER or /resume ID to open it directly.";
        return;
      }
      const rows = [...this.workbench.list()].reverse();
      const selected =
        rows.find((item) => item.id === arg) ?? rows[Number(arg) - 1];
      if (!selected) throw Error("/resume conversation-number-or-ID");
      this.useSession(selected.id);
      this.choose("chat");
      return;
    }
    if (cmd === "recovery") {
      await this.showRecovery(arg || undefined);
      return;
    }
    if (cmd === "rewind") {
      if (arg) {
        const ids = arg.split(/\s+/);
        if (ids[0] === "run") {
          if (ids.length !== 2) throw Error("/rewind run exact-run-ID");
          await this.prepareRecovery({ kind: "run", runId: ids[1]  });
        } else if (ids.length > 1) {
          await this.prepareRecovery({ kind: "operations", operationIds: ids });
        } else await this.prepareUndo(arg);
        return;
      }
      const sessionId = this.sessionId;
      if (!sessionId) {
        this.choose("ledger");
        this.notice =
          "Select a conversation to rewind its recoverable operations.";
        return;
      }
      this.choose("ledger");
      this.filter = sessionId;
      const recoverable = this.items().findIndex(
        (row) => row.operationId && row.sessionId === sessionId,
      );
      if (recoverable < 0) {
        this.notice = "No recoverable operations in this conversation.";
        return;
      }
      const selected = this.items()[recoverable];
      const deps = selected.label.match(/\(([^)]+)\)/);
      if (deps) {
        this.notice = `Dependency warning: ${deps[1]}. Press u for reviewed Undo.`;
      } else {
        this.notice =
          "Latest recoverable operation selected. Press u for reviewed Undo.";
      }
      this.selected = recoverable;
      return;
    }
    if (cmd === "doctor") {
      const lines           = [];
      const code = await runDoctorCommand(
        arg ? [arg] : [],
        {
          stdout: (line) => {
            lines.push(line);
          },
          stderr: (line) => {
            lines.push(line);
          },
        },
        { env: this.env },
      );
      this.detail = [`doctor exit ${code}`, "", ...lines];
      this.scroll = 0;
      return;
    }
    if (cmd === "conformance") {
      const adapter = arg || "managed-documents";
      if (
        adapter !== "managed-documents" &&
        adapter !== "filesystem.managed" &&
        adapter !== "git.managed"
      )
        throw Error(
          "/conformance managed-documents | filesystem.managed | git.managed",
        );
      // Disposable fixtures only, same command the release gate runs. Slow
      // adapters block the prompt with the busy spinner, never silently.
      const lines           = [];
      const code = await runConformanceCommand(
        ["--adapter", adapter],
        (line) => {
          lines.push(line);
        },
      );
      let summary = "report is not JSON";
      try {
        const report = JSON.parse(lines.join("\n"))     
                          
                      
                              
                            
                                                      
              
         ;
        summary = report.scenarios
          .map((scenario) => {
            const failed = scenario.checks.filter((check) => !check.passed);
            return `${scenario.operation}: ${scenario.passed ? "PASS" : `FAIL ${failed.map((check) => check.id).join(",")}`}`;
          })
          .join(" | ");
        this.detail = [
          `conformance ${adapter} exit ${code}, passed: ${report.passed}`,
          `capability: ${adapter} v1, certification: false`,
          "",
          ...report.scenarios.flatMap((scenario) => [
            `${scenario.operation}: ${scenario.passed ? "PASS" : "FAIL"}`,
            ...scenario.checks.map(
              (check) => `  ${check.passed ? "[+]" : "[x]"} ${check.id}`,
            ),
          ]),
        ];
      } catch {
        this.detail = [`conformance ${adapter} exit ${code}`, ...lines];
      }
      this.scroll = 0;
      this.notice =
        code === 0
          ? `Conformance ${adapter} passed: ${summary}`
          : `Conformance ${adapter} FAILED: ${summary}`;
      return;
    }
    if (cmd === "init") {
      const lines           = [];
      const code = await runInitCommand(
        arg ? [arg] : [],
        {
          stdout: (line) => {
            lines.push(line);
          },
          stderr: (line) => {
            lines.push(line);
          },
        },
        { env: this.env },
      );
      this.detail = [`init exit ${code}`, "", ...lines];
      this.scroll = 0;
      const target = this.sessionId;
      if (target && !this.workbench.running()) {
        try {
          const starter = this.workbench.document(target, "plan.md");
          if (!starter.content?.trim()) {
            await this.workbench.editDocument(
              target,
              { path: "plan.md", content: STARTER_DOC, expectedRevision: null },
              "tui-operator",
            );
            this.notice = "Storage ready. A starter plan.md was created.";
          } else this.notice = "Storage ready. plan.md already exists.";
        } catch (error) {
          this.notice = `Storage ready. Starter doc skipped: ${message(error)}`;
        }
      } else if (!target)
        this.notice = "Storage ready. Open a conversation for plan.md.";
      return;
    }
    if (cmd === "logout") {
      this.workbench.clearProvider();
      this.provider = await this.workbench.providerState();
      this.modelProjection = this.workbench.providerModelsProjection();
      this.model = "";
      this.modelCatalogStatus =
        this.provider.connected && this.provider.models.length > 0
          ? "ready"
          : "unavailable";
      this.notice =
        "Logged out locally. Saved provider profiles were removed; revoke keys with their providers.";
      return;
    }
    if (cmd === "bottom") {
      this.choose("chat");
      this.scroll = -1;
      this.notice = "Following latest messages.";
      return;
    }
    if (cmd === "find") {
      if (!arg) throw Error("/find text: search this conversation");
      const events = this.session()?.events;
      if (!events) throw Error("Select a conversation.");
      const matches = events.filter(
        (e) =>
          e.type !== "message.delta" &&
          e.type !== "run.status" &&
          e.kind !== "usage" &&
          e.text.toLocaleLowerCase().includes(arg.toLocaleLowerCase()),
      );
      this.detail = [
        `Search: ${arg}`,
        `${matches.length} matching messages`,
        "",
        ...transcript(matches),
      ];
      this.scroll = 0;
      this.notice = "Search results / PgUp PgDn scroll / Esc close";
      return;
    }
    if (cmd === "new") {
      this.sessionId = undefined;
      this.documentPath = undefined;
      this.choose("chat");
      if (arg) await this.command(arg);
      return;
    }
    if (cmd === "open") {
      const rows = [...this.workbench.list()].reverse();
      const s = rows.find((s) => s.id === arg) ?? rows[Number(arg) - 1];
      if (!s) throw Error("/open conversation-number-or-ID");
      this.useSession(s.id);
      this.choose("chat");
      return;
    }
    if (cmd === "subagent") {
      const selected = this.session();
      if (!selected?.parentId)
        throw Error("Select a verified spawned child in sessions.");
      if (arg === "cancel") {
        const parentId = selected.parentId;
        const childId = selected.id;
        await this.workbench.verifySubagent(parentId, childId);
        const current = this.workbench.get(childId);
        if (!current || current.parentId !== parentId)
          throw Error(
            "Selected child relationship changed. Refresh the sessions inspector.",
          );
        if (!["running", "queued", "paused"].includes(current.status))
          throw Error("This child is not in a cancellable state.");
        const apply = async () =>
          this.workbench.cancelSubagent(parentId, childId);
        if (current.status === "running" || current.state === "stopping") {
          this.confirmation = {
            title: "CANCEL RUNNING SUBAGENT?",
            lines: [
              `Child: ${childId}`,
              `Parent: ${parentId}`,
              "A dispatched tool may still complete.",
              "Capacity remains occupied until the run settles.",
            ],
            apply,
          };
        } else await apply();
        return;
      }
      if (arg === "review") {
        const result = await this.workbench.subagentResult(
          selected.parentId,
          selected.id,
        );
        if (!result) throw Error("No settled successful result is available.");
        const current = this.workbench.get(selected.id);
        if (
          !current ||
          current.parentId !== selected.parentId ||
          current.runId !== result.runId
        )
          throw Error("Subagent run changed. Refresh the sessions inspector.");
        const preview = escapeTerminalText(result.text);
        const lines = [
          `Child: ${result.childId}`,
          `Parent: ${current.parentId}`,
          `Run: ${result.runId}`,
          `Status: ${current.status}`,
          "Source: latest assistant completion for this successful run.",
          "Content is untrusted; review before acting.",
          "",
          preview,
        ];
        if (result.truncated) {
          this.detail = [
            ...lines,
            "",
            "Delivery unavailable: result may be incomplete.",
          ];
          this.notice =
            "Result may be truncated; preview only, delivery blocked.";
          return;
        }
        this.confirmation = {
          title: "DELIVER SUBAGENT RESULT?",
          lines,
          apply: async () =>
            this.workbench.deliverSubagentResult(
              current.parentId ,
              current.id,
              result.runId,
            ),
        };
        return;
      }
      throw Error("/subagent cancel|review");
    }
    if (cmd === "stop") {
      if (!this.sessionId) throw Error("Select a running conversation.");
      this.workbench.stopRun(this.sessionId);
      this.notice =
        "Stop requested. A dispatched tool may still complete; /runs shows the confirmed state.";
      return;
    }
    if (cmd === "retry" || cmd === "branch") {
      const s = this.session();
      const seq = arg
        ? Number(arg)
        : [...(s?.events ?? [])].reverse().find((e) => e.kind === "user")?.seq;
      if (!s || !seq) throw Error("Select a message to branch from.");
      if (this.workbench.running())
        throw Error("Wait for cancellation to finish.");
      const intent =
        this.branchIntent?.sessionId === s.id &&
        this.branchIntent.seq === seq &&
        this.branchIntent.command === cmd
          ? this.branchIntent
          : (this.branchIntent = {
              sessionId: s.id,
              seq,
              command: cmd,
              key: randomUUID(),
            });
      const child = await this.workbench.branch(s.id, {
        seq,
        snapshotDocuments: true,
        idempotencyKey: intent.key,
      });
      this.branchIntent = undefined;
      this.useSession(child.id);
      this.choose("chat");
      this.notice =
        "Branch created. Historical tools are not replayed. Write your next prompt.";
      if (cmd === "retry") {
        const key = randomUUID();
        this.confirmation = {
          title: "RETRY IN A NEW BRANCH?",
          lines: [
            "The model will respond to the previous prompt again.",
            "Current documents are copied. New tool calls go through NOMO again.",
            "Historical tools are not replayed.",
          ],
          apply: async () => {
            this.workbench.send(
              child.id,
              "Respond to the preceding user message. Inspect existing documents before making changes.",
              key,
            );
          },
        };
      }
      return;
    }
    if (cmd === "model") {
      if (!this.activeModelCatalog().some((model) => model.id === arg))
        throw Error(
          "Select a current connected-provider model ID from /models.",
        );
      this.workbench.patchPreferences({ defaultModel: arg });
      this.model = arg;
      if (this.provider)
        this.provider = { ...this.provider, defaultModel: arg };
      this.notice = `Model for new conversations: ${arg}; active conversation keeps its model.`;
      return;
    }
    if (cmd === "connect" || cmd === "login") {
      if (!arg || arg === "nvidia") {
        this.provider = await this.workbench.providerState({
          reconnectEnvironment: true,
        });
        this.modelProjection = this.workbench.providerModelsProjection();
        this.model = this.provider.defaultModel ?? "";
        this.modelCatalogStatus =
          this.provider.connected && this.provider.models.length > 0
            ? "ready"
            : "unavailable";
        this.detail = this.providerLines();
        this.notice = this.provider.connected
          ? "Current provider is connected. /sources lists local imports; /connect SOURCE-ID selects one."
          : "No provider is connected. Set an API key in the host environment or use /sources and /connect SOURCE-ID. No key is accepted in chat.";
        this.scroll = 0;
        return;
      }
      this.provider = await importDesktopProvider(
        arg,
        this.env,
        this.workbench,
      );
      this.modelProjection = this.workbench.providerModelsProjection();
      this.model = this.provider.defaultModel ?? "";
      this.modelCatalogStatus =
        this.provider.connected && this.provider.models.length > 0
          ? "ready"
          : "unavailable";
      this.notice =
        "Connected to the selected provider. The key is stored encrypted.";
      return;
    }
    if (cmd === "sources") {
      this.detail = json(await desktopSetup(this.env));
      return;
    }
    if (cmd === "filter") {
      this.filter = arg;
      this.selected = 0;
      this.detail = undefined;
      this.keybindingDetail = false;
      return;
    }
    if (cmd === "verify") {
      await this.refresh(true);
      this.choose("ledger");
      // Third parties recheck without this software through the standalone
      // script, so the notice names it instead of hiding that path.
      const standalone =
        "Third parties recheck exports with packages/verifier/verify-ledger.mjs.";
      this.notice =
        this.proofErrors.size || this.proxy.errors.length
          ? `VERIFICATION FAILED. Review /status. ${standalone}`
          : `Verified ${[...this.proofs.values()].reduce((n, v) => n + v.length, 0)} signed entries. ${standalone}`;
      return;
    }
    if (cmd === "document") {
      if (!this.sessionId) throw Error("Select a conversation.");
      this.documentPath = arg;
      this.choose("documents");
      this.showDocument();
      return;
    }
    if (cmd === "edit") return "edit";
    if (cmd === "history") {
      if (!this.sessionId) throw Error("Select a document.");
      this.detail = this.workbench
        .workspace(this.sessionId)
        .operations.filter(
          (o) => !this.documentPath || o.path === this.documentPath,
        )
        .flatMap((o) => [...json(o), ""]);
      this.scroll = 0;
      return;
    }
    if (cmd === "undo") {
      await this.prepareUndo(arg || undefined);
      return;
    }
    if (cmd === "approve" || cmd === "deny") {
      const [id, ...reason] = arg.split(/\s+/);
      this.prepareApproval(
        cmd === "approve" ? "approved" : "denied",
        id || undefined,
        reason.join(" "),
      );
      return;
    }
    // Prompt proposals are inert until one of these names their exact digest.
    // Listing shows diffs; only approve activates, only reject settles, and
    // both refuse an unknown digest rather than guessing. Approval runs through
    // a confirmation that prints the complete proposal first: it is the one
    // path that changes the prompt every later conversation runs under.
    if (cmd === "harness") {
      const [verb = "", ...rest] = arg.split(/\s+/).filter(Boolean);
      if (verb === "scores") {
        const board = measureBoard(
          verifiedScoreCases(this.proofs),
          new Date().toISOString(),
        );
        const firstPass = board.metrics.first_pass_rate;
        this.detail = [
          `HARNESS SCORES, verdict: ${board.verdict}`,
          `First-pass rate: ${firstPass.mean === null ? "unmeasured" : `${(firstPass.mean * 100).toFixed(1)}%`}`,
          `95% CI: ${firstPass.half === null ? "unavailable" : `±${(firstPass.half * 100).toFixed(1)}%`}`,
          `Sample count: ${firstPass.n} first-pass samples`,
          `Case count: ${board.caseCount} verified tool-call cases`,
          `Reason: ${board.reasons.join("; ")}.`,
          ...unmeasuredMetrics(board).map(
            (key) => `${key}: no sample, so no rate can be computed.`,
          ),
          "Descriptive only; never changes a decision or permission.",
        ];
        this.scroll = 0;
        return;
      }
      if (verb === "review") {
        if (!this.sessionId) throw Error("Select a conversation.");
        const sessionId = this.sessionId;
        this.confirmation = {
          title: "REQUEST A HARNESS REVIEW?",
          lines: [
            "This may spend one model call: the reviewer looks for a durable lesson in the signed chain.",
            "The settled-turn interval is skipped because you asked; the harness switch, the cooldown and the nothing-new check still apply, and a refusal costs nothing.",
            "If the conversation is running, the request is recorded and served at the next settled boundary.",
            "The reviewer can only propose. Nothing is activated without your approval.",
          ],
          apply: async () => {
            this.confirmation = undefined;
            const result = await this.workbench.requestHarnessReview(sessionId);
            const note = escapeTerminalText(result.note);
            this.notice = `Harness review ${result.kind}. ${note}`;
            this.detail = [
              `HARNESS REVIEW ${result.kind.toUpperCase()}`,
              "",
              note,
              ...(result.kind === "ran"
                ? [
                    "",
                    "The signed chain records the outcome. /harness lists any proposal awaiting a decision.",
                  ]
                : []),
              "",
              "The reviewer can only propose. Nothing is activated without your approval.",
            ];
            this.scroll = 0;
            await this.refresh(true);
          },
        };
        this.scroll = 0;
        return;
      }
      if (verb === "approve" || verb === "reject") {
        await this.prepareHarnessDecision(rest.join(" "), verb);
        return;
      }
      if (verb && verb !== "cloud" && verb !== "prime-agent")
        throw Error(
          "/harness cloud | prime-agent | scores | review | approve DIGEST | reject DIGEST",
        );
      if (verb) {
        this.workbench.patchPreferences({ defaultAgent: verb });
        this.notice =
          verb === "prime-agent"
            ? "Harness: prime-agent. New conversations route there when the bridge runs."
            : "Harness: cloud. New conversations run in the managed session.";
      }
      const prefs = this.workbench.getPreferences();
      const found = await detectHarnesses(this.env);
      const pending = this.sessionId
        ? await this.workbench.pendingApprovalsFor(this.sessionId)
        : [];
      this.detail = [
        `HARNESS, current default: ${prefs.defaultAgent ?? "cloud"}`,
        "",
        "cloud: managed session in this workspace, approvals in the TUI.",
        "prime-agent: local harness CLI for team agents, needs the bridge.",
        "",
        ...found.map(
          (item) => `${item.id}: ${item.path ?? "not detected on PATH"}`,
        ),
        "",
        ...pending.map(
          (approval) =>
            `${approval.digest.slice(0, 8)}… ${escapeTerminalText(approval.summary)} (${approval.proposal.edits.length} edits)`,
        ),
        pending.length
          ? "/harness approve DIGEST or /harness reject DIGEST opens the exact proposal for confirmation."
          : "No Harness proposals are awaiting an operator decision.",
        "",
        "/harness cloud | /harness prime-agent switches the default; /harness scores reports verified chains.",
        "/harness review asks the reviewer by hand; /harness approve DIGEST or /harness reject DIGEST shows the complete proposal before confirmation.",
      ];
      this.scroll = 0;
      return;
    }
    if (cmd === "rename") {
      if (!this.sessionId) throw Error("Select a conversation.");
      this.workbench.patchSession(this.sessionId, { title: arg });
      return;
    }
    if (cmd === "archive") {
      if (!this.sessionId) throw Error("Select a conversation.");
      this.workbench.patchSession(this.sessionId, { archived: true });
      this.choose("sessions");
      return;
    }
    if (cmd === "policy-file") {
      const space = arg.indexOf(" ");
      const id = arg.slice(0, space),
        path = arg.slice(space + 1);
      if (space < 1) throw Error("/policy-file connector-ID path-to-YAML");
      const policy = await readFile(resolve(path), "utf8");
      if (!loadPolicy(policy).ok) throw Error("Invalid policy.");
      this.confirmation = {
        title: `CHANGE POLICY ${id}?`,
        lines: [
          policy,
          "",
          "Applies to new conversations; existing conversations keep their policy snapshot.",
        ],
        apply: async () => {
          await this.workbench.updateConnector(id, { policy });
          this.notice = "Policy saved. Start a new conversation.";
        },
      };
      return;
    }
    if (cmd === "connector-file") {
      const config = JSON.parse(await readFile(resolve(arg), "utf8"));
      const staged = (await this.workbench.addConnector(config)).connectors.at(
        -1,
      ) ;
      this.choose("tools");
      // Staging contacts nothing, so saying "connected" here would be a claim
      // no request backs.
      this.notice =
        "MCP connector staged. Nothing was contacted; /mcp lists it.";
      this.detail = this.stagedView(staged);
      return;
    }
    if (cmd === "test-connector") {
      this.detail = json(await this.workbench.testConnector(arg));
      return;
    }
    if (cmd === "export") {
      await this.export(arg || "ledger");
      return;
    }
    if (cmd === "providers") {
      const current =
        this.provider?.providerId ??
        this.workbench.getPreferences().defaultProvider;
      this.detail = [
        "PROVIDERS, pick with /connect ID or /login",
        "",
        ...PROVIDER_PRESETS.map(
          (preset) =>
            `${preset.id === current ? "[*]" : "[ ]"} ${preset.id}  ${preset.name}` +
            ("local" in preset && preset.local
              ? "  (local, runs open models like Hermes)"
              : ""),
        ),
        "",
        "Local entries need Ollama or LM Studio running on this machine.",
        "Keys stay encrypted in local provider storage, never in the repo.",
      ];
      this.scroll = 0;
      return;
    }
    if (cmd === "attest") {
      if (!this.sessionId) throw Error("Select a conversation.");
      // Signed slice of this conversation for a third party. The bundle
      // from /export ledger plus this document verify fully offline.
      const doc = await this.workbench.attest(this.sessionId);
      this.detail = [
        `ATTESTATION ${this.session()?.title ?? this.sessionId}`,
        "",
        ...json(doc),
        "",
        "Check offline: standalone verifier --attestation this file.",
      ];
      this.scroll = 0;
      this.notice = `Attested ${doc.entriesCount} entries, head ${doc.headHash.slice(0, 16)}.`;
      return;
    }
    if (cmd === "command-palette") {
      // The palette is a live overlay, not a printed list. Open it explicitly
      // with /command-palette or choose it from a command suggestion.
      // Palette keeps frecency across opens: recent commands float to top.
      this.palette = initialPaletteState(paletteFromCommands(TUI_COMMANDS));
      if (this.paletteState?.recent) {
        this.palette = { ...this.palette, recent: this.paletteState.recent };
      }
      // palette.recent is ReadonlyMap, paletteState.recent is Map
      this.paletteState = { recent: new Map(this.palette.recent) };
      this.choose("help");
      this.detail = undefined;
      this.notice = COMMAND_PALETTE_NOTICE;
      return;
    }
    throw Error("Unknown command. Use /help to see available commands.");
  }
  async export(kind        ) {
    const folder = resolve(this.env.NOMO_EXPORT_DIR ?? "nomo-exports");
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const name = `${kind}-${Date.now()}-${randomUUID().slice(0, 8)}`;
    let content        , suffix        ;
    if (kind === "ledger") {
      await this.refresh(true);
      if (
        this.proofErrors.size ||
        this.proxy.errors.length ||
        (this.proxy.entries.size && !this.proxy.signed)
      )
        throw Error("Export refused: a ledger has not been verified.");
      content =
        [...this.proofs.values(), ...this.proxy.entries.values()]
          .flat()
          .map((e) => JSON.stringify(e))
          .join("\n") + "\n";
      suffix = ".jsonl";
    } else if (kind === "chat") {
      const session = this.session();
      if (!session) throw Error("Select a conversation.");
      content = JSON.stringify(session, null, 2);
      suffix = ".json";
    } else if (kind === "document") {
      const d = this.editTarget();
      content = d.content;
      suffix = ".txt";
    } else throw Error("/export ledger | chat | document");
    const path = join(folder, name + suffix);
    await writeFile(path, content, { flag: "wx", mode: 0o600 });
    this.notice = `Export: ${path}`;
  }
  scrollPage(direction        ) {
    const { offset, height, total } = this.viewport;
    const next = Math.max(
      0,
      Math.min(
        Math.max(0, total - height),
        offset + direction * Math.max(1, height - 2),
      ),
    );
    this.scroll =
      this.tab === "chat" &&
      !this.detail &&
      !this.confirmation &&
      next >= total - height
        ? -1
        : next;
  }
  lines(columns = 76, viewportHeight = 24)           {
    this.layoutColumns = Math.max(1, Math.floor(columns));
    const picker = this.modelPicker;
    if (picker?.open) {
      const matches = modelPickerMatches(picker.models, picker.query);
      motionContext(this.frame);
      const query = [...picker.query];
      query.splice(Math.max(0, Math.min(picker.cursor, query.length)), 0, "▌");
      const queryLabel = picker.query
        ? sanitizeText(query.join(""))
        : "▌(all models)";
      const providers = picker.providers;
      const selectedProvider = providers[picker.providerIndex];
      const catalogStatusLabel =
        picker.catalogStatus === "ready"
          ? "CATALOG READY"
          : picker.catalogStatus === "loading"
            ? "LOADING"
            : picker.catalogStatus === "unavailable"
              ? "UNAVAILABLE"
              : "NOT LOADED";
      const statusLabel = selectedProvider?.importSourceId
        ? `${catalogStatusLabel} · OMP KEY FOUND`
        : catalogStatusLabel;
      const providerRows = providers.map((provider, index) => {
        const selected = index === picker.providerIndex;
        const loading = this.pendingModelCatalogs.has(
          this.modelCatalogKey(provider.id),
        );
        const catalogStatus = selected
          ? picker.catalogStatus
          : loading
            ? "loading"
            : provider.catalogStatus;
        const catalogState =
          catalogStatus === "ready"
            ? provider.attached
              ? "active"
              : "catalog ready"
            : catalogStatus === "loading"
              ? "loading"
              : catalogStatus === "idle"
                ? "not loaded"
                : "unavailable";
        const state = [
          catalogState,
          ...(provider.importSourceId ? ["OMP key found"] : []),
          ...(catalogStatus === "idle" ? ["press →"] : []),
          ...(catalogStatus === "unavailable" ? ["press → retry"] : []),
        ].join(" · ");
        return `${selected && picker.focusedPane === "providers" ? "›" : selected ? "◆" : " "} ${this.providerGlyph(provider.id, provider.name)} ${sanitizeText(provider.name)} · ${state}`;
      });
      const selectedModelId =
        picker.selection === "session"
          ? this.session()?.model
          : selectedProvider?.id === this.modelProjection.activeProviderId
            ? this.model
            : undefined;
      const modelRows = matches.map(
        (model, index) =>
          `${cursorMarker(index === picker.selected)} ${this.providerGlyph(picker.providerId ?? "", selectedProvider?.name)} ${this.modelGlyph()} ${sanitizeText(model.name || model.id)}  ${sanitizeText(model.id)}${model.id === selectedModelId ? (picker.selection === "session" ? "  [current]" : "  [default]") : ""}`,
      );
      const selectedModel = matches[picker.selected];
      const selectedContextWindow = selectedModel
        ? (selectedModel.contextWindow ??
          this.modelContextWindow(
            picker.providerId,
            new Set([selectedModel.id]),
          ))
        : undefined;
      const contextWindowLabel =
        typeof selectedContextWindow === "number" &&
        Number.isSafeInteger(selectedContextWindow) &&
        selectedContextWindow > 0
          ? selectedContextWindow >= 1_000_000
            ? `${Math.round(selectedContextWindow / 100_000) / 10}m`.replace(
                /\.0m$/,
                "m",
              )
            : `${Math.round(selectedContextWindow / 1_000)}k`
          : "context not reported";
      const selectedCapabilities = selectedModel?.capabilities
        ?.map((capability) => sanitizeText(capability))
        .filter(Boolean)
        .join(" · ");
      const selectedPriceParts = [
        ...(selectedModel?.inputPrice
          ? [`input ${sanitizeText(selectedModel.inputPrice)}`]
          : []),
        ...(selectedModel?.outputPrice
          ? [`output ${sanitizeText(selectedModel.outputPrice)}`]
          : []),
      ];
      const selectedPrice =
        selectedPriceParts.length > 0
          ? selectedPriceParts.join(" · ")
          : undefined;
      const selectedModelDetails = selectedModel
        ? [
            `${this.modelGlyph()} ${sanitizeText(selectedModel.name || selectedModel.id)}`,
            contextWindowLabel,
            ...(selectedModel.maxTokens
              ? [`max output ${selectedModel.maxTokens}`]
              : []),
            ...(selectedCapabilities ? [selectedCapabilities] : []),
            ...(selectedPrice ? [selectedPrice] : []),
          ].join(" · ")
        : `${this.providerGlyph(selectedProvider?.id ?? "", selectedProvider?.name)} ${sanitizeText(selectedProvider?.name ?? "No provider")} · ${statusLabel}`;
      const emptyMessage =
        picker.catalogStatus === "loading"
          ? "Loading this provider's catalog…"
          : picker.catalogStatus === "idle"
            ? "Press → to load this provider's models."
            : picker.catalogStatus === "unavailable"
              ? "Catalog unavailable. Press → to retry; check credentials or /connect."
              : "No models match the current filter.";
      const providerSummary = selectedProvider
        ? `${this.providerGlyph(selectedProvider.id, selectedProvider.name)} ${sanitizeText(selectedProvider.name)} · ${picker.providerIndex + 1}/${providers.length} · ${statusLabel}`
        : "No provider configured · /sources then /connect";
      if (columns < 88) {
        const visibleRows = Math.max(1, viewportHeight - 5);
        const activeRows =
          picker.focusedPane === "providers" ? providerRows : modelRows;
        const selectedIndex =
          picker.focusedPane === "providers"
            ? picker.providerIndex
            : picker.selected;
        const windowStart = modelPickerWindowStart(
          selectedIndex,
          activeRows.length,
          visibleRows,
          picker.focusedPane === "providers"
            ? picker.providerWindowStart
            : picker.modelWindowStart,
        );
        const pickerHelp =
          columns < 50
            ? columns < 36
              ? picker.focusedPane === "providers"
                ? "↑↓prov →models ↵load Esc"
                : picker.query
                  ? "↑↓model ←prov Esc clear"
                  : `↑↓model ←prov ↵${picker.selection === "session" ? "use" : "set"} Esc`
              : picker.focusedPane === "providers"
                ? "↑↓ prov · → models · Enter load · Tab panes"
                : picker.query
                  ? "↑↓ models · ← providers · Esc clears · Tab panes"
                  : `↑↓ models · ← providers · Enter ${picker.selection === "session" ? "use" : "select"} · Esc`
            : `${picker.focusedPane === "providers" ? "↑/↓ provider · → models" : "↑/↓ model · ← providers"} · Tab/Shift+Tab switches panes · Type search · Ctrl+←/→ caret · Enter ${picker.selection === "session" ? "use for conversation" : "open/select"} · Esc`;
        return [
          `MODELS · ${matches.length}/${picker.models.length}`,
          `PROVIDER · ${providerSummary}`,
          `FILTER · ${queryLabel}`,
          ...(picker.focusedPane === "providers"
            ? activeRows.length
              ? activeRows.slice(windowStart, windowStart + visibleRows)
              : ["No configured providers."]
            : activeRows.length
              ? activeRows.slice(windowStart, windowStart + visibleRows)
              : [emptyMessage]),
          fit(selectedModelDetails, columns),
          pickerHelp,
        ].map((line) => fit(line, columns));
      }
      const sidebarWidth = Math.min(
        28,
        Math.max(20, Math.floor(columns * 0.27)),
      );
      const listWidth = Math.max(1, columns - sidebarWidth - 3);
      const joinPanes = (sidebar        , content        ) =>
        `${pad(fit(sidebar, sidebarWidth), sidebarWidth)} │ ${fit(content, listWidth)}`;
      const visibleRows = Math.max(1, viewportHeight - 4);
      const providerStart = modelPickerWindowStart(
        picker.providerIndex,
        providerRows.length,
        visibleRows,
        picker.providerWindowStart,
      );
      const modelStart = modelPickerWindowStart(
        picker.selected,
        modelRows.length,
        visibleRows,
        picker.modelWindowStart,
      );
      return [
        joinPanes(
          `PROVIDERS · ${providers.length}`,
          `MODELS · ${selectedProvider?.name ?? "No provider"} · ${matches.length}/${picker.models.length}`,
        ),
        joinPanes(
          providerSummary,
          `⌕ > ${queryLabel} · ${picker.selection === "session" ? "Enter uses model" : "Enter selects"}`,
        ),
        ...Array.from({ length: visibleRows }, (_, index) =>
          joinPanes(
            providerRows[providerStart + index] ?? "",
            modelRows[modelStart + index] ??
              (index === 0 && !modelRows.length ? emptyMessage : ""),
          ),
        ),
        joinPanes("", selectedModelDetails),
        joinPanes(
          "",
          `${picker.focusedPane === "providers" ? "↑/↓ providers · → models" : "↑/↓ models · ← providers"} · Tab/Shift+Tab panes · type search · Ctrl+←/→ caret · Enter ${picker.selection === "session" ? "use model" : "select"} · Esc close`,
        ),
      ];
    }
    if (this.confirmation)
      return [
        this.confirmation.title,
        ...(this.tab === "chat"
          ? []
          : [
              "y confirm · n reject · Esc cancel",
              `PgUp/Dn scroll${this.confirmation.hunks?.chunks.length ? " · 1–9 scope" : ""}`,
            ]),
        "",
        ...this.confirmation.lines.flatMap((l) => l.split("\n")),
      ];
    if (
      this.detail &&
      this.documentPreview &&
      this.tab === "documents" &&
      this.groupTree
    ) {
      const layout = documentPreviewLayout(columns, viewportHeight);
      if (layout.sideBySide) {
        const previewWidth = Math.max(1, layout.width - layout.treeWidth - 2);
        const tree = renderTree(
          this.groupTree.nodes,
          this.groupTree.state,
          layout.treeWidth,
          layout.height,
          { motion: motionContext(this.frame) },
        );
        const preview = wrap(
          ["DOCUMENT PREVIEW", ...this.detail],
          previewWidth,
        );
        return Array.from(
          { length: Math.max(tree.length, preview.length) },
          (_, index) =>
            `${fit(tree[index] ?? "", layout.treeWidth)}  ${fit(preview[index] ?? "", previewWidth)}`,
        );
      }
      const treeHeight = Math.max(1, Math.floor(layout.height / 2));
      return [
        ...renderTree(
          this.groupTree.nodes,
          this.groupTree.state,
          layout.width,
          treeHeight,
          { motion: motionContext(this.frame) },
        ),
        "",
        "DOCUMENT PREVIEW",
        ...this.detail,
      ];
    }
    if (this.settingsOpen) this.detail = this.settingsLines();
    if (this.detail?.[0]?.startsWith("DIFF "))
      this.detail = this.diffDetailLines(
        this.openOperations(),
        columns,
        viewportHeight,
      );
    if (this.detail) return this.detail;
    if (this.tab === "models" && this.modelCatalogStatus !== "ready") {
      const providers = this.modelProjection.providers;
      return [
        `MODELS · ${providers.length} configured provider${providers.length === 1 ? "" : "s"}`,
        "",
        ...(providers.length
          ? providers.map((provider) => {
              const state = provider.attached
                ? `${provider.catalogStatus} · active`
                : "configured · catalog loads on selection";
              return `${this.providerGlyph(provider.id, provider.name)} ${sanitizeText(provider.name)} · ${state}`;
            })
          : ["No provider is configured."]),
        "",
        providers.length
          ? "Alt+M opens the provider and model picker. Catalogs load only for the selected provider."
          : "Configure a provider with /connect, then open Alt+M to browse its models.",
      ];
    }
    if (this.tab === "help") {
      const commands = TUI_COMMANDS.length;
      return [
        `HELP, ${commands} commands, ${DISCOVERY_GROUPS.length} groups`,
        "",
        ...helpLines(columns),
      ];
    }
    if (this.tab === "mcp") {
      const connectors = this.items().flatMap((row) =>
        row.connector ? [row.connector] : [],
      );
      if (!connectors.length)
        return this.filter
          ? [
              `No MCP connectors match ${sanitizeText(this.filter)}.`,
              "Backspace edits the filter. Esc clears it.",
            ]
          : [
              `${getSymbols(this.themeConfig.symbolPreset).icons.network} MCP CONNECTORS · 0`,
              "",
              "No connector records are available.",
              "Use /mcp add URL [name] to stage one locally; staging makes no request.",
            ];
      const byConsent = new Map                ();
      for (const connector of connectors)
        byConsent.set(
          connector.consentState,
          (byConsent.get(connector.consentState) ?? 0) + 1,
        );
      const confirmed = connectors.filter(
        (connector) => connector.consentState === "confirmed",
      );
      const offeredTools = confirmed.reduce(
        (sum, connector) => sum + connector.tools.length,
        0,
      );
      const consentEntries = [...byConsent.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      );
      return [
        `${getSymbols(this.themeConfig.symbolPreset).icons.network} MCP · ${connectors.length} connectors · ${confirmed.length} confirmed · ${offeredTools} tools offered`,
        "Confirmed connectors serve new conversations; NOMO policy still applies.",
        "",
        "CONSENT STATES",
        ...barChart(
          {
            values: consentEntries.map(([, count]) => count),
            labels: consentEntries.map(([state]) => state),
          },
          Math.max(1, columns - 2),
          { motion: motionContext(this.frame) },
        ).map((line) => `  ${line}`),
        "",
        ...this.listRows(),
        "",
        "Type to filter · Up/Down selects · Enter inspects",
        "/mcp probe ID contacts a server only after confirmation · /mcp confirm ID grants the probed connector",
      ];
    }
    if (this.tab === "status") {
      const statusRows = this.items();
      const checks = statusRows.flatMap((row) =>
        row.check ? [row.check] : [],
      );
      const states = ["fail", "unknown", "warn", "skipped", "ok"]         ;
      const counts = states
        .map((state) => ({
          state,
          count: checks.filter((c) => c.state === state).length,
        }))
        .filter((entry) => entry.count > 0);
      const failures = checks.filter((check) => check.state === "fail").length;
      const unknown = checks.filter(
        (check) => check.state === "unknown",
      ).length;
      const warnings = checks.filter((check) => check.state === "warn").length;
      if (!checks.length)
        return this.filter
          ? [
              `No status checks match ${sanitizeText(this.filter)}.`,
              "Backspace edits the filter. Esc clears it.",
            ]
          : [
              "STATUS · no checks reported",
              "",
              "The Workbench returned no subsystem checks.",
            ];
      return [
        `${getSymbols(this.themeConfig.symbolPreset).icons.settings} STATUS · ${healthSummary(checks)}`,
        `${failures} fail · ${unknown} unknown · ${warnings} warn · ${checks.length} checks`,
        "",
        "SUBSYSTEM STATES",
        ...barChart(
          {
            values: counts.map((entry) => entry.count),
            labels: counts.map((entry) => entry.state),
          },
          Math.max(1, columns - 2),
          { motion: motionContext(this.frame) },
        ).map((line) => `  ${line}`),
        "",
        ...this.listRows(),
        "",
        "Up/Down selects · Enter explains evidence and remedy · /verify rechecks signed ledger chains",
        "This screen reports current Workbench checks; selecting a remedy never executes it.",
      ];
    }
    // Tools are grouped by class, low risk first, because that is the order
    // an operator reasoning about authority reads them in. A flat list put a
    // read next to a write with nothing between them.
    if (this.tab === "tools") {
      const summaries                = this.workbench
        .availableTools(this.sessionId)
        .tools.map((tool) => ({
          id: tool.id,
          name: tool.name,
          klass: tool.klass,
          source: tool.source,
          description: tool.description,
          capturedUndo: tool.capturedUndo,
          inputSchema: tool.inputSchema,
        }));
      const shown = filterTools(summaries, this.filter);
      const browser = toolRows(shown, columns, {
        selected: this.selected,
        motion: motionContext(this.frame),
      });
      const byClass = new Map                ();
      for (const tool of summaries) {
        const klass = tool.klass ?? "unknown";
        byClass.set(klass, (byClass.get(klass) ?? 0) + 1);
      }
      const classCounts = [...byClass.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([klass, count]) => `${count} ${klass}`)
        .join(", ");
      return [
        `${getSymbols(this.themeConfig.symbolPreset).icons.tool} TOOLS · ${summaries.length} available · ${classCounts}`,
        "",
        ...browser,
        "",
        this.filter
          ? `Filter: ${this.filter} (Esc clears, Backspace deletes)`
          : "Type to filter by name, class, source or description.",
        "Type to filter. Up/Down selects and wraps. Home/End jumps to either end; PageUp/Down pages. Enter inspects a tool; inspection never executes it.",
      ];
    }
    if (this.tab === "chat")
      return this.session()
        ? [
            // The shape of the conversation before the words of it. An
            // operator opening a chat after an hour away wants to see where it
            // got to, and scrolling a wall of events to find that is the work
            // the strip is meant to remove.
            ...renderActivity(
              buildActivity(this.session() .events),
              this.layoutColumns,
              {
                motion: motionContext(this.frame),
                symbolPreset: this.themeConfig.symbolPreset,
              },
            ),
            "",
            ...transcript(this.session() .events),
          ]
        : [
            "NEW CONVERSATION",
            "",
            `Model: ${this.model || "not connected"}`,
            `Project: ${this.projectId ?? "none"} | Agent: ${this.agentId ?? "runtime default"}`,
            "Press i to type; Enter to send; Shift+Enter or Ctrl+J for a new line.",
            "Example: Create a plan and save it to plan.md.",
            "",
            "/connect shows provider setup without switching existing conversations.",
          ];
    // The policy tab used to open with the raw YAML and then a JSON dump per
    // connector. The question it exists to answer is what this workspace is
    // allowed to do, and that is a summary of classes and decisions, not the
    // text of the rules. The YAML stays below for the operator who wants it.
    if (this.tab === "policy") {
      const connectors = this.workbench.connectionState().connectors;
      const policyTools = connectors.flatMap((c) =>
        c.tools.map((tool) => ({ name: tool, source: c.name || c.id })),
      );
      const byClass = new Map                ();
      for (const connector of connectors) {
        const summary = policySummary(
          "policy" in connector ? (connector.policy          ) : undefined,
        );
        byClass.set(String(summary), (byClass.get(String(summary)) ?? 0) + 1);
      }
      const byConsent = new Map                ();
      for (const connector of connectors) {
        const consent =
          "consentState" in connector ? connector.consentState : "unknown";
        byConsent.set(consent, (byConsent.get(consent) ?? 0) + 1);
      }
      const consentCounts = [...byConsent.entries()]
        .map(([state, count]) => `${count} ${state}`)
        .join(", ");
      return [
        `POLICY, ${connectors.length} connectors: ${consentCounts}`,
        "",
        ...renderInspector(
          {
            title: "POLICY",
            subtitle: "R0 reads; R1 writes with capture and verified Undo",
            icon: ROW_ICONS.harness,
            sections: [
              {
                title: "what is allowed",
                fields: [
                  { label: "classes", value: "R0 read, R1 write, R2 bulk" },
                  {
                    label: "unknown tools",
                    value: "denied",
                    tone: "success",
                  },
                  {
                    label: "expired approval",
                    value: "cannot release a tool",
                    tone: "warning",
                  },
                  {
                    label: "snapshot",
                    value: "each conversation takes its own copy",
                  },
                  {
                    label: "connectors",
                    value: `${connectors.length} connected, ${policyTools.length} tools offered`,
                  },
                ],
              },
              {
                title: "per connector",
                fields: connectors.map((c) => ({
                  label: (c.name || c.id).slice(0, 22),
                  value: `${c.tools.length} tools, ${c.consentState}`,
                  tone: c.consentState === "confirmed" ? "success" : "warning",
                })),
              },
            ],
            hint: "/policy-file ID path.yaml changes the policy for one connector.",
          },
          { width: columns },
        ),
        "",
        "DEFAULT POLICY FOR EXTERNAL MCP",
        ...DEFAULT_POLICY.split("\n"),
        "",
        ...this.items().flatMap((r) => [r.label, ...r.lines, ""]),
      ];
    }
    const rows = this.items();
    if (this.groupTree && !rows.length && this.filter) {
      return [
        `No matches for ${sanitizeText(this.filter)}.`,
        "Backspace edits the filter. Esc clears it.",
      ];
    }
    if (this.tab === "runs") {
      const runs = rows.flatMap((row) => (row.run ? [row.run] : []));
      if (!runs.length)
        return this.filter
          ? [
              `No runs match ${sanitizeText(this.filter)}.`,
              "Backspace edits the filter. Esc clears it.",
            ]
          : [
              `${getSymbols(this.themeConfig.symbolPreset).icons.run} RUNS · 0 recorded`,
              "",
              "No run records are available in this workspace yet.",
              "Runs appear here after a conversation emits run events.",
              "",
              "Type to filter · /sessions opens conversation history",
            ];
      const byState = new Map                ();
      for (const run of runs)
        byState.set(run.state, (byState.get(run.state) ?? 0) + 1);
      const active = runs.filter((run) =>
        ["running", "awaiting-approval", "stopping"].includes(run.state),
      ).length;
      const reconciliation = runs.filter((run) => run.reconcileRequired).length;
      const progressValues = runs.flatMap((run) =>
        typeof run.progress === "number" &&
        Number.isFinite(run.progress) &&
        run.progress >= 0 &&
        run.progress <= 1
          ? [run.progress * 100]
          : [],
      );
      const stateEntries = [...byState.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      );
      const chart = barChart(
        {
          values: stateEntries.map(([, count]) => count),
          labels: stateEntries.map(([state]) => state),
        },
        Math.max(1, columns - 2),
        { motion: motionContext(this.frame) },
      );
      const progressSummary = progressValues.length
        ? `Progress reported for ${progressValues.length}/${runs.length} runs · average ${Math.round(progressValues.reduce((sum, value) => sum + value, 0) / progressValues.length)}%`
        : `Progress not reported for these ${runs.length} runs`;
      return [
        `${getSymbols(this.themeConfig.symbolPreset).icons.run} RUNS · ${runs.length} recorded · ${active} active · ${reconciliation} need reconciliation`,
        progressSummary,
        "",
        "STATUS DISTRIBUTION",
        ...chart.map((line) => `  ${line}`),
        "",
        ...this.listRows(),
        "",
        "Type to filter · Up/Down selects · Enter inspects · /resume ID opens the conversation",
        "Unknown outcomes stay marked for reconciliation; inspection does not change run state.",
      ];
    }
    if (this.tab === "sessions" && !rows.length)
      return [
        "SESSIONS · 0 conversations",
        "",
        "No conversations yet.",
        "Start one in Chat to see it here.",
      ];
    // Documents group by folder and conversations by state, for the same</path>
    // reason: a flat list of forty rows cannot be scanned, and a group the
    // operator does not care about should be one keystroke to hide rather
    // than forty rows to scroll past.
    if (this.groupTree && rows.length) {
      // A folder tree answers "what is here". It does not answer "what
      // happened to it", so the recovery line sits under it rather than
      // replacing it. Two panes for one tab would mean the operator has to
      // choose which question to be able to ask at all.
      const openOps = this.recoveryRows().filter(
        (row) => row.recoverable === "recoverable",
      );
      const allSessions = this.workbench.list();
      const visibleSessionIds = new Set(rows.map((row) => row.id));
      const visibleSessions = allSessions.filter((session) =>
        visibleSessionIds.has(session.id),
      );
      const sessionIcons = getSymbols(this.themeConfig.symbolPreset).icons;
      const activeSessionCount = visibleSessions.filter(
        (session) => session.status === "running",
      ).length;
      const attentionSessionCount = visibleSessions.filter(
        (session) =>
          session.status === "failed" ||
          session.status === "queued" ||
          session.status === "paused",
      ).length;
      const sessionSummary =
        this.tab === "sessions"
          ? fit(
              `${sessionIcons.session} SESSIONS · ${visibleSessions.length}/${allSessions.length} · ${activeSessionCount} running · ${attentionSessionCount} attention`,
              columns,
            )
          : undefined;
      const sessionLayout =
        this.tab === "sessions"
          ? sessionInspectorLayout(columns, viewportHeight)
          : undefined;
      if (sessionSummary && sessionLayout) {
        const selectedNode = flattenTree(
          this.groupTree.nodes,
          this.groupTree.state,
        )[this.groupTree.state.cursor];
        const selectedSession =
          selectedNode && !selectedNode.hasChildren
            ? this.workbench.get(selectedNode.id)
            : undefined;
        const selectedGroupCount = selectedNode?.hasChildren
          ? visibleSessions.filter(
              (session) =>
                sessionGroup(session.status, session.archived === true) ===
                selectedNode.id,
            ).length
          : undefined;
        const sessionTitle =
          selectedSession?.title || selectedSession?.id || "Sessions";
        const stateTone =
          selectedSession?.status === "failed"
            ? "error"
            : selectedSession?.status === "running"
              ? "accent"
              : selectedSession?.status === "queued" ||
                  selectedSession?.status === "paused"
                ? "warning"
                : selectedSession?.status === "idle"
                  ? "success"
                  : "muted";
        const sessionRuns = selectedSession
          ? this.workbench
              .runs()
              .filter((run) => run.sessionId === selectedSession.id)
          : [];
        const latestSessionRun = sessionRuns.at(-1);
        const agentCatalog = this.workbench.agents().agents;
        const relatedSessions = selectedSession
          ? allSessions.filter(
              (session) => session.parentId === selectedSession.id,
            )
          : [];
        const activeChildSessions = relatedSessions.filter(
          (session) => session.status === "running",
        ).length;
        const recordedAgentProfiles = new Set(
          [
            selectedSession?.agent,
            ...relatedSessions.map((session) => session.agent),
          ].filter((agent)                  => typeof agent === "string"),
        );
        const usageEvents =
          selectedSession?.events.filter((event) => event.kind === "usage") ??
          [];
        const usageTokenSeries = usageEvents
          .map((event) => {
            const total = event.payload?.total_tokens;
            if (
              typeof total === "number" &&
              Number.isFinite(total) &&
              total >= 0
            )
              return total;
            const input =
              event.payload?.prompt_tokens ?? event.payload?.input_tokens;
            const output =
              event.payload?.completion_tokens ?? event.payload?.output_tokens;
            return typeof input === "number" &&
              Number.isFinite(input) &&
              input >= 0 &&
              typeof output === "number" &&
              Number.isFinite(output) &&
              output >= 0
              ? input + output
              : undefined;
          })
          .filter((value)                  => value !== undefined);
        const retainedEvents = selectedSession?.events ?? [];
        const retainedEventCount = (kind                      ) =>
          retainedEvents.filter((event) => event.kind === kind).length;
        const usageTotal = (keys                   ) => {
          let total = 0;
          let count = 0;
          for (const event of usageEvents) {
            const value = keys
              .map((key) => event.payload?.[key])
              .find(
                (candidate) =>
                  typeof candidate === "number" &&
                  Number.isFinite(candidate) &&
                  candidate >= 0,
              );
            if (typeof value === "number") {
              total += value;
              count += 1;
            }
          }
          return count ? String(total) : "not reported";
        };
        const recentSessionActivity = (selectedSession?.events ?? [])
          .filter((event) => event.kind !== "usage")
          .slice(-5)
          .map((event) => {
            const timestamp = sessionTimestamp(event.at);
            if (event.kind === "tool") {
              const tool =
                typeof event.payload?.tool === "string"
                  ? sanitizeText(event.payload.tool)
                  : "tool";
              const action =
                event.type === "tool.started" ? "started" : "completed";
              return `${sessionIcons.tool} ${timestamp} · ${tool} ${action}`;
            }
            if (event.kind === "error")
              return `${stateIcon("failed")} ${timestamp} · run error`;
            if (event.kind === "user")
              return `${sessionIcons.composer} ${timestamp} · prompt submitted`;
            if (event.kind === "assistant")
              return `${sessionIcons.agent} ${timestamp} · agent response`;
            return `${sessionIcons.usage} ${timestamp} · ${sanitizeText(event.type ?? event.kind)}`;
          });
        const recordedAgentLabel = selectedSession?.agent
          ? `${agentCatalog.find((agent) => agent.id === selectedSession.agent)?.name ?? selectedSession.agent} (${selectedSession.agent})`
          : "not recorded";
        const inspector                = selectedSession
          ? {
              title: sessionTitle,
              subtitle: selectedSession.id,
              icon: sessionIcons.session,
              sections: [
                {
                  title: "conversation",
                  fields: [
                    {
                      label: `${stateIcon(selectedSession.status)} status`,
                      value: selectedSession.status,
                      tone: stateTone,
                    },
                    {
                      label: "pinned",
                      value: selectedSession.pinned ? "yes" : "no",
                      tone: selectedSession.pinned ? "accent" : "muted",
                    },
                    {
                      label: `${sessionIcons.provider} provider`,
                      value: selectedSession.provider || "not set",
                    },
                    {
                      label: `${sessionIcons.model} model`,
                      value: selectedSession.model || "not set",
                    },
                    {
                      label: `${sessionIcons.document} workspace`,
                      value: selectedSession.workspace || "not set",
                    },
                    {
                      label: `${sessionIcons.document} project`,
                      value: selectedSession.project || "not recorded",
                    },
                    {
                      label: "Git worktree",
                      value: "not recorded for this session",
                    },
                    {
                      label: "Git branch",
                      value: "not recorded for this session",
                    },
                    {
                      label: `${sessionIcons.agent} agent profile`,
                      value: recordedAgentLabel,
                    },
                  ],
                },
                {
                  title: "activity · retained",
                  fields: [
                    {
                      label: `${sessionIcons.time} created`,
                      value: sessionTimestamp(selectedSession.createdAt),
                    },
                    {
                      label: `${sessionIcons.time} updated`,
                      value: sessionTimestamp(
                        selectedSession.updatedAt ?? selectedSession.createdAt,
                      ),
                    },
                    {
                      label: `${sessionIcons.session} messages`,
                      value:
                        selectedSession.contextMessages === undefined
                          ? "unknown"
                          : String(selectedSession.contextMessages),
                    },
                    {
                      label: `${sessionIcons.tokens} run tokens`,
                      value: String(selectedSession.runTokenCount),
                    },
                    {
                      label: `${sessionIcons.retry} continuations`,
                      value: String(selectedSession.continuationCount),
                    },
                    {
                      label: `${sessionIcons.usage} retained events`,
                      value: String(selectedSession.events.length),
                    },
                    {
                      label: `${sessionIcons.composer} retained prompts`,
                      value: String(retainedEventCount("user")),
                    },
                    {
                      label: `${sessionIcons.agent} retained replies`,
                      value: String(retainedEventCount("assistant")),
                    },
                    {
                      label: `${sessionIcons.tool} tool events`,
                      value: String(retainedEventCount("tool")),
                    },
                    {
                      label: `${stateIcon("failed")} errors`,
                      value: String(retainedEventCount("error")),
                      tone: retainedEventCount("error") ? "error" : "muted",
                    },
                    {
                      label: `${sessionIcons.run} runs`,
                      value: String(sessionRuns.length),
                    },
                    {
                      label: `${sessionIcons.run} latest run`,
                      value: latestSessionRun
                        ? `${latestSessionRun.status} · ${latestSessionRun.steps} tool steps`
                        : "not recorded",
                    },
                    {
                      label: `${sessionIcons.agent} agent profiles`,
                      value: String(recordedAgentProfiles.size),
                    },
                    {
                      label: `${sessionIcons.session} child conversations`,
                      value: `${relatedSessions.length} total · ${activeChildSessions} active`,
                    },
                  ],
                  body: recentSessionActivity.length
                    ? recentSessionActivity
                    : ["No retained activity events."],
                },
                {
                  title: "provider usage · reported",
                  fields: [
                    {
                      label: `${sessionIcons.usage} usage records`,
                      value: String(usageEvents.length),
                    },
                    {
                      label: `${sessionIcons.tokens} input tokens`,
                      value: usageTotal(["prompt_tokens", "input_tokens"]),
                    },
                    {
                      label: `${sessionIcons.tokens} output tokens`,
                      value: usageTotal(["completion_tokens", "output_tokens"]),
                    },
                    {
                      label: `${sessionIcons.tokens} total tokens`,
                      value: usageTotal(["total_tokens"]),
                    },
                  ],
                  body:
                    usageTokenSeries.length > 1
                      ? [
                          `${sessionIcons.tokens} tokens per reported response · recent ${Math.min(24, usageTokenSeries.length)}`,
                          sparkline(
                            { values: usageTokenSeries.slice(-24) },
                            Math.max(
                              1,
                              (sessionLayout.sideBySide
                                ? columns - sessionLayout.treeWidth - 3
                                : columns) - 4,
                            ),
                          ),
                        ]
                      : usageTokenSeries.length === 1
                        ? [
                            `${sessionIcons.tokens} ${usageTokenSeries[0]} tokens reported in one usage record; a trend needs more records.`,
                          ]
                        : [
                            "No provider-reported token usage is retained for this conversation.",
                          ],
                },
                ...(selectedSession.parentId
                  ? [
                      {
                        title: "lineage",
                        fields: [
                          {
                            label: "parent",
                            value: selectedSession.parentId,
                          },
                        ],
                      },
                    ]
                  : []),
              ],
              hint: "Enter opens this conversation in Chat · branch/worktree are shown only when recorded",
            }
          : {
              title: selectedNode?.id
                ? `${selectedNode.id} sessions`
                : "Sessions",
              subtitle: `${selectedGroupCount ?? visibleSessions.length} conversations in this status group`,
              icon: sessionIcons.session,
              sections: [
                {
                  title: "selection",
                  fields: [
                    {
                      label: "type",
                      value: selectedNode?.hasChildren
                        ? "status group"
                        : "conversation",
                    },
                    {
                      label: "status",
                      value: selectedNode?.id ?? "unknown",
                    },
                    {
                      label: "rows",
                      value: String(
                        selectedGroupCount ?? visibleSessions.length,
                      ),
                    },
                    {
                      label: "group",
                      value: selectedNode?.hasChildren
                        ? this.groupTree.state.expanded.has(selectedNode.id)
                          ? "expanded"
                          : "collapsed"
                        : "select a conversation",
                    },
                  ],
                },
              ],
              hint: "Enter opens or closes a group · Enter on a conversation opens Chat",
            };
        const header = [
          sessionSummary,
          fit(
            collapsedSummary(this.groupTree.state, this.groupTree.nodes, {
              group: "group",
              row: "conversation",
            }),
            columns,
          ),
        ];
        const paneHeight = sessionLayout.paneHeight;
        if (sessionLayout.sideBySide) {
          const treeWidth = Math.min(
            sessionLayout.treeWidth,
            Math.max(1, columns - 6),
          );
          const inspectorWidth = Math.max(1, columns - treeWidth - 3);
          const treeRows = renderTree(
            this.groupTree.nodes,
            this.groupTree.state,
            treeWidth,
            paneHeight,
            { motion: motionContext(this.frame) },
          );
          const inspectorRows = renderInspector(inspector, {
            width: inspectorWidth,
            height: paneHeight,
            motion: motionContext(this.frame),
          });
          const divider = getSymbols(this.themeConfig.symbolPreset).frame.v;
          const panes = Array.from(
            { length: paneHeight },
            (_, index) =>
              `${fit(treeRows[index] ?? "", treeWidth)} ${divider} ${fit(inspectorRows[index] ?? "", inspectorWidth)}`,
          );
          return [...header, ...panes];
        }

        // Narrow or short terminals keep both the selectable tree and the
        // selected session inspector visible in a vertical stack. The outer
        // viewport scrolls the detail when its retained activity is longer.
        const treeHeight = sessionLayout.treeHeight;
        const treeRows = renderTree(
          this.groupTree.nodes,
          this.groupTree.state,
          columns,
          treeHeight,
          { motion: motionContext(this.frame) },
        );
        const inspectorRows = renderInspector(inspector, {
          width: columns,
          height: Math.max(1, paneHeight - treeHeight - 1),
          motion: motionContext(this.frame),
        });
        return [
          ...header,
          ...treeRows,
          "",
          ...inspectorRows,
          fit(
            "Up/Down select · Enter opens · Type filters · Esc returns to Chat",
            columns,
          ),
        ];
      }
      const footer = [
        "",
        collapsedSummary(
          this.groupTree.state,
          this.groupTree.nodes,
          this.tab === "documents"
            ? { group: "folder", row: "document" }
            : { group: "group", row: "conversation" },
        ),
        ...(this.tab === "documents"
          ? [
              openOps.length
                ? `${openOps.length} of ${this.recoveryRows().length} changes can still be undone. /diff steps through them.`
                : "Every change has been decided: undone or kept.",
            ]
          : []),
        this.tab === "documents"
          ? "Type filters. Up/Down moves the tree cursor. Enter opens document details or toggles a folder. Home/End jump to the first/last row; PageUp/Down or Left/Right pages. /document path opens a document."
          : "Type filters. Up/Down moves the tree cursor. Enter opens a conversation or toggles a group. Home/End jump to the first/last row; PageUp/Down or Left/Right pages.",
      ];
      const header = sessionSummary ? [sessionSummary, ""] : [];
      return [
        ...header,
        ...renderTree(
          this.groupTree.nodes,
          this.groupTree.state,
          Math.max(1, columns),
          Math.max(1, viewportHeight - header.length - footer.length),
          { motion: motionContext(this.frame) },
        ),
        ...footer,
      ];
    }
    // The tools tab is answered earlier, by the grouped browser, so the
    // /mcp hint that used to sit here has no tab left to attach to.
    // Models gets a hint because Enter changes the future default while
    // existing conversations keep their own model snapshots.
    if (this.tab === "models" && rows.length) {
      const activeProvider = this.modelProjection.providers.find(
        (provider) => provider.id === this.modelProjection.activeProviderId,
      );
      const providerName = sanitizeText(
        activeProvider?.name ??
          this.provider?.providerId ??
          "connected provider",
      );
      return [
        `${getSymbols(this.themeConfig.symbolPreset).icons.model} MODELS · ${rows.length} models · ${providerName}`,
        `Default for new conversations: ${sanitizeText(this.model || "not set")}`,
        `${this.modelProjection.providers.length} configured provider profiles · Alt+M switches provider/model`,
        "",
        ...this.listRows(),
        "",
        "Enter sets the default for new conversations. /model ID selects by name; existing conversations keep their model.",
      ];
    }
    // The usage tab is one row per record, which answers "what happened" and
    // not "what did it cost me". Records arrive newest last, so the summary
    // leads with the shape and the list follows it.
    if (this.tab === "usage" && rows.length) {
      const known = rows
        .map((row) => row.usage?.totalTokens)
        .filter(
          (value)                  =>
            typeof value === "number" && Number.isFinite(value) && value >= 0,
        );
      const tokensByModel = new Map                ();
      for (const row of rows) {
        const model = row.usage?.model;
        const total = row.usage?.totalTokens;
        if (
          !model ||
          typeof total !== "number" ||
          !Number.isFinite(total) ||
          total < 0
        )
          continue;
        tokensByModel.set(model, (tokensByModel.get(model) ?? 0) + total);
      }
      const topModels = [...tokensByModel.entries()]
        .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
        .slice(-5);
      const modelChart = topModels.length
        ? [
            `${getSymbols(this.themeConfig.symbolPreset).icons.model} REPORTED TOKENS BY MODEL`,
            ...barChart(
              {
                values: topModels.map(([, total]) => total),
                labels: topModels.map(([model]) => model),
              },
              Math.max(1, columns - 2),
              { motion: motionContext(this.frame) },
            ).map((line) => `  ${line}`),
            "",
          ]
        : [];
      return [
        `${getSymbols(this.themeConfig.symbolPreset).icons.usage} USAGE · ${rows.length} records across ${new Set(rows.map((r) => r.sessionId)).size} conversations`,
        "",
        `Reported token totals: ${known.length}/${rows.length} · cost: not reported`,
        known.length
          ? `tokens, last ${Math.min(24, known.length)} records  ${sparkline({ values: known.slice(-24) }, 40)}`
          : "No token counts reported yet.",
        known.length
          ? `median ${median(known)} / peak ${Math.max(...known)} / total ${known.reduce((a, b) => a + b, 0)} tokens`
          : "",
        "",
        ...modelChart,
        "Each record, newest last.",
        ...this.listRows(),
      ];
    }
    // The sessions tab falls through to the default list below. It gets a
    // summary of its own because the question it answers is not "which
    // conversation" but "what state is everything in", and a flat list of
    // titles says nothing about that until it is read.
    if (this.tab === "sessions" && rows.length) {
      const byState = new Map                ();
      for (const row of rows) {
        const match = /\[([^\]]+)\]/.exec(row.label);
        const state = match?.[1] ?? "unknown";
        byState.set(state, (byState.get(state) ?? 0) + 1);
      }
      const counts = [...byState.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([state, count]) => `${count} ${state}`)
        .join(", ");
      return [
        `${getSymbols(this.themeConfig.symbolPreset).icons.session} CONVERSATIONS · ${rows.length} total · ${counts}`,
        "",
        ...this.listRows(),
        "",
        "Type to filter. Up/Down selects and wraps. Enter opens the conversation. Home/End jump to either end; PageUp/Down pages.",
        "/resume NUMBER or ID also opens a conversation.",
      ];
    }
    // The documents tab is a tree, so the summary line goes under it rather
    // than over it. The tree already answers "what is here"; the summary says
    // how much of it is still open.
    if (this.tab === "documents" && rows.length) {
      const bySession = new Map                ();
      for (const row of rows) {
        const session = row.sessionId ?? "unknown";
        bySession.set(session, (bySession.get(session) ?? 0) + 1);
      }
      const counts = [...bySession.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([session, count]) => `${session.slice(0, 8)}: ${count}`)
        .join(", ");
      const openOps = this.recoveryRows().filter(
        (row) => row.recoverable === "recoverable",
      );
      return [
        ...this.listRows(),
        "",
        `${getSymbols(this.themeConfig.symbolPreset).icons.document} DOCUMENTS · ${rows.length} across ${bySession.size} conversations`,
        "",
        counts + (bySession.size > 4 ? ", ..." : ""),
        "",
        openOps.length
          ? `${openOps.length} of ${this.recoveryRows().length} changes can still be undone. /diff steps through them.`
          : "Every change has been decided: undone or kept.",
        "Type to filter. Up/Down selects and wraps. Enter opens document details. Home/End jump to either end; PageUp/Down pages.",
        "Esc returns. /document path opens a document.",
      ];
    }
    // The ledger tab mixes signed evidence with derived records. Keep real
    // entry counts and verification claims separate from the derived rows;
    // those rows are useful context, but are not ledger entries themselves.
    if (this.tab === "ledger" && rows.length) {
      const byKind = new Map                ();
      for (const row of rows) {
        const kind = row.kind ?? "entry";
        byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
      }
      const managedEntries = [...this.proofs.values()].reduce(
        (sum, entries) => sum + entries.length,
        0,
      );
      const proxyEntries = [...this.proxy.entries.values()].reduce(
        (sum, entries) => sum + entries.length,
        0,
      );
      const managedVerification =
        this.proofErrors.size > 0
          ? `${this.proofErrors.size} workspace(s) failed verification`
          : managedEntries > 0
            ? (this.managedVerificationStatus ??
              "verification status unavailable")
            : "no managed entries recorded";
      const proxyVerification =
        proxyEntries === 0
          ? "no proxy entries recorded"
          : this.proxy.signed
            ? this.proxy.verificationStatus
            : `hash integrity only; signature not verified (${this.proxy.verificationStatus})`;
      const issues = [
        ...[...this.proofErrors.values()].map(
          (error) => `Managed ledger: ${error}`,
        ),
        ...this.proxy.errors.map((error) => `Proxy store: ${error}`),
      ];
      const recordKinds = [...byKind.entries()].sort(
        (left, right) =>
          (LEDGER_GROUP_ORDER.indexOf(
            left[0]                                       ,
          ) ?? Number.MAX_SAFE_INTEGER) -
          (LEDGER_GROUP_ORDER.indexOf(
            right[0]                                       ,
          ) ?? Number.MAX_SAFE_INTEGER),
      );
      const recordChart = barChart(
        {
          values: recordKinds.map(([, count]) => count),
          labels: recordKinds.map(([kind]) => LEDGER_GROUP_TITLE[kind] ?? kind),
        },
        Math.max(1, columns - 2),
        { motion: motionContext(this.frame) },
      );
      return [
        `${getSymbols(this.themeConfig.symbolPreset).icons.ledger} LEDGER · ${managedEntries} managed · ${proxyEntries} proxy entries · ${rows.length} records`,
        "",
        `${getSymbols(this.themeConfig.symbolPreset).icons.session} Managed · ${managedVerification}`,
        `${getSymbols(this.themeConfig.symbolPreset).icons.network} Proxy · ${proxyVerification}`,
        ...(issues.length
          ? [
              `${issues.length} verification or store issue(s) · /verify rechecks`,
              ...issues,
            ]
          : ["No ledger or proxy-store issues reported."]),
        "",
        "RECORD BREAKDOWN",
        ...recordChart.map((line) => `  ${line}`),
        "",
        ...this.listRows(),
      ];
    }
    // The approvals tab answers "what is waiting on me", and the answer is a
    // deadline, not a list. The list below is sorted by blast radius, which
    // answers a different question: which is riskiest. Both matter, so the
    // summary leads with how many are waiting and how long the soonest one
    // has, then the list follows.
    if (this.tab === "approvals" && rows.length) {
      const byStatus = new Map                ();
      for (const row of rows) {
        const match = /\[([^\]]+)\]/.exec(row.label);
        const status = match?.[1] ?? "unknown";
        byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
      }
      const counts = [...byStatus.entries()]
        .map(([status, count]) => `${count} ${status}`)
        .join(", ");
      // The deadline rides at the front of the label in one of two shapes:
      // "NNNs left | " while it runs and "EXPIRED | " once it has. Matching the
      // shape rather than any number is what keeps a hold id or a tool name
      // from being read as a deadline.
      const expiries = rows
        .map((row) => /^(\d+)s left \| /.exec(row.label)?.[1])
        .filter((v)              => !!v)
        .map(Number);
      const expired = rows.filter((row) =>
        row.label.startsWith("EXPIRED"),
      ).length;
      const soonest = expiries.length ? `${Math.min(...expiries)}s` : undefined;
      return [
        `APPROVALS, ${rows.length} waiting: ${counts}`,
        "",
        expired
          ? `${expired} already expired and did not run.`
          : soonest
            ? `soonest deadline: ${soonest}`
            : "no deadline reported",
        "",
        ...this.listRows(),
        "",
        "Enter inspects. Use /approve ID or /reject ID to review a hold.",
      ];
    }
    return rows.length ? this.listRows() : ["No entries yet.", ""];
  }
  /**
   * The item list as numbered rows with a selection marker.
   *
   * Three call sites rendered this by hand, and each had drifted: only one of
   * them respected the active filter. Rendering it once means a fix to the
   * cursor gutter or the numbering reaches all three.
   */
  listRows()           {
    const rows = this.items();
    if (!rows.length) return [];
    // The cursor marker is a fixed two cells, so selecting a row never shifts
    // the numbering of the rows below it. It breathes between two shapes
    // rather than blinking: a blinking cursor is hard to follow in a redraw
    // that happens four times a second.
    motionContext(this.frame);
    const mark = (index        ) =>
      cursorMarker(index === this.selected);
    // A tab that mixes kinds gets a heading above each run of them. Headings
    // carry no number on purpose: the number is how an operator refers to a
    // row, and a number that counts a heading would make every reference
    // after it wrong.
    if (!rows.some((row) => row.kind))
      return [
        ...rows.map((row, i) => `${mark(i)}${i + 1}. ${row.label}`),
        "Type to filter. Up/Down selects and wraps. Home/End jumps to either end; PageUp/Down moves a page.",
      ];
    const out           = [];
    let kind                    ;
    rows.forEach((row, index) => {
      if (row.kind !== kind) {
        kind = row.kind;
        const key = row.kind ?? "";
        out.push(
          `${LEDGER_GROUP_ICON[key] ?? "-"} ${LEDGER_GROUP_TITLE[key] ?? key}`,
        );
      }
      out.push(`${mark(index)}${index + 1}. ${row.label}`);
    });
    out.push(
      "Type to filter. Up/Down selects and wraps. Home/End jumps to either end; PageUp/Down moves a page.",
    );
    return out;
  }
}

function message(error         ) {
  return error instanceof Error ? error.message : "Operation failed.";
}
function transcript(events                         )           {
  const rows           = [];
  let partial = "";
  for (const e of events) {
    if (e.type === "message.delta") {
      partial += e.text;
      continue;
    }
    if (e.kind === "assistant") partial = "";
    if (e.type === "run.status" || e.kind === "usage") continue;
    if (e.kind === "tool" || e.kind === "error")
      rows.push(
        `[${e.at.slice(11, 19)}] ${e.kind === "tool" ? "TOOL" : "ERROR"}`,
      );
    rows.push(...e.text.split("\n"), "");
  }
  if (partial) rows.push(...partial.split("\n"));
  return rows;
}
                
               
        
                 
            
                 
                  
               
            
            
             
            
              
                        
                     
  
                                                                  
const TOOL_ACTIVITY_MODES                              = [
  "compact",
  "details",
  "expanded",
];
function nextToolActivityMode(
  current                  ,
)                   {
  const index = TOOL_ACTIVITY_MODES.indexOf(current);
  return TOOL_ACTIVITY_MODES[(index + 1) % TOOL_ACTIVITY_MODES.length] ;
}
function normalizeToolActivityMode(
  mode                            ,
)                   {
  return typeof mode === "boolean" ? (mode ? "compact" : "details") : mode;
}
                           
               
                            
  
function inlineMarkdownParts(value        )                       {
  const parts                       = [];
  const pattern = /\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`/g;
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push({ text: value.slice(cursor, index) });
    const code = match[3];
    parts.push({
      text: code ?? match[1] ?? match[2] ?? "",
      style: code === undefined ? "strong" : "code",
    });
    cursor = index + match[0].length;
  }
  if (cursor < value.length) parts.push({ text: value.slice(cursor) });
  return parts.length ? parts : [{ text: value }];
}
function displayedEventText(event              )         {
  if (event.kind !== "error") return event.text;
  // Older persisted transcripts used the generic failure copy for HTTP 503,
  // which incorrectly suggested credential and rate-limit problems. Keep
  // historical rows truthful without changing the stored Workbench event.
  return event.text.replace(
    /Provider request failed \(HTTP 503\)\. Check credentials, model access or rate limits\./g,
    "Provider service unavailable (HTTP 503). Try again later.",
  );
}

function toolDetailRecord(value         )                                      {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value                           )
    : undefined;
}

function redactToolDetail(value        )         {
  // Preserve real line boundaries for activity previews. Sanitizing the whole
  // value first turns newlines into visible question marks and flattens code.
  return stripAnsi(value)
    .split(/\r\n?|\n/)
    .map((line) => sanitizeText(line))
    .join("\n")
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g,
      "[redacted]",
    )
    .replace(
      /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|authorization)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi,
      "$1[redacted]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(
      /([?&](?:api[_-]?key|token|secret|password)=)[^&\s]+/gi,
      "$1[redacted]",
    );
}

function toolCodePreview(
  label        ,
  value        ,
  mode                  ,
  maximumCharacters        ,
  maximumLines        ,
)           {
  const lines = value.split("\n");
  const shown = value.slice(0, maximumCharacters);
  const shownLines = shown.split("\n");
  const preview =
    mode === "expanded"
      ? shownLines
      : shownLines
          .slice(0, maximumLines)
          .map((line) => (line.length > 180 ? `${line.slice(0, 179)}…` : line));
  const omitted           = [];
  if (mode !== "expanded" && lines.length > maximumLines)
    omitted.push(`… ${lines.length - maximumLines} more lines`);
  if (value.length > maximumCharacters)
    omitted.push(`… ${value.length - maximumCharacters} characters omitted`);
  if (mode !== "expanded" && value.length > maximumCharacters)
    omitted.push(`… ${value.length} characters total`);
  return [
    `${label} · ${lines.length} lines · ${value.length} chars`,
    "  ┌ code",
    ...preview.map((line) => `  │ ${line}`),
    "  └ code",
    ...omitted,
  ];
}

const PRIVATE_TOOL_DETAIL_KEY =
  /(?:^|[_-])(?:chain[_-]?of[_-]?thought|(?:private|internal)[_-]?(?:reasoning|thoughts?)|reasoning|thoughts?)(?:$|[_-])/i;

function isPrivateToolDetailKey(key        )          {
  return PRIVATE_TOOL_DETAIL_KEY.test(key);
}

function toolDetailValue(
  key        ,
  value         ,
  mode                   = "details",
  depth = 0,
)           {
  if (isPrivateToolDetailKey(key)) return [];
  if (
    /(?:^|[_-])(?:api[_-]?)?(?:key|token|secret|password|credential|authorization)(?:$|[_-])/i.test(
      key,
    )
  )
    return [`${key}: [redacted]`];
  if (typeof value === "string") {
    const safe = redactToolDetail(value);
    const lines = safe.split("\n");
    const isCodeOrPayload =
      /^(?:content|text|body|prompt|patch|diff|script|command|old_str|new_str|source|replacement|code)$/i.test(
        key,
      ) || lines.length > 1;
    if (!isCodeOrPayload && mode !== "expanded")
      return [`${key}: ${safe.replace(/\s+/g, " ").trim().slice(0, 180)}`];
    const maximumCharacters = mode === "expanded" ? 16 * 1024 : 900;
    return toolCodePreview(key, safe, mode, maximumCharacters, 5);
  }
  if (typeof value === "number" && Number.isFinite(value))
    return [`${key}: ${value}`];
  if (typeof value === "boolean") return [`${key}: ${value ? "yes" : "no"}`];
  if (Array.isArray(value)) {
    if (mode !== "expanded" || depth >= 5)
      return [`${key}: ${value.length} items`];
    const shown = value.slice(0, 32);
    return [
      `${key}: ${value.length} items`,
      ...shown.flatMap((item, index) =>
        toolDetailValue(`[${index}]`, item, mode, depth + 1),
      ),
      ...(shown.length < value.length
        ? [`… ${value.length - shown.length} more items`]
        : []),
    ];
  }
  const nested = toolDetailRecord(value);
  if (nested) {
    const visibleKeys = Object.keys(nested).filter(
      (childKey) => !isPrivateToolDetailKey(childKey),
    );
    const keys = visibleKeys.slice(0, 8);
    const suffix = keys.length < visibleKeys.length ? ", …" : "";
    if (mode === "expanded" && depth < 5) {
      const visibleEntries = Object.entries(nested).filter(
        ([childKey]) => !isPrivateToolDetailKey(childKey),
      );
      const entries = visibleEntries.slice(0, 32);
      return [
        `${key}: {`,
        ...entries.flatMap(([childKey, childValue]) =>
          toolDetailValue(childKey, childValue, mode, depth + 1),
        ),
        `}${entries.length < visibleEntries.length ? ` … ${visibleEntries.length - entries.length} more fields` : ""}`,
      ];
    }
    return [`${key}: { ${keys.join(", ")}${suffix} }`];
  }
  return [`${key}: unavailable`];
}

function toolOutputText(value         )           {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(toolOutputText);
  const record = toolDetailRecord(value);
  if (!record) return [];
  if (Array.isArray(record.content)) {
    const content = record.content.flatMap((block) => {
      const item = toolDetailRecord(block);
      return typeof item?.text === "string" ? [item.text] : [];
    });
    if (content.length) return content;
  }
  return ["stdout", "output", "text", "message", "stderr"].flatMap((key) =>
    typeof record[key] === "string" ? [record[key]          ] : [],
  );
}

function compactToolText(event              , toolName        )         {
  const result = toolDetailRecord(event.payload?.result);
  const verb =
    event.type === "tool.started"
      ? "Requested"
      : result?.isError === true
        ? "Failed"
        : "Completed";
  if (event.type === "tool.started") {
    const args = toolDetailRecord(event.payload?.arguments);
    if (args) {
      const previews = [
        "command",
        "cmd",
        "script",
        "path",
        "file_path",
        "filename",
        "file",
        "uri",
      ];
      for (const key of previews) {
        const value = args[key];
        if (typeof value !== "string" || !value.trim()) continue;
        const firstLine = redactToolDetail(value).split("\n", 1)[0] .trim();
        return `${verb} · ${toolName} · ${key}: ${firstLine.slice(0, 140)}`;
      }
    }
  }
  const output = result ? toolOutputText(result).join("\n").trim() : "";
  if (output) {
    const outputLines = redactToolDetail(output).split("\n");
    const firstLine = outputLines[0] .trim();
    const omitted = [
      ...(outputLines.length > 1
        ? [`${outputLines.length - 1} more lines`]
        : []),
      ...(firstLine.length > 140
        ? [`${firstLine.length - 140} more chars`]
        : []),
    ];
    return `${verb} · ${toolName} · ${firstLine.slice(0, 140)}${
      omitted.length ? ` · ${omitted.join(" · ")}` : ""
    }`;
  }
  return `${verb} · ${displayedEventText(event)}`;
}

function toolEventDetails(
  event              ,
  mode                  ,
)           {
  // Render only recorded tool I/O. Provider-private reasoning is not present
  // in these events and is never synthesized from the model response.
  const payload = event.payload;
  if (event.type === "tool.started") {
    const args = toolDetailRecord(payload?.arguments);
    if (!args) {
      const summary = redactToolDetail(event.text).trim();
      return summary ? [summary] : ["Arguments unavailable"];
    }
    const priority = [
      "command",
      "cmd",
      "script",
      "path",
      "file_path",
      "filename",
      "file",
      "uri",
      "patch",
      "diff",
      "old_str",
      "new_str",
      "content",
      "query",
    ];
    const rank = (key        ) => {
      const index = priority.indexOf(key.toLowerCase());
      return index < 0 ? priority.length : index;
    };
    const entries = Object.entries(args)
      .filter(([key]) => !isPrivateToolDetailKey(key))
      .sort(([left], [right]) => rank(left) - rank(right));
    const shown =
      mode === "expanded" ? entries.slice(0, 32) : entries.slice(0, 8);
    const details = shown.flatMap(([key, value]) =>
      toolDetailValue(key, value, mode),
    );
    if (shown.length < entries.length)
      details.push(`… ${entries.length - shown.length} more fields`);
    return details.length
      ? ["Arguments", ...details]
      : ["Arguments unavailable"];
  }
  const result = payload?.result;
  const output = toolOutputText(result).join("\n").trim();
  const details           = [];
  if (output) {
    const safe = redactToolDetail(output);
    const maximumCharacters = mode === "expanded" ? 16 * 1024 : 1200;
    details.push(
      ...toolCodePreview("Output", safe, mode, maximumCharacters, 6),
    );
  } else {
    const summary = redactToolDetail(event.text).trim();
    if (summary) details.push(summary);
  }
  return details.length ? details : ["No output returned"];
}

/** Terminal-only presentation. Never evaluate Markdown, HTML or terminal escapes. */
function chatRows(
  events                         ,
  width        ,
  requestedActivityMode                             = "details",
  density              = "comfortable",
  timestamps = false,
  hideToolActivity = false,
  symbolPreset               = "unicode",
)            {
  const activityMode = normalizeToolActivityMode(requestedActivityMode);
  const rows            = [];
  let partial = "";
  const add = (
    value        ,
    style                  ,
    promptStart = false,
    markdown = false,
  ) => {
    const wrapped = wrap([value], width);
    rows.push(
      ...wrapped.map((text, index) => ({
        text,
        style,
        ...(promptStart && index === 0 ? { promptStart: true } : {}),
        ...(markdown ? { markdown: true } : {}),
      })),
    );
  };
  const messageRows = (
    value        ,
    kind                      ,
    label        ,
    spacerAfter = true,
  ) => {
    const roleStyle                   =
      kind === "assistant"
        ? "assistant"
        : kind === "error"
          ? "role-error"
          : "role-tool";
    if (kind !== "user" && label) add(label, roleStyle);
    let promptMarked = false;
    const addBody = (text        , style                  ) => {
      if (kind === "user") {
        const marker = getSymbols(symbolPreset).role.user;
        const inset = visibleLength(marker) + 1;
        const chunks = wrap([text], Math.max(1, width - inset));
        rows.push(
          ...chunks.map((chunk, index) => ({
            text: `${index === 0 ? `${marker} ` : " ".repeat(inset)}${chunk}`,
            style: "user"         ,
            ...(!promptMarked && index === 0 ? { promptStart: true } : {}),
          })),
        );
        promptMarked = true;
        return;
      }
      add(text, style, false, kind === "assistant" && style === "text");
    };
    let fence = "",
      lineNumber = 0;
    const todoPattern = /^\s*[-*+]\s*\[( |x|X)\]\s+(.+)$/;
    const checklist =
      kind === "assistant" ? extractTodos([{ seq: 0, kind, text: value }]) : [];
    const completedTodos = checklist.filter((item) => item.done).length;
    for (const raw of value.split("\n")) {
      const marker = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(raw);
      if (
        kind !== "user" &&
        marker &&
        (!fence ||
          (marker[1] [0] === fence[0] &&
            marker[1] .length >= fence.length &&
            !marker[2] .trim()))
      ) {
        if (fence) {
          addBody("  └ end code", "tool");
          fence = "";
        } else {
          fence = marker[1] ;
          lineNumber = 0;
          addBody(`  ┌ ${marker[2] .trim() || "code"}`, "code");
        }
      } else if (fence) {
        const prefix = `  ${String(++lineNumber).padStart(2)} │ `;
        for (const [i, chunk] of wrap(
          [raw],
          Math.max(1, width - prefix.length),
        ).entries())
          addBody(
            (i ? " ".repeat(prefix.length - 2) + "│ " : prefix) + chunk,
            "code",
          );
      } else {
        const heading = kind === "assistant" && /^#{1,6}\s/.test(raw);
        const quote = kind === "assistant" && /^>\s?/.exec(raw);
        const task = kind === "assistant" ? todoPattern.exec(raw) : null;
        const bullet = kind === "assistant" && /^\s*[-*+]\s+/.exec(raw);
        const todoHeading =
          kind === "assistant" &&
          checklist.length > 0 &&
          /^(?:#{1,6}\s*)?TODO:?$/i.test(raw.trim());
        const body = todoHeading
          ? `TODO · ${completedTodos}/${checklist.length}`
          : task
            ? `${/^\s*/.exec(raw)?.[0] ?? ""}${task[1] === " " ? "○" : "✓"} ${task[2]}`
            : quote
              ? `│ ${raw.slice(quote[0].length)}`
              : bullet
                ? `${raw.slice(0, bullet[0].length - 1)}• ${raw.slice(bullet[0].length)}`
                : heading
                  ? raw.replace(/^#{1,6}\s+/, "")
                  : raw;
        addBody(
          body,
          quote ? "quote" : heading || todoHeading ? "heading" : "text",
        );
      }
    }
    if (spacerAfter && density === "comfortable") add("", "text");
  };
  const nextVisibleKind = (start        )                                   => {
    for (let index = start; index < events.length; index++) {
      const event = events[index] ;
      if (event.type === "run.status" || event.kind === "usage") continue;
      return event.kind;
    }
    return undefined;
  };
  const toolStartedAt = new Map                ();
  for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
    const event = events[eventIndex] ;
    if (event.type === "message.delta") {
      partial += event.text;
      continue;
    }
    if (event.kind === "assistant") partial = "";
    if (event.type === "run.status" || event.kind === "usage") continue;
    if (hideToolActivity && event.kind === "tool") continue;
    // Keep role and time context for non-user events; user content stays plain.
    const toolName =
      typeof event.payload?.tool === "string"
        ? sanitizeText(event.payload.tool)
        : "Tool";
    const callId =
      typeof event.payload?.callId === "string"
        ? event.payload.callId
        : undefined;
    if (event.kind === "tool" && event.type === "tool.started" && callId) {
      const startedAt = Date.parse(event.at);
      if (Number.isFinite(startedAt)) toolStartedAt.set(callId, startedAt);
    }
    const completedAt = Date.parse(event.at);
    const startedAt = callId ? toolStartedAt.get(callId) : undefined;
    const toolDuration =
      event.kind === "tool" &&
      event.type === "tool.result" &&
      startedAt !== undefined &&
      Number.isFinite(completedAt) &&
      completedAt >= startedAt
        ? completedAt - startedAt
        : undefined;
    const time = timestamps ? `  ${event.at.slice(11, 19)}` : "";
    const label =
      event.kind === "user"
        ? ""
        : event.kind === "assistant"
          ? time.trim()
          : event.kind === "error"
            ? `${roleIcon("error")} ERROR${time}`
            : event.type === "tool.started"
              ? `${roleIcon("tool")} ${toolName} running${time}`
              : `${roleIcon("tool")} ${toolName} result${time}`;
    if (event.kind === "error" || event.kind === "tool") {
      const bodyBudget =
        event.kind === "error" ? 6 : activityMode === "compact" ? 4 : undefined;
      const toolText =
        event.kind === "tool" && activityMode !== "compact"
          ? toolEventDetails(event, activityMode).join("\n")
          : event.kind === "tool"
            ? compactToolText(event, toolName)
            : displayedEventText(event);
      const resultRecord = toolDetailRecord(event.payload?.result);
      const blockRows = renderBlock(
        {
          role: event.kind === "error" ? "error" : "tool",
          text: toolText,
          ...(timestamps ? { at: event.at } : {}),
          ...(event.kind === "tool" ? { heading: toolName } : {}),
          ...(event.kind === "tool" && toolDuration !== undefined
            ? { durationMs: toolDuration }
            : {}),
          ...(event.kind === "tool"
            ? {
                status:
                  event.type === "tool.started"
                    ? ("running"         )
                    : resultRecord?.isError === true
                      ? ("failed"         )
                      : ("done"         ),
              }
            : {}),
          collapsible: true,
        },
        {
          width,
          motion: motionContext(0, false, true),
          symbolPreset,
        },
        bodyBudget,
      );
      let inCodeBlock = false;
      blockRows.forEach((row, index) => {
        const opensCodeBlock = row.trim() === "┌ code";
        const closesCodeBlock = row.trim() === "└ code";
        if (opensCodeBlock) inCodeBlock = true;
        const style                   =
          index === 0
            ? event.kind === "error"
              ? "role-error"
              : "role-tool"
            : index === blockRows.length - 1
              ? event.kind === "error"
                ? "error"
                : "tool"
              : inCodeBlock
                ? "code"
                : "text";
        add(row, style);
        if (closesCodeBlock) inCodeBlock = false;
      });
      if (density === "comfortable") add("", "text");
      continue;
    }
    messageRows(
      displayedEventText(event),
      event.kind,
      label,
      !(event.kind === "user" && nextVisibleKind(eventIndex + 1) === "error"),
    );
  }
  if (partial) messageRows(partial, "assistant", "");
  return rows;
}

function wrap(
  lines                   ,
  width        ,
  trustedIcons                    = [],
)           {
  const out           = [];
  for (const line of lines) {
    let part = "";
    let partWidth = 0;
    let spaceStart = -1;
    let spaceEnd = -1;
    for (const point of safeTextUnits(line, trustedIcons)) {
      const pointWidth = visibleLength(point);
      const whitespace = point.trim() === "";
      if (part && partWidth + pointWidth > width) {
        if (spaceStart > 0) {
          out.push(part.slice(0, spaceStart));
          part = part.slice(spaceEnd);
          partWidth = visibleLength(part);
          spaceStart = -1;
          spaceEnd = -1;
        }
        if (part && partWidth + pointWidth > width) {
          out.push(part);
          part = "";
          partWidth = 0;
          spaceStart = -1;
          spaceEnd = -1;
        }
        if (whitespace && part === "") continue;
      }
      const pointStart = part.length;
      part += point;
      partWidth += pointWidth;
      if (whitespace) {
        if (spaceEnd !== pointStart) spaceStart = pointStart;
        spaceEnd = part.length;
      }
    }
    out.push(part);
  }
  return out;
}
const TUI_COMMANDS = [
  ["/new", "New conversation"],
  ["/clear", "Start fresh and retain history"],
  ["/chat", "Return to chat"],
  ["/bottom", "Follow latest messages"],
  ["/find", "Search conversation text"],
  ["/sessions", "Open conversation history"],
  ["/resume", "Resume a conversation"],
  ["/runs", "Run states, progress and reconciliation"],
  ["/rewind", "Review operation IDs or run ID for recovery"],
  ["/recovery", "Refresh a recovery job without applying it"],
  ["/queue", "Inspect queued text or /queue resume when runtime allows"],
  ["/cancel", "Cancel queued text without stopping a run"],
  ["/documents", "Documents and revisions"],
  ["/context", "Managed documents and context"],
  ["/ledger", "Signed operations"],
  ["/approvals", "Pending decisions"],
  ["/models", "Available models"],
  ["/doctor", "Environment checks"],
  ["/init", "Set up workspace storage"],
  ["/conformance", "Run adapter conformance checks"],
  ["/status", "Workspace status"],
  ["/health", "Pass, warn, fail or unknown for every subsystem"],
  ["/discover", "Commands grouped by the task you arrived with"],
  ["/cost", "Token usage and cost"],
  ["/compact", "Review real context compaction"],
  ["/subagent", "Cancel a verified child or review and deliver its result"],
  ["/todos", "Checklist from agent output"],
  ["/agents", "Runtime profiles, conversations and connectors"],
  ["/agent", "Select a profile for new conversations"],
  ["/agent-file", "Review and save a custom profile from path.json"],
  ["/hooks", "Runtime hook support and operator allowlist"],
  ["/hook-file", "Review a hook if the host supports execution"],
  ["/hook", "Enable or disable a saved hook by id"],
  ["/projects", "List persisted projects"],
  ["/project", "Select a project ID or none for new conversations"],
  ["/project-file", "Review and save a project from path.json"],
  ["/config", "Resolved paths and flags"],
  ["/settings", "Interactive appearance and workspace settings"],
  ["/memory", "Retained local history"],
  ["/model", "Set model for new chats"],
  ["/plan", "Switch to plan mode"],
  ["/stats", "Token usage and cost"],
  ["/diff", "Outstanding document changes"],
  ["/diff-next", "Next outstanding change in the diff panel"],
  ["/theme", "Color and motion for this session"],
  ["/keybindings", "Keyboard shortcut reference"],
  ["/exit", "Save and quit"],
  ["/export", "Save ledger, chat or document"],
  ["/attest", "Signed slice for a third party"],
  ["/providers", "Model providers and local open models"],
  [
    "/harness",
    "Agent harness: cloud, prime-agent, scores, review, approve, reject",
  ],
  ["/login", "Connect a provider"],
  ["/logout", "Disconnect the provider"],
  ["/verify", "Verify signatures"],
  ["/undo", "Preview Undo"],
  ["/edit", "Open document editor"],
  ["/history", "Document history"],
  ["/branch", "Create a branch"],
  ["/retry", "Retry with confirmation"],
  ["/tools", "Search tools and inspect schemas"],
  ["/expand", "Toggle full tool output"],
  ["/connect opencode:zen", "Connect OpenCode Zen from local auth"],
  ["/connect omp:nvidia", "Connect NVIDIA NIM from the local OMP auth store"],
  [
    "/connect omp:openrouter",
    "Connect OpenRouter from the local OMP auth store",
  ],
  ["/policy", "Tool policies"],
  ["/permissions", "Tool policies and approvals"],
  ["/mcp", "MCP connectors: add, probe, confirm, rename, remove"],
  ["/usage", "Model usage"],
  ["/stop", "Stop run"],
  ["/help", "All commands"],
  ["/quit", "Save and quit"],
]         ;
function commandSuggestions(input        ) {
  if (!/^\/[^\s]*$/.test(input)) return [];
  const query = input.slice(1).toLocaleLowerCase();
  const matches = ([name]                               ) => {
    const command = name.slice(1).split(" ")[0] .toLocaleLowerCase();
    let cursor = 0;
    for (const point of command) if (point === query[cursor]) cursor++;
    return cursor === query.length;
  };
  return TUI_COMMANDS.filter(matches).sort(
    (left, right) =>
      Number(!left[0].startsWith(input)) - Number(!right[0].startsWith(input)),
  );
}
/**
 * The argument each command takes, for the hint that appears once the
 * operator has typed the command and a space.
 *
 * Declared rather than inferred. TUI_COMMANDS carries a description and no
 * argument, and the only other place the shape of an argument appears is the
 * error message a handler throws when it is missing. Reading a contract out
 * of an error string would couple the hint to wording that exists for a
 * different reader, and a command whose error message was reworded would
 * silently start showing a stale placeholder.
 *
 * Commands absent here take no argument, and the hint stays silent for them
 * rather than guessing.
 */
const COMMAND_ARGUMENTS                         = {
  "/model": "exact-ID",
  "/agent": "ID",
  "/document": "path",
  "/open": "number-or-ID",
  "/resume": "number-or-ID",
  "/branch": "seq",
  "/rename": "title",
  "/project": "ID or none",
  "/undo": "operation-ID",
  "/rewind": "operation-IDs",
  "/recovery": "job-ID",
  "/queue": "",
  "/export": "ledger, chat or document",
  "/filter": "text",
  "/settings": "key value",
  "/harness":
    "cloud, prime-agent, scores, review, approve DIGEST, reject DIGEST",
  "/theme": "color, mono, motion, still or reset",
  "/approve": "hold-ID [reason]",
  "/deny": "hold-ID [reason]",
  "/tools": "search text",
  "/policy-file": "connector-ID path.yaml",
  "/connector-file": "path.json",
  "/agent-file": "path.json",
  "/hook-file": "path.json",
  "/conformance": "adapter",
  "/compact": "",
  "/new": "conversation",
  "/mcp": "inspect, add, probe, confirm, rename or remove",
  "/mcp inspect": "ID",
  "/mcp add": "URL [name]",
  "/mcp probe": "ID",
  "/mcp confirm": "ID",
  "/mcp rename": "ID name",
  "/mcp remove": "ID",
  "/subagent": "cancel or review",
};

/**
 * The argument a command takes, or undefined when it takes none.
 *
 * A subcommand carries its own shape: "/mcp probe" takes an id while "/mcp"
 * alone takes several. The longest matching prefix wins, so a hint never
 * says "verb" when the operator has already typed the noun.
 */
function commandArgumentHint(command        )                     {
  if (!command.startsWith("/")) return undefined;
  const words = command.trim().split(/\s+/);
  for (let take = words.length; take > 0; take -= 1) {
    const key = words.slice(0, take).join(" ");
    if (key in COMMAND_ARGUMENTS) return COMMAND_ARGUMENTS[key] || undefined;
  }
  return undefined;
}
/**
 * Row icons for the item lists.
 *
 * Every list row gets a glyph so a column of rows can be scanned by shape
 * before it is read. Like the tab icons these are single cell geometric shapes,
 * and none of them is the only signal for anything: the state word stays in
 * the label, so removing the icon loses speed, not meaning.
 */
const ROW_ICONS = {
  running: "◉",
  run: "▶",
  settled: "●",
  failed: "×",
  queued: "◔",
  unknown: "?",
  archived: "□",
  session: "●",
  document: "▤",
  ledgerEntry: "▪",
  proxyEntry: "▫",
  learned: "◇",
  hook: "◇",
  harness: "◈",
  agent: "◆",
  tool: "+",
  connector: "▣",
  provider: "◈",
  model: "◐",
  approval: "◉",
  rejected: "×",
  // U+25B7 rather than the pencil U+270E, which counts two cells and would
  // shift every label one column to the right of this glyph.
  edit: "▷"}         ;

/**
 * Icon for a run or session state. An unknown state gets the question mark
 * rather than a default, because guessing a settled dot for a state nobody
 * recognised would read as a fact the terminal had not been told.
 */
function stateIcon(state        )         {
  const key = state.toLowerCase();
  if (key.includes("await") || key.includes("approval"))
    return ROW_ICONS.approval;
  if (key.includes("run") || key.includes("active")) return ROW_ICONS.running;
  if (key.includes("fail") || key.includes("error")) return ROW_ICONS.failed;
  if (
    key.includes("queue") ||
    key.includes("pending") ||
    key.includes("stopp") ||
    key.includes("paus")
  )
    return ROW_ICONS.queued;
  if (key.includes("archiv")) return ROW_ICONS.archived;
  if (
    key.includes("idle") ||
    key.includes("settl") ||
    key.includes("done") ||
    key.includes("complet")
  )
    return ROW_ICONS.settled;
  return ROW_ICONS.unknown;
}

const MODE_ICON                          = {
  normal: "◆",
  accept: "●",
  plan: "○",
};

// Iconoir's CPU Chip, Network, and Server forms become one-cell marks here;
// terminal rows cannot embed the source SVGs without changing the renderer.
function modelProviderIcon(id        , name = "")         {
  const key = `${id} ${name}`.toLowerCase();
  if (key.includes("nvidia")) return "▦";
  if (key.includes("openrouter")) return "◎";
  return ROW_ICONS.provider;
}
function hasVisibleTextFrom(value        , start = 0)          {
  for (let index = start; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (
      code !== 0x09 &&
      code !== 0x0a &&
      code !== 0x0b &&
      code !== 0x0c &&
      code !== 0x0d &&
      code !== 0x20 &&
      code !== 0x00a0 &&
      code !== 0x1680 &&
      !(code >= 0x2000 && code <= 0x200a) &&
      code !== 0x2028 &&
      code !== 0x2029 &&
      code !== 0x202f &&
      code !== 0x205f &&
      code !== 0x3000 &&
      code !== 0xfeff
    )
      return true;
  }
  return false;
}

function renderWorkspace(
  ui              ,
  columns        ,
  rows        ,
  input = "",
  editing = false,
  busy = false,
  visuals                   = {},
)         {
  const terminalWidth = Math.max(1, Math.floor(columns)),
    terminalHeight = Math.max(1, Math.floor(rows));
  ui.tabHitTargets = [];
  ui.rowHitTargets = [];
  if (terminalWidth < 20 || terminalHeight < 8) {
    ui.viewport = { offset: 0, height: 0, total: 0, width: terminalWidth };
    const message =
      terminalWidth < 20 && terminalHeight < 8
        ? "Widen and heighten terminal"
        : terminalWidth < 20
          ? "Widen terminal"
          : "Heighten terminal";
    const messageRow = Math.floor((terminalHeight - 1) / 2);
    return Array.from({ length: terminalHeight }, (_, row) =>
      pad(row === messageRow ? fit(message, terminalWidth) : "", terminalWidth),
    ).join("\n");
  }
  const modelPickerOpen = ui.modelPicker?.open === true;
  const chatBaseVisible =
    ui.tab === "chat" &&
    !ui.detail &&
    !ui.confirmation &&
    !ui.palette &&
    !modelPickerOpen &&
    !ui.diffView &&
    !ui.showingKeybindings &&
    !ui.showingCheatSheet;
  const panelOverlay = !chatBaseVisible;
  const panelFrameRows = panelOverlay ? 2 : 0;
  const panelTopOffset = panelOverlay ? 1 : 0;
  const chatPanelMarginX = chatBaseVisible
    ? terminalWidth >= 56
      ? 2
      : terminalWidth >= 40
        ? 1
        : 0
    : 0;
  const chatPanelTopMarginY = chatBaseVisible
    ? terminalHeight >= 24
      ? 2
      : terminalHeight >= 16
        ? 1
        : 0
    : 0;
  const width = panelOverlay
    ? Math.max(1, terminalWidth - 2)
    : chatBaseVisible
      ? Math.max(1, terminalWidth - chatPanelMarginX * 2)
      : terminalWidth;
  const height = panelOverlay
    ? Math.max(1, terminalHeight - panelFrameRows)
    : terminalHeight;
  const trustedIcons = trustedLocalIconLabels(
    ui.localTabIcons,
    ui.themeConfig.colorTheme,
  );
  const spaciousShell =
    !panelOverlay &&
    terminalHeight >= 22 &&
    terminalWidth >= 78 &&
    !ui.confirmation;
  const panelIcons = getSymbols(ui.themeConfig.symbolPreset).icons;
  const tabIcon = (tab              , fallback        ) =>
    ui.localTabIcons
      ? kittyTabIconLabel(tab, ui.localTabIcons, ui.themeConfig.colorTheme) ||
        fallback
      : fallback;
  const tabPanelIcons                               = {
    chat: tabIcon("chat", panelIcons.agent),
    sessions: tabIcon("sessions", panelIcons.session),
    runs: tabIcon("runs", panelIcons.run),
    documents: tabIcon("documents", panelIcons.document),
    ledger: tabIcon("ledger", panelIcons.ledger),
    approvals: tabIcon("approvals", panelIcons.approval),
    policy: tabIcon("policy", panelIcons.policy),
    tools: tabIcon("tools", panelIcons.tool),
    mcp: tabIcon("mcp", panelIcons.network),
    status: tabIcon("status", panelIcons.settings),
    models: tabIcon("models", panelIcons.model),
    usage: tabIcon("usage", panelIcons.usage),
    help: tabIcon("help", panelIcons.help),
  };
  const panelTitle = modelPickerOpen
    ? `${tabPanelIcons.models} Models`
    : ui.confirmation
      ? `${tabPanelIcons.approvals} Review`
      : ui.showingKeybindings
        ? `${panelIcons.key} Keybindings`
        : ui.showingCheatSheet
          ? `${panelIcons.help} Shortcuts`
          : ui.diffView
            ? `${tabPanelIcons.documents} Diff`
            : ui.tab !== "chat"
              ? `${tabPanelIcons[ui.tab]} ${ui.tab[0] .toUpperCase()}${ui.tab.slice(1)}`
              : ui.detail?.[0]
                ? safeTextUnits(ui.detail[0], trustedIcons).join("")
                : `${panelIcons.help} Details`;
  // The keybinding table sizes its columns to the terminal, so a resize has to
  // re-lay it out. Re-rendering on every frame would be wasteful, so it only
  // happens when the width actually moved.
  if (ui.showingKeybindings && ui.keybindingWidth !== width)
    ui.refreshKeybindings(width);
  // Same for the cheat sheet: it sizes its columns to the terminal, so a
  // resize has to re-lay it. Only on an actual width change, for the same
  // reason the keybinding table does not re-lay every frame.
  if (ui.showingCheatSheet && ui.cheatWidth !== width)
    ui.refreshCheatSheet(width);
  // Terminal capabilities for theme rendering (omp-style)
  const detectedCaps = visuals.capabilities
    ? {
        ...visuals.capabilities,
        columns: terminalWidth,
        rows: terminalHeight,
      }
    : detectCapabilities(ui.env, {
        columns: terminalWidth,
        rows: terminalHeight,
        isTTY: false,
      });
  const colorEnabled = detectedCaps.ansi && visuals.color !== false;
  visuals = { ...visuals, color: colorEnabled };
  const caps                       = {
    ...detectedCaps,
    columns: width,
    rows: height,
    ansi: colorEnabled,
    colorDepth: colorEnabled ? detectedCaps.colorDepth : 0,
  };
  const ink = (value        , code        ) =>
    visuals.color ? `\x1b[${code}m${value}\x1b[0;39m` : value;
  const text = (value        ) => fit(sanitizeText(value), width);
  const amber = "38;5;215",
    ice = "38;5;117",
    mutedAnsi = "38;5;245";
  const workbenchRunning = ui.workbench.running();
  const sessionRunning = ui.session()?.status === "running";
  const running = busy || workbenchRunning;
  const frame = visuals.motion === false ? 0 : (visuals.frame ?? 0);
  // One motion context drives every effect in the frame, so they stay in phase
  // with each other and a paused frame pauses all of them together.
  const motion = motionContext(visuals.frame ?? 0, visuals.motion !== false);
  // Published before anything asks the model for lines, because the list rows
  // animate their cursor marker and are built on the model side.
  ui.frame = motion.frame;
  // Published before the detail is asked for lines, same reason as the frame
  // above: the cheat sheet lists editing bindings and has to know whether the
  // keyboard currently belongs to the prompt.
  ui.editingInput = editing;
  const pending = ui.workbench.pending();
  pending.length + ui.proxy.holds.length;
  ui.workbench.list().length;
  const waiting = pending.some((hold) =>
    hold.holdId.startsWith(`${ui.sessionId}:`),
  );
  // A run that is waiting on a human is not a run that is progressing. The
  // marker says so at a glance: a slower, heavier glyph, because the next
  // thing that happens will be a decision, not output.
  const spinner = running
    ? waiting
      ? cautionSpinner(motion)
      : runningIndicator(motion)
    : "◆";
  // Sticky approval banner: the oldest pending hold stays pinned above the
  // body on every tab, so a hold is never hidden behind a panel switch.
  const banner = approvalBannerLines(
    [
      ...pending.map((hold) => ({
        holdId: hold.holdId,
        call: {
          tool: String((hold.call                      ).tool ?? "unknown"),
          klass: (hold.call                       ).klass                      ,
        },
      })),
      ...ui.proxy.holds.map((hold) => ({
        holdId: hold.holdId,
        call: { tool: hold.call.tool, klass: hold.call.klass },
      })),
    ],
    width,
    ui.tab === "chat" ||
      (!ui.editingInput &&
        !ui.filter &&
        !ui.detail &&
        !ui.diffView &&
        !ui.confirmation &&
        !ui.palette &&
        !ui.modelPicker &&
        !ui.showingKeybindings &&
        !ui.showingCheatSheet),
  );
  // Toasts sit below the approval banner and above the body. The banner is
  // sticky and authoritative; toasts are the transient layer under it, so a
  // raise never has to choose between being seen and being safe.
  //
  // On a terminal too short to carry them they are dropped rather than
  // squeezed. A toast that costs the operator their input surface has
  // charged more than it delivered, and the approval banner above still
  // carries everything they actually have to act on.
  const toastRows = renderToasts(ui.toasts, width - 4, {
    color: visuals.color === true,
  });
  const header           = [];
  const headerPalette = getPalette(ui.themeConfig.colorTheme);
  const modelName =
    ui.session()?.model || ui.model || "Connect a model with /connect";
  const home = ui.env.HOME;
  const rawCwd = ui.env.PWD || ".";
  const cwd =
    home && rawCwd.startsWith(home) ? `~${rawCwd.slice(home.length)}` : rawCwd;
  if (chatBaseVisible) {
    // Keep the tall Chat header's row count independent of terminal width.
    // Otherwise crossing 78 columns changes it from three rows to seven and
    // makes the transcript jump while the terminal is being resized.
    if (terminalHeight >= 30) {
      const aside = [
        `${running ? (waiting ? "WAITING FOR REVIEW" : "WORKING · IN PROGRESS") : "READY · WORKSPACE"}`,
        `◈ ${sanitizeText(modelName)}`,
        `⌂ ${sanitizeText(cwd)}`,
      ];
      const statusGlyph = running
        ? runningIndicator(motion)
        : idleBreath(motion);
      const statusTone = running ? "info" : "success";
      brandHeader("", caps).forEach((row, index) => {
        const extra = aside[index];
        const prefix =
          index === 0
            ? `${paintWithPalette(statusGlyph, statusTone, headerPalette, caps)} `
            : "  ";
        const logoTextGap = width >= 64 ? 7 : 4;
        const extraWidth = Math.max(
          0,
          width - visibleLength(prefix) - visibleLength(row) - logoTextGap,
        );
        header.push(
          `${prefix}${row}` +
            (extra && terminalWidth >= 78 && extraWidth >= 8
              ? ink(
                  `${" ".repeat(logoTextGap)}${fit(extra, extraWidth)}`,
                  index === 0 ? `1;${ice}` : mutedAnsi,
                )
              : ""),
        );
      });
    } else {
      const statusGlyph = running
        ? runningIndicator(motion)
        : idleBreath(motion);
      const compactLogoTextGap = terminalWidth >= 40 ? "    " : "  ";
      header.push(
        fit(
          `${paintWithPalette(statusGlyph, running ? "info" : "success", headerPalette, caps)} ${compactBrandMark(detectedCaps)}${compactLogoTextGap}${ink("workspace", `1;${ice}`)}`,
          width,
        ),
      );
      if (height >= 12 && width >= 40)
        header.push(fit(ink(`◈ ${sanitizeText(modelName)}`, mutedAnsi), width));
      if (height >= 18 && width >= 72)
        header.push(fit(ink(`⌂ ${sanitizeText(cwd)}`, mutedAnsi), width));
    }
  } else {
    const backLabel = "← Chat";
    const navRow = panelTopOffset + 1;
    const navColumn = panelTopOffset + 1;
    header.push(
      fit(
        ink(backLabel, `1;${ice}`) + ink("  ·  Esc returns to Chat", mutedAnsi),
        width,
      ),
    );
    ui.tabHitTargets.push({
      tab: "chat",
      row: navRow,
      start: navColumn,
      end: navColumn + visibleLength(backLabel) - 1,
    });
  }
  // A travelling wave under the header while a run is in flight. It is
  // attention, never the only signal: the status row below still names the
  // phase in words.
  if (
    !panelOverlay &&
    running &&
    !spaciousShell &&
    height - header.length >= 13
  )
    header.push(
      ink(
        phaseWave("Working", width, motion, {
          paint: (value, tone, bold) =>
            ink(value, bold ? `1;${ice}` : mutedAnsi),
        }),
        mutedAnsi,
      ),
    );
  const candidates =
    editing && !ui.confirmation && !visuals.suggestionsDismissed
      ? commandSuggestions(visuals.command ?? "")
      : [];
  const selection = Math.max(
    0,
    Math.min(visuals.suggestion ?? 0, candidates.length - 1),
  );
  const menuStart = Math.max(0, selection - 3);
  const menu = candidates.slice(
    menuStart,
    menuStart + Math.min(5, Math.max(0, height - header.length - 8)),
  );
  // Once a command and a space are typed, the useful hint is what it wants
  // next rather than which command it is. A hint that has not been earned
  // yet, before the space, would only repeat the command list.
  const typedCommand = visuals.command ?? "";
  const argumentHint =
    editing && !ui.confirmation && /^\/\S*\s/.test(typedCommand)
      ? commandArgumentHint(typedCommand)
      : undefined;
  // Reserve one cell per side for the frame. On very narrow terminals, fall
  // back to the filled surface rather than letting the frame clip the input.
  const useChatFrame = ui.chatPanelVisuals.frame !== "filled" && width >= 12;
  const composerPromptIcon = ui.localTabIcons
    ? kittySemanticIconLabel(
        "composer",
        ui.localTabIcons,
        ui.themeConfig.colorTheme,
      )
    : "";
  // One semantic composer glyph replaces the message icon; the centered
  // caret remains the edit indicator and the fallback is a symmetric diamond.
  const composerPrompt = composerPromptIcon || "◆";
  const composerPromptWidth = Math.max(1, visibleLength(composerPrompt)) + 1;
  // Keep the composer grid even at every width: one border cell on each side,
  // matching top, content and bottom rows. Rounded means rounded corners, not
  // stepped offsets that make the frame look asymmetric.
  const composerInner = Math.max(1, useChatFrame ? width - 2 : width);
  const composerTextWidth = Math.max(
    1,
    composerInner - composerPromptWidth - (useChatFrame ? 1 : 0),
  );
  // The palette query stands in for the draft while the overlay is open, so
  // the same wrapping and cursor arithmetic serve both surfaces.
  const composerLines = ui.palette
    ? [ui.palette.query]
    : (
        input ||
        (ui.tab === "chat"
          ? ""
          : editing
            ? "Type to filter…"
            : ui.groupTree
              ? "Type filter / Enter open or fold"
              : "Type filters / Enter opens")
      ).split("\n");
  const composerCursor = ui.palette
    ? [...ui.palette.query].length
    : ui.tab === "chat"
      ? (visuals.cursor ?? [...input].length)
      : editing
        ? (visuals.cursor ?? [...input].length)
        : undefined;
  const composerPoints = [...composerLines.join("\n")];
  const composerCharacters = new Set(composerPoints);
  let markerCodePoint = 0xe000;
  while (composerCharacters.has(String.fromCodePoint(markerCodePoint))) {
    markerCodePoint =
      markerCodePoint === 0xf8ff ? 0xf0000 : markerCodePoint + 1;
  }
  const composerCursorMarker = String.fromCodePoint(markerCodePoint);
  if (composerCursor !== undefined) {
    const cursor = Math.max(0, Math.min(composerPoints.length, composerCursor));
    composerPoints.splice(cursor, 0, composerCursorMarker);
  }
  const composer = wrap(composerPoints.join("").split("\n"), composerTextWidth);
  const chatStatusRowCount = width >= 72 ? 1 : 3;
  const chatComposerChromeRows =
    3 + chatStatusRowCount + (useChatFrame ? 2 : 0);
  const availableChatComposerRows = Math.max(
    1,
    height -
      header.length -
      banner.length -
      chatPanelTopMarginY -
      menu.length -
      (argumentHint ? 1 : 0) -
      chatComposerChromeRows -
      1,
  );
  const maxChatComposerRows =
    availableChatComposerRows > 1 && availableChatComposerRows % 2 === 0
      ? availableChatComposerRows - 1
      : availableChatComposerRows;
  // Target the outer composer in physical pixels, then translate to rows.
  // Some terminals do not report cell geometry; the stable fallback assumes
  // 24 px per row. The frame itself consumes two of the converted rows.
  const cellHeightPixels =
    visuals.capabilities?.cellHeightPixels &&
    Number.isFinite(visuals.capabilities.cellHeightPixels) &&
    visuals.capabilities.cellHeightPixels > 0
      ? visuals.capabilities.cellHeightPixels
      : 24;
  const frameRows = useChatFrame ? 2 : 0;
  const centeredOuterRows = Math.max(
    useChatFrame ? 3 : 1,
    2 *
      Math.round(
        (ui.chatPanelVisuals.composerHeightPx / cellHeightPixels - 1) / 2,
      ) +
      1,
  );
  const defaultChatComposerRows = Math.max(1, centeredOuterRows - frameRows);
  // Keep one editable input line even though the outer surface has comfortable
  // vertical room. Wrapped drafts expand past the configured base as needed.
  const minimumChatComposerRows = Math.min(
    defaultChatComposerRows,
    maxChatComposerRows,
  );
  const requestedChatComposerRows = Math.min(
    Math.max(
      minimumChatComposerRows,
      Math.max(1, composer.length) + (composer.length % 2 === 0 ? 1 : 0),
    ),
    maxChatComposerRows,
  );
  // An odd row count gives the composer prompt a real center cell.
  const targetChatComposerRows =
    requestedChatComposerRows > 1 && requestedChatComposerRows % 2 === 0
      ? requestedChatComposerRows - 1
      : requestedChatComposerRows;
  const composerHeight = chatBaseVisible
    ? targetChatComposerRows
    : Math.min(composer.length, height >= 18 ? 3 : 1);
  const cursorLine = composer.findIndex((line) =>
    line.includes(composerCursorMarker),
  );
  const composerCenterRow = Math.floor(composerHeight / 2);
  const composerStart =
    cursorLine < 0
      ? 0
      : Math.min(
          Math.max(0, composer.length - composerHeight),
          Math.max(0, cursorLine - composerCenterRow),
        );
  const composerLeadingRows =
    cursorLine < 0
      ? 0
      : Math.min(
          Math.max(0, composerHeight - composer.length),
          Math.max(0, composerCenterRow - cursorLine),
        );
  const composerViewport = [
    ...Array.from({ length: composerLeadingRows }, () => ""),
    ...composer.slice(
      composerStart,
      composerStart + composerHeight - composerLeadingRows,
    ),
  ];
  while (chatBaseVisible && composerViewport.length < composerHeight)
    composerViewport.push("");
  // An open palette owns the body. It is a filter surface, so whatever the
  // underlying tab would have shown is exactly the noise the operator is
  // trying to see past.
  const paletteView = ui.palette
    ? renderPalette(
        ui.palette,
        filterPalette(
          paletteFromCommands(TUI_COMMANDS),
          ui.palette.query,
          ui.palette.recent,
        ),
        width - 4,
        { color: visuals.color },
      )
    : undefined;
  // The legend is rendered after the paint helpers exist and before the body
  // height is known, because the body height is what decides how many legend
  // rows fit. Measuring it here is what keeps the frame exactly height rows
  // tall on every terminal size, which the parity tests pin.
  const pickerMatches = ui.modelPicker
    ? modelPickerMatches(ui.modelPicker.models, ui.modelPicker.query)
    : undefined;
  const selectedPickerModel = pickerMatches?.[ui.modelPicker?.selected ?? 0];
  const panelHint = modelPickerOpen
    ? ui.modelPicker?.focusedPane === "providers"
      ? width < 50
        ? "↑↓ provider · → models · Tab/⇧Tab panes"
        : "↑/↓ providers · → models · Tab/Shift+Tab panes · Enter load · Esc"
      : ui.modelPicker?.query
        ? width < 50
          ? "↑↓ model · ← provider · Tab/⇧Tab panes · Esc clears"
          : "↑/↓ models · ← providers · Tab/Shift+Tab panes · Type search · Esc clear"
        : ui.modelPicker?.selection === "session"
          ? width < 50
            ? "↑↓ model · ← provider · Tab/⇧Tab · Enter use"
            : "↑/↓ models · ← provider · Tab/Shift+Tab panes · Enter use · Esc close"
          : width < 50
            ? "↑↓ model · ← provider · Tab/⇧Tab · Enter set"
            : "↑/↓ models · ← providers · Tab/Shift+Tab panes · Enter set default · Esc close"
    : ui.confirmation
      ? "y accept · n reject · Esc cancel"
      : paletteView
        ? "↑/↓ choose · Enter run · Esc close"
        : ui.diffView
          ? width < 50
            ? "↑↓ review · Esc Chat"
            : "↑/↓ review · Esc returns to Chat"
          : ui.settingsOpen
            ? ui.settingsQuery
              ? width < 50
                ? "type filter · Ctrl+←→ caret · ↑↓ select · Esc clear"
                : "Type to filter · Ctrl+←/→ caret · ↑/↓ select · ←/→ change · Esc clear"
              : width < 50
                ? "type search · ↑↓ select · Ctrl+←→ groups · ←→ change · Enter edit · Esc Chat"
                : "Type to search · ↑/↓ select · Ctrl+←/→ groups · ←/→ change · Enter edit/change · PgUp/PgDn · Esc Chat"
            : ui.detail || ui.showingKeybindings || ui.showingCheatSheet
              ? "PgUp/PgDn scroll · Esc back"
              : ui.groupTree
                ? width < 50
                  ? "↑↓ move · Enter fold/open · Esc Chat"
                  : "↑/↓ move · Enter open or fold · Esc returns to Chat"
                : ui.tab === "help"
                  ? width < 50
                    ? "↑↓/PgUp/PgDn scroll · Esc Chat"
                    : "↑/↓ scroll · PgUp/PgDn page · Esc returns to Chat"
                  : width < 50
                    ? "↑↓ select · Enter open · Esc Chat"
                    : "Type to filter · ↑/↓ select · Enter open · Tab/Esc Chat";
  const legendRows = chatBaseVisible
    ? []
    : modelPickerOpen
      ? [
          fit(
            selectedPickerModel
              ? `${selectedPickerModel.name} · ${selectedPickerModel.id}${selectedPickerModel.id === (ui.modelPicker?.selection === "session" ? ui.session()?.model : ui.model) ? (ui.modelPicker?.selection === "session" ? " · current conversation model" : " · current default") : ""}`
              : "No model selected",
            width,
          ),
          ...(width >= 72
            ? [
                "↑/↓ select · Home/End bounds · PgUp/PgDn page · Type to search",
                width < 60
                  ? "↑/↓ select · ←/→ panes · type · Esc close"
                  : `↑/↓ select · Tab/Shift+Tab/←/→ switch panes · click row · double-click open/load · wheel · Esc close`,
              ]
            : [panelHint]
          ).map((row) => fit(row, width)),
        ]
      : [fit(panelHint, width)];
  // A run in flight may get a timeline above the status bar. What it would
  // cost is measured here; whether it is affordable is decided below, from
  // the shared budget rather than from a second guess at the same numbers.
  //
  // The timeline follows the run this process started, not whichever run is
  // newest. During the initial pass a busy run can be reported from a
  // different conversation than the one just sent, and the operator watching
  // a stopwatch saw another conversation's phases.
  const ownRun =
    ui.workbench
      .runs()
      .find((run                        ) => run.sessionId === ui.sessionId)
      ?.runId ?? ui.session()?.runId;
  const timelineRows =
    ui.tab !== "chat" && sessionRunning && !waiting && ownRun
      ? renderTimeline(buildTimeline(ui.session()?.events ?? []), width, 8, {
          motion,
          paint: (value, tone, bold) =>
            visuals.color
              ? paintWithPalette(
                  value,
                  tone                                          ,
                  getPalette(ui.themeConfig.colorTheme),
                  caps,
                  bold,
                )
              : value,
        })
      : [];
  // The composer starts with one editable row; a framed surface adds its top
  // and bottom edges. Wrapped drafts consume only the rows they need.
  //
  // Header, approval banner, composer rows/frame, summary/status, suggestions,
  // and one body row are reserved first. Optional bands share only what remains.
  const summaryRowsCount = width < 100 ? 2 : 1;
  const chatFooterRows = chatBaseVisible ? chatComposerChromeRows : 0;
  const bodyTextWidth = Math.max(1, width - 4);
  const reserved =
    header.length +
    banner.length +
    (panelOverlay
      ? legendRows.length + summaryRowsCount + 1
      : composerHeight + chatFooterRows) +
    (chatBaseVisible ? chatPanelTopMarginY : 0) +
    menu.length +
    (argumentHint ? 1 : 0) +
    1; /* one row of body, always */
  let spare = Math.max(0, height - reserved);

  // Toasts come first among the optional bands: they are the only ones
  // carrying an event the operator has not read yet. They are clipped rather
  // than dropped whole, because a partial queue is still a queue and the
  // sticky ones are ordered ahead of the rest.
  const takeToasts = Math.min(toastRows.length, spare);
  const shownToastRows = toastRows.slice(0, takeToasts);
  spare -= takeToasts;

  // Then the timeline of a run in flight. Dropped whole, never clipped: half
  // a timeline reads as a rendering fault rather than as a summary.
  const shownTimelineRows =
    timelineRows.length > 0 && spare >= timelineRows.length ? timelineRows : [];
  spare -= shownTimelineRows.length;

  // Then the rule that marks where the body ends and the controls begin. It
  // breathes while a run is in flight, which is the only reason it earns a
  // row ahead of the legend below it.
  const shownRuleRows =
    !chatBaseVisible &&
    !spaciousShell &&
    (spare > legendRows.length || (summaryRowsCount === 1 && spare >= 1))
      ? [separator(width, motion, running)]
      : [];
  spare -= shownRuleRows.length;

  // The legend is advice, and /keybindings carries the same list, so it takes
  // whatever is left and no more.
  const shownLegendRows = spare >= legendRows.length ? legendRows : [];
  spare -= shownLegendRows.length;

  const ruleRows = shownRuleRows;
  const visibleLegendRows = shownLegendRows;
  const bodyHeight = Math.max(1, spare + 1);
  const documentLayout =
    ui.tab === "documents" && ui.documentPreview
      ? documentPreviewLayout(width - 4, bodyHeight)
      : undefined;
  const sessionLayout =
    ui.tab === "sessions" && ui.groupTree
      ? sessionInspectorLayout(width - 4, bodyHeight)
      : undefined;
  const richChat =
    ui.tab === "chat" &&
    !!ui.session() &&
    !ui.detail &&
    !ui.confirmation &&
    !paletteView &&
    !modelPickerOpen;
  let content = modelPickerOpen
    ? ui.lines(width - 4, bodyHeight)
    : paletteView
      ? [...paletteView.lines]
      : richChat
        ? []
        : ui.lines(width - 4, bodyHeight);
  if (ui.confirmation && height < 14 && content[1] === "") {
    content.splice(1, 1);
  }
  const styled = richChat
    ? ui.renderChatRows(ui.session() .events, bodyTextWidth)
    : undefined;
  const noWrapPanel = modelPickerOpen || ui.settingsOpen || ui.tab === "models";
  const lines =
    (richChat && styled?.length === 0 ? [] : styled?.map((row) => row.text)) ??
    (paletteView
      ? paletteView.lines
      : noWrapPanel
        ? content.map((line) =>
            fitWithTrustedIcons(line, bodyTextWidth, trustedIcons),
          )
        : wrap(content, bodyTextWidth, trustedIcons));
  let offset = ui.scroll;
  // The Models picker and command palette window their lists internally.
  if (modelPickerOpen || paletteView) offset = 0;
  else if (ui.settingsOpen) {
    const selectedStart = ui.settingsRowLines[ui.settingsSelected] ?? 0;
    if (selectedStart < offset) offset = selectedStart;
    else if (selectedStart >= offset + bodyHeight)
      offset = selectedStart - bodyHeight + 1;
  } else if (
    !ui.detail &&
    !ui.confirmation &&
    ui.tab === "chat" &&
    ui.scroll < 0
  ) {
    let followEnd = lines.length;
    if (sessionRunning && bodyHeight === 1 && styled) {
      followEnd = 0;
      for (let index = styled.length - 1; index >= 0; index -= 1) {
        const row = styled[index] ;
        const pipe = row.style === "code" ? row.text.indexOf("│") : -1;
        if (hasVisibleTextFrom(row.text, pipe < 0 ? 0 : pipe + 1)) {
          followEnd = index + 1;
          break;
        }
      }
    } else if (sessionRunning) {
      followEnd = 0;
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (hasVisibleTextFrom(lines[index] )) {
          followEnd = index + 1;
          break;
        }
      }
    }
    offset = Math.max(0, followEnd - bodyHeight);
  } else if (ui.groupTree && !ui.detail) offset = 0;
  else if (
    !ui.detail &&
    !ui.confirmation &&
    !["chat", "policy", "help"].includes(ui.tab)
  ) {
    const selectedLine = content.findIndex((line) => /^(?:▸|›) /.test(line));
    if (selectedLine >= 0) {
      const selectedStart = noWrapPanel
        ? selectedLine
        : wrap(content.slice(0, selectedLine), width - 4, trustedIcons).length;
      if (selectedStart < offset) offset = selectedStart;
      else if (selectedStart >= offset + bodyHeight)
        offset = selectedStart - bodyHeight + 1;
    } else {
      offset = Math.max(0, ui.selected - bodyHeight + 1);
    }
  }
  offset = Math.min(
    Math.max(0, offset),
    Math.max(0, lines.length - bodyHeight),
  );
  ui.viewport = { offset, height: bodyHeight, total: lines.length, width };
  // User prompt rows drive the { and } jumps without depending on display text.
  ui.promptRows = lines
    .map((_line, index) => (styled?.[index]?.promptStart ? index : -1))
    .filter((index) => index >= 0);
  const body = lines.slice(offset, offset + bodyHeight);
  while (body.length < bodyHeight) body.push("");
  if (
    lines[0] === "No entries yet." &&
    (lines.length === 1 || (lines.length === 2 && lines[1] === ""))
  ) {
    body.fill("");
    body[Math.floor((body.length - 1) / 2)] = "No entries yet.";
  }
  const palette = getPalette(ui.themeConfig.colorTheme);
  const symbols = getSymbols(ui.themeConfig.symbolPreset);
  const userMessageMarker = `${symbols.role.user} `;
  const paintMarkdownLine = (
    value        ,
    width        ,
    tone                                        ,
  ) => {
    const parts = inlineMarkdownParts(value);
    const plainWidth = parts.reduce(
      (total, part) => total + visibleLength(part.text),
      0,
    );
    const body = parts
      .map((part) =>
        paintWithPalette(
          part.text,
          part.style === "code" ? "info" : tone,
          palette,
          caps,
          part.style === "strong",
        ),
      )
      .join("");
    return body + " ".repeat(Math.max(0, width - plainWidth));
  };
  const frameColor = ui.confirmation ? amber : mutedAnsi;
  const approvalReviewOpen =
    ui.confirmation?.title.startsWith("APPROVE ") ?? false;
  const undoConfirmationOpen =
    ui.confirmation?.title.startsWith("UNDO ") ?? false;
  const bodyRows = body.map((line, index) => {
    const style = styled?.[offset + index]?.style;
    const chatTone                                         =
      style === "assistant" || style === "heading"
        ? "accent"
        : style === "code" || style === "text"
          ? "fg"
          : style === "quote"
            ? "muted"
            : style === "role-tool"
              ? "warning"
              : style === "role-error"
                ? "warning"
                : style === "error"
                  ? "error"
                  : style === "tool"
                    ? "muted"
                    : /^(Error|Invalid|Failed)/.test(line)
                      ? "error"
                      : "fg";
    // A sweep crosses the newest run's last row while it is live, so the eye
    // is drawn to the line that just changed. It rides on a row that is
    // already coloured and already scrolled to, so it adds attention without
    // adding meaning that a monochrome terminal would lose.
    const isLiveTail =
      sessionRunning &&
      !ui.confirmation &&
      offset + index === lines.length - 1 &&
      lines.length > 1;
    const rowWidth = bodyTextWidth;
    const userWithoutColor =
      ui.tab === "chat" && style === "user" && !colorEnabled;
    const displayLine = userWithoutColor ? `${symbols.frame.v} ${line}` : line;
    const painted = isLiveTail
      ? sweepRow(pad(displayLine, rowWidth), rowWidth, motion, {
          paint: (value) => (visuals.color ? ink(value, `1;${amber}`) : value),
        })
      : pad(displayLine, rowWidth);
    const approvalTitle = approvalReviewOpen && line === ui.confirmation?.title;
    const undoTitle = undoConfirmationOpen && line === ui.confirmation?.title;
    const approvalField =
      approvalReviewOpen &&
      (line.startsWith(APPROVAL_EVIDENCE_LABELS.tool) ||
        line.startsWith(APPROVAL_EVIDENCE_LABELS.class) ||
        line.startsWith(APPROVAL_EVIDENCE_LABELS.blastRadius) ||
        line.startsWith(APPROVAL_EVIDENCE_LABELS.matchedRule) ||
        line.startsWith(APPROVAL_EVIDENCE_LABELS.precondition) ||
        line.startsWith(APPROVAL_EVIDENCE_LABELS.postcondition));
    const operationLabel =
      undoConfirmationOpen && line.startsWith(UNDO_OPERATION_LABEL);
    const contentLabelLength = approvalField
      ? 15
      : operationLabel
        ? UNDO_OPERATION_LABEL.length
        : 0;
    const statusTone =
      /\b(?:error|failed|blocked|denied|refused|unavailable|invalid|stale|missing|corrupt|not verified|no-go)\b/i.test(
        line,
      )
        ? "error"
        : /\b(?:pending|queued|paused|review|unknown|warning|not connected)\b/i.test(
              line,
            )
          ? "warning"
          : /\b(?:ready|connected|verified|approved|settled|healthy|passed|enabled)\b/i.test(
                line,
              )
            ? "success"
            : "fg";
    const settingsRowIndex = ui.settingsOpen
      ? ui.settingsRowLines.indexOf(offset + index)
      : -1;
    const selectedSettingsRow =
      ui.settingsOpen && settingsRowIndex === ui.settingsSelected;
    const selectedListRow =
      (ui.tab !== "chat" && /^(?:▸ |› )\d+\.\s/.test(line)) ||
      selectedSettingsRow;
    const sectionHeading =
      (ui.tab !== "chat" || ui.settingsOpen) &&
      /^(?:OVERVIEW|SETTINGS|APPEARANCE|INTERACTION|HARNESS|WORKSPACE LIMITS|WORKSPACE|HEALTH|STATUS|CONVERSATIONS?|SESSIONS|DOCUMENTS?|LEDGER|APPROVALS?|POLICY|TOOLS|MCP|MODELS|USAGE|HELP|RECOVERY|PROVIDER|RUNS?)(?:$|[\s,·:])/i.test(
        line.trim(),
      );
    const fieldColon = ui.tab !== "chat" && ui.detail ? line.indexOf(":") : -1;
    const chatBold =
      style === "assistant" ||
      style === "role-tool" ||
      style === "role-error" ||
      style === "heading";
    const contentRow = contentLabelLength
      ? ink(painted.slice(0, contentLabelLength), `1;${ice}`) +
        paintWithPalette(
          painted.slice(contentLabelLength),
          chatTone,
          palette,
          caps,
        )
      : selectedSettingsRow
        ? paintWithPalette(painted, "accent", palette, caps)
        : ui.settingsOpen && sectionHeading
          ? paintWithPalette(painted, "accent", palette, caps, true)
          : ui.tab === "chat" && style === "user"
            ? painted.startsWith(userMessageMarker)
              ? `${paintWithPalette(userMessageMarker, "accent", palette, caps, true)}${paintUserMessage(
                  painted.slice(userMessageMarker.length),
                  palette,
                  colorEnabled ? caps : { ...caps, ansi: false, colorDepth: 0 },
                )}`
              : paintUserMessage(
                  painted,
                  palette,
                  colorEnabled ? caps : { ...caps, ansi: false, colorDepth: 0 },
                )
            : ui.tab === "chat" &&
                styled?.[offset + index]?.markdown &&
                !isLiveTail
              ? paintMarkdownLine(displayLine, rowWidth, chatTone)
              : ui.tab === "chat"
                ? paintWithPalette(
                    painted,
                    approvalTitle || undoTitle ? "warning" : chatTone,
                    palette,
                    caps,
                    approvalTitle || undoTitle || chatBold,
                  )
                : selectedListRow
                  ? paintWithPalette(painted, "accent", palette, caps, true)
                  : sectionHeading
                    ? paintWithPalette(painted, "accent", palette, caps, true)
                    : fieldColon > 0 && fieldColon < 30
                      ? paintWithPalette(
                          painted.slice(0, fieldColon + 1),
                          "muted",
                          palette,
                          caps,
                        ) +
                        paintWithPalette(
                          painted.slice(fieldColon + 1),
                          statusTone,
                          palette,
                          caps,
                        )
                      : paintWithPalette(painted, statusTone, palette, caps);
    const sideTone = frameColor;
    return (
      ink(ui.confirmation ? "! " : "  ", sideTone) +
      contentRow +
      (ui.confirmation ? ink(" !", frameColor) : ink("  ", sideTone))
    );
  });
  const renderedBodyRows = bodyRows;
  const baseListVisible =
    ui.tab !== "chat" &&
    !ui.confirmation &&
    !modelPickerOpen &&
    !paletteView &&
    (!ui.detail || (ui.tab === "documents" && ui.documentPreview)) &&
    !ui.diffView &&
    !ui.palette &&
    !ui.showingKeybindings &&
    !ui.showingCheatSheet;
  if (baseListVisible) {
    const bodyStart = header.length + banner.length + shownToastRows.length;
    const treeNodes = ui.groupTree
      ? flattenTree(ui.groupTree.nodes, ui.groupTree.state)
      : [];
    const treeHeight =
      ui.tab === "documents" && ui.documentPreview
        ? documentLayout?.sideBySide
          ? bodyHeight
          : Math.max(1, Math.floor(bodyHeight / 2))
        : sessionLayout
          ? sessionLayout.treeHeight
          : Math.max(1, bodyHeight - (ui.tab === "sessions" ? 5 : 4));
    const treePaneEnd =
      ui.tab === "documents" && ui.documentPreview && documentLayout?.sideBySide
        ? documentLayout.treeWidth + 3 + panelTopOffset
        : sessionLayout?.sideBySide
          ? sessionLayout.treeWidth + 3 + panelTopOffset
          : undefined;
    const treeStart =
      ui.groupTree && ui.groupTree.state.cursor >= treeHeight
        ? Math.min(
            ui.groupTree.state.cursor - treeHeight + 1,
            Math.max(0, treeNodes.length - 1),
          )
        : 0;
    let visibleTreeIndex = treeStart;
    body.forEach((line, index) => {
      let kind                             ;
      let targetIndex = -1;
      if (ui.groupTree && /^(?:▸ |› |  )(?:\[(?:[-+])\] | {4})/.test(line)) {
        kind = "tree";
        targetIndex = visibleTreeIndex++;
      } else {
        const match = /^(?:▸ |› |  )(\d+)\.\s/.exec(line);
        if (match) {
          kind = "item";
          targetIndex = Number(match[1]) - 1;
        }
      }
      const screenRow = bodyStart + index + 1 + panelTopOffset;
      if (
        kind &&
        targetIndex >= 0 &&
        screenRow <= height + panelTopOffset &&
        (kind !== "item" || targetIndex < ui.items().length) &&
        (kind !== "tree" || targetIndex < treeNodes.length)
      ) {
        ui.rowHitTargets.push({
          row: screenRow,
          start: 1 + panelTopOffset,
          end:
            kind === "tree" && treePaneEnd !== undefined
              ? treePaneEnd
              : width + panelTopOffset,
          kind,
          index: targetIndex,
        });
      }
    });
  } else if (ui.settingsOpen) {
    const bodyStart = header.length + banner.length + shownToastRows.length;
    ui.settingsRowLines.forEach((contentRow, index) => {
      const bodyIndex = contentRow - offset;
      const screenRow = bodyStart + bodyIndex + 1 + panelTopOffset;
      if (
        bodyIndex < 0 ||
        bodyIndex >= bodyHeight ||
        screenRow > height + panelTopOffset
      )
        return;
      ui.rowHitTargets.push({
        row: screenRow,
        start: 1 + panelTopOffset,
        end: width + panelTopOffset,
        kind: "setting",
        index,
      });
    });
  } else if (modelPickerOpen && ui.modelPicker) {
    const picker = ui.modelPicker;
    const matches = modelPickerMatches(picker.models, picker.query);
    const bodyStart = header.length + banner.length + shownToastRows.length;
    const pickerColumns = width - 4;
    const sideBySidePicker = pickerColumns >= 88;
    const sidebarWidth = sideBySidePicker
      ? Math.min(28, Math.max(20, Math.floor(pickerColumns * 0.27)))
      : 0;
    const addPickerHitTarget = (
      kind                      ,
      index        ,
      contentRow        ,
    ) => {
      const rowStart = contentRow;
      const rowHeight = 1;
      for (let line = 0; line < rowHeight; line++) {
        const bodyIndex = rowStart + line - offset;
        const screenRow = bodyStart + bodyIndex + 1 + panelTopOffset;
        if (
          bodyIndex < 0 ||
          bodyIndex >= bodyHeight ||
          screenRow > height + panelTopOffset
        )
          continue;
        ui.rowHitTargets.push({
          row: screenRow,
          start:
            !sideBySidePicker || kind === "provider"
              ? 1 + panelTopOffset
              : Math.min(width, sidebarWidth + 6 + panelTopOffset),
          end:
            sideBySidePicker && kind === "provider"
              ? sidebarWidth + 1 + panelTopOffset
              : width + panelTopOffset,
          kind,
          index,
        });
      }
    };
    if (sideBySidePicker) {
      // The wide layout shows independent provider and model windows. Map each
      // hit target to its row within the same window the renderer displayed.
      const visibleRows = Math.max(1, bodyHeight - 2);
      const providerStart = modelPickerWindowStart(
        picker.providerIndex,
        picker.providers.length,
        visibleRows,
        picker.providerWindowStart,
      );
      const modelStart = modelPickerWindowStart(
        picker.selected,
        matches.length,
        visibleRows,
        picker.modelWindowStart,
      );
      for (
        let rowOffset = 0;
        rowOffset < visibleRows &&
        providerStart + rowOffset < picker.providers.length;
        rowOffset++
      )
        addPickerHitTarget(
          "provider",
          providerStart + rowOffset,
          2 + rowOffset,
        );
      for (
        let rowOffset = 0;
        rowOffset < visibleRows && modelStart + rowOffset < matches.length;
        rowOffset++
      )
        addPickerHitTarget("model", modelStart + rowOffset, 2 + rowOffset);
    } else if (picker.focusedPane === "providers") {
      const visibleRows = Math.max(1, bodyHeight - 5);
      const providerStart = modelPickerWindowStart(
        picker.providerIndex,
        picker.providers.length,
        visibleRows,
        picker.providerWindowStart,
      );
      for (
        let rowOffset = 0;
        rowOffset < visibleRows &&
        providerStart + rowOffset < picker.providers.length;
        rowOffset++
      )
        addPickerHitTarget(
          "provider",
          providerStart + rowOffset,
          3 + rowOffset,
        );
    } else {
      const visibleRows = Math.max(1, bodyHeight - 5);
      const modelStart = modelPickerWindowStart(
        picker.selected,
        matches.length,
        visibleRows,
        picker.modelWindowStart,
      );
      for (
        let rowOffset = 0;
        rowOffset < visibleRows && modelStart + rowOffset < matches.length;
        rowOffset++
      )
        addPickerHitTarget("model", modelStart + rowOffset, 3 + rowOffset);
    }
  }
  if (ui.hoveredRow) {
    const hovered = ui.rowHitTargets.find(
      (target) =>
        target.kind === ui.hoveredRow?.kind &&
        target.index === ui.hoveredRow?.index,
    );
    const topRow =
      header.length + banner.length + shownToastRows.length + panelTopOffset;
    const bodyIndex = hovered ? hovered.row - topRow - 1 : -1;
    const selected =
      hovered?.kind === "item"
        ? ui.selected === hovered.index
        : hovered?.kind === "tree"
          ? ui.groupTree?.state.cursor === hovered.index
          : hovered?.kind === "provider"
            ? ui.modelPicker?.providerIndex === hovered.index
            : hovered?.kind === "model"
              ? ui.modelPicker?.selected === hovered.index
              : hovered?.kind === "setting"
                ? ui.settingsSelected === hovered.index
                : true;
    if (!selected && bodyIndex >= 0 && bodyIndex < bodyRows.length) {
      const row = bodyRows[bodyIndex] ;
      const ansiPrefix = row.match(/^(?:\x1b\[[0-9;]*m)*/)?.[0] ?? "";
      const unstyled = row.slice(ansiPrefix.length);
      if (unstyled.startsWith("  "))
        bodyRows[bodyIndex] = `${ansiPrefix}› ${unstyled.slice(2)}`;
    }
  }
  const events = ui.session()?.events ?? [];
  const eventSummary = chatEventSummary(events);
  const latestUser = eventSummary.latestUser;
  const latestUserAt = latestUser ? Date.parse(latestUser.at) : NaN;
  const elapsed =
    visuals.now &&
    Number.isFinite(latestUserAt) &&
    ui.session()?.status === "running"
      ? ` / ${Math.max(0, Math.floor((visuals.now - latestUserAt) / 1000))}s`
      : "";
  const lastEvent = eventSummary.lastVisible;
  // The phase icon carries the same word as the label beside it, so the glyph
  // is recognition speed rather than the only signal.
  //
  // Every glyph here is single cell. The pencil U+270E that would read as
  // "writing" counts two in layout.ts, which would push this status row one
  // column past its width and, on a narrow terminal, drop the Esc stop hint
  // off the end.
  const activeToolName =
    (lastEvent?.type === "tool.started" || lastEvent?.type === "tool.result") &&
    typeof lastEvent.payload?.tool === "string"
      ? sanitizeText(lastEvent.payload.tool)
      : "";
  const lastToolResult =
    lastEvent?.type === "tool.result"
      ? toolDetailRecord(lastEvent.payload?.result)
      : undefined;
  const phase =
    lastEvent?.type === "tool.started"
      ? `${ROW_ICONS.tool} ${compactToolText(lastEvent, activeToolName || "tool")}`
      : lastEvent?.type === "message.delta"
        ? `${ROW_ICONS.edit} Writing response`
        : lastEvent?.type === "tool.result"
          ? `${ROW_ICONS.tool} ${activeToolName || "Tool"} · ${lastToolResult?.isError === true ? "failed" : "result received"}`
          : lastEvent?.type === "message.completed" &&
              lastEvent.payload?.toolCallsPresent === true
            ? `${ROW_ICONS.tool} Dispatching requested tools`
            : `◌ Thinking`;
  // Live ellipsis, frozen when motion is off so paused frames stay equal.
  const dots =
    visuals.motion === false ? "" : ".".repeat(1 + (Math.floor(frame / 3) % 3));
  const historyStatus =
    richChat && ui.scroll >= 0
      ? `History ${offset + 1}-${Math.min(offset + bodyHeight, lines.length)}/${lines.length} / /bottom to follow`
      : undefined;
  const usage = eventSummary.usage;
  const usageTokens =
    typeof usage?.total_tokens === "number" ? usage.total_tokens : "?";
  // Status segments with theme colors (omp-style segment catalog)
  // ink() takes an SGR code, not a pre-painted glyph.
  const muted = mutedAnsi;
  const seg = (
    label        ,
    value        ,
    tone                       = "accent",
  ) =>
    `${paintWithPalette(label, "muted", palette, caps)} ${paintWithPalette(value, tone, palette, caps)}`;

  const segments           = [];
  // Model segment
  let modelShown = fit(
    sanitizeText(ui.session()?.model || ui.model || "offline"),
    24,
  );
  segments.push(seg("model", modelShown, "accent"));
  // Mode segment
  const modeLabel = modeAuthorityLabel(ui.mode);
  // The mode is the one setting that changes what a later key is allowed to
  // do, so it gets a pill: a shape the eye finds without reading it. The word
  // stays inside the pill, so the rails are never the only signal.
  segments.push(
    seg(
      "mode",
      pill(`${MODE_ICON[ui.mode]} ${modeLabel}`, "info", motion, {
        paint: (value, tone, bold) =>
          paintWithPalette(value, tone, palette, caps, bold),
      }),
      "info",
    ),
  );
  // Tokens & cost
  const costStr =
    typeof usage?.cost === "number" ? `$${usage.cost.toFixed(4)}` : "?";
  segments.push(seg("tokens", String(usageTokens), "success"));
  segments.push(seg("cost", costStr, "warning"));
  // Approvals & queue
  const holdCount = ui.workbench.pending().length + ui.proxy.holds.length;
  if (holdCount > 0) segments.push(seg("holds", `◉ ${holdCount}`, "error"));
  if (ui.tab === "chat" && ui.queuedPrompt)
    segments.push(
      seg("queue", ui.queuedPromptPaused ? "paused" : "+1 queued", "warning"),
    );
  segments.push(seg("activity", ui.toolActivityMode, "muted"));
  // A run with no reported progress gets an indeterminate bar rather than a
  // percentage, because there is no honest fraction to print and a frozen 0%
  // would read as stalled rather than running.
  if (sessionRunning && !waiting) {
    const activeRun = ui.workbench
      .runs()
      .find((run                       ) => run.sessionId === ui.sessionId);
    if (activeRun && activeRun.progress === null) {
      segments.push(
        paintWithPalette(indeterminateBar(12, motion), "accent", palette, caps),
      );
    } else if (activeRun && typeof activeRun.progress === "number") {
      segments.push(
        paintWithPalette(
          animatedBar(activeRun.progress, 1, 12, motion),
          "accent",
          palette,
          caps,
        ),
      );
    }
  }

  // Live run badges-named sessions that are actively running.
  // Shows up to 3 running sessions with their progress.
  const runningRuns = [...ui.workbench.runs()].filter(
    (run                                      ) =>
      run.state === "running" ||
      run.state === "stopping" ||
      run.state === "paused",
  );
  if (runningRuns.length > 0) {
    const runBadges = runningRuns.slice(0, 3).map((run) => {
      const sess = ui.workbench.list().find((s) => s.id === run.sessionId);
      const title = sess?.title ?? run.sessionId.slice(0, 8);
      const pct =
        run.progress === null ? "?" : `${Math.round(run.progress * 100)}%`;
      return `${title} ${pct}`;
    });
    segments.push(
      paintWithPalette("▶", "accent", palette, caps) +
        " " +
        runBadges.join(" · "),
    );
  }

  // Live approval pulse-the oldest pending hold gets a breathing dot.
  // Only when there are holds and not in a confirmation modal.
  const pendingHolds = ui.workbench.pending();
  if (pendingHolds.length > 0 && !ui.confirmation) {
    // Holds have expiresAt; the one expiring soonest is the most urgent.
    const oldest = pendingHolds.reduce((a, b) =>
      a.expiresAt < b.expiresAt ? a : b,
    );
    const pulse =
      motion.enabled && !motion.reduced ? approvalPulse(motion) : "●";
    const tool = oldest.call?.tool ?? "tool";
    const badge = paintWithPalette(
      `${pulse} ${tool} ${oldest.holdId.slice(0, 6)}`,
      "error",
      palette,
      caps,
    );
    segments.push(badge);
  }

  // Queue indicator with live count and animation.
  if (ui.queuedPrompt) {
    const qPulse =
      motion.enabled && !motion.reduced
        ? ".".repeat(1 + (Math.floor(motion.frame / 4) % 3))
        : "";
    const qState = ui.queuedPromptPaused ? "paused" : `+1${qPulse}`;
    segments.push(
      paintWithPalette("⏳", "warning", palette, caps) +
        ` ${seg("queue", qState, "warning")}`,
    );
  }

  const compactContextOrQueue =
    ui.tab === "chat" || !ui.queuedPrompt
      ? segments[2] 
      : seg("queue", ui.queuedPromptPaused ? "paused" : "+1 queued", "warning");
  // Join with theme separator, respecting width
  const sep = paintWithPalette(symbols.separator.dot, "muted", palette, caps);
  let summary = segments.join(` ${sep} `);
  // Measure the row that actually contains the model, not the unsplit summary.
  while (
    visibleLength(
      width < 50
        ? `${segments[0]} ${sep} ${compactContextOrQueue}`
        : width < 100
          ? segments.slice(0, 2).join(` ${sep} `)
          : summary,
    ) > width &&
    visibleLength(modelShown) > 8
  ) {
    const next = fit(modelShown, visibleLength(modelShown) - 1);
    if (next === modelShown) break;
    modelShown = next;
    segments[0] = seg("model", modelShown, "accent");
    summary = segments.join(` ${sep} `);
  }
  const summaryRows =
    width < 50
      ? [
          paintWithPalette(
            `mode: ${ui.mode} (local; unenforced)`,
            "info",
            palette,
            caps,
          ),
          `${segments[0]} ${sep} ${compactContextOrQueue}`,
        ]
      : width < 100
        ? [
            segments.slice(0, 2).join(` ${sep} `),
            segments.slice(2).join(` ${sep} `),
          ]
        : [summary];
  // Compact color legends arrive painted; spacious-shell hints are kept plain
  // until this point so they can be quieted without exposing escape bytes.
  const paintedLegendRows =
    visuals.color === true
      ? spaciousShell
        ? visibleLegendRows.map((row) => ink(row, mutedAnsi))
        : visibleLegendRows
      : visibleLegendRows.map((row) => ink(text(row), muted));
  const todoBadge = (() => {
    try {
      return eventSummary.totalTodos
        ? ` | ✓ ${eventSummary.totalTodos - eventSummary.openTodos}/${eventSummary.totalTodos} todos`
        : "";
    } catch {
      return "";
    }
  })();
  const paletteMatches = paletteView?.items.length ?? 0;
  // The palette status names the match count and the key that runs the
  // selection, because an empty result set and a closed overlay look the
  // same otherwise.
  const status = paletteView
    ? `${paletteMatches} command${paletteMatches === 1 ? "" : "s"}${width < 50 ? "" : " match"} / Enter run / Esc close`
    : ui.confirmation
      ? width < 50
        ? "Review y accept n reject Esc cancel"
        : "[!] REVIEW / y accept / n reject / Esc cancel / PgDn preview"
      : sessionRunning
        ? `${spinner} ${waiting ? "[wait] Waiting for approval" : `● ${phase}${dots}`}${elapsed} / Esc stop${historyStatus ? " / [history] reading history" : ""}${todoBadge}`
        : busy
          ? `${spinner} Working${dots}`
          : workbenchRunning
            ? `${spinner} Workspace working`
            : `${historyStatus ?? (panelOverlay && ui.notice === "Ready" ? "" : ui.notice)}`;
  const menuRows = menu.map(([name, description], i) =>
    ink(
      text(
        `${i + menuStart === selection ? " ›" : "  "} ${name.padEnd(13)} ${description}`,
      ),
      i + menuStart === selection ? `1;${ice}` : muted,
    ),
  );
  // The caret marker is a one-cell placeholder so animation cannot alter
  // wrapping in the fixed Chat composer.
  const caret = typeCursor(
    ui.palette !== undefined || ui.tab === "chat" || editing,
    motion,
  );
  // Narrow overflows cannot fit a page hint in the status row, so reuse the
  // body/control divider only when the current view has more content.
  const scrollCue = ui.confirmation
    ? " PgDn preview "
    : ui.showingKeybindings
      ? " PgDn scroll "
      : undefined;
  const scrollCueRuleRows =
    scrollCue &&
    width >= scrollCue.length &&
    width < 50 &&
    ui.viewport.total > ui.viewport.height
      ? ruleRows.map((row) => {
          const start = Math.floor((row.length - scrollCue.length) / 2);
          return (
            `${row.slice(0, start)}${scrollCue}` +
            row.slice(start + scrollCue.length)
          );
        })
      : ruleRows;
  if (chatBaseVisible) {
    const sessions = ui.workbench.list();
    const activeSubagents = sessions.filter(
      (session) => session.parentId && session.status === "running",
    ).length;
    const activeShells = ui.activeShellCommands;
    const chatFrame = (() => {
      if (!useChatFrame) return undefined;
      if (symbols.frame.tl === "+") return symbols.frame;
      if (ui.chatPanelVisuals.frame === "rounded")
        return {
          ...symbols.frame,
          tl: "╭",
          tr: "╮",
          bl: "╰",
          br: "╯",
          h: "─",
          v: "│",
        };
      return ui.chatPanelVisuals.frame === "square"
        ? {
            ...symbols.frame,
            tl: "┌",
            tr: "┐",
            bl: "└",
            br: "┘",
            h: "─",
            v: "│",
          }
        : {
            ...symbols.frame,
            tl: "╔",
            tr: "╗",
            bl: "╚",
            br: "╝",
            h: "═",
            v: "║",
          };
    })();
    // Match OMP's compact status rail and Prime's theme-derived composer.
    // Framed input stays transparent; only the optional filled surface gets
    // a background. The terminal canvas remains inherited in either mode.
    const currentSession = ui.session();
    const selectedModel = currentSession?.model || ui.model;
    const contextModelIds = (modelId        ) => {
      const ids = [modelId];
      const effortSuffix = /:(?:minimal|low|medium|high|xhigh)$/i.exec(modelId);
      if (effortSuffix?.index !== undefined)
        ids.push(modelId.slice(0, effortSuffix.index));
      return ids;
    };
    const selectedContextModelIds = new Set(contextModelIds(selectedModel));
    const usageMatchesSelectedModel = (modelId        ) =>
      contextModelIds(modelId).some((candidate) =>
        selectedContextModelIds.has(candidate),
      );
    const sessionProviderMatches = currentSession
      ? typeof currentSession.provider === "string" &&
        currentSession.provider === ui.provider?.baseUrl
      : true;
    const contextProviderId = currentSession?.provider ?? ui.provider?.baseUrl;
    const catalogContextModel = sessionProviderMatches
      ? ui.provider?.models.find((model) =>
          selectedContextModelIds.has(model.id),
        )
      : undefined;
    const catalogContextWindow =
      catalogContextModel?.contextWindow ??
      ui.modelContextWindow(contextProviderId, selectedContextModelIds);
    const contextDescriptor =
      sessionProviderMatches &&
      ui.provider?.providerId &&
      ui.provider.transport &&
      ui.provider.baseUrl
        ? ui.provider.availableProviderDescriptors.find(
            (descriptor) =>
              descriptor.providerId === ui.provider?.providerId &&
              descriptor.transport === ui.provider?.transport &&
              descriptor.endpoint === ui.provider?.baseUrl &&
              descriptor.models.some((modelId) =>
                selectedContextModelIds.has(modelId),
              ),
          )
        : undefined;
    const descriptorModelId = contextDescriptor?.models.find((modelId) =>
      selectedContextModelIds.has(modelId),
    );
    const manifestContextWindow = contextDescriptor
      ? modelCapabilityDisclosure(
          contextDescriptor.id,
          descriptorModelId ?? selectedModel,
        )
      : undefined;
    const disclosedContextWindow =
      manifestContextWindow?.status === "known"
        ? manifestContextWindow.contextWindow
        : undefined;
    const contextWindow =
      typeof catalogContextWindow === "number" &&
      Number.isFinite(catalogContextWindow) &&
      catalogContextWindow > 0
        ? catalogContextWindow
        : disclosedContextWindow;
    const usageModel = eventSummary.usage?.model;
    const usageMatchesContext =
      sessionProviderMatches &&
      (typeof usageModel !== "string" || usageMatchesSelectedModel(usageModel));
    const reportedPromptTokens = usageMatchesContext
      ? (eventSummary.usage?.prompt_tokens ?? eventSummary.usage?.input_tokens)
      : undefined;
    const outputTokens =
      eventSummary.usage?.completion_tokens ??
      eventSummary.usage?.output_tokens;
    const totalReportedTokens = eventSummary.usage?.total_tokens;
    const promptTokens =
      typeof reportedPromptTokens === "number" &&
      Number.isFinite(reportedPromptTokens) &&
      reportedPromptTokens >= 0
        ? reportedPromptTokens
        : usageMatchesContext &&
            typeof totalReportedTokens === "number" &&
            Number.isFinite(totalReportedTokens) &&
            typeof outputTokens === "number" &&
            Number.isFinite(outputTokens) &&
            outputTokens >= 0 &&
            totalReportedTokens >= outputTokens
          ? totalReportedTokens - outputTokens
          : undefined;
    const contextPercentage =
      typeof contextWindow === "number" &&
      Number.isFinite(contextWindow) &&
      contextWindow > 0 &&
      typeof promptTokens === "number" &&
      Number.isFinite(promptTokens) &&
      promptTokens >= 0
        ? `${Math.min(100, Math.round((promptTokens / contextWindow) * 100))}%`
        : "—";
    const contextCapacity =
      typeof contextWindow === "number" &&
      Number.isFinite(contextWindow) &&
      contextWindow > 0
        ? contextWindow >= 1_000_000
          ? `${Math.round(contextWindow / 100_000) / 10}m`.replace(/\.0m$/, "m")
          : `${Math.round(contextWindow / 1_000)}k`
        : "unknown";
    const chatRunActive = busy || sessionRunning;
    const activityLabel = ui.hideToolActivity
      ? "Activity hidden · Ctrl+Shift+O show"
      : chatRunActive
        ? `Activity ${ui.toolActivityMode} · Ctrl+O cycle`
        : `Activity ${ui.toolActivityMode}`;
    const composerStatusLabel = fit(
      chatRunActive
        ? waiting
          ? "Review required"
          : `${runningIndicator(motion)} ${phase}${dots}`
        : "",
      Math.max(0, width - 5),
    );
    const statusRuleCells = Math.max(
      0,
      width - 5 - visibleLength(composerStatusLabel),
    );
    const paintComposerFrame = (line        ) =>
      paintWithPalette(line, "accent", palette, caps);
    const chatInputFrameTopRows = chatFrame
      ? (() => {
          const topLine = composerStatusLabel
            ? `${chatFrame.tl}${chatFrame.h} ${paintWithPalette(composerStatusLabel, waiting ? "warning" : "info", palette, caps)} ${chatFrame.h.repeat(statusRuleCells)}${chatFrame.tr}`
            : `${chatFrame.tl}${chatFrame.h.repeat(Math.max(0, width - 2))}${chatFrame.tr}`;
          return [paintComposerFrame(topLine)];
        })()
      : [];
    const chatInputFrameBottomRows = chatFrame
      ? [
          paintComposerFrame(
            `${chatFrame.bl}${chatFrame.h.repeat(Math.max(0, width - 2))}${chatFrame.br}`,
          ),
        ]
      : [];
    const chatInputRows = composerViewport.map((value, index) => {
      const rowPrefix =
        index === composerCenterRow
          ? `${composerPrompt} `
          : " ".repeat(composerPromptWidth);
      const cursorIndex = value.indexOf(composerCursorMarker);
      // Sanitize only draft text. The prompt icon and caret are generated
      // render tokens and must not be escaped into visible ANSI source text.
      const draftText =
        cursorIndex < 0
          ? sanitizeText(value)
          : `${sanitizeText(value.slice(0, cursorIndex))}${caret}${sanitizeText(value.slice(cursorIndex + composerCursorMarker.length))}`;
      const contentText = `${rowPrefix}${draftText}`;
      const contentRow = pad(
        chatFrame ? ` ${contentText}` : contentText,
        composerInner,
      );
      const content = chatFrame
        ? paintWithPalette(contentRow, "fg", palette, caps)
        : paintUserMessage(contentRow, palette, caps);
      if (!chatFrame) return content;
      return `${paintWithPalette(chatFrame.v, "accent", palette, caps)}${content}${paintWithPalette(chatFrame.v, "accent", palette, caps)}`;
    });
    const composerModeText = activityLabel;
    const composerModeLabel = fit(composerModeText, width);
    const composerModeRow = paintWithPalette(
      `${" ".repeat(Math.max(0, width - visibleLength(composerModeLabel)))}${composerModeLabel}`,
      "muted",
      palette,
      caps,
    );
    const chatNav = width >= 96 ? "← Sessions · double-click" : "← Sessions ×2";
    const modelIcon = ui.localTabIcons
      ? kittyTabIconLabel("models", ui.localTabIcons, ui.themeConfig.colorTheme)
      : symbols.icons.model;
    const contextIcon =
      (ui.localTabIcons
        ? kittySemanticIconLabel(
            "context",
            ui.localTabIcons,
            ui.themeConfig.colorTheme,
          )
        : "") || symbols.icons.context;
    (ui.localTabIcons
        ? kittySemanticIconLabel(
            "queue",
            ui.localTabIcons,
            ui.themeConfig.colorTheme,
          )
        : "") || symbols.icons.queue;
    const contextPercentValue = /^\d+%$/.test(contextPercentage)
      ? Number.parseInt(contextPercentage, 10)
      : undefined;
    const contextBar =
      contextPercentValue === undefined
        ? ""
        : ` ${"▰".repeat(Math.round(contextPercentValue / 20))}${"▱".repeat(5 - Math.round(contextPercentValue / 20))}`;
    const modelStatusText = selectedModel
      ? sanitizeText(selectedModel)
      : "No model selected";
    const modelStatusIcon = paintWithPalette(
      modelIcon,
      "accent",
      palette,
      caps,
    );
    const contextStatusText = `${contextIcon} ${contextCapacity} ${contextBar} ${contextPercentage}`;
    const contextStatusRow = `${paintWithPalette(contextIcon, "info", palette, caps)} ${paintWithPalette(contextCapacity, "muted", palette, caps)}${contextBar ? ` ${paintWithPalette(contextBar.trim(), contextPercentValue !== undefined && contextPercentValue >= 80 ? "warning" : "info", palette, caps)}` : ""} ${paintWithPalette(contextPercentage, contextPercentValue !== undefined && contextPercentValue >= 80 ? "warning" : "muted", palette, caps)}`;
    const contextStatusCompact = `${contextCapacity} ${contextPercentage}`;
    const contextStatusIconCompact = `${symbols.icons.context} ${contextStatusCompact}`;
    const contextStatusRowFor = (availableWidth        ) => {
      if (visibleLength(contextStatusRow) <= availableWidth)
        return contextStatusRow;
      if (visibleLength(contextStatusIconCompact) <= availableWidth)
        return paintWithPalette(
          contextStatusIconCompact,
          "info",
          palette,
          caps,
        );
      if (visibleLength(contextStatusCompact) <= availableWidth)
        return paintWithPalette(contextStatusCompact, "muted", palette, caps);
      return paintWithPalette(
        fit(contextPercentage, availableWidth),
        "muted",
        palette,
        caps,
      );
    };
    const modelStatusRow = (availableWidth        ) => {
      const iconFits = visibleLength(modelIcon) + 2 <= availableWidth;
      const icon = iconFits ? `${modelStatusIcon} ` : "";
      return `${icon}${paintWithPalette(
        fit(
          modelStatusText,
          Math.max(
            1,
            availableWidth - (iconFits ? visibleLength(modelIcon) + 1 : 0),
          ),
        ),
        "accent",
        palette,
        caps,
      )}`;
    };
    const chatStatusRows =
      chatStatusRowCount === 1
        ? (() => {
            const modelSpace = Math.max(
              1,
              width -
                visibleLength(chatNav) -
                visibleLength(contextStatusText) -
                4,
            );
            const modelRow = modelStatusRow(modelSpace);
            const rightStatus = `${modelRow}  ${contextStatusRowFor(width)}`;
            return [
              `${paintWithPalette(chatNav, "muted", palette, caps)}${" ".repeat(
                Math.max(
                  1,
                  width - visibleLength(chatNav) - visibleLength(rightStatus),
                ),
              )}${rightStatus}`,
            ];
          })()
        : [
            paintWithPalette(fit(chatNav, width), "muted", palette, caps),
            modelStatusRow(width),
            contextStatusRowFor(width),
          ];
    const activitySegment = (
      icon        ,
      fallbackIcon        ,
      value        ,
      label        ,
      tone                                        ,
    ) => {
      // Keep measured values stable. Image icons get a small animated activity
      // bead; terminals without Kitty graphics pulse the semantic fallback.
      const pulse = motion.enabled && !motion.reduced && motion.frame % 8 < 2;
      const isActive =
        value !== "0" && value !== "n/a" && value !== "unavailable";
      const iconContent = icon
        ? `${icon}${pulse && isActive ? paintWithPalette("•", tone, palette, caps) : ""}`
        : paintWithPalette(fallbackIcon, tone, palette, caps, pulse);
      return `${iconContent} ${value}${label ? ` ${label}` : ""}`;
    };
    const activityIconLabel = (key        ) =>
      ui.localTabIcons
        ? kittyActivityIconLabel(
            key,
            ui.localTabIcons,
            ui.themeConfig.colorTheme,
          )
        : "";
    const activityIcons = {
      subagents: activityIconLabel("subagents"),
      heartbeats: activityIconLabel("heartbeats"),
      shells: activityIconLabel("shells"),
      queue: ui.localTabIcons
        ? kittySemanticIconLabel(
            "queue",
            ui.localTabIcons,
            ui.themeConfig.colorTheme,
          )
        : "",
    };
    const activityFallbackIcons = {
      subagents: symbols.icons.agent,
      heartbeats: symbols.icons.heartbeat,
      shells: symbols.icons.shell,
      queue: symbols.icons.queue,
    };
    const queuedCount = ui.queuedPrompt ? "1" : "0";
    const queuedLabel = ui.queuedPrompt
      ? ui.queuedPromptPaused
        ? "paused"
        : "queued"
      : "queued";
    const chatActivityFull =
      `  ${activitySegment(activityIcons.subagents, activityFallbackIcons.subagents, String(activeSubagents), `subagent${activeSubagents === 1 ? "" : "s"}`, "success")}  ·  ` +
      `${activitySegment(activityIcons.heartbeats, activityFallbackIcons.heartbeats, "unavailable" , "" , "warning")}  ·  ` +
      activitySegment(
        activityIcons.shells,
        activityFallbackIcons.shells,
        String(activeShells),
        `shell${activeShells === 1 ? "" : "s"}`,
        "info",
      ) +
      `  ·  ${activitySegment(activityIcons.queue, activityFallbackIcons.queue, queuedCount, queuedLabel, "warning")}`;
    const chatActivityCompact =
      `  ${activitySegment(activityIcons.subagents, activityFallbackIcons.subagents, String(activeSubagents), "sub", "success")}  ·  ` +
      `${activitySegment(activityIcons.heartbeats, activityFallbackIcons.heartbeats, "n/a" , "hb", "warning")}  ·  ` +
      activitySegment(
        activityIcons.shells,
        activityFallbackIcons.shells,
        String(activeShells),
        "sh",
        "info",
      ) +
      `  ·  ${activitySegment(activityIcons.queue, activityFallbackIcons.queue, queuedCount, ui.queuedPromptPaused ? "pause" : "q", "warning")}`;
    const chatActivityNarrow =
      ` ${activitySegment(activityIcons.subagents, activityFallbackIcons.subagents, String(activeSubagents), "", "success")} · ` +
      `${activitySegment(activityIcons.heartbeats, activityFallbackIcons.heartbeats, "n/a" , "", "warning")} · ` +
      activitySegment(
        activityIcons.shells,
        activityFallbackIcons.shells,
        String(activeShells),
        "",
        "info",
      ) +
      ` · ${activitySegment(activityIcons.queue, activityFallbackIcons.queue, queuedCount, "", "warning")}`;
    const chatActivityRow = fit(
      visibleLength(chatActivityFull) <= width
        ? chatActivityFull
        : visibleLength(chatActivityCompact) <= width
          ? chatActivityCompact
          : chatActivityNarrow,
      width,
    );
    const separatorRow = ink("─".repeat(width), mutedAnsi);
    const chatInputFooter = [
      composerModeRow,
      ...chatInputFrameTopRows,
      ...chatInputRows,
      ...chatInputFrameBottomRows,
      ...chatStatusRows,
      separatorRow,
      chatActivityRow,
    ];
    const chatPrefix = [
      ...header,
      ...banner.map((row) =>
        ink(
          text(banner.length ? row.replace("[!]", approvalPulse(motion)) : row),
          `1;${amber}`,
        ),
      ),
      ...shownToastRows,
    ];
    const chatOverlays = [
      ...menuRows,
      ...(argumentHint
        ? [
            ink(
              fit(`  ${ROW_ICONS.unknown} expects: ${argumentHint}`, width),
              muted,
            ),
          ]
        : []),
    ];
    const availableBodyRows = Math.max(
      0,
      height -
        chatPrefix.length -
        chatOverlays.length -
        chatInputFooter.length -
        chatPanelTopMarginY,
    );
    const visibleChatBody = bodyRows.slice(0, availableBodyRows);
    const statusRowNumber =
      chatPrefix.length +
      chatPanelTopMarginY +
      visibleChatBody.length +
      chatOverlays.length +
      chatInputRows.length +
      1 +
      chatInputFrameTopRows.length +
      chatInputFrameBottomRows.length;
    // SGR mouse coordinates are one-based, so publish the rendered status row
    // and horizontal hitbox in terminal coordinates rather than array offsets.
    const chatStatusStart = chatPanelMarginX + 1;
    ui.tabHitTargets.push({
      tab: "sessions",
      row: statusRowNumber + 1,
      start: chatStatusStart,
      end: chatStatusStart + Math.min(width, visibleLength(chatNav)) - 1,
    });
    ui.viewport = { ...ui.viewport, height: visibleChatBody.length };
    const chatRows = [
      ...visibleChatBody,
      ...chatOverlays,
      ...chatInputFooter,
    ].map((row) => pad(row, width));
    const horizontalMargin = " ".repeat(chatPanelMarginX);
    const laidOutChat = [
      ...chatPrefix.map((row) => pad(row, terminalWidth)),
      ...Array.from({ length: chatPanelTopMarginY }, () =>
        pad("", terminalWidth),
      ),
      ...chatRows.map((row) => `${horizontalMargin}${row}${horizontalMargin}`),
    ].map((row) =>
      visuals.color
        ? `\x1b[39m${pad(row, terminalWidth)}\x1b[0m`
        : pad(row, terminalWidth),
    );
    return laidOutChat.slice(0, terminalHeight).join("\n");
  }
  const panelContent = [
    ...header,
    // The leading marker pulses in place rather than adding a row. The banner
    // still states the hold in words on the same line, so the pulse is
    // attention and never the meaning.
    ...banner.map((row) =>
      ink(
        text(banner.length ? row.replace("[!]", approvalPulse(motion)) : row),
        `1;${amber}`,
      ),
    ),
    // renderToasts paints by tone already. Wrapping the row in ink() again
    // would repaint the whole line in one muted colour and throw the tone
    // away, which is the only signal separating a danger from a success.
    ...shownToastRows,
    ...renderedBodyRows,
    // The timeline follows the run this process started and stays with its
    // transcript, ahead of the controls and bottom status dock.
    ...shownTimelineRows,
    // The rule marks where the body ends and the controls begin, so the
    // operator does not have to read the composer frame to know it is about
    // to type into it.
    ...scrollCueRuleRows.map((row) => ink(row, muted)),
    ...menuRows,
    ...(argumentHint
      ? [
          ink(
            fit(`  ${ROW_ICONS.unknown} expects: ${argumentHint}`, width),
            muted,
          ),
        ]
      : []),
    // The legend sits above the composer, never after it. A legend placed
    // below would be the last thing the slice(0, height) drops on a short
    // terminal, and the operator would lose the prompt frame's bottom rule.
    ...paintedLegendRows,
    // Panels use the whole framed surface. Their filter/search state is
    // keyboard-driven, so the persistent Chat composer stays on Chat only.
    ...summaryRows.map((row) =>
      ink(fit(row, width), spaciousShell ? mutedAnsi : ice),
    ),
    ink(text(status), ui.confirmation ? `1;${amber}` : running ? amber : muted),
  ];
  const panelFrameSide = paintWithPalette("│", "muted", palette, caps);
  const panelFrameTitle = fitWithTrustedIcons(
    ` ${panelTitle} `,
    width,
    trustedIcons,
  );
  const topRemainder = "─".repeat(
    Math.max(0, width - visibleLength(panelFrameTitle)),
  );
  const panelInterior = panelContent.slice(0, height);
  while (panelInterior.length < height) panelInterior.push("");
  const framedPanel = [
    `╭${paintWithPalette(panelFrameTitle, "accent", palette, caps)}${paintWithPalette(topRemainder, "muted", palette, caps)}╮`,
    ...panelInterior.map(
      (row) => `${panelFrameSide}${pad(row, width)}${panelFrameSide}`,
    ),
    `╰${paintWithPalette("─".repeat(width), "muted", palette, caps)}╯`,
  ];
  return framedPanel
    .slice(0, terminalHeight)
    .map((row) => (visuals.color ? `\x1b[39m${row}\x1b[0m` : row))
    .join("\n");
}
/**
 * Every shortcut as data rather than as one packed sentence per line.
 *
 * The packed form read fine on paper and badly on screen: a line held three
 * unrelated bindings separated by pipes, so a reader scanning for one key had
 * to parse the whole line before knowing whether it was there. As rows it
 * can be rendered as a table, filtered by typing, and scrolled.
 */
const KEYBINDING_ROWS            
                        
                          
                         
    = [
  { group: "send", keys: "Enter in Chat composer", action: "Send the prompt" },
  {
    group: "navigate",
    keys: "Enter / Return on non-Chat lists and trees",
    action:
      "Open/inspect the selected row, open a Sessions conversation, or toggle a tree group/folder",
  },
  {
    group: "send",
    keys: "Shift+Enter / Alt+Enter / Ctrl+J",
    action: "Insert a newline",
  },
  {
    group: "input",
    keys: "Ctrl+O",
    action:
      "Cycle compact, details and expanded agent activity; never resizes the composer",
  },
  {
    group: "input",
    keys: "Left / Right while editing",
    action: "Move the input cursor",
  },
  {
    group: "input",
    keys: "Up / Down while editing",
    action: "History, command suggestions, or multiline cursor",
  },
  {
    group: "input",
    keys: "Up / Down in single-line Chat input",
    action: "Browse prompt history",
  },
  {
    group: "navigate",
    keys: "Ctrl+P / Ctrl+N outside the composer",
    action: "Move the selected row up or down",
  },
  {
    group: "input",
    keys: "Ctrl+N in Chat input",
    action: "Newer prompt in single-line history; move down in multiline text",
  },
  {
    group: "input",
    keys: "Ctrl+A / Ctrl+E",
    action: "Start or end of the line",
  },
  {
    group: "input",
    keys: "Alt+B/F/Left/Right or Ctrl+Left/Right",
    action: "Jump by word",
  },
  {
    group: "input",
    keys: "Ctrl+] / Ctrl+Alt+] then a character",
    action: "Jump to the next or previous matching character",
  },
  {
    group: "input",
    keys: "Alt+D / Alt+Delete",
    action: "Delete the next word",
  },
  {
    group: "input",
    keys: "Alt+Backspace / Ctrl+Backspace / Ctrl+W",
    action: "Delete the previous word",
  },
  { group: "input", keys: "Ctrl+K", action: "Delete to end of prompt" },
  { group: "input", keys: "Ctrl+U", action: "Delete to start of prompt" },
  {
    group: "input",
    keys: "Ctrl+Y / Alt+Y",
    action: "Paste or cycle killed text",
  },
  {
    group: "input",
    keys: "Alt+Up / Shift+Up when a prompt is queued",
    action: "Restore the queued prompt to Chat and keep the current draft",
  },
  {
    group: "input",
    keys: "Ctrl+Q / Ctrl+Enter while a run is active",
    action: "Queue the Chat draft behind the active turn",
  },
  {
    group: "input",
    keys: "Alt+Shift+C while editing",
    action: "Copy the current Chat prompt to the system clipboard",
  },
  {
    group: "input",
    keys: "Ctrl+_ / Ctrl+Shift+Z",
    action: "Undo / redo the last edit",
  },
  { group: "input", keys: "Ctrl+D", action: "Delete forward, twice exit" },
  {
    group: "input",
    keys: "Tab with command/@ suggestions",
    action: "Complete a command or @ mention",
  },
  { group: "navigate", keys: "Tab from a panel", action: "Return to Chat" },
  {
    group: "navigate",
    keys: "Mouse click / double-click / wheel",
    action:
      "Select or open rows; wheel scrolls Chat/details or moves lists; Shift+drag selects and copies text",
  },
  {
    group: "navigate",
    keys: "Left / Right in a tree",
    action: "Page the tree selection; Enter expands or collapses groups",
  },
  {
    group: "navigate",
    keys: "Up / Down in list/tree views",
    action:
      "Select and wrap through flat rows or move the tree cursor; scroll open details/previews",
  },
  { group: "navigate", keys: "{ and }", action: "Jump between your prompts" },
  {
    group: "navigate",
    keys: "PgUp / PgDn",
    action:
      "Scroll a focused detail or Chat; page a list/tree selection otherwise",
  },
  {
    group: "navigate",
    keys: "Esc",
    action:
      "Cancel/close overlays; clear queries/filters; exit input/detail; stop run",
  },
  {
    group: "navigate",
    keys: "Esc Esc",
    action: "Clear the input, or list checkpoints when empty",
  },
  {
    group: "navigate",
    keys: "Shift+Tab",
    action: "Cycle mode: normal, accept, plan",
  },
  {
    group: "review",
    keys: "y / n / Esc",
    action: "Accept, reject or cancel a review",
  },
  {
    group: "review",
    keys: "Enter on Approvals",
    action:
      "Enter inspects; Esc closes. On a base view, a/d opens the oldest pending review; y/n decides",
  },
  { group: "review", keys: "1 to 9", action: "Toggle a hunk in the diff" },
  {
    group: "session",
    keys: "Ctrl+R while editing",
    action: "Search this conversation or cycle matching prompts",
  },
  {
    group: "session",
    keys: "Ctrl+T outside editing",
    action: "Show the checklist from the current conversation's output",
  },
  {
    group: "session",
    keys: "F5 / Alt+R after a failed turn",
    action: "Retry the prompt in a new branch after confirmation",
  },
  {
    group: "session",
    keys: "Ctrl+Shift+O",
    action: "Hide or show tool activity; saved for the next session",
  },
  {
    group: "session",
    keys: "Alt+L",
    action: "Redraw the current terminal view",
  },
  ...(process.platform === "win32"
    ? []
    : [
        {
          group: "session",
          keys: "Ctrl+Z (POSIX)",
          action: "Suspend NOMO to the shell; resume with fg",
        },
      ]),
  { group: "session", keys: "Ctrl+S", action: "Stash, press again to restore" },
  {
    group: "session",
    keys: "Ctrl+G or Ctrl+X Ctrl+E",
    action: "Open the editor",
  },
  {
    group: "session",
    keys: "Alt+M",
    action: "Open provider/model picker; selection sets future default",
  },
  {
    group: "session",
    keys: "Alt+P",
    action: "Choose a model for the current conversation; provider stays fixed",
  },
  {
    group: "session",
    keys: "Alt+A",
    action: "Open the read-only Agents panel",
  },
  {
    group: "session",
    keys: "Alt+Shift+P in Chat",
    action:
      "Toggle local plan mode; restore the previous local mode when turned off",
  },
  {
    group: "session",
    keys: "Left / Right / Tab / Shift+Tab in Models picker",
    action:
      "Switch focus between configured providers and the selected provider's model catalog",
  },
  {
    group: "session",
    keys: "Ctrl+Left / Ctrl+Right in Models search",
    action: "Move the search caret without changing provider/model focus",
  },
  {
    group: "session",
    keys: "Mouse hover / click / double-click / wheel",
    action:
      "Highlight, select or open rows; wheel scrolls Chat/details; Shift+drag selects and copies text",
  },
  {
    group: "session",
    keys: "Ctrl+L",
    action: "Redraw, twice clear the screen",
  },
  {
    group: "session",
    keys: "Ctrl+C",
    action: "Clear, then cancel, then exit",
  },
];

const KEYBINDING_GROUP_ICON                         = {
  send: ">",
  input: "|",
  navigate: "±",
  review: "◆",
  session: "≡",
};

const KEYBINDING_GROUP_TITLE                         = {
  send: "SENDING",
  input: "EDITING",
  navigate: "NAVIGATION",
  review: "REVIEW",
  session: "SESSION",
};

/**
 * The /keybindings view as a grouped table.
 *
 * Grouping is the whole point: a reader looking for how to undo an input
 * should land on one short block, not on a screen where that binding shares a
 * line with two unrelated ones.
 */
function keybindingLines(query        , width        )           {
  const needle = query.trim().toLowerCase();
  const matching = KEYBINDING_ROWS.filter(
    (row) =>
      !needle ||
      row.keys.toLowerCase().includes(needle) ||
      row.action.toLowerCase().includes(needle) ||
      row.group.includes(needle),
  );
  const lines = [
    fit(
      "KEYBINDINGS, same action as the reference terminal where NOMO has it",
      width,
    ),
    "",
    fit(`${matching.length} of ${KEYBINDING_ROWS.length} bindings`, width),
    "",
  ];
  if (!matching.length) {
    lines.push(fit(`No binding matches "${query.trim()}".`, width));
    lines.push("");
    lines.push(
      fit("Backspace deletes a character, Esc clears the search.", width),
    );
    return lines;
  }
  // The key column is sized to its content rather than to a guess: a binding
  // like "Alt+B / Alt+F or Ctrl+Left / Ctrl+Right" is long enough that a
  // fixed column would push every action to the right edge. The cap stops a
  // narrow terminal from leaving no room at all for the action column.
  const indent = 2;
  const keyWidth = Math.min(
    Math.max(...matching.map((row) => visibleLength(row.keys))),
    Math.max(6, Math.floor(width / 2) - indent),
  );
  for (const group of ["send", "input", "navigate", "review", "session"]) {
    const rows = matching.filter((row) => row.group === group);
    if (!rows.length) continue;
    lines.push(
      fit(
        `${indent}${KEYBINDING_GROUP_ICON[group] ?? "-"} ${KEYBINDING_GROUP_TITLE[group] ?? group}`,
        width,
      ),
    );
    // The action is dropped before the key is truncated. A key with no
    // description is useless, while a truncated key is still recognisable.
    const room = Math.max(0, width - indent - keyWidth - 2);
    for (const row of rows)
      lines.push(
        `${indent}${fit(row.keys, keyWidth)}  ${fit(row.action, room)}`,
      );
    lines.push("");
  }
  lines.push(
    fit(
      "No NOMO equivalent: background tasks, clipboard paste/image attachment, Vim editing.",
      width,
    ),
  );
  lines.push(
    fit("Type to filter these bindings. Esc clears the search.", width),
  );
  return lines;
}
/**
 * The help view as sections rather than as a wall of prose.
 *
 * It used to end with twenty lines listing every command by hand, which was
 * a copy of the palette that already lists them all and a third place for a
 * new command to be forgotten. The list now lives in exactly one place and
 * this view says where it is.
 */
/**
 * The command set grouped by the task it serves, plus what is not here.
 *
 * The palette searches by name, so it answers "what is the command for X" for
 * someone who already knows what X is called. This answers the earlier
 * question: an operator who has just opened the product and knows five
 * commands has no idea which of the sixty seven to reach for, and a flat list
 * gives them no way to find out.
 */
function discoverLines(width = 72)           {
  const entries                 = TUI_COMMANDS.map(([id, summary]) => ({
    id,
    summary,
    group: discoveryGroupFor(id),
  }));
  const rows = discoveryRows(entries, { width });
  return [...rows, "", ...absentCapabilities().map((line) => `  ${line}`)];
}
/**
 * Which task a command belongs to.
 *
 * Derived from the command name rather than declared per entry, because the
 * table below and the command list would then be two lists that could drift.
 * A command with no entry falls through as unrecognised, which the panel shows
 * last instead of guessing a group for it.
 */
function discoveryGroupFor(id        )         {
  const name = id.slice(1).split(" ")[0] ?? "";
  if (COMMAND_GROUPS[name]) return COMMAND_GROUPS[name] ;
  return (
    DISCOVERY_GROUPS.find((group) =>
      DISCOVERY_MEMBERS[group]?.some((member) => name.startsWith(member)),
    ) ?? ""
  );
}
/**
 * Commands grouped by the situation a person arrives in, not the order they
 * happen to be declared in. The order is the one a first time operator thinks
 * in: start something, read what is there, change it, run it, watch it, share
 * it, configure it.
 */
const DISCOVERY_MEMBERS                                    = {
  starting: ["new", "resume", "sessions", "chat", "init", "bottom", "clear"],
  reading: [
    "documents",
    "context",
    "ledger",
    "history",
    "runs",
    "find",
    "todos",
    "memory",
    "stats",
    "cost",
    "usage",
    "keybindings",
    "help",
    "diff",
  ],
  writing: [
    "edit",
    "document",
    "undo",
    "approval",
    "approve",
    "deny",
    "compact",
    "refine",
    "rewrite",
    "expand",
    "export",
  ],
  running: [
    "queue",
    "cancel",
    "stop",
    "retry",
    "branch",
    "rewind",
    "recovery",
    "verify",
    "attest",
    "conformance",
  ],
  watching: [
    "status",
    "health",
    "policy",
    "permissions",
    "mcp",
    "doctor",
    "tools",
    "models",
    "agents",
    "config",
    "settings",
    "themes",
  ],
  sharing: [
    "projects",
    "project",
    "project-file",
    "agent-file",
    "hook",
    "hook-file",
    "hooks",
    "connector-file",
    "test-connector",
    "policy-file",
  ],
  configuring: [
    "model",
    "connect",
    "login",
    "logout",
    "providers",
    "harness",
    "theme",
    "vim",
    "terminal-setup",
    "output-style",
    "init",
    "agent",
  ],
};
/** Which group each command belongs to, for the handful that do not match. */
const COMMAND_GROUPS                         = {
  chat: "starting",
  plan: "writing",
  open: "reading",
  rename: "sharing",
  sources: "reading",
  harness: "configuring",
  agent: "configuring",
  command: "starting",
};
function helpLines(width        )           {
  const commands = TUI_COMMANDS.length;
  return renderInspector(
    {
      title: "NOMO",
      subtitle: "real local data, no demo metrics",
      icon: ROW_ICONS.harness,
      sections: [
        {
          title: "working",
          fields: [
            {
              label: "chat",
              value:
                "Type to send; Enter sends; Shift+Enter adds a line. PgUp/PgDn scroll; Up/Down browse one-line history.",
            },
            {
              label: "selection",
              value:
                "Escape returns to Chat; Enter opens or inspects the selected row; y/n decides after review.",
            },
            {
              label: "paste",
              value:
                "Paste focuses the composer. Control characters are removed.",
            },
            {
              label: "commands",
              value: "/ opens them, arrows select, Tab completes",
            },
            {
              label: "subagents",
              value: "/subagent cancel|review for verified spawned children",
            },
            {
              label: "palette",
              value: `/ opens command suggestions; /command-palette opens a searchable list of ${commands} commands`,
            },
            {
              label: "shortcuts",
              value: "/keybindings, searchable by key or by action",
            },
            {
              label: "panels",
              value:
                "Escape returns to Chat; Up/Down selects; Enter opens rows or toggles groups; Left/Right pages a tree.",
            },
            {
              label: "mode",
              value: "Shift+Tab: normal, accept, plan",
            },
            {
              label: "scroll",
              value: "PgUp/PgDn, or /bottom to follow the latest",
            },
            {
              label: "stop",
              value:
                "Esc closes a picker, review or detail, clears a filter, or stops the selected run",
              tone: "warning",
            },
          ],
        },
        {
          title: "modes that change what a key does",
          fields: [
            {
              label: "normal",
              value: "Every action asks before it changes anything",
            },
            {
              label: "accept",
              value: "Edit keys are shortened. Tool approvals stay explicit.",
            },
            {
              label: "plan",
              value: "Prompts are prefixed so the model plans before acting",
            },
          ],
        },
        {
          title: "things that are not here",
          fields: [
            {
              label: "no equivalent",
              value:
                "background tasks, clipboard paste/image attachment, live voice, speech input, Vim editing, /hooks, /vim",
              tone: "muted",
            },
          ],
        },
        {
          title: "guarantees",
          fields: [],
          body: [
            "Revision conflicts never overwrite changes.",
            "Undo and approvals require an explicit confirmation.",
            "Branches copy text and documents; tools are never replayed.",
            "The free model is never silently replaced with a paid one.",
            "Exports use 0600 and never overwrite an existing file.",
            "Data is encrypted in NOMO_DATA_DIR, default ~/.nomo/workbench.",
            "The local TUI never reads private cloud conversations.",
          ],
        },
        {
          title: "environment",
          fields: [
            {
              label: "color",
              value:
                "NO_COLOR disables colour; NOMO_TUI_COLOR=0 keeps output monochrome",
            },
            {
              label: "motion",
              value: "NOMO_TUI_MOTION=0 freezes animation",
            },
            {
              label: "editor",
              value: 'NOMO_TUI_EDITOR is a JSON array, e.g. ["code","--wait"]',
            },
            {
              label: "fallback",
              value:
                "Otherwise EDITOR, default nano. Confirm edits in the TUI.",
            },
          ],
        },
      ],
      hint: "Type / for commands; press ? with an empty Chat composer to open this view.",
    },
    { width },
  );
}


//# sourceURL=packages/cli/src/tui/workspace.ts

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const MOUSE_START = "\x1b[<";
const CELL_PIXEL_REPLY_START = "\x1b[6;";
const MOUSE_MOTION_ON = "\x1b[?1003h";
const MOUSE_MOTION_OFF = "\x1b[?1003l";
const ALT_SCREEN_ON = "\x1b[?1049h";
const ALT_SCREEN_OFF = "\x1b[?1049l";
const BRACKETED_PASTE_ON = "\x1b[?2004h";
const BRACKETED_PASTE_OFF = "\x1b[?2004l";

                                            
                 
            
            
                   
                  
   

function createWorkspaceTerminal(
  input                   ,
  output                    ,
) {
  const keyInput = new PassThrough();
  const decoder = new StringDecoder("utf8");
  const initialRaw = input.isRaw ?? false;
  let buffer = "";
  let paste = "";
  let specialTimer                                           ;
  let inPaste = false;
  let started = false;
  let suspended = false;
  let displayDeferred = false;
  let stopped = false;
  let outputBlocked = false;
  let pendingFrame                    ;
  let previousFrame                    ;
  let previousFrameLines                      ;
  let previousColumns                    ;
  let previousRows                    ;
  let onKey                                                             ;
  let onPaste                                       ;
  let onMouse                                                    ;
  let onDrain                          ;
  let pendingCellPixelQuery 
       
                                                                                
                                                                        
                                             
       
               ;
  const finishCellPixelQuery = (
    value                                               ,
  ) => {
    const pending = pendingCellPixelQuery;
    if (!pending) return;
    pendingCellPixelQuery = undefined;
    clearTimeout(pending.timer);
    pending.resolve(value);
  };

  const writeModes = (enabled         ) => {
    const mouse =
      input.isTTY && output.isTTY
        ? enabled
          ? `\x1b[?1000h${MOUSE_MOTION_ON}\x1b[?1006h`
          : `\x1b[?1006l${MOUSE_MOTION_OFF}\x1b[?1000l`
        : "";
    output.write(
      enabled
        ? `${ALT_SCREEN_ON}${BRACKETED_PASTE_ON}${mouse}\x1b[H\x1b[2J\x1b[?25l`
        : `${BRACKETED_PASTE_OFF}${mouse}${ALT_SCREEN_OFF}\x1b[?25h`,
    );
    previousFrame = undefined;
    previousFrameLines = undefined;
    previousColumns = undefined;
    previousRows = undefined;
  };
  const trailingPrefixLength = (value        , marker        ) => {
    for (
      let length = Math.min(value.length, marker.length - 1);
      length > 0;
      length--
    )
      if (value.endsWith(marker.slice(0, length))) return length;
    return 0;
  };
  const deferPartialSequence = (delayMs = 40) => {
    if (specialTimer !== undefined) clearTimeout(specialTimer);
    specialTimer = setTimeout(() => {
      specialTimer = undefined;
      const pending = buffer;
      buffer = "";
      if (pending) keyInput.write(pending);
    }, delayMs);
  };
  const feed = (text        ) => {
    if (!text) return;
    if (specialTimer !== undefined) {
      clearTimeout(specialTimer);
      specialTimer = undefined;
    }
    buffer += text;
    while (buffer) {
      if (inPaste) {
        const end = buffer.indexOf(PASTE_END);
        if (end >= 0) {
          paste += buffer.slice(0, end);
          onPaste?.(paste);
          paste = "";
          buffer = buffer.slice(end + PASTE_END.length);
          inPaste = false;
          continue;
        }
        const safe = buffer.length - trailingPrefixLength(buffer, PASTE_END);
        paste += buffer.slice(0, safe);
        buffer = buffer.slice(safe);
        return;
      }
      const pasteStart = buffer.indexOf(PASTE_START);
      const mouseStart = buffer.indexOf(MOUSE_START);
      const cellPixelStart = buffer.indexOf(CELL_PIXEL_REPLY_START);
      const specialStart =
        pasteStart < 0
          ? mouseStart < 0
            ? cellPixelStart
            : cellPixelStart < 0
              ? mouseStart
              : Math.min(mouseStart, cellPixelStart)
          : mouseStart < 0
            ? cellPixelStart < 0
              ? pasteStart
              : Math.min(pasteStart, cellPixelStart)
            : cellPixelStart < 0
              ? Math.min(pasteStart, mouseStart)
              : Math.min(pasteStart, mouseStart, cellPixelStart);
      if (specialStart < 0) {
        const trailing = Math.max(
          trailingPrefixLength(buffer, PASTE_START),
          trailingPrefixLength(buffer, MOUSE_START),
          trailingPrefixLength(buffer, CELL_PIXEL_REPLY_START),
        );
        const safe = buffer.length - trailing;
        if (safe) keyInput.write(buffer.slice(0, safe));
        buffer = buffer.slice(safe);
        if (buffer) deferPartialSequence(pendingCellPixelQuery ? 100 : 40);
        return;
      }
      if (specialStart > 0) {
        keyInput.write(buffer.slice(0, specialStart));
        buffer = buffer.slice(specialStart);
        continue;
      }
      if (pasteStart === 0) {
        buffer = buffer.slice(PASTE_START.length);
        inPaste = true;
        continue;
      }
      if (cellPixelStart === 0) {
        const reply = /^\x1b\[6;(\d+);(\d+)t/.exec(buffer);
        if (reply) {
          const height = Number(reply[1]);
          const width = Number(reply[2]);
          finishCellPixelQuery(
            Number.isSafeInteger(height) &&
              Number.isSafeInteger(width) &&
              height > 0 &&
              width > 0
              ? { height, width }
              : undefined,
          );
          buffer = buffer.slice(reply[0].length);
          continue;
        }
        if (/^\x1b\[6;\d*(?:;\d*)?$/.test(buffer)) {
          deferPartialSequence(100);
          return;
        }
      }
      const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([mM])/.exec(buffer);
      if (mouse) {
        const button = Number(mouse[1]);
        onMouse?.({
          button,
          x: Number(mouse[2]),
          y: Number(mouse[3]),
          pressed: mouse[4] === "M",
          motion: (button & 32) !== 0,
        });
        buffer = buffer.slice(mouse[0].length);
        continue;
      }
      if (/^\x1b\[<\d*(?:;\d*){0,2}$/.test(buffer)) {
        deferPartialSequence();
        return;
      }
      keyInput.write(buffer[0] );
      buffer = buffer.slice(1);
    }
  };
  const onData = (chunk                 ) => feed(decoder.write(chunk));
  let onResize                          ;
  const handleResize = () => onResize?.();
  const flushPendingFrame = () => {
    if (stopped || suspended || outputBlocked || pendingFrame === undefined)
      return;
    const latest = pendingFrame;
    pendingFrame = undefined;
    renderFrame(latest);
  };
  const handleDrain = () => {
    outputBlocked = false;
    onDrain = undefined;
    flushPendingFrame();
  };
  function renderFrame(frame        ) {
    if (stopped || suspended) return;
    const columns = output.columns ?? 80;
    const rows = output.rows ?? 24;
    if (
      previousFrameLines &&
      (previousColumns !== columns || previousRows !== rows)
    ) {
      // Treat a size change as a full cache miss. Erasing the whole screen
      // first creates a visible blank frame before the redraw. The next frame
      // rewrites every visible row; rows exposed by a later expansion are
      // rewritten on that resize too.
      previousFrame = undefined;
      previousFrameLines = undefined;
    }
    if (frame === previousFrame) return;
    const nextLines = frame.split("\n");
    const previousLines = previousFrameLines ?? [];
    const updates           = [];
    const rowCount = Math.max(previousLines.length, nextLines.length);
    for (let row = 0; row < rowCount; row++) {
      const nextLine = nextLines[row] ?? "";
      if (nextLine === previousLines[row]) continue;
      updates.push(`\x1b[${row + 1};1H${nextLine}\x1b[K`);
    }
    previousFrameLines = nextLines;
    previousFrame = frame;
    previousColumns = columns;
    previousRows = rows;
    if (updates.length && !output.write(updates.join(""))) {
      outputBlocked = true;
      onDrain = handleDrain;
      output.once("drain", handleDrain);
    }
  }
  emitKeypressEvents(keyInput);
  keyInput.on("keypress", (value        , key     ) =>
    onKey?.(value || undefined, key),
  );
  output.on("resize", handleResize);

  const acquire = () => {
    if (stopped || !started || !suspended) return;
    input.setRawMode?.(true);
    input.resume();
    writeModes(true);
    displayDeferred = false;
    suspended = false;
    flushPendingFrame();
  };
  const release = () => {
    if (!started || suspended) return;
    input.pause();
    input.setRawMode?.(initialRaw);
    writeModes(false);
    suspended = true;
  };

  return {
    start(
      keyHandler                                               ,
      pasteHandler                         ,
      resizeHandler             ,
      mouseHandler                                       ,
      options                                      ,
    ) {
      if (started || stopped) return;
      started = true;
      onKey = keyHandler;
      onPaste = pasteHandler;
      onMouse = mouseHandler;
      onResize = resizeHandler;
      input.on("data", onData);
      input.setRawMode?.(true);
      input.resume();
      displayDeferred = options?.deferDisplay === true;
      suspended = displayDeferred;
      if (!displayDeferred) writeModes(true);
    },
    activate() {
      if (stopped || !started || !displayDeferred) return;
      writeModes(true);
      displayDeferred = false;
      suspended = false;
      flushPendingFrame();
    },
    render(frame        ) {
      if (stopped || suspended) return;
      if (outputBlocked) {
        pendingFrame = frame;
        return;
      }
      renderFrame(frame);
    },
    writeGraphics(sequence        ) {
      if (!started || stopped || suspended || !output.isTTY || !sequence)
        return false;
      return output.write(sequence);
    },
    measureCellPixels(timeoutMs = 160) {
      if (
        !started ||
        stopped ||
        (suspended && !displayDeferred) ||
        !input.isTTY ||
        !output.isTTY
      )
        return Promise.resolve(undefined);
      if (pendingCellPixelQuery) return pendingCellPixelQuery.promise;
      let resolveQuery    
                                                             
               ;
      const promise = new Promise 
                                                     
       ((resolve) => {
        resolveQuery = resolve;
      });
      const timer = setTimeout(
        () => finishCellPixelQuery(undefined),
        timeoutMs,
      );
      pendingCellPixelQuery = { promise, resolve: resolveQuery, timer };
      output.write("\x1b[16t");
      return promise;
    },
    invalidateDisplay() {
      previousFrame = undefined;
      previousFrameLines = undefined;
      previousColumns = undefined;
      previousRows = undefined;
    },
    suspend: release,
    resume: acquire,
    destroy() {
      if (stopped) return;
      if (specialTimer !== undefined) clearTimeout(specialTimer);
      finishCellPixelQuery(undefined);
      if (!suspended) writeModes(false);
      input.pause();
      input.setRawMode?.(initialRaw);
      suspended = true;
      input.off("data", onData);
      output.off("resize", handleResize);
      if (onDrain) output.off("drain", onDrain);
      onDrain = undefined;
      pendingFrame = undefined;
      outputBlocked = false;
      keyInput.removeAllListeners();
      keyInput.end();
      stopped = true;
      onKey = undefined;
      onPaste = undefined;
      onMouse = undefined;
      onResize = undefined;
    },
    get columns() {
      return output.columns ?? 80;
    },
    get rows() {
      return output.rows ?? 24;
    },
  };
}


//# sourceURL=packages/cli/src/tui/workspace-terminal.ts

const COMMANDS           
                                                          
  = {
  darwin: [["pbcopy", ["-Prefer", "txt"]]],
  win32: [["clip.exe", []]],
  linux: [
    ["wl-copy", []],
    ["xclip", ["-selection", "clipboard"]],
    ["xsel", ["--clipboard", "--input"]],
  ],
};
function tryCopy(
  command        ,
  args          ,
  value        ,
)                   {
  return new Promise         ((resolve) => {
    const child = spawn(command, args, {
      env:
        process.platform === "darwin"
          ? { ...process.env, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" }
          : process.env,
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
    });
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      finish(false);
    }, 2000);
    const finish = (copied         ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(copied);
    };
    child.once("error", () => {
      child.kill();
      finish(false);
    });
    child.once("close", (code) => finish(code === 0));
    child.stdin?.once("error", () => {
      child.kill();
      finish(false);
    });
    child.stdin?.end(value, "utf8");
  });
}

/** Copy text through the OS clipboard command without invoking a shell. */
async function writeTextToClipboard(value        )                {
  if (value.length === 0) throw Error("There is no prompt to copy.");
  for (const [command, args] of COMMANDS[process.platform] ?? []) {
    if (await tryCopy(command, [...args], value)) return;
  }
  throw Error("Clipboard is unavailable. Use your terminal's copy controls.");
}

let clipboardWriteQueue                = Promise.resolve();

/** Serialize prompt and mouse-selection writes so the newest gesture wins. */
function copyTextToClipboard(value        )                {
  const write = clipboardWriteQueue.then(() => writeTextToClipboard(value));
  clipboardWriteQueue = write.catch(() => undefined);
  return write;
}


//# sourceURL=packages/cli/src/tui/clipboard.ts

function ordered(anchor            , focus            ) {
  return anchor.y < focus.y || (anchor.y === focus.y && anchor.x <= focus.x)
    ? { start: anchor, end: focus }
    : { start: focus, end: anchor };
}

function rowRange(
  row        ,
  start            ,
  end            ,
  width        ,
)                                        {
  if (row < start.y || row > end.y) return undefined;
  return [row === start.y ? start.x : 0, row === end.y ? end.x : width - 1];
}

function paintSelectedRow(line        , from        , to        )         {
  const parts = line.split(/(\x1b\[[0-9;]*m)/g);
  let column = 0;
  return parts
    .map((part) => {
      if (part.startsWith("\x1b[")) return part;
      let painted = "";
      const points = [...part];
      for (let index = 0; index < points.length; index += 1) {
        let cluster = points[index] ;
        const cells = visibleLength(cluster);
        while (
          index + 1 < points.length &&
          visibleLength(points[index + 1] ) === 0
        )
          cluster += points[++index] ;
        const selected =
          cells === 0
            ? column > 0 && column - 1 >= from && column - 1 <= to
            : column <= to && column + cells - 1 >= from;
        painted += selected ? `\x1b[7m${cluster}\x1b[27m` : cluster;
        column += cells;
      }
      return painted;
    })
    .join("");
}

/** Apply a visible reverse-video selection to an ANSI-rendered terminal frame. */
function highlightMouseSelection(
  frame        ,
  anchor            ,
  focus            ,
  columns        ,
)         {
  const { start, end } = ordered(anchor, focus);
  return frame
    .split("\n")
    .map((line, y) => {
      const range = rowRange(y, start, end, columns);
      return range ? paintSelectedRow(line, range[0], range[1]) : line;
    })
    .join("\n");
}

/** Extract selected visible cells and drop renderer colors. */
function selectedMouseText(
  frame        ,
  anchor            ,
  focus            ,
  columns        ,
)         {
  const { start, end } = ordered(anchor, focus);
  const lines = frame.split("\n");
  const selected           = [];
  for (let y = start.y; y <= end.y && y < lines.length; y += 1) {
    const range = rowRange(y, start, end, columns);
    if (!range) continue;
    let column = 0;
    let text = "";
    for (const point of stripAnsi(lines[y] )) {
      const cells = visibleLength(point);
      const selected =
        cells === 0
          ? column > 0 && column - 1 >= range[0] && column - 1 <= range[1]
          : column <= range[1] && column + cells - 1 >= range[0];
      if (selected) text += point;
      column += cells;
    }
    selected.push(text);
  }
  return selected.join("\n");
}


//# sourceURL=packages/cli/src/tui/mouse-selection.ts

function modelPickerPageSize(ui              , direction        )         {
  const picker = ui.modelPicker;
  if (!picker) return 1;
  const width = Math.max(1, (ui.viewport.width ?? 80) - 4);
  const height = Math.max(1, ui.viewport.height);
  const lines = ui.lines(width, height);
  const matches = modelPickerMatches(picker.models, picker.query);
  if (!matches.length) return 1;
  // The stacked picker has three summary rows; the wide two-pane picker has
  // only two before its model list. Page sizing must follow the active layout
  // or PageUp/PageDown counts a provider row as part of the model catalog.
  const modelStart = width < 88 ? 3 : 2;
  const modelEnd = modelStart + matches.length;
  const reservedRows =
    wrap(lines.slice(0, modelStart), width).length +
    wrap(lines.slice(modelEnd), width).length;
  const visibleRows = Math.max(1, height - reservedRows);
  let index = direction < 0 ? picker.selected - 1 : picker.selected;
  let usedRows = 0;
  let count = 0;
  while (index >= 0 && index < matches.length) {
    const row = lines[modelStart + index] ?? "";
    const rowHeight = Math.max(1, wrap([row], width).length);
    if (count > 0 && usedRows + rowHeight > visibleRows) break;
    if (count === 0 && rowHeight > visibleRows) return 1;
    usedRows += rowHeight;
    count += 1;
    index += direction;
  }
  return Math.max(1, count);
}

function modelPickerVisibleRows(ui              )         {
  const columns = Math.max(1, (ui.viewport.width ?? 80) - 4);
  return Math.max(1, ui.viewport.height - (columns >= 88 ? 2 : 5));
}

function oneShotDimension(name                     , fallback        )         {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0
    ? Math.min(value, 1000)
    : fallback;
}

function setModelPickerQuery(
  ui              ,
  picker                                          ,
  query        ,
  cursor        ,
)       {
  ui.modelPicker = {
    ...picker,
    query,
    cursor: Math.max(0, Math.min([...query].length, cursor)),
    selected: 0,
    modelWindowStart: undefined,
  };
}
function handleModelPickerKey(
  ui              ,
  value                    ,
  key                                                             ,
)                                                              {
  const picker = ui.modelPicker;
  if (!picker?.open) return false;
  const matches = modelPickerMatches(picker.models, picker.query);
  if (
    key.name === "escape" &&
    picker.query &&
    picker.focusedPane === "models"
  ) {
    setModelPickerQuery(ui, picker, "", 0);
    return true;
  }
  if (key.name === "escape" || (key.ctrl && key.name === "c")) {
    ui.closeModelPicker();
    ui.notice = "Model selection cancelled.";
    return true;
  }
  if (
    picker.focusedPane === "models" &&
    picker.query !== "" &&
    key.ctrl &&
    (key.name === "left" || key.name === "right")
  ) {
    const length = [...picker.query].length;
    const cursor = Math.max(
      0,
      Math.min(length, picker.cursor + (key.name === "right" ? 1 : -1)),
    );
    ui.modelPicker = { ...picker, cursor };
    return true;
  }
  if (key.name === "left" || key.name === "right") {
    if (key.name === "left") {
      ui.modelPicker = { ...picker, focusedPane: "providers" };
      return true;
    }
    const provider = picker.providers[picker.providerIndex];
    if (!provider) return true;
    ui.modelPicker = { ...picker, focusedPane: "models" };
    return { loadProviderId: provider.id };
  }
  if (key.name === "return" || key.name === "enter") {
    if (picker.focusedPane === "providers") {
      const provider = picker.providers[picker.providerIndex];
      if (!provider) return true;
      ui.modelPicker = { ...picker, focusedPane: "models" };
      return { loadProviderId: provider.id };
    }
    return matches[picker.selected]?.id ?? true;
  }
  if (key.name === "up" || key.name === "down") {
    const delta = key.name === "down" ? 1 : -1;
    if (picker.focusedPane === "providers") {
      const providers = picker.providers;
      if (!providers.length) return true;
      const index =
        (picker.providerIndex + delta + providers.length) % providers.length;
      ui.selectModelPickerProvider(index);
      return true;
    }
    const selected = matches.length
      ? (picker.selected + delta + matches.length) % matches.length
      : Math.max(
          0,
          Math.min(Math.max(0, matches.length - 1), picker.selected + delta),
        );
    ui.modelPicker = {
      ...picker,
      selected,
      modelWindowStart: modelPickerSelectionWindowStart(
        picker.selected,
        selected,
        matches.length,
        modelPickerVisibleRows(ui),
        picker.modelWindowStart,
      ),
    };
    return true;
  }
  if (["home", "end", "pageup", "pagedown"].includes(key.name ?? "")) {
    if (picker.focusedPane === "providers") {
      const providers = picker.providers;
      if (providers.length) {
        const step = Math.max(1, Math.floor(ui.viewport.height / 2));
        const index =
          key.name === "home"
            ? 0
            : key.name === "end"
              ? providers.length - 1
              : Math.max(
                  0,
                  Math.min(
                    providers.length - 1,
                    picker.providerIndex +
                      (key.name === "pagedown" ? step : -step),
                  ),
                );
        ui.selectModelPickerProvider(index);
      }
      return true;
    }
    const last = Math.max(0, matches.length - 1);
    const direction = key.name === "pagedown" ? 1 : -1;
    const page = modelPickerPageSize(ui, direction);
    const selected =
      key.name === "home"
        ? 0
        : key.name === "end"
          ? last
          : Math.max(0, Math.min(last, picker.selected + direction * page));
    ui.modelPicker = {
      ...picker,
      selected,
      modelWindowStart: modelPickerSelectionWindowStart(
        picker.selected,
        selected,
        matches.length,
        modelPickerVisibleRows(ui),
        picker.modelWindowStart,
      ),
    };
    return true;
  }
  if (picker.focusedPane === "providers") return true;
  if (key.name === "home" || (key.ctrl && key.name === "a")) {
    ui.modelPicker = { ...picker, cursor: 0 };
    return true;
  }
  if (key.name === "end" || (key.ctrl && key.name === "e")) {
    ui.modelPicker = { ...picker, cursor: [...picker.query].length };
    return true;
  }
  if (key.ctrl && key.name === "u") {
    setModelPickerQuery(ui, picker, "", 0);
    return true;
  }
  if (key.name === "backspace") {
    const points = [...picker.query];
    if (picker.cursor > 0) {
      points.splice(picker.cursor - 1, 1);
      setModelPickerQuery(ui, picker, points.join(""), picker.cursor - 1);
    }
    return true;
  }
  if (key.name === "delete") {
    const points = [...picker.query];
    if (picker.cursor < points.length) {
      points.splice(picker.cursor, 1);
      setModelPickerQuery(ui, picker, points.join(""), picker.cursor);
    }
    return true;
  }
  if (value && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f-\x9f]/.test(value)) {
    const points = [...picker.query];
    const inserted = [...value];
    points.splice(picker.cursor, 0, ...inserted);
    const query = points.join("");
    setModelPickerQuery(ui, picker, query, picker.cursor + inserted.length);
  }
  return true;
}

function normalizePastedPrompt(text        )         {
  return stripAnsi(text)
    .replace(/\u009b[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u009d[^\u0007\u009c]*(?:\u0007|\u009c|$)/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

function signalQuitAction(
  now        ,
  lastCtrlC        ,
)                     {
  return isDoubleEscape(now, lastCtrlC) ? "stop" : "confirm";
}

function escapeOwnedByOverlay(
  state            
                          
                     
                         
                        
                   
                    
                     
                          
    ,
)          {
  return (
    state.confirmation ||
    state.palette ||
    state.keybindings ||
    state.cheatSheet ||
    state.panel === true ||
    state.detail === true ||
    state.suggestions === true ||
    state.filter.length > 0
  );
}

function shouldCancelActiveRun(
  key                            ,
  hasEscapeOwner         ,
  pasting         ,
)          {
  return (
    !pasting &&
    ((key.ctrl && key.name === "c") ||
      (!hasEscapeOwner && key.name === "escape"))
  );
}

function takeReadyQueuedPrompt(
  ui                                                   ,
  state            
                              
                             
                         
    ,
)                {
  if (state.workbenchRunning || state.hasConfirmation || state.runnerBusy)
    return null;
  return ui.takeQueued();
}

async function dispatchQueuedPrompt(
  ui                                               ,
  prompt        ,
  refresh                        ,
  onDispatchError                          ,
)                   {
  try {
    await ui.command(prompt);
  } catch (error) {
    ui.queuePrompt(prompt);
    onDispatchError(error);
    return false;
  }
  await refresh();
  return true;
}

                               
            
             
                  
                            
                    
           
                     
                 
                 
                 
                
           
           

function isSuspendKey(key     )          {
  return key.ctrl === true && !key.shift && !key.meta && key.name === "z";
}

function workspaceShortcut(
  key     ,
  editing         ,
  input        ,
  bindings                       = DEFAULT_WORKSPACE_KEYBINDINGS,
  tab               ,
)                                {
  const chatEditing = editing && (tab === undefined || tab === "chat");
  if (isSuspendKey(key)) return "suspend";
  if (key.ctrl && key.shift && !key.meta && key.name?.toLowerCase() === "o")
    return "toggle-tool-visibility";
  if (!key.ctrl && !key.shift && !key.meta && key.name === "f5") return "retry";
  if (!key.ctrl && !key.shift && key.meta && key.name === "r") return "retry";
  if (!key.ctrl && !key.shift && key.meta && key.name === "a")
    return "show-agents";
  if (
    chatEditing &&
    !key.ctrl &&
    key.shift &&
    key.meta &&
    key.name?.toLowerCase() === "p"
  )
    return "toggle-plan";
  if (
    chatEditing &&
    !key.ctrl &&
    key.shift &&
    key.meta &&
    key.name?.toLowerCase() === "c"
  )
    return "copy-prompt";
  if (!key.ctrl || key.shift || key.meta) return undefined;
  const action = (
    Object.keys(bindings)                                     
  ).find((candidate) => bindings[candidate].name === key.name);
  if (action === "redraw") return "redraw";
  if (action === "toggle-tools") return "toggle-tools";
  if (action === "search-history" && editing) return "search-history";
  if (action === "stash") return "stash";
  if (action === "external-editor") return "external-editor";
  if (action === "show-todos" && !editing) return "show-todos";
  if (key.name === "d" && (!editing || !input)) return "quit";
  return undefined;
}

/** Two key chords with a short window, for readline native bindings the
 * terminal sends as separate presses. Stays in memory only. */
class ChordTracker {
          pendingAt = 0;
  chord(key     , now = Date.now())                                {
    if (key.ctrl && key.name === "x") {
      this.pendingAt = now;
      return;
    }
    const open = this.pendingAt > 0 && now - this.pendingAt < 1500;
    this.pendingAt = 0;
    if (open && key.ctrl && key.name === "e") return "external-editor";
    return;
  }
}
/** The terminal keypress stream has no key-up event, so ignore rapid
 * autorepeat pairs and accept only a deliberate second Left press. */
class DoubleLeftSessionShortcut {
          lastPressAt                    ;

  press(
    key                                               ,
    eligible         ,
    now = Date.now(),
  )          {
    if (!eligible || key.name !== "left" || key.ctrl || key.meta || key.shift) {
      this.lastPressAt = undefined;
      return false;
    }
    const previous = this.lastPressAt;
    this.lastPressAt = now;
    if (previous === undefined) return false;
    const elapsed = now - previous;
    if (elapsed < 100) {
      this.lastPressAt = undefined;
      return false;
    }
    if (elapsed <= 450) {
      this.lastPressAt = undefined;
      return true;
    }
    return false;
  }
}

function isToolActivityCycleKey(
  key                                               ,
  running         ,
)          {
  return (
    running &&
    !!key.ctrl &&
    !key.shift &&
    !key.meta &&
    key.name?.toLowerCase() === "o"
  );
}

/** Jump between user prompts in the rendered chat rows. Rows are viewport
 * offsets, so the runner can set the scroll position directly. */
function nextPromptRow(
  rows                   ,
  offset        ,
  direction        ,
)         {
  if (direction === 1) return rows.find((row) => row > offset) ?? -1;
  return [...rows].reverse().find((row) => row < offset) ?? -1;
}

/** Bracketed paste never submits a message or an approval. */
class WorkspaceInput {
  editing = false;
  value = "";
  cursor = 0;
  pasting = false;
  pendingCommand         ;
          pendingCharacterJump                         ;
  // Recent kills and the latest yank are process-local editor state.
          killRing           = [];
          lastKillKind                         ;
          lastYank                                                       ;
  // Undo keeps one previous state for Ctrl+_.
          undoState                                    ;
          redoState                                    ;
  set(value        ) {
    // Drafts can outlive the terminal session that created them. Normalize
    // them at the same boundary as live input so an older raw ANSI escape
    // sequence cannot be rendered as visible `?[...m` text on the next launch.
    this.value = normalizePastedPrompt(value);
    this.cursor = [...this.value].length;
    this.pendingCharacterJump = undefined;
    this.lastKillKind = undefined;
    this.lastYank = undefined;
    this.undoState = undefined;
    this.redoState = undefined;
  }
          remember() {
    this.undoState = { value: this.value, cursor: this.cursor };
    this.redoState = undefined;
  }
  undoEdit()          {
    if (!this.undoState) return false;
    this.redoState = { value: this.value, cursor: this.cursor };
    this.value = this.undoState.value;
    this.cursor = Math.min(
      this.undoState.cursor,
      [...this.undoState.value].length,
    );
    this.undoState = undefined;
    return true;
  }
  redoEdit()          {
    if (!this.redoState) return false;
    this.undoState = { value: this.value, cursor: this.cursor };
    this.value = this.redoState.value;
    this.cursor = Math.min(
      this.redoState.cursor,
      [...this.redoState.value].length,
    );
    this.redoState = undefined;
    return true;
  }
  insert(value        ) {
    this.replaceRange(this.cursor, 0, value);
  }
  paste(value        ) {
    this.editing = true;
    this.insert(value);
  }
  replaceRange(start        , length        , value        ) {
    const normalized = normalizePastedPrompt(value);
    this.remember();
    const points = [...this.value];
    points.splice(start, length, ...normalized);
    points.length = Math.min(points.length, 32000);
    this.value = points.join("");
    this.cursor = Math.min(start + [...normalized].length, points.length);
    this.lastYank = undefined;
    this.lastKillKind = undefined;
  }
          static isWordChar(point        )          {
    return /[A-Za-z0-9]/.test(point);
  }
          static isPunctuationChar(point        )          {
    return /[!-/:-@[-`{-~]/.test(point);
  }
          killText(text        , direction                        ) {
    if (!text) return;
    const previous = this.killRing.at(-1);
    if (this.lastKillKind === direction && previous) {
      this.killRing[this.killRing.length - 1] =
        direction === "backward" ? text + previous : previous + text;
    } else {
      this.killRing.push(text);
      if (this.killRing.length > 16) this.killRing.shift();
    }
    this.lastKillKind = direction;
    this.lastYank = undefined;
  }
          yank() {
    const index = this.killRing.length - 1;
    const text = this.killRing[index];
    if (!text) return;
    const start = this.cursor;
    this.insert(text);
    this.lastYank = {
      start,
      length: this.cursor - start,
      ringIndex: index,
    };
  }
          yankPop() {
    const yank = this.lastYank;
    if (
      !yank ||
      this.killRing.length < 2 ||
      this.cursor !== yank.start + yank.length
    )
      return;
    const points = [...this.value];
    points.splice(yank.start, yank.length);
    const index =
      (yank.ringIndex + this.killRing.length - 1) % this.killRing.length;
    const text = this.killRing[index] ;
    const inserted = [...text].slice(0, 32000 - points.length);
    points.splice(yank.start, 0, ...inserted);
    this.remember();
    this.value = points.join("");
    this.cursor = yank.start + inserted.length;
    this.lastYank = {
      start: yank.start,
      length: inserted.length,
      ringIndex: index,
    };
  }
          editKey(key     )          {
    const points = [...this.value];
    if (key.ctrl && key.name === "home") {
      this.cursor = 0;
      return true;
    }
    if (key.ctrl && key.name === "end") {
      this.cursor = points.length;
      return true;
    }
    if (key.ctrl && (key.name === "up" || key.name === "down")) {
      const lines = this.value.split("\n");
      const lineStarts           = [];
      let offset = 0;
      for (const line of lines) {
        lineStarts.push(offset);
        offset += [...line].length + 1;
      }
      let lineIndex = Math.max(
        0,
        lineStarts.findIndex(
          (start, i) =>
            this.cursor >= start &&
            this.cursor <= start + [...lines[i] ].length,
        ),
      );
      const paragraphStart = (line        )         => {
        while (line > 0 && !lines[line - 1] .trim()) line--;
        while (line > 0 && lines[line - 1] .trim()) line--;
        return line;
      };
      const paragraphEnd = (line        )         => {
        while (line < lines.length - 1 && !lines[line + 1] .trim()) line++;
        while (line < lines.length - 1 && lines[line + 1] .trim()) line++;
        return line;
      };
      if (key.name === "up") {
        const start = paragraphStart(lineIndex);
        lineIndex =
          lineIndex === start && start > 0 ? paragraphStart(start - 1) : start;
        this.cursor = lineStarts[lineIndex] ;
      } else {
        const end = paragraphEnd(lineIndex);
        lineIndex =
          lineIndex === end && end < lines.length - 1
            ? paragraphEnd(end + 1)
            : end;
        this.cursor = lineStarts[lineIndex]  + [...lines[lineIndex] ].length;
      }
      return true;
    }
    const up = key.name === "up" || (key.ctrl && key.name === "p");
    const down = key.name === "down" || (key.ctrl && key.name === "n");
    if (up || down) {
      const start = this.cursor
        ? points.lastIndexOf("\n", this.cursor - 1) + 1
        : 0;
      const column = this.cursor - start;
      if (up && start > 0) {
        const previous =
          start > 1 ? points.lastIndexOf("\n", start - 2) + 1 : 0;
        this.cursor = Math.min(start - 1, previous + column);
      } else if (down) {
        const end = points.indexOf("\n", this.cursor);
        if (end >= 0) {
          const nextEnd = points.indexOf("\n", end + 1);
          this.cursor = Math.min(
            nextEnd < 0 ? points.length : nextEnd,
            end + 1 + column,
          );
        }
      }
      return true;
    }
    // Word jumps use letter and digit runs, so punctuation separates words.
    // Ctrl+W is the exception and deletes back to whitespace. Ctrl+Left and
    // Ctrl+Right mirror the Alt word jumps for terminals that send them.
    if (
      (key.meta && (key.name === "b" || key.name === "left")) ||
      (key.ctrl && key.name === "left")
    ) {
      let pos = this.cursor;
      if (pos === 0 || points[pos - 1] === "\n") {
        this.cursor = pos === 0 ? 0 : pos - 1;
        return true;
      }
      while (pos > 0 && /\s/u.test(points[pos - 1] )) pos--;
      const previous = points[pos - 1];
      if (previous && WorkspaceInput.isPunctuationChar(previous)) {
        while (pos > 0 && WorkspaceInput.isPunctuationChar(points[pos - 1] ))
          pos--;
      } else {
        while (pos > 0 && WorkspaceInput.isWordChar(points[pos - 1] )) pos--;
      }
      this.cursor = pos;
      return true;
    }
    if (
      (key.meta && (key.name === "f" || key.name === "right")) ||
      (key.ctrl && key.name === "right")
    ) {
      let pos = this.cursor;
      if (pos >= points.length || points[pos] === "\n") {
        this.cursor = pos >= points.length ? pos : pos + 1;
        return true;
      }
      while (pos < points.length && /\s/u.test(points[pos] )) pos++;
      const current = points[pos];
      if (current && WorkspaceInput.isPunctuationChar(current)) {
        while (
          pos < points.length &&
          WorkspaceInput.isPunctuationChar(points[pos] )
        )
          pos++;
      } else {
        while (pos < points.length && WorkspaceInput.isWordChar(points[pos] ))
          pos++;
      }
      this.cursor = pos;
      return true;
    }
    if (key.meta && (key.name === "d" || key.name === "delete")) {
      const start = this.cursor;
      let pos = start;
      while (pos < points.length && !WorkspaceInput.isWordChar(points[pos] ))
        pos++;
      while (pos < points.length && WorkspaceInput.isWordChar(points[pos] ))
        pos++;
      if (pos > start) {
        this.remember();
        this.killText(points.slice(start, pos).join(""), "forward");
        points.splice(start, pos - start);
        this.value = points.join("");
      }
      return true;
    }
    if (
      (key.ctrl && (key.name === "w" || key.name === "backspace")) ||
      (key.meta && key.name === "backspace")
    ) {
      let start = this.cursor;
      while (start > 0 && /\s/u.test(points[start - 1] )) start--;
      while (start > 0 && !/\s/u.test(points[start - 1] )) start--;
      if (start < this.cursor) {
        this.remember();
        this.killText(points.slice(start, this.cursor).join(""), "backward");
        points.splice(start, this.cursor - start);
        this.cursor = start;
        this.value = points.join("");
      }
      return true;
    }
    if (key.ctrl && key.name === "t") {
      const start = this.cursor
        ? points.lastIndexOf("\n", this.cursor - 1) + 1
        : 0;
      const end = points.indexOf("\n", this.cursor);
      const lineEnd = end < 0 ? points.length : end;
      if (lineEnd - start < 2) return true;
      const position = Math.max(
        start + 1,
        this.cursor >= lineEnd ? lineEnd - 1 : this.cursor,
      );
      this.remember();
      [points[position - 1], points[position]] = [
        points[position] ,
        points[position - 1] ,
      ];
      this.value = points.join("");
      this.cursor = position + 1;
      return true;
    }
    if (key.ctrl && key.name === "k") {
      const count = points.length - this.cursor;
      if (count > 0) {
        this.remember();
        this.killText(
          points.slice(this.cursor, this.cursor + count).join(""),
          "forward",
        );
        points.splice(this.cursor, count);
        this.value = points.join("");
      }
      return true;
    }
    return false;
  }
  key(value                    , key     )                                  {
    if (key.name === "paste-start") {
      this.pasting = true;
      this.editing = true;
      return;
    }
    if (key.name === "paste-end") {
      this.pasting = false;
      return;
    }
    if (!this.editing) return;
    if (this.pasting) {
      if (value)
        this.insert(
          value
            .replace(/\r\n?/g, "\n")
            .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ""),
        );
      return;
    }
    if (this.pendingCharacterJump) {
      const direction = this.pendingCharacterJump;
      this.pendingCharacterJump = undefined;
      if (key.ctrl && key.name === "]") return;
      if (!key.ctrl && !key.meta && !key.shift && value) {
        const target = [...value];
        const points = [...this.value];
        const matches = (index        ) =>
          target.every((point, offset) => points[index + offset] === point);
        let index = -1;
        if (target.length) {
          if (direction === "forward") {
            for (
              let candidate = this.cursor + 1;
              candidate <= points.length - target.length;
              candidate++
            ) {
              if (matches(candidate)) {
                index = candidate;
                break;
              }
            }
          } else {
            for (
              let candidate = Math.min(
                this.cursor - 1,
                points.length - target.length,
              );
              candidate >= 0;
              candidate--
            ) {
              if (matches(candidate)) {
                index = candidate;
                break;
              }
            }
          }
        }
        if (index >= 0) this.cursor = index;
        this.lastKillKind = undefined;
        this.lastYank = undefined;
        return;
      }
      // A non-printable key cancels the pending jump, then retains its normal
      // composer behavior below, matching OMP's editor state machine.
    }
    if (key.ctrl && key.name === "]") {
      this.pendingCharacterJump = key.meta ? "backward" : "forward";
      this.lastKillKind = undefined;
      this.lastYank = undefined;
      return;
    }
    const isKill =
      (key.ctrl && ["w", "u", "k"].includes(key.name ?? "")) ||
      (key.meta && key.name === "d");
    if (!isKill) this.lastKillKind = undefined;
    if (!(key.meta && key.name === "y")) this.lastYank = undefined;
    if (key.meta && key.name === "y") {
      this.yankPop();
      return;
    }
    if (key.name === "escape") {
      this.editing = false;
      return "escape";
    }
    // Ctrl+J inserts a newline in every terminal, no setup needed.
    if (key.ctrl && key.name === "j") {
      this.insert("\n");
      return;
    }
    if (key.ctrl && key.name === "y") {
      this.yank();
      return;
    }
    if (key.ctrl && key.shift && key.name === "z") {
      this.redoEdit();
      return;
    }
    if (key.ctrl && (key.name === "_" || key.name === "-")) {
      this.undoEdit();
      return;
    }
    if (key.name === "return" || key.name === "enter") {
      // Shift+Enter, Alt+Enter and Ctrl+Enter insert a newline. A trailing
      // backslash plus Enter is the fallback that works in every terminal.
      if (key.meta || key.shift || key.ctrl) {
        this.insert("\n");
        return;
      }
      const pointsNow = [...this.value];
      if (
        this.cursor === pointsNow.length &&
        pointsNow.length > 0 &&
        pointsNow[pointsNow.length - 1] === "\\"
      ) {
        this.remember();
        pointsNow.pop();
        this.value = pointsNow.join("");
        this.cursor = pointsNow.length;
        this.insert("\n");
        return;
      }
      return "submit";
    }
    // Ctrl+P opens the command palette while editing. The outer dispatcher
    // uses Ctrl+P/Ctrl+N for list navigation when the composer is unfocused.
    if (key.ctrl && key.name === "p") {
      this.pendingCommand = "/command-palette";
      return;
    }
    if (this.editKey(key)) return;
    const points = [...this.value];
    if (key.name === "backspace") {
      if (this.cursor) {
        this.remember();
        points.splice(--this.cursor, 1);
      }
      this.value = points.join("");
    } else if (key.name === "delete" || (key.ctrl && key.name === "d")) {
      if (this.cursor < points.length) {
        this.remember();
        points.splice(this.cursor, 1);
        this.value = points.join("");
      }
    } else if (key.name === "left") this.cursor = Math.max(0, this.cursor - 1);
    else if (key.name === "right")
      this.cursor = Math.min(points.length, this.cursor + 1);
    else if (key.name === "home" || (key.ctrl && key.name === "a"))
      this.cursor = 0;
    else if (key.name === "end" || (key.ctrl && key.name === "e"))
      this.cursor = points.length;
    else if (key.ctrl && key.name === "u") {
      this.remember();
      this.killText(points.slice(0, this.cursor).join(""), "backward");
      points.splice(0, this.cursor);
      this.value = points.join("");
      this.cursor = 0;
    } else if (
      !key.ctrl &&
      !key.meta &&
      value &&
      !/[\x00-\x1f\x7f-\x9f]/.test(value)
    )
      this.insert(value);
    return;
  }
  display() {
    // Block cursor, one cell like a terminal cursor. The render matches it
    // literally, so typed text can never be mistaken for the cursor.
    const points = [...this.value];
    points.splice(this.cursor, 0, "▌");
    return points.join("");
  }
}

async function runWorkspaceTui(
  argv                   ,
)                  {
  let directory                    ,
    once = false,
    source                    ,
    sessionId                    ,
    projectPath                    ;
  const skillIds           = [];
  let tab               = "chat";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--once") once = true;
    else if (arg === "--help") {
      console.log(
        "nomo tui [--once] [--project PATH] [--skill ID ...] [--view chat|sessions|documents|ledger|approvals|policy|tools|models|usage|help] [--session ID] [--data-dir PATH] [--import-provider SOURCE-ID]",
      );
      return 0;
    } else if (arg === "--project" || arg === "--skill") {
      const value = argv[++i];
      if (!value || value.startsWith("--"))
        throw Error(`${arg} requires a value`);
      if (arg === "--project") {
        if (projectPath) throw Error("--project may be specified only once");
        projectPath = value;
      } else skillIds.push(value);
    } else if (
      ["--view", "--session", "--data-dir", "--import-provider"].includes(arg )
    ) {
      const value = argv[++i];
      if (!value || value.startsWith("--"))
        throw Error(`${arg} requires a value`);
      if (arg === "--view") {
        const selected = workspaceTab(value);
        if (!selected) throw Error("Unknown TUI view");
        tab = selected;
      }
      if (arg === "--session") sessionId = value;
      if (arg === "--data-dir") directory = resolve(value);
      if (arg === "--import-provider") source = value;
    } else throw Error(`Unknown TUI option: ${arg}`);
  }
  const interactive =
    !once &&
    process.stdin.isTTY &&
    process.stdout.isTTY &&
    process.env.TERM !== "dumb" &&
    !process.env.CI;
  const env                    = {
    ...process.env,
    ...(directory ? { NOMO_DATA_DIR: directory } : {}),
  };
  // Normalized here rather than only in the binary so a test that drives the
  // TUI entry point directly sees the same settings an operator configured
  // under the old names.
  Object.assign(env, normalizeOwnedEnv(env));
  if (skillIds.length && !projectPath)
    throw Error("--skill requires --project");
  if (projectPath && (once || !interactive)) {
    console.error(
      "Project access requires an interactive TTY confirmation; no project or skill data was sent.",
    );
    return 2;
  }
  const projectRoot = projectPath
    ? await canonicalProjectRoot(resolve(projectPath))
    : undefined;
  const projectSkills = projectRoot
    ? await readProjectSkills(projectRoot, skillIds)
    : [];
  const dataDir$1 =
    envValue(env, "NOMO_DATA_DIR") ??
    join(
      envValue(env, "NOMO_LEDGER_DIR") ?? join(dataDir(homedir())),
      "workbench",
    );
  const store = new LocalStorage(join(dataDir$1, "tui"));
  const saved = store.read  
                       
                       
                     
                                                           
                   
                                        
                               
                  
                                         
                                   
    ();
  const app = new Workbench(env),
    ui = new WorkspaceTui(app, env);
  ui.applySavedSettings(saved?.settings);
  const parsedKeybindings = parseWorkspaceKeybindings(ui.keybindingsOverride);
  let keybindings = parsedKeybindings.bindings;
  const drafts = saved?.drafts ?? {};
  const input = new WorkspaceInput();
  await ui.initialize();
  if (parsedKeybindings.error) ui.notice = parsedKeybindings.error;
  if (projectRoot) {
    let sandboxConfigured        ;
    try {
      const config = projectSandboxConfig(env);
      sandboxConfigured = `${config.runtime} ${config.imageId}`;
    } catch (error) {
      sandboxConfigured =
        error instanceof Error
          ? `unavailable: ${error.message}`
          : "unavailable";
    }
    ui.prepareProjectAccess(projectRoot, projectSkills, sandboxConfigured);
  }
  ui.toolActivityMode =
    saved?.toolActivityMode === "compact" ||
    saved?.toolActivityMode === "details" ||
    saved?.toolActivityMode === "expanded"
      ? saved.toolActivityMode
      : "details";
  ui.hideToolActivity = saved?.hideToolActivity ?? false;
  if (
    saved?.mode === "normal" ||
    saved?.mode === "accept" ||
    saved?.mode === "plan"
  )
    ui.mode = saved.mode;
  if (source) await ui.command(`/connect ${source}`);
  const selected = sessionId ?? saved?.sessionId;
  if (selected && app.get(selected)) ui.sessionId = selected;
  if (saved?.model && ui.provider?.models.some((m) => m.id === saved.model))
    ui.model = saved.model;
  if (tab === "models") await ui.openModelPicker();
  else ui.choose(tab);
  if (app.listProjects().some((item) => item.id === saved?.projectId))
    ui.projectId = saved?.projectId;
  if (app.agents().agents.some((item) => item.id === saved?.agentId))
    ui.agentId = saved?.agentId;
  if (saved?.lastRecoveryJob && app.get(saved.lastRecoveryJob.sessionId))
    ui.lastRecoveryJob = saved.lastRecoveryJob;
  input.set(drafts[ui.sessionId ?? "new"] ?? "");
  if (once || !interactive) {
    console.log(
      renderWorkspace(
        ui,
        process.stdout.columns ?? oneShotDimension("COLUMNS", 100),
        process.stdout.rows ?? oneShotDimension("LINES", 32),
      ),
    );
    await app.shutdown();
    return ui.proofErrors.size || ui.proxy.errors.length ? 1 : 0;
  }
  input.editing = tab === "chat";
  let suggestion = 0;
  let historyIndex = -1;
  let historyDraft = "";
  let historyQuery = "";
  let historyPos = -1;
  let mentionIndex = 0;
  let lastEsc = 0;
  let lastCtrlC = 0;
  // Ctrl+S stash slot and Ctrl+L double press stay local, never persisted.
  let stash = "";
  let stashCursor = 0;
  let lastCtrlL = 0;
  let lastCtrlD = 0;
  let lastMouseClick                                            ;
  let dismissedCommandSuggestions                    ;
  const doubleLeftSessions = new DoubleLeftSessionShortcut();
  const chord = new ChordTracker();
  let startedAt = Date.now();
  let terminalCapabilities = detectCapabilities(env, process.stdout);
  const color = env.NOMO_TUI_COLOR === "0" ? false : terminalCapabilities.ansi;
  const motion = env.NOMO_TUI_MOTION !== "0" && env.TERM !== "dumb";
  const terminal = createWorkspaceTerminal(process.stdin, process.stdout);
  let busy = false,
    suspended = false,
    stopped = false,
    refreshing = false,
    initializingTerminal = true;
  let timer                            ,
    motionTimer                            ,
    draftTimer                            ,
    cellPixelTimer                            ;
  let mouseSelection                                                       ;
  let selectionDragging = false;
  let renderedFrame = "";
  // Keep input focus in sync with the same visible Chat surface the renderer
  // treats as the base view. Returning from a panel must restore typing.
  const chatComposerOwnsFocus = () =>
    ui.tab === "chat" &&
    !ui.detail &&
    !ui.confirmation &&
    !ui.settingsOpen &&
    !ui.palette &&
    !ui.modelPicker?.open &&
    !ui.diffView &&
    !ui.showingKeybindings &&
    !ui.showingCheatSheet;
  const saveDraft = () => {
    if (!input.value.startsWith("/"))
      drafts[ui.sessionId ?? "new"] = input.value;
    store.save({
      sessionId: ui.sessionId,
      projectId: ui.projectId,
      agentId: ui.agentId,
      lastRecoveryJob: ui.lastRecoveryJob,
      model: ui.model,
      toolActivityMode: ui.toolActivityMode,
      hideToolActivity: ui.hideToolActivity,
      mode: ui.mode,
      settings: ui.localSettings(),
      drafts,
    });
  };
  const scheduleDraft = () => {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      try {
        saveDraft();
      } catch (e) {
        ui.notice = message(e);
      }
    }, 500);
  };
  const draw = () => {
    if (stopped || suspended || initializingTerminal) return;
    // Derive input ownership from the visible surface on every redraw. A panel
    // can close through several paths (Escape, Tab, mouse or command result);
    // keeping this invariant here prevents stale focus from freezing Chat.
    input.editing = chatComposerOwnsFocus();
    const now = Date.now();
    renderedFrame = renderWorkspace(
      ui,
      terminal.columns,
      terminal.rows,
      input.value,
      input.editing,
      busy,
      {
        color: ui.colorOverride ?? color,
        capabilities: terminalCapabilities,
        motion: ui.motionOverride ?? motion,
        now,
        frame:
          motion && ui.motionOverride !== false
            ? Math.floor((now - startedAt) / 100)
            : 0,
        command: input.value,
        cursor: input.cursor,
        suggestion,
        suggestionsDismissed: dismissedCommandSuggestions === input.value,
      },
    );
    terminal.render(
      mouseSelection
        ? highlightMouseSelection(
            renderedFrame,
            mouseSelection.anchor,
            mouseSelection.focus,
            terminal.columns,
          )
        : renderedFrame,
    );
  };
  const applyCellPixelHeight = (
    cellPixels                                               ,
  ) => {
    if (
      !cellPixels ||
      stopped ||
      suspended ||
      terminalCapabilities.cellHeightPixels === cellPixels.height
    )
      return;
    terminalCapabilities = {
      ...terminalCapabilities,
      cellHeightPixels: cellPixels.height,
    };
    draw();
  };
  const scheduleCellPixelMeasurement = () => {
    if (cellPixelTimer !== undefined) clearTimeout(cellPixelTimer);
    cellPixelTimer = setTimeout(() => {
      cellPixelTimer = undefined;
      if (stopped || suspended) return;
      void terminal
        .measureCellPixels()
        .then(applyCellPixelHeight, () => undefined);
    }, 120);
  };
  let activeTask                = Promise.resolve();
  const task = (fn                        ) => {
    if (busy) {
      ui.notice = "An action is already running. Try again when it finishes.";
      draw();
      return activeTask;
    }
    busy = true;
    activeTask = (async () => {
      try {
        await fn();
        await ui.refresh();
        const queued = takeReadyQueuedPrompt(ui, {
          workbenchRunning: app.running(),
          hasConfirmation: !!ui.confirmation,
        });
        if (queued) {
          await dispatchQueuedPrompt(
            ui,
            queued,
            () => ui.refresh(),
            (error) => {
              ui.notice = message(error);
            },
          );
        }
      } catch (error) {
        ui.notice = message(error);
      } finally {
        busy = false;
        draw();
      }
    })();
    return activeTask;
  };
  const editor = async () => {
    const target = ui.editTarget();
    const config          = env.NOMO_TUI_EDITOR
      ? JSON.parse(env.NOMO_TUI_EDITOR)
      : [env.EDITOR || "nano"];
    if (
      !Array.isArray(config) ||
      !config.length ||
      !config.every((v) => typeof v === "string" && v.length)
    )
      throw Error(
        "NOMO_TUI_EDITOR must be a JSON array of an executable and its arguments.",
      );
    const temp = await mkdtemp(join(tmpdir(), "nomo-editor-")),
      file = join(temp, "document.txt");
    let captured = false;
    await writeFile(file, target.content, { mode: 0o600 });
    suspended = true;
    terminal.suspend();
    try {
      const code = await new Promise               ((done, reject) => {
        const child = spawn(config[0], [...config.slice(1), file], {
          stdio: "inherit",
          shell: false,
        });
        child.once("error", reject);
        child.once("exit", done);
      });
      if (code !== 0)
        throw Error(
          "The editor did not finish. The original document is preserved.",
        );
      const content = await readFile(file, "utf8");
      if (Buffer.byteLength(content) > 256000)
        throw Error("Document exceeds 256 kB.");
      ui.prepareEdit(target, content);
      captured = true;
    } catch (error) {
      throw Error(`${message(error)} Editor draft preserved at ${file}`);
    } finally {
      if (captured) await rm(temp, { recursive: true, force: true });
      suspended = false;
      if (!stopped) {
        terminal.resume();
        scheduleCellPixelMeasurement();
      }
    }
  };
  return new Promise        ((resolveDone) => {
    let suspendKeepalive                            ;
    let resumeOnContinue                          ;
    const restoreTerminal = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      clearInterval(motionTimer);
      clearTimeout(draftTimer);
      clearTimeout(cellPixelTimer);
      if (suspendKeepalive) clearInterval(suspendKeepalive);
      suspendKeepalive = undefined;
      if (resumeOnContinue) process.off("SIGCONT", resumeOnContinue);
      resumeOnContinue = undefined;
      process.off("SIGINT", stopOnSigint);
      process.off("SIGTERM", stopOnSigterm);
      process.off("SIGHUP", stopOnSighup);
      process.off("exit", restoreTerminal);
      process.off("uncaughtExceptionMonitor", restoreTerminal);
      if (ui.localTabIcons) {
        try {
          terminal.writeGraphics(
            `${kittyTabIconsCleanup(ui.localTabIcons)}${kittyProviderIconCleanup(ui.localTabIcons)}`,
          );
        } catch {
          // Terminal restoration must still run if the graphics cleanup fails.
        }
      }
      terminal.destroy();
    };
    const stop = () => {
      if (stopped) return;
      // Fatal exits need synchronous terminal cleanup, never asynchronous storage work.
      restoreTerminal();
      let draftError = false;
      try {
        saveDraft();
      } catch {
        draftError = true;
      }
      if (draftError) console.error("Could not save the draft.");
      console.log(
        "NOMO: stopping the run and saving history. A dispatched external tool may still complete.",
      );
      void (async () => {
        app.close();
        await activeTask;
        await app.settled();
      })().then(
        () => resolveDone(draftError ? 1 : 0),
        () => {
          console.error(
            "Save failed. Preserve the data directory and check the ledger.",
          );
          resolveDone(1);
        },
      );
    };
    const stopOnSigint = () => {
      const now = Date.now();
      if (signalQuitAction(now, lastCtrlC) === "stop") {
        lastCtrlC = 0;
        stop();
        return;
      }
      lastCtrlC = now;
      ui.notice = "Press Ctrl+C again to exit.";
      draw();
    };
    const stopOnSigterm = () => stop();
    const stopOnSighup = () => stop();
    const suspendToBackground = () => {
      if (process.platform === "win32") {
        ui.notice = "Ctrl+Z suspend is not supported on Windows.";
        draw();
        return;
      }
      try {
        saveDraft();
      } catch (error) {
        ui.notice = message(error);
        draw();
        return;
      }
      suspended = true;
      const suspendedAt = Date.now();
      suspendKeepalive = setInterval(() => {}, 2 ** 30);
      resumeOnContinue = () => {
        if (suspendKeepalive) clearInterval(suspendKeepalive);
        suspendKeepalive = undefined;
        resumeOnContinue = undefined;
        startedAt += Date.now() - suspendedAt;
        suspended = false;
        try {
          terminal.resume();
          scheduleCellPixelMeasurement();
          draw();
        } catch {
          stop();
        }
      };
      try {
        terminal.suspend();
        process.once("SIGCONT", resumeOnContinue);
        // Stop the foreground job as a group so shells and pipelines resume
        // coherently. SIGSTOP cannot be swallowed by child-installed handlers.
        process.kill(0, "SIGSTOP");
      } catch (error) {
        if (suspendKeepalive) clearInterval(suspendKeepalive);
        suspendKeepalive = undefined;
        if (resumeOnContinue)
          process.removeListener("SIGCONT", resumeOnContinue);
        resumeOnContinue = undefined;
        suspended = false;
        try {
          terminal.resume();
          scheduleCellPixelMeasurement();
        } catch {
          stop();
          return;
        }
        ui.notice = `Could not suspend: ${message(error)}`;
        draw();
      }
    };
    const submit = async () => {
      const original = input.value,
        oldSession = ui.sessionId ?? "new";
      const result = await ui.command(original);
      if (result === "quit") {
        stop();
        return;
      }
      if (!original.trimStart().startsWith("/")) drafts[oldSession] = "";
      input.set(drafts[ui.sessionId ?? "new"] ?? "");
      input.editing = chatComposerOwnsFocus();
      suggestion = 0;
      historyIndex = -1;
      if (result === "edit") await editor();
      saveDraft();
    };
    const navigate = async (fn                        ) => {
      const prior = ui.sessionId;
      saveDraft();
      await fn();
      if (prior !== ui.sessionId)
        input.set(drafts[ui.sessionId ?? "new"] ?? "");
      input.editing = chatComposerOwnsFocus();
    };
    const onKey = async (value                    , key     ) => {
      if (stopped || suspended) return;
      lastMouseClick = undefined;
      if (isSuspendKey(key)) {
        suspendToBackground();
        return;
      }
      if (key.name !== "escape") dismissedCommandSuggestions = undefined;
      if (!input.pasting && key.meta && key.name === "l") {
        terminal.invalidateDisplay();
        draw();
        return;
      }
      if (ui.modelPicker?.open && key.name === "tab") {
        ui.modelPicker = {
          ...ui.modelPicker,
          focusedPane:
            ui.modelPicker.focusedPane === "providers" ? "models" : "providers",
        };
        draw();
        return;
      }
      const pickerResult = handleModelPickerKey(ui, value, key);
      if (pickerResult !== false) {
        if (typeof pickerResult === "string")
          await task(async () => {
            await ui.selectModel(pickerResult);
            input.editing = chatComposerOwnsFocus();
          });
        else if (typeof pickerResult === "object") {
          void task(() =>
            ui.loadModelPickerProvider(pickerResult.loadProviderId),
          );
          input.editing = false;
          draw();
        } else {
          if (!ui.modelPicker?.open) input.editing = chatComposerOwnsFocus();
          draw();
        }
        return;
      }
      // An open palette consumes every key except the ones it binds itself.
      // Letting the key fall through would move tabs or run a shortcut behind
      // a filter surface, which is how a search box starts deleting work.
      if (ui.palette) {
        if (key.name === "escape") {
          ui.palette = undefined;
          input.editing = chatComposerOwnsFocus();
          ui.notice = "Palette closed.";
          draw();
          return;
        }
        if (key.name === "return" || key.name === "enter") {
          const matches = filterPalette(
            paletteFromCommands(TUI_COMMANDS),
            ui.palette.query,
          );
          const picked = matches[ui.palette.selected];
          ui.palette = undefined;
          if (!picked) {
            input.editing = chatComposerOwnsFocus();
            ui.notice = "No command matches that.";
            draw();
            return;
          }
          const priorSession = ui.sessionId;
          const priorDraft = input.value;
          const priorCursor = input.cursor;
          await task(async () => {
            saveDraft();
            const result = await ui.command(picked.id);
            if (result === "quit") {
              stop();
              return;
            }
            if (priorSession !== ui.sessionId) {
              input.set(drafts[ui.sessionId ?? "new"] ?? "");
            } else {
              input.set(priorDraft);
              input.cursor = Math.min(priorCursor, [...priorDraft].length);
            }
            input.editing = chatComposerOwnsFocus();
            if (result === "edit") await editor();
            saveDraft();
          });
          return;
        }
        if (key.name === "up" || key.name === "down") {
          ui.palette = advanceSelection(
            ui.palette,
            filterPalette(paletteFromCommands(TUI_COMMANDS), ui.palette.query),
            key.name === "down" ? 1 : -1,
          );
          draw();
          return;
        }
        if (["home", "end", "pageup", "pagedown"].includes(key.name ?? "")) {
          const matches = filterPalette(
            paletteFromCommands(TUI_COMMANDS),
            ui.palette.query,
          );
          if (key.name === "home") ui.palette = { ...ui.palette, selected: 0 };
          else if (key.name === "end")
            ui.palette = {
              ...ui.palette,
              selected: Math.max(0, matches.length - 1),
            };
          else
            ui.palette = advanceSelection(
              ui.palette,
              matches,
              (key.name === "pagedown" ? 1 : -1) *
                Math.max(1, ui.palette.visible - 1),
            );
          draw();
          return;
        }
        if (key.name === "backspace") {
          ui.palette = backspaceInPalette(ui.palette);
          draw();
          return;
        }
        if (value && !key.ctrl && !key.meta && [...value].length === 1) {
          ui.palette = typeInPalette(ui.palette, value);
          draw();
          return;
        }
        draw();
        return;
      }
      if (
        doubleLeftSessions.press(
          key,
          input.editing &&
            input.value === "" &&
            !input.pasting &&
            chatComposerOwnsFocus(),
        )
      ) {
        ui.choose("sessions");
        input.editing = chatComposerOwnsFocus();
        draw();
        return;
      }
      if (
        isToolActivityCycleKey(key, app.running()) &&
        chatComposerOwnsFocus() &&
        !input.pasting
      ) {
        ui.toolActivityMode = nextToolActivityMode(ui.toolActivityMode);
        ui.notice = `Agent activity: ${ui.toolActivityMode}.`;
        try {
          saveDraft();
        } catch (error) {
          ui.notice = message(error);
        }
        draw();
        return;
      }
      // The diff panel owns a small set of keys while it is on screen. They
      // are bound here rather than in the normal shortcut path because j, k
      // and space are already filter keys on the list tabs, and the panel is
      // the only surface where staging a hunk is the obvious meaning.
      if (ui.diffView) {
        if (key.name === "escape") {
          ui.diffView = undefined;
          ui.detail = undefined;
          ui.scroll = 0;
          input.editing = chatComposerOwnsFocus();
          draw();
          return;
        }
        if (key.name === "down" || value === "j") {
          ui.diffView = moveHunk(ui.diffView, 1);
          ui.rediff();
          draw();
          return;
        }
        if (key.name === "up" || value === "k") {
          ui.diffView = moveHunk(ui.diffView, -1);
          ui.rediff();
          draw();
          return;
        }
        if (key.name === "space") {
          ui.diffView = toggleHunk(ui.diffView, ui.diffView.cursor);
          ui.rediff();
          draw();
          return;
        }
        if (value === "s") {
          ui.diffView = setSide(ui.diffView, "split");
          ui.rediff();
          draw();
          return;
        }
        if (value === "u") {
          ui.diffView = setSide(ui.diffView, "unified");
          ui.rediff();
          draw();
          return;
        }
        if (value === "a") {
          const all = ui.diffView.hunks.every((hunk) => hunk.staged);
          ui.diffView = {
            ...ui.diffView,
            hunks: ui.diffView.hunks.map((hunk) => ({ ...hunk, staged: !all })),
          };
          ui.rediff();
          draw();
          return;
        }
      }
      // The keybinding table is searchable in place. A thirty row reference
      // the operator has to scroll is the reason people stop checking and
      // guess instead, and this is the one view where looking something up is
      // the whole task.
      if (ui.showingKeybindings) {
        if (key.name === "backspace") {
          ui.keybindingQuery = [...ui.keybindingQuery].slice(0, -1).join("");
          ui.refreshKeybindings();
          draw();
          return;
        }
        // Escape with a query clears it, and with an empty query falls
        // through to the normal close, so the key means the obvious thing at
        // both ends without a second binding to remember.
        if (key.name === "escape" && ui.keybindingQuery) {
          ui.keybindingQuery = "";
          ui.refreshKeybindings();
          draw();
          return;
        }
        if (value && !key.ctrl && !key.meta && [...value].length === 1) {
          ui.keybindingQuery += value;
          ui.refreshKeybindings();
          draw();
          return;
        }
      }
      // The cheat sheet is filtered the same way, for the same reason, and it
      // is reachable from anywhere so this block has to work in every mode.
      // Escape with a filter clears it, with an empty filter closes the sheet,
      // so one key covers both ends of the same action.
      if (ui.showingCheatSheet) {
        if (key.name === "backspace") {
          ui.cheatQuery = [...ui.cheatQuery].slice(0, -1).join("");
          ui.refreshCheatSheet();
          draw();
          return;
        }
        if (key.name === "escape" && ui.cheatQuery) {
          ui.cheatQuery = "";
          ui.refreshCheatSheet();
          draw();
          return;
        }
        if (key.name === "escape") {
          ui.closeCheatSheet();
          input.editing = chatComposerOwnsFocus();
          draw();
          return;
        }
        if (value && !key.ctrl && !key.meta && [...value].length === 1) {
          ui.cheatQuery += value;
          ui.refreshCheatSheet();
          draw();
          return;
        }
      }
      // ? is bound twice on purpose, and neither binding is here. One sits in
      // the composer path and fires only for a lone ? on an empty prompt,
      // because a question mark mid sentence is ordinary text that has to
      // reach the model. The other sits in the shortcut path below and only
      // runs when the composer does not have focus. A single binding placed
      // here would have to guess which of those two situations it was in, and
      // a guess that swallowed a typed question mark would corrupt a prompt
      // the operator never meant to change.
      //
      // Exit confirmation requires consecutive Ctrl+C presses; any other key
      // cancels the pending quit so a normal edit cannot inherit confirmation.
      const ctrlC = key.ctrl && key.name === "c";
      if (!ctrlC) lastCtrlC = 0;
      // Double Escape must be consecutive, not span commands typed in between.
      if (key.name !== "escape") lastEsc = 0;
      const commandSuggestionsVisible =
        input.editing &&
        !input.pasting &&
        !ui.confirmation &&
        dismissedCommandSuggestions !== input.value &&
        commandSuggestions(input.value).length > 0;
      if (key.name === "escape" && commandSuggestionsVisible) {
        dismissedCommandSuggestions = input.value;
        suggestion = 0;
        lastEsc = 0;
        draw();
        return;
      }
      if (
        ctrlC &&
        !input.pasting &&
        !input.value &&
        isDoubleEscape(Date.now(), lastCtrlC)
      ) {
        lastCtrlC = 0;
        stop();
        return;
      }
      if (
        shouldCancelActiveRun(
          key,
          escapeOwnedByOverlay({
            confirmation: !!ui.confirmation,
            palette: !!ui.palette,
            keybindings: ui.showingKeybindings,
            cheatSheet: ui.showingCheatSheet,
            filter: ui.filter,
            panel: ui.tab !== "chat" || !!ui.diffView,
            detail: !!ui.detail,
            suggestions: commandSuggestionsVisible,
          }),
          input.pasting,
        ) &&
        app.running()
      ) {
        try {
          const session = ui.session();
          if (session?.status === "running") {
            app.cancel(session.id);
            // A tool already dispatched may still complete after the cancel.
            // That is the one case where the operator has to keep looking, so
            // it gets a sticky toast rather than a notice the next key
            // overwrites.
            ui.announce(
              "run-stopped",
              "pending",
              "Run stopped. A dispatched tool may still complete.",
            );
          } else {
            if (key.name === "escape") input.editing = false;
            ui.notice =
              "Selected conversation is not running. Open the active conversation to cancel it.";
          }
        } catch (error) {
          ui.announce("cancel-failed", "danger", message(error));
        }
        draw();
        return;
      }
      if (ctrlC) {
        if (input.editing && input.value) {
          input.set("");
          suggestion = 0;
          lastCtrlC = 0;
          try {
            saveDraft();
          } catch (error) {
            ui.notice = message(error);
          }
          draw();
        } else if (isDoubleEscape(Date.now(), lastCtrlC)) {
          lastCtrlC = 0;
          stop();
        } else {
          lastCtrlC = Date.now();
          ui.notice = "Press Ctrl+C again to exit.";
          draw();
        }
        return;
      }
      const shortcut =
        ui.confirmation || (ui.settingsOpen && !(key.ctrl && key.name === "d"))
          ? undefined
          : workspaceShortcut(
              key,
              input.editing,
              input.value,
              keybindings,
              ui.tab,
            );
      if (ui.settingsOpen && shortcut !== "quit") {
        const wasOpen = ui.settingsOpen;
        const wasToolActivityHidden = ui.hideToolActivity;
        const settingsBefore = JSON.stringify(ui.localSettings());
        if (ui.handleSettingsKey(value, key)) {
          const parsed = parseWorkspaceKeybindings(ui.keybindingsOverride);
          keybindings = parsed.bindings;
          if (
            wasToolActivityHidden !== ui.hideToolActivity ||
            settingsBefore !== JSON.stringify(ui.localSettings())
          ) {
            try {
              saveDraft();
            } catch (error) {
              ui.notice = message(error);
            }
          }
          if (wasOpen && !ui.settingsOpen)
            input.editing = chatComposerOwnsFocus();
          draw();
          return;
        }
      }
      if (shortcut === "quit") {
        // Empty input exits on the second press within 800 ms, like the
        // reference terminal. Text input clears first instead of quitting.
        if (input.value) {
          input.set("");
          suggestion = 0;
          try {
            saveDraft();
          } catch (error) {
            ui.notice = message(error);
          }
          ui.notice = "Cleared. Draft saved.";
          draw();
          return;
        }
        const nowD = Date.now();
        if (isDoubleEscape(nowD, lastCtrlD)) {
          lastCtrlD = 0;
          stop();
          return;
        }
        lastCtrlD = nowD;
        // Exit guidance must not be masked by the history viewport status.
        ui.scroll = -1;
        ui.notice = "Press Ctrl+D again to exit.";
        draw();
        return;
      }
      if (shortcut === "show-todos") {
        void task(() => ui.command("/todos"));
        return;
      }
      if (shortcut === "show-agents") {
        void task(async () => {
          await navigate(() => ui.command("/agents"));
          input.editing = false;
        });
        return;
      }
      if (shortcut === "toggle-plan") {
        ui.togglePlanMode();
        try {
          saveDraft();
        } catch (error) {
          ui.notice = message(error);
        }
        draw();
        return;
      }
      if (shortcut === "copy-prompt") {
        if (!input.value) {
          ui.notice = "There is no prompt to copy.";
          draw();
          return;
        }
        if (busy) {
          ui.notice = "Wait for the current action before copying the prompt.";
          draw();
          return;
        }
        busy = true;
        void copyTextToClipboard(input.value)
          .then(() => {
            ui.notice = "Prompt copied to clipboard.";
          })
          .catch((error) => {
            ui.notice = message(error);
          })
          .finally(() => {
            busy = false;
            draw();
          });
        draw();
        return;
      }
      if (shortcut === "retry") {
        if (!ui.canRetryLastTurn()) {
          ui.notice = "Nothing to retry.";
          draw();
        } else if (busy || app.running()) {
          ui.notice = "Wait for the active run to settle before retrying.";
          draw();
        } else {
          try {
            saveDraft();
          } catch (error) {
            ui.notice = message(error);
            draw();
            return;
          }
          void task(() => ui.command("/retry"));
        }
        return;
      }
      if (shortcut === "redraw") {
        // Second Ctrl+L within 2 s runs /clear, like the reference terminal.
        const nowL = Date.now();
        if (nowL - lastCtrlL < 2000) {
          lastCtrlL = 0;
          void task(async () => {
            await navigate(() => ui.command("/clear"));
            input.editing = true;
          });
        } else {
          lastCtrlL = nowL;
          draw();
        }
        return;
      }
      if (shortcut === "stash") {
        if (input.value) {
          stash = input.value;
          stashCursor = input.cursor;
          input.set("");
          suggestion = 0;
          ui.notice = "Stashed. Ctrl+S restores the prompt.";
        } else if (stash) {
          input.set(stash);
          input.cursor = Math.min(stashCursor, [...input.value].length);
          ui.notice = "Restored the stashed prompt.";
        } else {
          ui.notice = "Nothing stashed. Type first, then Ctrl+S.";
        }
        try {
          saveDraft();
        } catch (error) {
          ui.notice = message(error);
        }
        draw();
        return;
      }
      if (shortcut === "external-editor") {
        void task(async () => {
          await editor();
          saveDraft();
        });
        return;
      }
      if (shortcut === "toggle-tools") {
        if (!app.running()) {
          ui.notice = "Agent activity details are available during a run.";
          draw();
          return;
        }
        ui.toolActivityMode = nextToolActivityMode(ui.toolActivityMode);
        ui.notice = `Agent activity: ${ui.toolActivityMode}.`;
        try {
          saveDraft();
        } catch (error) {
          ui.notice = message(error);
        }
        draw();
        return;
      }
      if (shortcut === "toggle-tool-visibility") {
        ui.hideToolActivity = !ui.hideToolActivity;
        ui.notice = ui.hideToolActivity
          ? "Tool activity hidden. Ctrl+Shift+O shows it again."
          : "Tool activity visible.";
        try {
          saveDraft();
        } catch (error) {
          ui.notice = message(error);
        }
        draw();
        return;
      }
      if (shortcut === "search-history") {
        if (!input.value) {
          input.set("/find ");
          suggestion = 0;
          historyQuery = "";
          historyPos = -1;
          ui.notice = "Type search text and press Enter.";
          draw();
          return;
        }
        const matches = searchHistoryPrompts(ui.promptHistory(), input.value);
        if (!matches.length) {
          ui.notice = "No matching prompt in this conversation.";
          draw();
          return;
        }
        if (historyQuery !== input.value) {
          historyQuery = input.value;
          historyPos = -1;
        }
        historyPos = (historyPos + 1) % matches.length;
        input.set(matches[historyPos] );
        ui.notice =
          `History ${historyPos + 1}/${matches.length}. ` +
          "Ctrl+R again for an older match.";
        draw();
        return;
      }
      if (key.name === "paste-start" && ui.confirmation) {
        input.pasting = true;
        return;
      }
      if (input.pasting && ui.confirmation) {
        if (key.name === "paste-end") input.pasting = false;
        return;
      }
      if (ui.confirmation) {
        if (key.name === "escape") {
          ui.confirmation = undefined;
          ui.scroll = 0;
        } else if (value === "y" && !input.pasting)
          void task(() => ui.confirm());
        else if (value === "n" && !input.pasting) ui.reject();
        else if (/^[1-9]$/.test(value ?? "") && !input.pasting) {
          // Per hunk diff scope, client side. The selection rides with
          // the decision; the server applies the full call until scope
          // is enforced by another lane.
          ui.toggleHunk(Number(value) - 1);
        } else if (key.name === "pageup")
          ui.scroll = Math.max(0, ui.scroll - 10);
        else if (key.name === "pagedown") ui.scroll += 10;
        draw();
        return;
      }
      // The sticky banner's a/d actions open the existing review before any
      // decision. Respect focused views, filters and Chat input; the full hold
      // id is resolved from the same ordering the renderer shows.
      if (
        !input.pasting &&
        !input.editing &&
        ui.tab !== "chat" &&
        !ui.filter &&
        !ui.detail &&
        !ui.diffView &&
        !ui.confirmation &&
        !ui.palette &&
        !ui.modelPicker &&
        !ui.showingKeybindings &&
        !ui.showingCheatSheet &&
        (value === "a" || value === "d")
      ) {
        const pending = ui.workbench.pending()[0];
        const proxy = ui.proxy.holds[0];
        const id =
          pending?.holdId ?? (proxy ? `proxy:${proxy.holdId}` : undefined);
        if (id) {
          try {
            ui.prepareApproval(value === "a" ? "approved" : "denied", id);
          } catch (error) {
            ui.notice = message(error);
          }
          draw();
          return;
        }
      }
      if (!input.pasting && key.name === "tab" && key.shift) {
        ui.cycleMode();
        try {
          saveDraft();
        } catch (error) {
          ui.notice = message(error);
        }
        draw();
        return;
      }
      // Readline native chord: Ctrl+X then Ctrl+E opens the editor. A lone
      // Ctrl+X arms nothing visible; any other key disarms it.
      if (!input.pasting && chord.chord(key) === "external-editor") {
        void task(async () => {
          await editor();
          saveDraft();
        });
        return;
      }
      const modelPickerAllowed =
        !ui.confirmation &&
        !ui.detail &&
        !ui.diffView &&
        !ui.palette &&
        !ui.showingKeybindings &&
        !ui.showingCheatSheet;
      // Alt+M changes the future default; Alt+P changes only the current
      // conversation, restricted to the provider that created that session.
      if (
        !input.pasting &&
        key.meta &&
        (key.name === "m" || key.name === "p") &&
        modelPickerAllowed
      ) {
        const selection = key.name === "p" ? "session" : "default";
        await task(async () => ui.openModelPicker(selection));
        input.editing = chatComposerOwnsFocus();
        draw();
        return;
      }
      // Panels are opened from Chat with slash commands. Tab never cycles
      // screens: in a panel it returns to Chat, and in Chat it belongs to the
      // composer and its completion behavior.
      if (
        !input.pasting &&
        key.name === "tab" &&
        !key.shift &&
        ui.tab !== "chat" &&
        !ui.confirmation
      ) {
        try {
          saveDraft();
        } catch (error) {
          ui.notice = message(error);
        }
        ui.choose("chat");
        input.editing = chatComposerOwnsFocus();
        draw();
        return;
      }
      if (
        !input.pasting &&
        input.editing &&
        ui.tab === "chat" &&
        key.name === "tab" &&
        !key.shift
      ) {
        const token = mentionToken(input.value, input.cursor);
        const hasMentionCandidates =
          token !== undefined &&
          mentionCandidates(token, ui.documentPaths()).length > 0;
        const hasCommandCandidates = commandSuggestions(input.value).length > 0;
        if (!hasMentionCandidates && !hasCommandCandidates) {
          // Tab stays a completion key. Without a candidate it leaves the
          // Chat draft untouched instead of sending the user to another view.
          draw();
          return;
        }
      }
      if (
        !input.pasting &&
        key.ctrl &&
        key.name === "end" &&
        ui.tab === "chat" &&
        !ui.detail
      ) {
        ui.scroll = -1;
        draw();
        return;
      }
      if (
        !input.pasting &&
        input.editing &&
        ui.tab === "chat" &&
        key.ctrl &&
        (key.name === "q" || key.name === "enter" || key.name === "return")
      ) {
        if (ui.workbench.running()) {
          if (ui.queueFollowUpPrompt(input.value)) {
            drafts[ui.sessionId ?? "new"] = "";
            input.set("");
            try {
              saveDraft();
            } catch (error) {
              ui.notice = message(error);
            }
          }
          draw();
          return;
        }
        if (key.name === "q" && input.value.trim()) {
          await task(submit);
          return;
        }
      }
      if (
        !input.pasting &&
        ui.queuedPrompt &&
        (key.meta || key.shift) &&
        key.name === "up"
      ) {
        const queued = ui.dequeueQueuedPrompt();
        if (queued) {
          const current = input.value;
          input.set(
            [queued, current].filter((text) => text.trim()).join("\n\n"),
          );
          ui.choose("chat");
          input.editing = true;
          try {
            saveDraft();
          } catch (error) {
            ui.notice = message(error);
          }
        }
        draw();
        return;
      }
      if (input.editing || key.name === "paste-start") {
        // A lone ? on empty input opens the cheat sheet, like the
        // reference. Any other text keeps the keystroke as typed input, because
        // a question mark in the middle of a sentence is ordinary text and
        // must reach the model.
        if (!input.pasting && input.value === "" && value === "?") {
          ui.openCheatSheet();
          input.editing = false;
          draw();
          return;
        }
        const token = input.pasting
          ? undefined
          : mentionToken(input.value, input.cursor);
        const mentions =
          token === undefined
            ? []
            : mentionCandidates(token, ui.documentPaths());
        if (mentions.length && key.name === "tab" && !key.shift) {
          const pick = mentions[mentionIndex % mentions.length] ;
          const start = input.cursor - [...token ].length;
          input.replaceRange(start, [...token ].length, `${pick} `);
          mentionIndex = (mentionIndex + 1) % mentions.length;
          ui.notice =
            mentions.length > 1
              ? `${mentions.length} @ matches. Tab again for the next one.`
              : `Mentioned @${pick}. Content is quoted on send.`;
          draw();
          return;
        }
        mentionIndex = 0;
        const candidates = input.pasting ? [] : commandSuggestions(input.value);
        if (
          candidates.length &&
          ["up", "down", "tab", "return", "enter"].includes(key.name ?? "")
        ) {
          if (key.name === "up" || key.name === "down")
            suggestion =
              (suggestion + (key.name === "up" ? candidates.length - 1 : 1)) %
              candidates.length;
          else {
            input.set(
              candidates[Math.min(suggestion, candidates.length - 1)] [0],
            );
            suggestion = 0;
            if (input.value === "/find") input.set("/find ");
            else if (key.name !== "tab") void task(submit);
          }
          draw();
          return;
        }
        if (
          !input.pasting &&
          (["up", "down"].includes(key.name ?? "") ||
            (key.ctrl && (key.name === "p" || key.name === "n"))) &&
          !(key.ctrl && key.name === "p") &&
          !input.value.includes("\n")
        ) {
          const history = (ui.session()?.events ?? [])
            .filter((e) => e.kind === "user")
            .map((e) => e.text)
            .reverse();
          if (history.length) {
            if (historyIndex < 0) historyDraft = input.value;
            const older = key.name === "up" || (key.ctrl && key.name === "p");
            historyIndex = older
              ? Math.min(history.length - 1, historyIndex + 1)
              : Math.max(-1, historyIndex - 1);
            input.set(historyIndex < 0 ? historyDraft : history[historyIndex] );
            draw();
            return;
          }
        }
        if (!input.pasting && ["pageup", "pagedown"].includes(key.name ?? "")) {
          ui.scrollPage(key.name === "pageup" ? -1 : 1);
          draw();
          return;
        }
        const action = input.key(value, key);
        suggestion = 0;
        historyIndex = -1;
        if (input.pendingCommand !== undefined) {
          const command = input.pendingCommand;
          input.pendingCommand = undefined;
          await ui.command(command);
          draw();
          return;
        }
        if (action === "submit") {
          const text = input.value;
          const plain =
            !text.trimStart().startsWith("/") &&
            !text.trimStart().startsWith("!");
          if (plain && app.running() && text.trim()) {
            ui.queuePrompt(text);
            input.set("");
            historyQuery = "";
            historyPos = -1;
            draw();
            return;
          }
          void task(submit);
        } else scheduleDraft();
        draw();
        return;
      }
      if (busy && key.name !== "tab") return;
      if (
        !input.pasting &&
        !input.editing &&
        ui.tab !== "chat" &&
        (key.name === "home" || key.name === "end")
      ) {
        const end = key.name === "end";
        if (ui.detail && !ui.documentPreview)
          ui.scroll = end
            ? Math.max(0, ui.viewport.total - ui.viewport.height)
            : 0;
        else if (ui.tab === "help")
          ui.scroll = end
            ? Math.max(0, ui.viewport.total - ui.viewport.height)
            : 0;
        else if (ui.groupTree) ui.moveTreeCursorToBoundary(end);
        else ui.selected = end ? Math.max(0, ui.items().length - 1) : 0;
        draw();
        return;
      }
      // Type to filter in list tabs. Bound keys keep their action; every
      // other printable character narrows the list instead of needing /filter.
      const filterChar = !input.pasting
        ? filterKeyForTab(value, key, ui.tab)
        : undefined;
      if (filterChar !== undefined) {
        ui.filter += filterChar;
        ui.selected = 0;
        ui.hoveredRow = undefined;
        ui.detail = undefined;
        ui.documentPreview = false;
        ui.notice = `Filter: ${ui.filter} (Esc clears, Backspace deletes)`;
        draw();
        return;
      }
      if (!input.pasting && key.name === "backspace" && ui.filter) {
        ui.filter = [...ui.filter].slice(0, -1).join("");
        ui.selected = 0;
        ui.hoveredRow = undefined;
        ui.detail = undefined;
        ui.documentPreview = false;
        ui.notice = ui.filter
          ? `Filter: ${ui.filter} (Esc clears, Backspace deletes)`
          : "Filter cleared.";
        draw();
        return;
      }
      if (key.name === "tab") {
        if (ui.tab === "chat") input.editing = true;
      } else if (
        !input.pasting &&
        (key.name === "right" || key.name === "left")
      ) {
        // OMP's tree selector uses Left/Right as page navigation too.
        if (ui.groupTree) {
          ui.moveTreeCursorByPage(
            key.name === "right" ? 1 : -1,
            Math.max(1, ui.viewport.height),
          );
          draw();
        }
      } else if (key.name === "escape") {
        // A focused detail closes before its underlying list filter, matching
        // selector cancellation precedence while preserving the filtered rows.
        if (ui.detail) {
          ui.detail = undefined;
          ui.documentPreview = false;
          ui.scroll = 0;
          input.editing = chatComposerOwnsFocus();
          lastEsc = 0;
          draw();
          return;
        }
        // An active filter clears after a focused detail, before checkpoints.
        if (ui.filter) {
          ui.filter = "";
          ui.selected = 0;
          lastEsc = 0;
          ui.notice = "Filter cleared.";
          draw();
          return;
        }
        if (ui.tab !== "chat") {
          ui.choose("chat");
          input.editing = chatComposerOwnsFocus();
          lastEsc = 0;
          ui.notice = "Returned to Chat.";
          draw();
          return;
        }
        const now = Date.now();
        if (isDoubleEscape(now, lastEsc)) {
          lastEsc = 0;
          // Text in the box clears first, empty input opens checkpoints.
          if (input.value) {
            input.set("");
            suggestion = 0;
            try {
              saveDraft();
            } catch (error) {
              ui.notice = message(error);
            }
            ui.notice = "Cleared. The draft stays saved.";
          } else void task(() => ui.command("/rewind"));
        } else {
          lastEsc = now;
          ui.detail = undefined;
          ui.scroll = 0;
        }
      } else if (
        (key.name === "return" && (ui.tab === "chat" || !ui.diffView)) ||
        (key.name === "enter" && ui.tab !== "chat" && !ui.diffView)
      ) {
        if (ui.groupTree && ui.tab !== "chat") {
          if (ui.activateTreeCursor() === "row")
            void task(() => navigate(() => ui.openSelected()));
          else draw();
        } else void task(() => navigate(() => ui.openSelected()));
      } else if (key.name === "pageup" || key.name === "pagedown") {
        const direction = key.name === "pageup" ? -1 : 1;
        if (ui.groupTree && (!ui.detail || ui.documentPreview)) {
          ui.moveTreeCursorByPage(direction, Math.max(1, ui.viewport.height));
        } else if (
          ui.tab === "chat" ||
          ui.tab === "help" ||
          ui.detail ||
          ui.diffView
        ) {
          ui.scrollPage(direction);
        } else {
          const pageSize = Math.max(1, ui.viewport.height);
          const last = Math.max(0, ui.items().length - 1);
          ui.selected = Math.max(
            0,
            Math.min(last, ui.selected + direction * pageSize),
          );
        }
      } else if (value === "{" || value === "}") {
        const target = nextPromptRow(
          ui.promptRows,
          ui.viewport.offset,
          value === "}" ? 1 : -1,
        );
        if (target < 0) ui.notice = "No further prompt in this direction.";
        else ui.scroll = target;
      } else if (key.name === "up" || (key.ctrl && key.name === "p")) {
        if (ui.tab === "documents" && ui.groupTree && ui.documentPreview)
          ui.moveTreeCursor(-1);
        else if (ui.detail) ui.scroll = Math.max(0, ui.scroll - 1);
        else if (ui.tab === "help")
          ui.scroll = Math.max(
            0,
            Math.min(
              Math.max(0, ui.viewport.total - ui.viewport.height),
              ui.scroll - 1,
            ),
          );
        else if (ui.tab !== "chat" && !ui.moveTreeCursor(-1) && !ui.groupTree)
          ui.selected = ui.items().length
            ? (ui.selected - 1 + ui.items().length) % ui.items().length
            : 0;
      } else if (key.name === "down" || (key.ctrl && key.name === "n")) {
        if (ui.tab === "documents" && ui.groupTree && ui.documentPreview)
          ui.moveTreeCursor(1);
        else if (ui.detail) ui.scroll++;
        else if (ui.tab === "help")
          ui.scroll = Math.max(
            0,
            Math.min(
              Math.max(0, ui.viewport.total - ui.viewport.height),
              ui.scroll + 1,
            ),
          );
        else if (ui.tab !== "chat" && !ui.moveTreeCursor(1) && !ui.groupTree)
          ui.selected = ui.items().length
            ? (ui.selected + 1) % ui.items().length
            : 0;
      }
      draw();
    };
    const onMouse = (event                     ) => {
      const point = {
        x: Math.max(0, event.x - 1),
        y: Math.max(0, event.y - 1),
      };
      if (event.motion) {
        if (selectionDragging && mouseSelection) {
          mouseSelection = { ...mouseSelection, focus: point };
          draw();
          return;
        }
        const rowTarget = ui.rowHitTargets.find(
          (item) =>
            item.row === event.y &&
            event.x >= item.start &&
            event.x <= item.end,
        );
        const hoveredRow = rowTarget
          ? { kind: rowTarget.kind, index: rowTarget.index }
          : undefined;
        if (
          ui.hoveredRow?.kind !== hoveredRow?.kind ||
          ui.hoveredRow?.index !== hoveredRow?.index
        ) {
          ui.hoveredRow = hoveredRow;
          draw();
        }
        return;
      }
      const button = event.button & -33;
      if (!event.pressed) {
        if (selectionDragging && mouseSelection) {
          const moved =
            mouseSelection.anchor.x !== point.x ||
            mouseSelection.anchor.y !== point.y;
          mouseSelection = moved
            ? { ...mouseSelection, focus: point }
            : undefined;
          selectionDragging = false;
          const selectedText =
            moved && mouseSelection
              ? selectedMouseText(
                  renderedFrame,
                  mouseSelection.anchor,
                  mouseSelection.focus,
                  terminal.columns,
                )
              : "";
          draw();
          if (selectedText.length > 0) {
            void copyTextToClipboard(selectedText)
              .then(() => {
                ui.notice = "Selection copied to clipboard.";
              })
              .catch((error) => {
                ui.notice = message(error);
              })
              .finally(draw);
          }
        }
        return;
      }
      if (button === 64 || button === 65) {
        lastMouseClick = undefined;
        // SGR wheel reports use button 64/65 for up/down.
        if (ui.modelPicker?.open) {
          const picker = ui.modelPicker;
          const delta = button === 64 ? -1 : 1;
          const columns = Math.max(1, (ui.viewport.width ?? 80) - 4);
          const wide = columns >= 88;
          const sidebarWidth = wide
            ? Math.min(28, Math.max(20, Math.floor(columns * 0.27)))
            : 0;
          const pane = wide
            ? event.x <= sidebarWidth + 4
              ? "providers"
              : "models"
            : picker.focusedPane;
          const visibleRows = Math.max(1, ui.viewport.height - (wide ? 2 : 5));
          const rows =
            pane === "providers"
              ? picker.providers
              : modelPickerMatches(picker.models, picker.query);
          const selected =
            pane === "providers" ? picker.providerIndex : picker.selected;
          const field =
            pane === "providers" ? "providerWindowStart" : "modelWindowStart";
          const currentStart = modelPickerWindowStart(
            selected,
            rows.length,
            visibleRows,
            picker[field],
          );
          const nextStart = modelPickerWindowStart(
            selected,
            rows.length,
            visibleRows,
            currentStart + delta,
          );
          ui.modelPicker = {
            ...picker,
            [field]: nextStart,
          };
          draw();
          return;
        }
        const delta = button === 64 ? -1 : 1;
        if (ui.settingsOpen) {
          const settingsCount = ui.visibleSettingsControls().length;
          ui.selectSetting(
            Math.max(
              0,
              Math.min(settingsCount - 1, ui.settingsSelected + delta * 3),
            ),
          );
        } else if (ui.detail) ui.scroll = Math.max(0, ui.scroll + delta * 3);
        else if (ui.tab === "chat") {
          const maxOffset = Math.max(0, ui.viewport.total - ui.viewport.height);
          const current = ui.scroll < 0 ? maxOffset : ui.viewport.offset;
          const next = Math.max(0, Math.min(maxOffset, current + delta * 3));
          ui.scroll = next >= maxOffset ? -1 : next;
        } else if (ui.groupTree) ui.moveTreeCursor(delta);
        else {
          const last = Math.max(0, ui.items().length - 1);
          ui.selected = Math.max(0, Math.min(last, ui.selected + delta));
        }
        draw();
        return;
      }
      if ((button & 3) === 0 && (button & 4) !== 0) {
        lastMouseClick = undefined;
        mouseSelection = { anchor: point, focus: point };
        selectionDragging = true;
        draw();
        return;
      }
      if (button !== 0) {
        lastMouseClick = undefined;
        return;
      }
      const tabTarget = ui.tabHitTargets.find(
        (item) =>
          item.row === event.y && event.x >= item.start && event.x <= item.end,
      );
      const rowTarget = ui.rowHitTargets.find(
        (item) =>
          item.row === event.y && event.x >= item.start && event.x <= item.end,
      );
      const actionableRow =
        rowTarget &&
        !(
          ui.tab === "chat" &&
          !(ui.settingsOpen && rowTarget.kind === "setting") &&
          rowTarget.kind !== "provider" &&
          rowTarget.kind !== "model"
        );
      // Ordinary drags select passive text; interactive rows keep click
      // behavior, while Shift explicitly selects through those hit targets.
      if (!tabTarget && !actionableRow) {
        lastMouseClick = undefined;
        mouseSelection = { anchor: point, focus: point };
        selectionDragging = true;
        draw();
        return;
      }
      mouseSelection = undefined;
      if (tabTarget) {
        const targetKey = `tab:${tabTarget.tab}:${tabTarget.row}`;
        const now = Date.now();
        const doubleClick =
          lastMouseClick?.target === targetKey &&
          now >= lastMouseClick.at &&
          now - lastMouseClick.at <= 450;
        lastMouseClick = doubleClick
          ? undefined
          : { target: targetKey, at: now };
        if (ui.tab === "chat" && tabTarget.tab === "sessions" && !doubleClick) {
          return;
        }
        try {
          saveDraft();
        } catch (error) {
          ui.notice = message(error);
        }
        ui.choose(tabTarget.tab);
        input.editing = chatComposerOwnsFocus();
        draw();
        return;
      }
      if (
        !rowTarget ||
        (ui.tab === "chat" &&
          !(ui.settingsOpen && rowTarget.kind === "setting") &&
          rowTarget.kind !== "provider" &&
          rowTarget.kind !== "model")
      ) {
        lastMouseClick = undefined;
        return;
      }
      const picker = ui.modelPicker;
      const targetIdentity =
        rowTarget.kind === "model" && picker
          ? [
              picker.providerId,
              modelPickerMatches(picker.models, picker.query)[rowTarget.index]
                ?.id,
            ]
          : rowTarget.kind === "provider" && picker
            ? picker.providers[rowTarget.index]?.id
            : rowTarget.index;
      const targetKey = JSON.stringify([
        ui.tab,
        rowTarget.kind,
        targetIdentity,
      ]);
      const now = Date.now();
      const doubleClick =
        lastMouseClick?.target === targetKey &&
        now >= lastMouseClick.at &&
        now - lastMouseClick.at <= 450;
      lastMouseClick = doubleClick ? undefined : { target: targetKey, at: now };
      if (rowTarget.kind === "tree") {
        ui.hoveredRow = { kind: rowTarget.kind, index: rowTarget.index };
        ui.selectTreeCursor(rowTarget.index);
        if (doubleClick && ui.activateTreeCursor() === "row")
          void task(() => navigate(() => ui.openSelected()));
      } else if (rowTarget.kind === "model") {
        ui.hoveredRow = { kind: rowTarget.kind, index: rowTarget.index };
        const picker = ui.modelPicker;
        const matches = picker
          ? modelPickerMatches(picker.models, picker.query)
          : undefined;
        const model = matches?.[rowTarget.index];
        if (!picker || !model) return;
        ui.modelPicker = {
          ...picker,
          selected: rowTarget.index,
          modelWindowStart: modelPickerWindowStart(
            picker.selected,
            matches.length,
            modelPickerVisibleRows(ui),
            picker.modelWindowStart,
          ),
        };
        if (doubleClick)
          void task(async () => {
            await ui.selectModel(model.id);
            input.editing = chatComposerOwnsFocus();
          });
      } else if (rowTarget.kind === "setting") {
        const editing = !!ui.settingsEdit;
        const settingsBefore = JSON.stringify(ui.localSettings());
        const toolActivityHiddenBefore = ui.hideToolActivity;
        ui.hoveredRow = { kind: "setting", index: rowTarget.index };
        ui.selectSetting(rowTarget.index);
        // A single click selects; a double-click applies exactly once.
        if (!editing && doubleClick) ui.activateSetting();
        if (
          settingsBefore !== JSON.stringify(ui.localSettings()) ||
          toolActivityHiddenBefore !== ui.hideToolActivity
        ) {
          try {
            saveDraft();
          } catch (error) {
            ui.notice = message(error);
          }
        }
      } else if (rowTarget.kind === "provider") {
        const picker = ui.modelPicker;
        const provider = picker?.providers[rowTarget.index];
        if (!provider || !ui.modelPicker?.open) return;
        ui.selectModelPickerProvider(rowTarget.index);
        if (doubleClick)
          void task(() => ui.loadModelPickerProvider(provider.id));
      } else {
        ui.hoveredRow = { kind: rowTarget.kind, index: rowTarget.index };
        ui.selected = rowTarget.index;
        void task(() => navigate(() => ui.openSelected()));
      }
      input.editing = false;
      draw();
    };
    process.on("SIGINT", stopOnSigint);
    process.on("SIGTERM", stopOnSigterm);
    process.on("SIGHUP", stopOnSighup);
    process.once("exit", restoreTerminal);
    process.once("uncaughtExceptionMonitor", restoreTerminal);
    terminal.start(
      onKey,
      (text) => {
        if (ui.settingsOpen) {
          ui.insertSettingsText(text);
          draw();
          return;
        }
        if (ui.modelPicker?.open) {
          const picker = ui.modelPicker;
          if (picker.focusedPane !== "models") return;
          const inserted = [
            ...sanitizeText(stripAnsi(text).replace(/[\r\n\t]+/g, " ")),
          ];
          const points = [...picker.query];
          points.splice(picker.cursor, 0, ...inserted);
          const query = points.join("");
          setModelPickerQuery(
            ui,
            picker,
            query,
            picker.cursor + inserted.length,
          );
          draw();
          return;
        }
        input.pasting = true;
        try {
          input.paste(text);
        } finally {
          input.pasting = false;
        }
        try {
          saveDraft();
        } catch (error) {
          ui.notice = message(error);
        }
        draw();
      },
      () => {
        draw();
        scheduleCellPixelMeasurement();
      },
      onMouse,
      { deferDisplay: true },
    );
    const activateTerminal = (
      cellPixels                                               ,
    ) => {
      if (stopped) return;
      if (cellPixels?.height) {
        terminalCapabilities = {
          ...terminalCapabilities,
          cellHeightPixels: cellPixels.height,
        };
      }
      terminal.activate();
      initializingTerminal = false;
      if (ui.localTabIcons)
        terminal.writeGraphics(
          `${kittyTabIconsTransfer(ui.localTabIcons)}${kittyProviderIconTransfer(ui.localTabIcons)}`,
        );
      draw();
    };
    // Measure before the first visible frame so the pixel-based composer
    // height is correct immediately instead of visibly reflowing afterward.
    void terminal
      .measureCellPixels()
      .then(activateTerminal, () => activateTerminal(undefined));
    motionTimer = setInterval(() => {
      if (
        !motion ||
        ui.motionOverride === false ||
        stopped ||
        suspended ||
        (!busy && !app.running())
      )
        return;
      // Motion frames redraw active runs on any panel; provider and ledger
      // refreshes remain on their separate, slower timer.
      draw();
    }, 100);
    timer = setInterval(() => {
      if (refreshing || stopped || suspended) return;
      refreshing = true;
      // Expiring on the same tick as the refresh is what makes a timed toast
      // disappear without a redraw of its own. Nothing is drawn here: draw()
      // runs in the finally below, and a toast that expires without a frame
      // would leave its row behind until the next unrelated event.
      ui.expireToasts();
      // Holds that are closing get announced on the same tick. Waiting for
      // the decision to fail would mean the operator only learns the window
      // closed after pressing the key that would have used it.
      ui.watchHoldsForExpiry();
      void ui
        .refresh()
        .then(async () => {
          const queued = takeReadyQueuedPrompt(ui, {
            workbenchRunning: app.running(),
            hasConfirmation: !!ui.confirmation,
            runnerBusy: busy,
          });
          if (!queued) return;
          busy = true;
          draw();
          try {
            await dispatchQueuedPrompt(
              ui,
              queued,
              () => ui.refresh(),
              (error) => {
                ui.notice = message(error);
              },
            );
          } finally {
            busy = false;
          }
        })
        .catch((e) => {
          // A failed refresh usually means the connector or the provider went
          // away mid run. That is not transient the way a keystroke notice is,
          // so it gets a danger toast that will not expire on its own.
          ui.announce("refresh-failed", "danger", sanitizeText(message(e)));
        })
        .finally(() => {
          refreshing = false;
          draw();
        });
    }, 250);
  });
}


//# sourceURL=packages/cli/src/tui/workspace-runner.ts

export { ChordTracker, DoubleLeftSessionShortcut, WorkspaceInput, dispatchQueuedPrompt, escapeOwnedByOverlay, isToolActivityCycleKey, nextPromptRow, normalizePastedPrompt, runWorkspaceTui, shouldCancelActiveRun, signalQuitAction, takeReadyQueuedPrompt, workspaceShortcut };
