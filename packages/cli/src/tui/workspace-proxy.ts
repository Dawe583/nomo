import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  loadPending,
  writeDecision,
  type ApprovalRecord,
} from "../../../policy/src/approvals.ts";
import {
  readLedgerEntries,
  verifyChain,
  type PublicKeyLookup,
} from "../../../ledger/src/verify.ts";
import { devKeyDir, retainedKeyProvider } from "../../../ledger/src/sign.ts";
import {
  NO_VERIFICATION_KEY_NOTE,
  resolveVerificationKey,
  verificationKeyNote,
  verificationStatus,
  type VerificationFacts,
} from "../../../ledger/src/verify-key.ts";
import type { JsonlEntry } from "../../../ledger/src/store.ts";

/** Read the existing proxy stores; never instantiate a competing approval broker. */
export class ProxyWorkspace {
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly ledgerDir: string;
  readonly approvalDir: string;
  entries = new Map<string, JsonlEntry[]>();
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
  verificationNote: string | undefined;
  verificationKey: VerificationFacts | undefined;
  verificationStatus = "no verification key";
  holds: ApprovalRecord[] = [];
  errors: string[] = [];
  private checked = 0;
  constructor(env: Readonly<NodeJS.ProcessEnv>) {
    this.env = env;
    const home = env.HOME ?? homedir();
    const base = env.VOID_DATA_DIR ?? join(home, ".void");
    this.ledgerDir = env.VOID_LEDGER_DIR ?? join(base, "ledger");
    this.approvalDir =
      env.VOID_APPROVALS_DIR ??
      join(base, "approvals", env.VOID_WORKSPACE ?? "default");
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
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        }
      },
    }).catch((error: unknown) => {
      this.errors.push(
        `Invalid proxy verification key: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    });
    const publicKey: PublicKeyLookup | undefined = key?.publicKey;
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
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        this.errors.push("Cannot read the proxy ledger.");
    }
    try {
      this.holds = loadPending(this.approvalDir).filter(
        (h) => h.status === "pending" && h.expiresAt > Date.now(),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        this.errors.push("Cannot read proxy approvals.");
    }
  }
  decide(id: string, kind: "approved" | "denied", reason: string) {
    writeDecision(this.approvalDir, id, { kind, by: "tui-operator", reason });
  }
}
