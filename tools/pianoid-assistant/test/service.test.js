// Assistant A1 (dev-df3c): isolation of the runtime + the service end to end with the zero-spend
// fake driver (real MCP server, real policy, fake :5000 / :3001 HTTP endpoints), over the pane WS.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { assistantPaths, assertSubscriptionOnly, authStatus, childEnv, ensureHome, loginCommand } from '../service/home.js';
import { createAssistantService } from '../service/server.js';
import { normalize } from '../drivers/sdk.js';
import { FakeDriver } from '../drivers/fake.js';
import { createArtifact, readArtifact } from '../analysis/store.js';

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pianoid-assistant-test-'));

test('isolation: child env is allow-listed and points every home into the isolated root', () => {
  const paths = assistantPaths({ PIANOID_ASSISTANT_HOME: 'X:\\iso' });
  const env = childEnv(paths, {
    PATH: 'p', ANTHROPIC_API_KEY: 'sk-live', ANTHROPIC_AUTH_TOKEN: 't', USERPROFILE: 'C:\\Users\\me',
    APPDATA: 'C:\\Users\\me\\AppData\\Roaming', CLAUDE_CONFIG_DIR: 'C:\\Users\\me\\.claude', SECRET: 's',
  });
  assert.equal(env.CLAUDE_CONFIG_DIR, path.join('X:\\iso', 'claude-home'));
  assert.equal(env.HOME, 'X:\\iso');
  assert.equal(env.USERPROFILE, 'X:\\iso');
  assert.ok(env.APPDATA.startsWith('X:\\iso') && env.LOCALAPPDATA.startsWith('X:\\iso'));
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.SECRET, undefined);
  assert.equal(env.PATH, 'p');
  assert.throws(() => assertSubscriptionOnly({ ANTHROPIC_API_KEY: 'x' }), /subscription/);
  assert.doesNotThrow(() => assertSubscriptionOnly({ ANTHROPIC_API_KEY: '  ' }));
  assert.match(loginCommand(paths).powershell, /CLAUDE_CONFIG_DIR=".*claude-home"; claude auth login --claudeai; Remove-Item Env:CLAUDE_CONFIG_DIR/);
});

test('isolation: the real CLI in an empty isolated home does not see the root login', { skip: !process.env.PATH }, () => {
  const paths = ensureHome(assistantPaths({ PIANOID_ASSISTANT_HOME: tmpHome() }));
  const s = authStatus(paths);
  if (s === null) return;           // no `claude` on PATH on this machine: nothing to probe
  assert.equal(s.loggedIn, false);
  assert.ok(!fs.readdirSync(paths.claudeHome).includes('.credentials.json'));
});

test('SDK message normalisation', () => {
  assert.deepEqual(normalize({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } } }), [{ type: 'delta', text: 'hi' }]);
  const [a] = normalize({ type: 'assistant', message: { model: 'm', content: [{ type: 'text', text: 'x' }, { type: 'tool_use', id: '1', name: 'mcp__pianoid__play__note', input: { pitch: 60 } }] } });
  assert.equal(a.text, 'x');
  assert.equal(a.toolUses[0].name, 'mcp__pianoid__play__note');
  assert.deepEqual(normalize({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: '1', content: [{ type: 'text', text: 'ok' }] }] } }), [{ type: 'tool_result', toolUseId: '1', isError: false, text: 'ok' }]);
  assert.equal(normalize({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } })[0].info.status, 'allowed');
  assert.equal(normalize({ type: 'result', subtype: 'success', usage: { output_tokens: 3 }, total_cost_usd: 0.1 })[0].costUsd, 0.1);
});

// ---- end to end with the fake driver --------------------------------------------------------

