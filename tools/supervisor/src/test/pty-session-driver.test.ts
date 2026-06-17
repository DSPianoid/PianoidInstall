/**
 * PtySessionDriver tests (A-variant: the @xterm/headless GRID path) — with a FakePty
 * (no real node-pty, no subprocess, no network) feeding render frames captured
 * VERBATIM from the 2026-06-15 probes through the REAL @xterm/headless grid the
 * driver uses in production. Asserts:
 *   - frames → the right SessionEvents (system_init / assistant / tool_result / result)
 *   - CLEAN assistant-text extraction (the marker reply, ZERO footer chrome on the row)
 *   - a permission-prompt frame → router consulted + the right keystroke (1\r / Esc)
 *   - the trust pre-set writes the exact ~/.claude.json key (forward-slash, case-sensitive)
 *   - send() types text + submit key; interrupt() sends Esc
 *
 * The grid reads on a debounce, so the driver tests feed a frame then wait > settleMs.
 * Frames use \r\n (a terminal needs CR to return to column 0).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { permissionFromHeader, stripAnsi } from '../adapters/pty-render-parser.js';
import {
  PtySessionDriver,
  preTrustProject,
  normalizeProjectKey,
  filterSpawnableMcpServers,
  type PtyProcess,
  type PtySpawnFn,
} from '../adapters/pty-session-driver.js';
import type { PermissionDecision, PermissionHandler, SessionEvent } from '../session-driver.js';
import { isDestructiveShellCommand } from '../profiles.js';
import { GridScreen } from '../adapters/pty-grid.js';

// The EXACT pre-allow predicate index.ts wires for the orchestrator profile: auto-allow
// the $() gate iff the underlying shell command is NOT destructive.
const orchestratorAutoAllowSubexpr = (toolName: string, input: Record<string, unknown>): boolean => {
  if (toolName !== 'Bash' && toolName !== 'PowerShell') return false;
  const cmd = String((input['command'] ?? input['cmd'] ?? '') as string);
  return !isDestructiveShellCommand(cmd);
};

const CRLF = '\r\n';
const lines = (...ls: string[]): string => ls.join(CRLF) + CRLF;

// ── verbatim probe captures (the pinned fixtures), CRLF for the grid ─────────
const BOOT_FRAME = lines(
  '────────────',
  ' Claude Code v2.1.177',
  ' Opus 4.8 (1M context) · Claude Max',
  ' D:\\repos\\PianoidInstall',
  '────────────',
  '❯ Try "refactor <filepath>"',
  '  ? for shortcuts',
);

// the assistant reply on its OWN row ("● <text>"), with the footer hint bar BELOW
// it on different rows — exactly the geometry the grid separates (option-A proof).
const REPLY_FRAME = lines(
  ' Claude Code v2.1.177',
  ' Haiku 4.5 · Claude Max',
  ' D:\\repos\\PianoidInstall',
  '❯ Reply with exactly: GRID-OK-42',
  '● GRID-OK-42',
  '────────────────────────────────────────',
  '❯ ',
  '────────────────────────────────────────',
  '  gh auth login · ← for agents          ⧉ In analyse.md',
);

const TOOL_FRAME = lines(
  '● Bash(echo hi)',
  '  ⎿  hi',
  '────────────────────────────────────────',
  '❯ ',
  '  ? for shortcuts',
);

const PERMISSION_FRAME = lines(
  '────────────',
  ' Create file',
  ' probe_marker.txt',
  '╌╌╌╌╌╌╌╌╌╌╌╌',
  '  1 PROBE-OK-98765',
  '╌╌╌╌╌╌╌╌╌╌╌╌',
  ' Do you want to create probe_marker.txt?',
  ' ❯ 1. Yes',
  '   2. Yes, allow all edits during this session (shift+tab)',
  '   3. No',
  ' Esc to cancel · Tab to amend',
);

const TRUST_GATE_FRAME = lines(
  ' Quick safety check: Is this a project you created or one you trust?',
  ' ❯ 1. Yes, I trust this folder',
  '   2. No, exit',
  ' Enter to confirm · Esc to cancel',
);

// The $() COMMAND-SUBSTITUTION SECURITY GATE — fires even when Bash is allow-listed.
// A ROUTINE (non-destructive) one: the orchestrator's startup repo-health probe.
const SUBEXPR_GATE_ROUTINE = lines(
  '● Bash(echo "count=$(git rev-list --count HEAD)")',
  '────────────',
  ' Command contains subexpressions $()',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. Yes, don’t ask again',
  '   3. No',
  ' Esc to cancel',
);

// A DESTRUCTIVE $() gate — must STILL route (the safety floor), never auto-allowed.
const SUBEXPR_GATE_DESTRUCTIVE = lines(
  '● Bash(git push origin $(git branch --show-current))',
  '────────────',
  ' Command contains subexpressions $()',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. Yes, don’t ask again',
  '   3. No',
  ' Esc to cancel',
);

// ── FakePty: scriptable {onData,write,kill} double (buffers pre-onData emits) ──
class FakePty implements PtyProcess {
  private dataCb: ((d: string) => void) | null = null;
  private exitCb: ((e: { exitCode: number }) => void) | null = null;
  private buffered: string[] = [];
  readonly writes: string[] = [];
  onData(cb: (d: string) => void): void {
    this.dataCb = cb;
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
  emit(frame: string): void {
    if (this.dataCb) this.dataCb(frame);
    else this.buffered.push(frame);
  }
}
function fakeSpawn(
  pty: FakePty,
  capture?: (file: string, args: string[], opts?: { cwd: string }) => void,
): PtySpawnFn {
  return (file, args, opts) => {
    capture?.(file, args, opts as { cwd: string });
    return pty;
  };
}
const allow = async (): Promise<PermissionDecision> => ({ behavior: 'allow' });
const SETTLE = 30; // ms — the test driver's debounce (fast for tests)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Start a grid driver on a FakePty, return the driver + a drained-events array. */
function startDriver(
  pty: FakePty,
  onPermission: PermissionHandler = allow,
  opts: Partial<ConstructorParameters<typeof PtySessionDriver>[0]> = {},
): { driver: PtySessionDriver; events: SessionEvent[]; pump: Promise<void> } {
  const driver = new PtySessionDriver({ spawnFn: fakeSpawn(pty), skipPreTrust: true, settleMs: SETTLE, submitDelayMs: 5, ...opts });
  const events: SessionEvent[] = [];
  const iter = driver.start({ onPermission, cwd: 'D:/repos/PianoidInstall' })[Symbol.asyncIterator]();
  const pump = (async () => {
    for (let r = await iter.next(); !r.done; r = await iter.next()) events.push(r.value);
  })();
  return { driver, events, pump };
}

