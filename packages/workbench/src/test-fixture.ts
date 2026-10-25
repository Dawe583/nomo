/**
 * Shared fixtures for tests that construct a `Workbench` directly.
 *
 * The risk this file exists to block: `Workbench` reads its data directory from
 * `env.NOMO_DATA_DIR` and silently falls back to `~/.void/workbench` when that
 * name is absent. A test that misspells it, easy to do while the VOID→NOMO
 * rename is in flight, writes the operator's real keys, sessions and
 * preferences into their home directory, and every assertion still passes,
 * because the assertions describe behaviour that the real store also exhibits.
 * The failure is silent and lands outside the temporary directory.
 *
 * `assertIsolated` turns that into an immediate, local error. The constructor
 * writes `workspace.key` synchronously before any test code runs, so its
 * presence under the temporary root is a cheap and decisive proof that the
 * environment was actually honoured. Every fixture asserts it right after
 * construction, including on restart, where a second construction could
 * otherwise reintroduce the same mistake.
 *
 * Cleanup is registered only after construction and assertion succeed: after
 * hooks run in registration order, and a hook registered before the directory
 * is known could remove a directory that a later write still needs.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workbench } from "./index.ts";
import type { AgentRunner } from "./agent-runners/agent-runner.ts";

/** The minimum of `node:test`'s context that a fixture needs. */
export type FixtureContext = {
  after(fn: () => Promise<void> | void): void;
};

export type FixtureOptions = {
  /**
   * Configure the workbench for the fixture provider. Tests that assert on the
   * unconfigured state, or that configure with their own base URL, pass false
   * and call `app.configure` themselves.
   */
  configure?: boolean;
  baseUrl?: string;
  apiKey?: string;
  /** `mkdtemp` prefix, so a leaked directory is traceable to its test. */
  prefix?: string;
  /**
   * Runs before shutdown. A test that deliberately parks a request mid-flight
   * uses this to release the transport, or `shutdown` waits on the run it made
   * hang.
   */
  beforeShutdown?: () => void | Promise<void>;
  agentRunners?: readonly AgentRunner[];
};

export type WorkbenchFixture = {
  /** The temporary root backing this fixture. */
  readonly root: string;
  /** The live workbench, following `restart`. */
  readonly app: Workbench;
  /**
   * Reopens a workbench over the same root. The previous instance is closed
   * first, unless `keepOpen` says the caller already did so.
   */
  restart(options?: { keepOpen?: boolean }): Workbench;
};

/**
 * Fails unless the workbench actually built its store under `root`. See the
 * file header: this is the assertion that catches an ignored `NOMO_DATA_DIR`
 * at the construction that caused it rather than as a mysterious failure
 * later.
 *
 * `LocalStorage` creates the directory and then writes `workspace.key`, unless
 * an external key was supplied, in which case the key comes from the
 * environment and nothing is written. Both are checked: the directory proves
 * the path was honoured in every case, and the key file is the stronger proof
 * whenever it exists.
 */
export function assertIsolated(
  root: string,
  env: Readonly<NodeJS.ProcessEnv> = {},
): void {
  assert.ok(
    existsSync(root),
    `the fixture workbench did not use the temporary data directory (${root}); ` +
      "an ignored NOMO_DATA_DIR silently writes to the operator's real store",
  );
  if (env.NOMO_WORKSPACE_KEY) return;
  assert.ok(
    existsSync(join(root, "workspace.key")),
    `the fixture workbench wrote no storage key under (${root}); ` +
      "an ignored NOMO_DATA_DIR silently writes to the operator's real store",
  );
}

/**
 * Builds a workbench over a fresh temporary directory, with the assertion
 * above and cleanup registered.
 *
 * `extraEnv` is merged into the same environment object as `NOMO_DATA_DIR`
 * rather than replacing it, so a caller supplying `NOMO_PERMISSION_MODE` or
 * `NOMO_POLICY_PATH` cannot accidentally drop the data directory.
 *
 * A caller naming `NOMO_DATA_DIR` in `extraEnv` loses that name: see the merge
 * below. A fixture that let a test redirect its own store would leave
 * `assertIsolated` checking a directory nobody wrote to, which is the one
 * outcome this file exists to rule out.
 */
export async function isolatedWorkbench(
  t: FixtureContext,
  fetcher?: typeof fetch,
  extraEnv: Record<string, string> = {},
  options: FixtureOptions = {},
): Promise<WorkbenchFixture> {
  const {
    configure = true,
    baseUrl = "https://fixture.test/v1",
    apiKey = "fixture",
    prefix = "void-test-",
    beforeShutdown,
    agentRunners = [],
  } = options;

  const root = await mkdtemp(join(tmpdir(), prefix));
  // One object, so extraEnv can add to the environment but never displace the
  // data directory. `NOMO_DATA_DIR` is written last and last wins, so a caller
  // who names it in `extraEnv` still gets the temporary root. Spreading
  // `extraEnv` first is the whole point of this line: the other order builds a
  // workbench that is silently not the one under test, and points
  // `assertIsolated` at a directory nobody wrote to.
  const env = { ...extraEnv, NOMO_DATA_DIR: root } as NodeJS.ProcessEnv;

  let app = new Workbench(env, fetcher, { agentRunners });
  assertIsolated(root, env);
  if (configure) await app.configure({ baseUrl, apiKey });

  // Registered after the first successful construction so the removal cannot
  // precede the key write it depends on.
  t.after(async () => {
    await beforeShutdown?.();
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });

  return {
    root,
    get app() {
      return app;
    },
    restart({ keepOpen = false }: { keepOpen?: boolean } = {}) {
      if (!keepOpen) app.close();
      app = new Workbench(env, fetcher, { agentRunners });
      assertIsolated(root, env);
      // Configuration is not repeated here. It was persisted by the first
      // `configure` and the constructor reads it back out of the same
      // directory, so re-configuring would only race the assertions that
      // follow against an unawaited write.
      return app;
    },
  };
}