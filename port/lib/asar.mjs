// Minimal asar reader and writer. The engine also runs inside installed copies
// during updates, so it stays free of npm dependencies.
import { closeSync, copyFileSync, createWriteStream, chmodSync, linkSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

const CHUNK = 1 << 20;
const MAX_HEADER_BYTES = 1 << 28;

function readHeader(fd) {
  const prefix = Buffer.alloc(8);
  readSync(fd, prefix, 0, 8, 0);
  const headerPickleSize = prefix.readUInt32LE(4);
  if (headerPickleSize > MAX_HEADER_BYTES) throw new Error('asar: header is too large');
  const pickle = Buffer.alloc(headerPickleSize);
  readSync(fd, pickle, 0, headerPickleSize, 8);
  const length = pickle.readUInt32LE(4);
  return { header: JSON.parse(pickle.toString('utf8', 8, 8 + length)), base: 8 + headerPickleSize };
}

/**
 * Expand an archive and its .unpacked sibling.
 * @param skip - selects relative paths to leave out.
 * @returns relative paths that upstream kept outside the archive.
 */
export function extractAsar(archive, destination, skip = () => false) {
  const fd = openSync(archive, 'r');
  const unpackedPaths = new Set();
  const buffer = Buffer.alloc(CHUNK);
  try {
    const { header, base } = readHeader(fd);
    const walk = (node, prefix) => {
      for (const [name, entry] of Object.entries(node.files)) {
        if (name === '' || name === '.' || name === '..' || /[/\\\0]/.test(name)) throw new Error(`asar: unsafe name ${JSON.stringify(name)} under ${prefix || 'the root'}`);
        const path = prefix === '' ? name : `${prefix}/${name}`;
        const target = join(destination, path);
        if (entry.files !== undefined) {
          mkdirSync(target, { recursive: true });
          walk(entry, path);
          continue;
        }
        if (entry.link !== undefined) throw new Error(`asar: unexpected link at ${path}`);
        if (skip(path)) continue;
        mkdirSync(dirname(target), { recursive: true });
        if (entry.unpacked) {
          copyFileSync(join(`${archive}.unpacked`, path), target);
          unpackedPaths.add(path);
        } else {
          const out = openSync(target, 'w');
          let left = Number(entry.size);
          let position = base + Number(entry.offset);
          while (left > 0) {
            const read = readSync(fd, buffer, 0, Math.min(CHUNK, left), position);
            if (read === 0) throw new Error(`asar: truncated entry ${path}`);
            writeSync(out, buffer, 0, read);
            left -= read;
            position += read;
          }
          closeSync(out);
        }
        chmodSync(target, entry.executable ? 0o755 : 0o644);
      }
    };
    walk(header, '');
  } finally {
    closeSync(fd);
  }
  return unpackedPaths;
}

/**
 * Replace an archive with a folder of the same name. On Linux, Electron's Node mode runs in the C
 * locale and cannot open an archive under a non-ASCII path, which the app's backend depends on.
 */
export function expandAsarInPlace(archive) {
  const expanded = `${archive}.expanded`;
  rmSync(expanded, { recursive: true, force: true });
  extractAsar(archive, expanded);
  rmSync(archive);
  renameSync(expanded, archive);
}

/**
 * Pack a directory. Files selected by isUnpacked go to the .unpacked sibling,
 * matching what Electron expects for native addons and spawned binaries.
 */
export async function createAsar(source, archive, isUnpacked) {
  const root = { files: {} };
  const packed = [];
  let offset = 0;
  const walk = (directory, node) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) throw new Error(`asar: refusing link ${path}`);
      if (info.isDirectory()) {
        node.files[name] = { files: {} };
        walk(path, node.files[name]);
        continue;
      }
      const relativePath = relative(source, path).split(sep).join('/');
      const executable = (info.mode & 0o100) !== 0;
      const entry = { size: info.size, ...(executable ? { executable: true } : {}) };
      if (isUnpacked(relativePath)) {
        entry.unpacked = true;
        const target = join(`${archive}.unpacked`, relativePath);
        mkdirSync(dirname(target), { recursive: true });
        try {
          linkSync(path, target);
        } catch {
          copyFileSync(path, target);
        }
        chmodSync(target, executable ? 0o755 : 0o644);
      } else {
        entry.offset = String(offset);
        offset += info.size;
        packed.push(path);
      }
      node.files[name] = entry;
    }
  };
  walk(source, root);

  const json = Buffer.from(JSON.stringify(root), 'utf8');
  const padded = json.length + ((4 - (json.length % 4)) % 4);
  const pickle = Buffer.alloc(8 + padded);
  pickle.writeUInt32LE(4 + padded, 0);
  pickle.writeUInt32LE(json.length, 4);
  json.copy(pickle, 8);
  const prefix = Buffer.alloc(8);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(pickle.length, 4);

  mkdirSync(dirname(archive), { recursive: true });
  const out = createWriteStream(archive);
  const write = (chunk) => new Promise((resolve, reject) => {
    out.write(chunk, (error) => (error ? reject(error) : resolve()));
  });
  await write(prefix);
  await write(pickle);
  const buffer = Buffer.alloc(CHUNK);
  for (const path of packed) {
    const fd = openSync(path, 'r');
    try {
      let read;
      while ((read = readSync(fd, buffer, 0, CHUNK, null)) > 0) await write(Buffer.from(buffer.subarray(0, read)));
    } finally {
      closeSync(fd);
    }
  }
  await new Promise((resolve, reject) => {
    out.end((error) => (error ? reject(error) : resolve()));
  });
  return statSync(archive).size;
}
