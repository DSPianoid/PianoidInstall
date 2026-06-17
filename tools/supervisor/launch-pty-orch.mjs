// Launch wrapper for the test-bot supervisor (--driver pty --profile orchestrator).
// Reads the dedicated test token from D:\tmp\supervisor-test.env (NEVER logged/printed),
// sets SUPERVISOR_TELEGRAM_TOKEN, UNSETS the prod token, spawns dist/index.js detached.
// The token only ever lives in the child's env — never on a command line or in output.
//
// #2 WORKTREE HARD ISOLATION: before spawning, create a SEPARATE git worktree of the repo
// (detached HEAD at the current commit) and point the hosted orchestrator's cwd at it via
// SUPERVISOR_SESSION_CWD. The orchestrator's file writes then land in the WORKTREE, not the
// real working tree under an active /dev. The supervisor process itself still runs in
// tools/supervisor (to find dist/). Teardown: the supervisor removes the worktree on a
// graceful stop (SUPERVISOR_WORKTREE_CLEANUP); a hard kill leaks it, so we ALSO prune stale
// supervisor worktrees here at startup (reaping a hard-killed predecessor's).
import { spawn, execSync } from 'node:child_process';
import { readFileSync, openSync, existsSync } from 'node:fs';

const REPO_ROOT = 'D:\\repos\\PianoidInstall';
const SUP_DIR = 'D:\\repos\\PianoidInstall\\tools\\supervisor';
const WORKTREE_PREFIX = 'D:\\tmp\\supervisor-worktree-';
const gitOpts = { cwd: REPO_ROOT, encoding: 'utf8' };

// DOUBLE-SUPERVISOR GUARD: refuse to launch a 2nd supervisor if panel 8790 is already
// owned — two supervisors on the SAME test bot = a duplicate sender (the user "double
// responses" hazard). Fail loud rather than start a second poller/sender.
try {
  const owner = execSync('netstat -ano', { encoding: 'utf8' })
    .split('\n')
    .find((l) => /:8790\s/.test(l) && /LISTENING/i.test(l));
  if (owner) {
    process.stderr.write('launch: REFUSING — panel 8790 is already in use (a supervisor is already running). Stop it first.\n');
    process.exit(2);
  }
} catch {
  /* netstat unavailable — proceed (the panel bind would EADDRINUSE anyway) */
}

const token = readFileSync('D:\\tmp\\supervisor-test.env', 'utf8').trim();
if (!token || token.length < 20) {
  process.stderr.write('launch: test token missing/short in D:\\tmp\\supervisor-test.env\n');
  process.exit(1);
}

// ── #2 worktree isolation: prune stale predecessors, then create a fresh worktree ──
// 1) Reap any leftover supervisor worktrees (a hard-killed predecessor can't self-clean).
try {
  const list = execSync('git worktree list --porcelain', gitOpts);
  for (const line of list.split('\n')) {
    const m = line.match(/^worktree (.+)$/);
    if (m && m[1] && m[1].replace(/\//g, '\\').startsWith(WORKTREE_PREFIX)) {
      try {
        execSync(`git worktree remove --force "${m[1]}"`, gitOpts);
        process.stdout.write(`launch: pruned stale isolation worktree ${m[1]}\n`);
      } catch { /* best-effort */ }
    }
  }
  execSync('git worktree prune', gitOpts);
} catch { /* git unavailable / no worktrees — proceed */ }

// 2) Create the isolation worktree (detached HEAD at the current commit), per-pid path.
const worktreePath = `${WORKTREE_PREFIX}${process.pid}`;
let isolated = false;
try {
  if (existsSync(worktreePath)) execSync(`git worktree remove --force "${worktreePath}"`, gitOpts);
  execSync(`git worktree add --detach "${worktreePath}" HEAD`, gitOpts);
  isolated = true;
  process.stdout.write(`launch: created isolation worktree ${worktreePath} (detached HEAD)\n`);
} catch (e) {
  // FAIL-CLOSED for safety: if we can't isolate, do NOT launch an un-isolated orchestrator
  // that could mutate the real working tree. (The soft preamble guard is the fallback only
  // if the operator explicitly launches without isolation.)
  process.stderr.write(`launch: REFUSING — could not create the isolation worktree: ${String(e)}\n`);
  process.exit(3);
}

const env = { ...process.env };
env.SUPERVISOR_TELEGRAM_TOKEN = token; // dedicated test token
delete env.TELEGRAM_BOT_TOKEN; // never the production token
delete env.SUPERVISOR_SYSTEM_PROMPT; // orchestrator uses preset+append, not the demo persona
env.SUPERVISOR_RAW_CAPTURE = 'D:\\tmp\\supervisor-pty-raw.log'; // RAW render dump → capture a live gate's real bytes
env.SUPERVISOR_SESSION_CWD = worktreePath; // #2: the hosted orchestrator runs in the worktree
env.SUPERVISOR_WORKTREE_CLEANUP = worktreePath; // #2: the supervisor removes it on graceful stop

const errLog = openSync('D:\\tmp\\supervisor-pty-orch.err.log', 'a');
const outLog = openSync('D:\\tmp\\supervisor-pty-orch.out.log', 'a');

const child = spawn(
  process.execPath,
  ['dist/index.js', '--live', '--session', '--driver', 'pty', '--profile', 'orchestrator', '--panel', '8790'],
  { cwd: SUP_DIR, env, detached: true, stdio: ['ignore', outLog, errLog] },
);
child.unref();
// print ONLY the pid (never the token)
process.stdout.write(`LAUNCHED supervisor pid=${child.pid} (driver=pty profile=orchestrator panel=8790; prod token UNSET; isolated=${isolated} cwd=${worktreePath})\n`);
process.exit(0);
