// Test helper: the engine fix channel against a local server that answers honestly and in each way
// an attacker or a broken host could. Uses a throwaway key, never the real one.
//   node test/engine-fix-unit.mjs <port dir> <app dir> <scratch dir>
import { generateKeyPairSync, createHash, createPublicKey, sign } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';

const [portDir, appDir, scratchDir] = process.argv.slice(2).map((path) => resolve(path));
rmSync(scratchDir, { recursive: true, force: true });
mkdirSync(scratchDir, { recursive: true });

const pair = () => generateKeyPairSync('ed25519').privateKey;
const key = pair();
const otherKey = pair();
const publicHalf = createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64');

// An engine as installed, numbered 5.
const installed = join(scratchDir, 'installed');
cpSync(portDir, installed, { recursive: true });
const pins = (engine, extra = {}) => ({ ...JSON.parse(readFileSync(join(portDir, 'pins.json'), 'utf8')), engine, engineFixes: { feed: 'https://example.invalid/', publicKey: publicHalf }, ...extra });
writeFileSync(join(installed, 'pins.json'), JSON.stringify(pins(5)));

/** A signed engine archive with the given number, changed as a test needs. */
function buildArchive(number, change = () => {}, pinned = number) {
  const source = join(scratchDir, `source-${number}`);
  rmSync(source, { recursive: true, force: true });
  cpSync(portDir, source, { recursive: true });
  writeFileSync(join(source, 'pins.json'), JSON.stringify(pins(pinned)));
  change(source);
  const archive = join(scratchDir, `engine-${number}.tar.gz`);
  const packed = spawnSync('tar', ['-C', source, '--transform', `s,^\\.,engine-${number},`, '-czf', archive, '.']);
  if (packed.status !== 0) throw new Error(`tar: ${packed.stderr}`);
  rmSync(source, { recursive: true, force: true });
  return readFileSync(archive);
}
const manifestFor = (bytes, number, extra = {}) => JSON.stringify({ engine: number, file: `engine-${number}.tar.gz`, sha512: createHash('sha512').update(bytes).digest('base64'), size: bytes.length, ...extra });
const signed = (text, signer = key) => sign(null, Buffer.from(text), signer).toString('base64');

let answers = {};
const server = createServer((request, response) => {
  const answer = answers[request.url.slice(1)];
  if (answer === undefined) return response.writeHead(404).end();
  if (typeof answer === 'number') return response.writeHead(answer).end();
  return response.end(answer);
});
await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
const feed = `http://127.0.0.1:${server.address().port}/`;

