/**
 * The PTY SessionDriver — drives the INTERACTIVE `claude` TUI in a node-pty
 * pseudo-console (subscription-billed), as the alternative to the headless Agent
 * SDK (`SdkSessionDriver`). Selected by `--driver pty`; the SDK driver stays the
 * default + the instant fallback (the 3c de-risk). Confined to this one file,
 * behind the `SessionDriver` seam, so LifecycleManager / SessionHost / the router
 * / panel / channel are unchanged.
 *
 * ── Why RENDER-parsed output (not transcript-tail) ──────────────────────────
 * Empirically established (probes 2026-06-15, design doc §(e)/§(f)): a node-pty-
 * spawned INTERACTIVE claude session writes NO session JSONL at all — not live,
 * not on clean exit, not with --session-id, regardless of activity (4 runs). Only
 * harness-launched / `--print` sessions journal. So transcript-tail is NOT
 * available here; the RENDER is the only real-time source. We parse a BOUNDED set
 * of known markers (assistant text / permission prompt / turn-complete / errors) —
 * NOT a full terminal emulator. All markers were captured verbatim from the probes
 * and are pinned in `src/test/fixtures/pty/`.
 *
 * ── Mapping (rendered TUI → normalized SessionEvent) ────────────────────────
 *   boot banner (model/cwd/version)              → system_init
 *   assistant prose between turn + input-box      → assistant (text)
 *   a "● <Tool>(<arg>)" line after a tool ran     → assistant (toolUses) + tool_result
 *   "Do you want to …?" + "❯ 1. Yes/…/3. No"      → a PermissionRequest (router) → keystroke
 *   input box "❯" re-render after a settled reply → result (turn complete)
 *
 * ── Permissions (the FC-1 path, render-driven) ─────────────────────────────
 * The pending prompt is NOT in any transcript (interactive claude blocks before
 * journaling). The driver render-detects the prompt header, builds a
 * PermissionRequest from the HEADER block ("Create file"/<filename> + the verb),
 * hands it to the EXISTING PermissionHandler (the router + safety floor), then
 * injects the verdict keystroke: `1\r` allow / `3\r` deny. The safety-floor
 * predicate still runs at the router, so a destructive op routes to the user
 * before the keystroke is sent.
 *
 * ── Trust gate ─────────────────────────────────────────────────────────────
 * Pre-trust the cwd by setting ~/.claude.json projects["<normalized-cwd>"].
 * hasTrustDialogAccepted=true (forward-slash, case-sensitive path key) BEFORE
 * spawn → no gate. A keystroke-Enter fallback clears the gate for a fresh dir.
 *
 * ⚠️ Constructing + starting this spawns a real interactive Claude Code child via
 * ConPTY. The supervisor only does so for its OWN driven session (additive). It is
 * NEVER the production orchestrator.
 *
 * Traces: design doc docs/development/m12-pty-driver-design-2026-06-15.md (§2 + §(e)/§(f) + PART 4).
 */

import { homedir } from 'node:os';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { GridScreen, type XtermCtor } from './pty-grid.js';
import { stripAnsi } from './pty-render-parser.js';
import type {
  PermissionDecision,
  PermissionHandler,
  SessionDriver,
  SessionDriverHealth,
  SessionEvent,
  SessionStartOptions,
  ToolUse,
  UserTurn,
} from '../session-driver.js';

/**
 * Minimal structural view of the node-pty surface we use. Kept loose so this file
 * TYPE-CHECKs + loads even when node-pty isn't installed (tests inject a FakePty;
 * the real addon is resolved only at runtime via dynamic import).
 */
export interface PtyProcess {
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  kill(signal?: string): void;
}
export type PtySpawnFn = (
  file: string,
  args: string[],
  opts: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string | undefined> },
) => PtyProcess;

