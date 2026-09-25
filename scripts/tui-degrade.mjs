import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const preview = resolve(root, "packages/cli/src/tui/preview.ts");
const widths = [80, 120, 200];
const cases = [
  ["piped", {}],
  ["NO_COLOR", { NO_COLOR: "1" }],
  ["TERM=dumb", { TERM: "dumb" }],
  ["CI", { CI: "1" }],
];

const emoji = /[\p{Extended_Pictographic}\uFE0F]/u;
const control = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
const unexpectedUnicode = /[^\x20-\x7E\n\r\t\u2580\u2584\u2588]/;

function quote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function runInPty(width, env) {
  const command = `stty cols ${width} rows 40; exec ${quote(process.execPath)} ${quote(preview)} ${width} 40 --hold --modal`;
  if (process.platform === "darwin") {
    const program =
      "set timeout 15; spawn -noecho sh -c $env(VOID_TUI_COMMAND); expect eof; set result [wait]; exit [lindex $result 3]";
    return spawnSync("expect", ["-c", program], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, ...env, VOID_TUI_COMMAND: command },
    });
  }
  return spawnSync("script", ["-q", "-c", command, "/dev/null"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function runPreview(name, additions, width) {
  const env = { ...process.env, TERM: "xterm-256color", ...additions };
  if (!("CI" in additions)) delete env.CI;
  if (!("NO_COLOR" in additions)) delete env.NO_COLOR;
  const run =
    name === "piped"
      ? spawnSync(
          process.execPath,
          [preview, String(width), "40", "--hold", "--modal"],
          { cwd: root, encoding: "utf8", env },
        )
      : runInPty(width, env);
  if (run.status !== 0)
    throw new Error(`${name} ${width} render failed:\n${run.stderr}`);
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  if (/\u001b\[/.test(output))
    throw new Error(`${name} ${width} leaked ANSI escape sequences`);
  if (emoji.test(output))
    throw new Error(`${name} ${width} leaked an emoji into the ASCII identity`);
  if (control.test(output))
    throw new Error(`${name} ${width} leaked terminal control characters`);
  if (unexpectedUnicode.test(output))
    throw new Error(`${name} ${width} leaked non-ASCII terminal content`);
  const plain = output.replaceAll("\r", "");
  const longest = Math.max(0, ...plain.split("\n").map((line) => line.length));
  if (longest > width)
    throw new Error(`${name} ${width} overran: longest line was ${longest}`);
  for (const text of [
    "WRITE PATH",
    "ACTION REQUIRED",
    "[0] R0",
    "[1] R1",
    "[2] R2",
    "[3] R3",
  ]) {
    if (!output.includes(text))
      throw new Error(`${name} ${width} render lost ${text}`);
  }
}

for (const [name, additions] of cases) {
  for (const width of widths) {
    runPreview(name, additions, width);
    console.log(`${name.padEnd(10)} ${String(width).padStart(3)} cols  ok  ANSI=0  ASCII=yes  safety information=complete`);
  }
}
