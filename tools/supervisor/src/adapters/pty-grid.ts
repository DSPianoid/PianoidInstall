/**
 * GRID-AWARE TUI reader for the interactive `claude` PTY (Option-3c, A-variant).
 *
 * Replaces the line-flatten parser (pty-render-parser) with a real 2D terminal
 * grid via `@xterm/headless`. The driver feeds every node-pty `onData` chunk into
 * `write()`; on turn-complete it calls `readNewEvents()` which reads the MESSAGE
 * REGION (the rows ABOVE the fixed footer block) and emits the NEW assistant /
 * tool-result / text rows since the last read.
 *
 * Why a grid (proven 2026-06-15, design §(f)/option-A feasibility): the TUI writes
 * the assistant reply and the footer hint bar to DIFFERENT screen ROWS via cursor
 * positioning. Flattening the byte stream into "lines" glued them together (the
 * line-flatten parser's failure). A grid that honors terminal geometry places the
 * footer in fixed bottom rows and the conversation above → CLEAN extraction. The
 * "●" (assistant) / "⎿" (tool-result) glyphs make those row types separable.
 *
 * This module owns ONLY the screen model + region reads. The PtySessionDriver still
 * owns the lifecycle, the permission round-trip (router → keystroke), and the trust
 * pre-set; it asks this module WHAT is on screen.
 */

import type { ToolUse } from '../session-driver.js';
import { permissionFromHeader } from './pty-render-parser.js';

// xterm-headless is CJS; import the Terminal type loosely (resolved at runtime).
// We keep the surface minimal so this file type-checks without xterm's d.ts.
interface XtermLine {
  translateToString(trimRight?: boolean): string;
}
interface XtermBuffer {
  length: number;
  baseY: number;
  cursorY: number;
  getLine(y: number): XtermLine | undefined;
}
interface XtermTerminal {
  buffer: { active: XtermBuffer };
  write(data: string | Uint8Array, cb?: () => void): void;
  dispose(): void;
}
export type XtermCtor = new (opts: Record<string, unknown>) => XtermTerminal;

/** A normalized thing read off the grid (parallels the render-parser's events). */
export type GridEvent =
  | { kind: 'assistant'; text: string; toolUses?: ToolUse[] }
  | { kind: 'tool_result'; toolUseId: string; content: string };

/** A pending permission prompt detected on the grid. */
export interface GridPermission {
  toolName: string;
  input: Record<string, unknown>;
  /**
   * True if this is the `$()` COMMAND-SUBSTITUTION security gate (the prompt block
   * carried the "Command contains subexpressions $()…" advisory). This is a Claude
   * Code security overlay that fires EVEN when the tool (Bash) is allow-listed and
   * is NOT suppressible by any documented env-var/settings field (confirmed). The
   * driver uses this flag to PRE-ALLOW the orchestrator's OWN routine `$()` startup
   * commands (auto-answer "1. Yes" without routing) while genuinely destructive
   * `$()` commands still route through the safety floor.
   */
  subexpressionGate?: boolean;
}

