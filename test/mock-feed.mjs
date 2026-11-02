// Test helper: a local update feed that can fail in the ways a real one can.
//   node test/mock-feed.mjs <port> <mode> [zip file] [version]
// Modes: ok, http500, stallfeed, badyaml, nofiles, badversion, otherhost, badhash, stall, cut
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';

const [port, mode, zip, version = '99.0.0'] = process.argv.slice(2);
const bytes = zip === undefined ? Buffer.from('not a real release') : readFileSync(zip);
const size = bytes.length;
const sha512 = createHash('sha512').update(mode === 'badhash' ? 'something else' : bytes).digest('base64');
const name = `release-${version}.zip`;

const feed = () => {
  const url = mode === 'otherhost' ? `https://elsewhere.example/${name}` : name;
  if (mode === 'badyaml') return ':\n  - [unclosed';
  if (mode === 'nofiles') return `version: ${version}\n`;
  if (mode === 'badversion') return `version: latest\nfiles:\n  - url: ${url}\n    sha512: ${sha512}\n    size: ${size}\n`;
  return `version: ${version}\nfiles:\n  - url: ${url}\n    sha512: ${sha512}\n    size: ${size}\n`;
};

createServer((req, res) => {
  if (req.url.endsWith('.yml')) {
    if (mode === 'http500') return res.writeHead(500).end('broken');
    if (mode === 'stallfeed') return undefined;
    return res.writeHead(200, { 'content-type': 'text/yaml' }).end(feed());
  }
  if (!req.url.endsWith(name)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': 'application/zip', 'content-length': size });
  if (mode === 'stall') return res.write(bytes.subarray(0, Math.min(1024, size)));
  if (mode === 'cut') { res.write(bytes.subarray(0, Math.floor(size / 2))); return setTimeout(() => res.destroy(), 200); }
  if (zip !== undefined && statSync(zip).size > 1 << 20) return createReadStream(zip).pipe(res);
  res.end(bytes);
}).listen(Number(port), '127.0.0.1');
