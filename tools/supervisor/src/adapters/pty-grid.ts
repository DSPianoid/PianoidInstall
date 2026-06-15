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
   * Read the NEW message-region content since the last call → GridEvents. We track
   * how many message rows were already surfaced so repeated reads (the TUI repaints
   * constantly) don't re-emit. Returns assistant-text + tool-result events in order.
   */
  readNewEvents(): GridEvent[] {
    const rows = this.allRows();
    const { messageRows } = this.regions(rows);
    // Non-empty message rows (skip the boot banner art, the input echo, and the
    // transient SPINNER/STATUS frames "✽ Dilly-dallying…" / "✻ Sautéed for 1s" that
    // claude renders while thinking — never assistant content).
    const contentRows = messageRows
      .map((r) => r.replace(/\s+$/, ''))
      .filter((r) => r.trim() && !this.isBanner(r) && !this.isInputEcho(r) && !this.isStatusRow(r));
    // De-dup by CONTENT (the TUI repaints rows in place; a row already surfaced is
    // not new even if it reappears at a different index). Spinner/status rows are
    // excluded from content so they never poison the set.
    const newRows = contentRows.filter((r) => !this.surfaced.has(r));
    for (const r of newRows) this.surfaced.add(r);

    const events: GridEvent[] = [];
    for (const row of newRows) {
      const t = row.trim();
      const tool = t.match(TOOL_INDICATOR);
      if (tool) {
        const name = tool[1]!;
        const arg = tool[2]!;
        events.push({ kind: 'assistant', text: '', toolUses: [{ id: `pty-${name}`, name, input: this.argToInput(name, arg) }] });
        continue;
      }
      const tr = t.match(TOOLRESULT_GLYPH);
      if (tr) {
        events.push({ kind: 'tool_result', toolUseId: 'pty-last', content: tr[1]!.trim() });
        continue;
      }
      const a = t.match(ASSISTANT_GLYPH);
      if (a) {
        // "● <text>" assistant content (not a Tool(...) line — handled above)
        const text = a[1]!.trim();
        if (text) events.push({ kind: 'assistant', text, toolUses: [] });
        continue;
      }
      // a plain continuation row of assistant prose (no glyph): treat as assistant text
      events.push({ kind: 'assistant', text: t, toolUses: [] });
    }
    return events;
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
    // A leading spinner rune (any of claude's animation glyphs) → a transient
    // "thinking" status row, e.g. "✽ Dilly-dallying…" / "✻ Sautéed for 1s".
    if (/^[✽✻✶✢✼✺◌✦✧✩∗*]/.test(t)) return true;
    // a "(Ns · …)" timer or a token counter row.
    if (/\(\d+s\b/.test(t) || /[↑↓]\s*\d+\s*tokens?/.test(t) || /esc to interrupt/.test(t)) return true;
    return false;
  }
  private argToInput(name: string, arg: string): Record<string, unknown> {
    const a = arg.trim();
    if (name === 'Bash') return { command: a };
    if (name === 'Write' || name === 'Edit' || name === 'Read') return { file_path: a };
    return { arg: a };
  }
}
