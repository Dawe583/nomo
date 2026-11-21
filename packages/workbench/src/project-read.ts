/**
 * Read and search over the filtered project copy (HP8).
 *
 * Both tools answer from `workspace.source` only. The host project, the
 * protected `control` metadata and the `baseline` copy are never opened, so a
 * model call cannot see a file the copy refused or an original the operator
 * has not approved for editing. Nothing here writes: the copy is changed only
 * through `nomo_project_exec` in the container and reviewed by
 * `nomo_project_changes`.
 *
 * Path validation is not reimplemented. `isAllowedProjectWorkspacePath` and
 * `readRegularProjectFile` are the functions the copy itself uses, so a path
 * that could not enter the copy cannot be read from it either: traversal,
 * absolute paths, backslashes, control characters, protected directories and
 * symlinked parents are refused by the same code that refused them during
 * preparation. Files added to the copy after preparation are readable because
 * the tools ask the filesystem, not the manifest.
 *
 * Every result is JSON the caller hands to a model, so it is bounded by
 * `PROJECT_SANDBOX_LIMITS.outputBytes` after escaping, not before. A result
 * that would exceed the bound is cut and says so, because a model that sees a
 * silently shortened file or match list would conclude the copy ends there.
 *
 * A search phrase is one literal substring, case sensitive. A pattern
 * language or a shell would be a surface for probing text the model was not
 * given, and a literal substring needs neither.
 */
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { PROJECT_SANDBOX_LIMITS } from "./project-sandbox.ts";
import {
  isAllowedProjectWorkspacePath,
  PROJECT_WORKSPACE_LIMITS,
  readRegularProjectFile,
  type ProjectWorkspace,
} from "./project-workspace.ts";

export const PROJECT_READ_LIMITS = {
  pathCharacters: 4_096,
  maxLines: 2_000,
  defaultLines: 400,
} as const;

export const PROJECT_SEARCH_LIMITS = {
  queryCharacters: 200,
  maxMatches: 200,
  lineCharacters: 400,
  scannedFiles: 2_000,
  /** One search decodes at most one workspace file limit of text. A call that
   * decoded the whole copy could spend a run on a single phrase. */
  scannedBytes: PROJECT_WORKSPACE_LIMITS.fileBytes,
} as const;

export type ProjectReadResult = {
  readonly path: string;
  /** First line in `content`, counting from 1. */
  readonly offset: number;
  /** Lines in `content`, including a last line clipped by the byte bound. */
  readonly lines: number;
  readonly totalLines: number;
  readonly content: string;
  /** More content exists after `content`: later lines, or the rest of a line
   * clipped by the byte bound. */
  readonly hasMore: boolean;
  /** `content` was cut by the byte bound. */
  readonly truncated: boolean;
};

export type ProjectSearchMatch = {
  readonly path: string;
  /** Line number, counting from 1. */
  readonly line: number;
  readonly text: string;
};

export type ProjectSearchResult = {
  readonly query: string;
  readonly path?: string;
  readonly matches: ProjectSearchMatch[];
  readonly scannedFiles: number;
  /** More matches exist than were returned. */
  readonly hasMore: boolean;
  /** The result stopped at a bound, so it is not the whole answer. */
  readonly truncated: boolean;
};

export const PROJECT_READ_TOOL = {
  name: "nomo_project_read",
  description:
    "Read a text file from the explicitly approved filtered project copy. Paths are relative to the copy. Returns a line window with its line numbers; binary files, invalid UTF-8 and protected paths are refused.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        minLength: 1,
        maxLength: PROJECT_READ_LIMITS.pathCharacters,
        description: "Path of the file inside the filtered project copy.",
      },
      offset: {
        type: "integer",
        minimum: 1,
        description: "First line to return, counting from 1. Defaults to 1.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: PROJECT_READ_LIMITS.maxLines,
        description: `Most lines to return. Defaults to ${PROJECT_READ_LIMITS.defaultLines}.`,
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
} as const;

export const PROJECT_SEARCH_TOOL = {
  name: "nomo_project_search",
  description:
    "Search text files in the explicitly approved filtered project copy for one literal phrase, case sensitive. Returns bounded matching lines. Regular expressions, shell commands and protected paths are not supported.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        minLength: 1,
        maxLength: PROJECT_SEARCH_LIMITS.queryCharacters,
        description: "The literal phrase to look for. Case is significant.",
      },
      path: {
        type: "string",
        minLength: 1,
        maxLength: PROJECT_READ_LIMITS.pathCharacters,
        description:
          "A file or directory inside the copy to search. Defaults to the copy root.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
} as const;

const ELLIPSIS = "...";

export async function projectWorkspaceRead(
  workspace: ProjectWorkspace,
  args: unknown,
): Promise<ProjectReadResult> {
  const { path, offset, limit } = readReadArguments(args);
  if (!isAllowedProjectWorkspacePath(path))
    throw new Error("Project read path is not permitted.");
  const device = await sourceDevice(workspace);
  let file: { readonly bytes: Buffer; readonly mode: number } | undefined;
  try {
    file = await readRegularProjectFile(workspace.source, path, device);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error("Project read path does not exist.");
    throw error;
  }
  if (!file) throw new Error("Project read path is not a regular file.");
  const text = decodeReadText(file.bytes);
  const lines = splitLines(text);
  const start = offset - 1;
  const window = lines.slice(start, start + limit);
  const hasMore = start + window.length < lines.length;
  const whole = readResult(path, offset, window, lines.length, hasMore, false);
  if (fitsOutput(whole)) return whole;
  return boundedReadResult(path, offset, window, lines.length);
}

