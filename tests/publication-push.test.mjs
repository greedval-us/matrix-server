import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const pushChecker = fileURLToPath(new URL('../scripts/checkPush.mjs', import.meta.url));
const hookDirectory = fileURLToPath(new URL('../.githooks/', import.meta.url));
const zero = '0'.repeat(40);
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-push-check-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.name', 'Publication Test']);
  git(root, ['config', 'user.email', 'publication@example.invalid']);
  async function commit(content) {
    await fs.writeFile(path.join(root, 'source.js'), content);
    git(root, ['add', 'source.js']);
    git(root, ['commit', '--quiet', '-m', 'fixture']);
    return git(root, ['rev-parse', 'HEAD']);
  }
  return { root, commit };
}

function check(root, tip, remote = zero) {
  return spawnSync(process.execPath, [pushChecker], {
    cwd: root, encoding: 'utf8', input: `refs/heads/main ${tip} refs/heads/main ${remote}\n`,
  });
}

test('pre-push rejects unsafe intermediate history even when the tip and worktree are clean', async t => {
  const { root, commit } = await fixture(t);
  const base = await commit('export const safe = true;\n');
  const secret = ['192', '168', '25', '19'].join('.');
  await commit(`const host = '${secret}';\n`);
  const tip = await commit('export const safe = false;\n');
  for (const remote of [zero, base]) {
    const result = check(root, tip, remote);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /private network address/);
    assert.ok(!result.stdout.includes(secret));
  }
});

test('pre-push checks clean outgoing history and accepts branch deletion', async t => {
  const { root, commit } = await fixture(t);
  const base = await commit('export const first = true;\n');
  const tip = await commit('export const second = true;\n');
  const result = check(root, tip, base);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /1 outgoing commits checked/);
  assert.equal(check(root, zero, tip).status, 0);
});

test('pre-push checks a rewind destination even when no commits are newly reachable', async t => {
  const { root, commit } = await fixture(t);
  const unsafe = await commit(`const host = '${['192', '168', '25', '19'].join('.')}';\n`);
  const remoteTip = await commit('export const safe = true;\n');
  const result = check(root, unsafe, remoteTip);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /private network address/);
});

test('pre-push refuses unavailable remote objects, malformed input and incomplete history', async t => {
  const { root, commit } = await fixture(t);
  const tip = await commit('export const safe = true;\n');
  assert.equal(check(root, tip, 'f'.repeat(40)).status, 1);
  const malformed = spawnSync(process.execPath, [pushChecker], { cwd: root, encoding: 'utf8', input: 'invalid\n' });
  assert.equal(malformed.status, 1);
  await fs.writeFile(path.join(root, '.git', 'shallow'), `${tip}\n`);
  const shallow = check(root, tip);
  assert.equal(shallow.status, 1);
  assert.match(shallow.stderr, /complete history/);
});

test('installed pre-commit hook blocks the staged bytes despite a clean worktree', async t => {
  const { root } = await fixture(t);
  const scripts = path.join(root, 'scripts');
  await fs.mkdir(scripts);
  await fs.copyFile(path.join(path.dirname(pushChecker), 'checkPublication.mjs'), path.join(scripts, 'checkPublication.mjs'));
  await fs.cp(path.join(path.dirname(pushChecker), 'publication'), path.join(scripts, 'publication'), { recursive: true });
  const hooks = path.join(root, '.githooks');
  await fs.cp(hookDirectory, hooks, { recursive: true });
  await fs.chmod(path.join(hooks, 'pre-commit'), 0o755);
  const secret = ['192', '168', '25', '19'].join('.');
  await fs.writeFile(path.join(root, 'source.js'), `const host = '${secret}';\n`);
  git(root, ['add', 'source.js']);
  await fs.writeFile(path.join(root, 'source.js'), 'export const safe = true;\n');
  const result = spawnSync('git', ['-c', 'core.hooksPath=.githooks', 'commit', '--quiet', '-m', 'must fail'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /private network address/);
  assert.ok(!(result.stdout + result.stderr).includes(secret));
});

test('hook installation preserves active default hooks and existing hook configuration', async t => {
  const { root } = await fixture(t);
  const scripts = path.join(root, 'scripts');
  await fs.mkdir(scripts);
  const installer = path.join(scripts, 'installHooks.mjs');
  await fs.copyFile(path.join(path.dirname(pushChecker), 'installHooks.mjs'), installer);
  await fs.cp(hookDirectory, path.join(root, '.githooks'), { recursive: true });
  const run = () => spawnSync(process.execPath, [installer], { cwd: root, encoding: 'utf8' });
  for (const name of ['pre-commit', 'commit-msg', 'post-checkout']) {
    const defaultHook = path.join(root, '.git', 'hooks', name);
    await fs.writeFile(defaultHook, '#!/bin/sh\nexit 0\n');
    assert.equal(run().status, 1);
    assert.equal(spawnSync('git', ['config', '--local', '--get', 'core.hooksPath'], { cwd: root }).status, 1);
    await fs.unlink(defaultHook);
  }
  git(root, ['config', 'core.hooksPath', 'custom-hooks']);
  assert.equal(run().status, 1);
  assert.equal(git(root, ['config', '--get', 'core.hooksPath']), 'custom-hooks');
  git(root, ['config', '--unset', 'core.hooksPath']);
  assert.equal(run().status, 0);
  assert.equal(git(root, ['config', '--get', 'core.hooksPath']), '.githooks');
});
