/**
 * The compact chat surface, asserted on what it renders.
 *
 * Every assertion here reads the rendered tree: the roles and accessible names
 * a screen reader reaches, the order and nesting of the regions, and the
 * attributes a cascade would later act on. There is no DOM and no stylesheet in
 * this runtime, so the two things a stylesheet decides are not observable here:
 * measured geometry (the 44px touch targets, the composer's max height, the
 * focus ring) and whether the cascade actually resolves to the value a rule
 * asks for. Those are reported as unassertable rather than stood in for by
 * matching a rule's text.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import {
  BUDGET_VISIBLE_AT,
  MESSAGE_BYTE_LIMIT,
  MESSAGE_CHAR_LIMIT,
  messageSize,
} from "./chat-composer.ts";
import {
  accessibleName,
  byClass,
  byRole,
  closest,
  elements,
  isExposed,
  parse,
  renderChat,
  renderIn,
  setDraft,
  setRoute,
  visibleText,
  type DomNode,
} from "./render-harness.test.ts";

const NEW_CONVERSATION = "http://127.0.0.1/chat/new";

/** The prefix the composer puts on the prompt before the draft while the
 * capabilities query is still in flight, so the budget is measured against the
 * same string the send guard measures. */
const { modePrefix } = await import("./permission-mode.tsx");
const READ_ONLY_PREFIX = modePrefix("read-only", (_cs, en) => en);

async function composerFor(draft: string | null): Promise<DomNode> {
  setRoute(NEW_CONVERSATION);
  setDraft(draft);
  return parse(await renderChat());
}

function formOf(tree: DomNode): DomNode {
  const forms = byClass(tree, "composer");
  assert.equal(forms.length, 1, "the composer renders exactly one form");
  return forms[0];
}

function noticesOf(tree: DomNode): DomNode {
  const regions = byClass(tree, "composer-notices");
  assert.equal(regions.length, 1, "the composer renders exactly one notices region");
  return regions[0];
}

/** Everything a person can operate, whether or not it carries a name. */
function controlsWithin(node: DomNode): DomNode[] {
  return elements(node).filter(
    (element) =>
      element.tag === "button" ||
      element.tag === "input" ||
      element.tag === "select" ||
      element.tag === "textarea" ||
      element.tag === "a" ||
      element.tag === "summary",
  );
}

test("the compact composer is one form holding one text entry", async () => {
  const tree = await composerFor(null);
  const form = formOf(tree);
  const textEntries = elements(form).filter((node) => node.tag === "textarea");
  assert.equal(textEntries.length, 1, "a compact composer has a single text entry");
  assert.equal(accessibleName(textEntries[0], tree), "Message");
  // Two text entries would mean two drafts, two budgets and two send guards
  // for one conversation, so the second one has to be a bug wherever it moves.
  assert.equal(
    elements(form).filter((node) => node.tag === "input").filter(
      (node) => (node.attrs.type ?? "") === "text",
    ).length,
    0,
  );
});

test("the composer form carries no settings of its own", async () => {
  // The mode rail and the per-conversation settings live in the dialog the
  // form's settings action opens. A control placed in the form instead would
  // submit with every message and put a mode switch in the send path.
  const tree = await composerFor(null);
  const form = formOf(tree);
  assert.deepEqual(byRole(form, "radiogroup"), [], "the form holds no mode rail");
  assert.equal(
    byRole(form, "region").length,
    0,
    "the form opens no dialog of its own",
  );
  assert.equal(
    byClass(tree, "composer-notices").filter((node) => closest(node, "composer")).length,
    0,
  );
  const settings = controlsWithin(form).filter(
    (control) => accessibleName(control, tree) === "Conversation settings",
  );
  assert.equal(settings.length, 1, "the settings action is one named control");
});

test("the dialog the settings action opens is named and modal", async () => {
  const { Dialog } = await import("./ui.tsx");
  const tree = parse(
    await renderIn(
      createElement(Dialog, { title: "Conversation settings", close: () => {} }, "body"),
    ),
  );
  const dialog = elements(tree).find((node) => node.tag === "dialog");
  assert.ok(dialog, "the settings surface is a native dialog");
  assert.equal(dialog.attrs["aria-modal"], "true");
  assert.equal(
    accessibleName(dialog, tree),
    "Conversation settings",
    "a modal with no name is announced as a modal and nothing else",
  );
  assert.equal(dialog.attrs.tabindex, "-1", "the dialog takes focus when it opens");
});

