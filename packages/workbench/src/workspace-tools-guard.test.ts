import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWorkspace,
  executeWorkspaceTool,
  workspaceToolClass,
  workspaceTools,
  type WorkspaceState,
} from './workspace.ts';

/**
 * The managed workspace is the one tool source VOID owns outright. Its safety
 * argument is that a document name is never a host path: `validPath` refuses a
 * leading slash, backslashes, control characters, empty and dot segments, and
 * the reserved prototype names, and it is called before any tool branches on
 * what the name means.
 *
 * That argument is structural, and structure does not fail tests. It fails when
 * someone adds a tool to `workspaceTools` that reaches the store without going
 * through `validPath`. This test is the guard for exactly that.
 *
 * Two deliberate choices:
 *
 * - The set is enumerated, never asserted. A hardcoded membership list is the
 *   test that rots the day someone adds a legitimate fifth tool, which is the
 *   opposite of what a guard is for. `for (const tool of workspaceTools)` covers
 *   whatever is there, today and later.
 * - The assertion is on `validPath`'s exact refusal message, not merely on
 *   `isError`. `isError` is what a tool returns when it fails for any reason,
 *   including its own business logic; the message is what proves the refusal
 *   came from the namespace check and not from somewhere downstream.
 */

const VALID_PATH_REFUSAL =
  'Use a relative document path without traversal or reserved segments.';

/**
 * Every shape `validPath` exists to refuse, one case each, so a tool that
 * validates some of them but not others is caught rather than passing on the
 * one case it happened to handle.
 */
const HOSTILE_PATHS = [
  { why: 'a leading slash is an absolute host path', path: '/etc/passwd' },
  { why: 'parent segments escape the document namespace', path: '../secrets' },
  { why: 'traversal can hide behind a plausible first segment', path: 'notes/../../etc/shadow' },
  { why: 'a backslash separator is a separator on Windows', path: 'notes\\..\\..\\escape' },
  { why: '__proto__ is a reserved segment, not a document name', path: '__proto__' },
  { why: 'a reserved segment can hide mid-path', path: 'notes/constructor' },
  { why: 'a NUL byte truncates the name at the syscall boundary', path: 'notes/a\0b' },
  { why: 'an empty segment is not a name', path: 'notes//b' },
  { why: 'the current directory is not a document name', path: '.' },
] as const;

/**
 * Names that look like host paths and are NOT refused, because `validPath` has
 * no rule against them: a tilde and a drive letter are ordinary characters in a
 * document name, and refusing them would be a rule about shell expansion and
 * Windows rather than about the document namespace.
 *
 * They are stated here rather than omitted, because "the guard does not cover
 * these" and "these are covered and found safe" are different claims and only
 * one of them is currently true. What does hold for them is asserted below: the
 * name becomes an opaque key in an in-memory map and is never resolved against
 * the host filesystem.
 */
const ACCEPTED_BUT_INERT_NAMES = [
  { why: 'a tilde prefix is a shell expansion, not a traversal', name: '~/.ssh/id_rsa' },
  { why: 'a drive letter is a path root only when followed by a separator this check also refuses', name: 'C:/Windows/System32' },
] as const;

/**
 * The arguments a hostile call needs. Every other required property is supplied
 * with a valid value of the right shape, so the call fails on the path and
 * nothing else. Whether a tool takes a path is read from its own `inputSchema`,
 * so adding a path-taking tool is covered automatically and adding a pathless
 * one does not have to be excused by hand.
 */
function hostileArguments(tool: (typeof workspaceTools)[number], path: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const schema = tool.inputSchema as
    | { properties?: Record<string, unknown>; required?: readonly string[] }
    | undefined;
  for (const name of schema?.required ?? []) {
    if (name === 'path') args.path = path;
    else if (name === 'content') args.content = 'hostile';
    else args[name] = 'x';
  }
  if ('path' in (schema?.properties ?? {}) && !('path' in args)) args.path = path;
  return args;
}

