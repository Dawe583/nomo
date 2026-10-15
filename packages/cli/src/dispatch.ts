/**
 * Command dispatch for the nomo binary.
 *
 * Lives here rather than in bin/nomo.mjs so the entry point can answer
 * `--help` and `--version` without loading this module. Everything below
 * reaches node:sqlite through the runtime, and an experimental-feature warning
 * on stderr for a help request is noise the operator did not ask for.
 */
import { readFileSync } from "node:fs";
import { runRecoveryCommand } from "./recovery.ts";
import { runAgentCommand } from "./agent.ts";
import { runOperation } from "./operations.ts";
import { runWatchCommand } from "./watch.ts";
import { runApproveCommand, runApprovalsCommand } from "./approve.ts";
import { runDoctorCommand } from "./doctor.ts";
import { runConfigCommand } from "./config.ts";
import { runInitCommand } from "./init.ts";
import { runUpdateCommand } from "./update.ts";
import { runMigrateStateCommand, stateSummary } from "./migrate-state.ts";
import { DATA_DIR_NAME, LEGACY_DATA_DIR_NAME } from "../../ledger/src/paths.ts";
import {
  runClassifyCommand,
  runFeedCommand,
  runReplayCommand,
  runTaintCommand,
  runVerifyCommand,
} from "./index.ts";
import { parseInvocation, type ParsedInvocation } from "./argv.ts";

export function packageVersion(): string {
  const meta = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  if (!meta || typeof meta.version !== "string" || !meta.version)
    throw Error("Package version is missing.");
  return meta.version;
}

/** Any command not wired yet fails loudly rather than pretending to succeed. */
export async function runCommand(
  parsed: ParsedInvocation & { ok: true },
  context: { readonly rawEnv?: Readonly<NodeJS.ProcessEnv> } = {},
): Promise<number> {
  // Commands that take an injected environment resolve through the NOMO-first
  // lookup themselves and are handed the environment as the operator typed
  // it, so a report naming its settings names the spelling that is really in
  // force. Everything else reads the process environment, which the binary
  // normalized once before dispatch.
  const injected = context.rawEnv ?? process.env;
  if (parsed.command === "tui") {
    const { runWorkspaceTui } = await import("./tui/workspace-runner.ts");
    return await runWorkspaceTui(parsed.args);
  }
  if (parsed.command === "recovery")
    return await runRecoveryCommand(parsed.args);
  if (parsed.command === "agent") return await runAgentCommand(parsed.args);
  if (parsed.command === "run") {
    // The proxy entry point is plain JavaScript with no declaration file. It
    // cannot gain one without duplicating its surface, and the command only
    // needs its side effect, so the untyped module is imported for that alone.
    // @ts-expect-error -- no declaration file for the proxy bin
    await import("../../proxy/bin/nomo-proxy.mjs");
    return 0;
  }
  if (["attest", "export", "policy", "metrics"].includes(parsed.command)) {
    return await runOperation(
      parsed.command,
      parsed.args,
      process.env,
      (text) => console.log(text),
      (text) => console.error(text),
    );
  }
  if (parsed.command === "ledger") {
    const [action, ...args] = parsed.args;
    if (action !== "verify")
      throw new Error("usage: nomo ledger verify --ledger <path>");
    return await runVerifyCommand(args, {
      stdout: console.log,
      stderr: console.error,
    });
  }
  if (parsed.command === "watch") return await runWatchCommand(parsed.args);
  if (parsed.command === "classify") {
    return await runClassifyCommand(
      parsed.args,
      (path) => readFileSync(path, "utf8"),
      (line) => console.log(line),
    );
  }
  if (parsed.command === "feed") {
    const code = await runFeedCommand(parsed.args, {
      stdout: (line) => console.log(line),
      stderr: (line) => console.error(line),
    });
    // --follow keeps the process alive on purpose.
    if (!parsed.args.includes("--follow")) return code;
    return code;
  }
  if (parsed.command === "replay") {
    return await runReplayCommand(parsed.args, {
      stdout: (line) => console.log(line),
      stderr: (line) => console.error(line),
      env: injected,
    });
  }
  if (parsed.command === "taint") {
    return await runTaintCommand(parsed.args, {
      stdout: (line) => console.log(line),
      stderr: (line) => console.error(line),
    });
  }
  if (parsed.command === "verify") {
    return await runVerifyCommand(parsed.args, {
      stdout: (line) => console.log(line),
      stderr: (line) => console.error(line),
    });
  }
  if (parsed.command === "doctor") {
    return await runDoctorCommand(
      parsed.args,
      {
        stdout: (line) => console.log(line),
        stderr: (line) => console.error(line),
      },
      { env: injected },
    );
  }
  if (parsed.command === "config") {
    return await runConfigCommand(
      parsed.args,
      {
        stdout: (line) => console.log(line),
        stderr: (line) => console.error(line),
      },
      { env: injected, version: packageVersion() },
    );
  }
  if (parsed.command === "init") {
    return await runInitCommand(
      parsed.args,
      {
        stdout: (line) => console.log(line),
        stderr: (line) => console.error(line),
      },
      { env: injected },
    );
  }
  if (parsed.command === "update") {
    return await runUpdateCommand(
      parsed.args,
      {
        stdout: (line) => console.log(line),
        stderr: (line) => console.error(line),
      },
      // The version comes from the binary's one reader, not from a second
      // parse of the manifest: two readers would drift on the first bump.
      { env: injected, version: packageVersion() },
    );
  }
  if (parsed.command === "approve" || parsed.command === "approvals") {
    const run =
      parsed.command === "approve" ? runApproveCommand : runApprovalsCommand;
    return await run(parsed.args, {
      stdout: (line) => console.log(line),
      stderr: (line) => console.error(line),
      env: injected,
    });
  }
  if (parsed.command === "state") {
    const [action, ...args] = parsed.args;
    const io = {
      stdout: (line: string) => console.log(line),
      stderr: (line: string) => console.error(line),
    };
    if (action === undefined || action === "status") {
      // Report only. Asking where state lives must never be the thing that
      // moves it.
      const state = stateSummary();
      io.stdout(`data directory: ${state.active}`);
      io.stdout(`${LEGACY_DATA_DIR_NAME}: ${state.legacyExists ? "present" : "absent"}`);
      io.stdout(`${DATA_DIR_NAME}: ${state.currentExists ? "present" : "absent"}`);
      if (!state.migrationSafe && state.legacyExists) io.stdout(state.reason);
      return 0;
    }
    if (action !== "migrate") {
      io.stderr("usage: nomo state [status|migrate]");
      return 2;
    }
    return await runMigrateStateCommand(args, io);
  }
  console.error(`${parsed.command} is not runnable yet`);
  return 2;
}
