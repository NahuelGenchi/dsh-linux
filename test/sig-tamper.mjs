// Test helper: changes a verified release in the ways an attacker would, and checks that each one is refused.
//   node test/sig-tamper.mjs <port dir> <unpacked Contents dir>
// The tree is restored after every case. Also run it with ELECTRON_RUN_AS_NODE=1 under the app's binary,
// because in-app updates verify inside Electron's Node, which uses BoringSSL.
import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [portDir, tree] = process.argv.slice(2).map((path) => resolve(path));
const { verifyRelease } = await import(pathToFileURL(join(portDir, 'lib', 'codesign.mjs')).href);
const pins = JSON.parse(readFileSync(join(portDir, 'pins.json'), 'utf8')).signature;
const macho = join(tree, 'MacOS', 'DeepSeek Harness');
const scratch = mkdtempSync(join(process.env.SEC_SCRATCH ?? tmpdir(), 'sig-'));
let failures = 0;

function verdict(name, wanted, run) {
  let outcome;
  try {
    const { team } = run();
    outcome = `accepted, team ${team}`;
  } catch (error) {
    outcome = `refused: ${error.message.split('\n')[0].slice(0, 90)}`;
  }
  const good = outcome.startsWith(wanted);
  if (!good) failures++;
  console.log(`${good ? 'PASS' : 'FAIL'}  ${name}  (${outcome})`);
}

/** Change one file, expect a refusal, put it back. */
function tampered(name, file, change, options = pins) {
  const path = join(tree, file);
  const saved = join(scratch, 'saved');
  const existed = existsSync(path);
  if (existed) copyFileSync(path, saved);
  try {
    change(path);
    verdict(name, 'refused', () => verifyRelease(tree, options));
  } finally {
    rmSync(path, { force: true });
    if (existed) renameSync(saved, path);
  }
}

function openssl(...args) {
  const result = spawnSync('openssl', args, { encoding: 'utf8', cwd: scratch });
  if (result.status !== 0) throw new Error(`openssl ${args[0]}: ${result.stderr}`);
  return result.stdout;
}

/** A complete signature made with a home-made "Apple Root CA", valid in every way except for its root. */
function forgeSignature() {
  const ext = (name, body) => writeFileSync(join(scratch, name), `[v3]\n${body}\n`);
  ext('ca.cnf', 'basicConstraints=critical,CA:TRUE\nkeyUsage=keyCertSign\n1.2.840.113635.100.6.2.6=DER:0500');
  ext('leaf.cnf', 'basicConstraints=critical,CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=codeSigning\n1.2.840.113635.100.6.1.13=DER:0500');
  openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'root.key', '-out', 'root.pem', '-days', '30', '-subj', '/C=US/O=Apple Inc./OU=Apple Certification Authority/CN=Apple Root CA');
  openssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.csr', '-subj', '/CN=Developer ID Certification Authority/OU=Apple Certification Authority/O=Apple Inc./C=US');
  openssl('x509', '-req', '-in', 'ca.csr', '-CA', 'root.pem', '-CAkey', 'root.key', '-CAcreateserial', '-out', 'ca.pem', '-days', '30', '-extfile', 'ca.cnf', '-extensions', 'v3');
  openssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', `/CN=Developer ID Application: Forged/OU=${pins.teamId}/O=Forged/C=US`);
  openssl('x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'leaf.pem', '-days', '30', '-extfile', 'leaf.cnf', '-extensions', 'v3');
  writeFileSync(join(scratch, 'chain.pem'), Buffer.concat([readFileSync(join(scratch, 'ca.pem')), readFileSync(join(scratch, 'root.pem'))]));

  // Find the signature in the program, keep its CodeDirectory and replace only the CMS part.
  const program = readFileSync(macho);
  if (program.readUInt32LE(0) !== 0xfeedfacf) throw new Error('this helper expects a thin Mach-O program');
  let position = 32;
  let command = -1;
  for (let left = program.readUInt32LE(16); left > 0; left--) {
    if (program.readUInt32LE(position) === 0x1d) command = position;
    position += program.readUInt32LE(position + 4);
  }
  const offset = program.readUInt32LE(command + 8);
  const blob = program.subarray(offset, offset + program.readUInt32LE(command + 12));
  const entries = [];
  for (let i = 0; i < blob.readUInt32BE(8); i++) {
    const start = blob.readUInt32BE(16 + i * 8);
    entries.push({ type: blob.readUInt32BE(12 + i * 8), data: blob.subarray(start, start + blob.readUInt32BE(start + 4)) });
  }
  writeFileSync(join(scratch, 'cd.bin'), entries.find((entry) => entry.type === 0).data);
  openssl('cms', '-sign', '-binary', '-in', 'cd.bin', '-signer', 'leaf.pem', '-inkey', 'leaf.key', '-certfile', 'chain.pem', '-md', 'sha256', '-outform', 'DER', '-out', 'cms.der');
  const cms = readFileSync(join(scratch, 'cms.der'));
  const wrapper = Buffer.alloc(8);
  wrapper.writeUInt32BE(0xfade0b01, 0);
  wrapper.writeUInt32BE(8 + cms.length, 4);
  const replaced = entries.map((entry) => (entry.type === 0x10000 ? { ...entry, data: Buffer.concat([wrapper, cms]) } : entry));
  const index = Buffer.alloc(12 + replaced.length * 8);
  let at = index.length;
  for (const [i, entry] of replaced.entries()) {
    index.writeUInt32BE(entry.type, 12 + i * 8);
    index.writeUInt32BE(at, 16 + i * 8);
    at += entry.data.length;
  }
  index.writeUInt32BE(0xfade0cc0, 0);
  index.writeUInt32BE(at, 4);
  index.writeUInt32BE(replaced.length, 8);
  const signature = Buffer.concat([index, ...replaced.map((entry) => entry.data)]);
  const forged = Buffer.concat([program.subarray(0, offset), signature]);
  forged.writeUInt32LE(signature.length, command + 12);
  const root = spawnSync('openssl', ['x509', '-in', join(scratch, 'root.pem'), '-noout', '-fingerprint', '-sha256'], { encoding: 'utf8' }).stdout.trim().split('=')[1];
  return { forged, root };
}

