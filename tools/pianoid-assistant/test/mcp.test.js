// Assistant A4 (dev-df3c): policy + the MCP server generated from the REAL command registry.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { decide } from '../policy.js';
import { INSTALL_ROOT, loadCommands } from '../lib/registry.js';
import { createPianoidMcpServer } from '../mcp/server.js';
import { compact, listTools } from '../mcp/tools.js';
import { buildIndex, search, slugify, pageUrl } from '../mcp/docsIndex.js';

const COMMANDS = loadCommands();
const byName = Object.fromEntries(COMMANDS.map((c) => [c.name, c]));
const d = (name, settings = {}) => {
  const c = byName[name];
  return decide({ command: c.name, tier: c.tier, family: c.family, settings }).action;
};

test('policy: D3 table on the real registry tiers (single user, D5)', () => {
  for (const n of ['ui.snapshot', 'ui.pane.open', 'play.note', 'render.note_playback', 'render.chart', 'param.get', 'job.list']) {
    assert.equal(d(n), 'allow', n);
  }
  for (const n of ['param.set', 'runtime.set', 'preset.switch', 'history.undo']) assert.equal(d(n), 'confirm', n);   // until A2
  for (const n of ['preset.save', 'preset.promote', 'preset.load', 'preset.unload', 'calibration.synthesis', 'modal.run_stage', 'modal.apply_to_preset']) {
    assert.equal(d(n), 'confirm', n);
  }
  assert.equal(d('launcher.backend.start'), 'confirm');
  assert.equal(d('launcher.status'), 'allow');
  assert.equal(d('launcher.backend.stop'), 'deny');                      // excluded tier
  assert.equal(d('calibration.status', { dataOptOut: true }), 'deny');
  assert.equal(d('modal.status', { dataOptOut: true }), 'deny');
  assert.equal(d('play.note', { dataOptOut: true }), 'allow');
});

test('renders are act tier (D3), excluded never listed', () => {
  assert.ok(COMMANDS.filter((c) => c.family === 'render').every((c) => c.tier !== 'destructive'));
  const names = listTools(COMMANDS).map((t) => t.name);
  assert.ok(!names.includes('launcher__backend__stop') && !names.includes('launcher__assistant__stop'));
  assert.ok(names.includes('ui__pane__open') && names.includes('search_docs'));
  assert.deepEqual(names, [...names].sort());
});

const connect = async (opts) => {
  const server = createPianoidMcpServer(opts);
  const client = new Client({ name: 'test', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  return client;
};

const fakeFetch = () => {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true, status: 200, result: { echoed: JSON.parse(init.body) } }) };
  };
  fn.calls = calls;
  return fn;
};

test('MCP list: registry tools with tier annotations; data opt-out hides measurement tools', async () => {
  const owner = await connect({ fetchImpl: fakeFetch() });
  const { tools } = await owner.listTools();
  const t = Object.fromEntries(tools.map((x) => [x.name, x]));
  assert.equal(t.play__note.annotations.readOnlyHint, false);
  assert.equal(t.ui__snapshot.annotations.readOnlyHint, true);
  assert.equal(t.preset__save.annotations.destructiveHint, true);
  assert.equal(t.param__get.annotations.idempotentHint, true);
  assert.deepEqual(t.play__note.inputSchema, byName['play.note'].args);
  assert.match(t.play__note.description, /tier: act/);
  const optOut = await connect({ settings: { dataOptOut: true }, fetchImpl: fakeFetch() });
  const names = (await optOut.listTools()).tools.map((x) => x.name);
  assert.ok(!names.includes('modal__run_stage') && !names.includes('calibration__synthesis'));
  assert.ok(names.includes('play__note'));
});

test('MCP call: backend -> :5000/command, ui -> :3001/api/command, source header; denied tool refused', async () => {
  const f = fakeFetch();
  const client = await connect({ source: 'assistant', fetchImpl: f });
  let r = await client.callTool({ name: 'play__note', arguments: { pitch: 60 } });
  assert.equal(r.isError, false);
  assert.equal(f.calls[0].url, 'http://127.0.0.1:5000/command/play.note');
  assert.equal(f.calls[0].headers['X-Pianoid-Source'], 'assistant');
  assert.equal(f.calls[0].headers['X-Pianoid-Client'], undefined);
  r = await client.callTool({ name: 'ui__pane__open', arguments: { pane: 'Modes' } });
  assert.equal(f.calls[1].url, 'http://127.0.0.1:3001/api/command/ui.pane.open');
  r = await client.callTool({ name: 'launcher__backend__stop', arguments: {} });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /never available/);
  assert.equal(f.calls.length, 2);
  r = await client.callTool({ name: 'nope', arguments: {} });
  assert.equal(r.isError, true);
});

test('MCP call: unreachable backend is a clean tool error', async () => {
  const client = await connect({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  const r = await client.callTool({ name: 'param__get', arguments: { parameter: 'mode', key_no: '5' } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /backend \(:5000\) is not reachable/);
});

test('search_docs over the real docs', async () => {
  const idx = buildIndex(path.join(INSTALL_ROOT, 'docs'));
  assert.ok(idx.length > 200);
  const hits = search(idx, 'undo redo history');
  assert.ok(hits.length > 0);
  assert.ok(hits.every((h) => h.url.startsWith('http://localhost:8001/')));
  assert.equal(slugify('Undo / redo (SSOT I3)'), 'undo-redo-ssot-i3');
  assert.equal(pageUrl('modules/pianoid-middleware/REST_API.md'), 'http://localhost:8001/modules/pianoid-middleware/REST_API/');
  const client = await connect({ fetchImpl: fakeFetch() });
  const r = await client.callTool({ name: 'search_docs', arguments: { query: 'command registry jobs' } });
  assert.ok(JSON.parse(r.content[0].text).length > 0);
});

test('compact keeps results small', () => {
  const out = compact({ a: Array.from({ length: 100 }, (_, i) => i), s: 'x'.repeat(5000) });
  assert.equal(out.a.length, 65);
  assert.match(out.s, /truncated/);
});

test('stdio: the real server process lists tools (standalone .mcp.json use)', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(INSTALL_ROOT, 'tools', 'pianoid-assistant', 'mcp', 'server.js'), '--data-opt-out', 'true'],
    env: { ...process.env, PIANOID_COMMANDS_DIR: path.join(INSTALL_ROOT, 'schemas', 'commands') },
  });
  const client = new Client({ name: 'stdio-test', version: '0' });
  await client.connect(transport);
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes('play__note') && names.includes('preset__save') && !names.includes('modal__run_stage'));
  await client.close();
});
