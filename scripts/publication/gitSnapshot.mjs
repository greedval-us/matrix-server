import { execFileSync } from 'node:child_process';

function git(repository, args, input) {
  try {
    return execFileSync('git', ['--no-replace-objects', ...args], {
      cwd: repository, input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 128 * 1024 * 1024,
    });
  } catch {
    // Git diagnostics can contain object contents or private remote configuration.
    throw new Error('Cannot read publication snapshot from Git; verify the repository, reference and object availability.');
  }
}

function snapshotEntries(repository, reference) {
  let listing;
  if (reference === undefined) {
    listing = git(repository, ['ls-files', '--stage', '--full-name', '-z', '--', ':/']);
  } else {
    if (!reference || reference.startsWith('-') || /[\0\r\n]/.test(reference)) throw new Error('Publication reference must identify one commit.');
    const oid = git(repository, ['rev-parse', '--verify', '--end-of-options', `${reference}^{commit}`]).toString('utf8').trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)) throw new Error('Publication reference must identify one commit.');
    listing = git(repository, ['ls-tree', '--full-tree', '-r', '-z', oid]);
  }
  return listing.toString('utf8').split('\0').filter(Boolean).map(record => {
    const separator = record.indexOf('\t');
    const header = record.slice(0, separator).split(' ');
    const filename = record.slice(separator + 1);
    const [mode, second, third] = header;
    const oid = reference === undefined ? second : third;
    if (separator < 0 || header.length !== 3 || !/^[0-7]{6}$/.test(mode) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid) || !filename) {
      throw new Error('Malformed Git publication snapshot.');
    }
    if (reference === undefined && !/^[0-3]$/.test(third)) throw new Error('Malformed Git index stage.');
    return { filename, mode, oid, stage: reference === undefined ? Number(third) : 0, type: reference === undefined ? undefined : second };
  });
}

function blobContents(repository, entries) {
  const oids = [...new Set(entries.map(entry => entry.oid))];
  const blobs = new Map();
  if (!oids.length) return blobs;
  const output = git(repository, ['cat-file', '--batch'], `${oids.join('\n')}\n`);
  let offset = 0;
  for (const oid of oids) {
    const end = output.indexOf(10, offset);
    const header = output.subarray(offset, end).toString('ascii').split(' ');
    const size = Number(header[2]);
    if (end < offset || header.length !== 3 || header[0] !== oid || header[1] !== 'blob' || !/^\d+$/.test(header[2]) || !Number.isSafeInteger(size) || output[end + 1 + size] !== 10) {
      throw new Error('Cannot read complete publication blob from Git.');
    }
    blobs.set(oid, output.subarray(end + 1, end + 1 + size));
    offset = end + 2 + size;
  }
  if (offset !== output.length) throw new Error('Unexpected Git publication blob data.');
  return blobs;
}

export function readGitSnapshot(repository, reference) {
  const entries = snapshotEntries(repository, reference);
  const findings = [];
  const regular = [];
  for (const entry of entries) {
    let rule;
    if (entry.stage !== 0) rule = 'unresolved index entry prevents publication';
    else if (entry.mode === '120000') rule = 'symbolic link requires separate review';
    else if (entry.mode === '160000') rule = 'submodule / gitlink requires separate review';
    else if (!['100644', '100755'].includes(entry.mode) || (entry.type && entry.type !== 'blob')) rule = 'unsupported Git entry requires separate review';
    if (rule) findings.push({ filename: entry.filename, line: 1, rule });
    else regular.push(entry);
  }
  const blobs = blobContents(repository, regular);
  return { files: regular.map(({ filename, oid }) => ({ filename, bytes: blobs.get(oid) })), findings };
}