test("every control in the compact composer announces a name of its own", async () => {
  const tree = await composerFor(null);
  const form = formOf(tree);
  const controls = controlsWithin(form);
  assert.ok(controls.length >= 5, "the compact composer has actions to name");
  for (const control of controls) {
    assert.notEqual(
      accessibleName(control, tree),
      "",
      `the ${control.tag}${control.attrs.class ? " ." + control.attrs.class : ""} announces nothing`,
    );
  }
  // The names come from the control, never from the glyph inside it: an icon
  // that carried the name would leave the button named "send" or "/".
  const icons = elements(form).filter((node) => hasIconClass(node));
  assert.ok(icons.length > 0, "the compact composer uses icons");
  for (const icon of icons) {
    assert.equal(icon.attrs["aria-hidden"], "true");
    assert.equal(icon.attrs.focusable, "false");
    assert.equal(isExposed(icon), false, "an icon is never exposed on its own");
  }
});

function hasIconClass(node: DomNode): boolean {
  return (node.attrs.class ?? "").split(/\s+/).includes("ui-icon");
}

test("alerts live in one named, polite region that the form does not contain", async () => {
  const tree = await composerFor(null);
  const notices = noticesOf(tree);
  const form = formOf(tree);

  assert.equal(notices.attrs.role, "region");
  assert.equal(accessibleName(notices, tree), "Status and notices");
  assert.equal(
    notices.attrs["aria-live"],
    "polite",
    "a notice must not interrupt what is being read",
  );
  // A region that cannot take focus cannot be scrolled from the keyboard, and
  // an alert the keyboard cannot reach is not announced when it appears.
  assert.equal(notices.attrs.tabindex, "0");

  assert.equal(closest(notices, "composer"), undefined, "the notices region is not inside the form");
  assert.equal(
    byRole(form, "region").length,
    0,
    "the form holds no second scrolling region",
  );
  const wrap = closest(notices, "composer-wrap");
  assert.ok(wrap, "the notices region and the form share the composer wrapper");
  const order = wrap!.children.filter(
    (child) => child.tag !== "#text" && (hasClass(child, "composer-notices") || hasClass(child, "composer")),
  );
  assert.deepEqual(
    order.map((child) => child.attrs.class),
    ["composer-notices", "composer"],
    "the notices region comes before the form, so a taller form cannot push it away",
  );
});

test("the permission banner is announced inside the notices region", async () => {
  const tree = await composerFor(null);
  const notices = noticesOf(tree);
  const banner = byClass(notices, "permission-banner");
  assert.equal(banner.length, 1, "the mode is stated once, inside the notices region");
  assert.equal(banner[0].attrs.role, "status");
  assert.equal(
    visibleText(banner[0]),
    "Mode: read-only · checking the server",
    "the banner names the mode and who is enforcing it",
  );
  assert.equal(byClass(formOf(tree), "permission-banner").length, 0);
});

test("a queued draft is announced in the notices region, with a named way out", async () => {
  setRoute(NEW_CONVERSATION);
  setDraft("half a thought", undefined, true);
  const tree = parse(await renderChat());
  const banner = byClass(noticesOf(tree), "queue-banner");
  assert.equal(banner.length, 1);
  assert.equal(banner[0].attrs.role, "status");
  assert.equal(visibleText(banner[0]), "Draft saved in this tab. Nothing sends automatically. Send draft");
  const action = controlsWithin(banner[0]);
  assert.equal(action.length, 1);
  assert.equal(accessibleName(action[0], tree), "Send draft");
});

test("an ordinary draft pays for no budget line", async () => {
  const tree = await composerFor("a short question");
  assert.equal(byClass(tree, "composer-budget").length, 0);
  const entry = elements(formOf(tree)).find((node) => node.tag === "textarea")!;
  assert.equal(
    entry.attrs["aria-describedby"],
    undefined,
    "nothing describes the text entry until there is something to describe",
  );
});

test("the visible budget and the blocking guard are the same number", async () => {
  // Exactly at the visibility threshold, so the line appears without the prompt
  // being over: the counter is what has to agree with the guard, not the alarm.
  const draft = "x".repeat(MESSAGE_CHAR_LIMIT * BUDGET_VISIBLE_AT - READ_ONLY_PREFIX.length);
  const size = messageSize(READ_ONLY_PREFIX + draft);
  const tree = await composerFor(draft);
  const budget = byClass(tree, "composer-budget");
  assert.equal(budget.length, 1, "a prompt at the threshold shows the budget");
  assert.equal(size.pressure >= BUDGET_VISIBLE_AT, true);
  assert.equal(size.over, false);
  assert.equal(budget[0].attrs.id, "composer-budget");
  assert.equal(
    budget[0].attrs["data-over"],
    undefined,
    "a prompt inside the bound is not marked over",
  );
  assert.equal(
    visibleText(budget[0]),
    `Before the limit: ${(MESSAGE_CHAR_LIMIT - size.chars).toLocaleString()} characters or ` +
      `${(MESSAGE_BYTE_LIMIT - size.bytes).toLocaleString()} B.`,
  );
  const entry = elements(formOf(tree)).find((node) => node.tag === "textarea")!;
  assert.equal(
    entry.attrs["aria-describedby"],
    "composer-budget",
    "the text entry points at the number rather than the number shouting over it",
  );
});

