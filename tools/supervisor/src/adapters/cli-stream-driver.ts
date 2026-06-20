/**
 * The `claude -p` STREAM-JSON SessionDriver — the HEDGE driver (Option B from the
 * architecture review, docs/development/reviews/m12-supervisor-architecture-review-2026-06-17.md §3.2/§5.2).
 *
 * Spawns ONE persistent headless Claude process:
 *   claude -p --output-format stream-json --input-format stream-json --verbose
 * and speaks NDJSON over its stdio:
 *   - OUTPUT (stdout, one JSON object per line):
 *       {type:'system', subtype:'init', session_id, model, tools, mcp_servers, slash_commands, …}
 *       {type:'assistant', message:{content:[{type:'text'|'tool_use', …}]}}
 *       {type:'user', message:{content:[{type:'tool_result', …}]}}      (tool results)
 *       {type:'result', subtype:'success', session_id, result, total_cost_usd, …}
 *   - INPUT (stdin, one JSON object per line): the standard Anthropic user envelope
 *       {type:'user', message:{role:'user', content:'<turn text>'}}
 *
 * Why this exists: it is structurally identical to the SDK driver (turn-complete =
 * the `result` object; answer = `result.result`; discrete tool_use/tool_result) but
 * goes through the `claude` CLI instead of the in-process SDK. It is a billing-mode
 * and mechanism hedge: if Anthropic ever meters the SDK differently from the CLI,
 * flipping `--driver sdk` ↔ `--driver cli-stream` is a one-line change at the single
 * construction site (index.ts). The review proved `claude -p` runs on the user's
 * subscription on this machine (`apiKeySource:"none"`).
 *
 * COST SAFETY: this driver NEVER passes `--api-key` and NEVER sets
 * ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN in the child env — it spreads the inherited
 * env unchanged (the startup cost-safety guard in index.ts asserts that env is
 * key-free). Billing follows the subscription OAuth login, exactly like the SDK
 * driver.
 *
 * The mapping is intentionally the SAME shape as SdkSessionDriver.mapMessage — the
 * stream-json schema the SDK and the CLI emit is identical. The ONE SDK/CLI-coupled
 * concern (the child process + its stdio framing) is confined to this file, behind
 * the SessionDriver seam (`spawnFn` is injectable so tests feed captured NDJSON via
 * a fake child — far simpler than the FakePty, since NDJSON has no chrome).
 *
 * Traces: review §3.2/§3.3 (live probe of the stream-json schema + multi-turn
 * one-process) + §5.2/§5.4 step 4 (the hedge).
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { statSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { join, dirname, isAbsolute } from 'node:path';
import type {
  PermissionHandler,
  SessionDriver,
  SessionDriverHealth,
  SessionEvent,
  SessionStartOptions,
  ToolUse,
  UserTurn,
} from '../session-driver.js';
import { isSupervisorRelaunchCommand } from '../profiles.js';

/**
 * The minimal structural view of a spawned child we use. Matches the relevant
 * subset of `node:child_process` ChildProcessWithoutNullStreams, kept loose so a
 * fake can satisfy it in tests without the real `spawn`.
 */
export interface CliChildProcess {
  stdout: AsyncIterable<unknown> | NodeJS.ReadableStream;
  stderr?: NodeJS.ReadableStream;
  stdin: { write(chunk: string): void; end(): void };
  kill(signal?: string): void;
  /** OS process id — used for a Windows TREE kill (taskkill /T). Optional (fake omits). */
  readonly pid?: number;
  /** Resolves/rejects when the child exits; optional (the fake may omit it). */
  readonly exitCode?: number | null;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  once?(event: string, listener: (...args: unknown[]) => void): void;
}

/** Injectable spawn (default = node:child_process spawn of the real `claude`). */
export interface CliSpawnFn {
  (
    command: string,
    args: string[],
    opts: { cwd?: string; env?: NodeJS.ProcessEnv },
  ): CliChildProcess;
}

export interface CliStreamDriverOptions {
  /** Inject the spawn (tests feed captured NDJSON via a fake child). */
  spawnFn?: CliSpawnFn;
  /** The CLI executable. Default `claude` (resolved on PATH). */
  command?: string;
  /** Optional sink for stderr lines (diagnostics; never carries a token). */
  onStderr?: (line: string) => void;
  /**
   * ★ RELAUNCH GUARD (2026-06-20) — the MODE-INDEPENDENT host-restart block.
   *
   * Fired the instant the driver observes (on stdout) an assistant tool_use that would
   * EXECUTE a supervisor relaunch (restart-supervisor.ps1 / a launcher / a `--session`
   * host launch) — from the orchestrator OR ANY sub-agent. The driver has ALREADY killed
   * the child tree before invoking this (the relaunch is prevented, not merely reported).
   * The supervisor uses this to surface a "blocked a host-restart attempt" note to the
   * operator. Best-effort; the driver never awaits it on the hot path.
   *
   * Why this exists (the bug it closes): the safety floor (PermissionRouter.routeWhen →
   * isSupervisorRelaunchCommand) only runs when a tool raises a `can_use_tool`
   * control_request. A `bypassPermissions` and/or background/Task sub-agent SUPPRESSES
   * that request entirely (measured), and an allow-listed Bash/PowerShell never raises one
   * either — so a relaunch from such a tool would run UN-GATED and silently tear down the
   * live host. This guard sits in the driver's stdout loop (the ONE chokepoint that sees
   * every tool_use regardless of permission mode / allow-list / background) → it cannot be
   * defeated by bypass.
   */
  onRelaunchBlocked?: (info: RelaunchBlockInfo) => void;
}

