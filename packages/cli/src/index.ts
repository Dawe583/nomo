/**
 * The void command.
 *
 * The command surface lives in ./argv.ts alone: that module has no imports,
 * so --help and --version never load a database engine, and there is exactly
 * one list to update when a command is added. This barrel re-exports it, and
 * the binary dispatches handlers; terminal views consume the shared
 * workbench rather than owning policy or recovery logic.
 */

export * from "./argv.ts";
export * from "./tui/index.ts";
export * from "./classify.ts";
export * from "./feed.ts";
export * from "./replay.ts";
export * from "./taint.ts";
export * from "./verify.ts";
export * from "./approve.ts";
export * from "./doctor.ts";
export * from "./config.ts";
export * from "./init.ts";
