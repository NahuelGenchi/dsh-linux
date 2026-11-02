#!/usr/bin/env node
// Engine fixes. DeepSeek's releases never carry this engine, so a release it cannot build would
// otherwise wait until the user installs a new package. Before each update the app asks the port's
// own channel for a newer engine. It takes one only if the key pinned in pins.json signed it and its
// number is above every engine here. Nothing else ever lands in <root>/engines, and any failure
// leaves the update to carry on with the engine it has.
//
//   deepseek-harness engine-fix.mjs --root <install root>
import { createPublicKey, verify } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { download, fetchText, untar } from './lib/fetch.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PINS = JSON.parse(readFileSync(join(HERE, 'pins.json'), 'utf8'));
const MAX_MANIFEST_BYTES = 4096;
const MAX_ENGINE_BYTES = 32 * 1024 ** 2;
const REQUEST_LIMIT_MS = 15e3;
const ENGINE_FILES = ['port.mjs', 'engine-fix.mjs', 'pins.json', 'lib/patches.mjs', 'overlay/lib/linux-updater.js', 'packaging/launcher.sh'];

process.umask(0o022);
delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

const rootAt = process.argv.indexOf('--root');
const root = process.argv[rootAt + 1];
if (rootAt < 0 || root === undefined) throw new Error('Usage: engine-fix.mjs --root <install root>');
const engines = join(root, 'engines');

const read = (url) => fetchText(url, { signal: AbortSignal.timeout(REQUEST_LIMIT_MS) });
const numbered = (name) => /^\d+$/u.test(name);

function feedBase() {
  const override = process.env.DSH_LINUX_ENGINE_FEED;
  const feed = override || PINS.engineFixes?.feed;
  if (typeof feed !== 'string') return undefined;
  const base = new URL(feed.endsWith('/') ? feed : `${feed}/`);
  if (base.protocol !== 'https:' && !override) throw new Error(`The engine channel must use HTTPS: ${base.href}`);
  return base;
}

/** The manifest is only read once the pinned key has vouched for it. */
function readManifest(text, signature) {
  if (text.length > MAX_MANIFEST_BYTES || signature.length > MAX_MANIFEST_BYTES) throw new Error('The engine manifest is too large');
  const key = createPublicKey({ key: Buffer.from(PINS.engineFixes.publicKey, 'base64'), format: 'der', type: 'spki' });
  if (!verify(null, Buffer.from(text), key, Buffer.from(signature.trim(), 'base64'))) throw new Error('The engine manifest is not signed by the pinned key');
  const manifest = JSON.parse(text);
  if (!Number.isSafeInteger(manifest.engine) || manifest.engine < 1) throw new Error('The engine manifest has no valid number');
  if (manifest.file !== `engine-${manifest.engine}.tar.gz`) throw new Error('The engine manifest names an unexpected file');
  if (typeof manifest.sha512 !== 'string' || manifest.sha512 === '') throw new Error('The engine manifest has no hash');
  if (!Number.isSafeInteger(manifest.size) || manifest.size < 1 || manifest.size > MAX_ENGINE_BYTES) throw new Error('The engine manifest has an unexpected size');
  return manifest;
}

async function main() {
  // In the install root, not in the settings a version carries, so it outlasts updates.
  if (existsSync(join(root, 'no-engine-fixes'))) return 'Engine fixes are turned off.';
  const base = feedBase();
  if (base === undefined || typeof PINS.engineFixes?.publicKey !== 'string') return 'This engine has no channel for fixes.';
  if (existsSync(engines)) for (const name of readdirSync(engines)) if (!numbered(name)) rmSync(join(engines, name), { recursive: true, force: true });

  let text;
  let signature;
  try {
    text = await read(new URL('engine.json', base));
    signature = await read(new URL('engine.json.sig', base));
  } catch (error) {
    if (error.permanent) return 'The channel has no engine fix.';
    throw error;
  }
  const manifest = readManifest(text, signature);
  const newest = Math.max(PINS.engine, ...(existsSync(engines) ? readdirSync(engines).filter(numbered).map(Number) : []));
  if (manifest.engine <= newest) return `Engine ${newest} is up to date, the channel offers ${manifest.engine}.`;

  mkdirSync(engines, { recursive: true, mode: 0o700 });
  const archive = join(engines, `.${manifest.file}`);
  const unpacked = join(engines, `.engine-${manifest.engine}`);
  try {
    await download(new URL(manifest.file, base).href, archive, { algorithm: 'sha512', encoding: 'base64', value: manifest.sha512 });
    rmSync(unpacked, { recursive: true, force: true });
    untar(archive, unpacked);
    for (const file of ENGINE_FILES) if (!existsSync(join(unpacked, file))) throw new Error(`Engine ${manifest.engine} has no ${file}`);
    if (JSON.parse(readFileSync(join(unpacked, 'pins.json'), 'utf8')).engine !== manifest.engine) throw new Error(`The files of engine ${manifest.engine} carry another number`);
    renameSync(unpacked, join(engines, String(manifest.engine)));
  } finally {
    rmSync(archive, { force: true });
    rmSync(unpacked, { recursive: true, force: true });
  }
  for (const name of readdirSync(engines)) if (numbered(name) && Number(name) < manifest.engine) rmSync(join(engines, name), { recursive: true, force: true });
  return `Added engine ${manifest.engine}.`;
}

try {
  console.log(await main());
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
