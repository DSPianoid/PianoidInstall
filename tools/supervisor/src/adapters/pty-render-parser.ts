/**
 * BOUNDED render parser for the interactive `claude` TUI (the PtySessionDriver's
 * output half). NOT a terminal emulator — it strips ANSI and matches a small,
 * fixed set of line markers captured VERBATIM from the 2026-06-15 probes (design
 * doc §(d-FINAL)/§(e)). Pure + synchronous + side-effect-free so it is unit-tested
 * against pinned fixtures (src/test/fixtures/pty/) with a FakePty — no real PTY.
 *
 * Markers (the ~5-8 the supervisor actually needs):
 *  - BOOT banner            → system_init (model + a synthetic session id)
 *  - "● <Tool>(<arg>)"       → an assistant toolUse (the POST-grant echo) + a
 *    "⎿ <result>" line       → tool_result
 *  - permission PROMPT       → "Do you want to <verb> <target>?" + the numbered
 *    "❯ 1. Yes / 2. … / 3. No" list (+ the "Create file"/<filename> header block).
 *    Emitted as a `permission` event carrying {toolName,input}. The tool+arg come
 *    from the HEADER block, NOT the "●" line (which only appears AFTER the grant).
 *  - assistant prose         → assistant (text) — plain lines that are not markers
 *  - input box "❯" re-render → turn_complete (with the turn's final assistant text)
 *  - an error banner         → error
 *
 * Design note (why these markers): the probes showed the TUI is noisy (spinners,
 * box-drawing, "Determining…", alternate-screen redraws). We deliberately match
 * ONLY the stable markers and ignore everything else, so a cosmetic TUI change
 * (a new spinner glyph) does not break parsing. If Claude Code changes a marker
 * itself, the SDK driver (--driver sdk, the default) is the instant fallback.
 */

import type { ToolUse } from '../session-driver.js';

export type PtyRenderEvent =
  | { kind: 'system_init'; sessionId: string; model?: string }
  | { kind: 'assistant'; text: string; toolUses?: ToolUse[] }
  | { kind: 'tool_result'; toolUseId: string; content: string; isError?: boolean }
  | { kind: 'permission'; toolName: string; input: Record<string, unknown> }
  | { kind: 'turn_complete'; finalText?: string }
  | { kind: 'error'; subtype?: string; message: string };

export interface ParseOptions {
  /** The session cwd (used to synthesize a stable-ish session id for system_init). */
  cwd?: string;
}

/** Strip ANSI escape sequences + OSC + charset-select so we match plain text. */
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b[()][AB012]/g, '')
    .replace(/\x1b[=>]/g, '');
}

