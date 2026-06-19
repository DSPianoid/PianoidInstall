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
import { readFileSync, openSync } from 'node:fs';

const REPO_ROOT = 'D:\\repos\\PianoidInstall';
const SUP_DIR = 'D:\\repos\\PianoidInstall\\tools\\supervisor';
const PROD_ENV_FILE = 'C:\\Users\\astri\\.claude\\channels\\telegram\\.env';

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
// (We deliberately do NOT set ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN — the cost guard
//  asserts the env is key-free so the hosted session stays on the subscription.)

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
    `hosted cwd=${REPO_ROOT} [REAL repo, NO worktree]; cost-guard=on; seal=on)\n`,
);
process.exit(0);