function fakePianoid() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      calls.push({ url: req.url, method: req.method, source: req.headers['x-pianoid-source'], client: req.headers['x-pianoid-client'], body });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/health') return res.end(JSON.stringify({ status: 'healthy', pianoid_loaded: true }));
      if (req.url === '/preset/list') return res.end(JSON.stringify({ active: 'P (working 1)', presets: [{ name: 'P (working 1)', kind: 'working' }] }));
      if (req.url.endsWith('/ui.snapshot')) return res.end(JSON.stringify({ ok: true, status: 200, result: { panes: ['Strings'] } }));
      if (req.url === '/command/render.note_playback') {
        return res.end(JSON.stringify({ ok: true, status: 200, result: { audio_data: [Buffer.from('RIFF....WAVE').toString('base64')], data: [[0, 0.25, -0.5]], chart_headers: ['p60'] } }));
      }
      return res.end(JSON.stringify({ ok: true, status: 200, result: { done: req.url } }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}` })));
}

async function startService({ driverFactory = null } = {}) {
  const fake = await fakePianoid();
  const home = tmpHome();
  const svc = createAssistantService({
    env: { ...process.env, ANTHROPIC_API_KEY: '', PIANOID_ASSISTANT_HOME: home, PIANOID_BACKEND_URL: fake.url, PIANOID_LAUNCHER_URL: fake.url },
    port: 0, driver: 'fake', driverFactory,
  });
  const port = await svc.listen();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const msgs = [];
  ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
  await new Promise((r) => ws.on('open', r));
  const send = (m) => ws.send(JSON.stringify(m));
  const waitFor = async (pred, ms = 15000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const m = msgs.find(pred);
      if (m) return m;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`timeout; got ${msgs.map((x) => x.type).join(',')}`);
  };
  const close = async () => { ws.close(); await svc.close(); fake.server.close(); };
  return { svc, fake, msgs, send, waitFor, close, port };
}

test('turn: ui command runs through policy + the real MCP server; context block; usage', async () => {
  const t = await startService();
  try {
    t.send({ type: 'hello' });
    const st = await t.waitFor((m) => m.type === 'state');
    assert.equal(st.user, undefined);                // no user management (D5)
    assert.equal(st.model.current, 'claude-sonnet-5-5');
    t.send({ type: 'turn', text: 'open Modes' });
    await t.waitFor((m) => m.type === 'message' && m.role === 'assistant');
    const call = t.fake.calls.find((c) => c.url === '/api/command/ui.pane.open');
    assert.ok(call, JSON.stringify(t.fake.calls.map((c) => c.url)));
    assert.equal(JSON.parse(call.body).pane, 'Modes');
    assert.equal(call.source, 'assistant');
    assert.equal(call.client, undefined);
    assert.ok(t.fake.calls.some((c) => c.url === '/api/command/ui.snapshot'));      // per-turn context
    const act = t.msgs.filter((m) => m.type === 'activity').map((m) => m.entry).find((e) => e.command === 'ui.pane.open');
    assert.equal(act.decision, 'allow');
    assert.ok(t.msgs.some((m) => m.type === 'usage' && m.usage.totals.turns === 1));
  } finally { await t.close(); }
});

test('confirm round trip for a destructive command (owner): reject then accept', async () => {
  const t = await startService();
  try {
    t.send({ type: 'turn', text: 'save it' });
    const c1 = await t.waitFor((m) => m.type === 'confirm');
    assert.equal(c1.command, 'preset.save');
    t.send({ type: 'confirm', id: c1.id, allow: false });
    await t.waitFor((m) => m.type === 'busy' && m.busy === false);
    assert.ok(!t.fake.calls.some((c) => c.url === '/command/preset.save'));
    t.msgs.length = 0;
    t.send({ type: 'turn', text: 'save again' });
    const c2 = await t.waitFor((m) => m.type === 'confirm');
    t.send({ type: 'confirm', id: c2.id, allow: true });
    await t.waitFor((m) => m.type === 'busy' && m.busy === false);
    assert.ok(t.fake.calls.some((c) => c.url === '/command/preset.save'));
  } finally { await t.close(); }
});

test('data opt-out: measurement tools denied without asking; restarts the session', async () => {
  const t = await startService();
  try {
    t.send({ type: 'settings', dataOptOut: true });
    await t.waitFor((m) => m.type === 'state' && m.dataOptOut === true);
    t.send({ type: 'turn', text: 'calibrate now' });
    await t.waitFor((m) => m.type === 'busy' && m.busy === false);
    assert.ok(!t.msgs.some((m) => m.type === 'confirm'));
    const act = t.msgs.filter((m) => m.type === 'activity').map((m) => m.entry).find((e) => e.command === 'calibration.synthesis');
    assert.equal(act.decision, 'deny');
    assert.ok(!t.fake.calls.some((c) => c.url === '/command/calibration.synthesis'));
  } finally { await t.close(); }
});

test('escalation in auto mode; forced model ignores it; Stop denies a pending confirm', async () => {
  const t = await startService();
  try {
    t.send({ type: 'turn', text: 'research this' });
    await t.waitFor((m) => m.type === 'model' && m.escalated === true && m.current === 'claude-opus-5-5');
    const routes = () => t.msgs.filter((m) => m.type === 'activity' && m.entry.command === 'model route').map((m) => m.entry);
    await t.waitFor((m) => m.type === 'busy' && m.busy === false);
    assert.match(routes()[0].reason, /^Opus: code \/ analysis \("research"\)/);     // v2 pre-route (layer 1)
    // stickiness: the next 2 turns stay on Opus, the third returns to Sonnet
    for (const [i, expect] of [[1, /sticky follow-up \(1 of 2/], [2, /sticky follow-up \(2 of 2/], [3, /^Sonnet: plain action/]]) {
      t.msgs.length = 0;
      t.send({ type: 'turn', text: `open Modes ${i}` });
      await t.waitFor((m) => m.type === 'busy' && m.busy === false);
      assert.match(routes()[0].reason, expect);
    }
    await t.waitFor((m) => m.type === 'model' && m.escalated === false && m.current === 'claude-sonnet-5-5');
    t.send({ type: 'settings', model: 'sonnet' });
    await t.waitFor((m) => m.type === 'state' && m.modelChoice === 'sonnet');
    t.msgs.length = 0;
    t.send({ type: 'turn', text: 'research again' });
    await t.waitFor((m) => m.type === 'busy' && m.busy === false);
    assert.ok(!t.msgs.some((m) => m.type === 'model' && m.escalated));
    t.send({ type: 'turn', text: 'save it' });
    const c = await t.waitFor((m) => m.type === 'confirm');
    t.send({ type: 'stop' });
    const done = await t.waitFor((m) => m.type === 'confirm_done' && m.id === c.id);
    assert.equal(done.allow, false);
  } finally { await t.close(); }
});

test('SDK options of the real runtime: no built-in tools, no settings, strict single MCP server, isolated cwd/env', async () => {
  const t = await startService();
  try {
    const o = t.svc.session.sdkOptions();
    assert.deepEqual(o.tools, []);
    assert.deepEqual(o.settingSources, []);
    assert.equal(o.strictMcpConfig, true);
    assert.deepEqual(Object.keys(o.mcpServers).sort(), ['analysis', 'assistant', 'pianoid']);   // analysis: v2 P5
    assert.deepEqual(o.disallowedTools, ['Bash', 'PowerShell']);
    assert.equal(o.hooks.PreToolUse.length, 1);
    assert.equal(o.mcpServers.pianoid.env.PIANOID_ANALYSIS_ARTIFACTS, t.svc.session.analysis.artifacts);
    assert.ok(!o.mcpServers.pianoid.args.includes('--role'));
    assert.ok(o.cwd.startsWith(t.svc.paths.root));
    assert.ok(!o.cwd.toLowerCase().includes('pianoidinstall'));
    assert.equal(o.env.CLAUDE_CONFIG_DIR, t.svc.paths.claudeHome);
    assert.equal(o.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(o.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
    assert.equal(typeof o.systemPrompt, 'string');
    assert.equal(o.permissionMode, 'default');
  } finally { await t.close(); }
});

test('the service refuses to start with an API key in its environment', () => {
  assert.throws(() => createAssistantService({ env: { ...process.env, ANTHROPIC_API_KEY: 'sk-x', PIANOID_ASSISTANT_HOME: tmpHome() }, driver: 'fake' }), /paid API/);
});

test('v2 P5: render export -> run_python over the pane: the code confirm, a plot message, the PNG served', async () => {
  const script = [{
    match: 'compare',
    steps: [
      { tool: 'mcp__pianoid__render__note_playback', input: { pitch: 60, export: true } },
      { tool: 'mcp__analysis__run_python', input: { code: 'print(1)', inputs: [{ $ref: '0.artifact.id' }] } },
      { say: 'Compared.' },
    ],
  }];
  const t = await startService({ driverFactory: () => new FakeDriver({ script }) });
  let ran = null;
  t.svc.session.runPythonImpl = async (args, { paths }) => {     // the launcher itself: analysis.test.js
    ran = args;
    const png = createArtifact(paths.artifacts, { kind: 'png', source: 'analysis.run_python', files: [{ name: 'cmp.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }] });
    return { ok: true, exit: 0, stdout: '1', stderr: '', files: [{ artifact_id: png.id, name: 'cmp.png', kind: 'png', size: 9 }], skipped: [], limits_hit: [] };
  };
  try {
    t.send({ type: 'turn', text: 'compare the spectra' });
    const c = await t.waitFor((m) => m.type === 'confirm');
    assert.equal(c.command, 'analysis.run_python');                  // category code: asks
    assert.equal(c.args.code, 'print(1)');                            // the user sees the code
    assert.equal(ran, null);
    t.send({ type: 'confirm', id: c.id, allow: true });
    const plot = await t.waitFor((m) => m.type === 'message' && m.role === 'plot');
    const exported = readArtifact(t.svc.session.analysis.artifacts, ran.inputs[0]);
    assert.equal(exported.command, 'render.note_playback');
    assert.deepEqual(exported.files.map((f) => f.name), ['audio_0.wav', 'series_0.npy']);
    const res = await fetch(plot.files[0].url);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal((await fetch(`http://127.0.0.1:${t.port}/artifacts/${ran.inputs[0]}/meta.json`)).status, 404);
    await t.waitFor((m) => m.type === 'busy' && m.busy === false);
    const act = t.msgs.filter((m) => m.type === 'activity').map((m) => m.entry).filter((e) => e.command === 'analysis.run_python').pop();
    assert.equal(act.files[0].name, 'cmp.png');
    const route = t.msgs.filter((m) => m.type === 'activity' && m.entry.command === 'model route').map((m) => m.entry.reason);
    assert.ok(route.some((r) => /^Opus: code \/ analysis/.test(r)), JSON.stringify(route));    // pre-routed (layer 1)
  } finally { await t.close(); }
});

