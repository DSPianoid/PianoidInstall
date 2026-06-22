/**
 * MULTI-TURN ADAPTER DRIVER tests (model-agnostic-orchestrator Tier-1, piece #1).
 * ALL tests inject a FAKE HTTP client returning canned NON-STREAMED JSON + a scripted
 * tool runner → NO network, NO real (paid) call, NO real fs/shell/http, ZERO spend.
 *
 * Coverage (the T1 acceptance set):
 *   - request build (model pin, thinking-disabled, tools/tool_choice wiring, non-streamed);
 *   - parse helpers (assistant message text + tool_calls; arguments-JSON parse; defensive);
 *   - a PLAIN multi-turn exchange (start runs turn 1; send + runTurn runs turn 2; messages[] grows);
 *   - a SINGLE tool_call round-trip (assistant tool_call → runTool → role:tool fed back → final text);
 *   - a MULTI-tool-call turn (two tool_calls in one assistant turn → both run + fed back → final);
 *   - error/timeout paths (missing key; HTTP 429; network/transport; a DENIED tool fed back not crashed;
 *     the tool-iteration cap bounds a runaway loop; interrupt aborts cleanly);
 *   - the capability descriptor (tool-capable + permission-routable, no teams/resume);
 *   - secret hygiene (the key value never appears in an emitted event).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MultiTurnAdapterDriver,
  buildToolCompletionRequest,
  parseAssistantMessage,
  parseToolCall,
  DEFAULT_MAX_TOOL_ITERATIONS,
  type ToolSchema,
  type ToolCall,
  type ParsedToolCall,
} from '../multi-turn-adapter-driver.js';
import {
  THINKING_DISABLED,
  DEEPSEEK_CODING_CONFIG,
  CODEX_REVIEWING_CONFIG,
  ApiAdapterHttpError,
  type ApiAdapterConfig,
  type ApiAdapterHttpClient,
  type ApiAdapterHttpRequest,
} from '../api-adapter-driver.js';
import type { SessionEvent, SessionStartOptions } from '../session-driver.js';

const CONFIG: ApiAdapterConfig = { ...DEEPSEEK_CODING_CONFIG };
const KEY_ENV = { DEEPSEEK_API_KEY: 'ds-secret-value' } as NodeJS.ProcessEnv;

// ── fakes ────────────────────────────────────────────────────────────────────────

/** A non-streamed completion object that returns plain text (a final answer, no tool_calls). */
function textCompletion(content: string, extra: Record<string, unknown> = {}): unknown {
  return { choices: [{ message: { content }, finish_reason: 'stop' }], ...extra };
}

/** A non-streamed completion object that returns tool_calls (an assistant turn that wants to act). */
function toolCallsCompletion(
  calls: { id: string; name: string; args: unknown }[],
  content: string | null = null,
  extra: Record<string, unknown> = {},
): unknown {
  return {
    choices: [
      {
        message: {
          content,
          tool_calls: calls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args) },
          })),
        },
        finish_reason: 'tool_calls',
      },
    ],
    ...extra,
  };
}

/** Wrap a JSON object as the HTTP client's body (a single chunk — the whole non-streamed JSON). */
function jsonBody(obj: unknown): AsyncIterable<string> {
  return (async function* () {
    yield JSON.stringify(obj);
  })();
}

/**
 * A fake HTTP client that serves a SEQUENCE of canned completion objects (one per call),
 * records each request, and (optionally) emits the body split across chunks to exercise the
 * concatenate-then-parse path. NO network.
 */
function fakeSequenceClient(
  completions: unknown[],
  opts: { capture?: (req: ApiAdapterHttpRequest) => void; split?: boolean } = {},
): ApiAdapterHttpClient {
  let i = 0;
  return {
    async stream(req: ApiAdapterHttpRequest) {
      opts.capture?.(req);
      const obj = completions[Math.min(i, completions.length - 1)];
      i++;
      const whole = JSON.stringify(obj);
      if (opts.split) {
        return (async function* () {
          for (const ch of whole) yield ch;
        })();
      }
      return (async function* () {
        yield whole;
      })();
    },
  };
}

