// Test helper: feeds hostile archives to the engine's extractors and prints one line per case.
// SAFE means the attack did nothing. Run it against any engine copy to compare before and after.
//   node test/security.mjs <port dir> <scratch dir>
import { spawnSync } from 'node:child_process';
import { createDeflateRaw, deflateRawSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [portDir, scratchDir] = process.argv.slice(2).map((path) => resolve(path));
const { fetchText, unzip, untar } = await import(pathToFileURL(join(portDir, 'lib', 'fetch.mjs')).href);
const { extractAsar } = await import(pathToFileURL(join(portDir, 'lib', 'asar.mjs')).href);
rmSync(scratchDir, { recursive: true, force: true });
mkdirSync(scratchDir, { recursive: true });

const results = [];
function report(name, safe, detail = '') {
  results.push(safe);
  console.log(`${safe ? 'SAFE  ' : 'UNSAFE'}  ${name}${detail ? `  (${detail})` : ''}`);
}

/** A case gets its own folders: the archive unpacks into `into`, `outside` must stay untouched. */
function arena(name) {
  const root = join(scratchDir, name);
  mkdirSync(join(root, 'outside'), { recursive: true });
  return { root, into: join(root, 'into'), outside: join(root, 'outside') };
}

function attempt(fn) {
  try {
    fn();
    return 'extracted';
  } catch (error) {
    return `refused: ${error.message.split('\n')[0].slice(0, 80)}`;
  }
}

// --- Archive builders -------------------------------------------------------

function makeZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const raw = Buffer.from(entry.data ?? '');
    const stored = entry.stored ?? (entry.deflate ? deflateRawSync(raw) : raw);
    const size = entry.claimedSize ?? raw.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.deflate ? 8 : 0, 8);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, stored);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(0x031e, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(entry.deflate ? 8 : 0, 10);
    record.writeUInt32LE(stored.length, 20);
    record.writeUInt32LE(size, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE((entry.mode ?? 0o100644) * 0x10000, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += local.length + name.length + stored.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function makeAsar(tree, payload = '') {
  const json = Buffer.from(JSON.stringify(tree));
  const padded = json.length + ((4 - (json.length % 4)) % 4);
  const pickle = Buffer.alloc(8 + padded);
  pickle.writeUInt32LE(4 + padded, 0);
  pickle.writeUInt32LE(json.length, 4);
  json.copy(pickle, 8);
  const prefix = Buffer.alloc(8);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(pickle.length, 4);
  return Buffer.concat([prefix, pickle, Buffer.from(payload)]);
}

function tarHeader({ name, data = '', type = '0', link = '', mode = 0o644 }) {
  const block = Buffer.alloc(512);
  const body = Buffer.from(data);
  const put = (text, at, width) => block.write(text, at, width, 'latin1');
  const octal = (value, width) => value.toString(8).padStart(width - 1, '0');
  put(name, 0, 100);
  put(octal(mode, 8), 100, 8);
  put(octal(0, 8), 108, 8);
  put(octal(0, 8), 116, 8);
  put(octal(body.length, 12), 124, 12);
  put(octal(0, 12), 136, 12);
  put(' '.repeat(8), 148, 8);
  put(type, 156, 1);
  put(link, 157, 100);
  put('ustar', 257, 6);
  put('00', 263, 2);
  let sum = 0;
  for (const byte of block) sum += byte;
  put(`${octal(sum, 7)}\0 `, 148, 8);
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([block, body, padding]);
}

function makeTar(entries) {
  return Buffer.concat([...entries.map(tarHeader), Buffer.alloc(1024)]);
}

// --- Zip --------------------------------------------------------------------

{
  const { root, into, outside } = arena('zip-symlink-write');
  const archive = join(root, 'a.zip');
  writeFileSync(archive, makeZip([
    { name: 'a/link', data: outside, mode: 0o120777 },
    { name: 'a/link/pwned.txt', data: 'pwned' },
  ]));
  const outcome = attempt(() => unzip(archive, into));
  report('zip: symlink, then a file written through it', !existsSync(join(outside, 'pwned.txt')), outcome);
}
{
  const { root, into, outside } = arena('zip-symlink-left');
  const archive = join(root, 'a.zip');
  writeFileSync(join(outside, 'secret.txt'), 'secret');
  writeFileSync(archive, makeZip([{ name: 'leak', data: join(outside, 'secret.txt'), mode: 0o120777 }]));
  const outcome = attempt(() => unzip(archive, into));
  report('zip: symlink pointing out of the tree is left behind', !existsSync(join(into, 'leak')), outcome);
}
{
  const { root, into, outside } = arena('zip-symlink-relative');
  const archive = join(root, 'a.zip');
  writeFileSync(archive, makeZip([
    { name: 'a/up', data: '../../outside', mode: 0o120777 },
    { name: 'a/up/pwned.txt', data: 'pwned' },
  ]));
  const outcome = attempt(() => unzip(archive, into));
  report('zip: relative symlink climbing out, then a write', !existsSync(join(outside, 'pwned.txt')), outcome);
}
{
  const { root, into, outside } = arena('zip-dotdot');
  const archive = join(root, 'a.zip');
  writeFileSync(archive, makeZip([{ name: '../outside/pwned.txt', data: 'pwned' }]));
  const outcome = attempt(() => unzip(archive, into));
  report('zip: ../ in an entry name', !existsSync(join(outside, 'pwned.txt')), outcome);
}
{
  const { root, into } = arena('zip-modes');
  const archive = join(root, 'a.zip');
  writeFileSync(archive, makeZip([
    { name: 'open.txt', data: 'x', mode: 0o100777 },
    { name: 'suid', data: 'x', mode: 0o104755 },
  ]));
  const outcome = attempt(() => unzip(archive, into));
  const mode = (name) => (existsSync(join(into, name)) ? statSync(join(into, name)).mode & 0o7777 : 0);
  report('zip: world-writable and setuid modes are dropped', (mode('open.txt') & 0o022) === 0 && (mode('suid') & 0o6000) === 0, `${outcome}; modes ${mode('open.txt').toString(8)} ${mode('suid').toString(8)}`);
}
{
  // A child process, so its peak memory can be read on its own. A child also inherits its parent's
  // peak on Linux, so the bomb is compressed in pieces to keep this process small.
  const { root, into } = arena('zip-bomb');
  const archive = join(root, 'a.zip');
  const megabyte = Buffer.alloc(1024 ** 2);
  const pieces = [];
  for await (const piece of Readable.from(Array.from({ length: 1024 }, () => megabyte)).pipe(createDeflateRaw())) pieces.push(piece);
  writeFileSync(archive, makeZip([{ name: 'bomb.bin', stored: Buffer.concat(pieces), deflate: true, claimedSize: 16 }]));
  const script = `import { unzip } from ${JSON.stringify(pathToFileURL(join(portDir, 'lib', 'fetch.mjs')).href)};
    let outcome = 'extracted';
    try { unzip(${JSON.stringify(archive)}, ${JSON.stringify(into)}); } catch (error) { outcome = 'refused'; }
    console.log(JSON.stringify({ outcome, peak: process.resourceUsage().maxRSS }));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  const { outcome, peak } = JSON.parse(child.stdout);
  const megabytes = Math.round(peak / 1024);
  report('zip: 1 GB bomb claiming 16 bytes stays out of memory', megabytes < 400, `${outcome}; peak ${megabytes} MB`);
}
{
  const { root, into } = arena('zip-lying-offset');
  const archive = join(root, 'a.zip');
  const zip = makeZip([{ name: 'a.txt', data: 'hello' }]);
  zip.writeUInt32LE(0xfffffff0, zip.length - 22 - 46 - 5 + 20);
  writeFileSync(archive, zip);
  const outcome = attempt(() => unzip(archive, into));
  report('zip: entry that claims 4 GB of compressed data is refused', outcome.startsWith('refused'), outcome);
}

// --- Asar -------------------------------------------------------------------

{
  const { root, into, outside } = arena('asar-dotdot');
  const archive = join(root, 'a.asar');
  writeFileSync(archive, makeAsar({ files: { '..': { files: { outside: { files: { 'pwned.txt': { size: 5, offset: '0' } } } } } } }, 'pwned'));
  const outcome = attempt(() => extractAsar(archive, into));
  report('asar: .. as a folder name', !existsSync(join(outside, 'pwned.txt')), outcome);
}
{
  const { root, into, outside } = arena('asar-slash');
  const archive = join(root, 'a.asar');
  writeFileSync(archive, makeAsar({ files: { '../outside/pwned.txt': { size: 5, offset: '0' } } }, 'pwned'));
  const outcome = attempt(() => extractAsar(archive, into));
  report('asar: ../ inside a file name', !existsSync(join(outside, 'pwned.txt')), outcome);
}
{
  const { root, into, outside } = arena('asar-unpacked-read');
  const archive = join(root, 'a.asar');
  writeFileSync(join(outside, 'secret.txt'), 'secret');
  mkdirSync(`${archive}.unpacked`);
  writeFileSync(archive, makeAsar({ files: { '../outside/secret.txt': { size: 6, unpacked: true } } }));
  const outcome = attempt(() => extractAsar(archive, into));
  report('asar: unpacked entry copying a file from outside', outcome.startsWith('refused'), outcome);
}
{
  const { root, into } = arena('asar-huge-size');
  const archive = join(root, 'a.asar');
  writeFileSync(archive, makeAsar({ files: { 'big.bin': { size: 2 ** 40, offset: '0' } } }, 'tiny'));
  const outcome = attempt(() => extractAsar(archive, into));
  report('asar: entry claiming 1 TB is refused', outcome.startsWith('refused'), outcome);
}

// --- Tar --------------------------------------------------------------------

function tarCase(label, folder, entries, check) {
  const { root, into, outside } = arena(folder);
  const archive = join(root, 'a.tar');
  writeFileSync(archive, makeTar(entries(outside)));
  const outcome = attempt(() => untar(archive, into));
  report(`tar: ${label}`, check({ into, outside, outcome }), outcome);
}

tarCase('../ in a member name', 'tar-dotdot', () => [{ name: 'package/../../outside/pwned.txt', data: 'pwned' }],
  ({ outside }) => !existsSync(join(outside, 'pwned.txt')));
tarCase('symlink out, then a file written through it', 'tar-symlink-write', (outside) => [
  { name: 'package/link', type: '2', link: outside },
  { name: 'package/link/pwned.txt', data: 'pwned' },
], ({ outside }) => !existsSync(join(outside, 'pwned.txt')));
tarCase('symlink pointing out of the tree is left behind', 'tar-symlink-left', (outside) => [
  { name: 'package/leak', type: '2', link: join(outside, 'secret.txt') },
], ({ into }) => { try { lstatSync(join(into, 'leak')); return false; } catch { return true; } });
tarCase('hard link to a file outside the tree', 'tar-hardlink', (outside) => {
  writeFileSync(join(outside, 'secret.txt'), 'secret');
  return [{ name: 'package/leak', type: '1', link: join(outside, 'secret.txt') }];
}, ({ into }) => !existsSync(join(into, 'leak')));
tarCase('setuid and world-writable modes are dropped', 'tar-modes', () => [
  { name: 'package/suid', data: 'x', mode: 0o4755 },
  { name: 'package/open', data: 'x', mode: 0o777 },
], ({ into }) => {
  const mode = (name) => (existsSync(join(into, name)) ? statSync(join(into, name)).mode & 0o7777 : 0);
  return (mode('suid') & 0o6000) === 0 && (mode('open') & 0o002) === 0;
});
tarCase('FIFO and device members are refused', 'tar-special', () => [
  { name: 'package/pipe', type: '6' },
], ({ into, outcome }) => outcome.startsWith('refused') || !existsSync(join(into, 'pipe')));

// A normal tree must still unpack, including a symlink that stays inside.
{
  const { root, into } = arena('tar-normal');
  const archive = join(root, 'a.tar');
  writeFileSync(archive, makeTar([
    { name: 'package/bin/tool', data: 'x', mode: 0o755 },
    { name: 'package/bin/alias', type: '2', link: 'tool' },
  ]));
  const outcome = attempt(() => untar(archive, into));
  report('tar: a normal tree with an inner symlink still unpacks', existsSync(join(into, 'bin', 'alias')) && (statSync(join(into, 'bin', 'tool')).mode & 0o100) !== 0, outcome);
}
{
  const { root, into } = arena('zip-normal');
  const archive = join(root, 'a.zip');
  writeFileSync(archive, makeZip([
    { name: 'bin/tool', data: 'x', mode: 0o100755, deflate: true },
    { name: 'bin/alias', data: 'tool', mode: 0o120777 },
    { name: 'empty.txt', data: '' },
  ]));
  const outcome = attempt(() => unzip(archive, into));
  report('zip: a normal tree with an inner symlink still unpacks', existsSync(join(into, 'bin', 'alias')) && readFileSync(join(into, 'bin', 'alias'), 'utf8') === 'x' && existsSync(join(into, 'empty.txt')), outcome);
}

// --- Downloads -----------------------------------------------------------

{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ url: 'http://example.invalid/file', ok: true, status: 200, text: async () => 'served over plain HTTP' });
  let outcome = 'accepted';
  try {
    await fetchText('https://example.invalid/file');
  } catch (error) {
    outcome = `refused: ${error.message.slice(0, 60)}`;
  }
  globalThis.fetch = realFetch;
  report('download: a redirect to plain HTTP is refused', outcome.startsWith('refused'), outcome);
}

rmSync(scratchDir, { recursive: true, force: true });
const failed = results.filter((safe) => !safe).length;
console.log(`${results.length - failed} of ${results.length} safe`);
process.exitCode = failed === 0 ? 0 : 1;
