// Test helper: how patches match and what a miss does, on small texts and on the real patch table.
//   node test/patch-unit.mjs <port dir> <scratch dir>
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [portDir, scratchDir] = process.argv.slice(2).map((path) => resolve(path));
rmSync(scratchDir, { recursive: true, force: true });
mkdirSync(scratchDir, { recursive: true });
const copy = join(scratchDir, 'patches-test.mjs');
writeFileSync(copy, `${readFileSync(join(portDir, 'lib', 'patches.mjs'), 'utf8')}\nexport { APP_PATCHES, RUNTIME_PATCHES, OPTIONAL, applyTo };\n`);
const { APP_PATCHES, RUNTIME_PATCHES, OPTIONAL, applyTo } = await import(pathToFileURL(copy).href);
const realError = console.error;

let failures = 0;
function check(name, good, detail = '') {
  if (!good) failures++;
  console.log(`${good ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  (${detail})`}`);
}

const FILE = 'file.js';
/** Runs one table over one text. Returns the text, what was skipped and any error. */
function attempt(text, patches, allPatches = false) {
  const root = join(scratchDir, 'tree');
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  if (text !== undefined) writeFileSync(join(root, FILE), text);
  const skipped = [];
  let error;
  console.error = () => {};
  try {
    applyTo(root, { [FILE]: patches }, skipped, allPatches);
  } catch (caught) {
    error = caught.message;
  }
  console.error = realError;
  return { text: existsSync(join(root, FILE)) ? readFileSync(join(root, FILE), 'utf8') : undefined, skipped, error };
}

let result = attempt('a();\nb(  1 );\nc();', [['b(  1 );', 'b(2);']]);
check('exact text is replaced', result.text === 'a();\nb(2);\nc();');

result = attempt('if (x) {\n\t\t\tgo();\n\t\t}', [['if (x) {\n\tgo();\n}', 'if (y) { go(); }']]);
check('the same code rewrapped still matches', result.text === 'if (y) { go(); }' && result.error === undefined);

result = attempt('call("a","b");', [['call("a", "b");', 'call("c");']]);
check('spacing removed by a bundler still matches', result.text === 'call("c");');

result = attempt('price = "$1";', [['price = "$1";', 'price = "$& $1 ${x}";']]);
check('a text replacement keeps its dollar signs as they are', result.text === 'price = "$& $1 ${x}";', result.text);

result = attempt('renamed();', [['original();', 'patched();']]);
check('a required patch that misses stops the build', result.error?.includes('not found') && result.text === 'renamed();', result.error);

result = attempt('twice(); twice();', [['twice();', 'once();']]);
check('a required patch that matches twice stops the build', result.error?.includes('ambiguous'), result.error);

result = attempt('twice(a); twice( a);', [['twice( a );', 'once();']]);
check('a loose match must be single too', result.error?.includes('ambiguous'), result.error);

result = attempt(undefined, [['anything', 'else']]);
check('a required patch on a file that is gone stops the build', result.error?.includes('the file is gone'), result.error);

result = attempt('keep(); renamed();', [['keep();', 'kept();'], ['original();', 'patched();', OPTIONAL]]);
check('an optional patch that misses is skipped, the rest still applies', result.text === 'kept(); renamed();' && result.skipped.length === 1 && result.error === undefined, result.skipped[0]);

result = attempt('twice(); twice();', [['twice();', 'once();', OPTIONAL]]);
check('an optional patch that matches twice changes nothing', result.text === 'twice(); twice();' && result.skipped.length === 1);

result = attempt(undefined, [['anything', 'else', OPTIONAL]]);
check('an optional patch on a file that is gone is skipped', result.skipped.length === 1 && result.error === undefined && result.text === undefined);

result = attempt('renamed();', [['original();', 'patched();', OPTIONAL]], true);
check('a package build stops at any miss', result.error?.includes('not found'), result.error);

result = attempt('value: 12px;', [[/value: (\d+)px;/u, 'value: calc($1px + 1px);', OPTIONAL]]);
check('a pattern fills in what it captured', result.text === 'value: calc(12px + 1px);', result.text);

result = attempt('value: 12px; value: 13px;', [[/value: (\d+)px;/u, 'no', OPTIONAL]]);
check('a pattern must match once too', result.skipped.length === 1 && result.text === 'value: 12px; value: 13px;');

// The real table.
const all = [...Object.entries(APP_PATCHES), ...Object.entries(RUNTIME_PATCHES)].flatMap(([file, patches]) => patches.map((patch) => ({ file, patch })));
const required = all.filter(({ patch }) => patch[2] !== OPTIONAL);
console.log(`The real table: ${required.length} required, ${all.length - required.length} optional`);
const menu = APP_PATCHES['lib/main.js'].filter(([find]) => String(find.source ?? find).includes('setApplicationMenu'));
check('one patch handles the application menu', menu.length === 1);
const today = 'Menu.setApplicationMenu(Menu.buildFromTemplate(process.platform === "win32" ? devToolsItems : [{';
result = attempt(today, menu);
check('the menu patch fits the current release', result.text.includes('process.platform === "linux" ? [...devToolsItems, { role: "quit", visible: false }] : [{'), result.text.slice(60));
// As bundled from DeepSeek's main branch, apps/desktop/src/main.ts, commit 4214f86da3.
for (const master of ['Menu.setApplicationMenu(Menu.buildFromTemplate(process.platform === "win32" ? windowsDevToolsShortcuts : [{', 'Menu.setApplicationMenu(Menu.buildFromTemplate(process.platform === "win32"\n\t\t? windowsDevToolsShortcuts : [{']) {
  result = attempt(master, menu);
  check('the menu patch fits the code on DeepSeek\'s main branch', result.text?.includes('[...windowsDevToolsShortcuts, { role: "quit", visible: false }]') && result.skipped.length === 0, result.skipped[0] ?? '');
}
const safety = required.filter(({ patch }) => /--disable-sigusr1|hostServiceMasks|token=|linux-updater|unsupported platform/u.test(String(patch[1])));
check('patches that keep the app safe or updatable stay required', safety.length >= 8, `${safety.length} of them`);

rmSync(scratchDir, { recursive: true, force: true });
console.log(failures === 0 ? 'all pass' : `${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