/** Detail of a blocked supervisor-relaunch attempt (passed to {@link CliStreamDriverOptions.onRelaunchBlocked}). */
export interface RelaunchBlockInfo {
  /** The tool that carried the relaunch (`Bash` / `PowerShell` / `Agent` / `Task`). */
  toolName: string;
  /** The offending command (a shell command string, or a sub-agent prompt for Agent/Task). */
  command: string;
  /** True when the relaunch came from a SUB-AGENT (the bypass hole), false for the orchestrator's own. */
  fromSubAgent: boolean;
}

/**
 * Scan ONE parsed stream-json message for an assistant tool_use that would EXECUTE a
 * supervisor relaunch — checked MODE-INDEPENDENTLY (before any permission/allow-list/
 * sub-agent handling). Returns the block detail on the first match, else null. Pure +
 * exported for the test.
 *
 * Two carriers are inspected:
 *  - a shell tool (`Bash`/`PowerShell`) whose `command`/`cmd` is a relaunch (the direct case,
 *    incl. a bypass sub-agent's shell call that raises no control_request);
 *  - an `Agent`/`Task` spawn whose `prompt` literally contains a relaunch (the orchestrator
 *    dispatching a sub-agent whose explicit job is to run the relaunch — caught at the spawn,
 *    a belt-and-suspenders layer on top of the sub-agent's own shell call being caught above).
 *
 * `fromSubAgent` is derived from the SAME markers the flood-fix uses: a non-null
 * `parent_tool_use_id` (foreground sidechain) or a `subagent_type` (background task).
 */
export function detectRelaunchToolUse(raw: unknown): RelaunchBlockInfo | null {
  const m = (raw ?? {}) as Record<string, unknown>;
  if (m['type'] !== 'assistant') return null;
  const fromSubAgent = m['parent_tool_use_id'] != null || m['subagent_type'] != null;
  const msg = (m['message'] ?? {}) as Record<string, unknown>;
  const content = Array.isArray(msg['content']) ? (msg['content'] as Record<string, unknown>[]) : [];
  for (const block of content) {
    if (block['type'] !== 'tool_use') continue;
    const name = String(block['name'] ?? '');
    const input = (block['input'] as Record<string, unknown>) ?? {};
    if (name === 'Bash' || name === 'PowerShell') {
      const cmd = String((input['command'] ?? input['cmd'] ?? '') as string);
      if (cmd && isSupervisorRelaunchCommand(cmd.toLowerCase())) {
        return { toolName: name, command: cmd, fromSubAgent };
      }
    } else if (name === 'Agent' || name === 'Task') {
      // The sub-agent dispatch itself — its prompt may carry the relaunch instruction.
      const prompt = String((input['prompt'] ?? '') as string);
      if (prompt && isSupervisorRelaunchCommand(prompt.toLowerCase())) {
        return { toolName: name, command: prompt, fromSubAgent };
      }
    }
  }
  return null;
}

/**
 * Build the standard Anthropic user-envelope line for a plain-text turn. The same
 * `{ type:'user', message:{ role:'user', content } }` shape the SDK driver builds
 * (SdkSessionDriver.makeUserTurn) and the one `--input-format stream-json`
 * empirically accepts (review §3.3). Exported for the contract test.
 */
export function makeCliUserTurn(content: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content } });
}

/**
 * Map ONE parsed NDJSON object (stream-json message) → a normalized SessionEvent,
 * or null for message types we don't model. This is deliberately the SAME logic as
 * SdkSessionDriver.mapMessage (the SDK and the CLI emit the identical schema) —
 * defensive reads, never throws on a missing field. Exported + pure for the test.
 */