export interface PtySessionDriverOptions {
  /**
   * Inject the node-pty `spawn` (for tests — a FakePty). If omitted, the driver
   * dynamically imports `node-pty` on first start().
   */
  spawnFn?: PtySpawnFn;
  /** Path to the `claude` launcher. Default resolves the platform npm shim. */
  claudeBin?: string;
  /** Override ~/.claude.json path (tests). Default = ~/.claude.json. */
  claudeJsonPath?: string;
  /** Skip the pre-trust write (tests / when the keystroke fallback is desired). */
  skipPreTrust?: boolean;
  /** PTY size. */
  cols?: number;
  rows?: number;
  /** ms to wait after typing a turn before sending the submit key. Default 900. */
  submitDelayMs?: number;
  /** ms of TUI quiet before reading the settled grid (debounce). Default 250. */
  settleMs?: number;
  /** Consecutive settled "turn-complete" reads required before emitting the result. Default 3. */
  turnCompleteStableNeeded?: number;
  /** Inject the @xterm/headless Terminal ctor (tests). Default = dynamic import. */
  gridCtor?: XtermCtor;
  /** Optional sink for the raw render stream (diagnostics; never the secret). */
  onRaw?: (chunk: string) => void;
  /**
   * PRE-ALLOW predicate for the `$()` COMMAND-SUBSTITUTION security gate. When the
   * grid detects that gate (a Claude Code security overlay that fires even when Bash
   * is allow-listed, and is NOT suppressible by any documented env-var/settings
   * field — confirmed), and this returns true for the underlying (toolName, input),
   * the driver AUTO-ANSWERS "1. Yes" WITHOUT routing — so the orchestrator's OWN
   * routine `$()` startup commands proceed without an operator click or a hang.
   * A `$()` command for which this returns FALSE (e.g. a destructive one) STILL
   * routes through the normal handler (safety floor). Default: undefined → the gate
   * is NOT auto-allowed (it routes like any other prompt — the safe default). The
   * orchestrator profile wires this to `!isDestructiveShellCommand(cmd)`.
   */
  autoAllowSubexpr?: (toolName: string, input: Record<string, unknown>) => boolean;
}

/** Default path to the interactive `claude` launcher on this platform. */
function defaultClaudeBin(): string {
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'npm', 'claude.cmd');
  }
  return 'claude';
}

/**
 * Normalize a cwd to the EXACT key Claude Code stores in ~/.claude.json
 * `projects` (forward slashes, case-sensitive — verified: it stores
 * "D:/repos/PianoidInstall", a "D:\…" backslash entry is a DIFFERENT key).
 */
export function normalizeProjectKey(cwd: string): string {
  return cwd.replace(/\\/g, '/');
}

/**
 * Pre-trust a cwd by writing projects["<key>"].hasTrustDialogAccepted=true into
 * ~/.claude.json (so the spawned TUI shows no first-run trust gate). Best-effort:
 * returns true if the flag is set (or was already), false on any error (then the
 * keystroke fallback handles the gate). Pure-ish (reads+writes one file); exported
 * for the test to assert the exact key/shape.
 */
export function preTrustProject(claudeJsonPath: string, cwd: string): boolean {
  try {
    if (!existsSync(claudeJsonPath)) return false;
    const j = JSON.parse(readFileSync(claudeJsonPath, 'utf8')) as {
      projects?: Record<string, { hasTrustDialogAccepted?: boolean }>;
    };
    const key = normalizeProjectKey(cwd);
    j.projects = j.projects ?? {};
    j.projects[key] = j.projects[key] ?? {};
    if (j.projects[key]!.hasTrustDialogAccepted === true) return true;
    j.projects[key]!.hasTrustDialogAccepted = true;
    writeFileSync(claudeJsonPath, JSON.stringify(j, null, 2));
    return true;
  } catch {
    return false;
  }
}

const SUBMIT_KEY = '\r';
const ESC_KEY = '\x1b';

export class PtySessionDriver implements SessionDriver {
  private readonly opts: PtySessionDriverOptions;
  private term: PtyProcess | null = null;
  private running = false;
  private sessionId: string | undefined;
  /** The 2D grid model (A-variant): the driver feeds onData here + reads regions. */
  private readonly grid: GridScreen;
  /** The session cwd (for the synthetic system_init id). */
  private cwd: string | undefined;
  /** True once the boot banner produced a system_init event. */
  private sawInit = false;
  /** Debounce timer: read the settled grid after the TUI stops repainting. */
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  /** The last assistant text surfaced this turn (carried into the result event). */
  private lastAssistantText: string | undefined;
  /** Queue of normalized events the generator drains (push-driven from onData). */
  private eventQueue: SessionEvent[] = [];
  private resolveNext: ((v: IteratorResult<SessionEvent>) => void) | null = null;
  private streamDone = false;
  /** The router (set on start) — consulted on a render-detected permission prompt. */
  private onPermission: PermissionHandler | null = null;
  /** True while a permission prompt is rendered + awaiting our keystroke (de-dup). */
  private permissionPending = false;
  /** Resolves once start()'s eager spawn has created the PTY (send/interrupt await it). */
  private setupPromise: Promise<void> | null = null;
  /**
   * Turn-complete de-dup. The TUI repaints the input box "❯" many times per turn
   * (spinner frames, redraws). We surface AT MOST ONE `result` per turn: armed on
   * send(), fired on the first settled "input box idle" after the turn, then
   * suppressed until the next turn. Without this the lifecycle sees bogus results.
   */
  private turnResultEmitted = false;
  /** True once real content (assistant text / tool) arrived for the current turn (diagnostic). */
  private turnHadContent = false;
  /** True between send() and the turn's surfaced result — gates the turn-complete de-dup. */
  private turnInFlight = false;
  /** Consecutive settled reads where the grid looked turn-complete (debounce vs a flash). */
  private turnCompleteStreak = 0;

