import { readdir, readFile } from "node:fs/promises";
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
import { keyProviderFromPkcs8 } from "../../../ledger/src/sign.ts";
import type { JsonlEntry } from "../../../ledger/src/store.ts";

/** Read the existing proxy stores; never instantiate a competing approval broker. */
export class ProxyWorkspace {
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly ledgerDir: string;
  readonly approvalDir: string;
  entries = new Map<string, JsonlEntry[]>();
  signed = false;
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
    let publicKey: PublicKeyLookup | undefined;
    try {
      if (this.env.VOID_VERIFY_KEY)
        publicKey = new Uint8Array(
          Buffer.from(this.env.VOID_VERIFY_KEY, "base64"),
        );
      else {
        const bytes = this.env.VOID_SIGNING_KEY
          ? Buffer.from(this.env.VOID_SIGNING_KEY, "base64")
          : await readFile(
              join(
                this.env.HOME ?? homedir(),
                ".void",
                "keys",
                "dev-ed25519.pkcs8",
              ),
            );
        const signer = keyProviderFromPkcs8(bytes);
        publicKey = (id) => signer.publicKey(id);
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        this.errors.push("Invalid proxy verification key.");
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
