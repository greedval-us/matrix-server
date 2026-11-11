#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { contentFindings, identifierFindings } from './publication/contentPolicy.mjs';
import { isPlanningDocument, pathFinding } from './publication/pathPolicy.mjs';
import { readGitSnapshot } from './publication/gitSnapshot.mjs';

function inspectFile(filename, bytes, options) {
  const findings = identifierFindings(filename);
  const rule = pathFinding(filename, options);
  if (rule) findings.push({ filename, line: 1, rule });
  else findings.push(...contentFindings(filename, bytes));
  return findings;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function linkedSource(repository, realRepository, filename) {
  const segments = filename.split(/[\\/]/);
  let ancestor = repository;
  for (const segment of segments.slice(0, -1)) {
    ancestor = path.join(ancestor, segment);
    if ((await fs.lstat(ancestor)).isSymbolicLink()) return true;
  }
  return !isWithin(realRepository, await fs.realpath(path.join(repository, filename)));
}

async function inspectWorktree(repository, options) {
  const realRepository = await fs.realpath(repository);
  let filenames;
  try {
    filenames = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\0').filter(Boolean);
  } catch {
    throw new Error('Cannot list publication candidates; run this check inside a Git repository.');
  }
  let scanned = 0;
  const findings = [];
  const files = [];
  for (const filename of new Set(filenames)) {
    const fullPath = path.join(repository, filename);
    let entry;
    try { entry = await fs.lstat(fullPath); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (entry.isSymbolicLink()) {
      findings.push({ filename, line: 1, rule: 'symbolic link requires separate review' });
      continue;
    }
    if (!entry.isFile()) {
      findings.push({ filename, line: 1, rule: 'non-file publication candidate requires separate review' });
      continue;
    }
    if (await linkedSource(repository, realRepository, filename)) {
      findings.push({ filename, line: 1, rule: 'ancestor link or file outside repository requires separate review' });
      continue;
    }
    scanned += 1;
    const bytes = await fs.readFile(fullPath);
    findings.push(...inspectFile(filename, bytes, options));
    files.push({ filename, bytes });
  }
  return { scanned, findings, files };
}

function inspectSnapshot(repository, reference) {
  const { files, findings } = readGitSnapshot(repository, reference);
  for (const { filename, bytes } of files) findings.push(...inspectFile(filename, bytes));
  return { scanned: files.length, findings, files };
}

async function exportSources(repository, requestedTarget, files) {
  const targetName = String(requestedTarget).replaceAll('\\', '/');
  if (!/^output\/[a-z0-9][a-z0-9._-]*$/i.test(targetName)) {
    throw new Error('Export target must be a fresh directory directly inside output/.');
  }
  try {
    execFileSync('git', ['check-ignore', '--no-index', '--quiet', '--', `${targetName}/publication-check`], { cwd: repository, stdio: 'ignore' });
  } catch {
    throw new Error('Export target must be ignored by this repository.');
  }
  const outputRoot = path.join(repository, 'output');
  try {
    const outputEntry = await fs.lstat(outputRoot);
    if (!outputEntry.isDirectory() || outputEntry.isSymbolicLink()) throw new Error('Export target parent must be a regular directory.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const target = path.join(repository, targetName);
  try {
    await fs.lstat(target);
    throw new Error('Export target already exists; choose a fresh directory.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.mkdir(outputRoot, { recursive: true });
  await fs.mkdir(target);
  const exported = files.filter(({ filename }) => !isPlanningDocument(filename));
  for (const { filename, bytes } of exported) {
    const destination = path.join(target, filename);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, bytes, { flag: 'wx' });
  }
  console.log(`Clean source export: ${targetName}, ${exported.length} files; Git history and planning documents excluded.`);
}

const args = process.argv.slice(2);
const exportOptions = args.filter(argument => argument.startsWith('--export='));
const referenceOptions = args.filter(argument => argument.startsWith('--ref='));
const stagedOptions = args.filter(argument => argument === '--staged');
const repositories = args.filter(argument => !argument.startsWith('--'));
const invalidOption = args.some(argument => argument.startsWith('--') && argument !== '--staged' && !argument.startsWith('--export=') && !argument.startsWith('--ref='));
const modes = exportOptions.length + referenceOptions.length + stagedOptions.length;
let failures = 0;
if (invalidOption || modes > 1 || (exportOptions.length && repositories.length)) {
  console.error('Usage: node scripts/checkPublication.mjs [--staged OR --ref=<commit>] [repositories...] OR --export=output/fresh-directory');
  process.exitCode = 1;
} else for (const input of repositories.length ? repositories : [process.cwd()]) {
  const repository = path.resolve(input);
  try {
    const snapshot = stagedOptions.length || referenceOptions.length;
    const reference = referenceOptions.length ? referenceOptions[0].slice('--ref='.length) : undefined;
    const { scanned, findings, files } = snapshot ? inspectSnapshot(repository, reference) : await inspectWorktree(repository, { exporting: Boolean(exportOptions.length) });
    for (const finding of findings) console.log(`${path.basename(repository)}:${finding.filename}:${finding.line}: ${finding.rule}`);
    const scope = stagedOptions.length ? 'Git index' : referenceOptions.length ? 'Git commit tree' : 'working tree';
    console.log(`${path.basename(repository)}: ${scanned} publication candidates checked (${scope}), ${findings.length} findings. Other commits and binary metadata require separate review.`);
    failures += findings.length;
    if (exportOptions.length && !findings.length) await exportSources(repository, exportOptions[0].slice('--export='.length), files);
  } catch (error) {
    console.error(error.message);
    failures += 1;
  }
}
if (failures) process.exitCode = 1;