test('v2 P5: a declined code run never reaches the sandbox; a shell call is denied by the hook', async () => {
  const script = [{
    match: 'run',
    steps: [{ tool: 'Bash', input: { command: 'dir' } }, { tool: 'mcp__analysis__run_python', input: { code: 'print(2)' } }],
  }];
  const t = await startService({ driverFactory: () => new FakeDriver({ script }) });
  let ran = false;
  t.svc.session.runPythonImpl = async () => { ran = true; return { ok: true, files: [] }; };
  try {
    t.send({ type: 'turn', text: 'run it' });
    const c = await t.waitFor((m) => m.type === 'confirm');
    t.send({ type: 'confirm', id: c.id, allow: false });
    await t.waitFor((m) => m.type === 'busy' && m.busy === false);
    assert.equal(ran, false);
    const act = t.msgs.filter((m) => m.type === 'activity').map((m) => m.entry);
    assert.ok(!act.some((e) => e.command === 'Bash'));                 // denied before the policy log
    assert.equal(act.filter((e) => e.command === 'analysis.run_python').pop().decision, 'rejected');
    const route = act.filter((e) => e.command === 'model route').map((e) => e.reason);
    assert.ok(route.includes("Opus: tool trigger: first code run (analysis.run_python)"), JSON.stringify(route));   // layer 2
  } finally { await t.close(); }
});

