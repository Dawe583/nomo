/**
 * Workspace setup. Creates the local encrypted storage layout and nothing
 * else: no provider is contacted, no model is called, no key is printed.
 * Running it twice is safe and changes nothing the second time.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { LocalStorage } from "../../workbench/src/storage.ts";

export type InitIo = {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
};
export type InitDeps = { readonly env?: Readonly<NodeJS.ProcessEnv> };

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function resolveInitDir(
  argv: readonly string[],
  env: Readonly<NodeJS.ProcessEnv>,
): string {
  let dataDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--data-dir") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--"))
        throw Error("usage: void init [--data-dir PATH]");
      dataDir = value;
      i++;
    } else throw Error("usage: void init [--data-dir PATH]");
  }
  return dataDir === undefined
    ? (env.VOID_DATA_DIR ?? join(env.HOME ?? homedir(), ".void", "workbench"))
    : resolve(dataDir);
}

export async function runInitCommand(
  argv: readonly string[],
  io: InitIo,
  deps: InitDeps = {},
): Promise<number> {
  let dir: string;
  try {
    dir = resolveInitDir(argv, deps.env ?? process.env);
  } catch (error) {
    io.stderr(message(error));
    return 2;
  }
  try {
    if (existsSync(join(dir, "tui", "workspace.key"))) {
      io.stdout(`already initialized: ${dir}`);
      return 0;
    }
    void new LocalStorage(join(dir, "tui"));
    io.stdout(`created: ${dir}`);
    io.stdout("next: run `void tui` to open the workspace");
    io.stdout("next: connect a provider with /connect inside the TUI");
    io.stdout("next: verify the setup with `void doctor`");
    return 0;
  } catch (error) {
    io.stderr(`init failed: ${message(error)}`);
    return 1;
  }
}