/** A fake client that THROWS (a non-2xx / transport failure). */
function throwingClient(err: unknown): ApiAdapterHttpClient {
  return {
    async stream() {
      throw err;
    },
  };
}

/** Drain an event stream into an array. */
async function collect(stream: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

const startOpts = (over: Partial<SessionStartOptions> = {}): SessionStartOptions => ({
  onPermission: async () => ({ behavior: 'deny', message: 'n/a' }),
  bootstrapTurns: ['read fileA, decide, summarize'],
  ...over,
});

const results = (evs: SessionEvent[]) => evs.filter((e) => e.kind === 'result') as Extract<SessionEvent, { kind: 'result' }>[];
const assistants = (evs: SessionEvent[]) => evs.filter((e) => e.kind === 'assistant') as Extract<SessionEvent, { kind: 'assistant' }>[];
const toolResults = (evs: SessionEvent[]) => evs.filter((e) => e.kind === 'tool_result') as Extract<SessionEvent, { kind: 'tool_result' }>[];

// ════════════════════════════════════════════════════════════════════════════════
// PURE: request build + parse helpers
// ════════════════════════════════════════════════════════════════════════════════

test('★ buildToolCompletionRequest pins the model, disables thinking, is NON-streamed, wires tools+tool_choice', () => {
  const tools: ToolSchema[] = [{ type: 'function', function: { name: 'read_file', description: 'read a file', parameters: { type: 'object' } } }];
  const req = buildToolCompletionRequest(CONFIG, [{ role: 'user', content: 'hi' }], tools, 'auto');
  assert.equal(req.model, 'deepseek-v4-flash');
  assert.equal(req.temperature, 0.0);
  assert.equal(req.max_tokens, 32768);
  assert.equal(req.stream, false);
  assert.deepEqual(req.thinking, THINKING_DISABLED);
  assert.deepEqual(req.tools, tools);
  assert.equal(req.tool_choice, 'auto');
  assert.deepEqual(req.messages, [{ role: 'user', content: 'hi' }]);
});

test('buildToolCompletionRequest omits tools/tool_choice when the manifest is empty (plain chat)', () => {
  const req = buildToolCompletionRequest(CONFIG, [{ role: 'user', content: 'hi' }], [], undefined);
  assert.equal(req.tools, undefined);
  assert.equal(req.tool_choice, undefined);
});

test('buildToolCompletionRequest omits the thinking toggle when disableThinking=false (e.g. Codex), copies messages', () => {
  const msgs = [{ role: 'user' as const, content: 'x' }];
  const req = buildToolCompletionRequest(CODEX_REVIEWING_CONFIG, msgs, undefined, undefined);
  assert.equal(req.thinking, undefined);
  // messages are COPIED (mutating the source array after build doesn't change the request)
  msgs.push({ role: 'user', content: 'y' });
  assert.equal(req.messages.length, 1);
});

test('parseAssistantMessage reads plain text content (a final answer), no tool_calls', () => {
  const p = parseAssistantMessage(textCompletion('the answer is 42', { usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }, total_cost_usd: 0.001 }));
  assert.equal(p.content, 'the answer is 42');
  assert.deepEqual(p.toolCalls, []);
  assert.deepEqual(p.usage, { promptTokens: 5, completionTokens: 3, totalTokens: 8 });
  assert.equal(p.costUsd, 0.001);
  assert.equal(p.finishReason, 'stop');
});

test('★ parseAssistantMessage extracts tool_calls (id, name, arguments) alongside/instead of content', () => {
  const p = parseAssistantMessage(toolCallsCompletion([{ id: 'call_1', name: 'read_file', args: { path: 'a.txt' } }]));
  assert.equal(p.toolCalls.length, 1);
  assert.equal(p.toolCalls[0]!.id, 'call_1');
  assert.equal(p.toolCalls[0]!.function.name, 'read_file');
  assert.equal(p.toolCalls[0]!.function.arguments, '{"path":"a.txt"}');
});