// ── marker regexes (ANSI-stripped) ───────────────────────────────────────────
const RE_BOOT_MODEL = /\b(Opus|Sonnet|Haiku|Claude)\s+[\w.\s()]*?(?:\bv?\d|\(1M context\))/i;
const RE_BOOT_VERSION = /Claude Code v[\d.]+|Claude v[\d.]+/i;
const RE_TOOL_INDICATOR = /[●•]\s*([A-Z][A-Za-z_]+)\(([^)]*)\)/; // "● Write(file.txt)" — POST-grant
const RE_TOOL_RESULT = /⎿\s*(.+)$/; // "⎿  Wrote 1 lines to …"
const RE_PERMISSION_HEADER = /Do you want to (\w+)\s+(.+?)\?/i; // "Do you want to create probe.txt?"
const RE_PERMISSION_LIST = /❯?\s*1\.\s*Yes\b/i; // "❯ 1. Yes"
const RE_PROMPT_ACTION = /^\s*(Create file|Edit file|Read file|Run command|Write file|Delete file)\s*$/i;
const RE_INPUT_BOX = /❯\s+Try ["“]|❯\s*$|\?\s+for shortcuts/; // input box re-rendered = idle/ready
const RE_ERROR = /\b(Error|fatal|failed|Exception):\s*(.+)$/i;

/** Map a permission "verb" + target to a {toolName, input} the router understands. */
export function permissionFromHeader(
  verb: string,
  target: string,
  actionLine?: string,
): { toolName: string; input: Record<string, unknown> } {
  const v = verb.toLowerCase();
  const action = (actionLine ?? '').toLowerCase();
  const tgt = target.trim();
  if (action.includes('create file') || action.includes('write file') || v === 'create' || v === 'write') {
    return { toolName: 'Write', input: { file_path: tgt } };
  }
  if (action.includes('edit file') || v === 'edit') {
    return { toolName: 'Edit', input: { file_path: tgt } };
  }
  if (action.includes('run command') || v === 'run' || v === 'execute') {
    return { toolName: 'Bash', input: { command: tgt } };
  }
  if (action.includes('delete') || v === 'delete' || v === 'remove') {
    return { toolName: 'Bash', input: { command: `rm ${tgt}` } };
  }
  // Fallback: surface the verb as the tool name + the raw target (router + safety
  // floor still see it; an unknown verb routes to the user, never silently allowed).
  return { toolName: verb, input: { target: tgt } };
}

/**
 * Parse a render buffer (carry + new chunk) into render-events + the leftover
 * incomplete trailing line (carry) for the next call. Line-oriented: only fully
 * terminated lines are matched; the trailing partial line is returned as carry.
 *
 * Stateless across calls EXCEPT via the caller-held carry string — so a multi-
 * chunk prompt is matched once its lines complete. The caller (PtySessionDriver)
 * de-dups permission events; this parser may emit the prompt markers more than
 * once if the TUI redraws them, which is why the driver gates on permissionPending.
 */
export function parseRenderChunk(
  buf: string,
  opts: ParseOptions = {},
): { events: PtyRenderEvent[]; carry: string } {
  const clean = stripAnsi(buf);
  const lines = clean.split('\n');
  const carry = lines.pop() ?? ''; // last (possibly incomplete) line carries over
  const events: PtyRenderEvent[] = [];

  let pendingAction: string | undefined; // a "Create file" header seen, awaiting the filename + "Do you want to"
  let pendingFilename: string | undefined;
  let lastAssistantText: string | undefined;

  // BOOT → system_init (once per buffer that contains the banner). Scan the WHOLE
  // frame for the banner: the version line and the model line are DIFFERENT lines
  // ("Claude Code v2.1.177" then "Opus 4.8 (1M context) · Claude Max"), so we
  // detect the banner by either marker but read the model from wherever it is.
  const bootSeen = lines.some((l) => RE_BOOT_VERSION.test(l)) || lines.some((l) => RE_BOOT_MODEL.test(l));
  if (bootSeen) {
    const modelLine = lines.find((l) => /\b(Opus|Sonnet|Haiku)\b/i.test(stripAnsi(l)));
    const modelMatch = modelLine ? stripAnsi(modelLine).match(/(Opus|Sonnet|Haiku)[\w.\s()]*?(?=·|$)/i) : null;
    events.push({
      kind: 'system_init',
      sessionId: synthSessionId(opts.cwd),
      model: modelMatch ? modelMatch[0].trim() : undefined,
    });
  }

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;

    // skip the banner lines (already handled above)
    if (RE_BOOT_VERSION.test(line) || /^\s*(Opus|Sonnet|Haiku)\b/i.test(line)) continue;

    // PERMISSION — the header block: an action line ("Create file"), then the
    // filename, then "Do you want to <verb> <target>?" + the numbered list.
    const actionMatch = line.match(RE_PROMPT_ACTION);
    if (actionMatch) {
      pendingAction = actionMatch[1];
      pendingFilename = undefined;
      continue;
    }
    const headerMatch = line.match(RE_PERMISSION_HEADER);
    if (headerMatch) {
      const verb = headerMatch[1]!;
      const target = (pendingFilename ?? headerMatch[2] ?? '').trim();
      const { toolName, input } = permissionFromHeader(verb, target, pendingAction);
      events.push({ kind: 'permission', toolName, input });
      pendingAction = undefined;
      pendingFilename = undefined;
      continue;
    }
    // capture the filename line that follows an action header (before "Do you want")
    if (pendingAction && !pendingFilename && /^[\w./\\\- ]+$/.test(line) && !RE_PERMISSION_LIST.test(line)) {
      pendingFilename = line.trim();
      continue;
    }

    // TOOL indicator (post-grant) → assistant toolUse
    const toolMatch = line.match(RE_TOOL_INDICATOR);
    if (toolMatch) {
      const name = toolMatch[1]!;
      const arg = toolMatch[2]!;
      const tu: ToolUse = { id: `pty-${name}-${events.length}`, name, input: argToInput(name, arg) };
      events.push({ kind: 'assistant', text: '', toolUses: [tu] });
      continue;
    }

    // TOOL result line "⎿ …"
    const resultMatch = line.match(RE_TOOL_RESULT);
    if (resultMatch) {
      events.push({ kind: 'tool_result', toolUseId: 'pty-last', content: resultMatch[1]!.trim() });
      continue;
    }

    // ERROR banner
    const errMatch = line.match(RE_ERROR);
    if (errMatch) {
      events.push({ kind: 'error', message: errMatch[2]!.trim() });
      continue;
    }

    // INPUT BOX re-render → turn complete (carry the last assistant text)
    if (RE_INPUT_BOX.test(line)) {
      events.push({ kind: 'turn_complete', finalText: lastAssistantText });
      lastAssistantText = undefined;
      continue;
    }

    // Otherwise: treat as assistant prose IF it isn't TUI chrome (box-drawing,
    // spinners, the "Determining…"/"Gusting…" status, separators).
    if (isAssistantProse(line)) {
      lastAssistantText = lastAssistantText ? `${lastAssistantText} ${line.trim()}` : line.trim();
      events.push({ kind: 'assistant', text: line.trim(), toolUses: [] });
    }
  }

  return { events, carry };
}

