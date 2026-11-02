// Test helper: makes an installed version report an older number, so the real update flow runs.
//   node test/fake-older.mjs <install root> <installed version> <older version>
import { mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createAsar, extractAsar } from '../port/lib/asar.mjs';

const [root, version, older] = process.argv.slice(2);
const installed = join(root, 'versions', version);
const archive = join(installed, 'resources', 'app.asar');
const temporary = mkdtempSync(join(dirname(root), '.fake-older-'));
const unpacked = extractAsar(archive, temporary);
const manifestPath = join(temporary, 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.version = older;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
await createAsar(temporary, archive, (path) => unpacked.has(path));
rmSync(temporary, { recursive: true, force: true });
renameSync(installed, join(root, 'versions', older));
rmSync(join(root, 'current'), { force: true });
symlinkSync(join('versions', older), join(root, 'current'));
console.log(`${version} now reports ${older}`);
