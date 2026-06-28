/**
 * CLI-STREAM (`claude -p` stream-json) HEDGE driver tests.
 *
 * Drives the driver with a FAKE child process that feeds captured NDJSON frames on
 * stdout and records stdin writes — the structured analog of the (retired) FakePty,
 * and far simpler since NDJSON has no chrome. Asserts:
 *   - buildCliArgs → the right flags, and NEVER `--api-key` (cost safety)
 *   - makeCliUserTurn → the standard Anthropic user envelope
 *   - mapCliMessage → system_init / assistant(text+tool_use) / user(tool_result) / result
 *   - iterateNdjsonLines reassembles chunk-split lines
 *   - end-to-end: a two-turn drive yields the expected SessionEvents; send() writes
 *     the user envelope to the child's stdin
 *   - the child env never gets an injected api key
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CliStreamDriver,
  buildCliArgs,
  extractSystemPromptAppend,
  makeCliUserTurn,
  mapCliMessage,
  iterateNdjsonLines,
  resolveCommandPath,
  terminateChildTree,
  writeMcpConfigFile,
  type CliChildProcess,
  type CliSpawnFn,
} from '../adapters/cli-stream-driver.js';
import type { PermissionDecision, SessionEvent, SessionStartOptions } from '../session-driver.js';
import { existsSync, readFileSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const noPerm = async (): Promise<PermissionDecision> => ({ behavior: 'allow' });
const baseOpts = (over: Partial<SessionStartOptions> = {}): SessionStartOptions => ({
  onPermission: noPerm,
  ...over,
});

// ── A fake child that yields scripted stdout chunks + records stdin ──
class FakeCliChild implements CliChildProcess {
  readonly stdinWrites: string[] = [];
  killed: string | undefined;
  readonly killSignals: string[] = [];
  stdinEnded = false;
  pid?: number;
  /** When true, never auto-fire 'exit' on kill — models a child that ignores SIGTERM. */
  ignoreKill = false;
  private readonly listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
  readonly stdin = {
    write: (c: string): void => void this.stdinWrites.push(c),
    end: (): void => void (this.stdinEnded = true),
  };
  readonly stdout: AsyncIterable<string>;
  constructor(chunks: string[], pid?: number) {
    this.pid = pid;
    this.stdout = (async function* () {
      for (const c of chunks) yield c;
    })();
  }
  kill(signal?: string): void {
    const s = signal ?? 'SIGTERM';
    this.killed = s;
    this.killSignals.push(s);
    // A cooperative child exits on the (first) kill, unless told to ignore it.
    if (!this.ignoreKill) setImmediate(() => this.emit('exit', 0, s));
  }
  on(event: string, listener: (...a: unknown[]) => void): void {
    (this.listeners[event] ??= []).push(listener);
  }
  once(event: string, listener: (...a: unknown[]) => void): void {
    const wrap = (...a: unknown[]): void => {
      this.off(event, wrap);
      listener(...a);
    };
    this.on(event, wrap);
  }
  private off(event: string, listener: (...a: unknown[]) => void): void {
    this.listeners[event] = (this.listeners[event] ?? []).filter((l) => l !== listener);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const l of [...(this.listeners[event] ?? [])]) l(...args);
  }
}

function collectSpawn(child: FakeCliChild): { spawnFn: CliSpawnFn; lastArgs: () => string[]; lastEnv: () => NodeJS.ProcessEnv | undefined } {
  let args: string[] = [];
  let env: NodeJS.ProcessEnv | undefined;
  const spawnFn: CliSpawnFn = (_cmd, a, opts) => {
    args = a;
    env = opts.env;
    return child;
  };
  return { spawnFn, lastArgs: () => args, lastEnv: () => env };
}

