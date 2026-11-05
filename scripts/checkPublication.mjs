#!/usr/bin/env node
// Checks working-tree publication candidates only. Git history needs a separate audit.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';

const contentRules = [
  ['private network address', /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/],
  ['deployment hostname', /(?<![a-z0-9-])(?:arm-\d+|(?:desktop|laptop)-[a-z0-9]{6,})\b/i],
  ['personal machine path', /\b[A-Z]:[\\/]+(?:Users[\\/]+[^\s"'`]+|[^\s"'`]*OSPanel[\\/])/i],
  ['personal mounted path', /\/(?:media|home|Users)\/[a-z0-9_.-]+\//i],
  ['private key material', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
];
const localFile = /(?:^|\/)(?:\.env(?:\..*)?|id_rsa|id_ed25519)$|\.(?:key|pem|crt|cer|p12|pfx|jks|keystore)$/i;
const environmentTemplate = /(?:^|\/)\.env(?:\.[^/]+)?\.(?:example|sample|template)$/i;
const generatedPath = /(?:^|\/)(?:\.git|node_modules|build|dist(?:-electron)?|output|out|release(?:-next)?|logs|coverage|\.cache|\.npm|\.electron-cache|\.electron-builder-cache|__pycache__|\.pytest_cache|\.venv|venv|\.codex|\.agents)(?:\/|$)/;
const localRuntimePath = /^(?:(?:data|indexes|state|runtime|private|backups|files|attachments|tmp|temp|\.superpowers)\/|docs\/(?:superpowers|plans)\/)/;
const planningDocument = /^docs\/(?:.*\/)?[^/]*-plans?\.md$/i;
const sourceBinaryAsset = /^src\/public\/[^/]+\.(?:png|ico)$/i;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const metadataLimit = 1024 * 1024;

function pngTextMetadata(bytes) {
  const texts = [];
  let requiresReview = false;
  for (let start = bytes.indexOf(pngSignature); start !== -1; start = bytes.indexOf(pngSignature, start + pngSignature.length)) {
    let offset = start + pngSignature.length;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      if (length > bytes.length - offset - 12) { requiresReview = true; break; }
      const type = bytes.toString('ascii', offset + 4, offset + 8);
      const data = bytes.subarray(offset + 8, offset + 8 + length);
      if (['tEXt', 'zTXt', 'iTXt'].includes(type)) {
        try {
          if (data.length > metadataLimit) throw new Error('Oversized metadata');
          if (type === 'tEXt') texts.push(data.toString('latin1'));
          else {
            const keywordEnd = data.indexOf(0);
            if (keywordEnd < 1 || keywordEnd > 79) throw new Error('Invalid metadata keyword');
            texts.push(data.subarray(0, keywordEnd).toString('latin1'));
            if (type === 'zTXt') {
              if (data[keywordEnd + 1] !== 0) throw new Error('Invalid compression method');
              texts.push(inflateSync(data.subarray(keywordEnd + 2), { maxOutputLength: metadataLimit }).toString('latin1'));
            } else {
              const compressed = data[keywordEnd + 1];
              const method = data[keywordEnd + 2];
              const languageEnd = data.indexOf(0, keywordEnd + 3);
              const translationEnd = languageEnd < 0 ? -1 : data.indexOf(0, languageEnd + 1);
              if (![0, 1].includes(compressed) || method !== 0 || translationEnd < 0) throw new Error('Invalid international metadata');
              texts.push(data.subarray(keywordEnd + 3, translationEnd).toString('utf8'));
              const text = data.subarray(translationEnd + 1);
              texts.push((compressed ? inflateSync(text, { maxOutputLength: metadataLimit }) : text).toString('utf8'));
            }
          }
        } catch { requiresReview = true; }
      }
      offset += length + 12;
      if (type === 'IEND') break;
    }
  }
  return { texts, requiresReview };
}

function binaryFindings(bytes) {
  const { texts, requiresReview } = pngTextMetadata(bytes);
  texts.push(bytes.toString('utf8'));
  for (const offset of [0, 1]) {
    const aligned = bytes.subarray(offset, bytes.length - ((bytes.length - offset) % 2));
    texts.push(aligned.toString('utf16le'));
    texts.push(Buffer.from(aligned).swap16().toString('utf16le'));
  }
  const rules = contentRules.filter(([, pattern]) => texts.some(text => pattern.test(text))).map(([rule]) => rule);
  if (requiresReview) rules.push('image text metadata requires separate review');
  return rules;
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

async function inspectRepository(repository) {
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
    for (const [rule, pattern] of contentRules) {
      if (pattern.test(filename)) findings.push({ filename, line: 1, rule });
    }
    if (entry.isSymbolicLink()) {
      findings.push({ filename, line: 1, rule: 'symbolic link requires separate review' });
      continue;
    }
    if (!entry.isFile()) continue;
    if (await linkedSource(repository, realRepository, filename)) {
      findings.push({ filename, line: 1, rule: 'ancestor link or file outside repository requires separate review' });
      continue;
    }
    scanned += 1;
    const portableName = filename.replaceAll('\\', '/');
    if (generatedPath.test(portableName) || localRuntimePath.test(portableName)) {
      findings.push({ filename, line: 1, rule: 'tracked local output, dependency or assistant state' });
      continue;
    }
    if (localFile.test(portableName) && !environmentTemplate.test(portableName)) {
      findings.push({ filename, line: 1, rule: 'local certificate or key / environment file' });
      continue;
    }
    const bytes = await fs.readFile(fullPath);
    files.push({ filename, bytes });
    // Public registry/documentation URLs are allowed; binary metadata needs separate review.
    if (bytes.includes(0)) {
      if (!sourceBinaryAsset.test(portableName)) findings.push({ filename, line: 1, rule: 'binary file requires separate review' });
      else for (const rule of binaryFindings(bytes)) findings.push({ filename, line: 1, rule });
      continue;
    }
    for (const [index, line] of bytes.toString('utf8').split(/\r?\n/).entries()) {
      for (const [rule, pattern] of contentRules) {
        if (pattern.test(line)) findings.push({ filename, line: index + 1, rule });
      }
    }
  }
  return { scanned, findings, files };
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
  const exported = files.filter(({ filename }) => !planningDocument.test(filename.replaceAll('\\', '/')));
  for (const { filename, bytes } of exported) {
    const destination = path.join(target, filename);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, bytes, { flag: 'wx' });
  }
  console.log(`Clean source export: ${targetName}, ${exported.length} files; Git history and planning documents excluded.`);
}

const args = process.argv.slice(2);
const exportOption = args.find(argument => argument.startsWith('--export='));
const repositories = args.filter(argument => !argument.startsWith('--'));
let failures = 0;
if (args.some(argument => argument.startsWith('--') && !argument.startsWith('--export=')) || args.filter(argument => argument.startsWith('--export=')).length > 1 || (exportOption && repositories.length)) {
  console.error('Usage: node scripts/checkPublication.mjs [repositories...] OR --export=output/fresh-directory');
  process.exitCode = 1;
} else for (const input of repositories.length ? repositories : [process.cwd()]) {
  const repository = path.resolve(input);
  try {
    const { scanned, findings, files } = await inspectRepository(repository);
    for (const finding of findings) console.log(`${path.basename(repository)}:${finding.filename}:${finding.line}: ${finding.rule}`);
    console.log(`${path.basename(repository)}: ${scanned} publication candidates checked, ${findings.length} findings. Git history and binary metadata require separate review.`);
    failures += findings.length;
    if (exportOption && !findings.length) await exportSources(repository, exportOption.slice('--export='.length), files);
  } catch (error) {
    console.error(error.message);
    failures += 1;
  }
}
if (failures) process.exitCode = 1;