test('parseAssistantMessage is defensive: garbage → empty content + no tool_calls (no throw); skips a nameless call', () => {
  assert.deepEqual(parseAssistantMessage(null), { content: '', toolCalls: [] });
  assert.deepEqual(parseAssistantMessage({ choices: 'nope' }), { content: '', toolCalls: [] });
  // a tool_call with no function.name is unusable → skipped
  const p = parseAssistantMessage({ choices: [{ message: { tool_calls: [{ id: 'x', type: 'function', function: { arguments: '{}' } }] } }] });
  assert.deepEqual(p.toolCalls, []);
});

test('parseToolCall parses the arguments JSON string → object; defensive {} on bad/empty/non-object JSON', () => {
  const mk = (args: string): ToolCall => ({ id: 'c', type: 'function', function: { name: 'f', arguments: args } });
  assert.deepEqual(parseToolCall(mk('{"a":1,"b":"two"}')).args, { a: 1, b: 'two' });
  assert.deepEqual(parseToolCall(mk('')).args, {});
  assert.deepEqual(parseToolCall(mk('not json')).args, {});
  assert.deepEqual(parseToolCall(mk('[1,2,3]')).args, {}); // a top-level array is not an args object
  assert.equal(parseToolCall(mk('{"a":1}')).rawArguments, '{"a":1}');
});

// ════════════════════════════════════════════════════════════════════════════════
// PLAIN multi-turn exchange (no tools)
// ════════════════════════════════════════════════════════════════════════════════

test('★★ a PLAIN multi-turn exchange: start() runs turn 1; send()+runTurn() runs turn 2; messages[] grows', async () => {
  const client = fakeSequenceClient([textCompletion('turn-1 answer'), textCompletion('turn-2 answer')]);
  const driver = new MultiTurnAdapterDriver({ config: CONFIG, env: KEY_ENV, httpClient: client, sessionIdFn: () => 'sess-mt-1' });

  // Turn 1 via start()
  const ev1 = await collect(driver.start(startOpts({ systemPrompt: 'be terse', bootstrapTurns: ['first task'] })));
  assert.equal(ev1[0]!.kind, 'system_init');
  const init = ev1[0] as Extract<SessionEvent, { kind: 'system_init' }>;
  assert.equal(init.sessionId, 'sess-mt-1');
  assert.equal(init.model, 'deepseek-v4-flash');
  assert.deepEqual(init.tools, []); // no manifest → no tools (plain chat)
  const r1 = results(ev1);
  assert.equal(r1.length, 1);
  assert.equal(r1[0]!.subtype, 'success');
  assert.equal(r1[0]!.result, 'turn-1 answer');

  // Turn 2 via send() + runTurn()
  await driver.send({ text: 'second task' });
  const ev2 = await collect(driver.runTurn());
  const r2 = results(ev2);
  assert.equal(r2.length, 1);
  assert.equal(r2[0]!.subtype, 'success');
  assert.equal(r2[0]!.result, 'turn-2 answer');
  // NO system_init on a follow-up turn (only start() emits it)
  assert.ok(!ev2.some((e) => e.kind === 'system_init'));

  // The conversation accumulated: system + user(first) + assistant(turn1) + user(second) + assistant(turn2) = 5
  assert.match(driver.health().detail!, /turns=5/);
});

test('multi-turn carries history forward: turn 2 request includes turn-1 messages', async () => {
  const sent: ApiAdapterHttpRequest[] = [];
  const client = fakeSequenceClient([textCompletion('a1'), textCompletion('a2')], { capture: (r) => sent.push(r) });
  const driver = new MultiTurnAdapterDriver({ config: CONFIG, env: KEY_ENV, httpClient: client, sessionIdFn: () => 's' });
  await collect(driver.start(startOpts({ systemPrompt: 'sys', bootstrapTurns: ['u1'] })));
  await driver.send({ text: 'u2' });
  await collect(driver.runTurn());
  // 2nd request body carries: system, user u1, assistant a1, user u2 (4 messages) BEFORE the model answers a2
  const body2 = sent[1]!.body as unknown as { messages: { role: string; content: string | null }[] };
  assert.deepEqual(
    body2.messages.map((m) => [m.role, m.content]),
    [['system', 'sys'], ['user', 'u1'], ['assistant', 'a1'], ['user', 'u2']],
  );
});