test("a prompt past the bound says so in the same numbers the guard uses", async () => {
  const draft = "x".repeat(MESSAGE_CHAR_LIMIT + 1 - READ_ONLY_PREFIX.length);
  const size = messageSize(READ_ONLY_PREFIX + draft);
  assert.equal(size.over, true, "the fixture has to be over the bound to mean anything");
  const tree = await composerFor(draft);
  const budget = byClass(tree, "composer-budget");
  assert.equal(budget.length, 1);
  assert.equal(budget[0].attrs["data-over"], "true");
  assert.equal(
    visibleText(budget[0]),
    `Over the limit: ${size.chars.toLocaleString()} characters and ${size.bytes.toLocaleString()} B. ` +
      "Shorten the message or remove an attachment.",
  );
  setDraft(null);
});

test("the whole compact surface is announced in Czech when Czech is active", async () => {
  setRoute(NEW_CONVERSATION);
  setDraft(null);
  const tree = parse(await renderChat({ locale: "cs" }));
  assert.equal(accessibleName(noticesOf(tree), tree), "Stav a upozornění");
  const form = formOf(tree);
  const entry = elements(form).find((node) => node.tag === "textarea")!;
  assert.equal(accessibleName(entry, tree), "Zpráva");
  const names = controlsWithin(form).map((control) => accessibleName(control, tree));
  assert.deepEqual(names, [
    "Zpráva",
    "Nastavení konverzace",
    "Otevřít příkazy a nástroje",
    "Přiložit textový soubor",
    "Přiložit dokument z konverzace",
    "Vybrat model pro novou konverzaci",
    "Odeslat zprávu",
  ]);
  assert.equal(
    visibleText(byClass(noticesOf(tree), "permission-banner")[0]),
    "Režim: jen čtení · režim se ověřuje u serveru",
  );
});

test("the permission rail is a radio group only when the client can change the mode", async () => {
  const { PermissionModeSwitch } = await import("./permission-mode.tsx");
  const changeable = parse(
    await renderIn(
      createElement(PermissionModeSwitch, {
        mode: "plan",
        source: "server",
        onChange: () => {},
      }),
    ),
  );
  const groups = byRole(changeable, "radiogroup");
  assert.equal(groups.length, 1, "a mode a person can change is offered as a group");
  assert.equal(accessibleName(groups[0], changeable), "Permission mode");
  assert.equal(groups[0].attrs["data-source"], "server");
  const radios = byRole(groups[0], "radio");
  assert.deepEqual(
    radios.map((radio) => accessibleName(radio, changeable)),
    ["Normal", "Plan", "Read-only"],
  );
  assert.deepEqual(
    radios.map((radio) => radio.attrs["aria-checked"]),
    ["false", "true", "false"],
    "exactly the active mode is checked",
  );

  const fixed = parse(
    await renderIn(
      createElement(PermissionModeSwitch, { mode: "read-only", source: "pending" }),
    ),
  );
  assert.equal(
    byRole(fixed, "radiogroup").length + byRole(fixed, "radio").length,
    0,
    "a mode the client cannot change is not offered as a control",
  );
  assert.equal(
    elements(fixed).filter((node) => "disabled" in node.attrs).length,
    0,
    "nothing here is offered and then refused",
  );
  assert.equal(
    visibleText(byClass(fixed, "permission-modes")[0]),
    "Mode: read-only · checking the server Server controls this mode; it cannot be changed here.",
    "the authoritative mode is stated as a fact, with the source that decides it",
  );
});

test("the permission rail reads the same sentence in both languages", async () => {
  const { PermissionModeSwitch } = await import("./permission-mode.tsx");
  for (const [locale, expected] of [
    ["en", "Mode: normal · enforced by server"],
    ["cs", "Režim: normální · vynucuje server"],
  ] as const) {
    const tree = parse(
      await renderIn(
        createElement(PermissionModeSwitch, {
          mode: "normal",
          source: "server",
          onChange: () => {},
        }),
        locale,
      ),
    );
    const banner = parse(
      await renderIn(
        createElement(
          (await import("./permission-mode.tsx")).PermissionBanner,
          { mode: "normal", source: "server" },
        ),
        locale,
      ),
    );
    assert.equal(byRole(tree, "radiogroup").length, 1, `${locale} renders a group`);
    assert.equal(
      visibleText(byClass(banner, "permission-banner")[0]),
      expected,
      `${locale} names the mode and its enforcement source`,
    );
  }
});

function hasClass(node: DomNode, className: string): boolean {
  return (node.attrs.class ?? "").split(/\s+/).includes(className);
}
