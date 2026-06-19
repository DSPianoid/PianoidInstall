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
  SESSION_CWD_ENV_VAR,
  WORKTREE_CLEANUP_ENV_VAR,
} from '../agent-worktree.js';
import { BACKEND_FS_WRITES, backendWritesFilesystem } from '../backend-kinds.js';
import type { BackendSelection } from '../backend-kinds.js';

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
