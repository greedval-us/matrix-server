#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const oidPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const isDeletion = oid => /^0+$/.test(oid);

function git(args) {
  try {
    return execFileSync('git', ['--no-replace-objects', ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
    }).trim();
  } catch {
    throw new Error('Cannot inspect outgoing history. Fetch the remote history and retry; no push was approved.');
  }
}

try {
  if (git(['rev-parse', '--is-shallow-repository']) !== 'false') {
    throw new Error('Publication requires complete history. Fetch with --unshallow and retry.');
  }
  const commits = new Set();
  for (const line of readFileSync(0, 'utf8').split(/\r?\n/).filter(Boolean)) {
    const parts = line.split(/\s+/);
    if (parts.length !== 4 || !oidPattern.test(parts[1]) || !oidPattern.test(parts[3])) {
      throw new Error('Invalid Git pre-push input; no push was approved.');
    }
    const [, localOid, , remoteOid] = parts;
    if (isDeletion(localOid)) continue;
    const tip = git(['rev-parse', '--verify', `${localOid}^{commit}`]);
    // A force-push may rewind to an ancestor, leaving the outgoing range empty.
    commits.add(tip);
    const exclusions = isDeletion(remoteOid) ? [] : [`^${git(['rev-parse', '--verify', `${remoteOid}^{commit}`])}`];
    for (const commit of git(['rev-list', tip, ...exclusions]).split('\n').filter(Boolean)) commits.add(commit);
  }
  const checker = fileURLToPath(new URL('./checkPublication.mjs', import.meta.url));
  for (const commit of commits) {
    const result = spawnSync(process.execPath, [checker, `--ref=${commit}`], { stdio: 'inherit' });
    if (result.error || result.status !== 0) throw new Error(`Publication refused for commit ${commit.slice(0, 12)}.`);
  }
  console.log(`Publication pre-push: ${commits.size} outgoing commits checked.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
