// ── M12 PRODUCTION launcher for the hosted orchestrator (full-functionality) ──
//
// The PRODUCTION counterpart of the test launcher (launch-pty-orch.mjs). Differences:
//   1. TELEGRAM: connects the supervisor's TelegramAdapter to the user's PRODUCTION bot
//      token (@LeonidsForClaudeBot), read from ~/.claude/channels/telegram/.env
//      (TELEGRAM_BOT_TOKEN), and supplied to the supervisor via SUPERVISOR_TELEGRAM_TOKEN
//      (the ONLY env var the transport policy reads — the supervisor NEVER reads
//      TELEGRAM_BOT_TOKEN itself; review TG2/TG3). This makes the supervisor's adapter the
//      user's LIVE telegram channel (durable inbox-queue → restores two-way telegram with
//      no plugin/reload). PRECONDITION: the prod telegram PLUGIN must be DOWN so the token
//      is FREE (one getUpdates poller per token).
//   2. CWD: the hosted orchestrator runs on the REAL repo (D:\repos\PianoidInstall) with
//      NO worktree isolation — full project access + real dev work (the Pianoid subrepos).
//      (The test launcher creates a throwaway git worktree; production does NOT.)
//
// UNCHANGED from the test launcher (these are SAFETY gates, not test-isolation — they MUST
// stay in production):
//   - cli-stream[claude -p] driver (HAS agent-teams — the orchestrator spawns dev agents) +
//     Opus 4.8[1m], via the orchestrator profile.
//   - COST GUARD: the env stays key-free (we never set ANTHROPIC_API_KEY/AUTH_TOKEN) →
//     index.ts assertCostSafe → the hosted session bills the subscription, never the API.
//   - HIJACK FIX: the hosted claude runs settingSources=project,local (profile) → it does
//     NOT load the user-scope prod telegram PLUGIN → it can't re-seize the token; it reaches
//     the user via the supervisor's ADAPTER. We ALSO delete TELEGRAM_BOT_TOKEN from the
//     child env (defense in depth — the plugin, even if it loaded, would have no token).
//   - PERMISSION ROUTER + SEAL: telegram/whatsapp/email-send are denied (profile policy) →
//     the orchestrator + its sub-agents' dangerous ops route to the USER over the channel;
//     it reaches the user via the supervisor's channel, not by messaging arbitrary contacts.
//   - SINGLE-INSTANCE 8790 guard (one supervisor per test bot/panel).
//
// The token only ever lives in the child's env — never on a command line or in output.
import { spawn, execSync } from 'node:child_process';
import { readFileSync, openSync, existsSync } from 'node:fs';

const REPO_ROOT = 'D:\\repos\\PianoidInstall';
const SUP_DIR = 'D:\\repos\\PianoidInstall\\tools\\supervisor';
const PROD_ENV_FILE = 'C:\\Users\\astri\\.claude\\channels\\telegram\\.env';
// ── STARTUP CONTEXT-PICKUP: the conventional path the orchestrator STAGES a parent-restart
//    handoff brief to (BEFORE firing restart-supervisor.ps1). If present + non-empty when the
//    fresh supervisor launches, we point SUPERVISOR_STARTUP_HANDOFF_FILE at it so the fresh
//    orchestrator's FIRST turn carries the brief (auto-resume) instead of booting cold. The
//    supervisor consumes (deletes) the file after injecting it, so a later plain restart with no
//    new brief boots normally. An explicit SUPERVISOR_STARTUP_HANDOFF_FILE env still wins.
const STAGED_HANDOFF_FILE = 'D:\\tmp\\supervisor-startup-handoff.txt';
// ── VOICE I/O: the STT (faster-whisper) + TTS (edge-tts) helpers live under the
// repo tools/, and their deps live ONLY in the Pianoid venv — NOT a bare system
// python. We PIN both so inbound voice notes transcribe (not the "(voice message)"
// placeholder) regardless of the supervisor's cwd. config.ts derives the same
// defaults from its own module location; this is belt-and-suspenders for prod.
const REPO_TOOLS_DIR = 'D:\\repos\\PianoidInstall\\tools';
const VENV_PYTHON = 'D:\\repos\\PianoidInstall\\PianoidCore\\.venv\\Scripts\\python.exe';

