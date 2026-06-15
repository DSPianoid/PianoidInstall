/**
 * PtySessionDriver + render-parser tests — with a FakePty (no real node-pty, no
 * subprocess, no network). Drives the bounded render parser against render frames
 * captured VERBATIM from the 2026-06-15 probes, and asserts:
 *   - render frames → the right SessionEvents (system_init / assistant / tool_result / result)
 *   - a permission-prompt frame → the right PermissionRequest built from the HEADER block
 *   - on a verdict → the right keystroke is written to the PTY ("1\r" allow / Esc deny)
 *   - the trust pre-set writes the exact ~/.claude.json key (forward-slash, case-sensitive)
 *   - send() types text + submit key; interrupt() sends Esc; stop() ends the stream
 *
 * Mirrors the FakeSessionDriver approach: the seam is exercised deterministically.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, readFileSync, rmSync } from 'node:fs';
import {
  parseRenderChunk,
  permissionFromHeader,
  stripAnsi,
  type PtyRenderEvent,
} from '../adapters/pty-render-parser.js';
import {
  PtySessionDriver,
  preTrustProject,
  normalizeProjectKey,
  type PtyProcess,
  type PtySpawnFn,
} from '../adapters/pty-session-driver.js';
import type { PermissionDecision, SessionEvent } from '../session-driver.js';

// ── verbatim probe captures (the pinned fixtures) ────────────────────────────
const BOOT_FRAME =
  '────────────\n' +
  ' Claude Code v2.1.177\n' +
  ' Opus 4.8 (1M context) · Claude Max\n' +
  ' ~\\AppData\\Local\\Temp\\proj\n' +
  '────────────\n' +
  '❯ Try "refactor <filepath>"\n' +
  '  ? for shortcuts\n';

const PERMISSION_FRAME =
  '────────────\n' +
  ' Create file\n' +
  ' probe_marker.txt\n' +
  '╌╌╌╌╌╌╌╌╌╌╌╌\n' +
  '  1 PROBE-OK-98765\n' +
  '╌╌╌╌╌╌╌╌╌╌╌╌\n' +
  ' Do you want to create probe_marker.txt?\n' +
  ' ❯ 1. Yes\n' +
  '   2. Yes, allow all edits during this session (shift+tab)\n' +
  '   3. No\n' +
  ' Esc to cancel · Tab to amend\n';

const AFTER_GRANT_FRAME =
  '● Write(probe_marker.txt)\n' +
  '  ⎿  Wrote 1 lines to probe_marker.txt\n' +
  '❯ \n' +
  '  ? for shortcuts\n';

const TRUST_GATE_FRAME =
  ' Quick safety check: Is this a project you created or one you trust?\n' +
  ' ❯ 1. Yes, I trust this folder\n' +
  '   2. No, exit\n' +
  ' Enter to confirm · Esc to cancel\n';

// ── FakePty: scriptable {onData,write,kill} double ───────────────────────────
class FakePty implements PtyProcess {
  private dataCb: ((d: string) => void) | null = null;
  private exitCb: ((e: { exitCode: number }) => void) | null = null;
  private buffered: string[] = []; // frames emitted before onData was wired (a real PTY buffers)
  readonly writes: string[] = [];
  onData(cb: (d: string) => void): void {
    this.dataCb = cb;
    // flush any frames emitted before the consumer registered (eager-spawn ordering)
    for (const f of this.buffered.splice(0)) cb(f);
  }
  onExit(cb: (e: { exitCode: number }) => void): void {
    this.exitCb = cb;
  }
  write(d: string): void {
    this.writes.push(d);
  }
  kill(): void {
    this.exitCb?.({ exitCode: 0 });
  }
  /** test helper: push a render frame to the driver (buffers until onData is wired) */
  emit(frame: string): void {
    if (this.dataCb) this.dataCb(frame);
    else this.buffered.push(frame);
  }
}

function fakeSpawn(pty: FakePty, capture?: (file: string, args: string[]) => void): PtySpawnFn {
  return (file, args) => {
    capture?.(file, args);
    return pty;
  };
}
const allow = async (): Promise<PermissionDecision> => ({ behavior: 'allow' });