// A minimal IDLE input-box frame (boot-ready) — establishes grid.isInputReady() so the
// turn QUEUE (#5) types the next turn. The real TUI renders this input box at boot and
// after each turn; tests emit it before a send() so the queued turn is actually typed.
const IDLE_INPUT = lines('────────────', '❯ Try "refactor <filepath>"', '  ? for shortcuts');
/** Make the driver input-ready (emit the idle input box + let it settle), then send a turn. */
async function readyAndSend(pty: FakePty, driver: PtySessionDriver, text: string): Promise<void> {
  pty.emit(IDLE_INPUT);
  await sleep(SETTLE + 20); // grid settles → isInputReady() true
  await driver.send({ text }); // enqueues; drainQueue types it now (input box idle)
  await sleep(20); // let the drain type + submit
}

// ── pure helper tests (the surviving pty-render-parser exports) ──────────────
test('permissionFromHeader maps verbs/actions to tools', () => {
  assert.deepEqual(permissionFromHeader('create', 'a.txt', 'Create file'), { toolName: 'Write', input: { file_path: 'a.txt' } });
  assert.deepEqual(permissionFromHeader('edit', 'b.ts', 'Edit file'), { toolName: 'Edit', input: { file_path: 'b.ts' } });
  assert.deepEqual(permissionFromHeader('run', 'ls -la', 'Run command'), { toolName: 'Bash', input: { command: 'ls -la' } });
});
test('stripAnsi removes escape sequences', () => {
  assert.equal(stripAnsi('\x1b[1m\x1b[32mhi\x1b[0m'), 'hi');
});

// ── pre-trust unit test ──────────────────────────────────────────────────────
test('preTrustProject writes the exact forward-slash key', () => {
  const f = join(tmpdir(), `claude-json-test-${Date.now()}.json`);
  writeFileSync(f, JSON.stringify({ projects: {} }));
  try {
    assert.equal(preTrustProject(f, 'D:\\repos\\PianoidInstall'), true);
    const j = JSON.parse(readFileSync(f, 'utf8')) as { projects: Record<string, { hasTrustDialogAccepted?: boolean }> };
    assert.equal(normalizeProjectKey('D:\\repos\\PianoidInstall'), 'D:/repos/PianoidInstall');
    assert.equal(j.projects['D:/repos/PianoidInstall']!.hasTrustDialogAccepted, true);
    assert.equal(j.projects['D:\\repos\\PianoidInstall'], undefined);
  } finally {
    rmSync(f, { force: true });
  }
});

// ── grid driver tests (real @xterm/headless) ─────────────────────────────────
test('driver: BOOT frame → system_init with model', async () => {
  const pty = new FakePty();
  const { driver, events, pump } = startDriver(pty);
  pty.emit(BOOT_FRAME);
  await sleep(SETTLE + 40);
  await driver.stop();
  await pump;
  const init = events.find((e) => e.kind === 'system_init') as Extract<SessionEvent, { kind: 'system_init' }>;
  assert.ok(init, 'system_init emitted');
  assert.match(init.model ?? '', /Opus/);
});

test('driver: ★ grid extracts CLEAN assistant text (marker reply, ZERO footer chrome)', async () => {
  const pty = new FakePty();
  const { driver, events, pump } = startDriver(pty);
  await driver.send({ text: 'Reply with exactly: GRID-OK-42' });
  pty.emit(REPLY_FRAME);
  await sleep(SETTLE + 60);
  await driver.stop();
  await pump;
  const texts = events.filter((e): e is Extract<SessionEvent, { kind: 'assistant' }> => e.kind === 'assistant' && !!e.text).map((e) => e.text);
  // the assistant reply reached an assistant event, CLEAN (just the marker)
  assert.ok(texts.some((t) => t.includes('GRID-OK-42')), `marker reached assistant text (got ${JSON.stringify(texts)})`);
  // and NO footer chrome leaked into any assistant text
  assert.ok(!texts.some((t) => /gh auth login|for agents|⧉ In/.test(t)), `no chrome in assistant text (got ${JSON.stringify(texts)})`);
  // the input-echo line ("❯ Reply…") is NOT surfaced as assistant text
  assert.ok(!texts.some((t) => /^❯|Reply with exactly:/.test(t.trim())), 'input echo not surfaced');
});

