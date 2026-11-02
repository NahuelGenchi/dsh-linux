// Verified downloads and archive helpers. Every download is pinned by a hash that
// comes from the publisher's own manifest (npm metadata, SHASUMS files).
import { closeSync, createWriteStream, existsSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, chmodSync, symlinkSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, normalize, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';

const RETRIES = 3;
const GIGABYTE = 1024 ** 3;
const MAX_DOWNLOAD_BYTES = 2 * GIGABYTE;
const MAX_ZIP_ENTRY_BYTES = GIGABYTE;
const MAX_ZIP_TOTAL_BYTES = 8 * GIGABYTE;
const MAX_ZIP_DIRECTORY_BYTES = 1 << 26;

async function request(url, init) {
  let lastError;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const response = await fetch(url, { redirect: 'follow', ...init });
      if (response.url.startsWith('http:') && !String(url).startsWith('http:')) throw Object.assign(new Error(`${url} redirected to plain HTTP`), { permanent: true });
      if (response.ok) return response;
      lastError = new Error(`HTTP ${response.status} for ${url}`);
      if (response.status >= 400 && response.status < 500 && response.status !== 429) throw Object.assign(lastError, { permanent: true });
    } catch (error) {
      lastError = error;
      if (error.permanent) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
  }
  throw lastError;
}

export async function fetchText(url, init) {
  return (await request(url, init)).text();
}

export async function fetchJson(url, init) {
  return JSON.parse(await (await request(url, init)).text());
}

/** Hash a file with node:crypto. */
export function hashFile(path, algorithm = 'sha256', encoding = 'hex') {
  const hash = createHash(algorithm);
  const fd = openSync(path, 'r');
  const buffer = Buffer.alloc(1 << 20);
  try {
    let read;
    while ((read = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read));
  } finally {
    closeSync(fd);
  }
  return hash.digest(encoding);
}

/**
 * Download into the cache unless a verified copy is there.
 * @param expected - { algorithm, encoding, value } from the publisher's manifest.
 */
export async function download(url, destination, expected) {
  const check = () => hashFile(destination, expected.algorithm, expected.encoding) === expected.value;
  if (existsSync(destination)) {
    if (check()) return destination;
    rmSync(destination);
  }
  mkdirSync(dirname(destination), { recursive: true });
  const partial = `${destination}.${process.pid}.partial`;
  const response = await request(url);
  let received = 0;
  const limit = new Transform({
    transform(chunk, _encoding, done) {
      received += chunk.length;
      done(received > MAX_DOWNLOAD_BYTES ? new Error(`${url} is larger than expected`) : null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(partial));
    if (hashFile(partial, expected.algorithm, expected.encoding) !== expected.value) throw new Error(`Hash mismatch for ${url}`);
    renameSync(partial, destination);
  } finally {
    rmSync(partial, { force: true });
  }
  return destination;
}

/** After unpacking: only files, folders and links that stay inside the tree may remain. */
function assertTreeInside(root) {
  const real = realpathSync(root);
  const refuse = (path, problem) => {
    rmSync(path, { force: true });
    throw new Error(`archive: ${path.slice(root.length + 1)} ${problem}`);
  };
  const walk = (directory) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const info = lstatSync(path);
      if (info.isDirectory()) walk(path);
      else if (info.isSymbolicLink()) {
        let target;
        try {
          target = realpathSync(path);
        } catch {
          refuse(path, 'is a link to nothing');
        }
        if (target !== real && !target.startsWith(real + sep)) refuse(path, 'is a link that points out of the tree');
      } else if (!info.isFile()) refuse(path, 'is not a regular file');
    }
  };
  walk(root);
}

/** Extract a tarball with the system tar, stripping leading components. */
export function untar(archive, destination, strip = 1) {
  mkdirSync(destination, { recursive: true });
  const result = spawnSync('tar', ['-xf', archive, '-C', destination, `--strip-components=${strip}`, '--no-same-owner', '--no-same-permissions'], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`tar failed for ${archive}: ${result.stderr}`);
  assertTreeInside(destination);
}

