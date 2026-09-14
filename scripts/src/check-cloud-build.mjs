/** Fail the deployment before upload if its frontend or API entrypoint is missing. */
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const output = resolve(process.argv[2] ?? fileURLToPath(new URL('../../.vercel/output/', import.meta.url)));
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const file = (root, name) => {
  const path = resolve(root, name), local = relative(root, path);
  assert(local && !local.startsWith('..') && !isAbsolute(local), `Build path escapes its output: ${name}`);
  assert(statSync(path).isFile() && statSync(path).size > 0, `Missing or empty build file: ${name}`);
  return path;
};
const config = json(file(output, 'config.json'));
assert.equal(config.version, 3, 'Expected Vercel Build Output API v3');
assert(config.routes.some(route => route.dest === '/__server'), 'Cloud API route is missing');
const staticRoot = resolve(output, 'static');
const html = readFileSync(file(staticRoot, 'index.html'), 'utf8');
const assets = [...html.matchAll(/(?:src|href)="(\/[^"?#]+)(?:[?#][^"]*)?"/g)].map(match => match[1].slice(1));
assert(assets.some(asset => asset.endsWith('.js')), 'Built GUI script is missing');
assert(assets.some(asset => asset.endsWith('.css')), 'Built GUI stylesheet is missing');
for (const asset of assets) file(staticRoot, asset);
const apiRoot = resolve(output, 'functions/__server.func');
const api = json(file(apiRoot, '.vc-config.json'));
assert.match(api.runtime, /^nodejs\d+\.x$/, 'Cloud API must use the Node runtime');
assert.equal(api.supportsResponseStreaming, true, 'Agent streaming support is missing');
file(apiRoot, api.handler);
console.log(`VOID cloud artifact verified: ${assets.length} frontend assets, Node API and streaming route.`);