/** Heuristic: is this line assistant prose vs TUI chrome? (Conservative — chrome out.) */
function isAssistantProse(line: string): boolean {
  const t = line.trim();
  if (t.length < 2) return false;
  if (/^[─━╌╭╮╰╯│┌┐└┘├┤┬┴┼·•▌▐█▘▝▛▜▟▙↓↑⧉◈✻✶✢✽✼]/.test(t)) return false; // box-drawing / glyphs / spinner runes
  if (/Determining…|Gusting…|thinking[…)]|esc to interrupt|for shortcuts|tokens?\)|\(\d+s\s/.test(t)) return false; // status/spinner
  if (/^\d+\.\s/.test(t) && /\b(Yes|No)\b/.test(t)) return false; // a menu option
  if (/^(Esc to cancel|Enter to confirm|Tab to amend|Security guide|What's new)/.test(t)) return false; // prompt chrome
  // FOOTER hint bar: "gh auth login · ← for agents⧉ In analyse.md …" — the input-box
  // footer mixes shortcut hints; never assistant content. Reject lines carrying its markers.
  if (/(←|→)\s*for agents|gh auth login|⧉\s*In\b|\/effort\b|◈\s*max\b|·\s*for shortcuts/.test(t)) return false;
  if (/^❯/.test(t) || /Try ["“]/.test(t)) return false; // the input box line itself
  return true;
}

/** Best-effort: turn a "● Tool(arg)" arg string into a tool input object. */
function argToInput(name: string, arg: string): Record<string, unknown> {
  const a = arg.trim();
  if (name === 'Bash') return { command: a };
  if (name === 'Write' || name === 'Edit' || name === 'Read') return { file_path: a };
  return { arg: a };
}

/** A stable-ish synthetic session id (the interactive child journals none of its own). */
function synthSessionId(cwd?: string): string {
  const base = (cwd ?? 'pty').replace(/[^A-Za-z0-9]/g, '-').slice(-24);
  return `pty-${base}-${Date.now().toString(36)}`;
}