/** List a zip's entries through its central directory. */
function zipEntries(fd, size) {
  const tailSize = Math.min(size, 65557);
  const tail = Buffer.alloc(tailSize);
  readSync(fd, tail, 0, tailSize, size - tailSize);
  let eocd = -1;
  for (let i = tailSize - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('zip: end of central directory not found');
  let count = tail.readUInt16LE(eocd + 10);
  let directorySize = tail.readUInt32LE(eocd + 12);
  let directoryOffset = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator < 0 || tail.readUInt32LE(locator) !== 0x07064b50) throw new Error('zip: zip64 locator not found');
    const record = Buffer.alloc(56);
    readSync(fd, record, 0, 56, Number(tail.readBigUInt64LE(locator + 8)));
    if (record.readUInt32LE(0) !== 0x06064b50) throw new Error('zip: zip64 record not found');
    count = Number(record.readBigUInt64LE(32));
    directorySize = Number(record.readBigUInt64LE(40));
    directoryOffset = Number(record.readBigUInt64LE(48));
  }
  if (directorySize > MAX_ZIP_DIRECTORY_BYTES || directoryOffset + directorySize > size) throw new Error('zip: central directory is out of bounds');
  const directory = Buffer.alloc(directorySize);
  readSync(fd, directory, 0, directorySize, directoryOffset);
  const entries = [];
  let position = 0;
  for (let i = 0; i < count; i++) {
    if (directory.readUInt32LE(position) !== 0x02014b50) throw new Error('zip: bad central directory entry');
    const method = directory.readUInt16LE(position + 10);
    let compressed = directory.readUInt32LE(position + 20);
    let uncompressed = directory.readUInt32LE(position + 24);
    const nameLength = directory.readUInt16LE(position + 28);
    const extraLength = directory.readUInt16LE(position + 30);
    const commentLength = directory.readUInt16LE(position + 32);
    const attributes = directory.readUInt32LE(position + 38);
    let local = directory.readUInt32LE(position + 42);
    const name = directory.toString('utf8', position + 46, position + 46 + nameLength);
    let extra = position + 46 + nameLength;
    const extraEnd = extra + extraLength;
    while (extra + 4 <= extraEnd) {
      const id = directory.readUInt16LE(extra);
      const length = directory.readUInt16LE(extra + 2);
      if (id === 1) {
        let field = extra + 4;
        if (uncompressed === 0xffffffff) { uncompressed = Number(directory.readBigUInt64LE(field)); field += 8; }
        if (compressed === 0xffffffff) { compressed = Number(directory.readBigUInt64LE(field)); field += 8; }
        if (local === 0xffffffff) { local = Number(directory.readBigUInt64LE(field)); }
      }
      extra += 4 + length;
    }
    entries.push({ name, method, compressed, uncompressed, local, mode: attributes >>> 16 });
    position = extraEnd + commentLength;
  }
  return entries;
}

/**
 * Extract the entries a filter selects, without needing unzip on the system.
 * @param select - maps an entry name to a relative output path, or undefined to skip it.
 */
export function unzip(archive, destination, select = (name) => name) {
  const size = statSync(archive).size;
  const fd = openSync(archive, 'r');
  // Links are made last, so no entry can be written through one.
  const links = [];
  let total = 0;
  try {
    for (const entry of zipEntries(fd, size)) {
      const output = select(entry.name);
      if (output === undefined || output === '') continue;
      const target = normalize(join(destination, output));
      if (!target.startsWith(normalize(destination) + sep)) throw new Error(`zip: entry escapes destination: ${entry.name}`);
      if (entry.name.endsWith('/')) {
        mkdirSync(target, { recursive: true });
        continue;
      }
      total += entry.uncompressed;
      if (entry.uncompressed > MAX_ZIP_ENTRY_BYTES || entry.compressed > MAX_ZIP_ENTRY_BYTES || total > MAX_ZIP_TOTAL_BYTES) throw new Error(`zip: ${entry.name} is too large`);
      const header = Buffer.alloc(30);
      readSync(fd, header, 0, 30, entry.local);
      if (header.readUInt32LE(0) !== 0x04034b50) throw new Error(`zip: bad local header for ${entry.name}`);
      const start = entry.local + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
      if (start + entry.compressed > size) throw new Error(`zip: ${entry.name} runs past the end of the file`);
      const raw = Buffer.alloc(entry.compressed);
      if (entry.compressed > 0) readSync(fd, raw, 0, entry.compressed, start);
      if (entry.method !== 0 && entry.method !== 8) throw new Error(`zip: unsupported method ${entry.method} for ${entry.name}`);
      const data = entry.method === 8 ? inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.uncompressed) }) : raw;
      if (data.length !== entry.uncompressed) throw new Error(`zip: size mismatch for ${entry.name}`);
      mkdirSync(dirname(target), { recursive: true });
      if ((entry.mode & 0o170000) === 0o120000) {
        links.push({ target, to: data.toString('utf8') });
        continue;
      }
      const out = openSync(target, 'w');
      writeSync(out, data);
      closeSync(out);
      const mode = entry.mode & 0o755;
      chmodSync(target, mode !== 0 ? mode : 0o644);
    }
  } finally {
    closeSync(fd);
  }
  for (const { target, to } of links) {
    if (existsSync(target)) throw new Error(`zip: link ${target} collides with another entry`);
    symlinkSync(to, target);
  }
  assertTreeInside(destination);
}
