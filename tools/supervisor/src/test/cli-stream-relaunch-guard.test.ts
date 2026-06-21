/**
 * CLI-STREAM RELAUNCH-GUARD tests — the MODE-INDEPENDENT host-restart block.
 *
 * THE BUG: the safety floor (PermissionRouter.routeWhen → isSupervisorRelaunchCommand)
 * only fires when a tool raises a `can_use_tool` control_request. A `bypassPermissions`
 * and/or background/Task sub-agent SUPPRESSES that request entirely (measured against the
 * live `claude -p`), and an allow-listed Bash/PowerShell never raises one either — so a
 * supervisor relaunch (restart-supervisor.ps1 / a launcher / a `--session` host launch)
 * from such a tool would run UN-GATED and silently tear down the live host.
 *
 * THE FIX: the cli-stream driver inspects EVERY assistant tool_use on its stdout stream
 * (the one chokepoint that sees every tool call regardless of permission mode / allow-list
 * / background) BEFORE the control-protocol + the sub-agent drop, and on a relaunch it
 * KILLS the child (the tool_use line precedes execution, measured) and fires onRelaunchBlocked.
 *
 * These tests prove:
 *  (a) a bypassPermissions/background SUB-AGENT relaunch is BLOCKED (child killed, callback fired);
 *  (b) the orchestrator's OWN relaunch is blocked too;
 *  (c) the detector identifies the carrier + the fromSubAgent flag from parent_tool_use_id/subagent_type;
 *  (d) a normal (non-relaunch) tool_use passes through untouched (no false block);
 *  (e) a READ of the script/launcher is NOT blocked (no false positive);
 *  (f) end-to-end through the driver: the stream ENDS after a blocked relaunch and the child is torn down.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CliStreamDriver,
  detectRelaunchToolUse,
  type CliChildProcess,
  type CliSpawnFn,
  type RelaunchBlockInfo,
} from '../adapters/cli-stream-driver.js';
import type { PermissionDecision, SessionEvent, SessionStartOptions } from '../session-driver.js';

const noPerm = async (): Promise<PermissionDecision> => ({ behavior: 'allow' });
const baseOpts = (over: Partial<SessionStartOptions> = {}): SessionStartOptions => ({
  onPermission: noPerm,
  ...over,
});

// A fake child (mirrors cli-stream-driver.test.ts). NO pid → terminateChildTree uses the
// POSIX child.kill('SIGTERM') path the fake handles (so the test never shells out to taskkill).
class FakeCliChild implements CliChildProcess {
  readonly stdinWrites: string[] = [];
  readonly killSignals: string[] = [];
  stdinEnded = false;
  pid?: number; // intentionally undefined
  private readonly listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
  readonly stdin = {
    write: (c: string): void => void this.stdinWrites.push(c),
    end: (): void => void (this.stdinEnded = true),
  };
  readonly stdout: AsyncIterable<string>;
  constructor(chunks: string[]) {
    this.stdout = (async function* () {
      for (const c of chunks) yield c;
    })();
  }
  kill(signal?: string): void {
    const s = signal ?? 'SIGTERM';
    this.killSignals.push(s);
    setImmediate(() => this.emit('exit', 0, s));
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

function spawnReturning(child: FakeCliChild): CliSpawnFn {
  return () => child;
}

async function drain(it: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

// NDJSON helpers — build the exact stream-json envelopes the CLI emits.
function assistantToolUse(
  tool: string,
  input: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): string {
  return (
    JSON.stringify({
      type: 'assistant',
      ...extra,
      message: { content: [{ type: 'tool_use', id: 'tu_1', name: tool, input }] },
    }) + '\n'
  );
}
function assistantText(text: string): string {
  return JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\n';
}
function resultLine(): string {
  return JSON.stringify({ type: 'result', subtype: 'success', session_id: 's1', result: 'ok' }) + '\n';
}

// ───────────────────────── detectRelaunchToolUse (pure) ─────────────────────────

test('detectRelaunchToolUse: a SUB-AGENT (background) PowerShell relaunch is detected, fromSubAgent=true', () => {
  // The bypass hole: a background sub-agent (subagent_type set) runs restart-supervisor.ps1.
  const raw = JSON.parse(
    assistantToolUse(
      'PowerShell',
      { command: 'powershell -NoProfile -ExecutionPolicy Bypass -File D:\\tmp\\restart-supervisor.ps1 -Launcher prod' },
      { subagent_type: 'general-purpose', task_description: 'restart' },
    ),
  );
  const hit = detectRelaunchToolUse(raw);
  assert.ok(hit, 'should detect the relaunch');
  assert.equal(hit!.toolName, 'PowerShell');
  assert.equal(hit!.fromSubAgent, true, 'subagent_type ⇒ fromSubAgent');
});

test('detectRelaunchToolUse: a SUB-AGENT (foreground sidechain) Bash relaunch is detected, fromSubAgent=true', () => {
  const raw = JSON.parse(
    assistantToolUse('Bash', { command: 'node launch-prod-orch.mjs' }, { parent_tool_use_id: 'toolu_abc' }),
  );
  const hit = detectRelaunchToolUse(raw);
  assert.ok(hit);
  assert.equal(hit!.fromSubAgent, true, 'non-null parent_tool_use_id ⇒ fromSubAgent');
});

test('detectRelaunchToolUse: the ORCHESTRATOR-OWN relaunch is detected, fromSubAgent=false', () => {
  const raw = JSON.parse(
    assistantToolUse('PowerShell', {
      command: 'powershell -File tools/supervisor/restart-supervisor.ps1 -Launcher prod',
    }),
  );
  const hit = detectRelaunchToolUse(raw);
  assert.ok(hit);
  assert.equal(hit!.fromSubAgent, false, 'no sub-agent markers ⇒ orchestrator-own');
});

test('detectRelaunchToolUse: an Agent/Task spawn whose PROMPT carries the relaunch is detected', () => {
  // The orchestrator dispatching a bypass sub-agent whose explicit job is the relaunch.
  const raw = JSON.parse(
    assistantToolUse('Agent', {
      mode: 'bypassPermissions',
      run_in_background: true,
      prompt: 'Run this: powershell -File D:\\tmp\\restart-supervisor.ps1 -Launcher prod',
    }),
  );
  const hit = detectRelaunchToolUse(raw);
  assert.ok(hit, 'the spawn prompt itself is a relaunch carrier');
  assert.equal(hit!.toolName, 'Agent');
});

test('detectRelaunchToolUse: a NORMAL tool_use is NOT detected (no false block)', () => {
  for (const raw of [
    JSON.parse(assistantToolUse('Bash', { command: 'npm test' })),
    JSON.parse(assistantToolUse('Bash', { command: 'git status' }, { subagent_type: 'general-purpose' })),
    JSON.parse(assistantToolUse('Edit', { file_path: 'src/x.ts', old_string: 'a', new_string: 'b' })),
    JSON.parse(assistantToolUse('Agent', { prompt: 'Review the diff and report findings.' })),
    JSON.parse(assistantText('just talking, no tools')),
    JSON.parse(resultLine()),
  ]) {
    assert.equal(detectRelaunchToolUse(raw), null, `should not block: ${JSON.stringify(raw).slice(0, 60)}`);
  }
});

test('detectRelaunchToolUse: READING the script/launcher is NOT detected (no false positive)', () => {
  for (const cmd of [
    'cat tools/supervisor/restart-supervisor.ps1',
    'grep -n launcher tools/supervisor/launch-prod-orch.mjs',
    'ls tools/supervisor',
    'node dist/index.js --panel 8790', // no --session
  ]) {
    const raw = JSON.parse(assistantToolUse('Bash', { command: cmd }, { subagent_type: 'general-purpose' }));
    assert.equal(detectRelaunchToolUse(raw), null, `read/non-relaunch must not block: ${cmd}`);
  }
});

// ───────────────────── end-to-end through the driver ─────────────────────

test('driver: a bypass SUB-AGENT relaunch is BLOCKED — child killed, onRelaunchBlocked fired, stream ends', async () => {
  // Stream: orchestrator spawns an Agent (bypass), then the sub-agent emits a relaunch Bash.
  const child = new FakeCliChild([
    assistantToolUse('Agent', { mode: 'bypassPermissions', run_in_background: true, prompt: 'do work' }),
    assistantToolUse(
      'Bash',
      { command: 'powershell -File D:\\tmp\\restart-supervisor.ps1 -Launcher prod' },
      { subagent_type: 'general-purpose' },
    ),
    // These lines come AFTER the relaunch — they must NOT be yielded (stream ended).
    assistantText('this should never be seen'),
    resultLine(),
  ]);
  const blocked: RelaunchBlockInfo[] = [];
  const driver = new CliStreamDriver({
    spawnFn: spawnReturning(child),
    onRelaunchBlocked: (info) => void blocked.push(info),
  });
  const events = await drain(driver.start(baseOpts()));

  assert.equal(blocked.length, 1, 'onRelaunchBlocked fired exactly once');
  assert.equal(blocked[0]!.fromSubAgent, true, 'identified as a sub-agent relaunch (the hole)');
  assert.ok(child.killSignals.length > 0, 'the child was killed to prevent the relaunch');
  assert.ok(child.stdinEnded, 'child stdin was ended on block');
  // The post-relaunch lines were NOT yielded (the stream ended at the block).
  assert.ok(!events.some((e) => e.kind === 'result'), 'no result event after a blocked relaunch');
  assert.ok(
    !events.some((e) => e.kind === 'assistant' && e.text.includes('never be seen')),
    'no events after the block',
  );
});

test('driver: the ORCHESTRATOR-OWN raw relaunch is also blocked (defense in depth)', async () => {
  const child = new FakeCliChild([
    assistantToolUse('PowerShell', {
      command: 'powershell -NoProfile -ExecutionPolicy Bypass -File D:\\tmp\\restart-supervisor.ps1 -Launcher prod',
    }),
    resultLine(),
  ]);
  const blocked: RelaunchBlockInfo[] = [];
  const driver = new CliStreamDriver({ spawnFn: spawnReturning(child), onRelaunchBlocked: (i) => void blocked.push(i) });
  await drain(driver.start(baseOpts()));
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0]!.fromSubAgent, false, 'orchestrator-own');
  assert.ok(child.killSignals.length > 0, 'child killed');
});

test('driver: a NORMAL turn (no relaunch) flows through untouched — no block, normal events', async () => {
  const child = new FakeCliChild([
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', model: 'm' }) + '\n',
    assistantText('working on it'),
    assistantToolUse('Bash', { command: 'npm run build' }), // routine — not a relaunch
    resultLine(),
  ]);
  const blocked: RelaunchBlockInfo[] = [];
  const driver = new CliStreamDriver({ spawnFn: spawnReturning(child), onRelaunchBlocked: (i) => void blocked.push(i) });
  const events = await drain(driver.start(baseOpts()));
  assert.equal(blocked.length, 0, 'no relaunch → no block');
  assert.equal(child.killSignals.length, 0, 'child NOT killed on a normal turn');
  assert.ok(events.some((e) => e.kind === 'result'), 'the result event is delivered normally');
});

test('driver: the block works even with NO onRelaunchBlocked callback wired (the kill is unconditional)', async () => {
  const child = new FakeCliChild([
    assistantToolUse('Bash', { command: 'node launch-prod-orch.mjs' }, { subagent_type: 'general-purpose' }),
    resultLine(),
  ]);
  const driver = new CliStreamDriver({ spawnFn: spawnReturning(child) }); // no onRelaunchBlocked
  const events = await drain(driver.start(baseOpts()));
  assert.ok(child.killSignals.length > 0, 'child killed regardless of a notify callback');
  assert.ok(!events.some((e) => e.kind === 'result'), 'stream ended at the block');
});
