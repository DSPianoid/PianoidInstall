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
 * CONCERN (P2 = one job): the routed agent's working-directory ISOLATION. Two halves:
 *   (1) PURE PLANNING — {@link planAgentWorktree}: classify FS-writing-ness + resolve the isolation
 *       cwd from the env. Owns no state, runs no git. (Unchanged from P5.)
 *   (2) REAL CREATE + TEARDOWN (H-1) — {@link createAgentWorktree} / {@link removeAgentWorktree}:
 *       actually make a per-agent git worktree (so two concurrent FS-writing agents don't corrupt
 *       ONE shared working tree — feedback_concurrent_dev_worktree) and reap it on teardown. The git
 *       side effect runs through an INJECTABLE {@link GitWorktreeRunner} so unit tests MOCK it (no
 *       real worktree is created/removed in this repo during tests) and the default runner REUSES the
 *       exact pattern the launcher/index.ts already use (`git worktree add --detach <path> HEAD` /
 *       `git worktree remove --force <path>` / `git worktree prune`) — proposal §X X3 "reuse, not
 *       re-implement". The choke-point (M6 result-relay) invokes (2) around an FS-writing dispatch.
 *
 * DORMANT until activation (P6) — and additionally OPT-IN at the dispatch layer (default OFF), so the
 * existing single-attempt dispatch primitive is byte-for-byte unchanged unless a caller asks to manage
 * the worktree. `traces-to: proposal CP3, CP5; §X X3; §M re-homing note; FD2.`
 */

import { execFileSync } from 'node:child_process';
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

/* ────────────────────────────────────────────────────────────────────────────
 * H-1 — REAL per-agent git-worktree CREATE + TEARDOWN.
 *
 * The PLANNING half above only decides WHETHER an agent needs a worktree + which cwd to reuse. This
 * half actually MAKES one when none was provided, so two concurrent FS-writing agents each get their
 * OWN checkout instead of stomping the single shared working tree (feedback_concurrent_dev_worktree).
 *
 * REUSE, not re-implement (the §X X3 constraint): the git commands are byte-identical to the launcher
 * + index.ts pattern — create = `git worktree add --detach <path> HEAD` (a detached-HEAD full checkout
 * at the current commit, so CLAUDE.md + .claude/commands + settingSources all load), teardown =
 * `git worktree remove --force <path>` then `git worktree prune`. The ONLY new thing here is that the
 * commands run through an INJECTABLE {@link GitWorktreeRunner} (tests mock it → no real worktree in
 * this repo) and the path is per-AGENT (not per-supervisor-pid).
 * ──────────────────────────────────────────────────────────────────────────── */

/** The default per-agent isolation-worktree path prefix (a sibling of the launcher's supervisor-worktree-* dirs). */
export const AGENT_WORKTREE_PREFIX = 'D:\\tmp\\agent-worktree-';

/**
 * The injectable git surface the create/teardown use. The default ({@link defaultGitWorktreeRunner})
 * shells out to `git worktree …` in the repo root; TESTS inject a fake that records the calls and runs
 * NO git — so a unit test never creates or removes a real worktree in the live repo. Each method mirrors
 * one launcher/index.ts command exactly.
 */
export interface GitWorktreeRunner {
  /** `git worktree add --detach <worktreePath> <ref>` (ref defaults to HEAD). Throws on failure. */
  add(worktreePath: string, ref: string): void;
  /** `git worktree remove --force <worktreePath>`. May throw (the caller swallows it on teardown). */
  remove(worktreePath: string): void;
  /** `git worktree prune` (reap the just-removed entry). May throw (swallowed on teardown). */
  prune(): void;
}

/**
 * The default git runner — REUSES the exact commands index.ts (379-394) + launch-pty-orch.mjs (63-68)
 * run, via `git worktree` in `repoRoot` (default process.cwd()). Uses execFileSync with an ARGUMENT
 * VECTOR (not a shell string) so a path with spaces can't break the command and there is no shell
 * injection surface. Only reached at real activation (P6); tests inject a fake.
 */
export function defaultGitWorktreeRunner(repoRoot: string = process.cwd()): GitWorktreeRunner {
  const git = (args: string[]): void => {
    execFileSync('git', args, { cwd: repoRoot, stdio: 'ignore' });
  };
  return {
    add(worktreePath: string, ref: string): void {
      git(['worktree', 'add', '--detach', worktreePath, ref]);
    },
    remove(worktreePath: string): void {
      git(['worktree', 'remove', '--force', worktreePath]);
    },
    prune(): void {
      git(['worktree', 'prune']);
    },
  };
}

