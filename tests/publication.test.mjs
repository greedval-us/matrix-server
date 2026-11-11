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

function publicationGit(directory, args, input) {
  const result = spawnSync('git', ['-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', '-c', 'user.name=Publication Test', '-c', 'user.email=publication@example.invalid', ...args], { cwd: directory, input, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function publicationCheck(directory, ...args) {
  const result = spawnSync(process.execPath, [checker, ...args], { cwd: directory, encoding: 'utf8' });
  assert.ifError(result.error);
  return { ...result, output: result.stdout + result.stderr };
}

test('staged publication reads the complete index even after working-tree content changes or disappears', async t => {
  const directory = await fixture(t);
  const endpoint = ['192', '168', '42', '23'].join('.');
  await fs.writeFile(path.join(directory, 'connection.js'), `export const endpoint = '${endpoint}';\n`);
  publicationGit(directory, ['add', '.']);
  publicationGit(directory, ['commit', '--quiet', '-m', 'existing unsafe fixture']);
  for (const state of ['clean', 'missing']) {
    if (state === 'clean') await fs.writeFile(path.join(directory, 'connection.js'), 'export const endpoint = "localhost";\n');
    else await fs.unlink(path.join(directory, 'connection.js'));
    const result = publicationCheck(directory, '--staged');
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /connection\.js:1: private network address/);
    assert.ok(!result.output.includes(endpoint));
  }
  publicationGit(directory, ['rm', '--cached', '--', 'connection.js']);
  assert.equal(publicationCheck(directory, '--staged').status, 0);
});

test('reference publication checks committed bytes and rejects invalid or incompatible options', async t => {
  const directory = await fixture(t);
  const endpoint = ['192', '168', '42', '23'].join('.');
  await fs.writeFile(path.join(directory, 'connection.js'), endpoint);
  publicationGit(directory, ['add', '.']);
  publicationGit(directory, ['commit', '--quiet', '-m', 'fixture']);
  await fs.writeFile(path.join(directory, 'connection.js'), 'localhost');
  const result = publicationCheck(directory, '--ref=HEAD');
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /connection\.js:1: private network address/);
  assert.ok(!result.output.includes(endpoint));
  for (const args of [['--ref='], ['--ref=missing'], ['--ref=--all'], ['--ref=HEAD^{tree}'], ['--ref=HEAD', '--staged'], ['--ref=HEAD', '--export=output/no'], ['--staged', '--staged']]) {
    assert.equal(publicationCheck(directory, ...args).status, 1, args.join(' '));
  }
});

test('Git snapshot checks refuse symlinks, gitlinks and unresolved index entries', async t => {
  const directory = await fixture(t);
  publicationGit(directory, ['add', '.']);
  publicationGit(directory, ['commit', '--quiet', '-m', 'fixture']);
  const blob = publicationGit(directory, ['hash-object', '-w', '--stdin'], 'external-target');
  const commit = publicationGit(directory, ['rev-parse', 'HEAD']);
  publicationGit(directory, ['update-index', '--add', '--cacheinfo', `120000,${blob},linked-file`]);
  publicationGit(directory, ['update-index', '--add', '--cacheinfo', `160000,${commit},nested-repository`]);
  let result = publicationCheck(directory, '--staged');
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /linked-file:1: symbolic link/);
  assert.match(result.output, /nested-repository:1: .*gitlink|nested-repository:1: .*submodule/);
  publicationGit(directory, ['commit', '--quiet', '-m', 'unsupported entries']);
  result = publicationCheck(directory, '--ref=HEAD');
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /linked-file:1: symbolic link/);
  assert.match(result.output, /nested-repository:1: .*gitlink|nested-repository:1: .*submodule/);
  publicationGit(directory, ['update-index', '--index-info'], `100644 ${blob} 1\tunresolved.js\n100644 ${blob} 2\tunresolved.js\n`);
  result = publicationCheck(directory, '--staged');
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /unresolved\.js:1: unresolved index/);
});

test('forced private, generated and planning paths fail while templates and migrations remain publishable', async t => {
  const directory = await fixture(t);
  const privatePaths = [
    'nested/.npmrc', 'nested/.aws/credentials', 'nested/.ssh/known_hosts', 'runtime.env', 'password.hash',
    'db-password', 'tls/id_rsa.pub', 'tls/server.der', '.claude/settings.json', '.codebase-memory/index.json',
    'docs/implementation-plan.md', 'diagnostic.log', 'backup.zip', 'database.sqlite', 'runtime/operations.txt',
    '.worktrees/feature/source.js', '.idea/workspace.xml', '.nyc_output/coverage.json',
    'test-results/report.json', 'playwright-report/index.html', 'generated/protocol.js',
    '.vscode/local-session.json', 'nested/.vscode/history/session.json',
  ];
  for (const filename of privatePaths) {
    await fs.mkdir(path.dirname(path.join(directory, filename)), { recursive: true });
    await fs.writeFile(path.join(directory, filename), 'local fixture\n');
  }
  publicationGit(directory, ['add', '--force', '--', ...privatePaths]);
  const result = publicationCheck(directory, '--staged');
  assert.equal(result.status, 1, result.output);
  for (const filename of privatePaths) assert.ok(result.output.includes(`${filename}:1:`), filename);
  const worktree = publicationCheck(directory);
  assert.equal(worktree.status, 1, worktree.output);
  for (const filename of privatePaths) assert.ok(worktree.output.includes(`${filename}:1:`), filename);
  publicationGit(directory, ['rm', '--cached', '--', ...privatePaths]);
  for (const filename of ['.env.example', 'nested/.env.worker.sample', 'migrations/001_schema.sql', 'templates/compose.yaml', '.vscode/settings.json', '.vscode/extensions.json', '.vscode/launch.json', '.vscode/tasks.json']) {
    await fs.mkdir(path.dirname(path.join(directory, filename)), { recursive: true });
    await fs.writeFile(path.join(directory, filename), 'portable fixture\n');
    publicationGit(directory, ['add', '--force', '--', filename]);
  }
  const clean = publicationCheck(directory, '--staged');
  assert.equal(clean.status, 0, clean.output);
});