export async function projectWorkspaceSearch(
  workspace: ProjectWorkspace,
  args: unknown,
): Promise<ProjectSearchResult> {
  const { query, path } = readSearchArguments(args);
  if (path !== undefined && !isAllowedProjectWorkspacePath(path))
    throw new Error("Project search path is not permitted.");
  const device = await sourceDevice(workspace);
  const matches: ProjectSearchMatch[] = [];
  const state = {
    scannedFiles: 0,
    scannedBytes: 0,
    hasMore: false,
    truncated: false,
  };
  const result = (): ProjectSearchResult => ({
    query,
    ...(path === undefined ? {} : { path }),
    matches: [...matches],
    scannedFiles: state.scannedFiles,
    hasMore: state.hasMore,
    truncated: state.truncated,
  });
  const stop = (): false => {
    state.hasMore = true;
    state.truncated = true;
    return false;
  };

  const scan = (filePath: string, bytes: Buffer): boolean => {
    const text = decodeSearchText(bytes);
    if (text === undefined) return true;
    const lines = splitLines(text);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      if (!line.includes(query)) continue;
      if (matches.length >= PROJECT_SEARCH_LIMITS.maxMatches) return stop();
      matches.push({ path: filePath, line: index + 1, text: lineExcerpt(line, query) });
      if (!fitsOutput(result())) {
        matches.pop();
        return stop();
      }
    }
    return true;
  };

  const visitFile = async (filePath: string): Promise<boolean> => {
    if (
      state.scannedFiles >= PROJECT_SEARCH_LIMITS.scannedFiles ||
      state.scannedBytes >= PROJECT_SEARCH_LIMITS.scannedBytes
    ) return stop();
    state.scannedFiles += 1;
    let file: { readonly bytes: Buffer; readonly mode: number } | undefined;
    try {
      file = await readRegularProjectFile(workspace.source, filePath, device);
    } catch {
      // A path that became unreadable, hard linked or changed while the search
      // walked is skipped: one broken file must not fail a search that already
      // has usable matches.
      return true;
    }
    if (!file) return true;
    state.scannedBytes += file.bytes.length;
    return scan(filePath, file.bytes);
  };

  const visit = async (prefix: string): Promise<boolean> => {
    const parent = prefix ? join(workspace.source, ...prefix.split("/")) : workspace.source;
    const entries = await readdir(parent, { withFileTypes: true });
    entries.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    for (const entry of entries) {
      const entryPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!isAllowedProjectWorkspacePath(entryPath)) continue;
      let info;
      try {
        info = await lstat(join(parent, entry.name));
      } catch {
        continue;
      }
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        if (!await visit(entryPath)) return false;
        continue;
      }
      if (!info.isFile()) continue;
      if (!await visitFile(entryPath)) return false;
    }
    return true;
  };

  if (path === undefined) {
    await visit("");
  } else {
    let file: { readonly bytes: Buffer; readonly mode: number } | undefined;
    try {
      file = await readRegularProjectFile(workspace.source, path, device);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new Error("Project search path does not exist.");
      throw error;
    }
    if (file) {
      state.scannedFiles += 1;
      state.scannedBytes += file.bytes.length;
      scan(path, file.bytes);
    } else {
      let info;
      try {
        info = await lstat(join(workspace.source, ...path.split("/")));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          throw new Error("Project search path does not exist.");
        throw error;
      }
      if (info.isSymbolicLink() || !info.isDirectory())
        throw new Error("Project search path is not a directory or a regular file.");
      await visit(path);
    }
  }

  // The flags can grow the JSON after a match was measured, so the last word
  // on the bound is the finished result, not the running estimate.
  while (matches.length > 0 && !fitsOutput(result())) {
    matches.pop();
    state.hasMore = true;
    state.truncated = true;
  }
  return result();
}

async function sourceDevice(workspace: ProjectWorkspace): Promise<number> {
  const info = await lstat(workspace.source);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Project workspace source is invalid.");
  return info.dev;
}

function readResult(
  path: string,
  offset: number,
  lines: readonly string[],
  totalLines: number,
  hasMore: boolean,
  truncated: boolean,
): ProjectReadResult {
  return {
    path,
    offset,
    lines: lines.length,
    totalLines,
    content: lines.join("\n"),
    hasMore,
    truncated,
  };
}

/**
 * The largest line prefix whose JSON fits the output bound. A window of whole
 * lines is preferred; when even one line is too large, that line is clipped
 * inside itself rather than returned empty.
 */