  constructor(opts: PtySessionDriverOptions = {}) {
    this.opts = opts;
    this.grid = new GridScreen({ cols: opts.cols ?? 120, rows: opts.rows ?? 40, termCtor: opts.gridCtor });
  }

  private async resolveSpawn(): Promise<PtySpawnFn> {
    if (this.opts.spawnFn) return this.opts.spawnFn;
    // Indirect dynamic import so the dep need not resolve for type-check/load.
    const dynamicImport = new Function('s', 'return import(s)') as (s: string) => Promise<unknown>;
    const mod = (await dynamicImport('node-pty')) as { spawn?: PtySpawnFn; default?: { spawn?: PtySpawnFn } };
    const spawn = mod.spawn ?? mod.default?.spawn;
    if (typeof spawn !== 'function') throw new Error('node-pty: spawn() not found (is the dependency installed?)');
    return spawn;
  }

  start(opts: SessionStartOptions): AsyncIterable<SessionEvent> {
    const self = this;
    this.running = true;
    this.onPermission = opts.onPermission;
    this.streamDone = false;
    this.eventQueue = [];
    this.sawInit = false;
    this.lastAssistantText = undefined;

    // Spawn EAGERLY (not lazily inside the generator) so `send()`/`interrupt()`
    // work the instant start() returns — the lifecycle injects the first turn
    // without first pulling an event (mirrors the SDK driver's eager queue). The
    // setup promise is awaited by the generator before it drains events.
    const cwd = opts.cwd ?? process.cwd();
    this.cwd = cwd;
    const setup = (async () => {
      await self.grid.init(); // the 2D screen the onData chunks feed into
      const spawn = await self.resolveSpawn();
      if (!self.opts.skipPreTrust) {
        const p = self.opts.claudeJsonPath ?? join(homedir(), '.claude.json');
        preTrustProject(p, cwd);
      }
      const args = self.buildArgs(opts);
      const env: Record<string, string | undefined> = opts.env ? { ...opts.env } : { ...process.env };
      self.term = spawn(self.opts.claudeBin ?? defaultClaudeBin(), args, {
        name: 'xterm-256color',
        cols: self.opts.cols ?? 120,
        rows: self.opts.rows ?? 40,
        cwd,
        env,
      });
      self.term.onData((chunk) => self.ingest(chunk));
      self.term.onExit(() => self.endStream());
    })();
    this.setupPromise = setup;

    async function* gen(): AsyncGenerator<SessionEvent> {
      await setup;
      try {
        while (true) {
          const ev = await self.nextEvent();
          if (ev === null) break; // stream ended
          if (ev.kind === 'system_init') self.sessionId = ev.sessionId;
          if (ev.kind === 'result') self.sessionId = ev.sessionId;
          yield ev;
        }
      } finally {
        self.running = false;
      }
    }
    return gen();
  }

  /**
   * Build interactive `claude` args from the start options. Subscription billing
   * requires the INTERACTIVE TUI (no --print), so we map what interactive flags
   * support: --model, --append-system-prompt (the orchestrator preamble),
   * --resume (FI restart). allow/deny/settings/mcp are governed by the project's
   * settings + the render-driven permission router (not headless flags).
   */
  private buildArgs(opts: SessionStartOptions): string[] {
    const args: string[] = [];
    if (opts.model) args.push('--model', opts.model);
    if (opts.resume) args.push('--resume', opts.resume);
    // systemPrompt: only the preset+append form maps to interactive (--append-…);
    // a bare string (demo persona) has no interactive flag → carried via the role
    // turn prefix instead, so we ignore it here.
    if (opts.systemPrompt && typeof opts.systemPrompt === 'object' && opts.systemPrompt.append) {
      args.push('--append-system-prompt', opts.systemPrompt.append);
    }
    return args;
  }

