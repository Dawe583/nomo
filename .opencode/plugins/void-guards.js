// VOID project guards for opencode: no secrets in repo, no destructive git ops by agents.
export const VoidGuards = async () => {
  return {
    "tool.execute.before": async (input, output) => {
      const args = output.args ?? {};
      const cmd = typeof args.command === "string" ? args.command : "";
      // Never let agents read raw secret files into context
      if (input.tool === "read") {
        const p = String(args.filePath ?? "");
        if (/(^|[\\/])\.env(\.|$)|auth\.json|TOKEN|SECRET|void-exports/i.test(p) && !p.endsWith(".example")) {
          throw new Error(`VOID guard: do not read secret file ${p}. Names only, never values.`);
        }
      }
      // Never auto force-push / reset shared history (R05 rule: revert commit or recovery PR only)
      if (input.tool === "bash" && /git\s+(push\s+.*--force|reset\s+--hard|push\s+.*-f\b)/.test(cmd)) {
        throw new Error("VOID guard: force-push / hard reset of shared history is refused. Use revert commit or recovery PR.");
      }
    },
  };
};