// ── render-parser unit tests (pure) ──────────────────────────────────────────
test('parser: BOOT frame → system_init with model', () => {
  const { events } = parseRenderChunk(BOOT_FRAME, { cwd: 'D:/repos/PianoidInstall' });
  const init = events.find((e) => e.kind === 'system_init') as Extract<PtyRenderEvent, { kind: 'system_init' }>;
  assert.ok(init, 'system_init emitted');
  assert.match(init.model ?? '', /Opus/);
  assert.ok(init.sessionId.startsWith('pty-'), 'synthetic session id');
});

test('parser: PERMISSION frame → permission event from the HEADER block (Write + file_path)', () => {
  const { events } = parseRenderChunk(PERMISSION_FRAME);
  const perm = events.find((e) => e.kind === 'permission') as Extract<PtyRenderEvent, { kind: 'permission' }>;
  assert.ok(perm, 'permission emitted');
  assert.equal(perm.toolName, 'Write');
  assert.equal(perm.input['file_path'], 'probe_marker.txt');
});

test('parser: AFTER-GRANT frame → assistant toolUse + tool_result + turn_complete', () => {
  const { events } = parseRenderChunk(AFTER_GRANT_FRAME);
  const tool = events.find((e) => e.kind === 'assistant' && (e.toolUses?.length ?? 0) > 0) as Extract<
    PtyRenderEvent,
    { kind: 'assistant' }
  >;
  assert.ok(tool, 'assistant toolUse emitted');
  assert.equal(tool.toolUses![0]!.name, 'Write');
  const tr = events.find((e) => e.kind === 'tool_result') as Extract<PtyRenderEvent, { kind: 'tool_result' }>;
  assert.ok(tr, 'tool_result emitted');
  assert.match(tr.content, /Wrote 1 lines/);
  const done = events.find((e) => e.kind === 'turn_complete');
  assert.ok(done, 'turn_complete emitted on input-box re-render');
});

test('parser: permissionFromHeader maps verbs/actions to tools', () => {
  assert.deepEqual(permissionFromHeader('create', 'a.txt', 'Create file'), {
    toolName: 'Write',
    input: { file_path: 'a.txt' },
  });
  assert.deepEqual(permissionFromHeader('edit', 'b.ts', 'Edit file'), { toolName: 'Edit', input: { file_path: 'b.ts' } });
  assert.deepEqual(permissionFromHeader('run', 'ls -la', 'Run command'), {
    toolName: 'Bash',
    input: { command: 'ls -la' },
  });
});

test('parser: carry returns the incomplete trailing line', () => {
  const { events, carry } = parseRenderChunk('● Write(x.txt)\n  ⎿  Wrote 1 lines to x');
  assert.ok(events.some((e) => e.kind === 'assistant'));
  assert.equal(carry, '  ⎿  Wrote 1 lines to x'); // no trailing newline → carried
});

test('parser: stripAnsi removes escape sequences', () => {
  assert.equal(stripAnsi('\x1b[1m\x1b[32mhi\x1b[0m'), 'hi');
});

// ── pre-trust unit test ──────────────────────────────────────────────────────
test('preTrustProject writes the exact forward-slash key', () => {
  const f = join(tmpdir(), `claude-json-test-${Date.now()}.json`);
  writeFileSync(f, JSON.stringify({ projects: {} }));
  try {
    const ok = preTrustProject(f, 'D:\\repos\\PianoidInstall');
    assert.equal(ok, true);
    const j = JSON.parse(readFileSync(f, 'utf8')) as { projects: Record<string, { hasTrustDialogAccepted?: boolean }> };
    assert.equal(normalizeProjectKey('D:\\repos\\PianoidInstall'), 'D:/repos/PianoidInstall');
    assert.equal(j.projects['D:/repos/PianoidInstall']!.hasTrustDialogAccepted, true);
    // a backslash key must NOT exist (forward-slash only)
    assert.equal(j.projects['D:\\repos\\PianoidInstall'], undefined);
  } finally {
    rmSync(f, { force: true });
  }
});

