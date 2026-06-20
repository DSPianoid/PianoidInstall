/**
 * AGENT WORKTREE ISOLATION tests (P5 / X3) — the PURE planning hook that decides whether a
 * routed agent needs a git worktree (FS-writing backend) and which cwd it runs in, REUSING the
 * existing SUPERVISOR_SESSION_CWD mechanism. It runs NO git and creates NO worktree (that stays
 * in index.ts, P6) — so these tests assert classification + cwd resolution only, no filesystem.
 *
 * Traces: proposal §X X3; §M re-homing note (REUSE the existing worktree mechanism); FD2; CP3/CP5.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planAgentWorktree,
  createAgentWorktree,
  ensureAgentWorktree,
  removeAgentWorktree,
  noopWorktreeHandle,
  AGENT_WORKTREE_PREFIX,
  SESSION_CWD_ENV_VAR,
  WORKTREE_CLEANUP_ENV_VAR,
  type GitWorktreeRunner,
} from '../agent-worktree.js';
import { BACKEND_FS_WRITES, backendWritesFilesystem } from '../backend-kinds.js';
import type { BackendSelection } from '../backend-kinds.js';

/**
 * A FAKE git runner that RECORDS every call and runs NO git — so a test never creates or removes a real
 * worktree in this repo. `failOn` makes a chosen op throw (to exercise fail-closed create + best-effort
 * teardown).
 */
function recordingRunner(failOn?: 'add' | 'remove' | 'prune'): GitWorktreeRunner & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    add(p: string, ref: string): void {
      calls.push(`add ${p} ${ref}`);
      if (failOn === 'add') throw new Error('git worktree add failed (fake)');
    },
    remove(p: string): void {
      calls.push(`remove ${p}`);
      if (failOn === 'remove') throw new Error('git worktree remove failed (fake)');
    },
    prune(): void {
      calls.push('prune');
      if (failOn === 'prune') throw new Error('git worktree prune failed (fake)');
    },
  };
}

const CLAUDE_SEL: Pick<BackendSelection, 'backend' | 'role'> = { backend: 'claude-cli', role: 'planning' };
const API_SEL: Pick<BackendSelection, 'backend' | 'role'> = { backend: 'api-adapter', role: 'coding' };

const CLAUDE: Pick<BackendSelection, 'backend'> = { backend: 'claude-cli' };
const API: Pick<BackendSelection, 'backend'> = { backend: 'api-adapter' };

// ── FS-writing classification (the data the rule keys on) ──────────────────────────
test('★ FS-writing classification: claude-cli MAY write (true); api-adapter is compute-only (false)', () => {
  assert.equal(BACKEND_FS_WRITES['claude-cli'], true);
  assert.equal(BACKEND_FS_WRITES['api-adapter'], false);
  assert.equal(backendWritesFilesystem('claude-cli'), true);
  assert.equal(backendWritesFilesystem('api-adapter'), false);
});

// ── the planner REUSES the existing env-var contract (no parallel convention) ───────
test('the planner re-exports the SAME env-var names index.ts uses (one worktree contract, reused)', () => {
  assert.equal(SESSION_CWD_ENV_VAR, 'SUPERVISOR_SESSION_CWD');
  assert.equal(WORKTREE_CLEANUP_ENV_VAR, 'SUPERVISOR_WORKTREE_CLEANUP');
});

// ── an FS-writing backend is flagged for a worktree; a pure api-adapter is NOT ──────
test('★ an FS-writing backend (claude-cli) is flagged for a worktree; a pure api-adapter is NOT', () => {
  const claudePlan = planAgentWorktree(CLAUDE, { env: {} as NodeJS.ProcessEnv });
  assert.equal(claudePlan.needsWorktree, true);

  const apiPlan = planAgentWorktree(API, { env: {} as NodeJS.ProcessEnv });
  assert.equal(apiPlan.needsWorktree, false);
  assert.equal(apiPlan.sessionCwd, undefined, 'a compute agent gets NO worktree cwd');
});

test('★ a claude-cli agent resolves its sessionCwd to the existing SUPERVISOR_SESSION_CWD isolation path', () => {
  const env = { SUPERVISOR_SESSION_CWD: '/repos/worktrees/agent-7f3a' } as NodeJS.ProcessEnv;
  const plan = planAgentWorktree(CLAUDE, { env });
  assert.equal(plan.needsWorktree, true);
  assert.equal(plan.sessionCwd, '/repos/worktrees/agent-7f3a'); // REUSED, not invented
});

