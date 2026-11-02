// Checks a macOS release against its Apple code signature, so trust does not rest on the
// download host alone. The chain, each step vouching for the next:
//   Apple Root CA (pinned) > Developer ID CA > DeepSeek's certificate (pinned team)
//   > CMS signature > CodeDirectory > Info.plist and CodeResources > every file the port reads.
// Revocation is not checked, because that needs Apple's servers. No npm dependencies, as in asar.mjs.
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, readdirSync, readlinkSync } from 'node:fs';
import { X509Certificate, createHash, createVerify } from 'node:crypto';
import { join } from 'node:path';

const OID = {
  messageDigest: '2a864886f70d010904',
  signingTime: '2a864886f70d010905',
  sha256: '608648016503040201',
  developerIdApplication: '2a864886f7636406010d',
  developerIdCa: '2a864886f76364060206',
};
const ELECTRON_FRAMEWORK = 'Frameworks/Electron Framework.framework/Versions/A';

const fail = (message) => {
  throw new Error(`release signature: ${message}`);
};
const sha256 = (data) => createHash('sha256').update(data);

/** Which zip entries the port needs, as paths below Contents. */
export function releaseEntry(name) {
  const match = name.match(/^[^/]+\.app\/Contents\/(.*)$/);
  if (match === null) return undefined;
  const inner = match[1];
  if (inner.startsWith('Resources/') || inner.startsWith('MacOS/')) return inner;
  if (inner === 'Info.plist' || inner === '_CodeSignature/CodeResources') return inner;
  if (inner === `${ELECTRON_FRAMEWORK}/Electron Framework` || inner === `${ELECTRON_FRAMEWORK}/Resources/Info.plist`) return inner;
  return undefined;
}

// --- BER, as Apple's signer writes it: definite lengths and indefinite ones --

function parseBer(buffer, start, limit, depth = 0) {
  if (depth > 32 || start + 2 > limit) fail('malformed CMS data');
  const node = { tag: buffer[start], start };
  let cursor = start + 2;
  let length = buffer[start + 1];
  if (length === 0x80) {
    node.children = [];
    while (cursor + 2 <= limit && (buffer[cursor] !== 0 || buffer[cursor + 1] !== 0)) {
      const child = parseBer(buffer, cursor, limit, depth + 1);
      node.children.push(child);
      cursor = child.end;
    }
    node.body = start + 2;
    node.bodyEnd = cursor;
    node.end = cursor + 2;
    if (node.end > limit) fail('malformed CMS data');
    return node;
  }
  if (length > 0x80) {
    const count = length - 0x80;
    if (count > 4 || cursor + count > limit) fail('malformed CMS data');
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + buffer[cursor++];
  }
  node.body = cursor;
  node.bodyEnd = cursor + length;
  node.end = node.bodyEnd;
  if (node.end > limit) fail('malformed CMS data');
  if ((node.tag & 0x20) !== 0) {
    node.children = [];
    while (cursor < node.bodyEnd) {
      const child = parseBer(buffer, cursor, node.bodyEnd, depth + 1);
      node.children.push(child);
      cursor = child.end;
    }
  }
  return node;
}

const raw = (buffer, node) => buffer.subarray(node.start, node.end);
const value = (buffer, node) => buffer.subarray(node.body, node.bodyEnd);
const oidOf = (buffer, node) => value(buffer, node).toString('hex');

// --- Mach-O: find the signature, which sits at the end of the executable -----

const LC_CODE_SIGNATURE = 0x1d;
const CPU_ARM64 = 0x0100000c;

function readAt(fd, length, position) {
  const buffer = Buffer.alloc(length);
  if (readSync(fd, buffer, 0, length, position) !== length) fail('the executable is truncated');
  return buffer;
}

