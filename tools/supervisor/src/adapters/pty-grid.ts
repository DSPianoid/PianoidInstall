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
}

/** Markers that identify FOOTER rows (the fixed bottom block — input box + hints). */
const FOOTER_MARKERS =
  /❯|Try ["“]|\? for shortcuts|for agents|gh auth login|\/effort|esc to interrupt|◈ max|⧉ In |^─{10,}$/;
/** A horizontal rule row (────…) — the footer block is fenced by these. */
const RULE_ROW = /^─{20,}$/;
/** Permission prompt markers. */
const PERM_HEADER = /Do you want to (\w+)\s+(.+?)\?/i;
const PERM_LIST = /❯?\s*1\.\s*Yes\b/i;
const PROMPT_ACTION = /^(Create file|Edit file|Read file|Run command|Write file|Delete file)$/i;
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

  /** Detect a pending PERMISSION prompt on the grid (footer region carries it). */
  detectPermission(): GridPermission | null {
    const rows = this.allRows().map((r) => r.replace(/\s+$/, ''));
    // find the "Do you want to <verb> <target>?" row with a numbered list nearby
    let headerIdx = -1;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (PERM_HEADER.test(rows[i]!)) {
        headerIdx = i;
        break;
      }
    }
    if (headerIdx < 0) return null;
    // require the numbered list ("❯ 1. Yes") within a few rows below the header
    const hasList = rows.slice(headerIdx, headerIdx + 6).some((r) => PERM_LIST.test(r));
    if (!hasList) return null;
    const m = rows[headerIdx]!.match(PERM_HEADER)!;
    const verb = m[1]!;
    let target = (m[2] ?? '').trim();
    // The action header ("Create file") + the filename appear a few rows ABOVE the
    // question. The FILENAME is the FIRST plain-path row immediately AFTER the action
    // header (later rows are the diff preview, e.g. "  1 PROBE-OK-98765" — NOT the
    // filename). So capture the filename ONCE, right after the action, then stop.
    let action: string | undefined;
    let filename: string | undefined;
    for (let i = Math.max(0, headerIdx - 6); i < headerIdx; i++) {
      const t = rows[i]!.trim();
      if (PROMPT_ACTION.test(t)) {
        action = t;
        filename = undefined; // reset; the next plain row is the filename
      } else if (action && filename === undefined && /^[\w][\w./\\-]*$/.test(t) && !/^\d/.test(t) && !PERM_LIST.test(t)) {
        filename = t; // first path-like row after the action = the filename
      }
    }
    if (filename) target = filename;
    return permissionFromHeader(verb, target, action);
  }

  /** Detect the first-run TRUST GATE on the grid. */
  detectTrustGate(): boolean {
    return this.allRows().some((r) => TRUST_GATE.test(r));
  }

  /** Is the input box rendered + idle (no pending prompt)? = turn-ready / turn-complete. */
  isInputReady(): boolean {
    const rows = this.allRows();
    const { footerRows } = this.regions(rows);
    const hasInputBox = footerRows.some((r) => /❯\s*(Try ["“]|$)/.test(r.trim()) || /\? for shortcuts/.test(r));
    return hasInputBox && !this.detectPermission();
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
    if (/^[✽✻✶✢✼✺◌✦✧✩∗*·•◦]/.test(t)) return true; // leading animation rune
    if (/^\p{Lu}[\p{Ll}-]+…\s*$/u.test(t)) return true; // a bare gerund "Word…" status row
    if (/^[\p{L}][\p{L} -]*…\s*(\(?\d+s\b|·|esc to interrupt|↑|↓|tokens?)/u.test(t)) return true; // "Gerund… (Ns · …)"
    if (/\(\s*\d+s\b/.test(t) || /[↑↓]\s*\d+\s*tokens?/.test(t) || /esc to interrupt/i.test(t)) return true; // timer/token/interrupt chrome
    if (/^[\w-]+…\s+for\s+\d+s/.test(t)) return true; // "Baked for 6s"-style
    return false;
  }
  private argToInput(name: string, arg: string): Record<string, unknown> {
    const a = arg.trim();
    if (name === 'Bash') return { command: a };
    if (name === 'Write' || name === 'Edit' || name === 'Read') return { file_path: a };
    return { arg: a };
  }
}