verdict('untouched release', 'accepted', () => verifyRelease(tree, pins));
verdict('wrong team pin', 'refused', () => verifyRelease(tree, { ...pins, teamId: 'AAAAAAAAAA' }));
verdict('wrong bundle pin', 'refused', () => verifyRelease(tree, { ...pins, bundleId: 'com.example.other' }));
verdict('wrong root pin', 'refused', () => verifyRelease(tree, { ...pins, appleRootSha256: pins.appleRootSha256.replace(/^B0/, 'B1') }));
tampered('changed resource', 'Resources/app-update.yml', (path) => appendFileSync(path, '# changed\n'));
tampered('added file nobody signed', 'Resources/extra.js', (path) => writeFileSync(path, 'evil()\n'));
tampered('removed signed file', 'Resources/app-update.yml', (path) => rmSync(path));
tampered('changed Info.plist', 'Info.plist', (path) => writeFileSync(path, readFileSync(path, 'utf8').replace('<key>CFBundleShortVersionString</key>', '<key>CFBundleShortVersionString</key><!-- -->')));
tampered('changed CodeResources', '_CodeSignature/CodeResources', (path) => appendFileSync(path, '\n'));
tampered('garbage instead of the program', 'MacOS/DeepSeek Harness', (path) => writeFileSync(path, Buffer.alloc(4096, 0x41)));
/** The signature blob of the type asked for: 0 is the CodeDirectory, 0x10000 the CMS. */
function blobOf(data, type) {
  let position = 32;
  for (let left = data.readUInt32LE(16); left > 0; left--) {
    if (data.readUInt32LE(position) === 0x1d) {
      const offset = data.readUInt32LE(position + 8);
      for (let i = 0; i < data.readUInt32BE(offset + 8); i++) {
        if (data.readUInt32BE(offset + 12 + i * 8) !== type) continue;
        const start = offset + data.readUInt32BE(offset + 16 + i * 8);
        return { start, end: start + data.readUInt32BE(start + 4) };
      }
    }
    position += data.readUInt32LE(position + 4);
  }
  throw new Error('signature blob not found');
}
tampered('flipped byte in the CodeDirectory', 'MacOS/DeepSeek Harness', (path) => {
  const data = readFileSync(path);
  data[blobOf(data, 0).end - 1] ^= 0xff;
  writeFileSync(path, data);
});
tampered('changed signing time, a signed field', 'MacOS/DeepSeek Harness', (path) => {
  const data = readFileSync(path);
  const { start, end } = blobOf(data, 0x10000);
  const oid = data.subarray(start, end).indexOf(Buffer.from('2a864886f70d010905', 'hex'));
  const time = data.subarray(start + oid, end).indexOf(Buffer.from([0x17, 13]));
  data[start + oid + time + 2 + 11] ^= 1;
  writeFileSync(path, data);
});
tampered('changed Electron version file', 'Frameworks/Electron Framework.framework/Versions/A/Resources/Info.plist', (path) => appendFileSync(path, '\n'));
tampered('removed the program', 'MacOS/DeepSeek Harness', (path) => rmSync(path));

// Control first: with the home-made root pinned, the forgery passes, so nothing but the pin stops it.
const { forged, root } = forgeSignature();
copyFileSync(macho, join(scratch, 'program'));
writeFileSync(macho, forged);
try {
  verdict('forged chain, home-made root pinned (control)', 'accepted', () => verifyRelease(tree, { ...pins, appleRootSha256: root }));
  verdict('forged chain, real pin', 'refused', () => verifyRelease(tree, pins));
} finally {
  copyFileSync(join(scratch, 'program'), macho);
}
verdict('untouched again', 'accepted', () => verifyRelease(tree, pins));
console.log(failures === 0 ? 'all cases behaved' : `${failures} cases misbehaved`);
rmSync(scratch, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
