import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  lstatSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { LocalStorage } from "./storage.ts";

const AUTHORIZATION_ENDPOINT = "https://auth.openai.com/api/accounts/authorize";
const LOCK_RETRY_MS = 25;
const LOCK_WAIT_MS = 120_000;
const RESOURCE = "https://api.openai.com/v1";
const SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "resource.invoke",
  "chatgpt.tokens.use.direct",
] as const;

/** Serialize host-wide credential mutations across Workbench processes. */
export async function withOpenAIChatGPTAuthLock<T>(
  path: string,
  action: () => Promise<T>,
): Promise<T> {
  const owner = await acquireAuthLock(path);
  try {
    return await action();
  } finally {
    try {
      if (
        sameFile(owner, lstatSync(path)) &&
        readFileSync(path, "utf8") === String(process.pid)
      ) unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function acquireAuthLock(path: string): Promise<Stats> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      writeFileSync(path, String(process.pid), { flag: "wx", mode: 0o600 });
      return lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let original: Stats;
      let text: string;
      try {
        original = lstatSync(path);
        if (!original.isFile())
          throw new Error("OpenAI account lock has an unknown owner.");
        text = readFileSync(path, "utf8");
      } catch (lockError) {
        if ((lockError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw lockError;
      }
      const pid = /^[1-9][0-9]{0,9}$/.test(text) ? Number(text) : 0;
      if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2_147_483_647)
        throw new Error("OpenAI account lock has an unknown owner.");
      let stale = false;
      try {
        process.kill(pid, 0);
      } catch (ownerError) {
        stale = (ownerError as NodeJS.ErrnoException).code === "ESRCH";
      }
      if (stale) {
        throw new Error("OpenAI account lifecycle lock has a stale owner; stop all NOMO processes and remove the lock to recover.");
      }
      if (Date.now() >= deadline)
        throw new Error("OpenAI account lifecycle is busy in another process.");
      await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
}

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

export type OpenAIChatGPTAccount = {
  readonly id: string;
  readonly clientId: string;
  readonly subject: string;
  readonly email?: string;
  readonly scopes: readonly string[];
  readonly usageEnabled: boolean;
  readonly reauthRequired?: boolean;
  readonly credentialGeneration?: number;
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly expiresAt?: number;
};

export type OpenAIChatGPTAuthState = {
  readonly schemaVersion: 1;
  readonly hostId: string;
  readonly accounts: readonly OpenAIChatGPTAccount[];
  readonly activeAccountId?: string;
};

/** Host-wide encrypted SIWC registrations, independent of workspace data dirs. */
export class OpenAIChatGPTAuthStore {
  private readonly storage: LocalStorage;
  private readonly lockPath: string;

  constructor(directory: string) {
    this.storage = new LocalStorage(directory);
    this.lockPath = join(directory, "accounts.lifecycle.lock");
  }

  read(): OpenAIChatGPTAuthState | undefined {
    const value = this.storage.read<unknown>();
    if (value === undefined) return undefined;
    assertAuthState(value);
    return value;
  }

  async update<T>(
    mutate: (state: OpenAIChatGPTAuthState) => Promise<{
      readonly state: OpenAIChatGPTAuthState;
      readonly result: T;
    }> | {
      readonly state: OpenAIChatGPTAuthState;
      readonly result: T;
    },
  ): Promise<T> {
    return withOpenAIChatGPTAuthLock(this.lockPath, async () => {
      const current = this.read() ?? {
        schemaVersion: 1,
        hostId: randomUUID(),
        accounts: [],
      } satisfies OpenAIChatGPTAuthState;
      const updated = await mutate(current);
      if (updated.state.hostId !== current.hostId)
        throw new Error("OpenAI host identity cannot be changed.");
      assertAuthState(updated.state);
      this.storage.save(updated.state);
      return updated.result;
    });
  }
}

function assertAuthState(value: unknown): asserts value is OpenAIChatGPTAuthState {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("OpenAI account state is invalid.");
  const state = value as Record<string, unknown>;
  if (
    state.schemaVersion !== 1 ||
    typeof state.hostId !== "string" ||
    !state.hostId.trim() ||
    !Array.isArray(state.accounts) ||
    (state.activeAccountId !== undefined && typeof state.activeAccountId !== "string")
  ) throw new Error("OpenAI account state is invalid.");
  const ids = new Set<string>();
  const clients = new Set<string>();
  for (const value of state.accounts) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("OpenAI account state is invalid.");
    const account = value as Record<string, unknown>;
    if (
      typeof account.id !== "string" || !account.id || ids.has(account.id) ||
      typeof account.clientId !== "string" || !account.clientId || clients.has(account.clientId) ||
      typeof account.subject !== "string" || !account.subject ||
      (account.email !== undefined && typeof account.email !== "string") ||
      !Array.isArray(account.scopes) ||
      !account.scopes.every(scope => typeof scope === "string") ||
      typeof account.usageEnabled !== "boolean" ||
      (account.reauthRequired !== undefined && typeof account.reauthRequired !== "boolean") ||
      (account.credentialGeneration !== undefined &&
        (typeof account.credentialGeneration !== "number" ||
          !Number.isSafeInteger(account.credentialGeneration) || account.credentialGeneration < 0))
    ) throw new Error("OpenAI account state is invalid.");
    if (
      (account.accessToken !== undefined &&
        (typeof account.accessToken !== "string" || !account.accessToken)) ||
      (account.refreshToken !== undefined &&
        (typeof account.refreshToken !== "string" || !account.refreshToken)) ||
      (account.expiresAt !== undefined &&
        (typeof account.expiresAt !== "number" || !Number.isFinite(account.expiresAt))) ||
      ((account.accessToken === undefined) !== (account.expiresAt === undefined)) ||
      (account.refreshToken !== undefined && account.accessToken === undefined) ||
      (account.usageEnabled && (
        !account.scopes.includes("resource.invoke") ||
        !account.scopes.includes("chatgpt.tokens.use.direct") ||
        account.accessToken === undefined
      ))
    ) throw new Error("OpenAI account state is invalid.");
    ids.add(account.id);
    clients.add(account.clientId);
  }
  if (
    state.activeAccountId !== undefined &&
    !ids.has(state.activeAccountId)
  ) throw new Error("OpenAI account state is invalid.");
}

export type OpenAIChatGPTAuthorizeInput = {
  readonly hostId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly nonce: string;
  readonly codeChallenge: string;
  readonly clientId?: string;
  readonly agentNameHint?: string;
  readonly promptConsent?: boolean;
};

/** Build the public SIWC authorization request without account/token hints. */
export function buildOpenAIChatGPTAuthorizeUrl(
  input: OpenAIChatGPTAuthorizeInput,
): URL {
  const redirect = new URL(input.redirectUri);
  if (
    redirect.protocol !== "http:" ||
    redirect.hostname !== "127.0.0.1" ||
    !redirect.port ||
    redirect.pathname !== "/auth/callback" ||
    redirect.username ||
    redirect.password ||
    redirect.search ||
    redirect.hash
  ) {
    throw new Error("Sign in requires the exact 127.0.0.1 loopback callback URI.");
  }
  for (const [name, value] of Object.entries({
    hostId: input.hostId,
    state: input.state,
    nonce: input.nonce,
    codeChallenge: input.codeChallenge,
  })) {
    if (!value.trim()) throw new Error(`Sign in ${name} must not be empty.`);
  }
  if (input.clientId !== undefined && !input.clientId.trim())
    throw new Error("Sign in client ID must not be empty.");
  if (input.clientId === undefined && !input.agentNameHint?.trim())
    throw new Error("First sign in requires the application name.");

  const authorization = new URL(AUTHORIZATION_ENDPOINT);
  authorization.searchParams.set(
    "client_id",
    input.clientId ?? "dynamic_agent_client",
  );
  if (input.clientId === undefined)
    authorization.searchParams.set("agent_name_hint", input.agentNameHint!);
  authorization.searchParams.set("ext_agent_host_id", input.hostId);
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set("redirect_uri", redirect.toString());
  authorization.searchParams.set("scope", SCOPES.join(" "));
  authorization.searchParams.set("resource", RESOURCE);
  authorization.searchParams.set("state", input.state);
  authorization.searchParams.set("nonce", input.nonce);
  authorization.searchParams.set("code_challenge_method", "S256");
  authorization.searchParams.set("code_challenge", input.codeChallenge);
  if (input.promptConsent) {
    if (input.clientId === undefined)
      throw new Error("Consent prompt requires an issued client ID.");
    authorization.searchParams.set("prompt", "consent");
  }
  return authorization;
}
