/**
 * SdkSessionDriver tests — with an INJECTED fake `query` (no real SDK, no
 * subprocess). Verifies the SDK-message → SessionEvent mapping, the permission
 * callback adaptation, and that the streaming prompt receives injected turns.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SdkSessionDriver, type SdkQueryFn } from '../adapters/sdk-session-driver.js';
import type { PermissionDecision, SessionEvent } from '../session-driver.js';

const allow = async (): Promise<PermissionDecision> => ({ behavior: 'allow' });

/** A fake query() that yields a scripted list of raw SDK messages. */
function fakeQuery(messages: unknown[], opts?: { capture?: (o: Record<string, unknown>) => void }): SdkQueryFn {
  return ({ options }) => {
    opts?.capture?.(options ?? {});
    async function* gen(): AsyncGenerator<unknown> {
      for (const m of messages) yield m;
    }
    return gen();
  };
}

test('maps system/init, assistant (text + tool_use), and result messages', async () => {
  const driver = new SdkSessionDriver({
    queryFn: fakeQuery([
      { type: 'system', subtype: 'init', session_id: 'sdk-1', model: 'claude-opus', tools: ['Read', 'Bash'] },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'working...' },
            { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      },
      { type: 'result', subtype: 'success', session_id: 'sdk-1', result: 'all done', total_cost_usd: 0.0123 },
    ]),
  });

  const events: SessionEvent[] = [];
  for await (const ev of driver.start({ onPermission: allow })) events.push(ev);

  assert.equal(events.length, 3);
  const init = events[0] as Extract<SessionEvent, { kind: 'system_init' }>;
  assert.equal(init.kind, 'system_init');
  assert.equal(init.sessionId, 'sdk-1');
  assert.equal(init.model, 'claude-opus');
  assert.deepEqual(init.tools, ['Read', 'Bash']);
  const a = events[1] as Extract<SessionEvent, { kind: 'assistant' }>;
  assert.equal(a.kind, 'assistant');
  assert.equal(a.text, 'working...');
  assert.equal(a.toolUses.length, 1);
  assert.equal(a.toolUses[0]!.name, 'Bash');
  const r = events[2] as Extract<SessionEvent, { kind: 'result' }>;
  assert.equal(r.kind, 'result');
  assert.equal(r.subtype, 'success');
  assert.equal(r.result, 'all done');
  assert.equal(r.costUsd, 0.0123);
  assert.equal(driver.health().sessionId, 'sdk-1');
});

test('passes resume + systemPrompt + allowedTools through to query() options', async () => {
  let captured: Record<string, unknown> = {};
  const driver = new SdkSessionDriver({
    queryFn: fakeQuery([{ type: 'result', subtype: 'success', session_id: 's' }], {
      capture: (o) => (captured = o),
    }),
  });
  for await (const _ of driver.start({
    onPermission: allow,
    systemPrompt: 'You are M1.',
    resume: 'prev-session',
    allowedTools: ['Read'],
    model: 'claude-opus',
  })) {
    void _;
  }
  assert.equal(captured['systemPrompt'], 'You are M1.');
  assert.equal(captured['resume'], 'prev-session');
  assert.deepEqual(captured['allowedTools'], ['Read']);
  assert.equal(captured['model'], 'claude-opus');
  assert.equal(typeof captured['canUseTool'], 'function');
});

test('canUseTool adaptation: allow → {behavior:allow}, deny → {behavior:deny,message}', async () => {
  let capturedCanUseTool: ((t: string, i: Record<string, unknown>) => Promise<unknown>) | undefined;
  const driver = new SdkSessionDriver({
    queryFn: fakeQuery([{ type: 'result', subtype: 'success', session_id: 's' }], {
      capture: (o) => (capturedCanUseTool = o['canUseTool'] as typeof capturedCanUseTool),
    }),
  });
  // Drain a start() so the options (with canUseTool) are captured.
  for await (const _ of driver.start({
    onPermission: async (req) =>
      req.toolName === 'Bash' ? { behavior: 'deny', message: 'nope' } : { behavior: 'allow' },
  })) {
    void _;
  }
  assert.ok(capturedCanUseTool, 'canUseTool was passed');
  const allowRes = (await capturedCanUseTool!('Read', { x: 1 })) as { behavior: string; updatedInput?: unknown };
  assert.equal(allowRes.behavior, 'allow');
  const denyRes = (await capturedCanUseTool!('Bash', {})) as { behavior: string; message?: string };
  assert.equal(denyRes.behavior, 'deny');
  assert.equal(denyRes.message, 'nope');
});

test('send() before start throws; health reflects not-running initially', async () => {
  const driver = new SdkSessionDriver({ queryFn: fakeQuery([]) });
  await assert.rejects(() => driver.send({ text: 'hi' }), /not started/);
  assert.equal(driver.health().running, false);
});

// ── FLOOD FIX parity: sub-agent suppression in mapMessage (mirrors cli-stream-sidechain.test.ts) ──
// mapMessage is private; a dropped (null) message simply does NOT appear in the start() output
// events. So we feed sub-agent + own messages and assert only the own ones survive.

test('mapMessage DROPS sub-agent messages (foreground sidechain AND background task) but KEEPS the orchestrator-own message', async () => {
  const driver = new SdkSessionDriver({
    queryFn: fakeQuery([
      // (b) FOREGROUND sidechain — non-null parent_tool_use_id
      {
        type: 'assistant',
        parent_tool_use_id: 'toolu_fg',
        message: { content: [{ type: 'text', text: 'sidechain narration — must be dropped' }] },
      },
      // (a) BACKGROUND task — subagent_type set, parent_tool_use_id NULL (the 2224ed4 gap)
      {
        type: 'assistant',
        parent_tool_use_id: null,
        subagent_type: 'general-purpose',
        task_description: 'probe bg',
        message: { content: [{ type: 'text', text: 'I now have a strong grasp — must be dropped' }] },
      },
      // (c) orchestrator OWN main-session message — neither marker → MUST be kept
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: { content: [{ type: 'text', text: 'On it — relaying the result.' }] },
      },
    ]),
  });

  const events: SessionEvent[] = [];
  for await (const ev of driver.start({ onPermission: allow })) events.push(ev);

  // Only the orchestrator-own assistant message survives; both sub-agent messages are dropped.
  assert.equal(events.length, 1);
  const a = events[0] as Extract<SessionEvent, { kind: 'assistant' }>;
  assert.equal(a.kind, 'assistant');
  assert.equal(a.text, 'On it — relaying the result.');
});
