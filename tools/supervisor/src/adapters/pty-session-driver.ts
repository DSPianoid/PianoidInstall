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

import { homedir, tmpdir } from 'node:os';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
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
  /**
   * Settle-poll cycles to wait before the ANTI-HANG fallback ends a turn that never
   * produced its own new answer (currentTurnAnswer() stayed undefined). Default
   * IDENTICAL_ANSWER_FALLBACK_CYCLES (~40 ≈ 10s at the default settle). Exposed for tests.
   */
  identicalAnswerFallbackCycles?: number;
  /**
   * NO-DEADLOCK bound for the turn QUEUE. A queued turn is only typed when the TUI's
   * input box is idle (grid.isInputReady() — which also excludes a pending permission
   * prompt). If the input box NEVER becomes ready (a wedged TUI that never re-renders
   * the box), the queued turn would hang forever — re-introducing the very bug class
   * we fix. After this many ms waiting to type the HEAD turn, the driver surfaces an
   * error result for that turn (drops it from the queue) rather than hang. Default
   * INPUT_READY_TIMEOUT_MS (~60s). Exposed for tests.
   */
  inputReadyTimeoutMs?: number;
  /** Inject the @xterm/headless Terminal ctor (tests). Default = dynamic import. */
  gridCtor?: XtermCtor;
  /** Optional sink for the raw render stream (diagnostics; never the secret). */
  onRaw?: (chunk: string) => void;
  /**
   * CONTAINMENT SEAL (orchestrator profile). The PTY child is a REAL `claude`
   * process → it loads the user's full ~/.claude.json, which includes the
   * production telegram PLUGIN (mcp__plugin_telegram_telegram__*). Left unsealed, a
   * hosted TEST orchestrator can reach the user's PRODUCTION channel (an isolation
   * breach + wrong-channel bug — observed live 2026-06-15). When true, buildArgs
   * seals the child:
   *   - --strict-mcp-config --mcp-config <curated work servers from opts.mcpServers>
   *     → the child uses ONLY the supervisor's servers, IGNORING ~/.claude.json's.
   *   - --settings '{"enabledPlugins":{"<id>":false}}' for each pluginDisableIds →
   *     disables the telegram PLUGIN (which --strict-mcp-config does NOT cover, since
   *     a plugin is not an mcpServers entry).
   *   - --disallowed-tools (opts.disallowedTools + the telegram tool globs) →
   *     belt-and-suspenders deny.
   * In PTY mode the in-process supervisor_channel reply tool is UNREACHABLE (a
   * separate process can't receive an SDK instance), so the sealed orchestrator
   * reaches the user via plain ASSISTANT TEXT (the supervisor forwards it). Off by
   * default (demo profile / tests).
   */
  sealContainment?: boolean;
  /** Plugin ids to disable via --settings enabledPlugins (default: the telegram plugin). */
  pluginDisableIds?: string[];
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

/** The production telegram PLUGIN ids disabled by the containment seal (default). */
const DEFAULT_DISABLE_PLUGIN_IDS = ['telegram@claude-plugins-official'];
/**
 * Settle-poll cycles to wait before the stale-answer guard ACCEPTS an answer equal to the
 * prior turn's (the rare legitimately-identical reply). ~40 cycles × settleMs(250) ≈ 10 s —
 * long after a genuinely-new answer would have latched, so this only fires when a turn truly
 * repeats the prior answer (prevents a hang) and never lets the stale-resend through early.
 */
const IDENTICAL_ANSWER_FALLBACK_CYCLES = 40;
/**
 * NO-DEADLOCK bound for a QUEUED turn waiting for the input box to be idle before it's
 * typed. If the TUI never renders an idle input box (wedged), the queued turn is dropped
 * with an error result after this long rather than hang forever (~60s default).
 */