export function mapCliMessage(raw: unknown, lastSessionId?: string): SessionEvent | null {
  const m = (raw ?? {}) as Record<string, unknown>;
  const type = m['type'];
  // ★ FLOOD FIX (2026-06-19) — DROP SUB-AGENT content. When the orchestrator spawns a
  // sub-agent (Agent/Task tool), the sub-agent's assistant narration + tool_result messages
  // ride this SAME stdout stream. Without this guard each line a sub-agent "thinks out loud"
  // mapped to a normal assistant event → onAssistant → sendToOperator → forwarded to the
  // channel = the flood (one /dev run sent ~16 sub-agent narration messages to the user).
  //
  // TWO sub-agent markers, BOTH required (measured against raw `claude -p` stream-json —
  // docs/development/diagnostics/dev-f982-raw-envelope-probe.mjs):
  //   1. FOREGROUND sidechain (Agent/Task run inline): a non-null `parent_tool_use_id`.
  //   2. BACKGROUND task (Agent run_in_background:true): a top-level `subagent_type` (e.g.
  //      "general-purpose") + `task_description`. A background sub-agent's assistant message
  //      is NOT reliably tagged with parent_tool_use_id (it leaked to the user with
  //      parent_tool_use_id==null — the original 2224ed4 guard missed exactly this), but it
  //      ALWAYS carries `subagent_type`. So key on `subagent_type` to catch the background
  //      case independently of parent_tool_use_id.
  // The orchestrator's OWN messages carry NEITHER marker (parent_tool_use_id null/absent and
  // no subagent_type) — incl. the Agent/Task tool_use that SPAWNS the sub-agent, and the
  // sub-agent's FINAL report (returns as the orchestrator's own tool_result, parent null) —
  // so the user still sees the orchestrator coordinating + relaying summaries. Sub-agent
  // PERMISSION requests are unaffected: they arrive as `control_request` (carrying agent_id)
  // and are serviced out-of-band above, before this mapper. system_init/result are
  // session-level (no subagent_type, parent always null) so this guard never drops them.
  if (m['parent_tool_use_id'] != null || m['subagent_type'] != null) return null;
  if (type === 'system' && m['subtype'] === 'init') {
    const slashRaw = m['slash_commands'] ?? m['slashCommands'] ?? m['commands'];
    const mcpRaw = m['mcp_servers'] ?? m['mcpServers'];
    return {
      kind: 'system_init',
      sessionId: String(m['session_id'] ?? ''),
      model: m['model'] != null ? String(m['model']) : undefined,
      tools: Array.isArray(m['tools']) ? (m['tools'] as unknown[]).map(String) : undefined,
      slashCommands: Array.isArray(slashRaw)
        ? (slashRaw as unknown[]).map((c) => String((c as { name?: string })?.name ?? c))
        : undefined,
      mcpServers: Array.isArray(mcpRaw)
        ? (mcpRaw as unknown[]).map((s) => String((s as { name?: string })?.name ?? s)).filter(Boolean)
        : undefined,
    };
  }
  if (type === 'assistant') {
    const msg = (m['message'] ?? {}) as Record<string, unknown>;
    const content = Array.isArray(msg['content']) ? (msg['content'] as Record<string, unknown>[]) : [];
    let text = '';
    const toolUses: ToolUse[] = [];
    for (const block of content) {
      if (block['type'] === 'text' && typeof block['text'] === 'string') text += block['text'];
      else if (block['type'] === 'tool_use') {
        toolUses.push({
          id: String(block['id'] ?? ''),
          name: String(block['name'] ?? ''),
          input: (block['input'] as Record<string, unknown>) ?? {},
        });
      }
    }
    return { kind: 'assistant', text, toolUses };
  }
  if (type === 'user') {
    // tool_result blocks ride in a `user` message's content (review §3.2).
    const msg = (m['message'] ?? {}) as Record<string, unknown>;
    const content = Array.isArray(msg['content']) ? (msg['content'] as Record<string, unknown>[]) : [];
    for (const block of content) {
      if (block['type'] === 'tool_result') {
        const c = block['content'];
        return {
          kind: 'tool_result',
          toolUseId: String(block['tool_use_id'] ?? ''),
          content: typeof c === 'string' ? c : JSON.stringify(c ?? ''),
          isError: block['is_error'] === true,
        };
      }
    }
    return null; // a plain user echo with no tool_result → ignored
  }
  if (type === 'result') {
    return {
      kind: 'result',
      sessionId: String(m['session_id'] ?? lastSessionId ?? ''),
      subtype: String(m['subtype'] ?? 'success'),
      result: typeof m['result'] === 'string' ? (m['result'] as string) : undefined,
      costUsd: typeof m['total_cost_usd'] === 'number' ? (m['total_cost_usd'] as number) : undefined,
    };
  }
  // system/thinking, rate_limit_event, task_started/notification, partial, unknown → ignored.
  return null;
}

/**
 * Default spawn: `claude -p --output-format stream-json --input-format stream-json
 * --verbose` plus the start options mapped to CLI flags. NO `--api-key` (cost
 * safety). `node:child_process` is a builtin (always present); the `claude`
 * executable is resolved on PATH at run time (tests inject a fake spawn, so this is
 * never reached without a real CLI).
 */
/** Grace window for a clean exit before we SIGKILL/force-kill the tree. */
export const CHILD_TERMINATE_TIMEOUT_MS = 4000;