test('a claude-cli agent with NO isolation cwd set → needsWorktree true but sessionCwd undefined (caller default cwd)', () => {
  const plan = planAgentWorktree(CLAUDE, { env: {} as NodeJS.ProcessEnv });
  assert.equal(plan.needsWorktree, true);
  assert.equal(plan.sessionCwd, undefined); // falls back to the caller's default cwd (today's behavior)
});

test('an api-adapter agent IGNORES a set SUPERVISOR_SESSION_CWD (compute agent never gets a worktree cwd)', () => {
  const env = { SUPERVISOR_SESSION_CWD: '/repos/worktrees/should-be-ignored' } as NodeJS.ProcessEnv;
  const plan = planAgentWorktree(API, { env });
  assert.equal(plan.needsWorktree, false);
  assert.equal(plan.sessionCwd, undefined);
});

// ── override: a tool-granted api-adapter (future) can be forced FS-writing; a compute claude forced off ──
test('writesFilesystem override flips the default (a future tool-granted api-adapter; or a compute-only claude run)', () => {
  // force an api-adapter to FS-writing (it was granted tools out-of-band)
  const forcedWrite = planAgentWorktree(API, {
    env: { SUPERVISOR_SESSION_CWD: '/wt/api-fs' } as NodeJS.ProcessEnv,
    writesFilesystem: true,
  });
  assert.equal(forcedWrite.needsWorktree, true);
  assert.equal(forcedWrite.sessionCwd, '/wt/api-fs');

  // force a claude-cli to compute-only (no worktree)
  const forcedCompute = planAgentWorktree(CLAUDE, {
    env: { SUPERVISOR_SESSION_CWD: '/wt/ignored' } as NodeJS.ProcessEnv,
    writesFilesystem: false,
  });
  assert.equal(forcedCompute.needsWorktree, false);
  assert.equal(forcedCompute.sessionCwd, undefined);
});

test('the planner is PURE — it never mutates the passed env', () => {
  const env = { SUPERVISOR_SESSION_CWD: '/wt/x', OTHER: 'keep' } as NodeJS.ProcessEnv;
  const before = { ...env };
  planAgentWorktree(CLAUDE, { env });
  assert.deepEqual(env, before, 'env must be unchanged (read-only planning)');
});

test('an empty/whitespace SUPERVISOR_SESSION_CWD is treated as unset (no bogus cwd)', () => {
  const plan = planAgentWorktree(CLAUDE, { env: { SUPERVISOR_SESSION_CWD: '   ' } as NodeJS.ProcessEnv });
  assert.equal(plan.needsWorktree, true);
  assert.equal(plan.sessionCwd, undefined);
});

// ════════════════════════════════════════════════════════════════════════════════
// H-1 — REAL per-agent worktree CREATE + TEARDOWN (mocked git; NO real worktree here)
// ════════════════════════════════════════════════════════════════════════════════

test('★★ H-1 createAgentWorktree REUSES the launcher git pattern: `worktree add --detach <path> HEAD`', () => {
  const runner = recordingRunner();
  const handle = createAgentWorktree({ selection: CLAUDE_SEL, runner, tokenFn: () => 'tok123' });
  assert.equal(handle.created, true);
  // path = the per-agent prefix + sanitized role + token (NOT the supervisor-pid path)
  assert.equal(handle.worktreePath, `${AGENT_WORKTREE_PREFIX}planning-tok123`);
  // the ONE create command, byte-identical to index.ts/launch (detached HEAD)
  assert.deepEqual(runner.calls, [`add ${AGENT_WORKTREE_PREFIX}planning-tok123 HEAD`]);
});

test('★★ H-1 teardown REUSES the launcher git pattern: `remove --force <path>` then `prune`', () => {
  const runner = recordingRunner();
  const handle = createAgentWorktree({ selection: CLAUDE_SEL, runner, tokenFn: () => 't' });
  runner.calls.length = 0; // drop the add, focus on teardown
  handle.teardown();
  assert.deepEqual(runner.calls, [`remove ${AGENT_WORKTREE_PREFIX}planning-t`, 'prune']);
});

