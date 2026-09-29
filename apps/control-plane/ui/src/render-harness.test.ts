/**
 * Render environment shared by the tests that assert on what a person ends up
 * looking at. Nothing here ships: `tsconfig.json` excludes `src/*.test.ts`, and
 * this file exists because Node cannot import a `.tsx` module on its own, so
 * the loader has to be installed before the first component is pulled in.
 *
 * What this runtime can observe is the rendered tree: roles, accessible names,
 * the order and nesting of regions, and the attributes a cascade would later
 * act on. There is no DOM and no stylesheet here, so measured geometry and
 * cascade-dependent visibility are not observable, and every test that used to
 * stand in for one says so and asserts the rendered fact instead.
 */
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ts from "typescript";

/**
 * `react-dom/client` is replaced so a module that mounts itself at import time
 * can be imported at all. The stub keeps the element that module hands to
 * `createRoot`, which is the tree the browser would have rendered, so the
 * assertions run against the same React elements the application builds.
 */
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "react-dom/client")
      return { url: "void-test:create-root", shortCircuit: true };
    // A stylesheet is not a module, and a render tree never needs one, so a
    // stylesheet import resolves to an empty module whether or not the file it
    // names is on disk.
    if (specifier.endsWith(".css"))
      return { url: "void-test:stylesheet", shortCircuit: true };
    try {
      return next(specifier, context);
    } catch (error) {
      // The sources use bundler style relative specifiers (`./ui` for ui.tsx),
      // which Node's ESM resolver rejects. The suffix list is the one Vite
      // would try, so a module resolves here exactly as it resolves in a build.
      if (!specifier.startsWith(".")) throw error;
      let last: unknown = error;
      for (const suffix of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
        try {
          return next(specifier + suffix, context);
        } catch (inner) {
          last = inner;
        }
      }
      throw last;
    }
  },
  load(url, context, next) {
    if (url === "void-test:create-root")
      return {
        format: "module",
        shortCircuit: true,
        source:
          "export function createRoot(){ return { render(node){" +
          " globalThis.__voidRoot = node; } }; }",
      };
    if (url === "void-test:stylesheet")
      return { format: "module", shortCircuit: true, source: "export default {};" };
    const path = new URL(url).pathname;
    if (path.endsWith(".css"))
      return { format: "module", shortCircuit: true, source: "export default {};" };
    if (/\.tsx?$/.test(path))
      return {
        format: "module",
        shortCircuit: true,
        source: ts.transpileModule(readFileSync(new URL(url), "utf8"), {
          compilerOptions: {
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ES2022,
            jsx: ts.JsxEmit.ReactJSX,
          },
        }).outputText,
      };
    return next(url, context);
  },
});

/** The few browser globals the components read while rendering rather than in
 * an effect. Effects never run here, so this is deliberately the minimum. */
function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => (values.has(key) ? values.get(key)! : null),
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => void values.delete(key),
    setItem: (key: string, value: string) => void values.set(key, String(value)),
  } as Storage;
}

const store = memoryStorage();
Object.assign(globalThis, {
  sessionStorage: store,
  localStorage: store,
  history: { pushState() {}, replaceState() {} },
  matchMedia: () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }),
  addEventListener() {},
  removeEventListener() {},
  document: {
    activeElement: null,
    documentElement: { dataset: {} as Record<string, string>, lang: "en" },
    getElementById: () => ({}),
    querySelector: () => null,
    addEventListener() {},
    removeEventListener() {},
  },
});

/** Point the router at a URL. Read during render, so it has to be set before
 * each render rather than once at import. */
export function setRoute(href: string): void {
  (globalThis as { location: URL }).location = new URL(href);
}

/** The key the composer restores its draft under, spelled the way the composer
 * spells it so that a change on either side is visible from here. */
function draftKey(id?: string): string {
  const workspace = new URLSearchParams(location.search).get("workspace");
  return `void-draft:${workspace}:${id ?? "new"}`;
}

/** Restore a draft into the composer's storage, or clear it with `null`. A
 * queued draft is the one the sender left behind: the same text under the
 * queued key, which is what tells the composer nothing sends on its own. */
