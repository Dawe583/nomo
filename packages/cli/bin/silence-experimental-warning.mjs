// Installed first so it runs before any node:sqlite import transitively loaded
// by the CLI runtime. node:sqlite is still an experimental builtin on this
// engine and emits a two-line ExperimentalWarning to stderr just by being
// imported; the binary's no-stderr contract (help/version/new workspace) would
// otherwise fail. The default warning listeners are cleared first because simply
// adding a no-op listener does not replace them.
for (const listener of process.listeners("warning")) {
  process.removeListener("warning", listener);
}
process.on("warning", () => {});