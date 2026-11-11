import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repository = fileURLToPath(new URL('../', import.meta.url));
const checker = path.join(repository, 'scripts', 'checkPublication.mjs');
const portableFiles = {
  'compose.yaml': 'services:\n  api:\n    image: node:lts\n',
  'compose.storage.yaml': 'volumes:\n  search-data:\n',
  '.env.example': 'API_HOST=localhost\n',
  '.env.compose.example': 'TLS_DIR=./docker/tls\n',
  'templates/.env.worker.example': 'WORKER_COUNT=1\n',
  'README.md': 'Portable source fixture.\n',
};
const privateDeploymentFiles = [
  'compose.server.yaml',
  'compose.server.yml',
  'compose.override.yaml',
  'compose.override.yml',
  'compose.worker.local.yaml',
  'compose.worker.local.yml',
  'nested/compose.server.yaml',
  'nested/compose.override.yml',
  'nested/compose.worker.local.yaml',
  'deployment-config/runtime.env',
  'deployment-config/compose.yaml',
  'deployment-config/tls/README.md',
  'nested/deployment-config/notes.txt',
];
const privateLocalFiles = [
  '.env',
  '.env.runtime',
  'runtime.env',
  'nested/runtime.env',
  'web-admin/password.hash',
  'web-admin/db-password',
  'tls/server.der',
  'tls/id_rsa.pub',
  '.cache/operation.txt',
  'runtime/operations.txt',
  '.aws/credentials',
  '.ssh/known_hosts',
  '.npmrc',
  'nested/.aws/credentials',
  'nested/.ssh/known_hosts',
  'nested/.npmrc',
];

async function writeFile(root, filename, contents) {
  const target = path.join(root, filename);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents);
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-publication-'));
  t.after(async () => {
    const target = path.resolve(root);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('matrix-publication-'));
    await fs.rm(target, { recursive: true, force: true });
  });
  execFileSync('git', ['init', '--quiet', root], { stdio: 'pipe' });
  for (const filename of ['.gitignore', '.dockerignore']) {
    await fs.copyFile(path.join(repository, filename), path.join(root, filename));
  }
  for (const [filename, contents] of Object.entries(portableFiles)) {
    await writeFile(root, filename, contents);
  }
  return root;
}

function check(root, ...args) {
  const result = spawnSync(process.execPath, [checker, ...args], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.ifError(result.error);
  return { ...result, output: result.stdout + result.stderr };
}

async function exportedFiles(root) {
  const entries = await fs.readdir(root, { recursive: true });
  const files = [];
  for (const entry of entries) {
    if ((await fs.lstat(path.join(root, entry))).isFile()) files.push(entry.replaceAll('\\', '/'));
  }
  return files.sort();
}

test('Git ignores private deployment configuration while portable source exports successfully', async t => {
  const root = await fixture(t);
  for (const filename of [...privateDeploymentFiles, ...privateLocalFiles]) {
    await writeFile(root, filename, 'Private deployment fixture.\n');
    const ignored = spawnSync('git', ['check-ignore', '--no-index', '--quiet', '--', filename], { cwd: root });
    assert.equal(ignored.status, 0, `${filename} must stay outside publication candidates`);
  }
  const result = check(root, '--export=output/portable-source');
  assert.equal(result.status, 0, result.output);
  const target = path.join(root, 'output', 'portable-source');
  assert.deepEqual(await exportedFiles(target), ['.dockerignore', '.gitignore', ...Object.keys(portableFiles)].sort());
  for (const [filename, contents] of Object.entries(portableFiles)) {
    assert.equal(await fs.readFile(path.join(target, filename), 'utf8'), contents);
  }
});

test('force-tracked private deployment and runtime files fail audit and prevent source export', async t => {
  for (const filename of [...privateDeploymentFiles, ...privateLocalFiles]) {
    await t.test(filename, async subtest => {
      const root = await fixture(subtest);
      await writeFile(root, filename, 'Private deployment fixture.\n');
      execFileSync('git', ['add', '--force', '--', filename], { cwd: root, stdio: 'pipe' });

      const audit = check(root);
      assert.equal(audit.status, 1, audit.output);
      assert.ok(audit.output.includes(filename), audit.output);

      const exported = check(root, '--export=output/blocked-source');
      assert.equal(exported.status, 1, exported.output);
      await assert.rejects(fs.stat(path.join(root, 'output', 'blocked-source')), { code: 'ENOENT' });
    });
  }
});