test('★ H-1 teardown is IDEMPOTENT — a double teardown does not re-run git (safe in a finally)', () => {
  const runner = recordingRunner();
  const handle = createAgentWorktree({ selection: CLAUDE_SEL, runner, tokenFn: () => 't' });
  runner.calls.length = 0;
  handle.teardown();
  handle.teardown(); // second call is a no-op
  assert.deepEqual(runner.calls, [`remove ${AGENT_WORKTREE_PREFIX}planning-t`, 'prune']); // only ONE round
});

test('★ H-1 createAgentWorktree is FAIL-CLOSED — a failed `add` THROWS (no un-isolated fallback)', () => {
  const runner = recordingRunner('add');
  assert.throws(() => createAgentWorktree({ selection: CLAUDE_SEL, runner, tokenFn: () => 't' }), /git worktree add failed/);
});

test('★ H-1 teardown NEVER throws even if `remove`/`prune` fail (best-effort reap)', () => {
  const removeFails = recordingRunner('remove');
  const h1 = createAgentWorktree({ selection: CLAUDE_SEL, runner: removeFails, tokenFn: () => 't' });
  assert.doesNotThrow(() => h1.teardown());
  // prune still attempted after a failed remove (leftover is harmless; prune reaps it later)
  assert.ok(removeFails.calls.includes('prune'));

  const pruneFails = recordingRunner('prune');
  const h2 = createAgentWorktree({ selection: CLAUDE_SEL, runner: pruneFails, tokenFn: () => 't' });
  assert.doesNotThrow(() => h2.teardown());
});

test('★ H-1 ensureAgentWorktree: an FS-writing plan with NO isolation cwd → CREATES a worktree', () => {
  const runner = recordingRunner();
  const plan = planAgentWorktree(CLAUDE_SEL, { env: {} as NodeJS.ProcessEnv }); // needs=true, cwd unset
  const handle = ensureAgentWorktree(plan, { selection: CLAUDE_SEL, runner, tokenFn: () => 'x' });
  assert.equal(handle.created, true);
  assert.deepEqual(runner.calls, [`add ${AGENT_WORKTREE_PREFIX}planning-x HEAD`]);
});

test('★★ H-1 ensureAgentWorktree: a COMPUTE api-adapter agent → NO worktree (no git at all)', () => {
  const runner = recordingRunner();
  const plan = planAgentWorktree(API_SEL, { env: {} as NodeJS.ProcessEnv }); // needs=false
  const handle = ensureAgentWorktree(plan, { selection: API_SEL, runner });
  assert.equal(handle.created, false);
  assert.deepEqual(runner.calls, [], 'a compute agent runs NO git');
});

test('★ H-1 ensureAgentWorktree: an ALREADY-isolated agent (SUPERVISOR_SESSION_CWD set) → REUSE, no create', () => {
  const runner = recordingRunner();
  const plan = planAgentWorktree(CLAUDE_SEL, {
    env: { SUPERVISOR_SESSION_CWD: '/repos/wt/existing' } as NodeJS.ProcessEnv,
  });
  assert.equal(plan.sessionCwd, '/repos/wt/existing'); // the launcher already provided one
  const handle = ensureAgentWorktree(plan, { selection: CLAUDE_SEL, runner });
  assert.equal(handle.created, false);
  assert.deepEqual(runner.calls, [], 'an already-isolated agent creates NO new worktree (reuses the launcher one)');
});

test('H-1 noopWorktreeHandle + removeAgentWorktree(undefined) are safe no-ops', () => {
  const noop = noopWorktreeHandle();
  assert.equal(noop.created, false);
  assert.doesNotThrow(() => noop.teardown());
  assert.doesNotThrow(() => removeAgentWorktree(undefined));
});

test('H-1 path is filesystem-safe (a role with odd chars is sanitized, never breaks the path)', () => {
  const runner = recordingRunner();
  const handle = createAgentWorktree({
    selection: { backend: 'claude-cli', role: 'weird/role name!!' },
    runner,
    tokenFn: () => 'z',
  });
  assert.ok(handle.worktreePath.startsWith(AGENT_WORKTREE_PREFIX));
  assert.ok(!/[^A-Za-z0-9_\\:.-]/.test(handle.worktreePath), 'no unsafe chars in the worktree path');
});
