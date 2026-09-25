import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
// fileURLToPath, never URL#pathname. A Windows file URL's pathname is
// "/C:/dir/moment.mjs", and Windows path normalization turns that leading slash
// into a drive-relative "\C:\dir\moment.mjs", which resolves to
// "C:\C:\dir\moment.mjs" and fails to load. POSIX pathname is already the
// absolute path, so the bug is invisible on ubuntu-latest and macOS.
const moment = fileURLToPath(new URL("./moment.mjs", import.meta.url));

async function runMoment(...args) {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [moment, ...args],
    { cwd: new URL("../..", import.meta.url), timeout: 5000 },
  );
  assert.equal(stderr, "");
  return stdout;
}

describe("moment runner", () => {
  test("prints denied and approved moments", async () => {
    const stdout = await runMoment();

    assert.match(stdout, /moment: postgres delete denied/);
    assert.match(stdout, /cancelled by cli/);
    assert.match(stdout, /orders unchanged: 41883 rows/);
    assert.match(stdout, /moment: postgres delete approved/);
    assert.match(stdout, /approved by cli/);
    assert.match(stdout, /forwarded/);
    assert.match(stdout, /simulated result: 2 rows deleted/);
    assert.equal(stdout.match(/ledger records: 2/g)?.length, 2);
  });

  test("prints approval frames for a pending then resolved hold", async () => {
    const stdout = await runMoment("--tui");
    const secondHeader = stdout.indexOf("\n\nVOID APPROVALS", 1);
    const frames = [
      stdout.slice(0, secondHeader),
      stdout.slice(secondHeader + 2),
    ];

    assert.notEqual(secondHeader, -1);
    assert.match(frames[0], /VOID APPROVALS/);
    assert.match(frames[0], /postgres\.row\.delete/);
    assert.match(frames[0], /02:00/);
    assert.match(frames[1], /No held calls\./);
  });
});
