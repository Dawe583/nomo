import { homedir } from "node:os";
import { join } from "node:path";
import { LocalStorage } from "./storage.ts";
import { TOKENHARBOR_URL } from "./provider-defaults.ts";
import type { Workbench } from "./index.ts";

/** An unverified key stays separate from the active provider and session snapshots. */
export function tokenHarborSetup(
  env: Readonly<NodeJS.ProcessEnv> = process.env,
) {
  const directory =
    env.VOID_DATA_DIR ??
    join(env.VOID_LEDGER_DIR ?? join(homedir(), ".void"), "workbench");
  return new LocalStorage(join(directory, "provider-setup"));
}

export function stageTokenHarborKey(
  apiKey: string,
  env: Readonly<NodeJS.ProcessEnv> = process.env,
) {
  if (!apiKey.trim()) throw new Error("Token Harbor key is required.");
  const store = tokenHarborSetup(env);
  store.read();
  store.save({ tokenharbor: apiKey.trim() });
}

export async function connectTokenHarbor(
  app: Workbench,
  env: Readonly<NodeJS.ProcessEnv> = process.env,
) {
  const apiKey =
    env.TOKENHARBOR_API_KEY ??
    tokenHarborSetup(env).read<{ tokenharbor?: string }>()?.tokenharbor;
  // An empty key lets Workbench reuse an already validated encrypted profile.
  await app.configure({ baseUrl: TOKENHARBOR_URL, apiKey: apiKey ?? "" });
  return app.providerState();
}
