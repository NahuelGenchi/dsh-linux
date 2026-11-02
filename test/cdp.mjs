// Small CDP driver for checking the running app: node cdp.mjs <port> <command> [args]
import { writeFileSync } from 'node:fs';
const [port, command, ...rest] = process.argv.slice(2);
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
if (command === 'list') {
  for (const t of targets) console.log(t.type, t.title, t.url);
  process.exit(0);
}
const wanted = process.env.TARGET_MATCH;
const page = targets.find((t) => t.type === 'page' && (!wanted || t.url.includes(wanted))) ?? targets.find((t) => t.webSocketDebuggerUrl);
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let id = 0;
const pending = new Map();
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
};
const send = (method, params = {}) => new Promise((resolve) => { const n = ++id; pending.set(n, resolve); socket.send(JSON.stringify({ id: n, method, params })); });
if (command === 'shot') {
  const { result } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(rest[0], Buffer.from(result.data, 'base64'));
  console.log('saved', rest[0], page.url);
} else if (command === 'eval') {
  const { result } = await send('Runtime.evaluate', { expression: rest[0], awaitPromise: true, returnByValue: true });
  console.log(JSON.stringify(result.result?.value ?? result.exceptionDetails ?? result, null, 1));
}
process.exit(0);