// ── SINGLE-INSTANCE GUARD: refuse a 2nd supervisor if panel 8790 is already owned. ──
try {
  const owner = execSync('netstat -ano', { encoding: 'utf8' })
    .split('\n')
    .find((l) => /:8790\s/.test(l) && /LISTENING/i.test(l));
  if (owner) {
    process.stderr.write('launch-prod: REFUSING — panel 8790 is already in use (a supervisor is already running). Stop it first.\n');
    process.exit(2);
  }
} catch {
  /* netstat unavailable — proceed (the panel bind would EADDRINUSE anyway) */
}

// ── Read the PRODUCTION telegram bot token from the channel .env (TELEGRAM_BOT_TOKEN). ──
let prodToken = '';
try {
  const envText = readFileSync(PROD_ENV_FILE, 'utf8');
  const m = envText.match(/^\s*TELEGRAM_BOT_TOKEN\s*=\s*(.+?)\s*$/m);
  prodToken = m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
} catch (e) {
  process.stderr.write(`launch-prod: could not read ${PROD_ENV_FILE}: ${String(e)}\n`);
  process.exit(1);
}
if (!prodToken || prodToken.length < 20) {
  process.stderr.write('launch-prod: PRODUCTION TELEGRAM_BOT_TOKEN missing/short in the channel .env\n');
  process.exit(1);
}

// ── Child env: prod token via SUPERVISOR_TELEGRAM_TOKEN; real-repo cwd; NO worktree. ──
const env = { ...process.env };
env.SUPERVISOR_TELEGRAM_TOKEN = prodToken; // the prod token — the ONLY var the transport reads
delete env.TELEGRAM_BOT_TOKEN; // defense in depth: the hosted claude's plugin (if any) gets no token
delete env.SUPERVISOR_SYSTEM_PROMPT; // orchestrator uses preset+append, not the demo persona
delete env.SUPERVISOR_WORKTREE_CLEANUP; // PRODUCTION: no isolation worktree to clean up
env.SUPERVISOR_SESSION_CWD = REPO_ROOT; // ★ the hosted orchestrator runs on the REAL repo
// ★ VOICE I/O pin: the repo tools/ (STT/TTS helper scripts) + the venv python
//   (faster-whisper/edge-tts deps). Without these the supervisor defaulted to a
//   non-existent ~/.claude script path + a bare python that lacks faster-whisper,
//   so inbound voice notes were delivered as the literal "(voice message)".
env.SUPERVISOR_TOOLS_DIR = REPO_TOOLS_DIR;
if (existsSync(VENV_PYTHON)) {
  env.SUPERVISOR_PYTHON = VENV_PYTHON;
} else {
  process.stderr.write(
    `launch-prod: WARN — venv python not found at ${VENV_PYTHON}; voice STT/TTS may degrade to text (config falls back to system python)\n`,
  );
}
// ── ★ DISPATCH ACTIVATION (B1 + C1) — staged 2026-06-21 (dev-e9d9). Takes effect on the NEXT
//    supervisor start (the running supervisor keeps its in-memory dist+env until the user restarts).
//    Turns ON model-agnostic role routing (so the dormant dispatch surface + the /control Dispatch
//    button + POST /api/dispatch become live) AND the ENFORCED spend caps (per-dispatch + rolling).
//    These are reversible: revert this block + restore dist.bak.pre-dispatch-activation/ → dist/.
env.SUPERVISOR_ROLE_ROUTING = 'on';            // P-B1: enable routed dispatch (dispatchRole wired)
env.SUPERVISOR_DISPATCH_COST_CAP_USD = '0.50'; // P-C1: per-dispatch USD ceiling (fail-closed)
env.SUPERVISOR_DISPATCH_COST_WINDOW_USD = '5';  // P-C1: rolling cumulative USD ceiling over the window
env.SUPERVISOR_DISPATCH_EST_COST_USD = '0.05';  // P-C1: conservative per-dispatch admission estimate
//   (0.05 is a deliberate small non-zero estimate so BOTH caps engage at admission: a single dispatch
//    estimated at $0.05 is well under the $0.50 per-dispatch cap [admit], while the rolling $5 window
//    starts refusing once ~100 dispatches' worth of estimate accumulates — the real cost is charged on
//    release so the ledger stays truthful. Tune up if dispatches are routinely larger.)
//
// ── ★ DEEPSEEK KEY BRIDGE — INTENTIONALLY LEFT OFF (dev-e9d9, 2026-06-21). The bridge would let a
//    routed DeepSeek (coding) dispatch with no /setkey key fall back to the deepseek-codegen MCP's key,
//    which lives ONLY in user-scope ~/.claude.json — the file the supervisor deliberately avoids
//    loading (token-hijack containment). Enabling it crosses that boundary. The coordinator relayed a
//    "user approved" but a RELAYED approval is NOT the user's own authority, so this flag is NOT set
//    here. To enable AFTER the USER's own confirmation, uncomment the next line + rebuild + restart:
// env.SUPERVISOR_DEEPSEEK_KEY_BRIDGE = 'on';   // ← gated on the USER's direct sign-off (see WIP NEEDS-USER-DECISION)

