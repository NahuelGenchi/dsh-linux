// Test helper: checks that the agent's sandbox limits file writes and nothing else, as on macOS.
//   ELECTRON_RUN_AS_NODE=1 deepseek-harness test/sandbox-reach.mjs <resources> <scratch dir>
// Run it with test/env.sh, so HOME is a throwaway. Its scratch dir must be outside /tmp.
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [resources, scratch] = process.argv.slice(2);
const runtime = `/run/user/${process.getuid()}`;

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${ok || !detail ? '' : `: ${detail}`}`);
  if (!ok) failures += 1;
}

const entry = join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-sandbox-local', 'lib', 'index.js');
const { LocalSandboxProvider } = await import(pathToFileURL(entry).href);
const provider = Object.create(LocalSandboxProvider.prototype);
Object.assign(provider, { internals: {}, probeTimeoutMs: 8000, configuredRunnerFailureSignatures: [], runnerCommand: undefined });

rmSync(scratch, { recursive: true, force: true });
const workspace = join(scratch, 'workspace');
const outside = join(scratch, 'outside');
const stubs = join(scratch, 'bin');
for (const dir of [workspace, outside, stubs]) mkdirSync(dir, { recursive: true });
writeFileSync(join(outside, 'keep.txt'), 'original');

async function run(command, mode = 'workspace-write') {
  provider.selectedRunner = undefined;
  const wrapped = await provider.confine(['/bin/sh', '-c', command], { mode, workspaceRoot: workspace });
  const result = spawnSync(wrapped.argv[0], wrapped.argv.slice(1), { encoding: 'utf8', timeout: 60000 });
  return { ...result, stdout: result.stdout.trim(), runner: wrapped.argv[0].split('/').pop() };
}
const canWrite = async (path, mode) => (await run(`echo x > "${path}" 2>/dev/null && echo wrote`, mode)).stdout === 'wrote';

const first = await run('true');
check('Landlock is the runner', first.runner === 'landlock-run', first.runner);

// What stays limited.
check('write in the workspace', await canWrite(join(workspace, 'a')));
check('write in /tmp', await canWrite(`/tmp/dsh-reach-${process.pid}`));
rmSync(`/tmp/dsh-reach-${process.pid}`, { force: true });
check('no write in the home folder', !(await canWrite(join(homedir(), 'escape'))) && !existsSync(join(homedir(), 'escape')));
check('no write outside the workspace', !(await canWrite(join(outside, 'new'))) && !existsSync(join(outside, 'new')));
check('no write in /etc', !(await canWrite('/etc/dsh-reach-test')));
symlinkSync(outside, join(workspace, 'link'));
check('no write through a link', !(await canWrite(join(workspace, 'link', 'new'))) && !existsSync(join(outside, 'new')));
check('no write through /proc', !(await canWrite(`/proc/self/root${outside}/new`)) && !(await canWrite(`/proc/${process.pid}/root${outside}/new`)) && !existsSync(join(outside, 'new')));
check('no overwrite through /proc', (await run(`exec 3<"${join(outside, 'keep.txt')}"; echo x > /proc/self/fd/3 2>/dev/null && echo wrote`)).stdout === '' && readFileSync(join(outside, 'keep.txt'), 'utf8') === 'original');
check('read-only mode: no write in the workspace', !(await canWrite(join(workspace, 'b'), 'read-only')));
check('read-only mode: no write in /tmp', !(await canWrite(`/tmp/dsh-reach-${process.pid}`, 'read-only')));

// What stays open, as on macOS.
check('reads anywhere', (await run(`cat "${join(outside, 'keep.txt')}"`)).stdout === 'original');
const python = (await run('command -v python3')).stdout !== '';
const shm = `/dev/shm/dsh-reach-${process.pid}`;
check('shared memory', await canWrite(shm) && await canWrite(shm, 'read-only'));
rmSync(shm, { force: true });
if (python) {
  check('Python locks', (await run(`python3 -I -c "import multiprocessing as m; m.Lock(); print('ok')" 2>&1`)).stdout === 'ok');
  check('terminals', (await run(`python3 -I -c "import pty; pty.openpty(); print('ok')" 2>&1`)).stdout === 'ok');
}
check('other processes are visible', (await run(`test -d /proc/${process.pid} && echo seen`)).stdout === 'seen');
check('the real /tmp', (await run('ls -a /tmp | wc -l')).stdout === String(readdirSync('/tmp').length + 2));
const socketPath = `/tmp/dsh-reach-${process.pid}.sock`;
const server = createServer().listen(socketPath);
await new Promise((resolve) => server.once('listening', resolve));
if (python) check('local services', (await run(`python3 -I -c "import socket; s=socket.socket(socket.AF_UNIX); s.connect('${socketPath}'); print('ok')" 2>&1`)).stdout === 'ok');
server.close();
if (existsSync(runtime)) {
  check('the session runtime folder', readdirSync(runtime).length === 0 || (await run(`ls -A "${runtime}" | wc -l`)).stdout !== '0');
  check('runtime folder writes', await canWrite(join(runtime, `dsh-reach-${process.pid}`)));
  rmSync(join(runtime, `dsh-reach-${process.pid}`), { force: true });
  check('read-only mode: no runtime folder writes', !(await canWrite(join(runtime, `dsh-reach-${process.pid}`), 'read-only')));
}

// xdg-open works as macOS's open does: what it starts is outside the sandbox.
const opened = join(outside, 'opened');
const stub = join(stubs, 'xdg-open');
writeFileSync(stub, `#!/bin/sh\necho "$1" > "${opened}"\nsleep 20 &\necho $! > "${opened}.child"\n`);
chmodSync(stub, 0o755);
process.env.PATH = `${stubs}:${process.env.PATH}`;
check('commands find the outside opener first', (await run('command -v xdg-open')).stdout.endsWith('/linux-port/packaging/sandbox-bin/xdg-open'));
check('the opener keeps the rest of PATH', (await run(`PATH="$PATH" sh -c 'echo "$PATH"'`)).stdout.endsWith(process.env.PATH));
const managed = spawnSync('systemctl', ['--user', 'is-system-running'], { encoding: 'utf8' }).stdout.trim();
if (['running', 'degraded'].includes(managed)) {
  const started = Date.now();
  // The bus address from test/env.sh goes nowhere, so this one command gets the real one.
  const result = await run(`DBUS_SESSION_BUS_ADDRESS=unix:path=${runtime}/bus xdg-open first-argument; echo "exit $?"`);
  check('xdg-open comes back quickly', result.stdout === 'exit 0' && Date.now() - started < 15000, result.stdout + result.stderr);
  check('what it opens can write outside', existsSync(opened) && readFileSync(opened, 'utf8').trim() === 'first-argument');
  const child = existsSync(`${opened}.child`) ? Number(readFileSync(`${opened}.child`, 'utf8')) : 0;
  check('what it opens keeps running', child > 0 && existsSync(`/proc/${child}`));
  if (child > 0) try { process.kill(child); } catch {}
} else {
  console.log(`skipped the outside opener: no user service manager (${managed || 'none'})`);
}
writeFileSync(stub, '#!/bin/sh\nexit 3\n');
check('a failed open reports its code', (await run('xdg-open x; echo "exit $?"')).stdout === 'exit 3');

// A browser with its own sandbox on, in a profile inside the workspace.
const chrome = ['google-chrome', 'chromium', 'chromium-browser'].find((name) => spawnSync('sh', ['-c', `command -v ${name}`]).status === 0);
if (chrome) {
  // Chrome stops at start if it can neither find nor make its config folder, and this home has none.
  const page = await run(`XDG_CONFIG_HOME="${workspace}" XDG_CACHE_HOME="${workspace}" timeout 45 ${chrome} --headless=new --no-first-run --disable-gpu --user-data-dir="${join(workspace, 'browser')}" --dump-dom "data:text/html,<p>page-loaded</p>" 2>/dev/null`);
  check(`${chrome} runs with its own sandbox`, page.stdout.includes('page-loaded'), page.stderr.slice(0, 200));
} else {
  console.log('skipped the browser: none installed');
}

console.log(failures === 0 ? 'all pass' : `${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
