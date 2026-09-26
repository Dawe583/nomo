import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveBuildPolicy } from './build-policy.mjs';
const desktop = fileURLToPath(new URL('../', import.meta.url));
const policy = resolveBuildPolicy({
  platform: process.platform,
  distribution: process.env.VOID_DISTRIBUTION,
  env: process.env,
});
// The build log names the identity the policy resolved and where it came from,
// so a keychain failure after a rebuild can be traced to a signing decision.
if (process.platform === 'darwin') {
  console.error(`desktop signing: ${policy.signingIdentity} (${policy.signingIdentitySource})`);
}
// Avoid Finder AppleScript automation during DMG creation. The installer still
// contains the application and Applications shortcut, without interactive layout.
const child = spawn(process.execPath, [fileURLToPath(new URL('../node_modules/@tauri-apps/cli/tauri.js', import.meta.url)), 'build', ...(process.platform === 'win32' ? ['--config', 'src-tauri/tauri.windows.conf.json'] : []), ...process.argv.slice(2)], {
  cwd: desktop,
  env: { ...process.env, CI: 'true', ...(process.platform === 'darwin' ? { APPLE_SIGNING_IDENTITY: policy.signingIdentity } : {}) },
  stdio: 'inherit',
});
child.once('error', error => { console.error(`Could not start the desktop build: ${error.message}`); process.exitCode = 1; });
child.once('exit', (code, signal) => { process.exitCode = signal ? 1 : code ?? 1; });