test('dev-947d: bug.report over the pane: the draft in the confirm, then one POST /bug_report with the context', async () => {
  const draft = { title: 'Renders refused during live audio', classification: 'app_bug', description: 'R6 denies every render.' };
  const script = [{ match: 'file', steps: [{ tool: 'mcp__assistant__bug_report', input: draft }, { say: 'Filed.' }] }];
  const t = await startService({ driverFactory: () => new FakeDriver({ script }) });
  try {
    t.send({ type: 'turn', text: 'file it as a bug' });
    const c = await t.waitFor((m) => m.type === 'confirm');
    assert.equal(c.command, 'bug.report');
    assert.equal(c.args.title, draft.title);
    assert.ok(c.args.attached.includes('versions'));
    assert.ok(!t.fake.calls.some((x) => x.url === '/bug_report'));
    t.send({ type: 'confirm', id: c.id, allow: true });
    await t.waitFor((m) => m.type === 'busy' && m.busy === false);
    const posts = t.fake.calls.filter((x) => x.url === '/bug_report');
    assert.equal(posts.length, 1);
    const body = JSON.parse(posts[0].body);
    assert.deepEqual(body.trigger, { auto: false, source: 'assistant', kind: 'app_bug' });
    assert.equal(body.pianoid_context.backend.status, 'healthy');
    assert.equal(body.transcript_excerpt.at(-1).text, 'file it as a bug');
  } finally { await t.close(); }
});
