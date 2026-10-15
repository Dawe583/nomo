import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The product data directory, and the legacy one it replaces.
 *
 * `DATA_DIR_NAME` is where NOMO keeps its state. `LEGACY_DATA_DIR_NAME` is
 * where the product kept it before the rename, and it is still read: a machine
 * that installed the old name has real ledgers, signing keys and a trust anchor
 * there, and silently starting a second empty tree beside them would look like
 * data loss while losing nothing on disk.
 *
 * Nothing is copied and nothing is moved by this module. The legacy tree keeps
 * being used until the operator migrates it explicitly, at which point this
 * resolver stops finding it and the new name takes over on its own.
 */
export const DATA_DIR_NAME = ".nomo";
export const LEGACY_DATA_DIR_NAME = ".void";

/**
 * Resolve the product data directory for `home`.
 *
 * The new name wins whenever it exists. The legacy name is used only when the
 * new one is absent and the old one is present, which is exactly the state of a
 * machine that installed before the rename and has not migrated its state yet.
 * With neither present the new name is returned, because an operator with no
 * state has nothing to preserve and should get the current default.
 *
 * Every surface derives its default from here. Two copies of this path would be
 * the same class of defect as two signing-key derivations: the writer and the
 * reader would disagree about where state lives, and each would report the
 * other's directory as empty.
 */
export function dataDir(home: string = homedir()): string {
  const current = join(home, DATA_DIR_NAME);
  if (existsSync(current)) return current;
  const legacy = join(home, LEGACY_DATA_DIR_NAME);
  return existsSync(legacy) ? legacy : current;
}

export type StateDescription = {
  readonly home: string;
  readonly current: string;
  readonly legacy: string;
  readonly active: string;
  readonly currentExists: boolean;
  readonly legacyExists: boolean;
  /**
   * Whether copying the legacy tree into the current name is unambiguous.
   *
   * It is true only when the current tree is absent. A current tree that
   * exists is refused whatever it holds, because an operator who already
   * migrated and then re-ran the command would otherwise have the newest state
   * silently replaced by whatever the old name still contained.
   */
  readonly migrationSafe: boolean;
  readonly reason: string;
};

const isEmptyDirectory = (path: string): boolean =>
  readdirSync(path).length === 0;

const nonEmpty = (path: string): boolean =>
  existsSync(path) && statSync(path).isDirectory() && !isEmptyDirectory(path);

/**
 * Report where state lives for `home`, and whether an explicit migration is
 * unambiguous.
 *
 * The refusal is the point. Two directories holding different state is the one
 * situation where a copy has to choose, and a tool that picks for an operator
 * picks silently. Saying which directory is in force, and why the other cannot
 * be written, is more useful than a migration that ran.
 */
export function describeState(home: string = homedir()): StateDescription {
  const current = join(home, DATA_DIR_NAME);
  const legacy = join(home, LEGACY_DATA_DIR_NAME);
  const currentExists = existsSync(current);
  const legacyExists = existsSync(legacy);

  const base = {
    home,
    current,
    legacy,
    // Derived from `dataDir` rather than re-decided here: two answers to
    // "which directory is in force" is the defect this module exists to avoid.
    active: dataDir(home),
    currentExists,
    legacyExists,
  };

  if (!legacyExists)
    return {
      ...base,
      migrationSafe: false,
      reason: `No legacy ${LEGACY_DATA_DIR_NAME} directory in ${home}. Nothing to migrate.`,
    };
  if (currentExists)
    return {
      ...base,
      migrationSafe: false,
      reason: `${DATA_DIR_NAME} already exists in ${home}${
        nonEmpty(current)
          ? " and holds state of its own, so the two directories may differ"
          : ""
      }. This refuses rather than overwriting either one. Merge them by hand, or remove the empty ${DATA_DIR_NAME} and run again.`,
    };
  return {
    ...base,
    migrationSafe: true,
    reason: `Legacy state found at ${legacy}. Nothing at ${current}.`,
  };
}