function boundedReadResult(
  path: string,
  offset: number,
  window: readonly string[],
  totalLines: number,
): ProjectReadResult {
  let best = -1;
  let low = 0;
  let high = window.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const candidate = readResult(path, offset, window.slice(0, middle), totalLines, true, true);
    if (fitsOutput(candidate)) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (best > 0)
    return readResult(path, offset, window.slice(0, best), totalLines, true, true);
  const first = window[0] ?? "";
  const clipped = (length: number) => readResult(
    path,
    offset,
    length > 0 ? [first.slice(0, length)] : [],
    totalLines,
    true,
    true,
  );
  let keep = 0;
  let lowCharacter = 0;
  let highCharacter = first.length;
  while (lowCharacter <= highCharacter) {
    const middle = (lowCharacter + highCharacter) >> 1;
    if (fitsOutput(clipped(middle))) {
      keep = middle;
      lowCharacter = middle + 1;
    } else {
      highCharacter = middle - 1;
    }
  }
  // A cut between the halves of a surrogate pair would leave text that is not
  // UTF-8, which the tool promises never to return.
  if (keep > 0 && keep < first.length) {
    const code = first.charCodeAt(keep - 1);
    if (code >= 0xd800 && code <= 0xdbff) keep -= 1;
  }
  return clipped(keep);
}

function decodeReadText(bytes: Buffer): string {
  if (bytes.includes(0)) throw new Error("Project read path is a binary file.");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Project read path is not valid UTF-8.");
  }
}

function decodeSearchText(bytes: Buffer): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** A trailing newline ends the last line rather than starting an empty one. */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** The matching line, or a window around the match when the line is long. */
function lineExcerpt(line: string, query: string): string {
  if (line.length <= PROJECT_SEARCH_LIMITS.lineCharacters) return line;
  const at = Math.max(0, line.indexOf(query));
  const points = Array.from(line);
  const matchPoint = Array.from(line.slice(0, at)).length;
  const room = PROJECT_SEARCH_LIMITS.lineCharacters - ELLIPSIS.length * 2;
  let start = Math.max(0, matchPoint - Math.floor(room / 2));
  const end = Math.min(points.length, start + room);
  start = Math.max(0, end - room);
  const head = start > 0 ? ELLIPSIS : "";
  const tail = end < points.length ? ELLIPSIS : "";
  return `${head}${points.slice(start, end).join("")}${tail}`;
}

function fitsOutput(value: unknown): boolean {
  return Buffer.byteLength(JSON.stringify(value), "utf8") <= PROJECT_SANDBOX_LIMITS.outputBytes;
}

function readReadArguments(args: unknown): {
  readonly path: string;
  readonly offset: number;
  readonly limit: number;
} {
  if (args === null || typeof args !== "object" || Array.isArray(args))
    throw new Error(
      "Invalid project read: expected an object with a path, an optional offset and an optional limit.",
    );
  const fields = args as Record<string, unknown>;
  for (const key of Object.keys(fields))
    if (key !== "path" && key !== "offset" && key !== "limit")
      throw new Error(`Invalid project read: unexpected field ${key}.`);
  if (typeof fields.path !== "string" || !fields.path)
    throw new Error("Invalid project read: path must be non-empty text.");
  return {
    path: fields.path,
    offset: fields.offset === undefined
      ? 1
      : integerField(fields.offset, "offset", 1, undefined, "project read"),
    limit: fields.limit === undefined
      ? PROJECT_READ_LIMITS.defaultLines
      : integerField(fields.limit, "limit", 1, PROJECT_READ_LIMITS.maxLines, "project read"),
  };
}

function readSearchArguments(args: unknown): {
  readonly query: string;
  readonly path: string | undefined;
} {
  if (args === null || typeof args !== "object" || Array.isArray(args))
    throw new Error(
      "Invalid project search: expected an object with a query and an optional path.",
    );
  const fields = args as Record<string, unknown>;
  for (const key of Object.keys(fields))
    if (key !== "query" && key !== "path")
      throw new Error(`Invalid project search: unexpected field ${key}.`);
  if (typeof fields.query !== "string")
    throw new Error("Invalid project search: query must be text.");
  const query = fields.query;
  if (!query.trim())
    throw new Error("Invalid project search: query must not be empty.");
  if (query.length > PROJECT_SEARCH_LIMITS.queryCharacters)
    throw new Error(
      `Invalid project search: query is at most ${PROJECT_SEARCH_LIMITS.queryCharacters} characters, got ${query.length}.`,
    );
  if (/[\u0000-\u001f\u007f]/.test(query))
    throw new Error("Invalid project search: query must not contain control characters.");
  if (fields.path === undefined) return { query, path: undefined };
  if (typeof fields.path !== "string" || !fields.path)
    throw new Error("Invalid project search: path must be non-empty text.");
  return { query, path: fields.path };
}

function integerField(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number | undefined,
  label: string,
): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < minimum ||
    (maximum !== undefined && (value as number) > maximum)
  )
    throw new Error(
      maximum === undefined
        ? `Invalid ${label}: ${field} must be an integer of at least ${minimum}, got ${JSON.stringify(value)}.`
        : `Invalid ${label}: ${field} must be an integer from ${minimum} to ${maximum}, got ${JSON.stringify(value)}.`,
    );
  return value as number;
}