// ── driver integration tests (FakePty) ───────────────────────────────────────
test('driver: BOOT → system_init flows through start()', async () => {
  const pty = new FakePty();
  const driver = new PtySessionDriver({ spawnFn: fakeSpawn(pty), skipPreTrust: true });
  const events: SessionEvent[] = [];
  const iter = driver.start({ onPermission: allow, cwd: 'D:/repos/PianoidInstall' })[Symbol.asyncIterator]();
  // boot, then end the stream
  setTimeout(() => pty.emit(BOOT_FRAME), 5);
  setTimeout(() => void driver.stop(), 30);
  for (let r = await iter.next(); !r.done; r = await iter.next()) events.push(r.value);
  const init = events.find((e) => e.kind === 'system_init') as Extract<SessionEvent, { kind: 'system_init' }>;
  assert.ok(init, 'system_init reached the consumer');
  assert.match(init.model ?? '', /Opus/);
});

test('driver: permission prompt → router consulted → "1\\r" keystroke on allow', async () => {
  const pty = new FakePty();
  const routedBox: { v: { toolName: string; input: Record<string, unknown> } | null } = { v: null };
  const driver = new PtySessionDriver({ spawnFn: fakeSpawn(pty), skipPreTrust: true });
  const iter = driver
    .start({
      onPermission: async (req): Promise<PermissionDecision> => {
        routedBox.v = { toolName: req.toolName, input: req.input };
        return { behavior: 'allow' };
      },
      cwd: 'D:/repos/PianoidInstall',
    })
    [Symbol.asyncIterator]();
  // drive the consumer in the background so start()'s generator runs
  const drained: SessionEvent[] = [];
  const pump = (async () => {
    for (let r = await iter.next(); !r.done; r = await iter.next()) drained.push(r.value);
  })();
  pty.emit(PERMISSION_FRAME);
  // allow the async permission round-trip + keystroke to land
  await new Promise((r) => setTimeout(r, 40));
  await driver.stop();
  await pump;
  assert.ok(routedBox.v, 'router was consulted');
  assert.equal(routedBox.v!.toolName, 'Write');
  assert.equal(routedBox.v!.input['file_path'], 'probe_marker.txt');
  assert.ok(pty.writes.includes('1\r'), `allow keystroke "1\\r" written (writes=${JSON.stringify(pty.writes)})`);
});

test('driver: permission deny → Esc keystroke', async () => {
  const pty = new FakePty();
  const driver = new PtySessionDriver({ spawnFn: fakeSpawn(pty), skipPreTrust: true });
  const iter = driver
    .start({ onPermission: async () => ({ behavior: 'deny', message: 'no' }), cwd: 'x' })
    [Symbol.asyncIterator]();
  const pump = (async () => {
    for (let r = await iter.next(); !r.done; r = await iter.next()) void r;
  })();
  pty.emit(PERMISSION_FRAME);
  await new Promise((r) => setTimeout(r, 40));
  await driver.stop();
  await pump;
  assert.ok(pty.writes.includes('\x1b'), `deny → Esc written (writes=${JSON.stringify(pty.writes)})`);
});

test('driver: send() types text then the submit key; interrupt() sends Esc', async () => {
  const pty = new FakePty();
  const driver = new PtySessionDriver({ spawnFn: fakeSpawn(pty), skipPreTrust: true, submitDelayMs: 5 });
  const iter = driver.start({ onPermission: allow, cwd: 'x' })[Symbol.asyncIterator]();
  const pump = (async () => {
    for (let r = await iter.next(); !r.done; r = await iter.next()) void r;
  })();
  await driver.send({ text: 'hello world' });
  assert.equal(pty.writes[0], 'hello world');
  assert.equal(pty.writes[1], '\r');
  await driver.interrupt();
  assert.ok(pty.writes.includes('\x1b'), 'interrupt sends Esc');
  await driver.stop();
  await pump;
});