function signatureBlobs(path) {
  const fd = openSync(path, 'r');
  try {
    let base = 0;
    const first = readAt(fd, 8, 0);
    if (first.readUInt32BE(0) === 0xcafebabe) {
      const count = first.readUInt32BE(4);
      if (count > 16) fail('malformed executable');
      const slices = readAt(fd, count * 20, 8);
      for (let i = 0; i < count; i++) {
        if (slices.readUInt32BE(i * 20) === CPU_ARM64) base = slices.readUInt32BE(i * 20 + 8);
      }
    }
    const header = readAt(fd, 32, base);
    if (header.readUInt32LE(0) !== 0xfeedfacf) fail('the executable is not a 64-bit Mach-O file');
    const commandBytes = header.readUInt32LE(20);
    if (commandBytes > 1 << 20) fail('malformed executable');
    const commands = readAt(fd, commandBytes, base + 32);
    let signature;
    for (let position = 0, left = header.readUInt32LE(16); left > 0; left--) {
      if (commands.readUInt32LE(position) === LC_CODE_SIGNATURE) {
        const size = commands.readUInt32LE(position + 12);
        if (size > 1 << 26) fail('the signature is too large');
        signature = readAt(fd, size, base + commands.readUInt32LE(position + 8));
      }
      position += commands.readUInt32LE(position + 4);
    }
    if (signature === undefined) fail(`${path} is not signed`);
    if (signature.readUInt32BE(0) !== 0xfade0cc0) fail('malformed signature blob');
    const blobs = new Map();
    const count = signature.readUInt32BE(8);
    if (count > 64) fail('malformed signature blob');
    for (let i = 0; i < count; i++) {
      const offset = signature.readUInt32BE(16 + i * 8);
      const length = signature.readUInt32BE(offset + 4);
      if (offset + length > signature.length) fail('malformed signature blob');
      blobs.set(signature.readUInt32BE(12 + i * 8), signature.subarray(offset, offset + length));
    }
    return blobs;
  } finally {
    closeSync(fd);
  }
}

/** Read a CodeDirectory: the signed list of hashes for this bundle's special files. */
function parseCodeDirectory(blob) {
  if (blob === undefined || blob.readUInt32BE(0) !== 0xfade0c02) fail('no code directory');
  const version = blob.readUInt32BE(8);
  const hashOffset = blob.readUInt32BE(16);
  const identifierOffset = blob.readUInt32BE(20);
  const specialSlots = blob.readUInt32BE(24);
  const hashSize = blob[36];
  if (blob[37] !== 2 || hashSize !== 32) fail('the code directory does not use SHA-256');
  const text = (offset) => blob.toString('utf8', offset, blob.indexOf(0, offset));
  const teamOffset = version >= 0x20200 ? blob.readUInt32BE(48) : 0;
  return {
    identifier: text(identifierOffset),
    team: teamOffset === 0 ? undefined : text(teamOffset),
    slot(number) {
      if (number > specialSlots) fail(`code directory slot ${number} is missing`);
      return blob.subarray(hashOffset - number * hashSize, hashOffset - (number - 1) * hashSize);
    },
  };
}
const SLOT_INFO_PLIST = 1;
const SLOT_CODE_RESOURCES = 3;

// --- CMS: Apple's chain signs the CodeDirectory -----------------------------

