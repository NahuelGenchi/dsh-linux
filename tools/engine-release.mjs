#!/usr/bin/env node
// Makes the signed files of an engine fix, which installed copies fetch before an update (port/engine-fix.mjs).
// The private key stays on the maintainer's machine, outside this repository.
//
//   node tools/engine-release.mjs key             creates the key and prints the public half for port/pins.json
//   node tools/engine-release.mjs pack <folder>   writes engine.json, engine.json.sig and engine-<n>.tar.gz
//
// DSH_ENGINE_KEY names another key file, and DSH_ENGINE_SOURCE another engine folder.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = process.env.DSH_ENGINE_SOURCE ?? join(HERE, '..', 'port');
const KEY = process.env.DSH_ENGINE_KEY ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'deepseek-harness-port', 'engine-signing-key.pem');
const [command, folder] = process.argv.slice(2);

const publicHalf = (key) => createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64');

if (command === 'key') {
  if (existsSync(KEY)) throw new Error(`${KEY} already exists. Installed copies trust it, so it stays.`);
  const { privateKey } = generateKeyPairSync('ed25519');
  mkdirSync(dirname(KEY), { recursive: true, mode: 0o700 });
  writeFileSync(KEY, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
  console.log(`Private key: ${KEY}. Keep a safe copy, and never commit or share it.`);
  console.log(`Public key for port/pins.json: ${publicHalf(privateKey)}`);
} else if (command === 'pack' && folder !== undefined) {
  const pins = JSON.parse(readFileSync(join(ENGINE, 'pins.json'), 'utf8'));
  const privateKey = createPrivateKey(readFileSync(KEY));
  if (publicHalf(privateKey) !== pins.engineFixes?.publicKey) throw new Error(`${KEY} is not the key pinned in pins.json, so installed copies would refuse this fix.`);
  const out = resolve(folder);
  mkdirSync(out, { recursive: true });
  const file = `engine-${pins.engine}.tar.gz`;
  const archive = join(out, file);
  const packed = spawnSync('tar', ['-C', ENGINE, '--sort=name', '--owner=0', '--group=0', '--numeric-owner', '--mtime=@0', '--transform', `s,^\\.,engine-${pins.engine},`, '-czf', archive, '.'], { stdio: 'inherit' });
  if (packed.status !== 0) throw new Error('tar failed');
  const manifest = `${JSON.stringify({ engine: pins.engine, file, sha512: createHash('sha512').update(readFileSync(archive)).digest('base64'), size: statSync(archive).size }, null, 2)}\n`;
  writeFileSync(join(out, 'engine.json'), manifest);
  writeFileSync(join(out, 'engine.json.sig'), `${sign(null, Buffer.from(manifest), privateKey).toString('base64')}\n`);
  console.log(`Engine ${pins.engine} is ready in ${out}. Check what goes out, then upload all three files to the channel's "engine" release:`);
  console.log(`gh release upload engine --clobber ${join(out, 'engine.json')} ${join(out, 'engine.json.sig')} ${archive}`);
} else {
  throw new Error('Usage: engine-release.mjs key | pack <folder>');
}
