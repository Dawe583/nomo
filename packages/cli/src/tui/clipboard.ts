import { spawn } from "node:child_process";

const COMMANDS: Readonly<
  Record<string, readonly (readonly [string, string[]])[]>
> = {
  darwin: [["pbcopy", ["-Prefer", "txt"]]],
  win32: [["clip.exe", []]],
  linux: [
    ["wl-copy", []],
    ["xclip", ["-selection", "clipboard"]],
    ["xsel", ["--clipboard", "--input"]],
  ],
};
function tryCopy(
  command: string,
  args: string[],
  value: string,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn(command, args, {
      env:
        process.platform === "darwin"
          ? { ...process.env, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" }
          : process.env,
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
    });
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      finish(false);
    }, 2000);
    const finish = (copied: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(copied);
    };
    child.once("error", () => {
      child.kill();
      finish(false);
    });
    child.once("close", (code) => finish(code === 0));
    child.stdin?.once("error", () => {
      child.kill();
      finish(false);
    });
    child.stdin?.end(value, "utf8");
  });
}

/** Copy text through the OS clipboard command without invoking a shell. */
async function writeTextToClipboard(value: string): Promise<void> {
  if (value.length === 0) throw Error("There is no prompt to copy.");
  for (const [command, args] of COMMANDS[process.platform] ?? []) {
    if (await tryCopy(command, [...args], value)) return;
  }
  throw Error("Clipboard is unavailable. Use your terminal's copy controls.");
}

let clipboardWriteQueue: Promise<void> = Promise.resolve();

/** Serialize prompt and mouse-selection writes so the newest gesture wins. */
export function copyTextToClipboard(value: string): Promise<void> {
  const write = clipboardWriteQueue.then(() => writeTextToClipboard(value));
  clipboardWriteQueue = write.catch(() => undefined);
  return write;
}