function verifyCms(cms, codeDirectory, pins) {
  const content = parseBer(cms, 0, cms.length);
  const signedData = content.children?.[1]?.children?.[0];
  if (signedData?.children === undefined) fail('malformed CMS data');
  const certificateSet = signedData.children.find((node) => node.tag === 0xa0);
  const signerSet = signedData.children.at(-1);
  if (certificateSet === undefined || signerSet?.children?.length !== 1) fail('expected one signer with its certificates');
  const certificates = certificateSet.children.map((node) => new X509Certificate(raw(cms, node)));

  const signer = signerSet.children[0];
  const [, identifier, digestAlgorithm, attributes, , signature] = signer.children;
  if (attributes?.tag !== 0xa0) fail('the signature has no signed attributes');
  if (oidOf(cms, digestAlgorithm.children[0]) !== OID.sha256) fail('the signature does not use SHA-256');
  const attribute = (oid) => attributes.children.find((node) => oidOf(cms, node.children[0]) === oid)?.children[1].children[0];

  const serial = value(cms, identifier.children[1]).toString('hex').replace(/^(00)+/, '').toUpperCase();
  const leaf = certificates.find((certificate) => certificate.serialNumber.replace(/^(00)+/, '').toUpperCase() === serial);
  if (leaf === undefined) fail('the signing certificate is missing');

  // Walk up to the pinned root. Certificates in the blob are claims until this reaches it.
  const chain = [leaf];
  let reachedRoot = false;
  for (let current = leaf; chain.length <= 4; ) {
    if (current.fingerprint256 === pins.appleRootSha256) {
      reachedRoot = true;
      break;
    }
    const issuer = certificates.find((candidate) => candidate !== current && current.checkIssued(candidate) && current.verify(candidate.publicKey));
    if (issuer === undefined) break;
    chain.push(issuer);
    current = issuer;
  }
  if (!reachedRoot) fail('the certificate chain does not lead to Apple\'s root');
  const holds = (certificate, oid) => certificate.raw.includes(Buffer.from(oid, 'hex'));
  if (!holds(leaf, OID.developerIdApplication)) fail('the signing certificate is not a Developer ID certificate');
  if (chain.length < 3 || !chain[1].ca || !holds(chain[1], OID.developerIdCa)) fail('the certificate was not issued by Apple\'s Developer ID authority');
  const team = leaf.subject.match(/^OU=(.+)$/m)?.[1];
  if (team !== pins.teamId) fail(`signed by team ${team}, expected ${pins.teamId}`);

  const digest = attribute(OID.messageDigest);
  if (digest === undefined || !value(cms, digest).equals(sha256(codeDirectory).digest())) fail('the signature does not cover this code directory');
  const signingTimeNode = attribute(OID.signingTime);
  if (signingTimeNode === undefined) fail('the signature has no signing time');
  const signedAt = parseUtcTime(value(cms, signingTimeNode).toString('latin1'));
  if (signedAt < new Date(leaf.validFrom) || signedAt > new Date(leaf.validTo)) fail('the certificate was not valid when this was signed');

  // CMS signs the attributes with a SET tag in place of the implicit [0].
  const signedBytes = Buffer.from(raw(cms, attributes));
  signedBytes[0] = 0x31;
  if (!createVerify('sha256').update(signedBytes).verify(leaf.publicKey, value(cms, signature))) fail('the signature is invalid');
  return { team, signedAt };
}

function parseUtcTime(text) {
  const match = text.match(/^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)Z$/);
  if (match === null) fail('unreadable signing time');
  const [, year, month, day, hour, minute, second] = match;
  return new Date(Date.UTC(2000 + Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)));
}

// --- CodeResources: the signed hash of every resource ------------------------

const unescapeXml = (text) => text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');

function parseCodeResources(xml) {
  const open = xml.indexOf('<dict>', xml.indexOf('<key>files2</key>'));
  const close = xml.indexOf('<key>rules</key>', open);
  if (open < 0 || close < 0) fail('CodeResources has no file list');
  const files = new Map();
  for (const [, key, body] of xml.slice(open + 6, close).matchAll(/<key>([^<]*)<\/key>\s*<dict>([\s\S]*?)<\/dict>/g)) {
    const data = (name) => body.match(new RegExp(`<key>${name}</key>\\s*<data>\\s*([^<]*?)\\s*</data>`))?.[1];
    files.set(unescapeXml(key), {
      hash2: data('hash2'),
      cdhash: data('cdhash'),
      symlink: body.match(/<key>symlink<\/key>\s*<string>([^<]*)<\/string>/)?.[1],
      optional: /<key>optional<\/key>\s*<true\/>/.test(body),
    });
  }
  if (files.size === 0) fail('CodeResources lists no files');
  return files;
}

function hashFile(path) {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  const buffer = Buffer.alloc(1 << 20);
  try {
    let read;
    while ((read = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read));
  } finally {
    closeSync(fd);
  }
  return hash.digest('base64');
}

