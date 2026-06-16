// Launch wrapper for the test-bot supervisor (--driver pty --profile orchestrator).
// Reads the dedicated test token from D:\tmp\supervisor-test.env (NEVER logged/printed),
// sets SUPERVISOR_TELEGRAM_TOKEN, UNSETS the prod token, spawns dist/index.js detached.
// The token only ever lives in the child's env — never on a command line or in output.
import { spawn, execSync } from 'node:child_process';
import { readFileSync, openSync } from 'node:fs';

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

const env = { ...process.env };
env.SUPERVISOR_TELEGRAM_TOKEN = token; // dedicated test token
delete env.TELEGRAM_BOT_TOKEN; // never the production token
delete env.SUPERVISOR_SYSTEM_PROMPT; // orchestrator uses preset+append, not the demo persona
env.SUPERVISOR_RAW_CAPTURE = 'D:\\tmp\\supervisor-pty-raw.log'; // RAW render dump → capture a live gate's real bytes

const errLog = openSync('D:\\tmp\\supervisor-pty-orch.err.log', 'a');
const outLog = openSync('D:\\tmp\\supervisor-pty-orch.out.log', 'a');

const child = spawn(
  process.execPath,
  ['dist/index.js', '--live', '--session', '--driver', 'pty', '--profile', 'orchestrator', '--panel', '8790'],
  { cwd: 'D:\\repos\\PianoidInstall\\tools\\supervisor', env, detached: true, stdio: ['ignore', outLog, errLog] },
);
child.unref();
// print ONLY the pid (never the token)
process.stdout.write(`LAUNCHED supervisor pid=${child.pid} (driver=pty profile=orchestrator panel=8790; prod token UNSET)\n`);
process.exit(0);
