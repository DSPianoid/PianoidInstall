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
  makeDemoProfile,
  makeOrchestratorProfile,
  resolveProfile,
} from '../profiles.js';

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
  assert.deepEqual(p.settingSources, []);
  assert.equal(p.policy.routeWhen, undefined, 'demo has no safety-floor predicate (everything routes anyway)');
});

test('orchestrator profile: broad allow + safety floor + teams + project context + de-dup', () => {
  const p = makeOrchestratorProfile();
  assert.equal(p.name, 'orchestrator');
  assert.ok(p.policy.allow.includes('Bash'));
  assert.ok(p.policy.allow.includes('Agent'));
  assert.ok(p.policy.allow.includes('mcp__*'));
  const deny = p.policy.deny ?? [];
  assert.ok(deny.some((d) => d.includes('telegram')), 'telegram denied');
  // CONTAINMENT: the outward-to-third-party channels are denied (feed the PTY seal's
  // --disallowed-tools too). whatsapp servers + email SEND tools.
  assert.ok(deny.some((d) => d.includes('whatsapp')), 'whatsapp denied');
  assert.ok(deny.includes('mcp__hostinger-email__send_email'), 'email send denied');
  assert.ok(deny.includes('mcp__google-workspace__send_gmail_message'), 'gmail send denied');
  assert.equal(typeof p.policy.routeWhen, 'function', 'has the safety-floor predicate');
  assert.equal(p.policy.routeWhen!('Bash', { command: 'rm -rf x' }), true);
  assert.equal(p.policy.routeWhen!('Read', {}), false);
  assert.equal(p.agentTeams, true);
  assert.equal(p.wireProjectMcp, true);
  assert.equal(p.suppressAutoOutbound, true, 'orchestrator de-dups (reply tool is the deliberate out)');
  assert.deepEqual(p.settingSources, ['user', 'project', 'local']);
  assert.equal(p.roleBootstrap, 'orchestrator-skill');
});

test('resolveProfile defaults to demo (safe)', () => {
  assert.equal(resolveProfile(undefined).name, 'demo');
  assert.equal(resolveProfile('demo').name, 'demo');
  assert.equal(resolveProfile('orchestrator').name, 'orchestrator');
});