const INPUT_READY_TIMEOUT_MS = 60000;
/** Telegram tool globs denied by the seal (belt-and-suspenders). */
const TELEGRAM_TOOL_GLOBS = ['mcp__plugin_telegram_telegram__*', 'mcp__telegram__*'];

/**
 * Keep only SPAWNABLE MCP servers (stdio `command`, or http/sse `url`/`type`). An
 * in-process SDK server (e.g. the supervisor_channel reply tool, an SDK instance
 * with neither) CANNOT be passed to a child process via --mcp-config → it's dropped.
 * Exported for the seal's unit test.
 */
export function filterSpawnableMcpServers(
  servers: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, cfg] of Object.entries(servers)) {
    if (!cfg || typeof cfg !== 'object') continue;
    const c = cfg as Record<string, unknown>;
    const spawnable =
      typeof c['command'] === 'string' ||
      typeof c['url'] === 'string' ||
      c['type'] === 'http' ||
      c['type'] === 'sse' ||
      c['type'] === 'stdio';
    if (spawnable) out[name] = cfg;
  }
  return out;
}

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
  /** Temp --mcp-config file written for the seal (deleted on stop). */
  private mcpConfigPath: string | null = null;
  /**
   * Turn-complete de-dup. The TUI repaints the input box "❯" many times per turn
   * (spinner frames, redraws). We surface AT MOST ONE `result` per turn: armed on
   * send(), fired on the first settled "input box idle" after the turn, then
   * suppressed until the next turn. Without this the lifecycle sees bogus results.
   */
  private turnResultEmitted = false;
  /** True once real content (assistant text / tool) arrived for the current turn (diagnostic). */
  private turnHadContent = false;
  /** True between TYPING a turn and its surfaced result — gates the turn-complete de-dup. */
  private turnInFlight = false;
  /**
   * INBOUND TURN QUEUE (#5 fix). send() ENQUEUES the turn text here; it is NOT typed
   * directly. A single drainer (drainQueue) types the HEAD turn into the PTY ONLY when
   * the TUI's input box is idle (grid.isInputReady() — excludes a pending permission
   * prompt AND a turn in flight). This serializes turns + waits for the TUI to be ready,
   * so a turn that arrives DURING boot or while a prior turn is mid-flight is held until
   * the box is ready instead of being typed into a busy/not-yet-rendered prompt and LOST
   * (the live "inbound never reached me" drop). FIFO → ordering preserved.
   */
  private pendingTurns: string[] = [];
  /** Wall-clock (ms) when the current HEAD turn began waiting to be typed (no-deadlock bound). */
  private headTurnWaitStart: number | null = null;
  /** Consecutive settled reads where the grid looked turn-complete (debounce vs a flash). */
  private turnCompleteStreak = 0;
  /** Settle-poll cycles elapsed this turn (for the identical-answer bounded fallback). */
  private turnPollCycles = 0;

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
   * --resume (FI restart), and — when sealContainment is set — the MCP CONTAINMENT
   * SEAL (--strict-mcp-config + --mcp-config + --settings enabledPlugins:false +
   * --disallowed-tools) so a hosted test session can NEVER reach the user's
   * production telegram plugin (the live isolation breach). allow/route is otherwise
   * governed by the render-driven permission router.
   */
  private buildArgs(opts: SessionStartOptions): string[] {
    const args: string[] = [];
    if (opts.model) args.push('--model', opts.model);
    if (opts.resume) args.push('--resume', opts.resume);
    // SECURITY-CRITICAL FIRST: the containment seal flags must come BEFORE
    // --append-system-prompt. The preamble value is MULTI-LINE (embedded newlines);
    // on Windows the `claude.cmd` shim truncates the spawned command line at the first
    // newline in an argument, dropping everything after it. With --append-system-prompt
    // LAST, a truncation only loses preamble prose — never the seal (which would
    // re-open the production-telegram breach). Verified live: with the seal AFTER the
    // multiline preamble, --strict-mcp-config/--mcp-config never reached claude.exe.
    if (this.opts.sealContainment) {
      args.push(...this.buildSealArgs(opts));
    }
    // systemPrompt LAST: only the preset+append form maps to interactive (--append-…);
    // a bare string (demo persona) has no interactive flag → carried via the role turn
    // prefix instead, so we ignore it here. SANITIZE newlines → spaces: a raw newline in
    // a spawned-process argument truncates the `claude.cmd` command line on Windows (the
    // bug that dropped the seal). Collapsing to single-line preserves the full prompt
    // text without the truncation; paragraph structure isn't load-bearing for guidance.
    if (opts.systemPrompt && typeof opts.systemPrompt === 'object' && opts.systemPrompt.append) {
      const oneLine = opts.systemPrompt.append.replace(/\s*\r?\n\s*/g, ' ').trim();
      args.push('--append-system-prompt', oneLine);
    }
    return args;
  }

  /**
   * The CONTAINMENT SEAL flags (see PtySessionDriverOptions.sealContainment).
   * Writes the curated spawnable MCP servers (from opts.mcpServers, filtering OUT
   * the in-process supervisor_channel — a separate process can't receive an SDK
   * instance) to a temp file and returns: --strict-mcp-config --mcp-config <file>,
   * --settings disabling each plugin id, and --disallowed-tools for the telegram
   * tools (+ any opts.disallowedTools). Pure-ish (writes ONE temp file, tracked for
   * cleanup); the arg shape is unit-tested via spawnFn capture.
   */
  private buildSealArgs(opts: SessionStartOptions): string[] {
    const out: string[] = [];
    // 1) ONLY the supervisor's MCP servers; ignore ~/.claude.json's. The in-process
    //    supervisor_channel (no `command`/`url`/http|sse `type`) can't be spawned by
    //    a child → drop it (the orchestrator reaches the user via assistant text).
    const spawnable = filterSpawnableMcpServers(opts.mcpServers ?? {});
    try {
      const p = join(tmpdir(), `supervisor-mcp-${process.pid}-${Date.now()}.json`);
      writeFileSync(p, JSON.stringify({ mcpServers: spawnable }, null, 2));
      this.mcpConfigPath = p;
      out.push('--strict-mcp-config', '--mcp-config', p);
    } catch {
      // if we can't write the config, STILL pass --strict-mcp-config with an inline
      // empty set so the production servers are excluded (fail-CLOSED for the seal).
      out.push('--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: {} }));
    }
    // 2) disable the telegram PLUGIN (NOT covered by --strict-mcp-config — a plugin
    //    is not an mcpServers entry). One --settings JSON with enabledPlugins=false.
    const pluginIds = this.opts.pluginDisableIds ?? DEFAULT_DISABLE_PLUGIN_IDS;
    const enabledPlugins: Record<string, boolean> = {};
    for (const id of pluginIds) enabledPlugins[id] = false;
    out.push('--settings', JSON.stringify({ enabledPlugins }));
    // 3) belt-and-suspenders: deny the telegram tool globs (+ any caller deny-list).
    const deny = [...TELEGRAM_TOOL_GLOBS, ...(opts.disallowedTools ?? [])];
    out.push('--disallowed-tools', deny.join(' '));
    return out;
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
    this.scheduleSettle();
  }

  /** (Re)arm the settle timer to read the grid after the TUI quiets (or to retry a drain). */
  private scheduleSettle(): void {
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
      this.turnPollCycles += 1;
      // BOUNDED ANTI-HANG fallback: if a turn never produces its OWN new answer block
      // (currentTurnAnswer() stays undefined — e.g. it legitimately repeats the prior
      // answer, OR the new answer never rendered cleanly), the streak can never latch and
      // the turn would hang forever. After a generous wait (input idle + no spinner + a
      // real answer on screen, just == the prior), END the turn so it can't wedge.
      const idleWithAnswer =
        this.grid.isInputReady() && !this.grid.spinnerActive() && !!this.grid.currentAnswerText();
      const identicalFallback =
        idleWithAnswer &&
        !this.grid.currentTurnAnswer() &&
        this.turnPollCycles >= (this.opts.identicalAnswerFallbackCycles ?? IDENTICAL_ANSWER_FALLBACK_CYCLES);
      const streakComplete = this.grid.isTurnComplete();
      if (streakComplete) {
        this.turnCompleteStreak += 1;
      } else {
        this.turnCompleteStreak = 0;
      }
      const streakLatched = this.turnCompleteStreak >= (this.opts.turnCompleteStableNeeded ?? 3);
      if (streakLatched || identicalFallback) {
        this.turnResultEmitted = true;
        this.turnInFlight = false;
        this.turnCompleteStreak = 0;
        // ★STALE-ANSWER FIX (seq-221 self-diagnosis #2: "never let the fallback emit text
        // equal to priorTurnAnswer — defer/emit empty instead of resending the baseline").
        // Choose the result text PER PATH:
        //  - NORMAL path (streakLatched): isTurnComplete() was true → currentTurnAnswer()
        //    is GUARANTEED present + NOT equal to the prior turn's answer. Use it. We do
        //    NOT `?? currentAnswerText()`: that reads the LAST "●" block in the whole
        //    scrollback with NO staleness check, so if the new answer hasn't rendered it
        //    returns the PRIOR turn's answer → the byte-identical stale resend (the live
        //    bug: turn 2 re-sent turn 1's 2807-char answer verbatim).
        //  - ANTI-HANG fallback path: by construction currentTurnAnswer() is undefined
        //    (currentAnswerText() == priorTurnAnswer EXACTLY). The OLD code emitted
        //    currentAnswerText() here = the stale prior answer = THE BUG. We emit EMPTY
        //    instead: the turn completes (no wedge) but onResult sends nothing — far better
        //    than confidently resending a stale answer to a DIFFERENT question. A genuinely-
        //    identical legitimate reply becomes silence for that one turn (rare, acceptable);
        //    the user can rephrase. (The send-side idempotency guard in SessionHost is the
        //    additional backstop for any near-identical drift that slips the exact compare.)
        const finalText = streakLatched ? (this.grid.currentTurnAnswer() ?? this.lastAssistantText) : '';
        this.enqueue({ kind: 'result', sessionId: this.sessionId ?? '', subtype: 'success', result: finalText });
        // This turn is done (turnInFlight cleared) → a queued NEXT turn can now be typed
        // once the input box is idle. Drain it (the #5 serialized-turn-queue handoff).
        this.drainQueue();
      } else {
        // ★SELF-RESCHEDULE: the streak needs N CONSECUTIVE settled reads, but readGrid is
        // otherwise only driven by incoming PTY data (ingest). A FAST reply finishes and
        // the TUI goes SILENT before N reads accumulate → the streak stalls < N → the
        // result never fires → nothing forwards to the channel (the live "fast reply never
        // reaches the test bot" bug). So while a turn is in flight and not yet confirmed
        // complete, poll the settled grid ourselves until it latches — independent of
        // whether the TUI keeps repainting. (A new turn / stop / result clears this.)
        this.scheduleSettle();
      }
    } else {
      // No turn in flight: if a turn is QUEUED (waiting for boot / a prior turn / a
      // permission prompt to clear), retry the drain on this settled read. drainQueue
      // re-arms the settle poll itself while it waits, so this can't stall.
      if (this.pendingTurns.length > 0) this.drainQueue();
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

  /**
   * Inject a user turn. #5 FIX: ENQUEUE the turn — do NOT type it directly. A turn is
   * typed only when the TUI's input box is idle (drainQueue → grid.isInputReady()), so a
   * turn arriving during boot or while a prior turn is mid-flight is HELD (FIFO), not
   * typed into a busy/not-yet-rendered prompt and lost (the live inbound-drop). The
   * drainer is kicked here and re-runs on each settled grid read.
   */
  async send(turn: UserTurn): Promise<void> {
    if (this.setupPromise) await this.setupPromise; // wait for the eager spawn
    if (!this.term) throw new Error('pty session driver: not started');
    this.pendingTurns.push(turn.text);
    this.drainQueue();
  }

  /**
   * Drain the turn queue: if a turn is queued AND no turn is in flight AND the TUI input
   * box is idle (grid.isInputReady() — excludes a pending permission prompt), TYPE the
   * head turn. Otherwise (boot not finished / prior turn in flight / permission pending)
   * leave it queued and re-arm a settle poll to retry. NO-DEADLOCK (d): if the head turn
   * has waited longer than inputReadyTimeoutMs without the box becoming ready, surface an
   * error result + drop it (a wedged TUI must not hang the queue forever). Called from
   * send() and from readGrid() after each settle.
   */
  private drainQueue(): void {
    if (this.pendingTurns.length === 0) {
      this.headTurnWaitStart = null;
      return;
    }
    if (this.turnInFlight) return; // a turn is being processed — hold the rest
    if (!this.term) return;
    // Ready to type? input box idle + not booting + no pending permission prompt.
    if (this.grid.isInputReady()) {
      this.headTurnWaitStart = null;
      const text = this.pendingTurns.shift()!;
      this.typeTurn(text);
      return;
    }
    // NOT ready — bound the wait so the queue can't deadlock on a wedged TUI.
    if (this.headTurnWaitStart === null) this.headTurnWaitStart = Date.now();
    const waited = Date.now() - this.headTurnWaitStart;
    const limit = this.opts.inputReadyTimeoutMs ?? INPUT_READY_TIMEOUT_MS;
    if (waited >= limit) {
      // give up on this head turn: drop it + surface an error so the caller/operator
      // knows it wasn't delivered (never silently hang).
      this.pendingTurns.shift();
      this.headTurnWaitStart = null;
      this.enqueue({
        kind: 'result',
        sessionId: this.sessionId ?? '',
        subtype: 'error',
        result: 'turn not delivered: the session input box never became ready (TUI wedged)',
      });
      // try the next queued turn (if any) on the next poll.
    }
    // re-arm a settle poll to retry the drain (independent of incoming PTY data).
    this.scheduleSettle();
  }

  /** Type a turn into the PTY: reset per-turn state, snapshot the stale-answer baseline, write + submit. */
  private typeTurn(text: string): void {
    if (!this.term) return;
    // New turn → re-arm the turn-complete de-dup (one result per turn).
    this.turnResultEmitted = false;
    this.turnHadContent = false;
    this.turnInFlight = true;
    this.turnCompleteStreak = 0;
    this.turnPollCycles = 0;
    this.lastAssistantText = undefined;
    // STALE-ANSWER guard: snapshot the answer present NOW (the PRIOR turn's) as the
    // baseline, so the result for THIS turn can't be the previous turn's answer
    // byte-for-byte (the live "turn 2 re-sent turn 1's answer" bug).
    this.grid.markTurnStart();
    this.term.write(text);
    const delay = this.opts.submitDelayMs ?? 900;
    const submit = setTimeout(() => this.term?.write(SUBMIT_KEY), delay);
    if (submit && typeof submit === 'object' && 'unref' in submit) (submit as { unref: () => void }).unref();
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
    this.pendingTurns = []; // drop any queued-but-untyped turns
    this.headTurnWaitStart = null;
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
    // clean the temp --mcp-config file the seal wrote (best-effort).
    if (this.mcpConfigPath) {
      try {
        unlinkSync(this.mcpConfigPath);
      } catch {
        /* already gone / never written */
      }
      this.mcpConfigPath = null;
    }
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
