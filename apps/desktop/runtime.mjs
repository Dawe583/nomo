/** The desktop owns this process through stdin. No provider or policy logic lives here. */
import { existsSync } from 'node:fs';
import { mkdir, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * Read an owned setting, falling back to the name it carried before the
 * rename.
 *
 * The rule is one line and it is duplicated here on purpose: this runtime is
 * plain Node ESM that cannot import the TypeScript workspace package, and the
 * two spellings must resolve identically on both sides of that boundary. A
 * present current name wins, including when its value is empty, because an
 * operator who exported an empty value chose it.
 */
function ownedValue(env, key) {
  return env[key] ?? env[`VOID_${key.slice('NOMO_'.length)}`];
}

process.umask(0o077);
const dataDir = ownedValue(process.env, 'NOMO_DATA_DIR');
const webRoot = ownedValue(process.env, 'NOMO_DESKTOP_WEB_ROOT');
if (!dataDir || !webRoot) throw new Error('Desktop runtime requires explicit data and web directories.');
await mkdir(dataDir, { recursive: true, mode: 0o700 });
await chmod(dataDir, 0o700);
// A desktop instance is loopback-only and does not inherit cloud operator
// credentials, whichever name the exporting shell used for them.
delete process.env.NOMO_CONTROL_TOKEN;
delete process.env.VOID_CONTROL_TOKEN;
// The backend and the workbench below read the current names, so the resolved
// values are published under them rather than left to be looked up twice.
process.env.NOMO_DATA_DIR = resolve(dataDir);
process.env.NOMO_DESKTOP_WEB_ROOT = webRoot;
process.env.NOMO_LEDGER_DIR ??= ownedValue(process.env, 'NOMO_LEDGER_DIR') ?? join(dataDir, 'ledger');
const packaged = new URL('./backend.mjs', import.meta.url);
const backend = existsSync(packaged) ? packaged : new URL('../control-plane/api/server.ts', import.meta.url);
const { createControlPlaneServer } = await import(backend.href);
const server = createControlPlaneServer({ env: process.env, webRoot });
// The workbench consumes this key synchronously; MCP child processes never inherit it.
delete process.env.NOMO_WORKSPACE_KEY;
delete process.env.VOID_WORKSPACE_KEY;
await new Promise((resolveListen, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolveListen(); });
});
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Desktop runtime did not bind loopback.');
process.stdout.write(`${JSON.stringify({ port: address.port, pid: process.pid })}\n`);
let closing = false;
function stop() {
  if (closing) return;
  closing = true;
  server.close(() => process.exit(0));
  server.closeAllConnections();
  setTimeout(() => process.exit(0), 4000).unref();
}
process.stdin.resume();
process.stdin.once('end', stop);
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