test('driver: grid extracts a tool indicator + tool-result row', async () => {
  const pty = new FakePty();
  const { driver, events, pump } = startDriver(pty);
  await driver.send({ text: 'run echo' });
  pty.emit(TOOL_FRAME);
  await sleep(SETTLE + 60);
  await driver.stop();
  await pump;
  const toolUse = events.find((e) => e.kind === 'assistant' && (e as { toolUses?: unknown[] }).toolUses?.length) as Extract<SessionEvent, { kind: 'assistant' }>;
  assert.ok(toolUse, 'assistant toolUse emitted');
  assert.equal(toolUse.toolUses[0]!.name, 'Bash');
  const tr = events.find((e) => e.kind === 'tool_result') as Extract<SessionEvent, { kind: 'tool_result' }>;
  assert.ok(tr, 'tool_result emitted');
  assert.match(tr.content, /hi/);
});

test('driver: permission prompt (grid-detected) → router consulted → "1\\r" on allow', async () => {
  const pty = new FakePty();
  const routedBox: { v: { toolName: string; input: Record<string, unknown> } | null } = { v: null };
  const { driver, pump } = startDriver(pty, async (req): Promise<PermissionDecision> => {
    routedBox.v = { toolName: req.toolName, input: req.input };
    return { behavior: 'allow' };
  });
  pty.emit(PERMISSION_FRAME);
  await sleep(SETTLE + 60);
  await driver.stop();
  await pump;
  assert.ok(routedBox.v, 'router was consulted');
  assert.equal(routedBox.v!.toolName, 'Write');
  assert.equal(routedBox.v!.input['file_path'], 'probe_marker.txt');
  assert.ok(pty.writes.includes('1\r'), `allow keystroke "1\\r" written (writes=${JSON.stringify(pty.writes)})`);
});

test('driver: permission deny (grid-detected) → Esc keystroke', async () => {
  const pty = new FakePty();
  const { driver, pump } = startDriver(pty, async () => ({ behavior: 'deny', message: 'no' }));
  pty.emit(PERMISSION_FRAME);
  await sleep(SETTLE + 60);
  await driver.stop();
  await pump;
  assert.ok(pty.writes.includes('\x1b'), `deny → Esc written (writes=${JSON.stringify(pty.writes)})`);
});

test('driver: ★ $() gate PRE-ALLOW — routine command auto-answers "1\\r" WITHOUT routing', async () => {
  const pty = new FakePty();
  const routedBox: { v: unknown | null } = { v: null };
  const { driver, pump } = startDriver(
    pty,
    async (req): Promise<PermissionDecision> => {
      routedBox.v = req; // should NOT be consulted for a routine $() gate
      return { behavior: 'allow' };
    },
    { autoAllowSubexpr: orchestratorAutoAllowSubexpr },
  );
  pty.emit(SUBEXPR_GATE_ROUTINE);
  await sleep(SETTLE + 60);
  await driver.stop();
  await pump;
  assert.equal(routedBox.v, null, 'router NOT consulted (pre-allowed, no operator click)');
  assert.ok(pty.writes.includes('1\r'), `auto-allow keystroke "1\\r" written (writes=${JSON.stringify(pty.writes)})`);
});

test('driver: ★ $() gate SAFETY FLOOR — destructive command STILL routes (not auto-allowed)', async () => {
  const pty = new FakePty();
  const routedBox: { v: { toolName: string; input: Record<string, unknown> } | null } = { v: null };
  const { driver, pump } = startDriver(
    pty,
    async (req): Promise<PermissionDecision> => {
      routedBox.v = { toolName: req.toolName, input: req.input };
      return { behavior: 'deny', message: 'destructive' };
    },
    { autoAllowSubexpr: orchestratorAutoAllowSubexpr },
  );
  pty.emit(SUBEXPR_GATE_DESTRUCTIVE);
  await sleep(SETTLE + 60);
  await driver.stop();
  await pump;
  assert.ok(routedBox.v, 'destructive $() command was ROUTED (safety floor), not auto-allowed');
  assert.match(String(routedBox.v!.input['command'] ?? ''), /git push/);
  // routed + denied → Esc, NOT an auto "1\r"
  assert.ok(pty.writes.includes('\x1b'), `routed-deny → Esc written (writes=${JSON.stringify(pty.writes)})`);
});

test('driver: $() gate with NO autoAllowSubexpr (demo) → routes like any prompt', async () => {
  const pty = new FakePty();
  const routedBox: { v: unknown | null } = { v: null };
  const { driver, pump } = startDriver(pty, async (req): Promise<PermissionDecision> => {
    routedBox.v = req;
    return { behavior: 'allow' };
  }); // no autoAllowSubexpr option
  pty.emit(SUBEXPR_GATE_ROUTINE);
  await sleep(SETTLE + 60);
  await driver.stop();
  await pump;
  assert.ok(routedBox.v, 'with no pre-allow predicate, the $() gate ROUTES (safe default)');
});

test('driver: trust gate (grid-detected) → Enter keystroke (fresh-dir fallback)', async () => {
  const pty = new FakePty();
  const { driver, pump } = startDriver(pty);
  pty.emit(TRUST_GATE_FRAME);
  await sleep(SETTLE + 60);
  await driver.stop();
  await pump;
  assert.ok(pty.writes.includes('\r'), `trust gate → Enter written (writes=${JSON.stringify(pty.writes)})`);
});

test('driver: turn-complete is STRICT + de-duped — real answer + stable idle → at most ONE result', async () => {
  const pty = new FakePty();
  // turnCompleteStableNeeded=2 for a fast test; the answer + idle must persist across reads.
  const { driver, events, pump } = startDriver(pty, allow, { turnCompleteStableNeeded: 2 });
  await readyAndSend(pty, driver, 'hi');
  // a real assistant ANSWER + the idle input box (no spinner) — the genuine end.
  const doneFrame = lines('● Done. Here is the answer.', '────────────', '❯ Try "x"', '  ? for shortcuts');
  pty.emit(doneFrame);
  await sleep(SETTLE + 30); // read 1: streak 1
  pty.emit(doneFrame); // a repaint of the same idle state
  await sleep(SETTLE + 30); // read 2: streak 2 → fires ONE result
  pty.emit(doneFrame);
  await sleep(SETTLE + 30); // read 3: already emitted, no second result
  await driver.stop();
  await pump;
  const results = events.filter((e) => e.kind === 'result');
  assert.equal(results.length, 1, `exactly one result for the turn (got ${results.length})`);
  assert.ok((results[0] as { result?: string }).result?.includes('Done. Here is the answer'), 'result carries the real answer');
});