/**
 * ★M-1 — terminate the cli-stream child AND its descendants, then AWAIT the exit.
 *
 * Why a plain `child.kill()` is not enough: the headless `claude` child spawns its
 * OWN sub-processes (sub-agent shells via Bash/PowerShell, MCP server processes).
 * On Windows `child.kill()` (TerminateProcess on the direct child only) does NOT
 * kill the process TREE → those grandchildren ORPHAN. Across repeated restarts (the
 * lifecycle-restart feature) the orphans accumulate. So:
 *   - Windows: `taskkill /T /F /PID <pid>` — /T kills the whole tree, /F forces it.
 *   - POSIX:   SIGTERM, then SIGKILL on timeout (kill the group if we can).
 * Either way we AWAIT the child's 'exit'/'close' (with a timeout fallback) so a
 * caller that immediately re-spawns can't race a not-yet-dead predecessor. The
 * function never rejects (teardown is best-effort).
 */
export async function terminateChildTree(
  child: CliChildProcess,
  timeoutMs: number = CHILD_TERMINATE_TIMEOUT_MS,
  spawnFn: typeof nodeSpawn = nodeSpawn,
): Promise<void> {
  let settled = false;
  let resolveExited: () => void = () => undefined;
  const exited = new Promise<void>((resolve) => {
    resolveExited = resolve;
  });
  const done = (): void => {
    if (settled) return;
    settled = true;
    resolveExited();
  };
  // Arm the exit waiter BEFORE killing so we never miss a fast exit.
  if (typeof child.once === 'function') {
    child.once('exit', done);
    child.once('close', done);
  } else {
    // A fake/loose child with no event emitter — nothing to await; resolve next tick.
    setImmediate(done);
  }

  const isWindows = process.platform === 'win32';
  const timers: ReturnType<typeof setTimeout>[] = [];
  if (isWindows && typeof child.pid === 'number') {
    // Tree kill: /T whole tree, /F force. Output ignored — best-effort.
    try {
      const tk = spawnFn('taskkill', ['/T', '/F', '/PID', String(child.pid)], {
        stdio: 'ignore',
        windowsHide: true,
      } as Parameters<typeof nodeSpawn>[2]);
      // Don't let a stray taskkill error crash us.
      (tk as { on?: (e: string, l: (...a: unknown[]) => void) => void }).on?.('error', () => undefined);
    } catch {
      // taskkill unavailable → fall back to the direct kill.
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
  } else {
    // POSIX (and the Windows no-pid fallback): SIGTERM now, SIGKILL on the timeout.
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    timers.push(
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, timeoutMs),
    );
  }

  // Hard fallback: stop WAITING if no exit event ever arrives. Fires AFTER the SIGKILL
  // escalation (timeoutMs) so the force-kill is always attempted first. Not unref'd —
  // this promise is awaited, so the fallback must keep the loop alive until it resolves.
  timers.push(setTimeout(done, timeoutMs + 250));
  await exited;
  for (const t of timers) clearTimeout(t);
}

function defaultSpawn(
  command: string,
  cliArgs: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv },
): CliChildProcess {
  // Resolve the real executable. On Windows `claude` is an npm shim `claude.cmd`
  // (not `claude`/`claude.exe`); `child_process.spawn` does NOT do PATH/PATHEXT
  // resolution for a bare name (that's a shell feature), so a bare 'claude' → ENOENT.
  const resolved = resolveCommandPath(command, opts.env ?? process.env);
  // ★ H1 — a Windows .cmd/.bat shim would need `shell:true` (cmd.exe), whose command
  // line is capped at 8191 chars → our ~12KB inline --append-system-prompt would be
  // TRUNCATED/FAIL (the system prompt silently lost). So FOLLOW the shim to the real
  // .exe it invokes and spawn THAT directly (no shell → CreateProcess's 32767 limit).
  // (`--append-system-prompt-FILE` is broken/ignored in claude v2.1.181 — verified —
  // so the inline flag is the only working path; this spawn fix makes it safe.)
  const direct = resolveDirectExecutable(resolved);
  const stillBatch = /\.(cmd|bat)$/i.test(direct);
  const child = nodeSpawn(direct, cliArgs, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    // If we couldn't extract the real .exe (extraction failed), fall back to shell on a
    // .cmd (accepting the 8191 limit — better than ENOENT). The .exe path never needs it.
    ...(stillBatch ? { shell: true } : {}),
  });
  return child as unknown as CliChildProcess;
}

/**
 * If `resolved` is a Windows `.cmd`/`.bat` shim, follow it to the real executable it
 * invokes (e.g. npm's `claude.cmd` → `…\node_modules\@anthropic-ai\claude-code\bin\
 * claude.exe`) so we can spawn that directly without a shell (avoiding cmd.exe's
 * 8191-char command-line cap). Returns the resolved path unchanged on POSIX, for a
 * non-shim, or if extraction fails. Exported for the test.
 */