/** A short, filesystem-safe token from a role (for the per-agent worktree path). */
function sanitizeForPath(s: string): string {
  return String(s).replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 32) || 'agent';
}

/** Options for {@link createAgentWorktree}. */
export interface CreateAgentWorktreeOptions {
  /** The resolved selection (its role/backend label the worktree path). */
  selection: Pick<BackendSelection, 'backend' | 'role'>;
  /** The git runner (default {@link defaultGitWorktreeRunner}()). Tests inject a fake → no real git. */
  runner?: GitWorktreeRunner;
  /** The git ref the detached worktree checks out (default 'HEAD' — the current commit, like the launcher). */
  ref?: string;
  /** The worktree path to create. Default = a unique {@link AGENT_WORKTREE_PREFIX}<role>-<token> path. */
  worktreePath?: string;
  /** Injectable unique-token generator (tests pin it deterministically). Default = time+random. */
  tokenFn?: () => string;
}

/** The handle a created worktree returns — its path + a one-shot, idempotent teardown. */
export interface AgentWorktreeHandle {
  /** The created worktree path (thread this into the agent's start options as `cwd`). */
  worktreePath: string;
  /** Whether a worktree was actually created (false only via {@link removeAgentWorktree} no-op handles). */
  readonly created: boolean;
  /**
   * Tear the worktree down (best-effort; never throws). Idempotent — a double-teardown is a no-op, so a
   * finally-block teardown after an error path is safe. Mirrors index.ts: remove --force, then prune.
   */
  teardown(): void;
}

/**
 * CREATE a per-agent isolation worktree (detached HEAD at `ref`) and return a handle whose `teardown()`
 * reaps it. Used by the choke-point (M6) for an FS-writing agent that did NOT already get an isolation
 * cwd from the launcher. THROWS if the git `add` fails — fail-CLOSED, exactly like the launcher refuses
 * to run an un-isolated orchestrator (an FS-writing agent must not fall back to the shared working tree).
 *
 * The git side effect runs through `opts.runner` (default {@link defaultGitWorktreeRunner}); tests inject
 * a fake so NO real worktree is created in this repo.
 */
export function createAgentWorktree(opts: CreateAgentWorktreeOptions): AgentWorktreeHandle {
  const runner = opts.runner ?? defaultGitWorktreeRunner();
  const ref = opts.ref ?? 'HEAD';
  const token = opts.tokenFn
    ? opts.tokenFn()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const worktreePath =
    opts.worktreePath ?? `${AGENT_WORKTREE_PREFIX}${sanitizeForPath(opts.selection.role)}-${token}`;

  // FAIL-CLOSED: a failure here propagates so the dispatcher does NOT run the agent un-isolated.
  runner.add(worktreePath, ref);

  let torn = false;
  return {
    worktreePath,
    created: true,
    teardown(): void {
      if (torn) return; // idempotent — safe in a finally after an error
      torn = true;
      // Best-effort reap (a leftover worktree is just disk; `git worktree prune` reaps it later). NEVER
      // throw from teardown — it runs in the dispatch finally, where throwing would mask the real result.
      try {
        runner.remove(worktreePath);
      } catch {
        /* leftover is harmless — prune below / a later prune reaps it */
      }
      try {
        runner.prune();
      } catch {
        /* best-effort */
      }
    },
  };
}

/** A no-op handle (created=false) for the path where no worktree was needed — its teardown does nothing. */
export function noopWorktreeHandle(): AgentWorktreeHandle {
  return { worktreePath: '', created: false, teardown(): void {} };
}

/**
 * Convenience: given a routed agent's plan + the create options, decide-and-create. Returns a no-op
 * handle (created:false) when the agent does NOT need an isolation worktree (a compute agent) OR when an
 * isolation cwd was ALREADY provided (the launcher path — REUSE it, create nothing). Otherwise creates a
 * fresh per-agent worktree and returns its handle. This is the single entry the choke-point calls.
 */
export function ensureAgentWorktree(
  plan: AgentWorktreePlan,
  opts: Omit<CreateAgentWorktreeOptions, 'selection'> & {
    selection: Pick<BackendSelection, 'backend' | 'role'>;
  },
): AgentWorktreeHandle {
  // No isolation needed (compute agent) OR an isolation cwd already exists (reuse it) → create nothing.
  if (!plan.needsWorktree || plan.sessionCwd !== undefined) return noopWorktreeHandle();
  return createAgentWorktree(opts);
}

/** Tear down a handle (best-effort, idempotent). Convenience for symmetric call sites. */
export function removeAgentWorktree(handle: AgentWorktreeHandle | undefined): void {
  handle?.teardown();
}
