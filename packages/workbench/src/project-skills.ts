import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const PROJECT_SKILL_LIMITS = {
  count: 8,
  fileBytes: 32_768,
  totalBytes: 131_072,
  lockBytes: 131_072,
} as const;

export type ProjectSkillSnapshot = {
  readonly id: string;
  readonly path: string;
  readonly lockedHash: string;
  readonly actualHash: string;
  readonly drifted: boolean;
  readonly content: string;
};

type LockEntry = {
  readonly skillPath: string;
  readonly computedHash: string;
};

function parseLock(value: unknown): { readonly skills: Readonly<Record<string, unknown>> } {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Unsupported workspace skills lock: expected a JSON object.");
  const candidate = value as { readonly version?: unknown; readonly skills?: unknown };
  if (candidate.version !== 1)
    throw new Error(`Unsupported workspace skills lock: version must be 1, got ${JSON.stringify(candidate.version)}.`);
  if (candidate.skills === null || typeof candidate.skills !== "object" || Array.isArray(candidate.skills))
    throw new Error(`Unsupported workspace skills lock: skills must be an object, got ${JSON.stringify(typeof candidate.skills)}.`);
  return {
    skills: candidate.skills as Readonly<Record<string, unknown>>,
  };
}

function lockEntry(value: unknown, id: string): LockEntry {
  if (value === undefined)
    throw new Error(`Skill ${id} is not present in the workspace lock.`);
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid lock entry for skill ${id}.`);
  const candidate = value as {
    readonly skillPath?: unknown;
    readonly computedHash?: unknown;
  };
  const skillPath = candidate.skillPath;
  const computedHash = candidate.computedHash;
  if (
    typeof skillPath !== "string" ||
    skillPath !== `skills/${id}/SKILL.md` ||
    isAbsolute(skillPath) ||
    typeof computedHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(computedHash)
  )
    throw new Error(`Invalid skill path or digest in workspace lock for ${id}.`);
  return { skillPath, computedHash };
}

async function regularFile(path: string, maxBytes: number, label: string) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile())
    throw new Error(`${label} must be a regular file, not a symlink.`);
  if (info.size > maxBytes) throw new Error(`${label} exceeds its size limit.`);
  return info;
}

/** Read only explicitly selected, lock-listed skills from this project. */
export async function readProjectSkills(
  projectRoot: string,
  ids: readonly string[],
): Promise<ProjectSkillSnapshot[]> {
  if (ids.length === 0) return [];
  if (ids.length > PROJECT_SKILL_LIMITS.count)
    throw new Error(`Select at most ${PROJECT_SKILL_LIMITS.count} workspace skills.`);
  const seen = new Set<string>();
  for (const id of ids) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id))
      throw new Error("Invalid workspace skill ID.");
    if (seen.has(id)) throw new Error(`Duplicate workspace skill ${id}.`);
    seen.add(id);
  }

  const root = await realpath(projectRoot);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory()) throw new Error("Project root must be a directory.");
  const lockPath = resolve(root, "skills-lock.json");
  await regularFile(lockPath, PROJECT_SKILL_LIMITS.lockBytes, "Workspace skill lock");
  let lock: unknown;
  try {
    lock = JSON.parse(await readFile(lockPath, "utf8"));
  } catch {
    throw new Error("Workspace skills lock is unreadable or invalid JSON.");
  }
  const lockSkills = parseLock(lock).skills;

  const agentsRoot = resolve(root, ".agents");
  const agentsInfo = await lstat(agentsRoot);
  if (agentsInfo.isSymbolicLink() || !agentsInfo.isDirectory())
    throw new Error("Workspace .agents must be a real directory.");
  const canonicalAgents = await realpath(agentsRoot);
  if (canonicalAgents !== agentsRoot)
    throw new Error("Workspace .agents resolves outside the project.");

  const snapshots: ProjectSkillSnapshot[] = [];
  let totalBytes = 0;
  for (const id of ids) {
    const entry = lockEntry(lockSkills[id], id);
    const path = resolve(agentsRoot, entry.skillPath);
    const pathFromRoot = relative(agentsRoot, path);
    if (
      pathFromRoot.startsWith(`..${sep}`) ||
      pathFromRoot === ".." ||
      isAbsolute(pathFromRoot)
    )
      throw new Error(`Skill path for ${id} escapes the workspace.`);

    const skillDirectory = resolve(agentsRoot, "skills", id);
    const skillsDirectory = resolve(agentsRoot, "skills");
    for (const [directory, label] of [
      [skillsDirectory, "Workspace skills directory"],
      [skillDirectory, `Skill directory ${id}`],
    ] as const) {
      const info = await lstat(directory);
      if (info.isSymbolicLink() || !info.isDirectory())
        throw new Error(`${label} must be a real directory.`);
    }

    const info = await regularFile(path, PROJECT_SKILL_LIMITS.fileBytes, `Skill ${id}`);
    const canonicalPath = await realpath(path);
    const canonicalRelative = relative(canonicalAgents, canonicalPath);
    if (
      canonicalRelative.startsWith(`..${sep}`) ||
      canonicalRelative === ".." ||
      isAbsolute(canonicalRelative)
    )
      throw new Error(`Skill ${id} resolves outside the project.`);
    const bytes = await readFile(path);
    if (bytes.byteLength > PROJECT_SKILL_LIMITS.fileBytes || bytes.byteLength !== info.size)
      throw new Error(`Skill ${id} changed while it was being read or exceeds its size limit.`);
    const content = bytes.toString("utf8");
    if (
      !Buffer.from(content, "utf8").equals(bytes) ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(content)
    )
      throw new Error(`Skill ${id} must be valid UTF-8 Markdown without control characters.`);
    totalBytes += bytes.byteLength;
    if (totalBytes > PROJECT_SKILL_LIMITS.totalBytes)
      throw new Error("Selected workspace skills exceed their aggregate size limit.");
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    snapshots.push({
      id,
      path: `.agents/${entry.skillPath}`,
      lockedHash: entry.computedHash,
      actualHash,
      drifted: actualHash !== entry.computedHash,
      content,
    });
  }
  return snapshots;
}