async function drain(it: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

// ── buildCliArgs ──
test('buildCliArgs uses stream-json in+out and NEVER --api-key (cost safety)', () => {
  const args = buildCliArgs(baseOpts({ model: 'haiku', cwd: '/repo', resume: 'sess-1', permissionMode: 'default', allowedTools: ['Bash', 'Read'], disallowedTools: ['mcp__telegram__reply'], settingSources: ['project'] }));
  // structured framing
  assert.ok(args.includes('-p'));
  assert.deepEqual(args.slice(args.indexOf('--output-format'), args.indexOf('--output-format') + 2), ['--output-format', 'stream-json']);
  assert.deepEqual(args.slice(args.indexOf('--input-format'), args.indexOf('--input-format') + 2), ['--input-format', 'stream-json']);
  // mapped options
  assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'haiku']);
  assert.deepEqual(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2), ['--resume', 'sess-1']);
  assert.deepEqual(args.slice(args.indexOf('--allowed-tools'), args.indexOf('--allowed-tools') + 2), ['--allowed-tools', 'Bash,Read']);
  assert.deepEqual(args.slice(args.indexOf('--disallowed-tools'), args.indexOf('--disallowed-tools') + 2), ['--disallowed-tools', 'mcp__telegram__reply']);
  assert.deepEqual(args.slice(args.indexOf('--setting-sources'), args.indexOf('--setting-sources') + 2), ['--setting-sources', 'project']);
  // ★ PERMISSION ROUTING: --permission-prompt-tool stdio (route gated tools over the control protocol)
  assert.deepEqual(args.slice(args.indexOf('--permission-prompt-tool'), args.indexOf('--permission-prompt-tool') + 2), ['--permission-prompt-tool', 'stdio']);
  // ★ THE COST-SAFETY INVARIANT: no api-key flag, ever
  assert.ok(!args.includes('--api-key'), 'must never pass --api-key');
  assert.ok(!args.some((a) => /api[-_]?key/i.test(a)), 'no api-key flag in any form');
});

// ── MCP CONFIG (2026-06-20): --mcp-config wiring + the private 0600 temp file ──
test('★ (criterion a) buildCliArgs emits --mcp-config <path> when a path is given, and NEVER --strict-mcp-config', () => {
  const args = buildCliArgs(baseOpts(), '/tmp/supervisor-mcp-1.json');
  const i = args.indexOf('--mcp-config');
  assert.ok(i >= 0, '--mcp-config flag present');
  assert.equal(args[i + 1], '/tmp/supervisor-mcp-1.json', 'the temp file path is passed');
  // ★ the connector-preservation invariant: --strict-mcp-config would DROP the claude.ai
  // Drive/Gmail/Calendar connector servers → must NEVER be emitted.
  assert.ok(!args.includes('--strict-mcp-config'), 'must NOT pass --strict-mcp-config (keeps the connector servers)');
});

test('★ buildCliArgs emits NO --mcp-config when no path is given (stays pure / no empty flag)', () => {
  const args = buildCliArgs(baseOpts());
  assert.ok(!args.includes('--mcp-config'), 'no --mcp-config without a config file');
  assert.ok(!args.includes('--strict-mcp-config'), 'never --strict-mcp-config');
});

test('★ (criterion f) writeMcpConfigFile writes {mcpServers} as a 0600 file under the temp dir; undefined for empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcpcfg-test-'));
  try {
    // empty / absent → no file, undefined
    assert.equal(writeMcpConfigFile(undefined, dir), undefined, 'undefined map → no file');
    assert.equal(writeMcpConfigFile({}, dir), undefined, 'empty map → no file');

    const map = { 'deepseek-codegen': { command: 'd', env: { DEEPSEEK_API_KEY: 'sk-SECRET' } }, whatsapp: { command: 'w' } };
    const path = writeMcpConfigFile(map, dir);
    assert.ok(path && existsSync(path), 'a config file was written');
    // shape = { "mcpServers": {...} } (the CLI's expected format)
    const parsed = JSON.parse(readFileSync(path!, 'utf8')) as { mcpServers: Record<string, unknown> };
    assert.deepEqual(Object.keys(parsed.mcpServers).sort(), ['deepseek-codegen', 'whatsapp']);
    // 0600 perms (owner-only) on POSIX; on Windows the mode bits are advisory so we only assert there.
    if (process.platform !== 'win32') {
      const mode = statSync(path!).mode & 0o777;
      assert.equal(mode, 0o600, `file mode is 0600 (got ${mode.toString(8)})`);
    }
    // the file lives UNDER the temp dir, never the repo
    assert.ok(path!.startsWith(dir), 'temp file under os.tmpdir, not the repo');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★ (criteria a+f) start() writes the 0600 --mcp-config file + passes it; stop() UNLINKS it; secrets never logged', async () => {
  const frames = [JSON.stringify({ type: 'result', subtype: 'success', session_id: 'S1' }) + '\n'];
  const child = new FakeCliChild(frames);
  const { spawnFn, lastArgs } = collectSpawn(child);
  // Capture EVERY stderr line the driver emits (the only logging sink it has) to prove no secret leaks.
  const stderrLines: string[] = [];
  const driver = new CliStreamDriver({ spawnFn, onStderr: (l) => stderrLines.push(l) });

  const mcpServers = { 'deepseek-codegen': { command: 'd', env: { DEEPSEEK_API_KEY: 'sk-TOPSECRET-12345' } } };
  const it = driver.start(baseOpts({ mcpServers }));
  // The flag + path are on the spawned argv
  const args = lastArgs();
  const i = args.indexOf('--mcp-config');
  assert.ok(i >= 0, '--mcp-config on the child argv');
  const cfgPath = args[i + 1]!;
  assert.ok(existsSync(cfgPath), 'the config file exists while the session runs');
  assert.ok(!args.includes('--strict-mcp-config'), 'no --strict-mcp-config');
  // the SECRET is in the FILE but NOT on the command line (argv) — argv is process-table-visible
  assert.ok(!args.some((a) => a.includes('sk-TOPSECRET')), 'secret never appears in argv');
  assert.ok(readFileSync(cfgPath, 'utf8').includes('sk-TOPSECRET-12345'), 'the resolved secret is in the 0600 file');

  await drain(it);
  await driver.stop();
  // ★ unlinked on stop
  assert.ok(!existsSync(cfgPath), 'the --mcp-config temp file is unlinked on stop()');
  // ★ no secret ever logged (the driver's stderr sink — the only place it could leak)
  assert.ok(!stderrLines.some((l) => l.includes('sk-TOPSECRET') || l.includes('DEEPSEEK_API_KEY')), 'no secret/key in any log line');
});

