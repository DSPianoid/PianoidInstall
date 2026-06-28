/**
 * Session-profile + safety-floor tests. The destructive-op predicate is the heart
 * of the orchestrator profile's safety floor — it must route the team-lead's exact
 * set (rm -rf / system-PID kill / git push / git reset --hard / disk-format /
 * outward third-party sends) while leaving routine ops alone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isDestructiveOp,
  isDestructiveShellCommand,
  isSupervisorRelaunchCommand,
  makeDemoProfile,
  makeOrchestratorProfile,
  makeOrchestratorPolicy,
  resolveProfile,
} from '../profiles.js';
import { PermissionRouter, type PermissionChannel } from '../permission-router.js';
import type { PermissionRequest } from '../session-driver.js';

test('isDestructiveShellCommand routes the destructive set, allows routine commands', () => {
  // Destructive → true (route).
  for (const c of [
    'rm -rf /tmp/x',
    'rm -fr build',
    'sudo rm -Rf node_modules',
    'git push origin master',
    'git push --force',
    'git reset --hard HEAD~1',
    'git clean -fd',
    'taskkill /F /PID 1234',
    'Stop-Process -Id 9988 -Force',
    'mkfs.ext4 /dev/sda1',
    'format C:',
    'diskpart',
    'shutdown /r',
  ]) {
    assert.equal(isDestructiveShellCommand(c), true, `should route: ${c}`);
  }
  // Routine → false (allow).
  for (const c of [
    'ls -la',
    'git status',
    'npm run build',
    'rm file.txt', // a single non-recursive rm is NOT in the floor
    'cat README.md',
    'taskkill /IM node.exe', // image-name kill (not a system PID) → not floored
    'echo hello',
  ]) {
    assert.equal(isDestructiveShellCommand(c), false, `should allow: ${c}`);
  }
});

test('isSupervisorRelaunchCommand routes a PARENT/dist supervisor restart (the host-cycle gate)', () => {
  // The orchestrator cycling its OWN host (parent-restart) → must be confirmed (route).
  for (const c of [
    "powershell -noprofile -executionpolicy bypass -file 'd:\\tmp\\restart-supervisor.ps1' -launcher prod",
    'powershell -file tools/supervisor/restart-supervisor.ps1 -launcher test',
    'node launch-prod-orch.mjs',
    'node tools/supervisor/launch-pty-orch.mjs',
    'node dist/index.js --live --session --profile orchestrator --panel 8790',
    'node dist\\index.js --session', // backslash path variant (windows)
  ]) {
    assert.equal(isSupervisorRelaunchCommand(c.toLowerCase()), true, `relaunch should route: ${c}`);
    // And it flows through the public floor predicate the router actually calls.
    assert.equal(isDestructiveShellCommand(c), true, `floor should route relaunch: ${c}`);
  }
  // NOT a relaunch (no false positives): reading/inspecting the files, unrelated node launches,
  // a child-only restart-request curl (that path already confirms in-channel).
  for (const c of [
    'cat tools/supervisor/restart-supervisor.ps1', // reading the script ≠ running it
    'ls tools/supervisor', // listing the dir
    'grep -n launcher tools/supervisor/launch-prod-orch.mjs', // grepping the launcher source
    'node dist/index.js --panel 8790', // a non-host (no --session) dev shell launch
    'curl -X POST http://127.0.0.1:8790/api/lifecycle/restart-request', // child restart-request (confirms in-channel already)
    'node build.js',
  ]) {
    assert.equal(isSupervisorRelaunchCommand(c.toLowerCase()), false, `not a relaunch: ${c}`);
    assert.equal(isDestructiveShellCommand(c), false, `floor must NOT route: ${c}`);
  }
});

test('isSupervisorRelaunchCommand catches SHELL-MANGLED (separator-stripped) forms (the predicate-miss fix)', () => {
  // Git-Bash strips backslashes before we ever see the command — `\brestart-supervisor\.ps1\b`
  // / `dist[\\/]index.js` / `\blaunch-…` anchored patterns would MISS these. The hardened
  // predicate tests a separator-stripped copy too, so the mangled forms still route.
  for (const c of [
    // backslash path collapsed onto the script name + the execution marker survives
    "powershell -noprofile -executionpolicy bypass -file 'd:tmprestart-supervisor.ps1' -launcher prod",
    // backslash-stripped direct host launch: dist\index.js → distindex.js
    'node distindex.js --session --profile orchestrator',
    'node distindex.js --live --session',
    // backslash-stripped launcher path: tools\supervisor\launch-prod-orch.mjs → no boundary before launch-
    'node toolssupervisorlaunch-prod-orch.mjs',
    'node toolssupervisorlaunch-pty-orch.mjs',
  ]) {
    assert.equal(isSupervisorRelaunchCommand(c.toLowerCase()), true, `mangled relaunch should route: ${c}`);
    assert.equal(isDestructiveShellCommand(c), true, `floor should route mangled relaunch: ${c}`);
  }
  // The mangled normalization must NOT create false positives on benign / read commands.
  for (const c of [
    'cat d:tmprestart-supervisor.ps1', // reading the (mangled-path) script ≠ running it
    'node distindex.js --panel 8790', // mangled path but NO --session → a dev shell, not a host
    'echo restart-supervisor.ps1 launch-prod-orch.mjs', // bare mentions, no node/powershell/-file exec marker
    'grep -rn session distindex.js', // a read
  ]) {
    assert.equal(isSupervisorRelaunchCommand(c.toLowerCase()), false, `mangled but NOT a relaunch: ${c}`);
    assert.equal(isDestructiveShellCommand(c), false, `floor must NOT route: ${c}`);
  }
});

test('the orchestrator safety floor routes a parent-restart via routeWhen (Bash + PowerShell)', () => {
  const p = makeOrchestratorProfile();
  // The full path the PermissionRouter takes: routeWhen(toolName, input) on the shell input.
  assert.equal(
    p.policy.routeWhen!('PowerShell', {
      command: 'powershell -NoProfile -ExecutionPolicy Bypass -File D:\\tmp\\restart-supervisor.ps1 -Launcher prod',
    }),
    true,
    'firing restart-supervisor.ps1 must route to the user for confirm',
  );
  assert.equal(p.policy.routeWhen!('Bash', { command: 'node launch-prod-orch.mjs' }), true, 'launcher relaunch routes');
  // A routine shell command is still allowed (no false floor).
  assert.equal(p.policy.routeWhen!('Bash', { command: 'npm test' }), false);
});

test('isDestructiveOp routes outward third-party send MCP tools', () => {
  assert.equal(isDestructiveOp('mcp__hostinger-email__send_email', {}), true);
  assert.equal(isDestructiveOp('mcp__google-workspace__send_gmail_message', {}), true);
  assert.equal(isDestructiveOp('mcp__whatsapp__send_message', {}), true);
  assert.equal(isDestructiveOp('mcp__whatsapp-work__send_audio_message', {}), true);
  // Reads / non-send MCP → allowed.
  assert.equal(isDestructiveOp('mcp__hostinger-email__get_messages', {}), false);
  assert.equal(isDestructiveOp('mcp__whatsapp__list_chats', {}), false);
  assert.equal(isDestructiveOp('mcp__context7__query-docs', {}), false);
  // The supervisor's OWN reply tool is NOT a third-party send → allowed.
  assert.equal(isDestructiveOp('mcp__supervisor_channel__reply', {}), false);
});

test('isDestructiveOp inspects shell tool input', () => {
  assert.equal(isDestructiveOp('Bash', { command: 'rm -rf x' }), true);
  assert.equal(isDestructiveOp('PowerShell', { command: 'Stop-Process -Id 5' }), true);
  assert.equal(isDestructiveOp('Bash', { command: 'ls' }), false);
  assert.equal(isDestructiveOp('Read', { file_path: '/etc/passwd' }), false); // read is not destructive
});

test('demo profile: narrow allow, route-most, auto-out ON, no teams/skills', () => {
  const p = makeDemoProfile();
  assert.equal(p.name, 'demo');
  assert.deepEqual(p.policy.allow, ['Read', 'Glob', 'Grep', 'mcp__supervisor_channel__*']);
  assert.equal(p.policy.fallback, 'route');
  assert.equal(p.suppressAutoOutbound, false, 'demo auto-sends assistant text');
  assert.equal(p.agentTeams, false);
  assert.equal(p.defaultDriver, 'sdk', 'demo defaults to the lighter SDK driver (no teams needed)');
  assert.equal(p.model, undefined, 'demo does not pin a model');
  assert.deepEqual(p.settingSources, []);
  assert.equal(p.policy.routeWhen, undefined, 'demo has no safety-floor predicate (everything routes anyway)');
});

test('orchestrator profile: broad allow + safety floor + teams + project context + cli-stream default + Opus 4.8[1m]', () => {
  const p = makeOrchestratorProfile();
  assert.equal(p.name, 'orchestrator');
  assert.ok(p.policy.allow.includes('Bash'));
  assert.ok(p.policy.allow.includes('Agent'));
  assert.ok(p.policy.allow.includes('SendMessage'), 'agent-teams SendMessage allow-listed');
  // MCP allow uses PER-SERVER prefixes (the claude -p CLI rejects a bare mcp__* in allow).
  assert.ok(p.policy.allow.some((a) => a.startsWith('mcp__') && a.endsWith('__*')), 'per-server mcp allow patterns');
  assert.ok(!p.policy.allow.includes('mcp__*'), 'no bare mcp__* (CLI-invalid in allow position)');
  const deny = p.policy.deny ?? [];
  assert.ok(deny.some((d) => d.includes('telegram')), 'telegram denied');
  // CONTAINMENT (2026-06-20 policy): TELEGRAM is hard-denied; the email/gmail SEND tools are
  // hard-denied. WhatsApp is NO LONGER hard-denied (read-allowed/send-gated — see the dedicated
  // whatsapp tests below); a blanket whatsapp deny would block its reads.
  assert.ok(!deny.some((d) => d.includes('whatsapp')), 'whatsapp NOT hard-denied (read-allowed/send-routed)');
  assert.ok(deny.includes('mcp__hostinger-email__send_email'), 'email send denied');
  assert.ok(deny.includes('mcp__hostinger-email__reply_to_email'), 'email reply denied');
  assert.ok(deny.includes('mcp__google-workspace__send_gmail_message'), 'gmail send denied');
  assert.equal(typeof p.policy.routeWhen, 'function', 'has the safety-floor predicate');
  assert.equal(p.policy.routeWhen!('Bash', { command: 'rm -rf x' }), true);
  assert.equal(p.policy.routeWhen!('Read', {}), false);
  assert.equal(p.agentTeams, true);
  assert.equal(p.wireProjectMcp, true);
  // ★ Corrected design (2026-06-18): orchestrator DEFAULTS to the cli-stream (claude -p)
  // driver — the only backend exposing agent-teams — and pins Opus 4.8 with the 1M window.
  assert.equal(p.defaultDriver, 'cli-stream', 'orchestrator defaults to claude -p (has agent-teams)');
  assert.equal(p.model, 'claude-opus-4-8[1m]', 'orchestrator pins Opus 4.8 1M');
  // Under cli-stream the in-process reply tool can't reach the child → auto-FORWARD
  // assistant text (no reply tool) → suppressAutoOutbound is FALSE.
  assert.equal(p.suppressAutoOutbound, false, 'cli-stream orchestrator auto-forwards assistant text (no in-proc reply tool)');
  // ★ CONTAINMENT (token-hijack fix 2026-06-18): NO 'user' setting source — it would
  // load the prod telegram PLUGIN (enabledPlugins, user-scope) whose server seizes the
  // user's getUpdates token + kills their real orchestrator's channel on every launch.
  assert.deepEqual(p.settingSources, ['project', 'local'], 'user source EXCLUDED (no prod telegram plugin load)');
  assert.ok(!p.settingSources.includes('user'), 'never load user-scope enabledPlugins (the prod telegram plugin)');
  assert.equal(p.roleBootstrap, 'orchestrator-skill');
});

test('resolveProfile defaults to demo (safe)', () => {
  assert.equal(resolveProfile(undefined).name, 'demo');
  assert.equal(resolveProfile('demo').name, 'demo');
  assert.equal(resolveProfile('orchestrator').name, 'orchestrator');
});

// ── WhatsApp read-allowed / send-routed + telegram fully-blocked, via the REAL PermissionRouter ──
// These drive the actual PermissionRouter.decide with the orchestrator policy + a recording fake
// channel, so they prove the END-TO-END resolution (allow-list vs safety-floor vs deny-list), not a
// re-implementation. `routed` = askUser was invoked (= the user gets an allow/deny prompt).
function decideWith(policy = makeOrchestratorPolicy()) {
  return async (toolName: string, input: Record<string, unknown> = {}) => {
    let routed = false;
    const channel: PermissionChannel = {
      askUser: async (_req: PermissionRequest) => {
        routed = true;
        return 'allow'; // the user's verdict if/when asked — irrelevant to WHETHER it routed
      },
    };
    const router = new PermissionRouter({ policy, channel });
    const decision = await router.decide({ toolName, input });
    return { decision, routed };
  };
}

test('★ (criterion c) WhatsApp READ tools are ALLOWED with NO prompt (both accounts)', async () => {
  const decide = decideWith();
  for (const tool of [
    'mcp__whatsapp__list_chats',
    'mcp__whatsapp__list_messages',
    'mcp__whatsapp__search_contacts',
    'mcp__whatsapp__get_chat',
    'mcp__whatsapp__get_message_context',
    'mcp__whatsapp__download_media', // a read (fetch to local path), NOT a third-party send
    'mcp__whatsapp-work__list_chats',
    'mcp__whatsapp-work__download_media',
  ]) {
    const { decision, routed } = await decide(tool);
    assert.equal(decision.behavior, 'allow', `${tool} should be allowed`);
    assert.equal(routed, false, `${tool} must NOT prompt the user (allow-list fast-path)`);
  }
});

test('★ (criterion d) WhatsApp SEND tools ROUTE for user approval — NOT auto-allowed, NOT hard-denied', async () => {
  const decide = decideWith();
  const policy = makeOrchestratorPolicy();
  for (const tool of [
    'mcp__whatsapp__send_message',
    'mcp__whatsapp__send_file',
    'mcp__whatsapp__send_audio_message',
    'mcp__whatsapp-work__send_message',
    'mcp__whatsapp-work__send_audio_message',
  ]) {
    const { decision, routed } = await decide(tool);
    // routed = the user was asked (askUser fired) → this is the approval gate.
    assert.equal(routed, true, `${tool} must ROUTE to the user (safety floor), not resolve silently`);
    // It is NOT auto-allowed: it is not on the allow-list (would skip the prompt entirely).
    assert.ok(!policy.allow.includes(tool), `${tool} must NOT be allow-listed (an allow-listed tool skips the prompt)`);
    assert.ok(
      !policy.allow.some((a) => a.endsWith('*') && tool.startsWith(a.slice(0, -1))),
      `${tool} must not be covered by an allow GLOB either`,
    );
    // It is NOT hard-denied: a hard-deny would make sending impossible. The decision came from the
    // user verdict (we returned 'allow'), proving it reached the user rather than the deny-list.
    assert.ok(!(policy.deny ?? []).some((d) => (d.endsWith('*') ? tool.startsWith(d.slice(0, -1)) : d === tool)), `${tool} must NOT be hard-denied`);
    assert.equal(decision.behavior, 'allow', `${tool} resolves via the USER verdict (here allow), not a hard rule`);
  }
});

test('★ (criterion e) TELEGRAM is FULLY blocked (hard deny, no prompt) — both server name forms', async () => {
  const decide = decideWith();
  for (const tool of [
    'mcp__telegram__send_message',
    'mcp__telegram__anything',
    'mcp__plugin_telegram_telegram__send_message',
    'mcp__plugin_telegram_telegram__get_updates',
  ]) {
    const { decision, routed } = await decide(tool);
    assert.equal(decision.behavior, 'deny', `${tool} must be hard-denied`);
    assert.equal(routed, false, `${tool} must NOT route (deny-list wins, never reaches the user)`);
  }
});

test('★ (criterion d, predicate) isDestructiveOp routes every whatsapp SEND tool name + leaves reads/download alone', () => {
  for (const t of ['mcp__whatsapp__send_message', 'mcp__whatsapp__send_file', 'mcp__whatsapp__send_audio_message', 'mcp__whatsapp-work__send_message']) {
    assert.equal(isDestructiveOp(t, {}), true, `${t} routes`);
  }
  for (const t of ['mcp__whatsapp__list_chats', 'mcp__whatsapp__download_media', 'mcp__whatsapp-work__get_chat']) {
    assert.equal(isDestructiveOp(t, {}), false, `${t} does NOT route (read)`);
  }
});
