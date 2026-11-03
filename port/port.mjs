#!/usr/bin/env node
// Port engine: turns a DeepSeek Harness macOS release into a native Linux application.
// The same script builds the first install and every in-app update.
//
//   node port/port.mjs --source <App.app/Contents> --out <dir> [--cache <dir>]
//   node port/port.mjs --zip <release.zip> --out <dir> --reuse <installed app dir> --progress-json [--expect-version <version>]
// The app's updater also runs newer signed copies of this engine (engine-fix.mjs), so these arguments must keep working.
import { chmodSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createAsar, expandAsarInPlace, extractAsar } from './lib/asar.mjs';
import { releaseEntry, verifyRelease } from './lib/codesign.mjs';
import { download, fetchJson, fetchText, hashFile, unzip, untar } from './lib/fetch.mjs';
import { patchApp, patchRuntime } from './lib/patches.mjs';
import { trimApp, trimPnpm, trimPython } from './lib/trim.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PINS = JSON.parse(readFileSync(join(HERE, 'pins.json'), 'utf8'));
const TARGET = { npm: 'linux-x64', electron: 'linux-x64', node: 'linux-x64', python: 'x86_64-unknown-linux-gnu', arch: 'x64' };
if (process.arch !== 'x64' || process.platform !== 'linux') throw new Error('The port engine currently runs on x86-64 Linux only.');
// The build must not inherit a loose umask or a shell that turned TLS checks off.
process.umask(0o022);
delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

const args = parseArgs(process.argv.slice(2));
const out = args.out;
const cache = args.cache ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'deepseek-harness-port');
const reuse = args.reuse;
const progressJson = args['progress-json'] === true;
const work = mkdtempSync(join(args['work-dir'] ?? dirname(out), '.port-'));

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].replace(/^--/, '');
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) parsed[name] = true;
    else parsed[name] = argv[++i];
  }
  if (typeof parsed.out !== 'string' || (typeof parsed.source !== 'string' && typeof parsed.zip !== 'string')) {
    throw new Error('Usage: port.mjs (--source <Contents> | --zip <file>) --out <dir> [--cache <dir>] [--reuse <dir>] [--progress-json] [--expect-version <version>]');
  }
  return parsed;
}

function step(name, percent) {
  if (progressJson) process.stdout.write(`${JSON.stringify({ step: name, percent })}\n`);
  else process.stdout.write(`[${String(percent).padStart(3)}%] ${name}\n`);
}

function note(message) {
  if (progressJson) process.stderr.write(`${message}\n`);
  else process.stdout.write(`       ${message}\n`);
}

function run(command, argv, options = {}) {
  const result = spawnSync(command, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${argv.slice(0, 4).join(' ')} failed: ${(result.stderr || result.stdout || '').slice(-1800)}`);
  return result.stdout;
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const copyTree = (from, to, skip = () => false) => {
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true, verbatimSymlinks: true, filter: (path) => !path.includes(':com.apple.') && !skip(path) });
};

/** Take files from the installed version. Hard links cost no time or space, and nothing edits these files in place. */
function linkTree(source, target) {
  const info = lstatSync(source);
  if (info.isDirectory()) {
    mkdirSync(target, { recursive: true });
    for (const name of readdirSync(source)) linkTree(join(source, name), join(target, name));
  } else if (info.isSymbolicLink()) {
    symlinkSync(readlinkSync(source), target);
  } else {
    try {
      linkSync(source, target);
    } catch {
      cpSync(source, target, { preserveTimestamps: true });
    }
  }
}

function plistValue(file, key) {
  const match = readFileSync(file, 'utf8').match(new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`));
  if (match === null) throw new Error(`${key} is missing from ${file}`);
  return match[1];
}

// --- Upstream ---------------------------------------------------------------

