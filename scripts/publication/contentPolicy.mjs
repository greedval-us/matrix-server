import { inflateSync } from 'node:zlib';

const contentRules = [
  ['private network address', /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/],
  ['deployment hostname', /(?<![a-z0-9-])(?:arm-\d+|(?:desktop|laptop)-[a-z0-9]{6,})\b/i],
  ['personal machine path', /\b[A-Z]:[\\/]+(?:Users[\\/]+[^\s"'`]+|[^\s"'`]*OSPanel[\\/])/i],
  ['personal mounted path', /\/(?:media|home|Users)\/[a-z0-9_.-]+\//i],
  ['private key material', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
];
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

export function identifierFindings(filename) {
  return contentRules.filter(([, pattern]) => pattern.test(filename)).map(([rule]) => ({ filename, line: 1, rule }));
}

export function contentFindings(filename, bytes) {
  if (bytes.includes(0)) {
    const rules = sourceBinaryAsset.test(filename.replaceAll('\\', '/')) ? binaryFindings(bytes) : ['binary file requires separate review'];
    return rules.map(rule => ({ filename, line: 1, rule }));
  }
  const findings = [];
  for (const [index, line] of bytes.toString('utf8').split(/\r?\n/).entries()) {
    for (const [rule, pattern] of contentRules) {
      if (pattern.test(line)) findings.push({ filename, line: index + 1, rule });
    }
  }
  return findings;
}
