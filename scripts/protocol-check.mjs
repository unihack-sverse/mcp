/**
 * Speaks JSON-RPC to `dist/index.js` over stdio exactly as a client would: initialize, list tools,
 * then call a read-only tool. Proves the built server registers 7 tools with valid schemas and that
 * stdout stays protocol-clean (any stray logging would fail the parse).
 *
 *   SVERSE_API_KEY=sk_live_… node scripts/protocol-check.mjs
 */
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(HERE, '..', 'dist', 'index.js');
const EXPECTED = ['sverse_whoami', 'sverse_scan_project', 'sverse_propose_items', 'sverse_run_step', 'sverse_get_job', 'sverse_publish', 'sverse_preview_sdk'];

const child = spawn(process.execPath, [ENTRY], {
  env: { ...process.env, SVERSE_PROJECT_DIR: resolve(HERE, '..', 'test', 'fixtures', 'godot-min') },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buffer = '';
const pending = new Map();
let stderr = '';
let failures = 0;

child.stderr.on('data', (chunk) => {
  stderr += chunk.toString();
});
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stdout.write(`FAIL stdout is not JSON-RPC: ${line.slice(0, 120)}\n`);
      failures += 1;
      continue;
    }
    const resolvePending = pending.get(message.id);
    if (resolvePending) {
      pending.delete(message.id);
      resolvePending(message);
    }
  }
});

let nextId = 1;
function send(method, params) {
  const id = nextId++;
  const payload = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
  child.stdin.write(`${JSON.stringify(payload)}\n`);
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), 20_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolvePromise(message);
    });
  });
}

function check(name, condition, detail) {
  if (condition) {
    process.stdout.write(`PASS ${name}\n`);
    return;
  }
  failures += 1;
  process.stdout.write(`FAIL ${name} — ${JSON.stringify(detail)}\n`);
}

try {
  const init = await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'protocol-check', version: '1.0.0' } });
  check('initialize succeeds', init.result?.serverInfo?.name === 'sverse', init);

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  const list = await send('tools/list', {});
  const tools = list.result?.tools ?? [];
  check('exactly 7 tools', tools.length === 7, tools.map((tool) => tool.name));
  check('tool names match', JSON.stringify(tools.map((tool) => tool.name).sort()) === JSON.stringify([...EXPECTED].sort()), tools.map((tool) => tool.name));
  for (const tool of tools) {
    check(`${tool.name} has a description`, typeof tool.description === 'string' && tool.description.length > 40, tool.description?.slice(0, 60));
    check(`${tool.name} has an object input schema`, tool.inputSchema?.type === 'object', tool.inputSchema);
  }

  const whoami = await send('tools/call', { name: 'sverse_whoami', arguments: {} });
  check('sverse_whoami returns content', Array.isArray(whoami.result?.content) && whoami.result.content.length > 0, whoami.result);
  check('sverse_whoami is not an error', whoami.result?.isError !== true, whoami.result?.content?.[0]?.text);

  // preview_sdk is pure-local: it must work without any API call succeeding.
  const preview = await send('tools/call', {
    name: 'sverse_preview_sdk',
    arguments: { path: resolve(HERE, '..', 'test', 'fixtures', 'godot-min'), sdk: 'sverse-godot' },
  });
  const previewText = preview.result?.content?.[0]?.text ?? '';
  check('sverse_preview_sdk returns a diff', previewText.includes('--- ') && previewText.includes('addons/sverse/sverse.gd'), previewText.slice(0, 120));
  check('sverse_preview_sdk writes nothing', !previewText.includes('Wrote files: true'), previewText.slice(0, 80));

  check('startup banner went to stderr', /sverse-mcp ready/.test(stderr), stderr.slice(0, 120));
} finally {
  child.kill();
}

process.stdout.write(`\n${failures === 0 ? 'protocol check passed' : `${failures} check(s) failed`}\n`);
if (failures > 0) process.exitCode = 1;