test('driver: ★ FAST reply that goes SILENT still fires ONE result (self-reschedule; the "reply never reaches the bot" bug)', async () => {
  // THE LIVE BUG: a quick reply finishes and the TUI STOPS repainting before N settled
  // reads accumulate. readGrid was only driven by incoming PTY data (ingest), so the
  // streak stalled < N → no result → nothing forwarded to the channel → user silence.
  // The driver must POLL the settled grid itself until the streak latches, even with NO
  // further data. Here: emit the completed reply ONCE, then send NO more data.
  const pty = new FakePty();
  const { driver, events, pump } = startDriver(pty, allow, { turnCompleteStableNeeded: 3 });
  await readyAndSend(pty, driver, 'Hi');
  // a complete fast reply + a lingering "Cooked for Ns" completion marker + idle input —
  // exactly the live end-state. Emitted ONCE; then the TUI is SILENT.
  pty.emit(
    lines(
      '● Hi! Orchestrator is up. Standing by.',
      '· Cascading… (6s · ↓ 150 tokens)',
      '────────────',
      '❯ ',
      '────────────',
      '  gh auth login · esc to interrupt',
      '✻ Cooked for 7s',
      '────────────',
      '❯ ',
      '  gh auth login · ← for agents',
    ),
  );
  // wait LONG ENOUGH for several SELF-rescheduled reads (3 × settleMs) WITHOUT any new data.
  await sleep(SETTLE * 6 + 80);
  await driver.stop();
  await pump;
  const results = events.filter((e) => e.kind === 'result');
  assert.equal(results.length, 1, `the fast reply fired exactly ONE result despite the TUI going silent (got ${results.length})`);
  assert.ok((results[0] as { result?: string }).result?.includes('Orchestrator is up'), 'result carries the fast reply text');
});

test('driver: ★ two DIFFERENT consecutive turns yield two DIFFERENT answers (the stale byte-identical resend bug)', async () => {
  // THE LIVE BUG: turn 2 ("What MCP tools") re-sent turn 1's answer ("Describe env") BYTE-
  // IDENTICAL because, when turn 2's turn-complete latched, the buffer STILL showed turn 1's
  // answer as the last "●" block (turn 2's answer hadn't rendered yet) → currentAnswerText()
  // returned the STALE prior answer. Fix: markTurnStart() snapshots the prior answer; the
  // turn isn't complete until a DIFFERENT (current-turn) answer appears.
  // The @xterm headless terminal APPENDS on write (it doesn't repaint a viewport like a real
  // TUI), so we drive a clean grid directly to assert the GUARD: currentTurnAnswer() must not
  // return the prior turn's answer after markTurnStart(). (The driver wires markTurnStart in
  // send() + uses currentTurnAnswer for the result.)
  const g = new GridScreen({ cols: 80, rows: 20 });
  await g.init();
  const rule = '─'.repeat(60); // full-width rule (Claude Code fences the footer with these)
  const idle = `\r\n${rule}\r\n❯ \r\n${rule}\r\n  gh auth login · ← for agents\r\n`;
  // turn 1's answer is on screen and was emitted as turn 1's result.
  g.write('● ANSWER ALPHA about the environment' + idle + '✻ Brewed for 5s\r\n');
  await sleep(25);
  const turn1 = g.currentAnswerText();
  assert.ok(turn1 && turn1.includes('ALPHA') && !turn1.includes('────'), `turn 1 answer is ALPHA, no rule-row chrome (got ${JSON.stringify(turn1)})`);

  // turn 2 SUBMITS — snapshot the prior (ALPHA) as baseline. The buffer STILL shows ALPHA.
  g.markTurnStart();
  // ★ before turn 2's own answer renders, currentTurnAnswer() must NOT return ALPHA (the stale
  // resend) — it must be undefined → isTurnComplete() false → the turn keeps waiting.
  assert.equal(g.currentTurnAnswer(), undefined, 'while only the prior answer is on screen, the current-turn answer is undefined (no stale resend)');
  assert.equal(g.isTurnComplete(), false, 'a stale prior answer does NOT count as turn-complete');

  // turn 2's REAL answer renders → currentTurnAnswer() = BRAVO, isTurnComplete true.
  g.write('● ANSWER BRAVO about the mcp tools' + idle + '✻ Brewed for 6s\r\n');
  await sleep(25);
  const turn2 = g.currentTurnAnswer();
  assert.ok(turn2 && turn2.includes('BRAVO'), `turn 2 answer is BRAVO (got ${JSON.stringify(turn2)})`);
  assert.notEqual(turn1, turn2, 'turn 2 answer DIFFERS from turn 1 (no byte-identical resend)');
  assert.equal(g.isTurnComplete(), true, 'with the new answer present, the turn IS complete');
  g.dispose();
});

// A COMPLETED-turn frame in the real TUI geometry: the "●" answer, the past-tense
// completion summary, then the footer block with the idle input box LAST.
const completedTurn = (answer: string, secs: number): string =>
  lines('● ' + answer, '✻ Brewed for ' + secs + 's', '────────────', '❯ ', '────────────', '  gh auth login · ← for agents');
