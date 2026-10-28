import test from "node:test";
import assert from "node:assert/strict";
import * as brand from "./brand.ts";
import { brandHeader } from "./brand.ts";
import { visibleLength, stripAnsi } from "./layout.ts";
import type { TerminalCapabilities } from "./types.ts";

const colorCaps = (columns: number): TerminalCapabilities => ({
  columns,
  rows: 24,
  colorDepth: 24,
  ansi: true,
  reason: "interactive",
  interactive: true,
});

const graphicsCaps = (columns: number): TerminalCapabilities => ({
  ...colorCaps(columns),
  graphicsProtocol: "kitty",
});

const monoCaps = (columns: number): TerminalCapabilities => ({
  ...colorCaps(columns),
  colorDepth: 0,
});

test("non-graphics terminals show the NOMO wordmark without a substitute mark", () => {
  for (const width of [20, 40, 80, 120, 160]) {
    const output = brandHeader("NOMO", colorCaps(width));
    assert.equal(output.length, 1);
    assert.match(stripAnsi(output[0] ?? ""), /^ NOMO/);
    assert.doesNotMatch(output.join(""), /⌜⊡⌝/);
    assert.ok(output.every((line) => visibleLength(line) <= width));

    const mono = brandHeader("NOMO", monoCaps(width));
    assert.equal(mono.length, 1);
    assert.ok(mono.every((line) => !line.includes("\x1b")));
    assert.match(mono[0] ?? "", /^ NOMO/);
  }
});

test("Ghostty receives the original logo as a cropped Kitty image placement", () => {
  const output = brandHeader("NOMO / visual-fixture", graphicsCaps(80));
  const plain = stripAnsi(output.join("\n"));
  assert.equal(output.length, 6);
  assert.equal([...plain].filter((point) => point === "\u{10eeee}").length, 54);
  assert.match(output[0] ?? "", /\x1b_Ga=p,U=1/);
  assert.ok(output.every((line) => visibleLength(line) <= 80));
  assert.doesNotMatch(plain, /⌜⊡⌝/);
  assert.match(plain, /visual-fixture/);

  const transfer = brand.kittyLogoTransfer();
  assert.match(transfer, /\x1b_Ga=t,f=100,i=\d+,q=2,m=1;/);
  assert.match(transfer, /\x1b_Ga=t,f=100,i=\d+,q=2,m=0;/);
  const encoded = [...transfer.matchAll(/\x1b_G[^;]*;([A-Za-z0-9+/=]+)\x1b\\/g)]
    .map((match) => match[1] ?? "")
    .join("");
  const png = Buffer.from(encoded, "base64");
  assert.deepEqual(
    [...png.subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
  );
  assert.equal(png.readUInt32BE(16), 340);
  assert.equal(png.readUInt32BE(20), 430);
  assert.match(brand.kittyLogoCleanup(), /\x1b_Ga=d,d=I,i=\d+,q=2\x1b\\/);
});

test("the logo label remains recognizable at narrow widths", () => {
  const output = brandHeader("NOMO / visual-fixture", colorCaps(20));
  assert.equal(output.length, 1);
  assert.ok(visibleLength(output[0] ?? "") <= 20);
  assert.match(stripAnsi(output[0] ?? ""), /^ NOMO/);
});

test("Kitty image commands do not consume terminal cells", () => {
  const command = "\x1b_Ga=p,U=1,i=42,c=9,r=6\x1b\\";
  assert.equal(visibleLength(`${command}NOMO`), 4);
  assert.equal(visibleLength("\u{10eeee}"), 1);
  assert.equal(stripAnsi(command), "");
});