// ════════════════════════════════════════════════════════════════════════════════
// SINGLE tool_call round-trip
// ════════════════════════════════════════════════════════════════════════════════

const READ_TOOL: ToolSchema = { type: 'function', function: { name: 'read_file', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } };

test('★★ a SINGLE tool_call round-trip: assistant tool_call → runTool → role:tool fed back → final text', async () => {
  const ran: ParsedToolCall[] = [];
  const runTool = async (call: ParsedToolCall): Promise<string> => {
    ran.push(call);
    return `contents of ${String(call.args['path'])}`;
  };
  const client = fakeSequenceClient([
    toolCallsCompletion([{ id: 'call_1', name: 'read_file', args: { path: 'a.txt' } }]),
    textCompletion('the file says hello'),
  ]);
  const driver = new MultiTurnAdapterDriver({ config: CONFIG, env: KEY_ENV, httpClient: client, runTool, tools: [READ_TOOL], sessionIdFn: () => 's' });

  const evs = await collect(driver.start(startOpts()));

  // system_init lists the manifest tool name
  const init = evs[0] as Extract<SessionEvent, { kind: 'system_init' }>;
  assert.deepEqual(init.tools, ['read_file']);

  // the tool was executed with the parsed args
  assert.equal(ran.length, 1);
  assert.equal(ran[0]!.name, 'read_file');
  assert.deepEqual(ran[0]!.args, { path: 'a.txt' });

  // an assistant event carried the tool_use, a tool_result event carried the result, then a final success
  const a = assistants(evs);
  assert.ok(a.some((e) => e.toolUses.some((u) => u.name === 'read_file' && (u.input as { path?: string }).path === 'a.txt')));
  const tr = toolResults(evs);
  assert.equal(tr.length, 1);
  assert.equal(tr[0]!.toolUseId, 'call_1');
  assert.equal(tr[0]!.content, 'contents of a.txt');
  assert.ok(!tr[0]!.isError);
  const r = results(evs);
  assert.equal(r.length, 1);
  assert.equal(r[0]!.subtype, 'success');
  assert.equal(r[0]!.result, 'the file says hello');

  // the conversation recorded the role:tool message correlated by tool_call_id
  assert.match(driver.health().detail!, /turns=/);
});

test('the 2nd completion request (after the tool ran) carries the assistant tool_calls + the role:tool result', async () => {
  const sent: ApiAdapterHttpRequest[] = [];
  const client = fakeSequenceClient(
    [toolCallsCompletion([{ id: 'call_1', name: 'read_file', args: { path: 'a.txt' } }]), textCompletion('done')],
    { capture: (r) => sent.push(r) },
  );
  const driver = new MultiTurnAdapterDriver({ config: CONFIG, env: KEY_ENV, httpClient: client, runTool: async () => 'FILE-BODY', tools: [READ_TOOL], sessionIdFn: () => 's' });
  await collect(driver.start(startOpts()));
  const body2 = sent[1]!.body as unknown as { messages: { role: string; content: string | null; tool_call_id?: string; tool_calls?: unknown[] }[] };
  const last2 = body2.messages.slice(-2);
  assert.equal(last2[0]!.role, 'assistant');
  assert.ok(Array.isArray(last2[0]!.tool_calls) && last2[0]!.tool_calls!.length === 1);
  assert.deepEqual(last2[1], { role: 'tool', content: 'FILE-BODY', tool_call_id: 'call_1' });
});

// ════════════════════════════════════════════════════════════════════════════════
// MULTI tool_call turn
// ════════════════════════════════════════════════════════════════════════════════