// An IDLE footer with NO new "●" answer block — the input box is ready + no spinner, but
// the prior turn's answer is still the last "●" in the buffer (the stale window).
const idleNoNewAnswer = lines('✻ Brewed for 9s', '────────────', '❯ ', '────────────', '  gh auth login · ← for agents');

test('driver: ★ turn-2 result is the NEW answer once it renders, never the stale prior one (streak path picks currentTurnAnswer)', async () => {
  // The grid-guard (currentTurnAnswer() undefined while stale) + the driver picking
  // currentTurnAnswer() on the streak path together guarantee turn 2's result is its OWN
  // answer. @xterm APPENDS, so turn-1's answer stays in the buffer when turn-2 completes —
  // the live race condition. The driver must NOT emit a stale result in the window where
  // only the prior answer is on screen, and must emit BRAVO once it renders.
  const pty = new FakePty();
  const { driver, events, pump } = startDriver(pty, allow, { turnCompleteStableNeeded: 3 });

  // ── Turn 1: ALPHA renders + completes → result #1 = ALPHA.
  await readyAndSend(pty, driver, 'Describe your environment');
  pty.emit(completedTurn('ANSWER ALPHA about the environment', 5));
  await sleep(SETTLE * 6 + 80);
  let results = events.filter((e) => e.kind === 'result') as { result?: string }[];
  assert.equal(results.length, 1, 'turn 1 produced exactly one result');
  assert.ok(results[0]!.result?.includes('ALPHA'), 'turn 1 result is ALPHA');

  // ── Turn 2: SUBMIT (markTurnStart snapshots ALPHA as the baseline). The buffer STILL
  //    shows ALPHA (turn 1's completed frame left the input box idle → the queued turn 2
  //    types now). Render an IDLE footer (input box ready, no spinner) with NO new "●"
  //    block yet — the stale window. The driver must NOT emit a 2nd result here (the
  //    streak can't latch: currentTurnAnswer() is undefined while ALPHA is stale).
  await driver.send({ text: 'What MCP tools do you have?' });
  await sleep(20);
  pty.emit(idleNoNewAnswer);
  await sleep(SETTLE * 6 + 80);
  results = events.filter((e) => e.kind === 'result') as { result?: string }[];
  assert.equal(results.length, 1, 'turn 2 did NOT emit a stale result while only ALPHA is on screen (no byte-identical resend)');

  // ── Turn 2's REAL answer (BRAVO) renders → result #2 = BRAVO, never the stale ALPHA.
  pty.emit(completedTurn('ANSWER BRAVO about the mcp tools', 6));
  await sleep(SETTLE * 6 + 80);
  await driver.stop();
  await pump;
  results = events.filter((e) => e.kind === 'result') as { result?: string }[];
  assert.equal(results.length, 2, 'turn 2 emitted its result once BRAVO rendered');
  assert.ok(results[1]!.result?.includes('BRAVO'), `turn 2 result is BRAVO (got ${JSON.stringify(results[1]!.result)})`);
  assert.ok(!results[1]!.result?.includes('ALPHA'), 'turn 2 result does NOT contain the stale ALPHA');
});

test('driver: ★★ the ANTI-HANG fallback emits EMPTY, never the stale prior answer (the seq-221 byte-identical-resend bug)', async () => {
  // ★ THE HEADLINE BUG (capture seq 221): turn 2 went idle with NO new "●" answer block
  // (its answer never rendered cleanly / it produced none), so currentTurnAnswer() stayed
  // undefined → the streak could never latch → the bounded ANTI-HANG fallback fired. The
  // OLD code then emitted currentAnswerText() = the PRIOR turn's answer (== priorTurnAnswer
  // EXACTLY) → turn 2 re-sent turn 1's 2807-char answer BYTE-IDENTICAL. The FIX (seq-221
  // self-diagnosis #2): the fallback emits EMPTY (the turn completes — no hang — but sends
  // NOTHING; onResult skips empty), never the stale baseline. We force the fallback fast via
  // identicalAnswerFallbackCycles:3 and assert turn 2's result text is EMPTY, NOT ALPHA.
  const pty = new FakePty();
  const { driver, events, pump } = startDriver(pty, allow, {
    turnCompleteStableNeeded: 3,
    identicalAnswerFallbackCycles: 3, // fire the fallback after ~3 settle cycles (fast for the test)
  });

  // ── Turn 1: ALPHA renders + completes → result #1 = ALPHA.
  await readyAndSend(pty, driver, 'Describe your environment');
  pty.emit(completedTurn('ANSWER ALPHA about the environment', 5));
  await sleep(SETTLE * 6 + 80);
  let results = events.filter((e) => e.kind === 'result') as { result?: string }[];
  assert.equal(results.length, 1, 'turn 1 produced exactly one result');
  assert.ok(results[0]!.result?.includes('ALPHA'), 'turn 1 result is ALPHA');

  // ── Turn 2: SUBMIT (turn 1's completed frame left the input box idle → queued turn 2
  //    types now), then ONLY the idle frame with NO new "●" answer — and NEVER a new
  //    answer. After identicalAnswerFallbackCycles settle cycles the anti-hang fallback
  //    fires. OLD code → emits stale ALPHA (the bug). FIXED → emits EMPTY (no resend).
  await driver.send({ text: 'What MCP tools do you have?' });
  await sleep(20);
  pty.emit(idleNoNewAnswer);
  await sleep(SETTLE * 10 + 120); // > identicalAnswerFallbackCycles settle cycles
  await driver.stop();
  await pump;
  results = events.filter((e) => e.kind === 'result') as { result?: string }[];
  assert.equal(results.length, 2, 'turn 2 completed via the anti-hang fallback (no wedge)');
  const turn2Text = results[1]!.result ?? '';
  assert.ok(!turn2Text.includes('ALPHA'), `★ turn 2 did NOT resend the stale ALPHA (got ${JSON.stringify(turn2Text)})`);
  assert.equal(turn2Text, '', 'turn 2 fallback result is EMPTY (sends nothing — never the stale baseline)');
});

