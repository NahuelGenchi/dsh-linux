// Removes files no program here can load. It runs in the engine, so a first install and every
// update get the same tree. DeepSeek's own packages stay whole, because their skills and manuals
// are read at run time, and every license text stays. A rule that matches nothing is fine.
import { existsSync, readdirSync, rmSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';

// Sources and documents of third-party npm packages. Native addons are built before this runs.
const NPM_FILE = /\.(?:[cm]?ts|tsx|c|cc|cpp|h|hh|hpp|S|gyp|gypi|patch|md|markdown)$/i;
const NPM_ROOT_FOLDER = new Set(['.github', '__tests__', 'example', 'examples', 'test', 'tests']);
const LICENSE = /^(?:licen[cs]e|copying|notice|third.?party)/i;

const names = (directory) => (existsSync(directory) ? readdirSync(directory) : []);

function trimPackage(directory, isRoot) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') trimModules(path);
      else if (isRoot && NPM_ROOT_FOLDER.has(entry.name)) rmSync(path, { recursive: true, force: true });
      else trimPackage(path, false);
    } else if (NPM_FILE.test(entry.name) && !LICENSE.test(entry.name)) {
      rmSync(path);
    }
  }
  if (readdirSync(directory).length === 0) rmdirSync(directory);
}

function trimModules(nodeModules) {
  if (!existsSync(nodeModules)) return;
  for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const path = join(nodeModules, entry.name);
    if (!entry.name.startsWith('@')) {
      trimPackage(path, true);
      continue;
    }
    for (const inner of readdirSync(path)) {
      if (entry.name !== '@deepseek-ai') trimPackage(join(path, inner), true);
      else if (readdirSync(join(path, inner)).includes('node_modules')) trimModules(join(path, inner, 'node_modules'));
    }
  }
}

/** Relative to the expanded app.asar. */
export function trimApp(appRoot) {
  trimModules(join(appRoot, 'node_modules'));
  trimModules(join(appRoot, 'dsh', 'node_modules'));
}

/** pnpm's Windows helpers and its long changelog. */
export function trimPnpm(pnpmRoot) {
  const vendor = join(pnpmRoot, 'dist', 'vendor');
  for (const name of names(vendor)) if (name.endsWith('.exe')) rmSync(join(vendor, name));
  rmSync(join(pnpmRoot, 'CHANGELOG.md'), { force: true });
}

/**
 * Test folders, which DeepSeek's macOS payload leaves out too, the terminal database that this
 * Python never looks in (its search path is fixed to the system's), and pip's Windows launchers.
 */
export function trimPython(pythonRoot, sitePackages) {
  rmSync(join(pythonRoot, 'share', 'terminfo'), { recursive: true, force: true });
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'tests') rmSync(join(directory, entry.name), { recursive: true, force: true });
      else walk(join(directory, entry.name));
    }
  };
  walk(sitePackages);
  const launchers = join(sitePackages, 'pip', '_vendor', 'distlib');
  for (const name of names(launchers)) if (name.endsWith('.exe')) rmSync(join(launchers, name));
}