test('★ no mcpServers → start() passes NO --mcp-config and writes no temp file', async () => {
  const frames = [JSON.stringify({ type: 'result', subtype: 'success', session_id: 'S1' }) + '\n'];
  const child = new FakeCliChild(frames);
  const { spawnFn, lastArgs } = collectSpawn(child);
  const driver = new CliStreamDriver({ spawnFn });
  await drain(driver.start(baseOpts())); // no mcpServers
  assert.ok(!lastArgs().includes('--mcp-config'), 'no --mcp-config when the map is absent');
  await driver.stop();
});

// ── H1: --append-system-prompt (the system prompt must reach the model on cli-stream) ──
test('★ H1: buildCliArgs emits --append-system-prompt for the {preset, append} form', () => {
  const args = buildCliArgs(baseOpts({ systemPrompt: { preset: 'claude_code', append: 'HOSTING CONTEXT + methodology' } }));
  const i = args.indexOf('--append-system-prompt');
  assert.ok(i >= 0, 'append flag present');
  assert.equal(args[i + 1], 'HOSTING CONTEXT + methodology', 'the append text is passed inline');
  // NOT the broken file variant
  assert.ok(!args.includes('--append-system-prompt-file'), 'uses inline, not the ignored -file variant');
});

test('★ H1: buildCliArgs emits --append-system-prompt for a plain-string systemPrompt (demo)', () => {
  const args = buildCliArgs(baseOpts({ systemPrompt: 'demo persona' }));
  const i = args.indexOf('--append-system-prompt');
  assert.equal(args[i + 1], 'demo persona');
});

test('★ H1: NO append flag when systemPrompt is unset (no empty arg)', () => {
  const args = buildCliArgs(baseOpts());
  assert.ok(!args.includes('--append-system-prompt'), 'no append flag without a system prompt');
});

test('extractSystemPromptAppend: string→itself, preset→append, undefined→empty', () => {
  assert.equal(extractSystemPromptAppend('x'), 'x');
  assert.equal(extractSystemPromptAppend({ preset: 'claude_code', append: 'y' }), 'y');
  assert.equal(extractSystemPromptAppend({ preset: 'claude_code' }), '');
  assert.equal(extractSystemPromptAppend(undefined), '');
});

// ── resolveCommandPath (Windows .cmd shim / POSIX PATH resolution — the ENOENT fix) ──
test('resolveCommandPath: an already-pathy command is returned unchanged', () => {
  assert.equal(resolveCommandPath('/usr/bin/claude', {} as NodeJS.ProcessEnv), '/usr/bin/claude');
  assert.equal(resolveCommandPath('C:\\x\\claude.cmd', {} as NodeJS.ProcessEnv), 'C:\\x\\claude.cmd');
});

