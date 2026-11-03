// Test helper: measures an installed copy the same way every time and prints one JSON line per run.
//   node test/measure.mjs start <run name> [runs] [--warm]
//                                                    Launch with the app's files out of the page cache (or left
//                                                    in it with --warm), time the main window, then sum idle memory.
//   node test/measure.mjs update <run name> <release .zip> [runs] [--warm]
//                                                    Run the engine as the in-app updater does, after the download.
// The copy must already be installed in <run name>'s isolated home, and the private display must be up.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORK = join(HERE, '..', '.work');
const IDLE_SECONDS = Number(process.env.DSH_MEASURE_IDLE ?? 30);
const [command, run, ...rest] = process.argv.slice(2);
const home = join(WORK, run ?? '', 'home');
const root = join(home, '.local', 'share', 'deepseek-harness');
const port = process.env.DSH_TEST_PORT ?? '39433';
const mockPort = process.env.DSH_TEST_MOCK_PORT ?? '39422';

const EVICT = `
import os, sys
for base, _, names in os.walk(sys.argv[1]):
    for name in names:
        path = os.path.join(base, name)
        if os.path.islink(path): continue
        fd = os.open(path, os.O_RDONLY)
        os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_DONTNEED)
        os.close(fd)
`;

function evict(directory) {
  spawnSync('sync', ['-f', directory]);
  const result = spawnSync('python3', ['-I', '-c', EVICT, directory], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`evict failed: ${result.stderr}`);
}

/** Every process of this isolated home: those with its HOME or running from it, plus all their descendants (Chromium rewrites its own environ). */
function processes() {
  const wanted = `HOME=${home}`;
  const inHome = `${home}/`;
  const parents = new Map();
  const found = new Set();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const pid = Number(name);
      parents.set(pid, Number(readFileSync(`/proc/${name}/stat`, 'latin1').match(/\) \S (\d+)/)[1]));
      if (readFileSync(`/proc/${name}/environ`, 'latin1').split('\0').includes(wanted) || readFileSync(`/proc/${name}/cmdline`, 'latin1').includes(inHome)) found.add(pid);
    } catch {}
  }
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, parent] of parents) {
      if (!found.has(pid) && found.has(parent)) {
        found.add(pid);
        grew = true;
      }
    }
  }
  return [...found];
}

function pssMegabytes(pids) {
  let kilobytes = 0;
  for (const pid of pids) {
    try {
      kilobytes += Number(readFileSync(`/proc/${pid}/smaps_rollup`, 'latin1').match(/^Pss:\s+(\d+) kB/m)?.[1] ?? 0);
    } catch {}
  }
  return Math.round(kilobytes / 1024);
}

async function stopAll() {
  for (const pid of processes()) try { process.kill(pid, 'SIGTERM'); } catch {}
  for (let i = 0; i < 60; i++) {
    if (processes().length === 0) return;
    await sleep(250);
  }
  for (const pid of processes()) try { process.kill(pid, 'SIGKILL'); } catch {}
  await sleep(500);
}

async function mainWindowReady(deadline) {
  const pageTarget = async () => {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    return targets.find((target) => target.type === 'page' && target.url.includes('dsh-app'));
  };
  let target;
  while (target === undefined) {
    if (performance.now() > deadline) throw new Error('no main window target');
    target = await pageTarget().catch(() => undefined);
    if (target === undefined) await sleep(25);
  }
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0;
  const pending = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  };
  const evaluate = (expression) => new Promise((resolve) => {
    id += 1;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
  });
  while (performance.now() < deadline) {
    const answer = await evaluate('!!document.querySelector("[data-windows-menu]")');
    if (answer.result?.result?.value === true) {
      socket.close();
      return;
    }
    await sleep(25);
  }
  throw new Error('the main window did not finish loading');
}

async function measureStart(runs, warm) {
  const launcher = join(root, 'deepseek-harness');
  for (let index = 0; index < runs; index++) {
    await stopAll();
    if (!warm) evict(join(root, 'versions'));
    const log = openSync(join(WORK, run, 'measure-app.log'), 'w');
    const begin = performance.now();
    spawn(join(HERE, 'env.sh'), [run, launcher, `--remote-debugging-port=${port}`, '--disable-gpu', '--ozone-platform=x11', '--enable-logging=stderr'], {
      env: { ...process.env, DEEPSEEK_API_KEY: 'mock-local-test', DEEPSEEK_BASE_URL: `http://127.0.0.1:${mockPort}/anthropic` },
      stdio: ['ignore', log, log],
      detached: true,
    }).unref();
    closeSync(log);
    await mainWindowReady(begin + 120000);
    const startMs = Math.round(performance.now() - begin);
    await sleep(IDLE_SECONDS * 1000);
    const samples = [];
    for (let i = 0; i < 3; i++) {
      samples.push(pssMegabytes(processes()));
      await sleep(2000);
    }
    samples.sort((a, b) => a - b);
    console.log(JSON.stringify({ run, warm, startMs, idlePssMb: samples[1], processes: processes().length, load: readFileSync('/proc/loadavg', 'latin1').split(' ')[0] }));
    await stopAll();
  }
}

async function measureUpdate(zip, runs, warm) {
  const current = join(root, readlinkSync(join(root, 'current')));
  const target = join(root, 'versions', 'measure-target');
  const cache = join(root, 'measure-cache');
  const staging = join(root, 'measure-staging');
  for (let index = 0; index < runs; index++) {
    if (!warm || index === 0 && !existsSync(cache)) rmSync(cache, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    evict(current);
    const begin = performance.now();
    const steps = [];
    const child = spawn(join(HERE, 'env.sh'), [run, join(current, 'deepseek-harness'), join(current, 'resources', 'linux-port', 'port.mjs'),
      '--zip', zip, '--out', target, '--reuse', current, '--cache', cache, '--work-dir', staging, '--progress-json'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ASAR: '1', NODE_USE_ENV_PROXY: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let errors = '';
    child.stderr.on('data', (chunk) => { errors = `${errors}${chunk}`.slice(-1500); });
    let pending = '';
    child.stdout.on('data', (chunk) => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.step !== undefined) steps.push([Math.round(performance.now() - begin) / 1000, event.step]);
        } catch {}
      }
    });
    const code = await new Promise((resolve) => child.on('close', resolve));
    if (code !== 0) throw new Error(`the engine failed: ${errors}`);
    console.log(JSON.stringify({ run, warm, seconds: Math.round(performance.now() - begin) / 1000, steps, load: readFileSync('/proc/loadavg', 'latin1').split(' ')[0] }));
    rmSync(target, { recursive: true, force: true });
    rmSync(staging, { recursive: true, force: true });
  }
  rmSync(cache, { recursive: true, force: true });
}

if (command === 'start') await measureStart(Number(rest[0] ?? 5), rest.includes('--warm'));
else if (command === 'update') await measureUpdate(rest[0], Number(rest[1] ?? 3), rest.includes('--warm'));
else throw new Error('Usage: test/measure.mjs start|update <run name> ...');