export function resolveDirectExecutable(resolved: string): string {
  if (!/\.(cmd|bat)$/i.test(resolved)) return resolved;
  try {
    const text = readFileSync(resolved, 'utf8');
    // The npm shim invokes the real binary in double quotes, often via %~dp0 / %dp0%.
    // Match the LAST quoted "...\something.exe" in the script and resolve %dp0%/%~dp0.
    const matches = [...text.matchAll(/"([^"]*?\.exe)"/gi)].map((m) => m[1]!);
    if (matches.length === 0) return resolved;
    let exe = matches[matches.length - 1]!;
    const shimDir = dirname(resolved);
    // npm shims reference the dir as %~dp0 or %dp0% (a trailing-backslash dir token).
    exe = exe.replace(/%~?dp0%?\\?/gi, shimDir + '\\');
    const abs = isAbsolute(exe) ? exe : join(shimDir, exe);
    if (statSync(abs).isFile()) return abs;
  } catch {
    /* unreadable shim / parse miss → fall back to the .cmd (+ shell) */
  }
  return resolved;
}

/**
 * Resolve a command name to an absolute executable path by scanning PATH (and, on
 * Windows, PATHEXT — .CMD/.EXE/.BAT/.PS1). Returns the input unchanged if it is
 * already an absolute/relative path that exists, or if nothing is found (let spawn
 * surface the ENOENT). Mirrors `which`/`where`. Exported for the test.
 */
export function resolveCommandPath(command: string, env: NodeJS.ProcessEnv): string {
  // Already a path (contains a separator) → use as-is.
  if (command.includes('/') || command.includes('\\')) return command;
  const isWin = process.platform === 'win32';
  const pathSep = isWin ? ';' : ':';
  const dirs = (env['PATH'] ?? env['Path'] ?? '').split(pathSep).filter(Boolean);
  const exts = isWin ? (env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        /* not here — keep scanning */
      }
    }
  }
  return command; // not found → let spawn report ENOENT
}

/**
 * Translate the normalized SessionStartOptions into `claude -p` CLI flags. Kept
 * pure + exported so the flag contract (esp. "no --api-key") is asserted by a test.
 *
 * Permission handling (R4): `--permission-prompt-tool stdio`. This is the SAME
 * mechanism the Agent SDK uses under the hood — when the SDK is given a `canUseTool`
 * callback it spawns `claude` with `--permission-prompt-tool stdio` (confirmed in the
 * SDK source, sdk.mjs ~L7701). With `stdio`, the CLI surfaces every gated tool as a
 * stream-json `control_request {subtype:"can_use_tool", tool_name, input, tool_use_id,
 * agent_id}` on stdout and BLOCKS until the host writes a `control_response` on stdin.
 * Because the request carries `agent_id`, sub-agent (Task-spawned) tool calls flow
 * through the SAME channel — so the supervisor's PermissionRouter catches the
 * orchestrator's AND its sub-agents' permission requests and routes them to the user.
 * The driver speaks this protocol in-process (it owns the child's stdio); no separate
 * MCP shim process is needed.
 */
/**
 * Extract the system-prompt APPEND text from the normalized systemPrompt union for the
 * CLI's `--append-system-prompt`. A plain string IS the append (demo persona); the
 * `{preset:'claude_code', append}` form contributes its `append` (the preset is the
 * CLI default, passed implicitly). Returns '' if there's nothing to append. Pure.
 */
export function extractSystemPromptAppend(sp: SessionStartOptions['systemPrompt']): string {
  if (!sp) return '';
  if (typeof sp === 'string') return sp;
  return sp.append ?? '';
}

/**
 * Write the curated MCP server map to a private temp file for `--mcp-config`, and return its
 * path (or undefined when there is nothing to write). The file is created with mode 0600
 * (owner read/write only) under os.tmpdir() — OUTSIDE the repo working tree, so it can never be
 * committed and is not visible to other repo users. The JSON shape is the CLI's expected
 * `{ "mcpServers": { <name>: <config> } }` (the same shape as `~/.claude.json` / `.mcp.json`).
 *
 * ★ SECRET HYGIENE: the map already carries RESOLVED secrets (DEEPSEEK_API_KEY, EMAIL_PASS, …
 * inline from ~/.claude.json) — this function writes them to the 0600 file ONLY; the CONTENTS are
 * NEVER logged or printed (the caller logs at most the path + the server NAMES). The driver unlinks
 * the file on stop()/teardown. Pure given its inputs (the only effect is the file write); the
 * filename uses crypto.randomBytes so concurrent sessions don't collide. Exported for the test
 * (which asserts the 0600 mode + the `{mcpServers}` shape without reading any secret).
 *
 * @returns the temp file path, or undefined if `mcpServers` is absent/empty (no flag needed).
 */
