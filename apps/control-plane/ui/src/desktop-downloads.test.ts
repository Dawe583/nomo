import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { DESKTOP_DOWNLOADS } from "./desktop-downloads.ts";

test("desktop download links match the published beta 4 assets", async () => {
  assert.match(
    DESKTOP_DOWNLOADS.macos,
    /desktop-v0\.1\.0-beta\.4\/VOID_0\.1\.0_aarch64\.dmg$/,
  );
  assert.match(
    DESKTOP_DOWNLOADS.windows,
    /desktop-v0\.1\.0-beta\.4\/VOID_0\.1\.0_x64-setup\.exe$/,
  );
  const site = await readFile(
    join(import.meta.dirname, "../../../../site/index.html"),
    "utf8",
  );
  assert.match(
    site,
    new RegExp(DESKTOP_DOWNLOADS.macos.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.match(
    site,
    new RegExp(
      DESKTOP_DOWNLOADS.windows.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    ),
  );
});
