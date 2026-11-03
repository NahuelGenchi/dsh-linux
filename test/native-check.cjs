// Test helper: exercises every native part of an install on this system, like the engine's own check.
//   ELECTRON_RUN_AS_NODE=1 <install>/current/deepseek-harness test/native-check.cjs <install>/current/resources
const { createRequire } = require('node:module');
const { join } = require('node:path');
const { existsSync } = require('node:fs');
const { spawnSync } = require('node:child_process');

const resources = process.argv[2];
const r = createRequire(join(resources, 'app.asar', 'dsh', 'package.json'));
const unpacked = (path) => path.replace(`app.asar${require('node:path').sep}`, `app.asar.unpacked${require('node:path').sep}`);
const tool = (command, args, env) => {
  const result = spawnSync(command, args, { encoding: 'utf8', cwd: '/tmp', env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, ...env } });
  if (result.status !== 0) throw new Error(`${command}: ${result.error ?? result.stderr}`);
  return result.stdout.trim().split('\n')[0];
};

const checks = {
  landlock: () => { const l = r('@deepseek-ai/node-addon-system/landlock-run'); const p = l.launcherPath(); if (!existsSync(p)) throw new Error(`missing ${p}`); return l.probe(p); },
  flock: () => typeof r('@deepseek-ai/node-addon-system/flock').tryLockExclusive,
  koffi: () => typeof r('koffi').load,
  sharp: async () => {
    const sharp = r('sharp');
    const png = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#336699' } }).png().toBuffer();
    const read = [];
    for (const format of ['png', 'jpeg', 'webp', 'gif']) {
      const image = await sharp(png)[format]().toBuffer();
      const { width, format: found } = await sharp(image, { failOn: 'error' }).metadata();
      const pixels = await sharp(image, { failOn: 'error' }).rotate().resize(32).raw().toBuffer();
      if (width !== 64 || found !== format || pixels.length === 0) throw new Error(`read ${format} as ${found} ${width}`);
      read.push(found);
    }
    return read.join(' ');
  },
  ripgrep: () => tool(unpacked(r('@vscode/ripgrep').rgPath), ['--version']),
  sherpa: () => typeof r('sherpa-onnx-node').OfflineRecognizer,
  pty: () => new Promise((resolve, reject) => {
    const term = r('node-pty').spawn('/bin/sh', ['-c', 'printf pty-ok'], { name: 'xterm', cols: 40, rows: 5 });
    let output = '';
    term.onData((data) => { output += data; });
    term.onExit(() => (output.includes('pty-ok') ? resolve(true) : reject(new Error(output))));
  }),
  office: () => { const name = ['libreoffice-kit-linux-x64-glibc', 'libreoffice-kit-wasm'].find((n) => { try { r.resolve(`@deepseek-ai/${n}/package.json`); return true; } catch { return false; } }); if (!name) throw new Error('no Office engine'); return name; },
  node: () => tool(join(resources, 'runtime/primary-runtime/dependencies/node/bin/node'), ['-v']),
  pnpm: () => tool(join(resources, 'runtime/primary-runtime/dependencies/node/bin/node'), [join(resources, 'runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs'), '--version'], { HOME: '/tmp' }),
  python: () => tool(join(resources, 'runtime/primary-runtime/dependencies/python/bin/python3'), ['-I', '-B', '-c', 'import numpy, pandas, docx, pptx, openpyxl, PIL, lxml, ssl, sqlite3, ctypes; print(ssl.OPENSSL_VERSION)']),
  pip: () => tool(join(resources, 'runtime/primary-runtime/dependencies/python/bin/pip'), ['--version'], { PYTHONDONTWRITEBYTECODE: '1' }).split(' from ')[0],
};

(async () => {
  let failed = 0;
  for (const [name, check] of Object.entries(checks)) {
    try { console.log(`ok   ${name}: ${JSON.stringify(await check())}`); } catch (error) { failed++; console.log(`FAIL ${name}: ${String(error.message).slice(0, 300)}`); }
  }
  console.log(failed === 0 ? 'native check passed' : `native check FAILED: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
})();
