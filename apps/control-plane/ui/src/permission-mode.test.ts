/**
 * The permission mode, asserted through the resolver it is built on and through
 * the words the banner and the rail put on screen. Nothing here reads the source
 * of the component: a source match can be satisfied by a comment or a renamed
 * variable, and it cannot tell a sentence a reader hears from one that only
 * exists in the file.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import {
  byClass,
  parse,
  renderIn,
  visibleText,
  type DomNode,
} from "./render-harness.test.ts";

// The harness installs the loader that makes a `.tsx` module importable, and it
// has to be imported before the component is asked for.
const { modePrefix, resolvePermissionMode, usePermissionMode } = await import(
  "./permission-mode.tsx"
);
type PermissionQuery = Parameters<typeof resolvePermissionMode>[0];

const cs = (czech: string) => czech;
const en = (_czech: string, english: string) => english;

async function renderBanner(
  props: {
    mode: "normal" | "plan" | "read-only";
    source: "server" | "local" | "pending";
  },
  locale: "cs" | "en" = "en",
): Promise<DomNode> {
  const { PermissionBanner } = await import("./permission-mode.tsx");
  return byClass(
    parse(await renderIn(createElement(PermissionBanner, props), locale)),
    "permission-banner",
  )[0];
}

test("permission mode requires explicit server authority", () => {
  for (const mode of ["plan", "read-only", "normal"] as const)
    assert.deepEqual(
      resolvePermissionMode({
        data: { permissionMode: mode, permissionModeAuthority: "server" },
      }),
      { mode, source: "server" },
      `${mode} is the server's to grant`,
    );
  // A mode the server sent without claiming the authority to send it is not a
  // grant, and neither is a mode the server never sent at all.
  for (const data of [
    { permissionMode: "normal", permissionModeAuthority: "local" },
    { permissionMode: "normal" },
    { permissionModeAuthority: "server" },
    {},
  ])
    assert.deepEqual(
      resolvePermissionMode({ data }),
      { mode: "read-only", source: "local" },
      "an unauthorised mode falls back to the one mode that changes nothing",
    );
});

test("an unanswered capabilities query is pending, not a server refusal", () => {
  // The fail-closed mode is unchanged; only the claim changes. A banner that
  // calls the server unavailable while the query is in flight is false against
  // a healthy server, and the banner is the one element a reader has to be able
  // to believe.
  assert.deepEqual(resolvePermissionMode({ isPending: true }), {
    mode: "read-only",
    source: "pending",
  });
  // An explicit error, and a query that has settled with no data, are the only
  // two cases that license naming the server as the reason.
  for (const capabilities of [
    { isError: true },
    { isPending: false },
  ] as PermissionQuery[])
    assert.deepEqual(
      resolvePermissionMode(capabilities),
      { mode: "read-only", source: "local" },
      "a settled query is an answer, even when the answer is nothing",
    );
});

test("a pending answer never buys privilege, and the client cannot grant one", () => {
  for (const capabilities of [
    {},
    { isPending: true },
    { isError: true },
    { isPending: false },
  ] as PermissionQuery[])
    assert.equal(
      usePermissionMode(capabilities).mode,
      "read-only",
      "a client that has not been told may only read",
    );
  // The resolver hands back no way to change the mode: a client that could
  // grant itself a mode would make the banner a decoration.
  for (const capabilities of [
    { data: { permissionMode: "normal", permissionModeAuthority: "server" } },
    { isPending: true },
    {},
  ] as PermissionQuery[])
    assert.equal(
      "setMode" in usePermissionMode(capabilities),
      false,
      "nothing in this path exposes a setter",
    );
});

test("the mode prefix fails closed while the answer is unknown", () => {
  // The prefix reads only the mode, so it says read-only during the flight
  // window. Omitting it would instruct the model that it may act before the
  // server has granted anything, which is the direction this file must never
  // err in. The flight window resolves to read-only, so the prefix cannot be
  // dropped on the grounds that the mode is not known yet.
  assert.equal(
    modePrefix(resolvePermissionMode({ isPending: true }).mode, en),
    modePrefix("read-only", en),
  );
  for (const mode of ["read-only", "plan"] as const)
    assert.notEqual(modePrefix(mode, en), "", `${mode} instructs the model`);
  assert.equal(modePrefix("normal", en), "", "normal mode needs no instruction");
});

test("the mode prefix is written in both languages", () => {
  for (const mode of ["read-only", "plan"] as const) {
    const czech = modePrefix(mode, cs);
    assert.notEqual(czech, "", `${mode} has a Czech instruction`);
    assert.notEqual(
      czech,
      modePrefix(mode, en),
      `${mode} is not left in English when Czech is active`,
    );
  }
});

test("a pending banner never names the server as the reason", async () => {
  const pending = await renderBanner({ mode: "read-only", source: "pending" });
  const local = await renderBanner({ mode: "read-only", source: "local" });
  assert.equal(pending.attrs.role, "status", "the banner is announced politely");
  assert.equal(visibleText(pending), "Mode: read-only · checking the server");
  // The fallback sentence names unavailability; the exact wording is the
  // component's, and reproducing it here would only pin it a second time.
  assert.equal(
    visibleText(local).includes("server mode unavailable"),
    true,
    "a settled query with no grant says the mode is unavailable",
  );
  assert.equal(
    visibleText(local).includes("checking the server"),
    false,
    "a settled query is not still being checked",
  );
  assert.notEqual(
    visibleText(pending),
    visibleText(local),
    "an unanswered query and a refused one must not read the same",
  );
});

test("the banner names the mode, its source, and the source in a form CSS can key on", async () => {
  for (const source of ["server", "local", "pending"] as const) {
    const tree = await renderBanner({ mode: "plan", source });
    assert.equal(tree.attrs["data-source"], source);
    assert.equal(tree.attrs["data-mode"], "plan");
  }
  assert.equal(
    visibleText(await renderBanner({ mode: "normal", source: "server" })),
    "Mode: normal · enforced by server",
  );
  assert.equal(
    visibleText(await renderBanner({ mode: "plan", source: "server" }, "cs")),
    "Režim: plán · vynucuje server",
  );
});