test('driver: ★ a fast reply with a pinned "✘ Auto-update failed … /doctor" footer banner STILL fires a result (the subsequent-turn silence bug)', async () => {
  // THE SECOND live bug (a fast FOLLOW-UP turn went silent): when a 2nd claude.exe is
  // running, Claude Code pins "✘ Auto-update failed: claude.exe in use … · Run /doctor"
  // as the BOTTOM footer row. That row isn't footer-ish → regions() stopped the footer
  // walk at it → the input box above was EXCLUDED from footerRows → isInputReady()=false
  // → isTurnComplete() never latched → no result → no forward. Verbatim the live frame.
  const pty = new FakePty();
  const { driver, events, pump } = startDriver(pty, allow, { turnCompleteStableNeeded: 3 });
  await readyAndSend(pty, driver, 'Hi, are you there?');
  pty.emit(
    lines(
      "● Yes — I'm here and ready.",
      '  Orchestrator is up and idle, waiting for a task.',
      '· Unfurling… (6s · ↓ 184 tokens · thought for 1s)',
      '  ⎿  Tip: Use /memory to view and manage Claude memory',
      '────────────',
      '❯ ',
      '────────────',
      '  gh auth login · esc to interrupt',
      '✘ Auto-update failed: claude.exe in use (close other Claude Code sessions, including VS Code) · Run /doctor',
      '✻ Brewed for 7s',
      '────────────',
      '❯ ',
      '  gh auth login · ← for agents',
      '✘ Auto-update failed: claude.exe in use (close other Claude Code sessions, including VS Code) · Run /doctor',
    ),
  );
  await sleep(SETTLE * 6 + 80);
  await driver.stop();
  await pump;
  const results = events.filter((e) => e.kind === 'result');
  assert.equal(results.length, 1, `fired ONE result despite the pinned auto-update banner (got ${results.length})`);
  assert.ok((results[0] as { result?: string }).result?.includes("I'm here and ready"), 'result carries the reply text');
});

// ── #5 INBOUND-DROP: turn queue + input-ready gating ─────────────────────────
test('driver #5 (a): a turn sent during BOOT waits for the input box, then is typed', async () => {
  // The live "first question never reached me" boot race: the PTY is spawned but the TUI
  // hasn't rendered its input box yet → the OLD send() typed immediately into a not-ready
  // TUI → lost. Now send() ENQUEUES; the turn is typed only once the input box renders.
  const pty = new FakePty();
  const { driver, pump } = startDriver(pty);
  // send BEFORE any input box exists (still booting).
  await driver.send({ text: 'EARLY QUESTION' });
  await sleep(SETTLE + 30);
  assert.ok(!pty.writes.some((w) => w.includes('EARLY QUESTION')), 'the turn is HELD while the input box has not rendered (not typed into a not-ready TUI)');
  // NOW the boot input box renders → the queued turn is typed.
  pty.emit(IDLE_INPUT);
  await sleep(SETTLE + 40);
  assert.ok(pty.writes.some((w) => w.includes('EARLY QUESTION')), 'once the input box rendered, the queued turn was typed');
  await driver.stop();
  await pump;
});

test('driver #5 (b)+(c): a 2nd turn sent MID-TURN-1 is HELD until turn 1 completes, then typed — order preserved', async () => {
  // THE CORE BUG (proved by the FakePty diagnostic): with no queue, send() typed turn 2
  // into the PTY WHILE turn 1 was still in flight (TUI busy) → lost/garbled. Now turn 2 is
  // held until turn 1's input box is idle again, then typed. FIFO → order preserved.
  const pty = new FakePty();
  const { driver, events, pump } = startDriver(pty, allow, { turnCompleteStableNeeded: 2 });
  await readyAndSend(pty, driver, 'FIRST');
  assert.ok(pty.writes.some((w) => w.includes('FIRST')), 'turn 1 typed (input box was idle)');
  // turn 1 is now in flight; the TUI is BUSY (spinner, NO idle input box).
  pty.emit(lines('● Working…', '· Orchestrating… (5s · ↑ 100 tokens)', '  esc to interrupt'));
  await sleep(SETTLE + 20);
  // turn 2 arrives WHILE turn 1 is busy → must be HELD (not typed).
  await driver.send({ text: 'SECOND' });
  await sleep(SETTLE + 40);
  assert.ok(!pty.writes.some((w) => w.includes('SECOND')), '★ turn 2 is HELD while turn 1 is in flight (NOT typed into the busy TUI — the inbound-drop fix)');
  // turn 1 COMPLETES (answer + idle input box, twice for the streak) → turn 2 drains.
  const done1 = lines('● First answer.', '✻ Brewed for 5s', '────────────', '❯ ', '────────────', '  gh auth login · ← for agents');
  pty.emit(done1);
  await sleep(SETTLE + 30);
  pty.emit(done1);
  await sleep(SETTLE + 60);
  assert.ok(pty.writes.some((w) => w.includes('SECOND')), '★ once turn 1 completed (input idle), the held turn 2 was typed');
  // order preserved: FIRST was written before SECOND.
  const idxFirst = pty.writes.findIndex((w) => w.includes('FIRST'));
  const idxSecond = pty.writes.findIndex((w) => w.includes('SECOND'));
  assert.ok(idxFirst >= 0 && idxSecond > idxFirst, 'FIFO order preserved (FIRST typed before SECOND)');
  await driver.stop();
  await pump;
});