// macOS files that get replaced anyway. The signature check needs them all unpacked, but nothing goes
// further: its native packages (only their package.json is read), its Node and its Python.
const MACOS_NATIVE = /(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+-darwin-arm64\/(?!package\.json$)/;
const MACOS_RUNTIME = /^Resources\/runtime\/primary-runtime\/dependencies\/(?:node\/bin|python)\//;

function prepareUpstream() {
  const root = typeof args.source === 'string' ? args.source : join(work, 'upstream');
  if (typeof args.source !== 'string') unzip(args.zip, root, releaseEntry);
  // Nothing from the release is used before this: a build needs DeepSeek's Apple signature, whatever the feed said.
  const { team, signedAt } = verifyRelease(root, PINS.signature);
  note(`signature ok: Apple Developer ID team ${team}, signed ${signedAt.toISOString()}`);
  return root;
}

// --- npm --------------------------------------------------------------------

const npmManifests = new Map();
async function npmManifest(name, version) {
  const key = `${name}@${version}`;
  if (!npmManifests.has(key)) {
    const url = `https://registry.npmjs.org/${name.replace('/', '%2f')}/${encodeURIComponent(version)}`;
    npmManifests.set(key, await fetchJson(url).catch((error) => {
      if (error.permanent) return null;
      throw error;
    }));
  }
  return npmManifests.get(key);
}

const installedNative = (name, version) => {
  if (reuse === undefined) return undefined;
  const directory = join(reuse, 'resources', 'app.asar.unpacked', 'dsh', 'node_modules', name);
  return existsSync(join(directory, 'package.json')) && readJson(join(directory, 'package.json')).version === version ? directory : undefined;
};

/** An unchanged package comes from the installed version, which saves the download. */
async function installNpmPackage(name, version, destination, installed) {
  if (installed === undefined) {
    await fetchNpmPackage(name, version, destination);
    return;
  }
  rmSync(destination, { recursive: true, force: true });
  linkTree(installed, destination);
}

async function fetchNpmPackage(name, version, destination) {
  const manifest = await npmManifest(name, version);
  if (manifest === null) throw new Error(`npm package ${name}@${version} does not exist`);
  if (manifest.name !== name || manifest.version !== version) throw new Error(`npm answered with ${manifest.name}@${manifest.version} for ${name}@${version}`);
  if (Array.isArray(manifest.os) && !manifest.os.includes('linux')) throw new Error(`npm package ${name}@${version} is not for Linux`);
  if (Array.isArray(manifest.cpu) && !manifest.cpu.includes(TARGET.arch) && !manifest.cpu.includes('wasm32')) throw new Error(`npm package ${name}@${version} is not for ${TARGET.arch}`);
  const integrity = manifest.dist.integrity;
  if (typeof integrity !== 'string' || !integrity.startsWith('sha512-')) throw new Error(`npm package ${name}@${version} has no sha512 integrity`);
  assertPinned(`${name}@${version}`, integrity);
  const tarballUrl = new URL(manifest.dist.tarball);
  if (tarballUrl.protocol !== 'https:' || tarballUrl.host !== 'registry.npmjs.org') throw new Error(`npm package ${name}@${version} points to ${tarballUrl.host}`);
  const tarball = await download(manifest.dist.tarball, join(cache, 'npm', `${name.replace('/', '__')}-${version}.tgz`), { algorithm: 'sha512', encoding: 'base64', value: integrity.slice(7) });
  rmSync(destination, { recursive: true, force: true });
  untar(tarball, destination);
  return manifest;
}

/** A download whose exact version was reviewed must still have the hash recorded then. */
function assertPinned(label, value) {
  const pinned = PINS.hashes?.[label];
  if (pinned !== undefined && pinned !== value) throw new Error(`${label} no longer has the hash recorded in pins.json`);
}

/** Every name the bundled packages list next to a macOS package. Only the signed release can vouch for a twin. */
function declaredTwins(nodeModules, macName) {
  const declared = new Set();
  const consider = (directory) => {
    const manifestPath = join(directory, 'package.json');
    if (!existsSync(manifestPath)) return;
    const optional = readJson(manifestPath).optionalDependencies ?? {};
    if (macName in optional) for (const name of Object.keys(optional)) declared.add(name);
  };
  for (const entry of readdirSync(nodeModules)) {
    if (entry.startsWith('.')) continue;
    if (entry.startsWith('@')) for (const inner of readdirSync(join(nodeModules, entry))) consider(join(nodeModules, entry, inner));
    else consider(join(nodeModules, entry));
  }
  return declared;
}

/** Find every macOS-only package in the bundled tree. */
function darwinPackages(nodeModules) {
  const found = [];
  const consider = (directory) => {
    const manifestPath = join(directory, 'package.json');
    if (!existsSync(manifestPath)) return;
    const manifest = readJson(manifestPath);
    const os = Array.isArray(manifest.os) ? manifest.os : [];
    if (os.length > 0 && os.every((value) => value === 'darwin')) found.push({ directory, name: manifest.name, version: manifest.version });
  };
  for (const entry of readdirSync(nodeModules)) {
    if (entry.startsWith('.')) continue;
    if (entry.startsWith('@')) for (const inner of readdirSync(join(nodeModules, entry))) consider(join(nodeModules, entry, inner));
    else consider(join(nodeModules, entry));
  }
  return found;
}

function officeEngineVersions(nodeModules) {
  const source = readFileSync(join(nodeModules, '@deepseek-ai/libreoffice-kit/lib/index.js'), 'utf8');
  const version = (key) => source.match(new RegExp(`"?${key}"?: "([^"]+)"`))?.[1];
  return { native: version('linux-x64-glibc'), wasm: version('wasm') };
}

/** Resolve the official Linux package that replaces one macOS package. */
async function linuxReplacement(pkg, nodeModules) {
  if (pkg.name.startsWith('@deepseek-ai/libreoffice-kit-')) {
    // Upstream's own rule: Linux uses a native engine when one is published, otherwise WASM.
    const versions = officeEngineVersions(nodeModules);
    if (versions.native !== undefined && (installedNative('@deepseek-ai/libreoffice-kit-linux-x64-glibc', versions.native) !== undefined || await npmManifest('@deepseek-ai/libreoffice-kit-linux-x64-glibc', versions.native) !== null)) {
      return { name: '@deepseek-ai/libreoffice-kit-linux-x64-glibc', version: versions.native };
    }
    if (versions.wasm !== undefined && (installedNative('@deepseek-ai/libreoffice-kit-wasm', versions.wasm) !== undefined || await npmManifest('@deepseek-ai/libreoffice-kit-wasm', versions.wasm) !== null)) {
      return { name: '@deepseek-ai/libreoffice-kit-wasm', version: versions.wasm };
    }
    throw new Error('No Linux Office engine is published for this release.');
  }
  const base = pkg.name.replace(/-darwin-arm64$/, '');
  // Guessing names is not enough: anyone can register a free look-alike on npm.
  const declared = declaredTwins(nodeModules, pkg.name);
  for (const suffix of [TARGET.npm, `${TARGET.npm}-gnu`, `${TARGET.npm}-glibc`]) {
    if (declared.has(`${base}-${suffix}`) && (installedNative(`${base}-${suffix}`, pkg.version) !== undefined || await npmManifest(`${base}-${suffix}`, pkg.version) !== null)) return { name: `${base}-${suffix}`, version: pkg.version };
  }
  throw new Error(`No Linux build is published for ${pkg.name}@${pkg.version}.`);
}

// sharp's Linux build carries its own GLib, and Electron has the system's loaded already. The two get mixed up, so
// reading an image kills the process without a message. Its WebAssembly build needs nothing from the system.
const SHARP_NATIVE = /^@img\/sharp-(?:libvips-)?darwin-arm64$/;
const SHARP_WASM = '@img/sharp-wasm32';
const EMNAPI = '@emnapi/runtime';

/** sharp falls back to its WebAssembly build by itself when no native build is there. */
async function installSharpWasm(nodeModules) {
  const sharp = join(nodeModules, 'sharp');
  const version = readJson(join(sharp, 'package.json')).version;
  const loaders = [join(sharp, 'dist', 'sharp.cjs'), join(sharp, 'lib', 'sharp.js')].filter((path) => existsSync(path));
  // Only the signed release can vouch for a package, so the signed sharp has to name this one.
  if (!loaders.some((path) => readFileSync(path, 'utf8').includes(`${SHARP_WASM}/sharp.node`))) throw new Error(`sharp ${version} no longer falls back to ${SHARP_WASM}.`);
  await installNpmPackage(SHARP_WASM, version, join(nodeModules, SHARP_WASM), installedNative(SHARP_WASM, version));
  const installed = [{ name: SHARP_WASM, version }];
  if (!existsSync(join(nodeModules, EMNAPI, 'package.json'))) {
    const wanted = readJson(join(nodeModules, SHARP_WASM, 'package.json')).dependencies?.[EMNAPI]?.match(/^\^?(\d+\.\d+\.\d+)$/)?.[1];
    if (wanted === undefined) throw new Error(`${SHARP_WASM}@${version} doesn't say which ${EMNAPI} it needs.`);
    await installNpmPackage(EMNAPI, wanted, join(nodeModules, EMNAPI), installedNative(EMNAPI, wanted));
    installed.push({ name: EMNAPI, version: wanted });
  }
  return installed;
}

async function swapNativePackages(appRoot) {
  const nodeModules = join(appRoot, 'dsh', 'node_modules');
  const installed = [];
  for (const pkg of darwinPackages(nodeModules)) {
    if (SHARP_NATIVE.test(pkg.name)) {
      rmSync(pkg.directory, { recursive: true, force: true });
      if (!installed.some(({ name }) => name === SHARP_WASM)) installed.push(...await installSharpWasm(nodeModules));
      note(`${pkg.name}@${pkg.version} -> ${SHARP_WASM}`);
      continue;
    }
    const replacement = await linuxReplacement(pkg, nodeModules);
    await installNpmPackage(replacement.name, replacement.version, join(nodeModules, replacement.name), installedNative(replacement.name, replacement.version));
    rmSync(pkg.directory, { recursive: true, force: true });
    installed.push(replacement);
    note(`${pkg.name}@${pkg.version} -> ${replacement.name}@${replacement.version}`);
  }
  return installed;
}

/** node-pty ships no Linux prebuild, so build its small addon from the bundled source. */
async function buildNodePty(appRoot) {
  const root = join(appRoot, 'dsh', 'node_modules', 'node-pty');
  const version = readJson(join(root, 'package.json')).version;
  const output = join(root, 'prebuilds', `linux-${TARGET.arch}`, 'pty.node');
  mkdirSync(dirname(output), { recursive: true });
  rmSync(join(root, 'prebuilds', 'darwin-arm64'), { recursive: true, force: true });
  rmSync(join(root, 'prebuilds', 'darwin-x64'), { recursive: true, force: true });

  const installedCopy = reuse === undefined ? undefined : join(reuse, 'resources', 'app.asar.unpacked', 'dsh', 'node_modules', 'node-pty');
  const installedVersion = installedCopy !== undefined && existsSync(join(installedCopy, 'package.json')) ? readJson(join(installedCopy, 'package.json')).version : undefined;
  const installedBinary = installedCopy === undefined ? undefined : join(installedCopy, 'prebuilds', `linux-${TARGET.arch}`, 'pty.node');
  if (typeof args['pty-binary'] === 'string') {
    cpSync(args['pty-binary'], output);
    return version;
  }
  if (installedVersion === version && existsSync(installedBinary)) {
    cpSync(installedBinary, output);
    return version;
  }

  try {
    const headers = join(work, 'node-api-headers');
    await fetchNpmPackage('node-api-headers', PINS.nodeApiHeaders, headers);
    const addonApi = join(appRoot, 'dsh', 'node_modules', 'node-addon-api');
    const flags = (source, api, include, target) => [
      '-std=c++17', '-shared', '-fPIC', '-O2', '-fstack-protector-strong', '-fexceptions',
      '-DNAPI_CPP_EXCEPTIONS', '-DBUILDING_NODE_EXTENSION', '-DNODE_GYP_MODULE_NAME=pty',
      `-I${api}`, `-I${include}`, source,
      '-lutil', '-pthread', '-static-libstdc++', '-static-libgcc', '-Wl,-z,relro,-z,now', '-s', '-o', target,
    ];
    if (args['pty-docker'] === true) {
      // Release builds compile against an old glibc so the package runs on older distributions.
      const compile = flags('/src/pty/src/unix/pty.cc', '/src/addon-api', '/src/headers/include', '/out/pty.node').map((flag) => `'${flag}'`).join(' ');
      const built = join(cache, 'pty', `${createHash('sha256').update(readFileSync(join(root, 'src', 'unix', 'pty.cc'))).update(JSON.stringify([version, compile, PINS.ptyBuildImage, PINS.nodeApiHeaders])).digest('hex')}.node`);
      if (existsSync(built)) {
        cpSync(built, output);
        return version;
      }
      run('docker', ['run', '--rm', '-u', '0',
        '-v', `${root}:/src/pty:ro`, '-v', `${addonApi}:/src/addon-api:ro`, '-v', `${headers}:/src/headers:ro`, '-v', `${dirname(output)}:/out`,
        PINS.ptyBuildImage, 'sh', '-c', `apt-get update -qq >/dev/null && apt-get install -y -qq --no-install-recommends g++ >/dev/null && g++ ${compile} && chown ${process.getuid()}:${process.getgid()} /out/pty.node`]);
      mkdirSync(dirname(built), { recursive: true });
      cpSync(output, built);
    } else {
      run(process.env.CXX ?? 'g++', flags(join(root, 'src', 'unix', 'pty.cc'), addonApi, join(headers, 'include'), output));
    }
  } catch (error) {
    // Node-API is ABI-stable, so an addon from the previous version still loads.
    if (installedBinary === undefined || !existsSync(installedBinary)) throw new Error(`Could not build node-pty: ${error.message}`);
    cpSync(installedBinary, output);
    note(`node-pty ${version}: no compiler available, reusing the addon built for ${installedVersion}`);
  }
  return version;
}

function writeRuntimeDescriptor(appRoot) {
  const root = join(appRoot, 'dsh');
  const path = join(root, 'desktop-runtime.json');
  const descriptor = readJson(path);
  descriptor.platform = 'linux';
  descriptor.arch = TARGET.arch;
  const files = [];
  const walk = (directory) => {
    for (const name of readdirSync(directory)) {
      const full = join(directory, name);
      const info = lstatSync(full);
      if (info.isDirectory()) walk(full);
      else if (full !== path) files.push({ path: relative(root, full).split(sep).join('/'), bytes: info.size, sha256: hashFile(full), executable: (info.mode & 0o100) !== 0 });
    }
  };
  walk(root);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  descriptor.files = files;
  writeFileSync(path, JSON.stringify(descriptor));
}

// --- Prebuilt runtimes ------------------------------------------------------

async function installElectron(version, destination) {
  const previous = reuse === undefined ? undefined : join(reuse, 'resources', 'linux-port', 'port-info.json');
  if (previous !== undefined && existsSync(previous) && readJson(previous).electron === version) {
    for (const name of readdirSync(reuse)) {
      if (name !== 'resources') linkTree(join(reuse, name), join(destination, name));
    }
    mkdirSync(join(destination, 'resources'), { recursive: true });
    return;
  }
  const base = `https://github.com/electron/electron/releases/download/v${version}`;
  const file = `electron-v${version}-${TARGET.electron}.zip`;
  const sums = await fetchText(`${base}/SHASUMS256.txt`);
  const line = sums.split('\n').find((row) => row.endsWith(` *${file}`) || row.endsWith(`  ${file}`));
  if (line === undefined) throw new Error(`Electron ${version} has no ${file}`);
  assertPinned(file, line.split(/\s+/)[0]);
  // Electron also publishes these hashes on npm, a second channel an attacker would have to control too.
  const npmCopy = join(work, 'electron-npm');
  await fetchNpmPackage('electron', version, npmCopy);
  if (readJson(join(npmCopy, 'checksums.json'))[file] !== line.split(/\s+/)[0]) throw new Error(`Electron ${version}: GitHub and npm disagree on the hash of ${file}`);
  const archive = await download(`${base}/${file}`, join(cache, 'electron', file), { algorithm: 'sha256', encoding: 'hex', value: line.split(/\s+/)[0] });
  unzip(archive, destination);
  renameSync(join(destination, 'electron'), join(destination, 'deepseek-harness'));
  chmodSync(join(destination, 'deepseek-harness'), 0o755);
  for (const helper of ['chrome-sandbox', 'chrome_crashpad_handler']) {
    if (existsSync(join(destination, helper))) chmodSync(join(destination, helper), 0o755);
  }
  rmSync(join(destination, 'resources', 'default_app.asar'), { force: true });
  rmSync(join(destination, 'version'), { force: true });
}

async function installNode(version, destination) {
  const previous = reuse === undefined ? undefined : join(reuse, 'resources', 'runtime', 'primary-runtime', 'runtime.json');
  const bin = join(destination, 'bin');
  mkdirSync(bin, { recursive: true });
  if (previous !== undefined && existsSync(previous) && readJson(previous).node === version) {
    linkTree(join(dirname(previous), 'dependencies', 'node', 'bin', 'node'), join(bin, 'node'));
  } else {
    const base = `https://nodejs.org/dist/v${version}`;
    // The .gz build: tar needs a separate xz program for .xz, and not every system has one.
    const file = `node-v${version}-${TARGET.node}.tar.gz`;
    const sums = await fetchText(`${base}/SHASUMS256.txt`);
    const line = sums.split('\n').find((row) => row.endsWith(`  ${file}`));
    if (line === undefined) throw new Error(`Node ${version} has no ${file}`);
    assertPinned(file, line.split(/\s+/)[0]);
    const archive = await download(`${base}/${file}`, join(cache, 'node', file), { algorithm: 'sha256', encoding: 'hex', value: line.split(/\s+/)[0] });
    const unpacked = join(work, 'node');
    untar(archive, unpacked);
    cpSync(join(unpacked, 'bin', 'node'), join(bin, 'node'));
    rmSync(unpacked, { recursive: true, force: true });
  }
  chmodSync(join(bin, 'node'), 0o755);
}

/** Official Node builds carry debug data nothing here reads. Updates may run without binutils, so this is best effort. */
function stripBinary(path) {
  const stripped = `${path}.stripped`;
  const result = spawnSync('strip', ['-o', stripped, path], { stdio: 'ignore' });
  // Stripping again shaves a few bytes, which is not worth breaking the link to the installed version.
  if (result.status === 0 && statSync(stripped).size + (1 << 20) < statSync(path).size) {
    chmodSync(stripped, 0o755);
    renameSync(stripped, path);
  } else {
    rmSync(stripped, { force: true });
  }
}

/** Add the reflink addon pnpm expects on Linux; the rest of pnpm is plain JavaScript. */
async function installPnpmNatives(pnpmRoot) {
  const scope = join(pnpmRoot, 'dist', 'node_modules', '@reflink');
  if (!existsSync(join(scope, 'reflink'))) return;
  const version = readJson(join(scope, 'reflink', 'package.json')).version;
  for (const name of ['reflink-darwin-arm64', 'reflink-darwin-x64', 'reflink-win32-arm64-msvc', 'reflink-win32-x64-msvc']) {
    rmSync(join(scope, name), { recursive: true, force: true });
  }
  const installed = reuse === undefined ? undefined : join(reuse, 'resources', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'dist', 'node_modules', '@reflink', `reflink-${TARGET.npm}-gnu`);
  const unchanged = installed !== undefined && existsSync(join(installed, 'package.json')) && readJson(join(installed, 'package.json')).version === version;
  await installNpmPackage(`@reflink/reflink-${TARGET.npm}-gnu`, version, join(scope, `reflink-${TARGET.npm}-gnu`), unchanged ? installed : undefined);
}

async function pythonRelease(version) {
  const pinned = PINS.pythonBuildStandalone[version];
  if (pinned !== undefined) return pinned;
  const releases = await fetchJson('https://api.github.com/repos/astral-sh/python-build-standalone/releases?per_page=100', { headers: { accept: 'application/vnd.github+json', 'user-agent': 'deepseek-harness-linux-port' } });
  for (const release of releases) {
    if (release.assets.some((asset) => asset.name.startsWith(`cpython-${version}+`) && asset.name.includes(`${TARGET.python}-install_only_stripped`))) return release.tag_name;
  }
  throw new Error(`No standalone Python ${version} build was found for Linux.`);
}

/** The port has no use for Electron's inspector arguments, so this closes their fuse. */
function closeInspectorFuse(binary) {
  const sentinel = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
  const INSPECT_FUSE = 3;
  const data = readFileSync(binary);
  const at = data.indexOf(sentinel);
  if (at < 0 || data.indexOf(sentinel, at + 1) >= 0) throw new Error('Electron fuses: the fuse wire was not found exactly once');
  const wire = at + sentinel.length;
  if (data[wire] !== 1 || data[wire + 1] <= INSPECT_FUSE) throw new Error(`Electron fuses: unknown wire version ${data[wire]}`);
  const fuse = wire + 2 + INSPECT_FUSE;
  if (data[fuse] !== 0x30 && data[fuse] !== 0x31) throw new Error('Electron fuses: unexpected wire contents');
  if (data[fuse] === 0x30) return;
  data[fuse] = 0x30;
  // An update may hold a hard link to the running binary here, and that file must keep its own bytes.
  writeFileSync(`${binary}.closed`, data, { mode: 0o755 });
  renameSync(`${binary}.closed`, binary);
}

const SCRIPT_HEADER = `#!/bin/sh\n'''exec' "$(dirname -- "$(realpath -- "$0")")/PYTHON" "$0" "$@"\n' '''\n`;

async function installPython(version, packages, upstreamPython, destination) {
  const previous = reuse === undefined ? undefined : join(reuse, 'resources', 'runtime', 'primary-runtime', 'runtime.json');
  if (previous !== undefined && existsSync(previous)) {
    const manifest = readJson(previous);
    if (manifest.python === version && JSON.stringify(manifest.pythonPackages) === JSON.stringify(packages)) {
      linkTree(join(dirname(previous), 'dependencies', 'python'), destination);
      return;
    }
  }
  const tag = await pythonRelease(version);
  const base = `https://github.com/astral-sh/python-build-standalone/releases/download/${tag}`;
  const file = `cpython-${version}+${tag}-${TARGET.python}-install_only_stripped.tar.gz`;
  const sums = await fetchText(`${base}/SHA256SUMS`);
  const line = sums.split('\n').find((row) => row.endsWith(`  ${file}`));
  if (line === undefined) throw new Error(`Python release ${tag} does not list ${file}`);
  assertPinned(file, line.split(/\s+/)[0]);
  const archive = await download(`${base}/${file}`, join(cache, 'python', file), { algorithm: 'sha256', encoding: 'hex', value: line.split(/\s+/)[0] });
  untar(archive, destination);

  const short = version.split('.').slice(0, 2).join('.');
  const python = join(destination, 'bin', `python${short}`);
  const env = { PATH: process.env.PATH, HOME: work, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', PIP_NO_INPUT: '1', NO_PROXY: process.env.NO_PROXY, HTTP_PROXY: process.env.HTTP_PROXY, HTTPS_PROXY: process.env.HTTPS_PROXY };
  const sitePackages = join(upstreamPython, 'lib', `python${short}`, 'site-packages');
  const pipInfo = readdirSync(sitePackages).find((name) => /^pip-.*\.dist-info$/.test(name));
  const pipSpec = pipInfo === undefined ? [] : [`pip==${pipInfo.slice(4, -10)}`];
  run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-cache-dir', '--only-binary=:all:', '--no-deps', '--no-compile', ...pipSpec, ...Object.entries(packages).map(([name, pinnedVersion]) => `${name}==${pinnedVersion}`)], { env });

  // Same relocatable script header as the macOS payload: pip wrote absolute shebangs.
  const bin = join(destination, 'bin');
  for (const name of readdirSync(bin)) {
    const path = join(bin, name);
    if (lstatSync(path).isSymbolicLink() || !statSync(path).isFile()) continue;
    const text = readFileSync(path);
    if (text.subarray(0, 2).toString() !== '#!') continue;
    // A deep build path makes pip write its three-line /bin/sh form instead of a plain shebang.
    const wrapped = text.toString('latin1').match(/^#!\/bin\/sh\n'''exec' .*\n' '''\n/);
    const newline = text.indexOf(10);
    if (wrapped === null && !text.subarray(0, newline).toString().includes('python')) continue;
    const body = text.subarray(wrapped === null ? newline + 1 : wrapped[0].length);
    writeFileSync(path, Buffer.concat([Buffer.from(SCRIPT_HEADER.replace('PYTHON', `python${short}`)), body]));
    chmodSync(path, 0o755);
  }
  for (const alias of ['python', 'python3']) {
    rmSync(join(bin, alias), { force: true });
    symlinkSync(`python${short}`, join(bin, alias));
  }
}

const PYTHON_IMPORTS = ['numpy', 'pandas', 'dateutil', 'six', 'tzdata', 'docx', 'pptx', 'openpyxl', 'PIL', 'PIL.Image', 'lxml', 'xlsxwriter', 'typing_extensions', 'et_xmlfile', 'ctypes', 'sqlite3', 'ssl', 'argparse', 'csv', 'json', 'pathlib', 'shutil', 'subprocess', 'tempfile', 'zipfile'];

/**
 * Compile what the Office tools import, since a sandboxed run cannot save its own: `import pandas`
 * drops from 0.8 s to 0.2 s. Unchecked pycs stay valid when files are copied or linked, and
 * relative names keep build paths out of them.
 */
function compilePython(root, short) {
  const marker = join(root, 'lib', `python${short}`, '__pycache__', `os.cpython-${short.replace('.', '')}.pyc`);
  if (existsSync(marker) && readFileSync(marker).readUInt32LE(4) === 3) return;
  run(join(root, 'bin', `python${short}`), ['-I', '-B', '-c', `
import importlib, os, py_compile, sys
root = os.path.realpath(sys.argv[1]) + os.sep
for name in sys.argv[2:]:
    importlib.import_module(name)
for module in list(sys.modules.values()):
    path = os.path.realpath(getattr(module, '__file__', None) or '')
    if path.startswith(root) and path.endswith('.py'):
        py_compile.compile(path, dfile=path[len(root):], doraise=True, invalidation_mode=py_compile.PycInvalidationMode.CHECKED_HASH)
`, root, ...PYTHON_IMPORTS], { cwd: work, env: { PATH: process.env.PATH, HOME: work } });
}

function payloadDigest(root) {
  const hash = createHash('sha256');
  const walk = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const full = join(directory, name);
      const info = lstatSync(full);
      if (info.isDirectory()) walk(full);
      else if (full !== join(root, 'runtime.json')) {
        hash.update(relative(root, full)).update('\0');
        hash.update(info.isSymbolicLink() ? 'link' : hashFile(full)).update('\0');
      }
    }
  };
  walk(root);
  return hash.digest('hex');
}

// --- Verification -----------------------------------------------------------

/** Exercise every native part before an update is allowed to become current. */
function smokeTest(appDir, expectedVersion) {
  const resources = join(appDir, 'resources');
  const probe = join(work, 'smoke.cjs');
  writeFileSync(probe, `
const { createRequire } = require('node:module');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const resources = ${JSON.stringify(resources)};
const r = createRequire(join(resources, 'app.asar', 'dsh', 'package.json'));
const results = {};
const attempt = async (name, fn) => { results[name] = await fn(); };
(async () => {
  if (r('../package.json').version !== ${JSON.stringify(expectedVersion)}) throw new Error('app version mismatch');
  if (process.platform !== 'linux') throw new Error('not linux');
  await attempt('node-addon-system', async () => {
    const landlock = r('@deepseek-ai/node-addon-system/landlock-run');
    const launcher = landlock.launcherPath();
    if (!require('node:fs').existsSync(launcher)) throw new Error('landlock launcher is missing: ' + launcher);
    return { landlock: landlock.probe(launcher), flock: typeof r('@deepseek-ai/node-addon-system/flock').tryLockExclusive };
  });
  await attempt('require-builtin', () => typeof r('node-addon-require-builtin').requireBuiltin);
  await attempt('koffi', () => typeof r('koffi').load);
  await attempt('sharp', async () => {
    // The app reads an image's details and decodes it before anything else, so that is what has to work here.
    const sharp = r('sharp');
    const png = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#369' } }).png().toBuffer();
    for (const format of ['png', 'jpeg', 'webp', 'gif']) {
      const image = await sharp(png)[format]().toBuffer();
      const details = await sharp(image, { failOn: 'error' }).metadata();
      const pixels = await sharp(image, { failOn: 'error' }).rotate().resize(16).raw().toBuffer();
      if (details.format !== format || details.width !== 32 || pixels.length === 0) throw new Error('sharp read ' + format + ' as ' + details.format + ' ' + details.width);
    }
    return true;
  });
  await attempt('ripgrep', () => {
    const rg = r('@vscode/ripgrep').rgPath.replace('app.asar' + require('node:path').sep, 'app.asar.unpacked' + require('node:path').sep);
    const result = spawnSync(rg, ['--version'], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error('rg failed ' + result.stderr);
    return result.stdout.split('\\n')[0];
  });
  await attempt('sherpa-onnx', () => typeof r('sherpa-onnx-node').OfflineRecognizer);
  await attempt('icons', async () => {
    const sharp = r('sharp');
    for (const size of [48, 128, 256, 512]) await sharp(join(resources, 'icon.png')).resize(size, size).png().toFile(join(resources, 'linux-port', 'packaging', 'icons', size + '.png'));
    return true;
  });
  await attempt('node-pty', () => new Promise((resolve, reject) => {
    const term = r('node-pty').spawn('/bin/sh', ['-c', 'printf port-pty-ok'], { name: 'xterm', cols: 40, rows: 5 });
    let output = '';
    const timer = setTimeout(() => reject(new Error('pty timed out')), 15000);
    term.onData((data) => { output += data; });
    term.onExit(() => {
      clearTimeout(timer);
      if (output.includes('port-pty-ok')) resolve(true); else reject(new Error('pty output: ' + output));
    });
  }));
  process.stdout.write(JSON.stringify(results));
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
`);
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_NO_ASAR;
  const report = run(join(appDir, 'deepseek-harness'), [probe], { env, timeout: 120000 });
  const dependencies = join(resources, 'runtime', 'primary-runtime', 'dependencies');
  const nodeVersion = run(join(dependencies, 'node', 'bin', 'node'), ['-v']).trim();
  const pnpmVersion = run(join(dependencies, 'node', 'bin', 'node'), [join(dependencies, 'pnpm', 'bin', 'pnpm.mjs'), '--version'], { cwd: work, env: { ...process.env, HOME: work } }).trim();
  const pythonBin = join(dependencies, 'python', 'bin');
  const pythonEnv = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
  run(join(pythonBin, 'python3'), ['-I', '-B', '-c', `import ${PYTHON_IMPORTS.join(', ')}`], { cwd: work, env: pythonEnv });
  for (const name of readdirSync(pythonBin)) {
    const script = join(pythonBin, name);
    if (lstatSync(script).isSymbolicLink() || readFileSync(script).subarray(0, 2).toString() !== '#!') continue;
    if (readFileSync(script, 'latin1').includes(appDir)) throw new Error(`Python script ${name} keeps a build path`);
  }
  run(join(pythonBin, 'pip'), ['--version'], { cwd: work, env: pythonEnv });
  note(`native check: ${report} node ${nodeVersion} pnpm ${pnpmVersion} python ok`);
}

const START_LIMIT_MS = 6e4;
let startedGroup;

/** One real start in a throwaway home: the app's own code keeps its windows off screen and reports its first page (overlay/lib/linux-updater.js). */
function startOnce(appDir, name) {
  const home = join(work, `start-${name}`);
  const started = join(home, 'started');
  mkdirSync(home, { recursive: true });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:ELECTRON_|NODE_|DBUS_)/u.test(key)));
  Object.assign(env, { HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'), XDG_CACHE_HOME: join(home, 'cache'), XDG_STATE_HOME: join(home, 'state'), DSH_LINUX_START_TEST: started });
  return new Promise((resolve) => {
    const child = spawn(join(appDir, 'deepseek-harness'), ['--no-sandbox', '--disable-gpu', '--host-resolver-rules=MAP * ~NOTFOUND'], { env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    startedGroup = child.pid;
    let tail = '';
    child.stderr.on('data', (chunk) => { tail = `${tail}${chunk}`.slice(-400); });
    let waited = false;
    const stop = setTimeout(() => {
      waited = true;
      child.kill('SIGKILL');
    }, START_LIMIT_MS);
    const finish = (detail) => {
      clearTimeout(stop);
      // The Host and its helpers go with the app, in the same process group.
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      startedGroup = undefined;
      const ok = existsSync(started);
      rmSync(home, { recursive: true, force: true, maxRetries: 5 });
      resolve(ok ? undefined : detail);
    };
    child.on('error', (error) => finish(error.message));
    // Exit, not close: the app's helpers hold the same output pipe open.
    child.on('exit', (code, signal) => finish(waited ? `no page after ${START_LIMIT_MS / 1000} s` : `it ended with ${signal ?? `code ${code}`}. ${tail.trim().split('\n').pop() ?? ''}`));
  });
}

/** Files can all be fine while the app still fails to start. If the running version cannot pass this test either, the test is what is not working here. */
async function startTest(appDir) {
  const failure = await startOnce(appDir, 'new');
  if (failure === undefined) return;
  note(`The new build did not start: ${failure}`);
  const baseline = await startOnce(reuse, 'running');
  if (baseline === undefined) throw new Error(`The new build did not start: ${failure}`);
  note(`The running version does not pass this test here either, so it says nothing: ${baseline}`);
}

// --- Main -------------------------------------------------------------------

async function main() {
  const partial = `${out}.partial`;
  rmSync(partial, { recursive: true, force: true });
  mkdirSync(partial, { recursive: true });

  step('Reading the release', 2);
  const upstream = prepareUpstream();
  const resources = join(upstream, 'Resources');
  const electronVersion = plistValue(join(upstream, 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Resources', 'Info.plist'), 'CFBundleVersion');
  const versions = readJson(join(resources, 'runtime', 'versions.json'));
  const upstreamRuntime = readJson(join(resources, 'runtime', 'primary-runtime', 'runtime.json'));
  const signedVersion = plistValue(join(upstream, 'Info.plist'), 'CFBundleShortVersionString');
  if (typeof args['expect-version'] === 'string' && signedVersion !== args['expect-version']) {
    throw new Error(`The feed announced ${args['expect-version']}, but this release is ${signedVersion}.`);
  }

  step(`Fetching Electron ${electronVersion} for Linux`, 8);
  await installElectron(electronVersion, partial);
  closeInspectorFuse(join(partial, 'deepseek-harness'));

  step('Unpacking the application', 20);
  const appRoot = join(work, 'app');
  const unpacked = extractAsar(join(resources, 'app.asar'), appRoot, (path) => MACOS_NATIVE.test(path));
  const appVersion = readJson(join(appRoot, 'package.json')).version;
  if (appVersion !== signedVersion) throw new Error(`The release says ${signedVersion}, but its application says ${appVersion}.`);

  step('Installing Linux native modules', 30);
  const natives = await swapNativePackages(appRoot);
  const ptyVersion = await buildNodePty(appRoot);

  step('Adapting the application', 45);
  const portInfo = { engine: PINS.engine, target: TARGET.npm, upstreamVersion: appVersion, electron: electronVersion, node: versions.node, pnpm: versions.pnpm, python: upstreamRuntime.python, nodePty: ptyVersion, natives, skippedPatches: [] };
  patchApp(appRoot, portInfo, args['all-patches'] === true);
  trimApp(appRoot);
  mkdirSync(join(appRoot, 'lib'), { recursive: true });
  cpSync(join(HERE, 'overlay', 'lib', 'linux-updater.js'), join(appRoot, 'lib', 'linux-updater.js'));
  writeRuntimeDescriptor(appRoot);

  step('Packing the application', 50);
  const newPackages = [...natives.map((pkg) => `dsh/node_modules/${pkg.name}/`), 'dsh/node_modules/node-pty/'];
  await createAsar(appRoot, join(partial, 'resources', 'app.asar'), (path) => unpacked.has(path) || newPackages.some((prefix) => path.startsWith(prefix)));

  step(`Fetching Node ${versions.node}`, 58);
  const runtime = join(partial, 'resources', 'runtime');
  copyTree(join(resources, 'runtime'), runtime, (path) => MACOS_RUNTIME.test(relative(upstream, path)));
  rmSync(join(runtime, 'cli', 'link-entry'), { force: true });
  rmSync(join(runtime, 'cli', 'command-path.ps1'), { force: true });
  rmSync(join(runtime, 'bin', 'node.cmd'), { force: true });
  patchRuntime(runtime, portInfo, args['all-patches'] === true);
  const dependencies = join(runtime, 'primary-runtime', 'dependencies');
  await installNode(versions.node, join(dependencies, 'node'));
  stripBinary(join(dependencies, 'node', 'bin', 'node'));
  await installPnpmNatives(join(dependencies, 'pnpm'));
  trimPnpm(join(dependencies, 'pnpm'));

  step(`Building Python ${upstreamRuntime.python} with its packages`, 65);
  rmSync(join(dependencies, 'python'), { recursive: true, force: true });
  await installPython(upstreamRuntime.python, upstreamRuntime.pythonPackages, join(resources, 'runtime', 'primary-runtime', 'dependencies', 'python'), join(dependencies, 'python'));
  const pythonShort = upstreamRuntime.python.split('.').slice(0, 2).join('.');
  trimPython(join(dependencies, 'python'), join(dependencies, 'python', 'lib', `python${pythonShort}`, 'site-packages'));
  compilePython(join(dependencies, 'python'), pythonShort);
  const runtimeManifest = { ...upstreamRuntime, platform: 'linux', arch: TARGET.arch };
  runtimeManifest.payloadDigest = payloadDigest(join(runtime, 'primary-runtime'));
  writeFileSync(join(runtime, 'primary-runtime', 'runtime.json'), `${JSON.stringify(runtimeManifest, null, 2)}\n`);

  step('Adding resources and packaging', 85);
  cpSync(join(resources, 'icon.png'), join(partial, 'resources', 'icon.png'));
  cpSync(join(resources, 'app-update.yml'), join(partial, 'resources', 'app-update.yml'));
  const portCopy = join(partial, 'resources', 'linux-port');
  for (const name of ['port.mjs', 'engine-fix.mjs', 'pins.json', 'lib', 'overlay', 'packaging']) cpSync(join(HERE, name), join(portCopy, name), { recursive: true });
  writeFileSync(join(portCopy, 'port-info.json'), `${JSON.stringify(portInfo, null, 2)}\n`);
  mkdirSync(join(portCopy, 'packaging', 'icons'), { recursive: true });

  if (/[^ -~]/.test(realpathSync(dirname(out)))) expandAsarInPlace(join(partial, 'resources', 'app.asar'));

  step('Checking every native part', 90);
  smokeTest(partial, appVersion);
  // A first build has no earlier version to compare with, and its package goes through the full tests instead.
  if (reuse !== undefined) {
    step('Starting the new build', 95);
    await startTest(partial);
  }

  rmSync(out, { recursive: true, force: true });
  renameSync(partial, out);
  step(`Linux build ${appVersion} is ready`, 100);
  if (progressJson) process.stdout.write(`${JSON.stringify({ done: true, version: appVersion, out })}\n`);
}

// On exit, not after main: when the app quits it closes the output pipes too, and the next progress
// line then ends this process with an uncaught EPIPE before any signal handler gets to run.
process.on('exit', () => {
  if (startedGroup !== undefined) try { process.kill(-startedGroup, 'SIGKILL'); } catch {}
  rmSync(work, { recursive: true, force: true });
  rmSync(`${out}.partial`, { recursive: true, force: true });
});
for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(signal, () => process.exit(1));

try {
  await main();
} catch (error) {
  // The updater shows the last line of this output to the user.
  console.error(`${error.stack}\n${error.message}`);
  process.exitCode = 1;
}