export function setDraft(text: string | null, id?: string, queued = false): void {
  const draft = draftKey(id);
  const waiting = draft.replace(/^void-draft:/, "void-queued:");
  if (text === null) store.removeItem(draft);
  else store.setItem(draft, text);
  if (text === null || !queued) store.removeItem(waiting);
  else store.setItem(waiting, text);
}

/** Render one element inside the shared locale and query providers, so the
 * assertions can be made in either language against the same tree. */
export async function renderIn(
  element: ReactElement,
  locale: "cs" | "en" = "en",
): Promise<string> {
  // A static import would be hoisted above the loader registration above, and
  // the registration is the only reason this import is not static.
  const { Locale } = await import("./ui.tsx");
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(Locale, { value: locale }, element),
    ),
  );
}

export async function renderChat(
  props: { id?: string; locale?: "cs" | "en" } = {},
): Promise<string> {
  const { Chat } = await import("./chat.tsx");
  return renderIn(
    createElement(Chat, {
      id: props.id,
      navigate: () => {},
      onContext: () => {},
    }),
    props.locale,
  );
}

/** Render the whole application at the current route, from the element tree
 * `main.tsx` hands to `createRoot`. */
export async function renderApp(): Promise<string> {
  await import("./main.tsx");
  const root = (globalThis as { __voidRoot?: unknown }).__voidRoot;
  if (root === undefined) throw new Error("main.tsx never reached createRoot");
  return renderToStaticMarkup(root as ReactElement);
}

export type DomNode = {
  tag: string;
  attrs: Record<string, string>;
  children: DomNode[];
  parent: DomNode | null;
  /** Text carried by a `#text` node. */
  value: string;
};

const VOID: Record<string, true> = {
  area: true, base: true, br: true, col: true, embed: true, hr: true,
  img: true, input: true, link: true, meta: true, param: true, source: true,
  track: true, wbr: true,
};

const RAW_TEXT: Record<string, true> = {
  pre: true, script: true, style: true, textarea: true,
};

const ENTITIES: Record<string, string> = {
  amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"',
};

function decode(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] !== "#") return ENTITIES[body] ?? whole;
    const code =
      body[1] === "x" || body[1] === "X"
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
  });
}

/** `>` inside a quoted attribute value does not end the tag. */
function tagEnd(html: string, start: number): number {
  let quote = "";
  for (let index = start; index < html.length; index++) {
    const character = html[index];
    if (quote) {
      if (character === quote) quote = "";
    } else if (character === '"' || character === "'") quote = character;
    else if (character === ">") return index;
  }
  return html.length;
}