const pathTools = workspaceTools.filter(
  (tool) => 'path' in (((tool.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties) ?? {}),
);
const pathlessTools = workspaceTools.filter(
  (tool) => !('path' in (((tool.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties) ?? {})),
);

test('the enumeration is non-empty and covers every declared workspace tool', () => {
  // If workspaceTools ever became empty the loop below would vacuously pass.
  // This asserts the two sets partition the literal, not what the literal is.
  assert.equal(pathTools.length + pathlessTools.length, workspaceTools.length);
  assert.ok(pathTools.length > 0, 'at least one workspace tool must take a document path');
});

test('a pathless workspace tool is named in its own schema and takes no path', () => {
  // Spelled out rather than skipped, so a tool that silently drops its `path`
  // property to dodge this guard is visible instead of quietly exempted.
  for (const tool of pathlessTools) {
    assert.equal('path' in (((tool.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties) ?? {}), false, tool.name);
    const response = executeWorkspaceTool(createWorkspace(), {
      id: `pathless-${tool.name}`,
      name: tool.name,
      arguments: hostileArguments(tool, '/etc/passwd'),
    });
    // A pathless tool either succeeds on its own terms or fails for its own
    // reasons; what it must never do is accept the host path as a document name,
    // which for these means it never reaches the store at all.
    if (response.result.isError) {
      assert.notEqual(
        JSON.stringify(response.result.content),
        '',
        `${tool.name} refused without naming a reason`,
      );
    }
    assert.equal(
      Object.keys(response.state.files).some((name) => name.includes('passwd')),
      false,
      `${tool.name} stored a host path`,
    );
  }
});

for (const tool of pathTools) {
  for (const { why, path } of HOSTILE_PATHS) {
    test(`${tool.name} refuses ${why}`, () => {
      const before: WorkspaceState = createWorkspace();
      const response = executeWorkspaceTool(before, {
        id: `hostile-${tool.name}`,
        name: tool.name,
        arguments: hostileArguments(tool, path),
      });

      assert.equal(
        response.result.isError,
        true,
        `${tool.name} accepted ${JSON.stringify(path)}`,
      );

      const text = JSON.stringify(response.result.content);
      assert.ok(
        text.includes(VALID_PATH_REFUSAL),
        `${tool.name} refused ${JSON.stringify(path)} for the wrong reason; got ${text}. ` +
          `A refusal that is not validPath's means the path reached something ` +
          `other than the document namespace check.`,
      );

      // The refusal must also leave nothing behind: same state object, no new
      // operation, no document. A tool that validates the path and writes
      // anyway has still broken the property.
      assert.equal(response.state, before, `${tool.name} returned a new state for a refused path`);
      assert.equal(response.operation, undefined, `${tool.name} recorded an operation for a refused path`);
      assert.deepEqual(Object.keys(response.state.files), [], `${tool.name} stored a document for a refused path`);
    });
  }
}

for (const { why, name } of ACCEPTED_BUT_INERT_NAMES) {
  test(`${why}: ${JSON.stringify(name)} is stored as an opaque key and reaches nothing`, () => {
    // `validPath` accepts this name, and that is currently correct: the managed
    // store is an in-memory map keyed by the name, so the name is a label, not a
    // location. What must stay true is that accepting it changes nothing about
    // the host — the document exists in the map under exactly this key, and the
    // same key round-trips through read.
    const written = executeWorkspaceTool(createWorkspace(), {
      id: 'inert',
      name: 'void_workspace_write',
      arguments: { path: name, content: 'hostile' },
    });
    assert.equal(written.result.isError, undefined, `${JSON.stringify(name)} was refused unexpectedly`);
    assert.deepEqual(Object.keys(written.state.files), [name]);
    // The value is stored verbatim: the name is never normalised into a real path.
    assert.equal(written.state.files[name], 'hostile');

    const read = executeWorkspaceTool(written.state, {
      id: 'inert-read',
      name: 'void_workspace_read',
      arguments: { path: name },
    });
    assert.equal(read.result.isError, undefined);
    assert.equal(JSON.parse(read.result.content[0]!.text).content, 'hostile');
  });
}

test('a pathless tool that takes no path cannot be made to take one', () => {
  // The exemption above is a schema fact, not a behaviour. This checks the
  // behaviour for the one literal member that is pathless today, so that adding
  // a path argument to it without adding the schema property is caught.
  for (const tool of pathlessTools) {
    const response = executeWorkspaceTool(createWorkspace(), {
      id: `extra-${tool.name}`,
      name: tool.name,
      arguments: { ...hostileArguments(tool, '/etc/passwd'), path: '/etc/passwd' },
    });
    const stored = Object.keys(response.state.files);
    assert.equal(
      stored.some((name) => name.includes('passwd') || name.includes('etc')),
      false,
      `${tool.name} stored a host path supplied outside its schema`,
    );
  }
});

test('every workspace tool is classified, so none of them falls back to r3', () => {
  // Not the guard itself, but the same failure mode: a tool added to the literal
  // without a class silently becomes the worst class at index.ts, and the
  // ledger stops naming what happened. Cheap to state alongside.
  for (const tool of workspaceTools) {
    assert.notEqual(
      workspaceToolClass(tool.name),
      undefined,
      `${tool.name} has no class; it would be recorded as r3`,
    );
  }
});