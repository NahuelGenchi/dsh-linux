// Test helper: runs the app's real sandbox chain and checks what a confined command may touch.
//   ELECTRON_RUN_AS_NODE=1 deepseek-harness test/sandbox.mjs <resources> <scratch dir>
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [resources, scratch] = process.argv.slice(2);
const entry = join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-sandbox-local', 'lib', 'index.js');
const { LocalSandboxProvider } = await import(pathToFileURL(entry).href);

const workspace = join(scratch, 'workspace');
const outside = join(scratch, 'outside');
rmSync(scratch, { recursive: true, force: true });
mkdirSync(workspace, { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(join(outside, 'secret.txt'), 'visible');

const provider = Object.create(LocalSandboxProvider.prototype);
Object.assign(provider, { internals: process.env.TEST_CHAIN ? { chain: [process.env.TEST_CHAIN] } : {}, probeTimeoutMs: 8000, configuredRunnerFailureSignatures: [], runnerCommand: undefined });

for (const mode of ['workspace-write', 'read-only']) {
  provider.selectedRunner = undefined;
  const confine = (command) => provider.confine(['/bin/sh', '-c', command], { mode, workspaceRoot: workspace });
  const inside = join(workspace, `inside-${mode}.txt`);
  const blocked = join(outside, `blocked-${mode}.txt`);
  const wrapped = await confine(`echo a > "${inside}"; echo b > "${blocked}"; cat "${join(outside, 'secret.txt')}"`);
  const result = spawnSync(wrapped.argv[0], wrapped.argv.slice(1), { encoding: 'utf8', timeout: 20000 });
  console.log(JSON.stringify({
    mode,
    runner: wrapped.argv[0].split('/').pop(),
    enforcement: wrapped.enforcement,
    insideWritten: existsSync(inside),
    outsideWritten: existsSync(blocked),
    outsideReadable: result.stdout.includes('visible'),
    stderr: result.stderr.trim().split('\n').slice(0, 2).map((line) => line.slice(0, 110)),
  }));
}
