import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const rootPackage = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const uiPackage = JSON.parse(readFileSync(new URL("../../apps/control-plane/ui/package.json", import.meta.url), "utf8"));
const buildScript = readFileSync(new URL("./build-web.mjs", import.meta.url), "utf8");

test("private control-plane UI identity and local filters use the void package name", () => {
  assert.equal(uiPackage.name, "@void/control-plane-ui");
  assert.match(rootPackage.scripts.typecheck, /pnpm --filter @void\/control-plane-ui typecheck/);
  assert.match(rootPackage.scripts["dev:web"], /pnpm --filter @void\/control-plane-ui dev/);
  assert.match(buildScript, /"@void\/control-plane-ui"/);
  assert.doesNotMatch(buildScript, /"@nomo\/control-plane-ui"/);
});