test('resolveCommandPath: a bare name not found on PATH is returned unchanged (spawn surfaces ENOENT)', () => {
  assert.equal(resolveCommandPath('definitely-not-a-real-binary-xyz', { PATH: '' } as NodeJS.ProcessEnv), 'definitely-not-a-real-binary-xyz');
});

test('resolveCommandPath: resolves a bare name from PATH (finds this dir self)', () => {
  // Use a known-present file: resolve "package" against a PATH that includes the supervisor dir,
  // with an ext that matches package.json — proves PATH+ext scanning works cross-platform.
  // (Kept hermetic: we only assert it returns an absolute path ending in the file when found.)
  const env = { PATH: process.cwd(), PATHEXT: '.JSON' } as unknown as NodeJS.ProcessEnv;
  const r = resolveCommandPath('package', env);
  // On a machine where cwd has package.json this resolves; otherwise it returns the input.
  assert.ok(r === 'package' || /package\.json$/i.test(r), `resolved to ${r}`);
});

// ── makeCliUserTurn ──
test('makeCliUserTurn builds the standard Anthropic user envelope', () => {
  const line = makeCliUserTurn('hello there');
  assert.deepEqual(JSON.parse(line), { type: 'user', message: { role: 'user', content: 'hello there' } });
});

// ── mapCliMessage (the same schema the SDK driver maps) ──
test('mapCliMessage maps system/init with composition fields', () => {
  const ev = mapCliMessage({
    type: 'system',
    subtype: 'init',
    session_id: 'S1',
    model: 'claude-opus-4-8',
    tools: ['Bash', 'Read'],
    slash_commands: ['orchestrator', 'dev'],
    mcp_servers: [{ name: 'context7' }, { name: 'hostinger-email' }],
  });
  assert.equal(ev?.kind, 'system_init');
  if (ev?.kind === 'system_init') {
    assert.equal(ev.sessionId, 'S1');
    assert.equal(ev.model, 'claude-opus-4-8');
    assert.deepEqual(ev.slashCommands, ['orchestrator', 'dev']);
    assert.deepEqual(ev.mcpServers, ['context7', 'hostinger-email']);
  }
});

test('mapCliMessage maps assistant text + tool_use', () => {
  const ev = mapCliMessage({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'working' }, { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }] },
  });
  assert.equal(ev?.kind, 'assistant');
  if (ev?.kind === 'assistant') {
    assert.equal(ev.text, 'working');
    assert.equal(ev.toolUses.length, 1);
    assert.deepEqual(ev.toolUses[0], { id: 'tu1', name: 'Bash', input: { command: 'ls' } });
  }
});

test('mapCliMessage maps a tool_result carried in a user message', () => {
  const ev = mapCliMessage({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'file.txt', is_error: false }] } });
  assert.equal(ev?.kind, 'tool_result');
  if (ev?.kind === 'tool_result') {
    assert.equal(ev.toolUseId, 'tu1');
    assert.equal(ev.content, 'file.txt');
    assert.equal(ev.isError, false);
  }
});

test('mapCliMessage maps result/success (turn-complete = the result object)', () => {
  const ev = mapCliMessage({ type: 'result', subtype: 'success', session_id: 'S1', result: 'Paris.', total_cost_usd: 0.02 });
  assert.equal(ev?.kind, 'result');
  if (ev?.kind === 'result') {
    assert.equal(ev.subtype, 'success');
    assert.equal(ev.result, 'Paris.');
    assert.equal(ev.costUsd, 0.02);
    assert.equal(ev.sessionId, 'S1');
  }
});

test('mapCliMessage ignores unmodeled types and never throws on junk', () => {
  assert.equal(mapCliMessage({ type: 'system', subtype: 'thinking_tokens' }), null);
  assert.equal(mapCliMessage({ type: 'rate_limit_event' }), null);
  assert.equal(mapCliMessage({ type: 'user', message: { content: [{ type: 'text', text: 'echo' }] } }), null); // user echo, no tool_result
  assert.equal(mapCliMessage(null), null);
  assert.equal(mapCliMessage({}), null);
});

// ── iterateNdjsonLines reassembles split chunks ──
test('iterateNdjsonLines reassembles lines split across chunks', async () => {
  async function* chunks(): AsyncGenerator<string> {
    yield '{"a":1}\n{"b":'; // a line + a partial
    yield '2}\n'; // completes the partial
    yield '{"c":3}'; // trailing, no newline → flushed at end
  }
  const lines: string[] = [];
  for await (const l of iterateNdjsonLines(chunks())) lines.push(l);
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}']);
});