const root = join(scratchDir, 'root');
const run = (env = {}, engine = installed) => new Promise((finish) => {
  // Under the app's own binary: its TLS library is not the one in plain Node.
  const child = spawn(join(appDir, 'deepseek-harness'), ['--disable-sigusr1', join(engine, 'engine-fix.mjs'), '--root', root], {
    env: { PATH: process.env.PATH, HOME: scratchDir, ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ASAR: '1', DSH_LINUX_ENGINE_FEED: feed, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  child.on('close', (code) => finish({ code, output: output.trim().split('\n').pop() ?? '' }));
});

let failures = 0;
function check(name, good, detail = '') {
  if (!good) failures++;
  console.log(`${good ? 'SAFE  ' : 'UNSAFE'}  ${name}${detail === '' ? '' : `  (${detail})`}`);
}
const present = () => (existsSync(join(root, 'engines')) ? readdirSync(join(root, 'engines')).sort() : []);
const fresh = () => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
};
/** The server offers this; the fix must be refused and nothing may land. */
async function refused(name, offer, env) {
  fresh();
  answers = offer;
  const result = await run(env);
  check(name, result.code !== 0 && present().length === 0, result.output.slice(0, 100));
}

const good = buildArchive(6);
const goodManifest = manifestFor(good, 6);
const offer = (bytes = good, manifest = goodManifest, signature = signed(manifest), number = 6) => ({ 'engine.json': manifest, 'engine.json.sig': signature, [`engine-${number}.tar.gz`]: bytes });

fresh();
answers = offer();
let result = await run();
check('a properly signed newer engine is added', result.code === 0 && present().join() === '6' && JSON.parse(readFileSync(join(root, 'engines', '6', 'pins.json'), 'utf8')).engine === 6, result.output);
check('it can run: its files are all there', existsSync(join(root, 'engines', '6', 'port.mjs')) && existsSync(join(root, 'engines', '6', 'overlay', 'lib', 'linux-updater.js')));
const second = await run();
check('asking again changes nothing', second.code === 0 && present().join() === '6', second.output);

const newer = buildArchive(7);
const newerManifest = manifestFor(newer, 7);
answers = offer(newer, newerManifest, signed(newerManifest), 7);
result = await run();
check('a later fix replaces the earlier one', result.code === 0 && present().join() === '7', `${present().join()}`);
result = await run({}, join(root, 'engines', '7'));
check('a delivered engine can check for the next fix itself', result.code === 0 && result.output.includes('up to date'), result.output);

fresh();
answers = offer(good, manifestFor(good, 5), signed(manifestFor(good, 5)), 5);
result = await run();
check('the same number is not taken', result.code === 0 && present().length === 0, result.output);
const older = buildArchive(4);
answers = offer(older, manifestFor(older, 4), signed(manifestFor(older, 4)), 4);
result = await run();
check('an older signed engine cannot take over', result.code === 0 && present().length === 0, result.output);

fresh();
answers = {};
result = await run();
check('a channel that does not exist is no problem', result.code === 0 && present().length === 0, result.output);

await refused('a channel in trouble changes nothing', { 'engine.json': 500, 'engine.json.sig': 500 });
await refused('a manifest changed after signing is refused', offer(good, goodManifest.replace('"engine":6', '"engine":66'), signed(goodManifest)));
await refused('a signature from another key is refused', offer(good, goodManifest, signed(goodManifest, otherKey)));
await refused('a signature that is nonsense is refused', offer(good, goodManifest, 'bm90IGEgc2lnbmF0dXJl'));
await refused('an empty signature is refused', offer(good, goodManifest, ''));
fresh();
answers = { 'engine.json': goodManifest, 'engine-6.tar.gz': good };
result = await run();
check('without a signature nothing is taken', present().length === 0, result.output);
await refused('an archive changed after signing is refused', offer(Buffer.concat([good, Buffer.from('x')])));

for (const [name, change] of [
  ['a file name with a path', { file: '../../evil.tar.gz' }],
  ['a size far too large', { size: 1024 ** 3 }],
  ['a size that is not a number', { size: 'large' }],
  ['no hash', { sha512: '' }],
]) {
  const text = manifestFor(good, 6, change);
  await refused(`even signed, ${name} is refused`, offer(good, text, signed(text)));
}
{
  const text = 'this is signed but it is not a manifest';
  await refused('even signed, a manifest that is not JSON is refused', offer(good, text, signed(text)));
}
{
  const text = JSON.stringify({ engine: 6.5, file: 'engine-6.5.tar.gz', sha512: 'x', size: 10 });
  await refused('even signed, a number that is not whole is refused', offer(good, text, signed(text)));
}
{
  const bytes = buildArchive(6, () => {}, 9);
  const text = manifestFor(bytes, 6);
  await refused('files that carry another number are refused', offer(bytes, text, signed(text)));
}
{
  const bytes = buildArchive(6, (source) => rmSync(join(source, 'port.mjs')));
  const text = manifestFor(bytes, 6);
  await refused('an archive with files missing is refused', offer(bytes, text, signed(text)));
}
{
  const bytes = buildArchive(6, (source) => symlinkSync('/etc', join(source, 'lib', 'outside')));
  const text = manifestFor(bytes, 6);
  await refused('an archive with a link out of its tree is refused', offer(bytes, text, signed(text)));
}

// A plain HTTP channel is for tests alone, which is why it takes the test variable.
const plain = join(scratchDir, 'plain');
cpSync(installed, plain, { recursive: true });
writeFileSync(join(plain, 'pins.json'), JSON.stringify(pins(5, { engineFixes: { feed, publicKey: publicHalf } })));
fresh();
answers = offer();
result = await run({ DSH_LINUX_ENGINE_FEED: '' }, plain);
check('a channel on plain HTTP is refused', result.code !== 0 && present().length === 0, result.output);

const keyless = join(scratchDir, 'keyless');
cpSync(installed, keyless, { recursive: true });
writeFileSync(join(keyless, 'pins.json'), JSON.stringify(pins(5, { engineFixes: undefined })));
fresh();
answers = offer();
result = await run({}, keyless);
check('without a pinned key nothing is taken', result.code === 0 && present().length === 0, result.output);

fresh();
writeFileSync(join(root, 'no-engine-fixes'), '');
answers = offer();
result = await run();
check('the off switch is respected', result.code === 0 && present().length === 0 && result.output.includes('turned off'), result.output);

// Leftovers from an interrupted run go, and are never taken for an engine.
fresh();
mkdirSync(join(root, 'engines', '.engine-6', 'lib'), { recursive: true });
writeFileSync(join(root, 'engines', '.engine-6.tar.gz'), 'partial');
answers = {};
result = await run();
check('what an interrupted run left behind is cleaned up', result.code === 0 && present().length === 0, present().join());

server.close();
rmSync(scratchDir, { recursive: true, force: true });
console.log(failures === 0 ? 'all safe' : `${failures} unsafe`);
process.exit(failures === 0 ? 0 : 1);