// (We deliberately do NOT set ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN — the cost guard
//  asserts the env is key-free so the hosted session stays on the subscription.)

// ★ STARTUP CONTEXT-PICKUP: signal the fresh supervisor to auto-resume from a staged parent-restart
//   brief. An explicit env wins; otherwise, if the conventional staged file is present + non-empty,
//   point the env at it. The supervisor reads + DELETES it after injecting it into the first turn.
if (!env.SUPERVISOR_STARTUP_HANDOFF_FILE) {
  try {
    if (existsSync(STAGED_HANDOFF_FILE) && readFileSync(STAGED_HANDOFF_FILE, 'utf8').trim() !== '') {
      env.SUPERVISOR_STARTUP_HANDOFF_FILE = STAGED_HANDOFF_FILE;
    }
  } catch {
    /* staged-handoff probe failed — boot without pickup (fail-soft, never block the relaunch) */
  }
}

const errLog = openSync('D:\\tmp\\supervisor-prod.err.log', 'a');
const outLog = openSync('D:\\tmp\\supervisor-prod.out.log', 'a');

const child = spawn(
  process.execPath,
  // No --driver: the orchestrator profile defaults to cli-stream (claude -p + teams).
  ['dist/index.js', '--live', '--session', '--profile', 'orchestrator', '--panel', '8790'],
  { cwd: SUP_DIR, env, detached: true, stdio: ['ignore', outLog, errLog] },
);
child.unref();
// print ONLY the pid (never the token)
process.stdout.write(
  `LAUNCHED PRODUCTION supervisor pid=${child.pid} ` +
    `(driver=cli-stream[claude -p] profile=orchestrator model=opus-4-8[1m] panel=8790; ` +
    `telegram=PROD-token-via-SUPERVISOR_TELEGRAM_TOKEN; TELEGRAM_BOT_TOKEN UNSET in child; ` +
    `hosted cwd=${REPO_ROOT} [REAL repo, NO worktree]; cost-guard=on; seal=on; ` +
    `role-routing=${env.SUPERVISOR_ROLE_ROUTING ?? 'off'}; ` +
    `spend-caps=$${env.SUPERVISOR_DISPATCH_COST_CAP_USD ?? '0'}/dispatch+$${env.SUPERVISOR_DISPATCH_COST_WINDOW_USD ?? '0'}/window; ` +
    `deepseek-bridge=${env.SUPERVISOR_DEEPSEEK_KEY_BRIDGE ?? 'off'}; ` +
    `startup-handoff=${env.SUPERVISOR_STARTUP_HANDOFF_FILE ? 'STAGED (auto-resume)' : 'none (cold boot)'})\n`,
);
process.exit(0);