test('★★ a MULTI-tool-call turn: two tool_calls in one assistant turn → both run + fed back → final', async () => {
  const ran: string[] = [];
  const runTool = async (call: ParsedToolCall): Promise<string> => {
    ran.push(call.name);
    return `${call.name}:ok`;
  };
  const client = fakeSequenceClient([
    toolCallsCompletion([
      { id: 'c1', name: 'read_file', args: { path: 'a.txt' } },
      { id: 'c2', name: 'list_dir', args: { dir: '/x' } },
    ]),
    textCompletion('combined summary'),
  ]);
  const driver = new MultiTurnAdapterDriver({
    config: CONFIG,
    env: KEY_ENV,
    httpClient: client,
    runTool,
    tools: [READ_TOOL, { type: 'function', function: { name: 'list_dir' } }],
    sessionIdFn: () => 's',
  });

  const evs = await collect(driver.start(startOpts()));

  // both tools ran, in order
  assert.deepEqual(ran, ['read_file', 'list_dir']);
  // two tool_result events, correlated to the two call ids
  const tr = toolResults(evs);
  assert.equal(tr.length, 2);
  assert.deepEqual(tr.map((e) => e.toolUseId).sort(), ['c1', 'c2']);
  assert.deepEqual(tr.map((e) => e.content).sort(), ['list_dir:ok', 'read_file:ok']);
  // the assistant turn emitted BOTH tool_uses
  const a0 = assistants(evs)[0]!;
  assert.equal(a0.toolUses.length, 2);
  // final success
  const r = results(evs);
  assert.equal(r.length, 1);
  assert.equal(r[0]!.result, 'combined summary');
});

test('a multi-round agentic flow: tool → tool → final (loop continues across multiple assistant turns)', async () => {
  const client = fakeSequenceClient([
    toolCallsCompletion([{ id: 'c1', name: 'read_file', args: { path: 'a' } }]),
    toolCallsCompletion([{ id: 'c2', name: 'read_file', args: { path: 'b' } }]),
    textCompletion('read both, here is the summary'),
  ]);
  const driver = new MultiTurnAdapterDriver({ config: CONFIG, env: KEY_ENV, httpClient: client, runTool: async (c) => `body-${String(c.args['path'])}`, tools: [READ_TOOL], sessionIdFn: () => 's' });
  const evs = await collect(driver.start(startOpts()));
  assert.equal(toolResults(evs).length, 2);
  assert.equal(results(evs)[0]!.result, 'read both, here is the summary');
});

// ════════════════════════════════════════════════════════════════════════════════
// send() metering + token/cost on the terminal result
// ════════════════════════════════════════════════════════════════════════════════

test('★ M-1 metering: terminal result carries tokens + the backend-reported cost', async () => {
  const client = fakeSequenceClient([textCompletion('ans', { usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }, total_cost_usd: 0.0005 })]);
  const driver = new MultiTurnAdapterDriver({ config: CONFIG, env: KEY_ENV, httpClient: client, sessionIdFn: () => 's' });
  const evs = await collect(driver.start(startOpts()));
  const r = results(evs)[0]!;
  assert.deepEqual(r.tokens, { prompt: 7, completion: 3, total: 10 });
  assert.equal(r.costUsd, 0.0005);
});

test('M-1 metering: COMPUTES cost from the rate when the backend reports NO total_cost_usd (Codex shape)', async () => {
  const client = fakeSequenceClient([textCompletion('review', { usage: { prompt_tokens: 1_000_000, completion_tokens: 0, total_tokens: 1_000_000 } })]);
  const driver = new MultiTurnAdapterDriver({ config: { ...CODEX_REVIEWING_CONFIG }, env: { OPENAI_API_KEY: 'oa' } as NodeJS.ProcessEnv, httpClient: client, sessionIdFn: () => 's' });
  const evs = await collect(driver.start(startOpts()));
  // 1M input @ $1.25/M = 1.25 (the gpt-5-codex placeholder rate)
  assert.equal(results(evs)[0]!.costUsd, 1.25);
});

