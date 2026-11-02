// Test helper: pretends someone registered a free look-alike of a Linux twin on npm, and reports
// which package the engine picks. Nothing is registered anywhere: the answer is faked in this process.
//   NODE_TLS_REJECT_UNAUTHORIZED=0 node --import ./test/npm-confusion.mjs <port dir>/port.mjs --zip <release> --out <dir> --cache <dir> --work-dir <dir>
const LOOKALIKE = 'node-addon-require-builtin-linux-x64';
const GENUINE = `${LOOKALIKE}-gnu`;
const VERSION = '0.1.9';
const realFetch = globalThis.fetch;

function finish(picked, code) {
  console.log(`PICKED ${picked}; NODE_TLS_REJECT_UNAUTHORIZED ${process.env.NODE_TLS_REJECT_UNAUTHORIZED === undefined ? 'removed' : 'still set'}`);
  process.exit(code);
}

globalThis.fetch = async (url, init) => {
  const text = String(url);
  if (text === `https://registry.npmjs.org/${LOOKALIKE}/${VERSION}`) {
    return new Response(JSON.stringify({
      name: LOOKALIKE,
      version: VERSION,
      dist: { integrity: 'sha512-AAAA', tarball: `https://registry.npmjs.org/${LOOKALIKE}/-/${LOOKALIKE}-${VERSION}.tgz` },
    }));
  }
  if (text.endsWith(`/${LOOKALIKE}-${VERSION}.tgz`)) finish(`the look-alike ${LOOKALIKE}`, 3);
  if (text === `https://registry.npmjs.org/${GENUINE}/${VERSION}`) finish(`the declared ${GENUINE}`, 0);
  return realFetch(url, init);
};
