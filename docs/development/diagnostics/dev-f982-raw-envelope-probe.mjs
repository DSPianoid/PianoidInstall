/**
 * dev-f982 — RAW `claude -p` stream-json envelope probe (channel-flood fix measurement).
 *
 * PURPOSE: measure the EXACT raw stream-json envelope a BACKGROUND-task sub-agent
 * (Agent tool with run_in_background:true) emits, vs a FOREGROUND sidechain sub-agent,
 * vs the MAIN orchestrator session — to find the discriminator that distinguishes a
 * sub-agent message from the orchestrator's own. The supervisor /api/capture stores
 * only POST-mapper data ({text,toolUses}); this probe captures the RAW NDJSON.
 *
 * ISOLATION: spawns its OWN headless `claude -p` (separate process, separate session),
 * writes raw stdout NDJSON to a file. It does NOT touch the user's Telegram channel.
 * No --api-key (subscription billing, like the real driver). Bounded by a hard timeout.
 *
 * USAGE: node docs/development/diagnostics/dev-f982-raw-envelope-probe.mjs > /tmp/raw-ndjson.txt
 */
import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';

const TIMEOUT_MS = 180_000;

// Resolve the real claude .exe (avoid cmd.exe shim arg limits), mirroring the driver.
function resolveDirectExecutable(resolved) {
  if (!/\.(cmd|bat)$/i.test(resolved)) return resolved;
  try {
    const text = readFileSync(resolved, 'utf8');
    const matches = [...text.matchAll(/"([^"]*?\.exe)"/gi)].map((m) => m[1]);
    if (matches.length === 0) return resolved;
    let exe = matches[matches.length - 1];
    const shimDir = dirname(resolved);
    exe = exe.replace(/%~?dp0%?\\?/gi, shimDir + '\\');
    const abs = isAbsolute(exe) ? exe : join(shimDir, exe);
    if (statSync(abs).isFile()) return abs;
  } catch {}
  return resolved;
}
function resolveCommandPath(command, env) {
  if (command.includes('/') || command.includes('\\')) return command;
  const isWin = process.platform === 'win32';
  const dirs = (env.PATH ?? env.Path ?? '').split(isWin ? ';' : ':').filter(Boolean);
  const exts = isWin ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  for (const dir of dirs) for (const ext of exts) {
    const c = join(dir, command + ext);
    try { if (statSync(c).isFile()) return c; } catch {}
  }
  return command;
}

const cmd = resolveDirectExecutable(resolveCommandPath('claude', process.env));
const args = ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose',
  '--permission-mode', 'bypassPermissions'];

const child = spawn(cmd, args, { cwd: process.cwd(), env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });

const prompt =
  'Spawn ONE background sub-agent NOW with the Agent tool: subagent_type "general-purpose", ' +
  'run_in_background set to true, description "probe bg", prompt exactly: ' +
  '"Reply with exactly these two short lines and nothing else, then stop: ' +
  'Line one: BG-NARRATION-ALPHA. Line two: BG-NARRATION-BETA." ' +
  'After you launch it, do not do anything else except wait for it to finish; ' +
  'when it finishes, reply with the single word DONE.';

child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n');

let buf = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).replace(/\r$/, '');
    buf = buf.slice(nl + 1);
    if (line.trim()) process.stdout.write(line + '\n');
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (d) => process.stderr.write('[stderr] ' + d));

const timer = setTimeout(() => { process.stderr.write('[probe] TIMEOUT — killing\n'); try { child.kill('SIGKILL'); } catch {} }, TIMEOUT_MS);
child.on('exit', (code) => { clearTimeout(timer); process.stderr.write(`[probe] child exited code=${code}\n`); process.exit(0); });
