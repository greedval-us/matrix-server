#!/usr/bin/env node
import { chmod, readdir } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const existing = spawnSync('git', ['config', '--get', 'core.hooksPath'], { cwd: root, encoding: 'utf8' });
if (existing.error || ![0, 1].includes(existing.status)) throw new Error('Cannot inspect existing Git hooks.');
if (existing.status === 0 && existing.stdout.trim() !== '.githooks') {
  throw new Error('A different hooksPath is already configured. Integrate the publication hooks there before replacing it.');
}
if (existing.status === 1) {
  const hooks = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd: root, encoding: 'utf8' }).trim();
  let entries;
  try { entries = await readdir(path.resolve(root, hooks), { withFileTypes: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; entries = []; }
  if (entries.some(entry => !entry.isDirectory() && !entry.name.endsWith('.sample'))) {
    throw new Error('An existing default Git hook would be bypassed. Integrate publication checks before replacing it.');
  }
}
for (const hook of ['pre-commit', 'pre-push']) {
  await chmod(fileURLToPath(new URL(`../.githooks/${hook}`, import.meta.url)), 0o755);
}
execFileSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], { cwd: root, stdio: 'inherit' });
console.log('Publication pre-commit and pre-push hooks installed for this repository.');
