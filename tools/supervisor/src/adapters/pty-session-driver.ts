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
import {
  parseRenderChunk,
  type PtyRenderEvent,
} from './pty-render-parser.js';
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
  /** Optional sink for the raw render stream (diagnostics; never the secret). */
  onRaw?: (chunk: string) => void;
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
  /** Render parser carry-over (incomplete trailing line between chunks). */
  private parseCarry = '';
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
   * (spinner frames, redraws), so the parser emits `turn_complete` repeatedly. We
   * surface AT MOST ONE `result` per turn: armed when a turn is sent / content
   * arrives, fired on the first turn_complete after content, then suppressed until
   * the next turn. Without this the lifecycle sees many bogus "turn done" results.
   */
  private turnResultEmitted = false;
  /** True once real content (assistant text / tool) arrived for the current turn (diagnostic). */
  private turnHadContent = false;
  /** True between send() and the turn's surfaced result — gates the turn_complete de-dup. */
  private turnInFlight = false;

  constructor(opts: PtySessionDriverOptions = {}) {
    this.opts = opts;
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
    this.parseCarry = '';

    // Spawn EAGERLY (not lazily inside the generator) so `send()`/`interrupt()`
    // work the instant start() returns — the lifecycle injects the first turn
    // without first pulling an event (mirrors the SDK driver's eager queue). The
    // setup promise is awaited by the generator before it drains events.
    const cwd = opts.cwd ?? process.cwd();
    const setup = (async () => {
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
      self.term.onData((chunk) => self.ingest(chunk, cwd));
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

  /** Feed a raw render chunk through the bounded parser → enqueue SessionEvents. */
  private ingest(chunk: string, cwd: string): void {
    this.opts.onRaw?.(chunk);
    const { events, carry } = parseRenderChunk(this.parseCarry + chunk, { cwd });
    this.parseCarry = carry;
    for (const re of events) this.handleRenderEvent(re);
  }

  /** Map a parser render-event → a normalized SessionEvent (+ permission round-trip). */
  private handleRenderEvent(re: PtyRenderEvent): void {
    switch (re.kind) {
      case 'system_init':
        this.enqueue({ kind: 'system_init', sessionId: re.sessionId, model: re.model, tools: undefined });
        break;
      case 'assistant':
        // Only surface assistant events that carry real content (text or a tool).
        // The parser is conservative but some chrome can slip through; an empty
        // text with no toolUses is never useful downstream.
        if ((re.text && re.text.trim()) || (re.toolUses && re.toolUses.length > 0)) {
          this.turnHadContent = true;
          this.enqueue({ kind: 'assistant', text: re.text, toolUses: re.toolUses ?? [] });
        }
        break;
      case 'tool_result':
        this.turnHadContent = true;
        this.enqueue({ kind: 'tool_result', toolUseId: re.toolUseId, content: re.content, isError: re.isError });
        break;
      case 'turn_complete':
        // De-dup: emit at most ONE result per turn. We surface it once the input box
        // has settled AND a turn was actually in flight (a turn was sent). The
        // 'turnHadContent' flag is recorded for diagnostics but does NOT gate the
        // result — on the real noisy TUI, content + chrome interleave on the same
        // lines, so recognized content can be empty even though the turn completed;
        // gating the result on it would drop the turn-end signal entirely.
        if (this.turnInFlight && !this.turnResultEmitted) {
          this.turnResultEmitted = true;
          this.turnInFlight = false;
          this.enqueue({ kind: 'result', sessionId: this.sessionId ?? '', subtype: 'success', result: re.finalText });
        }
        break;
      case 'permission':
        void this.handlePermission(re.toolName, re.input);
        break;
      case 'error':
        this.enqueue({ kind: 'result', sessionId: this.sessionId ?? '', subtype: re.subtype ?? 'error_during_execution', result: re.message });
        break;
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
    try {
      this.term?.kill();
    } catch {
      /* already gone */
    }
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