function attributes(source: string): Record<string, string> {
  const found: Record<string, string> = {};
  const pattern = /([^\s=/>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'`=<>]+))?/g;
  for (const match of source.matchAll(pattern)) {
    const quoted = match[2] ?? "";
    found[match[1].toLowerCase()] = decode(
      quoted.replace(/^["']|["']$/g, ""),
    );
  }
  return found;
}

function textNode(value: string): DomNode {
  return { tag: "#text", attrs: {}, children: [], parent: null, value };
}

/** Parse rendered markup into a tree. Small on purpose: it understands exactly
 * what `renderToStaticMarkup` emits, which is closed elements, quoted
 * attributes and escaped text. */
export function parse(html: string): DomNode {
  const root: DomNode = {
    tag: "#root",
    attrs: {},
    children: [],
    parent: null,
    value: "",
  };
  const stack: DomNode[] = [root];
  const append = (node: DomNode) => {
    node.parent = stack[stack.length - 1];
    stack[stack.length - 1].children.push(node);
  };
  let index = 0;
  while (index < html.length) {
    const open = html.indexOf("<", index);
    if (open < 0) {
      append(textNode(decode(html.slice(index))));
      break;
    }
    if (open > index) append(textNode(decode(html.slice(index, open))));
    if (html.startsWith("</", open)) {
      const close = html.indexOf(">", open);
      const name = html.slice(open + 2, close).trim().toLowerCase();
      for (let depth = stack.length - 1; depth > 0; depth--)
        if (stack[depth].tag === name) {
          stack.length = depth;
          break;
        }
      index = close + 1;
      continue;
    }
    const end = tagEnd(html, open);
    const body = html.slice(open + 1, end);
    const selfClosing = body.endsWith("/");
    const inner = selfClosing ? body.slice(0, -1) : body;
    const name = /^([a-zA-Z][^\s/>]*)/.exec(inner);
    index = end + 1;
    if (!name) continue;
    const node: DomNode = {
      tag: name[1].toLowerCase(),
      attrs: attributes(inner.slice(name[1].length)),
      children: [],
      parent: null,
      value: "",
    };
    append(node);
    if (selfClosing || VOID[node.tag]) continue;
    if (RAW_TEXT[node.tag]) {
      const close = html.toLowerCase().indexOf("</" + node.tag, index);
      const stop = close < 0 ? html.length : close;
      if (stop > index) append(textNode(decode(html.slice(index, stop))));
      index = close < 0 ? html.length : html.indexOf(">", close) + 1;
    } else {
      stack.push(node);
    }
  }
  return root;
}

export function elements(node: DomNode): DomNode[] {
  const found: DomNode[] = [];
  const visit = (current: DomNode) => {
    for (const child of current.children) {
      if (child.tag === "#text") continue;
      found.push(child);
      visit(child);
    }
  };
  visit(node);
  return found;
}

export function hasClass(node: DomNode, className: string): boolean {
  return (node.attrs.class ?? "").split(/\s+/).includes(className);
}

export function byClass(tree: DomNode, className: string): DomNode[] {
  return elements(tree).filter((node) => hasClass(node, className));
}

export function byRole(tree: DomNode, role: string): DomNode[] {
  return elements(tree).filter((node) => node.attrs.role === role);
}

/** The nearest ancestor carrying the given class, or undefined. */
export function closest(node: DomNode, className: string): DomNode | undefined {
  for (let current: DomNode | null = node; current; current = current.parent)
    if (hasClass(current, className)) return current;
  return undefined;
}

/** An element is not exposed to assistive technology when it, or anything it
 * sits inside, is hidden from it. */
export function isExposed(node: DomNode): boolean {
  for (let current: DomNode | null = node; current; current = current.parent)
    if (current.attrs["aria-hidden"] === "true") return false;
  return true;
}

function normalise(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function fromContent(node: DomNode): string {
  if (node.attrs["aria-hidden"] === "true") return "";
  if (node.attrs["aria-label"] !== undefined) return node.attrs["aria-label"];
  if (node.tag === "img") return node.attrs.alt ?? "";
  if (node.tag === "#text") return node.value;
  if (node.tag === "script" || node.tag === "style") return "";
  return node.children.map(fromContent).join(" ");
}

/** The accessible name of a rendered element, following the parts of the accname
 * algorithm this application can produce: `aria-labelledby`, then `aria-label`,
 * then the element's own content or the label it sits inside. */
export function accessibleName(node: DomNode, tree: DomNode): string {
  if (node.attrs["aria-hidden"] === "true") return "";
  const labelledBy = node.attrs["aria-labelledby"];
  if (labelledBy !== undefined)
    return normalise(
      labelledBy
        .split(/\s+/)
        .map((id) => {
          const target = elements(tree).find((node) => node.attrs.id === id);
          return target ? fromContent(target) : "";
        })
        .join(" "),
    );
  if (node.attrs["aria-label"] !== undefined)
    return normalise(node.attrs["aria-label"]);
  if (node.tag === "input") {
    const type = node.attrs.type ?? "text";
    if (type === "button" || type === "submit" || type === "reset")
      return normalise(fromContent(node) || node.attrs.value || "");
    for (let owner = node.parent; owner; owner = owner.parent)
      if (owner.tag === "label") return normalise(fromContent(owner));
    return "";
  }
  if (node.tag === "img") return normalise(node.attrs.alt ?? "");
  return normalise(fromContent(node));
}

/** The text a person reads inside a node, content hidden from assistive
 * technology excluded. */
export function visibleText(node: DomNode): string {
  return normalise(fromContent(node));
}
