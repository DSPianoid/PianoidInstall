/**
 * AGENT WORKTREE ISOLATION PLANNER (X3) — decide, for a routed agent, WHETHER it needs a
 * git-worktree-isolated working directory and WHICH cwd it should run in. A FS-WRITING agent
 * (e.g. a claude-cli agent with Edit/Write/Bash) runs in its OWN worktree so its writes don't
 * land in the real working tree under an active /dev; a read-only/compute agent (a pure
 * api-adapter turn, NO tools — OD-5) needs none. `traces-to: proposal CP3, CP5; §X X3; FD2.`
 *
 * REUSE, NOT RE-IMPLEMENT (the non-negotiable X3 constraint): the worktree CREATE + TEARDOWN
 * already exist — the launcher creates an isolation worktree and points the session at it via
 * `SUPERVISOR_SESSION_CWD`, and `index.ts` reaps it on shutdown via `SUPERVISOR_WORKTREE_CLEANUP`
 * (index.ts:266-272, 379-394; launch-pty-orch.mjs). This module DOES NOT create, remove, or git
 * any worktree. It is the PURE PLANNING half: given a {@link BackendSelection} (+ the env that
 * already carries the isolation cwd), it returns {needsWorktree, sessionCwd} so the choke-point
 * (M4 backend-seal, or the P6 composition root) can thread the cwd into the agent's start options.
 * Full activation — actually creating a per-agent worktree at spawn — is P6; this is the hook/flag.
 *
 * CONCERN (P2 = one job): classify FS-writing-ness + resolve the isolation cwd. It owns NO state,
 * touches NO filesystem, runs NO git. PURE given (selection, env). DORMANT until activation (P6).
 */

import { backendWritesFilesystem, type BackendKind, type BackendSelection } from './backend-kinds.js';

/**
 * The env var the launcher/composition-root sets to the worktree path a session should run IN
 * (the SAME var index.ts:272 reads for the hosted orchestrator's cwd). Re-exported here so the
 * planner + the existing worktree mechanism agree on ONE name (no parallel convention).
 */
export const SESSION_CWD_ENV_VAR = 'SUPERVISOR_SESSION_CWD';

/** The env var index.ts:384 reads to reap the isolation worktree on shutdown (re-exported for agreement; not used to plan). */
export const WORKTREE_CLEANUP_ENV_VAR = 'SUPERVISOR_WORKTREE_CLEANUP';

/** The plan for one routed agent's working directory. */
export interface AgentWorktreePlan {
  /**
   * True iff this agent MAY write the filesystem and therefore SHOULD run in an isolated worktree
   * (claude-cli + a future tool-granted api-adapter). False for a pure compute agent (api-adapter,
   * OD-5) — it gets NO worktree.
   */
  needsWorktree: boolean;
  /**
   * The cwd the agent should run in. For an FS-writing agent this is the isolation worktree path
   * from `SUPERVISOR_SESSION_CWD` when the launcher provided one; otherwise undefined (the caller
   * uses its own default cwd, exactly as the live path does today). For a compute agent it is
   * always undefined (cwd is irrelevant — no FS access).
   */
  sessionCwd?: string;
  /** The backend kind the plan was computed for (echoed for logging/attribution). */
  backend: BackendKind;
}

/** Options for {@link planAgentWorktree}. */
export interface PlanAgentWorktreeOptions {
  /** The env that may carry the isolation cwd (default process.env). Read-only; never mutated. */
  env?: NodeJS.ProcessEnv;
  /**
   * Force the FS-writing classification (override the per-backend default) — for a backend that has
   * been granted tools out-of-band, or to assert a compute-only run. When omitted, the default from
   * {@link backendWritesFilesystem} is used.
   */
  writesFilesystem?: boolean;
}

/** Read a NON-EMPTY env var (the "present" test the rest of the system uses), else undefined. */
function readNonEmptyEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const v = env[name];
  return typeof v === 'string' && v.trim().length > 0 ? v : undefined;
}

/**
 * Plan a routed agent's worktree isolation. PURE — reads (never writes) the env; runs no git.
 *
 * - A FS-writing backend (claude-cli, or `writesFilesystem:true`) → needsWorktree=true, and
 *   sessionCwd = the existing `SUPERVISOR_SESSION_CWD` isolation path WHEN the launcher set one
 *   (so the agent's writes land in that worktree — the index.ts:272 contract, REUSED). If no
 *   isolation cwd is set, needsWorktree is still true (the choke-point/P6 may create one), but
 *   sessionCwd is undefined → caller falls back to its default cwd (today's behavior, unchanged).
 * - A compute backend (api-adapter, OD-5) → needsWorktree=false, sessionCwd=undefined.
 */
export function planAgentWorktree(
  selection: Pick<BackendSelection, 'backend'>,
  opts: PlanAgentWorktreeOptions = {},
): AgentWorktreePlan {
  const env = opts.env ?? process.env;
  const writes = opts.writesFilesystem ?? backendWritesFilesystem(selection.backend);
  const plan: AgentWorktreePlan = { needsWorktree: writes, backend: selection.backend };
  if (writes) {
    const cwd = readNonEmptyEnv(env, SESSION_CWD_ENV_VAR);
    if (cwd !== undefined) plan.sessionCwd = cwd;
  }
  return plan;
}