export function writeMcpConfigFile(
  mcpServers: Record<string, unknown> | undefined,
  dir: string = tmpdir(),
): string | undefined {
  if (!mcpServers || Object.keys(mcpServers).length === 0) return undefined;
  const path = join(dir, `supervisor-mcp-${process.pid}-${randomBytes(6).toString('hex')}.json`);
  // mode 0o600 at create time (owner-only). On Windows the POSIX bits are advisory, but the file
  // still lands in the per-user temp dir (not the repo), so it is not exposed to other repo users.
  writeFileSync(path, JSON.stringify({ mcpServers }), { encoding: 'utf8', mode: 0o600 });
  return path;
}

export function buildCliArgs(opts: SessionStartOptions, mcpConfigPath?: string): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose'];
  // Route every gated tool over the stdio control protocol → the PermissionRouter.
  args.push('--permission-prompt-tool', 'stdio');
  // ★ MCP CONFIG (2026-06-20) — when a curated MCP map was written to a temp file, point the
  // child at it with `--mcp-config <file>`. WHY THIS IS NEEDED: the hosted orchestrator runs
  // with settingSources ['project','local'] (NEVER 'user' — the token-hijack containment), and
  // the user's `~/.claude.json` mcpServers are USER-scope config → they do NOT auto-load under
  // project/local. So without this flag the child sees ZERO MCP servers. We pass an explicit,
  // curated map (telegram excluded; whatsapp/email/deepseek kept; secrets resolved in-memory by
  // mcp-config.ts) via the file. ★ DELIBERATELY NO `--strict-mcp-config`: that would make the
  // child use ONLY these servers and DROP the claude.ai connector servers (Drive/Gmail/Calendar)
  // the orchestrator also relies on. Omitting it ADDS our curated map alongside them (measured:
  // `--strict-mcp-config` = "Only use MCP servers from --mcp-config, ignoring all other MCP
  // configurations"). The file path is the ONLY thing on the command line — the resolved secrets
  // live in the file (0600, os.tmpdir, unlinked on stop), never in argv and never logged.
  if (mcpConfigPath) args.push('--mcp-config', mcpConfigPath);
  if (opts.resume) args.push('--resume', opts.resume);
  if (opts.model) args.push('--model', opts.model);
  if (opts.cwd) {
    // `claude -p` honors the spawn cwd; --add-dir keeps the working dir trusted.
    args.push('--add-dir', opts.cwd);
  }
  if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode);
  if (opts.allowedTools && opts.allowedTools.length > 0) {
    args.push('--allowed-tools', opts.allowedTools.join(','));
  }
  if (opts.disallowedTools && opts.disallowedTools.length > 0) {
    args.push('--disallowed-tools', opts.disallowedTools.join(','));
  }
  if (opts.settingSources && opts.settingSources.length > 0) {
    args.push('--setting-sources', opts.settingSources.join(','));
  }
  // ★ H1 — SYSTEM PROMPT. The orchestrator profile builds {preset:'claude_code', append}
  // (the hosting-context preamble + the folded ~/.claude/CLAUDE.md methodology + the
  // panel/channel-check/repair contracts). The `claude_code` preset IS the CLI's own
  // default system prompt (no flag needed for it); only the APPEND must be passed —
  // INLINE via `--append-system-prompt` (the `-file` variant is broken/ignored in
  // v2.1.181, verified). Without this the entire append (incl. the user-source-drop
  // compensation) was silently dropped on cli-stream. A plain-string systemPrompt
  // (demo) also maps here. defaultSpawn spawns the real .exe (no shell) so the long
  // (~12KB) inline arg is not truncated by cmd.exe's 8191 cap.
  const append = extractSystemPromptAppend(opts.systemPrompt);
  if (append) args.push('--append-system-prompt', append);
  // NOTE: deliberately NO `--api-key` — billing stays on the subscription (cost safety).
  return args;
}

export class CliStreamDriver implements SessionDriver {
  private readonly spawnFnOverride?: CliSpawnFn;
  private readonly command: string;
  private readonly onStderr?: (line: string) => void;
  private readonly onRelaunchBlocked?: (info: RelaunchBlockInfo) => void;
  private child: CliChildProcess | null = null;
  private running = false;
  private sessionId: string | undefined;
  /** The private 0600 temp file holding the curated --mcp-config map; unlinked on stop()/teardown. */
  private mcpConfigFile: string | undefined;
  /** True once we've intercepted a relaunch + killed the child (suppresses further events). */
  private relaunchBlocked = false;
  /** The permission handler (PermissionRouter), set in start() — services can_use_tool. */
  private onPermission?: PermissionHandler;

  constructor(opts: CliStreamDriverOptions = {}) {
    this.spawnFnOverride = opts.spawnFn;
    this.command = opts.command ?? 'claude';
    this.onStderr = opts.onStderr;
    this.onRelaunchBlocked = opts.onRelaunchBlocked;
  }

