// Test helper: runs the real update code against a local feed, with Electron stubbed out and a
// stand-in engine that only records how it was started. Nothing is built or installed.
//   node test/updater-unit.mjs <port dir> <scratch dir>
import { createHash } from 'node:crypto';
import fs, { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [portDir, scratchDir] = process.argv.slice(2).map((path) => resolve(path));
rmSync(scratchDir, { recursive: true, force: true });

const INSTALLED = '1.0.0';
const root = join(scratchDir, 'root');
const resources = join(root, 'versions', INSTALLED, 'resources');
mkdirSync(join(resources, 'linux-port'), { recursive: true });
symlinkSync(join('versions', INSTALLED), join(root, 'current'));
// The stand-in engine: writes down its arguments and environment, then says the build worked.
const record = join(scratchDir, 'engine.json');
writeFileSync(join(resources, 'linux-port', 'port.mjs'), `import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
const out = process.argv[process.argv.indexOf('--out') + 1];
mkdirSync(out, { recursive: true });
if (!existsSync(out + '/deepseek-harness')) writeFileSync(out + '/deepseek-harness', '');
writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));
`);
const program = join(root, 'versions', INSTALLED, 'deepseek-harness');
writeFileSync(program, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
chmodSync(program, 0o755);
Object.defineProperty(process, 'execPath', { value: program });
process.resourcesPath = resources;

// Plain Node has no electron, semver or js-yaml next to the overlay, so give it small equivalents.
const STUBS = {
  electron: `export const app = { getVersion: () => ${JSON.stringify(INSTALLED)}, getLocale: () => globalThis.testLocale ?? 'en-US', once() {}, off() {}, relaunch() {}, quit() {} };
    export const net = { fetch: (...args) => globalThis.fetch(...args) };
    export class BrowserWindow { static getFocusedWindow() { return null; } }
    export const dialog = { showMessageBox: (options) => globalThis.testDialog(options) };`,
  semver: `const parse = (v) => /^(\\d+)\\.(\\d+)\\.(\\d+)(-[0-9A-Za-z.-]+)?$/.exec(v);
    export const valid = (v) => { const clean = String(v).trim().replace(/^[=v]+/, ''); return parse(clean) ? clean : null; };
    export const gt = (a, b) => { const x = parse(a).slice(1, 4).map(Number), y = parse(b).slice(1, 4).map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };`,
  'js-yaml': `export default { load: (text) => JSON.parse(text) };`,
};
registerHooks({
  resolve(specifier, context, next) {
    return specifier in STUBS ? { url: `stub:${specifier}`, shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    return url.startsWith('stub:') ? { source: STUBS[url.slice(5)], format: 'module', shortCircuit: true } : next(url, context);
  },
});

// --- A local feed ------------------------------------------------------------

const payload = Buffer.alloc(4096, 0x5a);
const hash = createHash('sha512').update(payload).digest('base64');
let feed = {};
let body = payload;
let served = Promise.resolve(true);
const server = createServer((request, response) => {
  if (request.url.endsWith('-mac.yml')) {
    response.end(JSON.stringify(feed));
    return;
  }
  // In pieces, so a client that hangs up early can be told from one that takes it all.
  let closed = false;
  response.once('close', () => { closed = true; });
  served = (async () => {
    let sent = 0;
    while (sent < body.length && !closed) {
      const piece = body.subarray(sent, sent + 1024 ** 2);
      sent += piece.length;
      if (!response.write(piece)) await new Promise((go) => { response.once('drain', go); response.once('close', go); });
      await new Promise(setImmediate);
    }
    response.end();
    return !closed;
  })();
});
await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
process.env.DSH_LINUX_UPDATE_FEED = `http://127.0.0.1:${server.address().port}/`;
process.env.DEEPSEEK_API_KEY = 'placeholder-not-a-key';
process.env.GH_TOKEN = 'placeholder-not-a-token';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
process.env.NODE_PATH = '/nonexistent';

const { linuxAutoUpdater: updater } = await import(pathToFileURL(join(portDir, 'overlay', 'lib', 'linux-updater.js')).href);
const release = (version, extra = {}) => ({ version, files: [{ url: 'r.zip', sha512: hash, size: payload.length, ...extra }] });
const mode = (path) => (existsSync(path) ? (statSync(path).mode & 0o777).toString(8) : 'missing');

let failures = 0;
function check(name, good, detail = '') {
  if (!good) failures++;
  console.log(`${good ? 'SAFE  ' : 'UNSAFE'}  ${name}${detail === '' ? '' : `  (${detail})`}`);
}
async function refused(run) {
  try {
    await run();
    return false;
  } catch {
    return true;
  }
}
const staging = join(root, 'staging');
const leftovers = () => (existsSync(staging) ? readdirSync(staging).filter((name) => name.endsWith('.partial')).length : 0);

for (const version of ['v2.0.0', ' 2.0.0', '=2.0.0', '2.0', '../../2.0.0']) {
  feed = release(version);
  check(`feed version ${JSON.stringify(version)} is refused`, await refused(() => updater.checkForUpdates()));
}

feed = release('0.9.0');
await updater.checkForUpdates();
check('an older version cannot be installed', await refused(() => updater.downloadUpdate()));
rmSync(join(root, 'versions', '0.9.0'), { recursive: true, force: true });

feed = release(INSTALLED);
await updater.checkForUpdates();
check('the same version cannot be reinstalled', await refused(() => updater.downloadUpdate()));

feed = release('2.0.0');
body = Buffer.alloc(256 * 1024 * 1024, 0x5a);
await updater.checkForUpdates();
const oversizeRefused = await refused(() => updater.downloadUpdate());
const finished = await served;
check('a download larger than announced is stopped early', oversizeRefused && !finished, `refused ${oversizeRefused}, sent in full ${finished}`);
check('that download leaves nothing behind', leftovers() === 0, `${leftovers()} left`);

body = Buffer.alloc(payload.length, 0x41);
await updater.checkForUpdates();
check('a download with the wrong hash is refused', await refused(() => updater.downloadUpdate()));
check('that download leaves nothing behind', leftovers() === 0, `${leftovers()} left`);

body = payload;
rmSync(staging, { recursive: true, force: true });
await updater.checkForUpdates();
await updater.downloadUpdate();
const engine = JSON.parse(readFileSync(record, 'utf8'));
check('the engine is told which version the feed promised', engine.argv[engine.argv.indexOf('--expect-version') + 1] === '2.0.0');
check('the engine gets no credentials', !('DEEPSEEK_API_KEY' in engine.env) && !('GH_TOKEN' in engine.env));
check('the engine gets no switches that change trust', !('NODE_TLS_REJECT_UNAUTHORIZED' in engine.env) && !('NODE_PATH' in engine.env));
check('the staging folder is private', mode(staging) === '700', mode(staging));
check('the logs folder is private', mode(join(root, 'logs')) === '700', mode(join(root, 'logs')));
check('the log is private', mode(join(root, 'logs', 'update-2.0.0.log')) === '600', mode(join(root, 'logs', 'update-2.0.0.log')));

// --- Engine fixes -------------------------------------------------------------

const standIn = (name) => `import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
const out = process.argv[process.argv.indexOf('--out') + 1];
mkdirSync(out, { recursive: true });
if (!existsSync(out + '/deepseek-harness')) writeFileSync(out + '/deepseek-harness', '');
writeFileSync(${JSON.stringify(record)}, JSON.stringify({ engine: ${JSON.stringify(name)}, argv: process.argv.slice(2), env: process.env }));
`;
const ownEngine = join(resources, 'linux-port');
const engineFixRecord = join(scratchDir, 'engine-fix.json');
writeFileSync(join(ownEngine, 'pins.json'), JSON.stringify({ engine: 5 }));
writeFileSync(join(ownEngine, 'port.mjs'), standIn('own'));
writeFileSync(join(ownEngine, 'engine-fix.mjs'), `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(engineFixRecord)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));
process.exit(1);
`);
const deliver = (number, pinned = number) => {
  const directory = join(root, 'engines', String(number));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'pins.json'), JSON.stringify({ engine: pinned }));
  writeFileSync(join(directory, 'port.mjs'), standIn(number));
  writeFileSync(join(directory, 'engine-fix.mjs'), 'process.exit(0);\n');
};
const prepare = async (version) => {
  feed = release(version);
  await updater.checkForUpdates();
  await updater.downloadUpdate();
  return JSON.parse(readFileSync(record, 'utf8'));
};

let used = await prepare('2.0.1');
check('with no fix, the version\'s own engine builds', used.engine === 'own', String(used.engine));
const asked = JSON.parse(readFileSync(engineFixRecord, 'utf8'));
check('the channel is asked before the build', asked.argv.includes('--root') && asked.argv.includes(root));
check('a channel check that fails does not stop the update', used.argv.includes('2.0.1'));
check('the channel check gets no credentials', !('DEEPSEEK_API_KEY' in asked.env) && !('GH_TOKEN' in asked.env));
check('the channel check log is private', mode(join(root, 'logs', 'engine-fix.log')) === '600', mode(join(root, 'logs', 'engine-fix.log')));
deliver(3);
used = await prepare('2.0.2');
check('a fix numbered below this version\'s engine is not used', used.engine === 'own', String(used.engine));
deliver(6);
used = await prepare('2.0.3');
check('a newer fix builds the update', used.engine === 6, String(used.engine));
deliver(9);
deliver(7);
used = await prepare('2.0.4');
check('the newest fix wins', used.engine === 9, String(used.engine));
mkdirSync(join(root, 'engines', '.engine-99'), { recursive: true });
writeFileSync(join(root, 'engines', '.engine-99', 'pins.json'), JSON.stringify({ engine: 99 }));
mkdirSync(join(root, 'engines', 'notes'), { recursive: true });
writeFileSync(join(root, 'engines', 'notes', 'pins.json'), JSON.stringify({ engine: 99 }));
used = await prepare('2.0.5');
check('only numbered folders count as engines', used.engine === 9, String(used.engine));
writeFileSync(join(root, 'engines', '9', 'pins.json'), 'broken');
used = await prepare('2.0.6');
check('a damaged fix is passed over', used.engine === 7, String(used.engine));
rmSync(join(root, 'engines'), { recursive: true, force: true });

// --- Forced updates -----------------------------------------------------------

class Policy {
  current = { blocking: true, checking: false };
  published = [];
  publish = (state) => this.published.push(state);
  get state() { return this.current; }
  setState(state) { this.current = state; this.publish(state); }
}
let dialogs = [];
let answer = 1;
globalThis.testDialog = (options) => {
  dialogs.push(options);
  return Promise.resolve({ response: answer });
};
const settled = () => new Promise((go) => setImmediate(go));
const fail = async () => {
  feed = release('4.0.0');
  body = Buffer.alloc(payload.length, 0x41);
  await updater.checkForUpdates();
  await updater.downloadUpdate().catch(() => {});
  body = payload;
  await settled();
};

await fail();
check('without a forced update, a failure asks nothing', dialogs.length === 0, String(dialogs.length));

updater.watchForcedUpdate({ current: { blocking: true } }, () => {});
await fail();
check('a policy of an unknown shape is left alone', dialogs.length === 0, String(dialogs.length));

const policy = new Policy();
let changes = 0;
updater.watchForcedUpdate(policy, () => { changes++; });
check('a forced update still blocks as sent', policy.state.blocking === true);

policy.setState({ blocking: false, checking: false });
await fail();
check('no decision from the server, no question', dialogs.length === 0, String(dialogs.length));
policy.setState({ blocking: true, checking: false });

feed = release('8.0.0');
await updater.checkForUpdates();
await settled();
check('a forced update alone asks nothing', dialogs.length === 0, String(dialogs.length));
await updater.downloadUpdate();
await settled();
check('a forced update that builds asks nothing', dialogs.length === 0 && policy.state.blocking === true, String(dialogs.length));

await fail();
check('a forced update that fails offers the choice', dialogs.length === 1 && dialogs[0].buttons.length === 2 && dialogs[0].buttons[0].includes('Keep'), dialogs[0]?.buttons?.join(' / '));
check('going back keeps the block', policy.state.blocking === true && changes === 0);

dialogs = [];
feed = release(INSTALLED);
await updater.checkForUpdates();
await settled();
check('nothing newer to go to offers the choice too', dialogs.length === 1, String(dialogs.length));

dialogs = [];
const brokenFeed = feed;
feed = { version: 'not a version' };
await updater.checkForUpdates().catch(() => {});
await settled();
feed = brokenFeed;
check('a feed that fails offers the choice too', dialogs.length === 1, String(dialogs.length));

dialogs = [];
globalThis.testLocale = 'zh-CN';
await fail();
globalThis.testLocale = undefined;
check('the choice speaks Chinese too', /[\u4e00-\u9fff]/u.test(dialogs[0]?.buttons?.[0] ?? ''), dialogs[0]?.buttons?.[0]);

dialogs = [];
answer = 0;
await fail();
check('keeping this version lifts the block', policy.state.blocking === false && changes === 1, `${policy.state.blocking}, ${changes} change`);
policy.published.length = 0;
policy.setState({ blocking: true, checking: false });
check('a later answer from the server stays lifted', policy.state.blocking === false && policy.published.at(-1)?.blocking === false);
check('the server\'s answer itself is kept as sent', policy.current.blocking === true);
dialogs = [];
await fail();
check('and it does not ask again', dialogs.length === 0, String(dialogs.length));

// --- Switching ----------------------------------------------------------------

deliver(6);
await prepare('5.0.0');
const running = process.execPath;
updater.quitAndInstall();
check('switching removes delivered engines, the new version carries the newest', !existsSync(join(root, 'engines')));
check('switching moves the current link', fs.readlinkSync(join(root, 'current')) === join('versions', '5.0.0'), fs.readlinkSync(join(root, 'current')));
check('the running version stays for going back', fs.readlinkSync(join(root, 'previous')) === join('versions', INSTALLED) && existsSync(running));

// A real full disk: /dev/full answers every write with ENOSPC, and the download must end cleanly.
const { createWriteStream } = fs;
fs.createWriteStream = (path, options) => (String(path).endsWith('.partial') ? createWriteStream('/dev/full') : createWriteStream(path, options));
syncBuiltinESMExports();
feed = release('3.0.0');
await updater.checkForUpdates();
const fullDisk = await updater.downloadUpdate().then(() => 'finished', (error) => error.message);
fs.createWriteStream = createWriteStream;
syncBuiltinESMExports();
check('a full disk ends the download with its reason', fullDisk.includes('ENOSPC'), fullDisk);
check('that download leaves nothing behind', leftovers() === 0, `${leftovers()} left`);

server.close();
console.log(failures === 0 ? 'all safe' : `${failures} unsafe`);
process.exit(failures === 0 ? 0 : 1);