// ════════════════════════════════════════════════════════════════════════════════
// ERROR / TIMEOUT paths
// ════════════════════════════════════════════════════════════════════════════════

test('★ MISSING key → clean surfaced FAILURE (error_no_api_key), NO crash, NO HTTP call', async () => {
  let called = false;
  const client: ApiAdapterHttpClient = { async stream() { called = true; return jsonBody(textCompletion('x')); } };
  const driver = new MultiTurnAdapterDriver({ config: CONFIG, env: { PATH: '/x' } as NodeJS.ProcessEnv, httpClient: client, sessionIdFn: () => 's' });
  const evs = await collect(driver.start(startOpts()));
  assert.equal(called, false, 'the HTTP client must NOT be called without a key');
  const r = results(evs)[0]!;
  assert.equal(r.subtype, 'error_no_api_key');
  assert.ok(r.result!.includes('DEEPSEEK_API_KEY'));
  // system_init still emitted; the stream did NOT throw
  assert.equal(evs[0]!.kind, 'system_init');
});

test('★ a non-2xx HTTP error → surfaced FAILED (error_http_429), NOT a thrown crash', async () => {
  const driver = new MultiTurnAdapterDriver({ config: CONFIG, env: KEY_ENV, httpClient: throwingClient(new ApiAdapterHttpError('HTTP 429. rate limited', 429)), sessionIdFn: () => 's' });
  const evs = await collect(driver.start(startOpts()));
  const r = results(evs)[0]!;
  assert.equal(r.subtype, 'error_http_429');
  assert.ok(r.result!.includes('429'));
});

test('a network/transport error → surfaced FAILED (error_network)', async () => {
  const driver = new MultiTurnAdapterDriver({ config: CONFIG, env: KEY_ENV, httpClient: throwingClient(new ApiAdapterHttpError('network error: ECONNREFUSED')), sessionIdFn: () => 's' });
  const evs = await collect(driver.start(startOpts()));
  assert.equal(results(evs)[0]!.subtype, 'error_network');
});

test('a non-JSON / empty response body → surfaced FAILED (error_network), NOT a thrown crash', async () => {
  const client: ApiAdapterHttpClient = { async stream() { return (async function* () { yield 'not json at all'; })(); } };
  const driver = new MultiTurnAdapterDriver({ config: CONFIG, env: KEY_ENV, httpClient: client, sessionIdFn: () => 's' });
  const evs = await collect(driver.start(startOpts()));
  assert.equal(results(evs)[0]!.subtype, 'error_network');
});

test('★ a DENIED / failing tool is fed back as a tool_result (isError) and the model continues — NO crash', async () => {
  // The runner returns a denial STRING (the real router converts a deny into a string; it does not throw).
  const runTool = async (call: ParsedToolCall): Promise<string> => `DENIED by operator: ${call.name}`;
  const client = fakeSequenceClient([
    toolCallsCompletion([{ id: 'c1', name: 'git_push', args: {} }]),
    textCompletion('understood, I will not push'),
  ]);
  const driver = new MultiTurnAdapterDriver({ config: CONFIG, env: KEY_ENV, httpClient: client, runTool, tools: [{ type: 'function', function: { name: 'git_push' } }], sessionIdFn: () => 's' });
  const evs = await collect(driver.start(startOpts()));
  const tr = toolResults(evs);
  assert.equal(tr.length, 1);
  assert.ok(tr[0]!.content.includes('DENIED by operator'));
  // the model saw the denial and finalized — the turn did NOT crash
  assert.equal(results(evs)[0]!.subtype, 'success');
  assert.equal(results(evs)[0]!.result, 'understood, I will not push');
});