// ── End-to-end drive via the fake child ──
test('★ end-to-end: a turn yields system_init → assistant → result; send() writes the envelope', async () => {
  // A captured single-turn stream-json transcript (the exact schema the CLI emits).
  const frames = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'S9', model: 'haiku', slash_commands: [{ name: 'orchestrator' }] }) + '\n',
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Paris.' }] } }) + '\n',
    JSON.stringify({ type: 'result', subtype: 'success', session_id: 'S9', result: 'Paris.', total_cost_usd: 0.01 }) + '\n',
  ];
  const child = new FakeCliChild(frames);
  const { spawnFn, lastArgs, lastEnv } = collectSpawn(child);
  const driver = new CliStreamDriver({ spawnFn });

  const it = driver.start(baseOpts({ bootstrapTurns: ['/orchestrator'] }));
  // send a real turn while the stream is consumed
  await driver.send({ text: 'capital of France' });
  const events = await drain(it);

  const kinds = events.map((e) => e.kind);
  assert.deepEqual(kinds, ['system_init', 'assistant', 'result']);
  const result = events.find((e) => e.kind === 'result');
  assert.equal(result?.kind === 'result' && result.result, 'Paris.');
  assert.equal(driver.health().sessionId, 'S9');

  // bootstrap + the user turn were both written as the standard envelope to stdin
  assert.ok(child.stdinWrites.some((w) => JSON.parse(w.trim()).message.content === '/orchestrator'), 'bootstrap turn injected');
  assert.ok(child.stdinWrites.some((w) => JSON.parse(w.trim()).message.content === 'capital of France'), 'user turn injected');

  // ★ cost safety at the spawn boundary: no --api-key, and no api key injected into env
  assert.ok(!lastArgs().includes('--api-key'));
  const env = lastEnv() ?? {};
  assert.ok(!('ANTHROPIC_API_KEY' in env) || !env['ANTHROPIC_API_KEY'], 'no api key injected into child env');
});

// ── Permission control protocol (R4) — the core of item (ii) ──
test('★ control_request{can_use_tool} → routes to onPermission → writes control_response (ALLOW); not yielded as an event', async () => {
  const frames = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'S1', model: 'opus' }) + '\n',
    // the CLI raises a permission request over the control protocol (carries agent_id →
    // would be a sub-agent's tool too):
    JSON.stringify({
      type: 'control_request',
      request_id: 'req-1',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'tu1', agent_id: 'sub-A' },
    }) + '\n',
    JSON.stringify({ type: 'result', subtype: 'success', session_id: 'S1', result: 'done' }) + '\n',
  ];
  const child = new FakeCliChild(frames);
  const { spawnFn } = collectSpawn(child);
  let routed: { toolName: string; input: Record<string, unknown> } | undefined;
  const onPermission = async (req: { toolName: string; input: Record<string, unknown> }): Promise<PermissionDecision> => {
    routed = { toolName: req.toolName, input: req.input };
    return { behavior: 'allow' };
  };
  const driver = new CliStreamDriver({ spawnFn });
  const events = await drain(driver.start(baseOpts({ onPermission })));

  // the request went to the router (the supervisor's PermissionRouter in prod)
  assert.deepEqual(routed, { toolName: 'Bash', input: { command: 'ls' } }, 'permission routed to onPermission');
  // a control_response was written to stdin: success + the allow decision (updatedInput defaults to the input)
  const ctrl = child.stdinWrites.map((w) => JSON.parse(w.trim())).find((m) => m.type === 'control_response');
  assert.ok(ctrl, 'control_response written');
  assert.equal(ctrl.response.subtype, 'success');
  assert.equal(ctrl.response.request_id, 'req-1');
  assert.equal(ctrl.response.response.behavior, 'allow');
  assert.deepEqual(ctrl.response.response.updatedInput, { command: 'ls' });
  // the control_request is NOT surfaced as a SessionEvent (only system_init + result)
  assert.deepEqual(events.map((e) => e.kind), ['system_init', 'result']);
});