test('driver #5 (d): NO-DEADLOCK — if the input box NEVER becomes ready, the queued turn surfaces an error (does not hang)', async () => {
  // The queue must not re-introduce a hang: a wedged TUI that never renders an idle input
  // box would otherwise hold the turn forever. With a short inputReadyTimeoutMs, the
  // driver gives up on the head turn + surfaces an error result instead of hanging.
  const pty = new FakePty();
  const { driver, events, pump } = startDriver(pty, allow, { inputReadyTimeoutMs: 120 });
  // send a turn, but NEVER render an input box — only busy/spinner frames (wedged).
  await driver.send({ text: 'WEDGED TURN' });
  pty.emit(lines('● …', '· Spinning forever… (1s)', '  esc to interrupt'));
  await sleep(SETTLE * 8 + 200); // > inputReadyTimeoutMs, with self-rescheduled drain polls
  await driver.stop();
  await pump;
  assert.ok(!pty.writes.some((w) => w.includes('WEDGED TURN')), 'the turn was never typed (input box never became ready)');
  const errs = events.filter((e) => e.kind === 'result' && (e as { subtype?: string }).subtype === 'error');
  assert.ok(errs.length >= 1, 'an error result was surfaced (no silent hang)');
  assert.match((errs[0] as { result?: string }).result ?? '', /never became ready|wedged/i, 'the error explains the input box never became ready');
});

test('driver #5 (e): a PENDING PERMISSION PROMPT is NOT "ready" — the next turn is held until it resolves', async () => {
  // A pending permission prompt must never count as input-ready: typing a new question
  // into a permission prompt would answer/garble it. The drainer holds the next turn while
  // a prompt is on screen (isInputReady() excludes detectPermission()).
  const pty = new FakePty();
  let decided = false;
  const onPermission: PermissionHandler = async () => { decided = true; return { behavior: 'allow' }; };
  const { driver, pump } = startDriver(pty, onPermission, { turnCompleteStableNeeded: 2 });
  // a turn is in flight + a permission prompt is rendered (NOT an idle input box).
  await readyAndSend(pty, driver, 'do the thing');
  pty.emit(PERMISSION_FRAME);
  await sleep(SETTLE + 40);
  assert.ok(decided, 'the permission prompt WAS detected + routed (driver consulted the handler)');
  // a SECOND turn arrives while the prompt is still on screen → must be HELD.
  await driver.send({ text: 'NEXT QUESTION' });
  await sleep(SETTLE + 40);
  assert.ok(!pty.writes.some((w) => w.includes('NEXT QUESTION')), '★ the next turn is HELD while a permission prompt is pending (never typed into the prompt)');
  await driver.stop();
  await pump;
});

test('driver: NO premature result on a transient input-box flash with a spinner active', async () => {
  const pty = new FakePty();
  const { driver, events, pump } = startDriver(pty, allow, { turnCompleteStableNeeded: 2 });
  await driver.send({ text: 'hi' });
  // the input box flashes "❯" at the very start WHILE the engine works (spinner) + no answer.
  pty.emit(lines('❯ ', '✻ Orchestrating…', '  esc to interrupt'));
  await sleep(SETTLE + 30);
  pty.emit(lines('❯ ', '✻ Orchestrating… (3s)', '  esc to interrupt'));
  await sleep(SETTLE + 30);
  await driver.stop();
  await pump;
  const results = events.filter((e) => e.kind === 'result');
  assert.equal(results.length, 0, `NO result while the engine is still working (got ${results.length})`);
});

test('driver: a queued turn is typed (text + submit) once the input box is idle; interrupt() sends Esc', async () => {
  const pty = new FakePty();
  const { driver, pump } = startDriver(pty);
  // #5: send() ENQUEUES — the turn is typed by the drainer when the input box is idle.
  // Establish the idle input box first (the real TUI renders it at boot), then send.
  await readyAndSend(pty, driver, 'hello world');
  await sleep(20); // the submit key follows after submitDelayMs (5ms) via a timer
  assert.equal(pty.writes[0], 'hello world', 'the queued turn text was typed once input-ready');
  assert.equal(pty.writes[1], '\r', 'the submit key followed');
  await driver.interrupt();
  assert.ok(pty.writes.includes('\x1b'), 'interrupt sends Esc');
  await driver.stop();
  await pump;
});

test('driver: buildArgs passes --model/--resume/--append-system-prompt', async () => {
  const pty = new FakePty();
  let capturedArgs: string[] = [];
  const driver = new PtySessionDriver({ spawnFn: fakeSpawn(pty, (_f, a) => (capturedArgs = a)), skipPreTrust: true, settleMs: SETTLE });
  const iter = driver
    .start({ onPermission: allow, cwd: 'x', model: 'claude-opus-4-8', resume: 'sess-123', systemPrompt: { preset: 'claude_code', append: 'You are the orchestrator.' } })
    [Symbol.asyncIterator]();
  const pump = (async () => {
    for (let r = await iter.next(); !r.done; r = await iter.next()) void r;
  })();
  await sleep(10);
  await driver.stop();
  await pump;
  assert.ok(capturedArgs.includes('--model') && capturedArgs.includes('claude-opus-4-8'));
  assert.ok(capturedArgs.includes('--resume') && capturedArgs.includes('sess-123'));
  assert.ok(capturedArgs.includes('--append-system-prompt'));
});

test('driver: send() before start throws; health reflects state', async () => {
  const driver = new PtySessionDriver({ spawnFn: fakeSpawn(new FakePty()), skipPreTrust: true });
  await assert.rejects(() => driver.send({ text: 'hi' }), /not started/);
  assert.equal(driver.health().running, false);
  assert.equal(driver.health().detail, 'pty-session-driver');
});