/** Every file below Resources must be listed and match, and every listed file must be there. */
function verifyResources(contents, files) {
  const seen = new Set();
  const walk = (directory, prefix) => {
    for (const name of readdirSync(directory)) {
      if (name.includes(':com.apple.')) continue;
      const path = join(directory, name);
      const relative = `${prefix}/${name}`;
      const info = lstatSync(path);
      if (info.isDirectory()) {
        walk(path, relative);
        continue;
      }
      const entry = files.get(relative);
      if (entry === undefined) fail(`${relative} is not part of the signed release`);
      seen.add(relative);
      if (info.isSymbolicLink()) {
        if (entry.symlink !== readlinkSync(path)) fail(`${relative} is a link the signature does not list`);
      } else if (entry.hash2 === undefined || hashFile(path) !== entry.hash2) {
        fail(`${relative} does not match the signed release`);
      }
    }
  };
  walk(join(contents, 'Resources'), 'Resources');
  for (const [relative, entry] of files) {
    if (relative.startsWith('Resources/') && !entry.optional && !seen.has(relative)) fail(`${relative} is missing from the release`);
  }
}

// --- Entry point -------------------------------------------------------------

/**
 * Verify a Contents folder. Throws unless the whole chain holds.
 * @param pins - { appleRootSha256, teamId, bundleId } from pins.json.
 */
export function verifyRelease(contents, pins) {
  const infoPath = join(contents, 'Info.plist');
  const resourcesPath = join(contents, '_CodeSignature', 'CodeResources');
  if (!existsSync(infoPath) || !existsSync(resourcesPath)) fail('the release carries no signature files');
  const info = readFileSync(infoPath);
  const executable = info.toString('utf8').match(/<key>CFBundleExecutable<\/key>\s*<string>([^<\/]+)<\/string>/)?.[1];
  if (executable === undefined) fail('Info.plist names no executable');

  const blobs = signatureBlobs(join(contents, 'MacOS', executable));
  const directoryBlob = blobs.get(0);
  const directory = parseCodeDirectory(directoryBlob);
  const cms = blobs.get(0x10000);
  if (cms === undefined) fail('the executable has no signature');
  const { team, signedAt } = verifyCms(cms.subarray(8), directoryBlob, pins);

  if (directory.team !== pins.teamId) fail(`code directory team is ${directory.team}, expected ${pins.teamId}`);
  if (directory.identifier !== pins.bundleId) fail(`bundle is ${directory.identifier}, expected ${pins.bundleId}`);
  if (!directory.slot(SLOT_INFO_PLIST).equals(sha256(info).digest())) fail('Info.plist does not match the signature');
  const resources = readFileSync(resourcesPath);
  if (!directory.slot(SLOT_CODE_RESOURCES).equals(sha256(resources).digest())) fail('CodeResources does not match the signature');

  const files = parseCodeResources(resources.toString('utf8'));
  verifyResources(contents, files);

  // The Electron version comes from the framework's Info.plist, signed through its own directory.
  const nested = files.get('Frameworks/Electron Framework.framework');
  if (nested?.cdhash === undefined) fail('CodeResources does not list Electron');
  const frameworkBlob = signatureBlobs(join(contents, ELECTRON_FRAMEWORK, 'Electron Framework')).get(0);
  if (frameworkBlob === undefined) fail('Electron has no code directory');
  if (!sha256(frameworkBlob).digest().subarray(0, 20).equals(Buffer.from(nested.cdhash, 'base64'))) fail('Electron does not match the signature');
  const frameworkInfo = readFileSync(join(contents, ELECTRON_FRAMEWORK, 'Resources', 'Info.plist'));
  if (!parseCodeDirectory(frameworkBlob).slot(SLOT_INFO_PLIST).equals(sha256(frameworkInfo).digest())) fail('Electron\'s Info.plist does not match the signature');
  return { team, signedAt };
}