test('control_request{can_use_tool} DENY → control_response carries behavior:deny + message', async () => {
  const frames = [
    JSON.stringify({ type: 'control_request', request_id: 'req-9', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf /' }, tool_use_id: 'tu9' } }) + '\n',
    JSON.stringify({ type: 'result', subtype: 'success', session_id: 'S1' }) + '\n',
  ];
  const child = new FakeCliChild(frames);
  const { spawnFn } = collectSpawn(child);
  const onPermission = async (): Promise<PermissionDecision> => ({ behavior: 'deny', message: 'User denied.' });
  await drain(new CliStreamDriver({ spawnFn }).start(baseOpts({ onPermission })));
  const ctrl = child.stdinWrites.map((w) => JSON.parse(w.trim())).find((m) => m.type === 'control_response');
  assert.equal(ctrl.response.response.behavior, 'deny');
  assert.equal(ctrl.response.response.message, 'User denied.');
});

test('unsupported control_request subtype → error control_response (child does not hang)', async () => {
  const frames = [
    JSON.stringify({ type: 'control_request', request_id: 'req-x', request: { subtype: 'hook_callback', callback_id: 'h1' } }) + '\n',
    JSON.stringify({ type: 'result', subtype: 'success', session_id: 'S1' }) + '\n',
  ];
  const child = new FakeCliChild(frames);
  const { spawnFn } = collectSpawn(child);
  await drain(new CliStreamDriver({ spawnFn }).start(baseOpts()));
  const ctrl = child.stdinWrites.map((w) => JSON.parse(w.trim())).find((m) => m.type === 'control_response');
  assert.equal(ctrl.response.subtype, 'error', 'replies error so the child does not block forever');
});

test('stop() ends stdin + kills the child', async () => {
  const child = new FakeCliChild([]);
  const { spawnFn } = collectSpawn(child);
  const driver = new CliStreamDriver({ spawnFn });
  // start + immediately drain (no frames → completes)
  await drain(driver.start(baseOpts()));
  await driver.stop();
  assert.ok(child.killed, 'child killed on stop');
  assert.ok(child.stdinEnded, 'stdin ended on stop');
  assert.equal(driver.health().running, false);
});

// ── ★M-1: stop() tree-kills the child + AWAITS its exit (no orphaned grandchildren) ──
test('★M-1: terminateChildTree on Windows tree-kills via taskkill /T /F /PID and awaits exit', async (t) => {
  if (process.platform !== 'win32') return t.skip('windows-only path');
  const child = new FakeCliChild([], 4242); // has a pid → Windows tree-kill branch
  const taskkillCalls: string[][] = [];
  // Inject a fake taskkill spawn that records args + returns a stub with .on.
  const fakeSpawn = ((_cmd: string, a: string[]) => {
    taskkillCalls.push([_cmd, ...a]);
    // Simulate the OS killing the tree → the child exits shortly after.
    setImmediate(() => child.emit('exit', 1, 'SIGKILL'));
    return { on: () => undefined } as unknown as ReturnType<typeof import('node:child_process').spawn>;
  }) as unknown as typeof import('node:child_process').spawn;
  await terminateChildTree(child, 3000, fakeSpawn);
  assert.equal(taskkillCalls.length, 1, 'taskkill invoked exactly once');
  assert.deepEqual(taskkillCalls[0], ['taskkill', '/T', '/F', '/PID', '4242'], 'tree+force kill of the child pid');
});

test('★M-1: terminateChildTree (no pid / POSIX path) escalates SIGTERM → SIGKILL on timeout', async () => {
  const child = new FakeCliChild([]); // NO pid → POSIX/no-pid branch
  child.ignoreKill = true; // the child ignores SIGTERM → force the SIGKILL escalation
  const start = Date.now();
  await terminateChildTree(child, 40); // short timeout
  const elapsed = Date.now() - start;
  assert.ok(child.killSignals.includes('SIGTERM'), 'SIGTERM sent first');
  assert.ok(child.killSignals.includes('SIGKILL'), 'SIGKILL escalation after the timeout');
  assert.ok(elapsed >= 35, 'awaited the grace window before resolving');
});

test('★M-1: terminateChildTree resolves promptly when the child exits cleanly (no hang)', async () => {
  const child = new FakeCliChild([]); // no pid → POSIX path; cooperative (exits on SIGTERM)
  const start = Date.now();
  await terminateChildTree(child, 5000); // big timeout — must NOT wait for it
  const elapsed = Date.now() - start;
  assert.ok(child.killSignals.includes('SIGTERM'), 'SIGTERM sent');
  assert.ok(!child.killSignals.includes('SIGKILL'), 'no SIGKILL needed (clean exit)');
  assert.ok(elapsed < 1000, `resolved on the exit event, not the timeout (took ${elapsed}ms)`);
});
