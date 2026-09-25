import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
// fileURLToPath, never URL#pathname. A Windows file URL's pathname is
// "/C:/dir/e2e-final.mjs", and Windows path normalization turns that leading
// slash into a drive-relative "\C:\dir\e2e-final.mjs", which resolves to
// "C:\C:\dir\e2e-final.mjs" and fails to load. POSIX pathname is already the
// absolute path, so the bug is invisible on ubuntu-latest and macOS.
const script = fileURLToPath(new URL("./e2e-final.mjs", import.meta.url));
const root = new URL("../..", import.meta.url);

describe("final e2e sweep", () => {
  test("runs the product moments through the script", async () => {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [script, "all"],
      { cwd: root, timeout: 30000, maxBuffer: 1024 * 1024 },
    );

    assert.equal(stderr, "");
    assert.match(stdout, /PASS full product stdio moment/);
    assert.match(stdout, /PASS attestation moment/);
    assert.match(stdout, /PASS tamper moment/);
    assert.match(stdout, /PASS feed moment/);
    assert.doesNotMatch(stdout, /FAIL /);
    assert.match(stdout, /^(PASS|NOTE) /m);
  });
});