test('a runTool that THROWS is contained: converted to an isError tool_result fed back, never crashes the turn', async () => {
  const runTool = async (): Promise<string> => { throw new Error('boom'); };
  const client = fakeSequenceClient([
    toolCallsCompletion([{ id: 'c1', name: 'flaky', args: {} }]),
    textCompletion('recovered'),
  ]);
  const driver = new MultiTurnAdapterDriver({ config: CONFIG, env: KEY_ENV, httpClient: client, runTool, tools: [{ type: 'function', function: { name: 'flaky' } }], sessionIdFn: () => 's' });
  const evs = await collect(driver.start(startOpts()));
  const tr = toolResults(evs);
  assert.equal(tr.length, 1);
  assert.ok(tr[0]!.isError);
  assert.ok(tr[0]!.content.includes('boom'));
  assert.equal(results(evs)[0]!.subtype, 'success');
});

test('the default (unwired) tool runner degrades to a clean "not wired" tool_result — never crashes', async () => {
  const client = fakeSequenceClient([
    toolCallsCompletion([{ id: 'c1', name: 'read_file', args: { path: 'a' } }]),
    textCompletion('ok'),
  ]);
  // NO runTool injected → default stub
  const driver = new MultiTurnAdapterDriver({ config: CONFIG, env: KEY_ENV, httpClient: client, tools: [READ_TOOL], sessionIdFn: () => 's' });
  const evs = await collect(driver.start(startOpts()));
  const tr = toolResults(evs);
  assert.equal(tr.length, 1);
  assert.ok(tr[0]!.content.includes('not wired'));
  assert.equal(results(evs)[0]!.subtype, 'success');
});

test('★ the tool-iteration cap BOUNDS a runaway loop → terminal error (error_tool_loop_cap)', async () => {
  // The model ALWAYS returns a tool_call (never finalizes); the runner always succeeds → would loop forever.
  const alwaysToolCall = toolCallsCompletion([{ id: 'c', name: 'noop', args: {} }]);
  const client = fakeSequenceClient([alwaysToolCall]); // the sequence client repeats its last entry
  const driver = new MultiTurnAdapterDriver({
    config: CONFIG,
    env: KEY_ENV,
    httpClient: client,
    runTool: async () => 'ok',
    tools: [{ type: 'function', function: { name: 'noop' } }],
    maxToolIterations: 4,
    sessionIdFn: () => 's',
  });
  const evs = await collect(driver.start(startOpts()));
  const r = results(evs)[0]!;
  assert.equal(r.subtype, 'error_tool_loop_cap');
  assert.ok(r.result!.includes('4'));
  // exactly 4 iterations' worth of tool_results before the cap tripped
  assert.equal(toolResults(evs).length, 4);
});

test('an assistant turn with neither content nor tool_calls → surfaced FAILED (error_empty_response)', async () => {
  const client = fakeSequenceClient([{ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }]);
  const driver = new MultiTurnAdapterDriver({ config: CONFIG, env: KEY_ENV, httpClient: client, sessionIdFn: () => 's' });
  const evs = await collect(driver.start(startOpts()));
  assert.equal(results(evs)[0]!.subtype, 'error_empty_response');
});

test('an empty task (no system prompt, no bootstrap turns) → surfaced FAILED (error_empty_task), no call', async () => {
  let called = false;
  const client: ApiAdapterHttpClient = { async stream() { called = true; return jsonBody(textCompletion('x')); } };
  const driver = new MultiTurnAdapterDriver({ config: CONFIG, env: KEY_ENV, httpClient: client, sessionIdFn: () => 's' });
  const evs = await collect(driver.start(startOpts({ bootstrapTurns: [], systemPrompt: undefined })));
  assert.equal(called, false);
  assert.equal(results(evs)[0]!.subtype, 'error_empty_task');
});

test('interrupt() aborts the in-flight turn cleanly at the next loop boundary (error_interrupted)', async () => {
  // The runner trips interrupt mid-loop; the next iteration must bail with error_interrupted (not loop on).
  let driver!: MultiTurnAdapterDriver;
  const runTool = async (): Promise<string> => {
    await driver.interrupt();
    return 'ran once';
  };
  const client = fakeSequenceClient([toolCallsCompletion([{ id: 'c', name: 'noop', args: {} }])]); // always a tool_call
  driver = new MultiTurnAdapterDriver({ config: CONFIG, env: KEY_ENV, httpClient: client, runTool, tools: [{ type: 'function', function: { name: 'noop' } }], maxToolIterations: 50, sessionIdFn: () => 's' });
  const evs = await collect(driver.start(startOpts()));
  const r = results(evs)[0]!;
  assert.equal(r.subtype, 'error_interrupted');
  // the tool ran exactly once before the interrupt was honored at the loop boundary
  assert.equal(toolResults(evs).length, 1);
});

