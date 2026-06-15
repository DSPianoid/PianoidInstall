/**
 * Shared TUI-text helpers for the interactive `claude` PTY path (Option-3c, A-variant).
 *
 * The Option-A driver reads the screen via a real 2D grid (`pty-grid.ts` →
 * `@xterm/headless`), NOT a line-flatten parser. The only pieces that survived from
 * the original line-flatten parser are these two pure helpers, reused by the grid:
 *   - `stripAnsi` — strip escape sequences (used for the boot-banner system_init scan).
 *   - `permissionFromHeader` — map a permission prompt's verb/action/target → a
 *     {toolName, input} the PermissionRouter understands.
 *
 * (History: the line-flatten `parseRenderChunk` was proven unable to separate
 * assistant content from footer chrome — they are written to different screen ROWS,
 * which flattening glued together. The grid reader replaced it. See design doc
 * §(e)/§(f) + PART 4 / the A-variant.)
 */

/** Strip ANSI escape sequences + OSC + charset-select so we match plain text. */
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b[()][AB012]/g, '')
    .replace(/\x1b[=>]/g, '');
}

/**
 * Map a permission "verb" + target (+ the action-header line) to a {toolName, input}
 * the router understands. Built from the prompt HEADER block ("Create file" /
 * "<filename>" / "Do you want to <verb> <target>?"), NOT a "● Tool(...)" line.
 */
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
  // Fallback: surface the verb as the tool name + the raw target. The router + the
  // safety floor still see it; an unknown verb routes to the user, never silently
  // allowed.
  return { toolName: verb, input: { target: tgt } };
}
