// Test helper: a local Messages-style model that asks for one shell command, then finishes.
// It lets a whole agent turn run with no account and no outside traffic.
//   node test/mock-model.mjs <port> <log file>
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

const [port, log] = process.argv.slice(2);
const COMMAND = process.env.MOCK_COMMAND ?? 'echo inside > inside.txt; cat inside.txt; echo escape > "$HOME/escape-test.txt"; echo "write-outside-exit=$?"; uname -sm';
// Colon-separated image files to read with the read_image tool, instead of running a command.
const IMAGES = process.env.MOCK_IMAGES?.split(':').filter(Boolean) ?? [];
const note = (entry) => appendFileSync(log, `${JSON.stringify(entry)}\n`);

function fill(schema) {
  const input = {};
  for (const name of schema?.required ?? []) {
    const type = schema.properties?.[name]?.type;
    input[name] = /command|cmd|script/i.test(name) ? COMMAND : type === 'number' || type === 'integer' ? 1 : type === 'boolean' ? false : type === 'array' ? [] : 'x';
  }
  return input;
}

function stream(res, blocks, stop) {
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  send('message_start', { message: { id: 'msg_mock', type: 'message', role: 'assistant', model: 'mock', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      send('content_block_start', { index, content_block: { type: 'text', text: '' } });
      send('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } });
    } else {
      send('content_block_start', { index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
      send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    }
    send('content_block_stop', { index });
  });
  send('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } });
  send('message_stop', {});
  res.end();
}

createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    if (req.method !== 'POST' || !req.url.endsWith('/messages')) {
      note({ other: `${req.method} ${req.url}` });
      res.writeHead(404, { 'content-type': 'application/json' }).end('{}');
      return;
    }
    const request = JSON.parse(body);
    const last = request.messages.at(-1);
    const results = Array.isArray(last?.content) ? last.content.filter((part) => part.type === 'tool_result') : [];
    const tool = (request.tools ?? []).find((entry) => /^(bash|shell|terminal|exec)/i.test(entry.name));
    note({ model: request.model, stream: request.stream, tools: (request.tools ?? []).map((entry) => entry.name), results });
    if (results.length > 0) stream(res, [{ type: 'text', text: 'Mock turn finished.' }], 'end_turn');
    else if (IMAGES.length > 0 && /run the check/i.test(JSON.stringify(last))) {
      stream(res, IMAGES.map((path, index) => ({ type: 'tool_use', id: `toolu_image_${index}`, name: 'read_image', input: { file_path: path } })), 'tool_use');
    }
    else if (tool !== undefined && /run the check/i.test(JSON.stringify(last))) {
      note({ chosen: tool.name, schema: tool.input_schema });
      stream(res, [{ type: 'tool_use', id: 'toolu_mock', name: tool.name, input: fill(tool.input_schema) }], 'tool_use');
    } else stream(res, [{ type: 'text', text: 'Mock title' }], 'end_turn');
  });
}).listen(Number(port), '127.0.0.1', () => note({ listening: Number(port) }));