test('driver: buildArgs passes --model/--resume/--append-system-prompt', async () => {
  const pty = new FakePty();
  let capturedArgs: string[] = [];
  const driver = new PtySessionDriver({
    spawnFn: fakeSpawn(pty, (_f, a) => (capturedArgs = a)),
    skipPreTrust: true,
  });
  const iter = driver
    .start({
      onPermission: allow,
      cwd: 'x',
      model: 'claude-opus-4-8',
      resume: 'sess-123',
      systemPrompt: { preset: 'claude_code', append: 'You are the orchestrator.' },
    })
    [Symbol.asyncIterator]();
  const pump = (async () => {
    for (let r = await iter.next(); !r.done; r = await iter.next()) void r;
  })();
  await new Promise((r) => setTimeout(r, 10));
  await driver.stop();
  await pump;
  assert.ok(capturedArgs.includes('--model') && capturedArgs.includes('claude-opus-4-8'));
  assert.ok(capturedArgs.includes('--resume') && capturedArgs.includes('sess-123'));
  assert.ok(capturedArgs.includes('--append-system-prompt'));
});

test('driver: turn_complete is de-duped — many "❯" repaints → at most ONE result per turn', async () => {
  const pty = new FakePty();
  const driver = new PtySessionDriver({ spawnFn: fakeSpawn(pty), skipPreTrust: true, submitDelayMs: 5 });
  const results: SessionEvent[] = [];
  const iter = driver.start({ onPermission: allow, cwd: 'x' })[Symbol.asyncIterator]();
  const pump = (async () => {
    for (let r = await iter.next(); !r.done; r = await iter.next()) {
      if (r.value.kind === 'result') results.push(r.value);
    }
  })();
  await driver.send({ text: 'hi' });
  // content arrives, then the TUI repaints the input box several times
  pty.emit('● Bash(echo hi)\n  ⎿  hi\n');
  pty.emit('❯ \n  ? for shortcuts\n');
  pty.emit('❯ \n  ? for shortcuts\n');
  pty.emit('❯ Try "refactor"\n');
  await new Promise((r) => setTimeout(r, 20));
  await driver.stop();
  await pump;
  assert.equal(results.length, 1, `exactly one result for the turn (got ${results.length})`);
});

test('driver: empty/chrome assistant lines are NOT surfaced (footer-hint filter)', async () => {
  const pty = new FakePty();
  const driver = new PtySessionDriver({ spawnFn: fakeSpawn(pty), skipPreTrust: true });
  const assistantTexts: string[] = [];
  const iter = driver.start({ onPermission: allow, cwd: 'x' })[Symbol.asyncIterator]();
  const pump = (async () => {
    for (let r = await iter.next(); !r.done; r = await iter.next()) {
      if (r.value.kind === 'assistant' && r.value.text) assistantTexts.push(r.value.text);
    }
  })();
  // a real reply line + a footer-hint chrome line
  pty.emit('Here is the answer you asked for.\n');
  pty.emit('gh auth login · ← for agents⧉ In analyse.md  /effort\n');
  await new Promise((r) => setTimeout(r, 20));
  await driver.stop();
  await pump;
  assert.ok(
    assistantTexts.some((t) => t.includes('answer you asked for')),
    'the real reply line surfaced',
  );
  assert.ok(
    !assistantTexts.some((t) => t.includes('gh auth login') || t.includes('for agents')),
    `footer-hint chrome filtered (got ${JSON.stringify(assistantTexts)})`,
  );
});

test('driver: send() before start throws; health reflects state', async () => {
  const driver = new PtySessionDriver({ spawnFn: fakeSpawn(new FakePty()), skipPreTrust: true });
  await assert.rejects(() => driver.send({ text: 'hi' }), /not started/);
  assert.equal(driver.health().running, false);
  assert.equal(driver.health().detail, 'pty-session-driver');
});

test('parser: TRUST GATE frame is recognizable (for the keystroke fallback)', () => {
  // The driver pre-trusts via settings; but the gate text must be detectable for
  // the fresh-dir fallback. We assert the marker is present in the stripped text.
  const clean = stripAnsi(TRUST_GATE_FRAME);
  assert.match(clean, /Is this a project you created or one you trust/);
  assert.match(clean, /1\.\s*Yes, I trust this folder/);
});