  start(opts: SessionStartOptions): AsyncIterable<SessionEvent> {
    const self = this;
    this.running = true;
    this.relaunchBlocked = false; // fresh session (a restart re-starts this driver)
    // The permission handler (the supervisor's PermissionRouter) — invoked for each
    // `can_use_tool` control_request the CLI raises over stdio (R4).
    this.onPermission = opts.onPermission;

    // ★ MCP CONFIG (2026-06-20): if the supervisor passed a curated MCP map, materialize it to a
    // private 0600 temp file (outside the repo) and point the child at it via --mcp-config. The
    // file write happens HERE (not in the pure buildCliArgs) so buildCliArgs stays pure/unit-tested;
    // the contents (resolved secrets) are never logged. A stale file from a prior start (e.g. a
    // crash-restart that re-enters start()) is cleaned up first.
    this.cleanupMcpConfigFile();
    this.mcpConfigFile = writeMcpConfigFile(opts.mcpServers);

    // Spawn the child SYNCHRONOUSLY in start() (not inside the generator) so the
    // contract matches the SDK driver: send() works as soon as start() returns,
    // before the caller begins draining events. (`node:child_process` is a builtin,
    // so no async import is needed.)
    const cliArgs = buildCliArgs(opts, this.mcpConfigFile);
    // Env: spread the caller's env (or process.env) UNCHANGED — no api-key injected.
    const env = opts.env ? ({ ...process.env, ...opts.env } as NodeJS.ProcessEnv) : process.env;
    const child = this.spawnFnOverride
      ? this.spawnFnOverride(this.command, cliArgs, { cwd: opts.cwd, env })
      : defaultSpawn(this.command, cliArgs, { cwd: opts.cwd, env });
    this.child = child;

    // Surface stderr lines to the optional sink (diagnostics).
    if (child.stderr && this.onStderr) {
      const sink = this.onStderr;
      child.stderr.setEncoding?.('utf8');
      child.stderr.on?.('data', (d: unknown) => {
        for (const line of String(d).split('\n')) if (line.trim()) sink(line);
      });
    }

    // Inject any bootstrap turns BEFORE consuming output so the session adopts its
    // role on the first turn (mirrors the SDK driver).
    for (const t of opts.bootstrapTurns ?? []) child.stdin.write(makeCliUserTurn(t) + '\n');

    async function* gen(): AsyncGenerator<SessionEvent> {
      try {
        for await (const line of iterateNdjsonLines(child.stdout)) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue; // a non-JSON line (rare CLI chatter) → skip
          }
          // ★ RELAUNCH GUARD (2026-06-20) — MODE-INDEPENDENT host-restart block. Checked
          // FIRST, before the control-protocol + the sub-agent drop in mapCliMessage, so it
          // fires for EVERY tool_use the model emits regardless of permission mode / allow-list
          // / background. A relaunch (restart-supervisor.ps1 / a launcher / a `--session` host
          // launch) from a bypassPermissions or background sub-agent raises NO can_use_tool
          // control_request (measured), so the PermissionRouter floor never sees it — but the
          // tool_use line ALWAYS rides this stdout stream, and (measured) it is emitted BEFORE
          // the CLI executes the tool, so killing the child tree HERE prevents the relaunch from
          // tearing down the live host. We stop draining + end the stream after blocking.
          const blocked = detectRelaunchToolUse(parsed);
          if (blocked && !self.relaunchBlocked) {
            self.relaunchBlocked = true;
            self.blockRelaunch(blocked);
            return; // stop yielding — the child is being torn down; the turn is void
          }
          // CONTROL PROTOCOL: a `control_request` is NOT a content message — handle it
          // out-of-band (permission round-trip) and do not yield it as a SessionEvent.
          const m = parsed as Record<string, unknown>;
          if (m['type'] === 'control_request') {
            void self.handleControlRequest(m);
            continue;
          }
          const ev = mapCliMessage(parsed, self.sessionId);
          if (ev) {
            if (ev.kind === 'system_init') self.sessionId = ev.sessionId;
            if (ev.kind === 'result') self.sessionId = ev.sessionId;
            yield ev;
          }
        }
      } finally {
        self.running = false;
      }
    }
    return gen();
  }

  /**
   * Handle a stream-json `control_request`. The only subtype we service is
   * `can_use_tool` — route it to the PermissionRouter (which may ask the user over the
   * channel and BLOCK on their reply) and write the `control_response` back on stdin.
   * The request's `agent_id` means a SUB-AGENT's gated tool surfaces here too, so the
   * router governs the orchestrator AND its sub-agents. Mirrors the SDK's own
   * handleControlRequest (sdk.mjs ~L8228): success → {subtype:"success", response},
   * failure → {subtype:"error", error}. Exported shape kept minimal + defensive.
   */
  private async handleControlRequest(message: Record<string, unknown>): Promise<void> {
    const requestId = String(message['request_id'] ?? '');
    const req = (message['request'] ?? {}) as Record<string, unknown>;
    try {
      if (req['subtype'] !== 'can_use_tool') {
        // We don't model hook_callback / mcp_message on the CLI path → reply error so
        // the child doesn't hang waiting (it only blocks on can_use_tool in practice).
        throw new Error(`unsupported control_request subtype: ${String(req['subtype'])}`);
      }
      if (!this.onPermission) throw new Error('cli-stream: no permission handler');
      const toolName = String(req['tool_name'] ?? '');
      const input = (req['input'] as Record<string, unknown>) ?? {};
      const decision = await this.onPermission({ toolName, input, sessionId: this.sessionId });
      // Map our PermissionDecision → the SDK's canUseTool return shape (spread into
      // control_response.response). allow → {behavior:'allow', updatedInput}; the CLI
      // requires updatedInput on allow (default to the original input).
      const response =
        decision.behavior === 'allow'
          ? { behavior: 'allow', updatedInput: decision.updatedInput ?? input }
          : { behavior: 'deny', message: decision.message };
      this.writeControlResponse({ subtype: 'success', request_id: requestId, response });
    } catch (err) {
      this.writeControlResponse({
        subtype: 'error',
        request_id: requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * ★ Block an intercepted supervisor-relaunch: KILL the child tree (preventing the relaunch
   * from executing — the tool_use line precedes execution, measured) and notify the supervisor.
   * Best-effort, never throws. After this the generator returns (stream ends); the lifecycle
   * manager observes the child exit. This is the HARD-DENY the task blesses for the bypass case;
   * it also covers an orchestrator-OWN raw shell relaunch (the legitimate host-restart path is
   * the lifecycle API — POST /api/lifecycle/restart-request / ctl:restart — NOT a raw shell call).
   */
  private blockRelaunch(info: RelaunchBlockInfo): void {
    this.running = false;
    const child = this.child;
    this.child = null;
    // The child we fed is being torn down → drop its private --mcp-config temp file too.
    this.cleanupMcpConfigFile();
    // Notify FIRST (so the operator-facing note is queued even if the kill races the exit).
    try {
      this.onRelaunchBlocked?.(info);
    } catch {
      /* a notify failure must not stop the kill */
    }
    if (child) {
      try {
        child.stdin.end();
      } catch {
        /* ignore */
      }
      // Fire-and-forget the tree kill (terminateChildTree awaits the exit; we don't block the
      // generator's return on it — the child is doomed either way).
      void terminateChildTree(child).catch(() => undefined);
    }
  }

  /**
   * Unlink the private --mcp-config temp file (best-effort; idempotent). Called on stop(), on a
   * relaunch-block teardown, and at the start of a fresh start() so the resolved-secret file never
   * lingers on disk after the child it fed has exited.
   */
  private cleanupMcpConfigFile(): void {
    const f = this.mcpConfigFile;
    if (!f) return;
    this.mcpConfigFile = undefined;
    try {
      unlinkSync(f);
    } catch {
      /* already gone / unreadable — best-effort */
    }
  }

  /** Write a control_response frame to the child's stdin (NDJSON). */
  private writeControlResponse(response: Record<string, unknown>): void {
    if (!this.child) return;
    try {
      this.child.stdin.write(JSON.stringify({ type: 'control_response', response }) + '\n');
    } catch {
      /* best-effort; a dead child means the turn is already over */
    }
  }

  async send(turn: UserTurn): Promise<void> {
    if (!this.child) throw new Error('cli-stream driver: not started');
    this.child.stdin.write(makeCliUserTurn(turn.text) + '\n');
  }

  async interrupt(): Promise<void> {
    // No cooperative interrupt over stream-json stdin; SIGINT the child (the
    // lifecycle FI path restarts + resumes). Best-effort.
    this.child?.kill('SIGINT');
  }

  async stop(): Promise<void> {
    this.running = false;
    const child = this.child;
    this.child = null;
    // Remove the private --mcp-config temp file (resolved secrets) now the child is going down.
    this.cleanupMcpConfigFile();
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      /* ignore */
    }
    await terminateChildTree(child);
  }

  health(): SessionDriverHealth {
    return { running: this.running, sessionId: this.sessionId, detail: 'cli-stream-driver' };
  }
}

/**
 * Yield complete NDJSON LINES from a child's stdout, handling chunk boundaries that
 * split a line. Accepts either an async-iterable stream (Node streams are
 * async-iterable) or one exposing `on('data')`. Exported for the test.
 */
export async function* iterateNdjsonLines(
  stdout: AsyncIterable<unknown> | NodeJS.ReadableStream,
): AsyncGenerator<string> {
  let buf = '';
  const emit = function* (chunk: string): Generator<string> {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line.length > 0) yield line;
    }
  };
  for await (const chunk of stdout as AsyncIterable<unknown>) {
    yield* emit(typeof chunk === 'string' ? chunk : String(chunk));
  }
  if (buf.trim().length > 0) yield buf.trim();
}