// ════════════════════════════════════════════════════════════════════════════════
// capability descriptor + secret hygiene + lifecycle guards
// ════════════════════════════════════════════════════════════════════════════════

test('★ capabilities() declares tool-capable + permission-routable, NO teams, NO resume', () => {
  const caps = MultiTurnAdapterDriver.capabilities();
  assert.equal(caps.supportsTools, true);
  assert.equal(caps.supportsPermissionRouting, true);
  assert.equal(caps.supportsTeams, false);
  assert.equal(caps.supportsResume, false);
});

test('the API key VALUE never appears in any emitted event (secret hygiene)', async () => {
  const client = fakeSequenceClient([
    toolCallsCompletion([{ id: 'c1', name: 'read_file', args: { path: 'a' } }]),
    textCompletion('done'),
  ]);
  const driver = new MultiTurnAdapterDriver({ config: CONFIG, env: KEY_ENV, httpClient: client, runTool: async () => 'body', tools: [READ_TOOL], sessionIdFn: () => 's' });
  const evs = await collect(driver.start(startOpts()));
  const blob = JSON.stringify(evs);
  assert.ok(!blob.includes('ds-secret-value'), 'the key value must never be in an emitted event');
});

test('the auth header carries the env key (value transient, only in the request headers)', async () => {
  let captured: ApiAdapterHttpRequest | undefined;
  const client = fakeSequenceClient([textCompletion('ok')], { capture: (r) => (captured = r) });
  const driver = new MultiTurnAdapterDriver({ config: CONFIG, env: KEY_ENV, httpClient: client, sessionIdFn: () => 's' });
  await collect(driver.start(startOpts()));
  assert.equal(captured!.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(captured!.headers['Authorization'], 'Bearer ds-secret-value');
});

test('send() before start() throws; a second start() is a clean error result (one lifecycle per instance)', async () => {
  const client = fakeSequenceClient([textCompletion('ok')]);
  const driver = new MultiTurnAdapterDriver({ config: CONFIG, env: KEY_ENV, httpClient: client, sessionIdFn: () => 's' });
  await assert.rejects(() => driver.send({ text: 'x' }), /not started/);
  await collect(driver.start(startOpts()));
  const evs2 = await collect(driver.start(startOpts()));
  assert.equal(results(evs2)[0]!.subtype, 'error_already_started');
});

test('stop()/interrupt() are safe; health() reports not-running after stop()', async () => {
  const driver = new MultiTurnAdapterDriver({ config: CONFIG, env: KEY_ENV, httpClient: fakeSequenceClient([textCompletion('ok')]), sessionIdFn: () => 's' });
  await assert.doesNotReject(() => driver.stop());
  await assert.doesNotReject(() => driver.interrupt());
  assert.equal(driver.health().running, false);
});

test('a split (chunked) response body is concatenated then parsed (transport chunk-boundary safety)', async () => {
  const client = fakeSequenceClient([textCompletion('chunked answer')], { split: true });
  const driver = new MultiTurnAdapterDriver({ config: CONFIG, env: KEY_ENV, httpClient: client, sessionIdFn: () => 's' });
  const evs = await collect(driver.start(startOpts()));
  assert.equal(results(evs)[0]!.result, 'chunked answer');
});

test('DEFAULT_MAX_TOOL_ITERATIONS is a sane positive bound', () => {
  assert.ok(DEFAULT_MAX_TOOL_ITERATIONS > 0 && DEFAULT_MAX_TOOL_ITERATIONS <= 1000);
});
