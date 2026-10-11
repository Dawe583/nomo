import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workbench } from "./index.ts";

/**
 * Direct construction is the boundary this file is about: a caller that holds a
 * process environment, hands it to the Workbench, and expects the product to
 * behave the way it did before the rename.
 *
 * Everything here asserts through the public surface. What a setting resolves
 * to is proved by what the Workbench then does, not by reading a private field
 * back, because a private read would keep passing if the setting stopped being
 * consulted at all.
 */
const withRoot = async (t: TestContext): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "nomo-wb-env-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
};

const exists = async (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

test("a legacy data directory is where the workbench writes its state", async (t) => {
  const root = await withRoot(t);
  const target = join(root, "legacy-wb");
  const app = new Workbench({ VOID_DATA_DIR: target } as NodeJS.ProcessEnv);
  try {
    app.patchPreferences({ theme: "dark" });
    assert.equal(await exists(join(target, "workspace.enc")), true);
  } finally {
    app.close();
  }
});

test("a current data directory still wins over a legacy one", async (t) => {
  const root = await withRoot(t);
  const current = join(root, "current");
  const app = new Workbench({
    NOMO_DATA_DIR: current,
    VOID_DATA_DIR: join(root, "legacy"),
  } as NodeJS.ProcessEnv);
  try {
    app.patchPreferences({ theme: "dark" });
    assert.equal(await exists(join(current, "workspace.enc")), true);
    assert.equal(await exists(join(root, "legacy")), false);
  } finally {
    app.close();
  }
});

test("a legacy permission mode is the mode that is enforced", async (t) => {
  const root = await withRoot(t);
  const app = new Workbench({
    NOMO_DATA_DIR: join(root, "wb"),
    VOID_PERMISSION_MODE: "plan",
  } as NodeJS.ProcessEnv);
  try {
    assert.equal(app.permissionModeState(), "plan");
  } finally {
    app.close();
  }
});

test("the current permission mode wins over the legacy one", async (t) => {
  const root = await withRoot(t);
  const app = new Workbench({
    NOMO_DATA_DIR: join(root, "wb"),
    NOMO_PERMISSION_MODE: "plan",
    VOID_PERMISSION_MODE: "normal",
  } as NodeJS.ProcessEnv);
  try {
    assert.equal(app.permissionModeState(), "plan");
  } finally {
    app.close();
  }
});

test("an unknown mode under either spelling narrows to read-only", async (t) => {
  const root = await withRoot(t);
  // "allow" is not a mode the server issues. Naming it must not produce
  // `normal`, which is the unrestricted local mode.
  for (const env of [{ VOID_PERMISSION_MODE: "allow" }, { NOMO_PERMISSION_MODE: "allow" }]) {
    const app = new Workbench({
      NOMO_DATA_DIR: join(root, "wb"),
      ...env,
    } as NodeJS.ProcessEnv);
    try {
      assert.equal(app.permissionModeState(), "read-only");
    } finally {
      app.close();
    }
  }
});

test("an explicitly empty mode is not replaced by the legacy one", async (t) => {
  const root = await withRoot(t);
  const app = new Workbench({
    NOMO_DATA_DIR: join(root, "wb"),
    NOMO_PERMISSION_MODE: "",
    VOID_PERMISSION_MODE: "normal",
  } as NodeJS.ProcessEnv);
  try {
    // Falling back would run with a setting nobody typed, and here the one
    // nobody typed is the widest mode there is.
    assert.equal(app.permissionModeState(), "read-only");
  } finally {
    app.close();
  }
});

test("a legacy hook allowlist is what the hook editor checks against", async (t) => {
  const root = await withRoot(t);
  const app = new Workbench({
    NOMO_DATA_DIR: join(root, "wb"),
    VOID_HOOK_COMMANDS: '["shell.run"]',
  } as NodeJS.ProcessEnv);
  try {
    assert.deepEqual(app.agents().hookCommands, ["shell.run"]);
    assert.equal(app.agents().hooksSupported, true);
    // The accepted one is the sharper signal: an empty allowlist refuses
    // everything, so only an acceptance proves the legacy list was read.
    assert.doesNotThrow(() =>
      app.upsertHook({ id: "h1", command: "shell.run", event: "before-run", enabled: true }),
    );
    assert.throws(
      () => app.upsertHook({ id: "h2", command: "not.on.allowlist", event: "before-run", enabled: true }),
      /operator allowlist/,
    );
  } finally {
    app.close();
  }
});

test("the current hook allowlist wins over the legacy one", async (t) => {
  const root = await withRoot(t);
  const app = new Workbench({
    NOMO_DATA_DIR: join(root, "wb"),
    NOMO_HOOK_COMMANDS: '["shell.run"]',
    VOID_HOOK_COMMANDS: '["shell.run","git.status"]',
  } as NodeJS.ProcessEnv);
  try {
    assert.deepEqual(app.agents().hookCommands, ["shell.run"]);
  } finally {
    app.close();
  }
});

test("a legacy hook allowlist is still validated as strictly", async (t) => {
  const root = await withRoot(t);
  assert.throws(
    () =>
      new Workbench({
        NOMO_DATA_DIR: join(root, "wb"),
        VOID_HOOK_COMMANDS: "[1,2]",
      } as NodeJS.ProcessEnv),
    /Configure NOMO_HOOK_COMMANDS/,
  );
});

test("a legacy workspace key selects keychain storage and is never retained", async (t) => {
  const root = await withRoot(t);
  const app = new Workbench({
    NOMO_DATA_DIR: join(root, "wb"),
    VOID_WORKSPACE_KEY: Buffer.from("synthetic-passphrase").toString("base64"),
  } as NodeJS.ProcessEnv);
  try {
    assert.equal(app.keyStorageState(), "os-keychain");
  } finally {
    app.close();
  }
});

test("the current workspace key wins over the legacy one", async (t) => {
  const root = await withRoot(t);
  const app = new Workbench({
    NOMO_DATA_DIR: join(root, "wb"),
    NOMO_WORKSPACE_KEY: Buffer.from("current-passphrase").toString("base64"),
    VOID_WORKSPACE_KEY: Buffer.from("legacy-passphrase").toString("base64"),
  } as NodeJS.ProcessEnv);
  try {
    assert.equal(app.keyStorageState(), "os-keychain");
  } finally {
    app.close();
  }
});

test("no workspace key under either spelling keeps encrypted local storage", async (t) => {
  const root = await withRoot(t);
  const app = new Workbench({ NOMO_DATA_DIR: join(root, "wb") } as NodeJS.ProcessEnv);
  try {
    assert.equal(app.keyStorageState(), "encrypted-local");
  } finally {
    app.close();
  }
});

test("an unrelated variable is never aliased", async (t) => {
  const root = await withRoot(t);
  const app = new Workbench({
    NOMO_DATA_DIR: join(root, "wb"),
    HOME: join(root, "home"),
    VOID_HOME: join(root, "not-ours"),
  } as NodeJS.ProcessEnv);
  try {
    app.patchPreferences({ theme: "dark" });
    assert.equal(await exists(join(root, "home")), false);
  } finally {
    app.close();
  }
});

test("the input environment handed to the Workbench is never written to", async (t) => {
  const root = await withRoot(t);
  const env: NodeJS.ProcessEnv = {
    NOMO_DATA_DIR: join(root, "wb"),
    VOID_DATA_DIR: join(root, "legacy"),
  };
  const snapshot = { ...env };
  const app = new Workbench(env);
  try {
    assert.deepEqual(env, snapshot);
  } finally {
    app.close();
  }
});