test('driver #2: the session cwd is passed to the spawn (the worktree-isolation mechanism)', async () => {
  // #2 WORKTREE HARD ISOLATION relies on the hosted PTY child running in a SEPARATE worktree.
  // The supervisor passes that path as start({cwd}); the driver must spawn claude with that
  // exact cwd (so the orchestrator's file writes land in the worktree, not the real tree).
  const pty = new FakePty();
  let capturedCwd: string | undefined;
  const driver = new PtySessionDriver({
    spawnFn: fakeSpawn(pty, (_f, _a, opts) => (capturedCwd = opts?.cwd)),
    skipPreTrust: true,
    settleMs: SETTLE,
  });
  const worktree = 'D:/tmp/supervisor-worktree-12345';
  const iter = driver.start({ onPermission: allow, cwd: worktree })[Symbol.asyncIterator]();
  const pump = (async () => {
    for (let r = await iter.next(); !r.done; r = await iter.next()) void r;
  })();
  await sleep(10);
  await driver.stop();
  await pump;
  assert.equal(capturedCwd, worktree, 'the spawn ran in the isolation-worktree cwd');
});

// ── containment seal (the production-telegram isolation breach fix) ───────────
test('filterSpawnableMcpServers keeps stdio/http servers, DROPS in-process (no command/url)', () => {
  const out = filterSpawnableMcpServers({
    'hostinger-email': { command: 'npx', args: ['mcp-mail-server'] }, // stdio → keep
    context7: { type: 'http', url: 'https://ctx7.example/mcp' }, // http → keep
    google: { url: 'https://gw.example/sse', type: 'sse' }, // sse → keep
    supervisor_channel: { instanceRef: 'sdk-in-process' }, // no command/url → DROP
    bogus: 'not-an-object', // → DROP
  });
  assert.deepEqual(Object.keys(out).sort(), ['context7', 'google', 'hostinger-email']);
  assert.ok(!('supervisor_channel' in out), 'the in-process SDK server is NOT passed to the child');
});

test('driver: ★ sealContainment → --strict-mcp-config + --mcp-config + plugin-disable + telegram deny', async () => {
  const pty = new FakePty();
  let capturedArgs: string[] = [];
  const driver = new PtySessionDriver({
    spawnFn: fakeSpawn(pty, (_f, a) => (capturedArgs = a)),
    skipPreTrust: true,
    settleMs: SETTLE,
    sealContainment: true,
  });
  const iter = driver
    .start({
      onPermission: allow,
      cwd: 'x',
      mcpServers: {
        'hostinger-email': { command: 'npx', args: ['mcp-mail-server'] },
        supervisor_channel: { instanceRef: 'sdk' }, // in-process → must be filtered out of the config
      },
      disallowedTools: ['mcp__plugin_telegram_telegram__*'],
    })
    [Symbol.asyncIterator]();
  const pump = (async () => {
    for (let r = await iter.next(); !r.done; r = await iter.next()) void r;
  })();
  await sleep(10);
  // 1) the seal flags are present
  assert.ok(capturedArgs.includes('--strict-mcp-config'), `--strict-mcp-config present (got ${JSON.stringify(capturedArgs)})`);
  const mcpIdx = capturedArgs.indexOf('--mcp-config');
  assert.ok(mcpIdx >= 0, '--mcp-config present');
  // 2) the --mcp-config value is a temp file holding ONLY the spawnable server (no telegram, no in-process)
  const cfgPath = capturedArgs[mcpIdx + 1]!;
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { mcpServers: Record<string, unknown> };
  assert.deepEqual(Object.keys(cfg.mcpServers), ['hostinger-email'], 'only the spawnable work server is in the child config');
  assert.ok(!('supervisor_channel' in cfg.mcpServers), 'in-process supervisor_channel excluded');
  // 3) --settings disables the telegram PLUGIN
  const setIdx = capturedArgs.indexOf('--settings');
  assert.ok(setIdx >= 0, '--settings present');
  const settings = JSON.parse(capturedArgs[setIdx + 1]!) as { enabledPlugins: Record<string, boolean> };
  assert.equal(settings.enabledPlugins['telegram@claude-plugins-official'], false, 'telegram plugin disabled');
  // 4) --disallowed-tools denies the telegram tool globs
  const disIdx = capturedArgs.indexOf('--disallowed-tools');
  assert.ok(disIdx >= 0, '--disallowed-tools present');
  assert.match(capturedArgs[disIdx + 1]!, /mcp__plugin_telegram_telegram__\*/, 'telegram tools denied');
  await driver.stop();
  await pump;
  // 5) the temp config file is cleaned on stop
  assert.ok(!existsSync(cfgPath), 'the temp --mcp-config file is removed on stop');
});

test('driver: NO seal flags when sealContainment is unset (demo/default)', async () => {
  const pty = new FakePty();
  let capturedArgs: string[] = [];
  const driver = new PtySessionDriver({ spawnFn: fakeSpawn(pty, (_f, a) => (capturedArgs = a)), skipPreTrust: true, settleMs: SETTLE });
  const iter = driver.start({ onPermission: allow, cwd: 'x', mcpServers: { foo: { command: 'x' } } })[Symbol.asyncIterator]();
  const pump = (async () => {
    for (let r = await iter.next(); !r.done; r = await iter.next()) void r;
  })();
  await sleep(10);
  await driver.stop();
  await pump;
  assert.ok(!capturedArgs.includes('--strict-mcp-config'), 'no seal without sealContainment');
  assert.ok(!capturedArgs.includes('--mcp-config'), 'no --mcp-config without sealContainment');
});