/** Markers that identify FOOTER rows (the fixed bottom block — input box + hints). */
// Includes persistent STATUS BANNERS Claude Code pins to the bottom (e.g.
// "✘ Auto-update failed: claude.exe in use … · Run /doctor"). Without these in the
// footer set, regions() stops the footer walk at the banner and EXCLUDES the input
// box above it → isInputReady() returns false → a completed turn never latches →
// the reply never forwards (the live "fast follow-up reply silent" bug).
const FOOTER_MARKERS =
  /❯|Try ["“]|\? for shortcuts|for agents|gh auth login|\/effort|esc to interrupt|◈ max|⧉ In |^─{10,}$|^[✘✗⚠⛔]|Auto-update|Run \/doctor|\/doctor\b|update failed/;
/** A horizontal rule row (────…) — the footer block is fenced by these. */
const RULE_ROW = /^─{20,}$/;
/** Permission prompt markers. */
// The SPECIFIC file-action header ("Do you want to create probe.txt?") — verb + target.
const PERM_HEADER = /Do you want to (\w+)\s+(.+?)\?/i;
// The GENERIC permission QUESTION — ANY "Do you want to …?" incl. "proceed?" (the
// $()-subexpression gate renders "Do you want to proceed?" with no target → the
// specific PERM_HEADER misses it → the prompt goes undetected → the child HANGS).
const PERM_QUESTION = /Do you want to .*\?|Do you want to proceed/i;
const PERM_LIST = /❯?\s*1\.\s*Yes\b/i;
// The numbered "1./2./3." options + an "Esc to cancel"/"No" footer = the permission
// block signature (used to confirm a generic prompt even without a file action).
const PERM_NO_OPTION = /^\s*3\.\s*No\b|Esc to cancel/i;
const PROMPT_ACTION = /^(Create file|Edit file|Read file|Run command|Write file|Delete file)$/i;
// The $()-subexpression gate body line ("Command contains subexpressions $()…").
const PERM_SUBEXPR = /subexpressions?|contains?\s+\$\(/i;
/** Trust gate marker. */
const TRUST_GATE = /Is this a project you created or one you trust|Do you trust the files/i;
/** Assistant response glyph / tool-result glyph (start-of-row). */
const ASSISTANT_GLYPH = /^[●•]\s*(.*)$/;
const TOOLRESULT_GLYPH = /^⎿\s*(.*)$/;
const TOOL_INDICATOR = /^[●•]\s*([A-Z][A-Za-z_]+)\(([^)]*)\)\s*$/;

export interface GridScreenOptions {
  cols?: number;
  rows?: number;
  /** Inject the xterm Terminal ctor (tests). Default = dynamic import of @xterm/headless. */
  termCtor?: XtermCtor;
}

export class GridScreen {
  private term: XtermTerminal | null = null;
  private readonly cols: number;
  private readonly rows: number;
  private readonly ctorOverride?: XtermCtor;
  /** Content of message rows already surfaced (de-dup across reads, content-keyed). */
  private surfaced = new Set<string>();
  /**
   * The answer text present at THIS turn's submission (= the PRIOR turn's answer, still
   * in the message region/scrollback). currentTurnAnswer() refuses to return a block equal
   * to this, so a completed turn can never re-emit the previous turn's answer byte-for-byte
   * (the live STALE-ANSWER bug: turn 2 "What MCP tools" re-sent turn 1's answer because the
   * new answer hadn't replaced the old one in the buffer when turn-complete latched).
   */
  private priorTurnAnswer: string | undefined;

  constructor(opts: GridScreenOptions = {}) {
    this.cols = opts.cols ?? 120;
    this.rows = opts.rows ?? 40;
    this.ctorOverride = opts.termCtor;
  }

  async init(): Promise<void> {
    if (this.term) return;
    const Ctor = this.ctorOverride ?? (await this.resolveCtor());
    this.term = new Ctor({ cols: this.cols, rows: this.rows, allowProposedApi: true, scrollback: 5000 });
  }

  private async resolveCtor(): Promise<XtermCtor> {
    const dynamicImport = new Function('s', 'return import(s)') as (s: string) => Promise<unknown>;
    const mod = (await dynamicImport('@xterm/headless')) as { Terminal?: XtermCtor; default?: { Terminal?: XtermCtor } };
    const T = mod.Terminal ?? mod.default?.Terminal;
    if (typeof T !== 'function') throw new Error('@xterm/headless: Terminal not found');
    return T;
  }

  /** Feed a raw PTY chunk into the grid. */
  write(chunk: string): void {
    this.term?.write(chunk);
  }

  /** All buffer rows (scrollback + viewport) as plain strings. */
  private allRows(): string[] {
    if (!this.term) return [];
    const buf = this.term.buffer.active;
    const out: string[] = [];
    for (let y = 0; y < buf.length; y++) {
      const line = buf.getLine(y);
      out.push(line ? line.translateToString(true) : '');
    }
    return out;
  }

  /**
   * Split the buffer into [messageRows, footerStartIndex]. The FOOTER is the
   * contiguous block of footer-ish rows at the bottom (the input box + hint bar,
   * fenced by ──── rules). Everything above the footer block is the message region.
   */
  private regions(rows: string[]): { messageRows: string[]; footerRows: string[] } {
    let lastNonEmpty = -1;
    for (let y = rows.length - 1; y >= 0; y--) {
      if (rows[y]!.trim()) {
        lastNonEmpty = y;
        break;
      }
    }
    if (lastNonEmpty < 0) return { messageRows: [], footerRows: [] };
    // Walk up from the bottom: footer rows are footer-ish OR empty. Stop at the
    // first content row that is NOT footer-ish (that's the last message row).
    let footerStart = lastNonEmpty + 1;
    for (let y = lastNonEmpty; y >= 0 && y > lastNonEmpty - 14; y--) {
      const t = rows[y]!.trim();
      if (!t || FOOTER_MARKERS.test(rows[y]!) || RULE_ROW.test(t)) {
        footerStart = y;
      } else {
        break;
      }
    }
    return {
      messageRows: rows.slice(0, footerStart),
      footerRows: rows.slice(footerStart).filter((r) => r.trim()),
    };
  }

  /**
   * Read the NEW message-region content since the last call → GridEvents.
   *
   * MODEL (from the heavy-turn repro 2026-06-15): an assistant ANSWER is a "● <text>"
   * head row followed by INDENTED CONTINUATION rows (no glyph) until the next
   * structural boundary (a "● Tool(…)" indicator, a "⎿" result, a "────" rule, the
   * input box, or a spinner/status row). A tool USE is "● Tool(arg)"; a tool RESULT
   * is "⎿ …". Everything else (boot banner, input echo, spinner/status, footer
   * chrome) is REJECTED — there is NO trust-any-unmatched-row catch-all (that was the
   * spinner-leak vector). The assistant answer is assembled as the head + its
   * continuation rows, so a multi-row reply (lists, the final token on its own line)
   * comes through whole and clean.
   *
   * De-dup is content-keyed across reads (the TUI repaints rows in place).
   */
  readNewEvents(): GridEvent[] {
    const rows = this.allRows();
    const { messageRows } = this.regions(rows);
    const events: GridEvent[] = [];

    let answer: string[] = []; // accumulating an assistant answer block
    const flushAnswer = (): void => {
      if (answer.length === 0) return;
      const text = answer.join('\n').replace(/\s+$/g, '').trim();
      answer = [];
      if (text && !this.surfaced.has(text)) {
        this.surfaced.add(text);
        events.push({ kind: 'assistant', text, toolUses: [] });
      }
    };

    for (const raw of messageRows) {
      const row = raw.replace(/\s+$/, '');
      const t = row.trim();
      if (!t) {
        // A blank row is a PARAGRAPH BREAK within an answer, NOT a boundary — keep the
        // block open (the answer often has blank lines between sections + the final
        // token on its own line). Only a STRUCTURAL element below ends the answer.
        if (answer.length > 0) answer.push('');
        continue;
      }
      if (this.isBanner(row) || this.isInputEcho(row) || this.isStatusRow(row)) {
        flushAnswer(); // a boundary
        continue;
      }
      const tool = t.match(TOOL_INDICATOR);
      if (tool) {
        flushAnswer();
        const name = tool[1]!;
        const arg = tool[2]!;
        const sig = `tooluse:${name}(${arg})`;
        if (!this.surfaced.has(sig)) {
          this.surfaced.add(sig);
          events.push({ kind: 'assistant', text: '', toolUses: [{ id: `pty-${name}`, name, input: this.argToInput(name, arg) }] });
        }
        continue;
      }
      const tr = t.match(TOOLRESULT_GLYPH);
      if (tr) {
        flushAnswer();
        const content = tr[1]!.trim();
        const sig = `toolres:${content}`;
        if (content && !this.surfaced.has(sig)) {
          this.surfaced.add(sig);
          events.push({ kind: 'tool_result', toolUseId: 'pty-last', content });
        }
        continue;
      }
      const a = t.match(ASSISTANT_GLYPH);
      if (a) {
        // "● <text>" = the HEAD of a new assistant answer block.
        flushAnswer();
        answer.push(a[1]!);
        continue;
      }
      // An INDENTED continuation row of the current answer block (no glyph). Accumulate
      // it IF an answer block is open (a "●" head was seen); a stray no-glyph row with
      // NO open block is chrome/noise → ignored (no trust-any-row catch-all).
      if (answer.length > 0) answer.push(row);
    }
    flushAnswer();
    return events;
  }

  /**
   * The current FULL assistant answer text in the grid (the latest "●" answer block +
   * its continuation rows). Used by the driver as the turn's result text — robust to
   * the spinner being the last-rendered row (the spinner is not an answer block).
   */
  currentAnswerText(): string | undefined {
    const rows = this.allRows();
    const { messageRows } = this.regions(rows);
    // Track the LAST NON-EMPTY answer block. A trailing boundary (e.g. the spinner
    // "✻ Baked for 6s" that renders AFTER the answer) closes the current block but
    // must NOT erase the answer we already accumulated — so we save it to `last`
    // before resetting. The final answer = the last completed (or still-open) block.
    let block: string[] = [];
    let last: string[] = [];
    const close = (): void => {
      if (block.some((r) => r.trim())) last = block;
      block = [];
    };
    for (const raw of messageRows) {
      const row = raw.replace(/\s+$/, '');
      const t = row.trim();
      if (!t) { if (block.length) block.push(''); continue; } // paragraph break, keep open
      // A horizontal rule (────…) FENCES the footer/answer — it ends the answer block (it
      // is chrome, not answer text; leaking it appended "────…" to the reply).
      if (RULE_ROW.test(t)) { close(); continue; }
      if (this.isBanner(row) || this.isInputEcho(row) || this.isStatusRow(row)) { close(); continue; }
      if (TOOL_INDICATOR.test(t) || TOOLRESULT_GLYPH.test(t)) { close(); continue; }
      const a = t.match(ASSISTANT_GLYPH);
      if (a) { close(); block = [a[1]!]; continue; } // a NEW "●" head starts a fresh answer
      if (block.length > 0) block.push(row);
    }
    close();
    const text = last.join('\n').replace(/\s+$/g, '').trim();
    return text || undefined;
  }

  /**
   * Snapshot the CURRENT answer as the prior-turn baseline. The driver calls this when it
   * SUBMITS a turn — so the answer visible at that instant is the previous turn's, and
   * currentTurnAnswer() will refuse to return it (forcing the wait for the genuinely-new
   * answer). Prevents the stale byte-identical resend across consecutive turns.
   */
  markTurnStart(): void {
    this.priorTurnAnswer = this.currentAnswerText();
  }

  /**
   * The answer for the CURRENT turn: currentAnswerText(), but UNDEFINED while it still
   * equals the prior-turn baseline (the new answer hasn't rendered yet). The driver uses
   * THIS for the result text + turn-complete, so a turn never emits the previous turn's
   * answer. (If two turns legitimately produce identical text, the driver's bounded
   * fallback eventually accepts it — see PtySessionDriver turn-complete.)
   */
  currentTurnAnswer(): string | undefined {
    const ans = this.currentAnswerText();
    if (ans !== undefined && ans === this.priorTurnAnswer) return undefined; // still the prior answer
    return ans;
  }

  /**
   * Detect a pending PERMISSION prompt on the grid. Handles BOTH:
   *  - the SPECIFIC file action ("Create file / <name> / Do you want to create <name>?")
   *  - the GENERIC block ("Do you want to proceed?" + "1./2./3." options + "Esc to
   *    cancel") — e.g. the $()-subexpression gate on a shell command. The earlier
   *    detector only matched the file format, so the generic gate went undetected and
   *    the child HUNG waiting at the prompt (the live /orchestrator-startup bug).
   * Returns a {toolName, input} for the router, or null if no prompt is rendered.
   */
  detectPermission(): GridPermission | null {
    const rows = this.allRows().map((r) => r.replace(/\s+$/, ''));
    // Find the permission QUESTION row (search from the bottom — it's near the footer).
    let qIdx = -1;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (PERM_QUESTION.test(rows[i]!)) {
        qIdx = i;
        break;
      }
    }
    // ROBUSTNESS — the UNIVERSAL signature: even if the QUESTION wording is unrecognized
    // (a prompt variant we didn't anticipate), a numbered "❯ 1. Yes" list + a "3. No"/
    // "Esc to cancel" footer is UNMISTAKABLY a permission prompt. If we see that structure
    // but no matched question, STILL return a generic request — so an unanticipated prompt
    // is ROUTED (the router + safety floor decide), NEVER ignored → the child never HANGS
    // silently on an unparsed prompt. This is the structural guard for the $()-gate class.
    if (qIdx < 0) {
      // NOT the first-run trust gate (it ALSO has a "❯ 1. Yes …" list + Esc — but it's
      // handled by detectTrustGate → Enter, not the permission router).
      if (rows.some((r) => TRUST_GATE.test(r))) return null;
      const hasList = rows.some((r) => PERM_LIST.test(r));
      const hasCancel = rows.some((r) => PERM_NO_OPTION.test(r));
      if (hasList && hasCancel) {
        // pull a context line for the request (a "● Tool(arg)" indicator, else generic).
        let toolName = 'Bash';
        let command = 'unrecognized permission prompt';
        for (let i = rows.length - 1; i >= 0 && i > rows.length - 14; i--) {
          const m = rows[i]!.trim().match(TOOL_INDICATOR);
          if (m) {
            toolName = m[1]!;
            command = m[2]!;
            break;
          }
        }
        const subexpressionGate = rows.some((r) => PERM_SUBEXPR.test(r));
        return { toolName, input: toolName === 'Bash' ? { command } : { arg: command }, subexpressionGate };
      }
      return null;
    }
    // CONFIRM it's a real permission block: a "1. Yes" list AND a "3. No"/"Esc to cancel"
    // within a few rows below the question (guards against a stray "do you want…" in prose).
    const below = rows.slice(qIdx, qIdx + 8);
    if (!below.some((r) => PERM_LIST.test(r)) || !below.some((r) => PERM_NO_OPTION.test(r))) return null;

    // (A) SPECIFIC file action: "Do you want to <verb> <target>?" with a "Create file"
    //     header + filename a few rows above.
    const fileM = rows[qIdx]!.match(PERM_HEADER);
    if (fileM && fileM[2] && fileM[2].trim()) {
      const verb = fileM[1]!;
      let target = fileM[2].trim();
      let action: string | undefined;
      let filename: string | undefined;
      for (let i = Math.max(0, qIdx - 6); i < qIdx; i++) {
        const t = rows[i]!.trim();
        if (PROMPT_ACTION.test(t)) {
          action = t;
          filename = undefined;
        } else if (action && filename === undefined && /^[\w][\w./\\-]*$/.test(t) && !/^\d/.test(t) && !PERM_LIST.test(t)) {
          filename = t;
        }
      }
      if (filename) target = filename;
      return permissionFromHeader(verb, target, action);
    }

    // (B) GENERIC block ("Do you want to proceed?"). Build the request from the prompt
    //     BODY a few rows above the question: a "● Tool(arg)" indicator names the
    //     tool+arg; otherwise the command/context line (e.g. the $()-subexpr command).
    //     Default to a Bash permission carrying the command text so the router + the
    //     safety floor see it; an unknown shape still routes to the user (never auto-allowed).
    let command = '';
    let toolName = 'Bash';
    let subexpressionGate = false;
    for (let i = Math.max(0, qIdx - 10); i < qIdx; i++) {
      const t = rows[i]!.trim();
      if (!t) continue;
      const tool = t.match(TOOL_INDICATOR);
      if (tool) {
        toolName = tool[1]!;
        command = tool[2]!;
        continue; // a later body line may refine the command, but the tool name stands
      }
      // the "Command contains subexpressions $()…" advisory or a quoted command line
      if (PERM_SUBEXPR.test(t)) {
        subexpressionGate = true; // this IS the $() security gate (label it for the pre-allow)
        continue; // it's the advisory, not the command itself
      }
      // a plausible command/argument line (not chrome / a menu option / the question)
      if (!/^\d+\.\s/.test(t) && !PERM_QUESTION.test(t) && !PERM_NO_OPTION.test(t) && /[\w$./\\-]/.test(t)) {
        if (t.length > command.length) command = t; // prefer the most specific body line
      }
    }
    return {
      toolName,
      input: toolName === 'Bash' ? { command: command || '(shell command)' } : { arg: command },
      subexpressionGate,
    };
  }

  /** Detect the first-run TRUST GATE on the grid. */
  detectTrustGate(): boolean {
    return this.allRows().some((r) => TRUST_GATE.test(r));
  }

  /**
   * A coarse SIGNATURE of the current screen content (all non-empty rows joined). Used by
   * the driver to detect "the screen changed since the last settled read" = the engine is
   * still WORKING/rendering (a spinner frame advancing, an elapsed-timer/token-counter
   * ticking, new answer rows appearing). A STABLE signature across reads = a genuinely
   * static screen. This is what makes the destructive timeouts (anti-hang fallback,
   * no-deadlock drop) count only on real inactivity, never mid-think.
   */
  signature(): string {
    return this.allRows().filter((r) => r.trim()).join('\n');
  }

  /** Is a working SPINNER currently rendered? = the engine is mid-turn (NOT complete). */
  spinnerActive(): boolean {
    // scan the last ~8 non-empty rows for a spinner/status row (the spinner lives just
    // above/below the footer while the engine works).
    const rows = this.allRows().filter((r) => r.trim());
    const tail = rows.slice(-8);
    // AUTHORITATIVE completion signal: once Claude Code prints the past-tense summary
    // "✻ Crunched/Baked/… for Ns", the turn has ENDED — even if a stale in-progress
    // frame ("Precipitating… (Ns · tokens)") still lingers in the buffer above it. So a
    // completion summary in the tail overrides any lingering active-looking row → NOT a
    // spinner. (This was the USER-SILENCE bug: the lingering frame + the mis-classified
    // summary both read as "working" → the result never fired.)
    if (tail.some((r) => this.isCompletionSummary(r.trim()))) return false;
    return tail.some((r) => this.isStatusRow(r));
  }

  /** Is the input box rendered + idle (no pending prompt)? (low-level — may flash mid-turn). */
  isInputReady(): boolean {
    const rows = this.allRows();
    const { footerRows } = this.regions(rows);
    const isInputRow = (r: string): boolean => /❯\s*(Try ["“]|$)/.test(r.trim()) || /\? for shortcuts/.test(r);
    // PRIMARY: the idle input box in the footer region. BELT-AND-SUSPENDERS: also scan
    // the last ~12 rows directly — an UNEXPECTED persistent bottom banner (e.g. the
    // "✘ Auto-update failed … /doctor" line) can perturb the region split and hide the
    // input box from footerRows; scanning the tail directly makes input-detection robust
    // to any such chrome (this was the live fast-follow-up-reply silence bug).
    const tail = rows.slice(-12);
    const hasInputBox = footerRows.some(isInputRow) || tail.some(isInputRow);
    return hasInputBox && !this.detectPermission();
  }

  /**
   * STRICT turn-complete: the input box is idle AND a real assistant ANSWER is present
   * AND no spinner is active AND no permission prompt is pending. This guards against
   * the PREMATURE turn-complete bug — the input box flashes "❯" transiently at the very
   * start of a turn (before the engine produces output), which `isInputReady` alone
   * would mistake for completion (the live bug fired a result ~3 s into a long startup).
   * The driver additionally requires this to hold across a debounce of consecutive reads.
   */
  isTurnComplete(): boolean {
    if (!this.isInputReady()) return false;
    if (this.spinnerActive()) return false; // engine still working
    if (this.detectPermission()) return false; // a prompt is pending (would hang, not complete)
    // Require the CURRENT turn's answer (not equal to the prior turn's) — so a turn that
    // hasn't produced its OWN new answer yet is NOT complete (the stale-resend guard).
    const ans = this.currentTurnAnswer();
    return !!ans && ans.trim().length > 0;
  }

  dispose(): void {
    try {
      this.term?.dispose();
    } catch {
      /* ignore */
    }
    this.term = null;
    this.surfaced.clear();
  }

  // ── helpers ────────────────────────────────────────────────────────────────
  private isBanner(row: string): boolean {
    const t = row.trim();
    // boot banner art + the version/model/cwd header lines
    return (
      /^[▐▛███▜▌▝▜▘]/.test(t) ||
      /Claude Code v[\d.]+|·\s*Claude Max|Claude Max$/.test(t) ||
      /^(Opus|Sonnet|Haiku)\s+[\d.]/.test(t) ||
      /What's new|Session titles|footerLinksRegexes|Bedrock|release-notes/.test(t)
    );
  }
  private isInputEcho(row: string): boolean {
    // the user's typed-turn echo line starts with the input prompt "❯ "
    return /^❯\s/.test(row.trim());
  }
  private isStatusRow(row: string): boolean {
    const t = row.trim();
    // Claude Code's WORKING SPINNER renders as: a (sometimes-absent after cell-render)
    // leading animation rune + a random GERUND verb ending in "…" (Orchestrating… /
    // Pondering… / Noodling… / Dilly-dallying…), OR an elapsed/interrupt/token status
    // ("Baked for 6s", "(3s · ↑ 231 tokens)", "esc to interrupt"). We match the
    // PATTERN, NOT a hardcoded word list, and NOT only the rune-anchored form (the
    // gerund frame can lack a leading rune → that was the live spinner LEAK).
    //
    // NOTE: this is "is this row STATUS/SPINNER CHROME to exclude from answer content?".
    // It returns TRUE for BOTH an active spinner AND the past-tense completion summary
    // ("✻ Crunched for Ns") — both are chrome, neither belongs in the answer text. The
    // "engine actively WORKING?" question is separate → spinnerActive() (which excludes
    // the completion summary via isCompletionSummary), so a completed turn is recognized.
    if (/^[✽✻✶✢✼✺◌✦✧✩∗*·•◦]/.test(t)) return true; // leading animation rune
    if (/^\p{Lu}[\p{Ll}-]+…\s*$/u.test(t)) return true; // a bare gerund "Word…" status row
    if (/^[\p{L}][\p{L} -]*…\s*(\(?\d+s\b|·|esc to interrupt|↑|↓|tokens?)/u.test(t)) return true; // "Gerund… (Ns · …)"
    if (/\(\s*\d+s\b/.test(t) || /[↑↓]\s*\d+\s*tokens?/.test(t) || /esc to interrupt/i.test(t)) return true; // timer/token/interrupt chrome
    if (/^[\w-]+…\s+for\s+\d+s/.test(t)) return true; // "Baked for 6s"-style
    return false;
  }

  /**
   * The COMPLETED-turn summary marker (NOT an active spinner): a (optional) leading
   * animation rune + a PAST-TENSE verb + "for <time>", with NO trailing "…" and no
   * active "(Ns · tokens)" / "esc to interrupt" chrome. E.g. "✻ Crunched for 3m 28s",
   * "✻ Baked for 6s", "✻ Cooked for 12s", "✻ Sautéed for 1s". When this appears (the
   * turn has ended), spinnerActive() must NOT classify the screen as still working —
   * otherwise isTurnComplete() never fires and the finished answer is never surfaced
   * (the live USER-SILENCE bug). It is STILL status chrome (kept out of answer text by
   * isStatusRow); this predicate only governs the "actively working?" decision.
   */
  private isCompletionSummary(t: string): boolean {
    if (/…/.test(t)) return false; // a "…" means an ACTIVE gerund, never a completion
    if (/esc to interrupt/i.test(t) || /[↑↓]\s*\d+\s*tokens?/.test(t) || /\(\s*\d+s\b/.test(t)) return false; // active chrome
    // [rune] <Word> for <time> — past-tense "Verbed for <Ns>" / "Verbed for <Nm Ns>".
    // \p{L} so accented verbs ("Sautéed") match.
    return /^[✽✻✶✢✼✺◌✦✧✩∗*·•◦]?\s*\p{Lu}[\p{L}]+\s+for\s+\d+m?\s*\d*s\b/u.test(t);
  }
  private argToInput(name: string, arg: string): Record<string, unknown> {
    const a = arg.trim();
    if (name === 'Bash') return { command: a };
    if (name === 'Write' || name === 'Edit' || name === 'Read') return { file_path: a };
    return { arg: a };
  }
}