  /**
   * Feed a raw PTY chunk into the GRID (the A-variant: a real 2D @xterm/headless
   * screen, not a line-flatten). The TUI repaints rapidly, so we DEBOUNCE: each
   * chunk (re)schedules a settle, and only the settled screen is read. On settle we
   * (1) emit system_init once (from the boot banner), (2) read the NEW message-
   * region content rows → assistant/tool_result events, (3) route a pending
   * permission prompt, (4) emit ONE result per turn when the input box is idle.
   */
  private ingest(chunk: string): void {
    this.opts.onRaw?.(chunk);
    this.grid.write(chunk);
    // boot banner → system_init (once). The grid has the banner rows immediately.
    if (!this.sawInit) {
      const clean = stripAnsi(chunk);
      if (/Claude Code v[\d.]+|·\s*Claude Max/.test(clean)) {
        this.sawInit = true;
        const model = clean.match(/(Opus|Sonnet|Haiku)[\w.\s()]*?(?=·|$)/i);
        const sid = `pty-${(this.cwd ?? 'x').replace(/[^A-Za-z0-9]/g, '-').slice(-24)}-${Date.now().toString(36)}`;
        this.sessionId = sid;
        this.enqueue({ kind: 'system_init', sessionId: sid, model: model ? model[0].trim() : undefined, tools: undefined });
      }
    }
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => this.readGrid(), this.opts.settleMs ?? 250);
    if (this.settleTimer && typeof this.settleTimer === 'object' && 'unref' in this.settleTimer) {
      (this.settleTimer as { unref: () => void }).unref();
    }
  }

  /** Read the settled grid: new content rows, a permission prompt, turn-complete. */
  private readGrid(): void {
    // (1) pending permission prompt → route once (the FC-1 path, grid-detected).
    const perm = this.grid.detectPermission();
    if (perm && !this.permissionPending) {
      // (1a) PRE-ALLOW the `$()` command-substitution gate for the orchestrator's OWN
      // routine startup commands: if it's that gate AND the command is NOT destructive
      // (autoAllowSubexpr), auto-answer "1. Yes" WITHOUT routing (no operator click, no
      // hang). A destructive `$()` command falls through to the normal routed handler
      // (the safety floor still confirms it). De-duped via permissionPending.
      if (perm.subexpressionGate && this.opts.autoAllowSubexpr?.(perm.toolName, perm.input)) {
        // Hold permissionPending across the re-render window (one settle cycle) so the
        // still-rendered gate isn't re-detected → double-injected before the TUI consumes
        // the keystroke. Mirrors how handlePermission's await spans the round-trip.
        this.permissionPending = true;
        try {
          this.term?.write('1' + SUBMIT_KEY);
        } catch {
          /* term gone */
        }
        const clear = setTimeout(() => {
          this.permissionPending = false;
        }, this.opts.settleMs ?? 250);
        if (clear && typeof clear === 'object' && 'unref' in clear) (clear as { unref: () => void }).unref();
        return; // verdict injected; wait for the re-render before reading content
      }
      void this.handlePermission(perm.toolName, perm.input);
      return; // wait for the verdict + re-render before reading content
    }
    // (2) trust gate (fresh dir, pre-trust missed) → send Enter (default "1. Yes").
    if (this.grid.detectTrustGate()) {
      try {
        this.term?.write(SUBMIT_KEY);
      } catch {
        /* term gone */
      }
      return;
    }
    // (3) NEW message-region content since the last read → assistant / tool_result.
    for (const ev of this.grid.readNewEvents()) {
      if (ev.kind === 'assistant') {
        this.turnHadContent = true;
        this.enqueue({ kind: 'assistant', text: ev.text, toolUses: ev.toolUses ?? [] });
      } else {
        this.turnHadContent = true;
        this.enqueue({ kind: 'tool_result', toolUseId: ev.toolUseId, content: ev.content });
      }
    }
    // (4) turn-complete: ONE result per turn — STRICT + DEBOUNCED. The input box flashes
    // "❯" transiently at the very START of a turn (before output), so a single idle read
    // is NOT enough (the live bug fired a result ~3 s into a long startup). We require
    // grid.isTurnComplete() (input idle + a real answer present + no spinner + no pending
    // prompt) to hold across `turnCompleteStableNeeded` CONSECUTIVE settled reads.
    if (this.turnInFlight && !this.turnResultEmitted) {
      if (this.grid.isTurnComplete()) {
        this.turnCompleteStreak += 1;
      } else {
        this.turnCompleteStreak = 0;
      }
      if (this.turnCompleteStreak >= (this.opts.turnCompleteStableNeeded ?? 3)) {
        this.turnResultEmitted = true;
        this.turnInFlight = false;
        this.turnCompleteStreak = 0;
        const finalText = this.grid.currentAnswerText() ?? this.lastAssistantText;
        this.enqueue({ kind: 'result', sessionId: this.sessionId ?? '', subtype: 'success', result: finalText });
      }
    }
  }

  /**
   * A permission prompt was render-detected. Route it through the EXISTING handler
   * (router + safety floor + channel round-trip), then inject the verdict keystroke
   * into the PTY. De-duped so a multi-chunk prompt render only routes once.
   */
  private async handlePermission(toolName: string, input: Record<string, unknown>): Promise<void> {
    if (this.permissionPending || !this.onPermission || !this.term) return;
    this.permissionPending = true;
    let decision: PermissionDecision;
    try {
      decision = await this.onPermission({ toolName, input, sessionId: this.sessionId });
    } catch {
      decision = { behavior: 'deny', message: 'permission handler error' };
    }
    // Inject the keystroke: allow → "1"+Enter; deny → Esc (cancel). (Probe-verified:
    // "1\r" grants + the action runs; Esc cancels.)
    try {
      if (decision.behavior === 'allow') this.term.write('1' + SUBMIT_KEY);
      else this.term.write(ESC_KEY);
    } catch {
      /* term gone */
    }
    this.permissionPending = false;
  }

  // ── push-driven async event queue (onData → generator) ─────────────────────
  private enqueue(ev: SessionEvent): void {
    if (this.resolveNext) {
      const r = this.resolveNext;
      this.resolveNext = null;
      r({ value: ev, done: false });
    } else {
      this.eventQueue.push(ev);
    }
  }
  private nextEvent(): Promise<SessionEvent | null> {
    if (this.eventQueue.length > 0) return Promise.resolve(this.eventQueue.shift()!);
    if (this.streamDone) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.resolveNext = (r) => resolve(r.done ? null : r.value);
    });
  }
  private endStream(): void {
    this.streamDone = true;
    if (this.resolveNext) {
      const r = this.resolveNext;
      this.resolveNext = null;
      r({ value: undefined as never, done: true });
    }
  }

  /** Inject a user turn: type the text, then the submit key after a settle delay. */
  async send(turn: UserTurn): Promise<void> {
    if (this.setupPromise) await this.setupPromise; // wait for the eager spawn
    if (!this.term) throw new Error('pty session driver: not started');
    // New turn → re-arm the turn-complete de-dup (one result per turn).
    this.turnResultEmitted = false;
    this.turnHadContent = false;
    this.turnInFlight = true;
    this.turnCompleteStreak = 0;
    this.lastAssistantText = undefined;
    this.term.write(turn.text);
    const delay = this.opts.submitDelayMs ?? 900;
    await new Promise((r) => setTimeout(r, delay));
    this.term.write(SUBMIT_KEY);
  }

  /** Interrupt the current turn — Esc into the PTY (the interactive analog of query().interrupt()). */
  async interrupt(): Promise<void> {
    if (this.setupPromise) await this.setupPromise;
    this.term?.write(ESC_KEY);
  }

  /** Stop + dispose the PTY child. Safe to call when not running. */
  async stop(): Promise<void> {
    this.running = false;
    this.streamDone = true;
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    try {
      this.term?.kill();
    } catch {
      /* already gone */
    }
    this.grid.dispose();
    this.term = null;
    if (this.resolveNext) {
      const r = this.resolveNext;
      this.resolveNext = null;
      r({ value: undefined as never, done: true });
    }
  }

  health(): SessionDriverHealth {
    return { running: this.running, sessionId: this.sessionId, detail: 'pty-session-driver' };
  }
}

// Re-export the ToolUse type usage so the parser + this file agree.
export type { ToolUse };
