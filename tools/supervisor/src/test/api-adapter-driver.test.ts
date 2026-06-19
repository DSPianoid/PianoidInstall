/**
 * API-ADAPTER DRIVER tests (P3 / M5) — a SessionDriver for OpenAI-compatible backends
 * (DeepSeek=coding). ALL tests inject a FAKE HTTP client returning canned SSE/JSON →
 * NO network, NO real (paid) call, ZERO spend. They cover:
 *   - request build (model pin, thinking-disabled, message assembly);
 *   - stream → SessionEvent mapping (system_init → assistant deltas → one terminal result);
 *   - error → surfaced FAILED (a terminal result with an error subtype, never a thrown crash);
 *   - key-from-env-ONLY (missing key → clean failure, never a crash, never a leaked value).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ApiAdapterDriver,
  buildChatCompletionRequest,
  parseStreamPayload,
  iterateSsePayloads,
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

/** Build an SSE body (async-iterable of text chunks) from a list of `data:` JSON payloads + [DONE]. */
function sseBody(payloads: unknown[], opts: { split?: boolean } = {}): AsyncIterable<string> {
  const lines = payloads.map((p) => `data: ${JSON.stringify(p)}\n\n`);
  lines.push('data: [DONE]\n\n');
  const whole = lines.join('');
  if (opts.split) {
    // emit char-by-char to exercise chunk-boundary handling (a `data:` line split across chunks)
    return (async function* () {
      for (const ch of whole) yield ch;
    })();
  }
  return (async function* () {
    for (const l of lines) yield l;
  })();
}

/** A fake HTTP client that records the request and returns a canned body (NO network). */
function fakeClient(
  body: AsyncIterable<string | Uint8Array>,
  capture?: (req: ApiAdapterHttpRequest) => void,
): ApiAdapterHttpClient {
  return {
    async stream(req: ApiAdapterHttpRequest) {
      capture?.(req);
      return body;
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

/** Drain a driver's event stream into an array. */
async function collect(stream: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

const startOpts = (over: Partial<SessionStartOptions> = {}): SessionStartOptions => ({
  onPermission: async () => ({ behavior: 'deny', message: 'n/a' }),
  bootstrapTurns: ['write a function add(a,b)'],
  ...over,
});

// ── pure: request build ────────────────────────────────────────────────────────
test('★ buildChatCompletionRequest pins the model, disables thinking, assembles messages', () => {
  const req = buildChatCompletionRequest(CONFIG, startOpts({ systemPrompt: 'be terse' }));
  assert.equal(req.model, 'deepseek-v4-flash');
  assert.equal(req.temperature, 0.0);
  assert.equal(req.max_tokens, 32768);
  assert.equal(req.stream, true);
  assert.deepEqual(req.thinking, THINKING_DISABLED);
  assert.deepEqual(req.messages, [
    { role: 'system', content: 'be terse' },
    { role: 'user', content: 'write a function add(a,b)' },
  ]);
});

test('buildChatCompletionRequest omits the thinking toggle when disableThinking=false (e.g. Codex)', () => {
  const req = buildChatCompletionRequest(CODEX_REVIEWING_CONFIG, startOpts());
  assert.equal(req.model, 'gpt-5-codex');
  assert.equal(req.thinking, undefined);
});

test('the {preset:claude_code} systemPrompt form is ignored for a bare API turn (no system message)', () => {
  const req = buildChatCompletionRequest(CONFIG, startOpts({ systemPrompt: { preset: 'claude_code', append: 'x' } }));
  assert.deepEqual(req.messages, [{ role: 'user', content: 'write a function add(a,b)' }]);
});

// ── pure: SSE parsing ────────────────────────────────────────────────────────────
test('parseStreamPayload reads a streamed delta, a non-streamed message, finish_reason, cost, tokens', () => {
  assert.deepEqual(parseStreamPayload({ choices: [{ delta: { content: 'abc' } }] }), { textDelta: 'abc' });
  assert.deepEqual(parseStreamPayload({ choices: [{ message: { content: 'full' } }] }), { textDelta: 'full' });
  const fin = parseStreamPayload({ choices: [{ delta: {}, finish_reason: 'stop' }], total_cost_usd: 0.001, usage: { total_tokens: 42 } });
  assert.equal(fin.finishReason, 'stop');
  assert.equal(fin.costUsd, 0.001);
  assert.equal(fin.totalTokens, 42);
});

test('parseStreamPayload is defensive on garbage (no throw, empty result)', () => {
  assert.deepEqual(parseStreamPayload(null), {});
  assert.deepEqual(parseStreamPayload({}), {});
  assert.deepEqual(parseStreamPayload({ choices: 'nope' }), {});
});

test('iterateSsePayloads splits data lines, drops [DONE], handles chunk boundaries', async () => {
  const payloads: unknown[] = [];
  for await (const p of iterateSsePayloads(sseBody([{ a: 1 }, { b: 2 }], { split: true }))) payloads.push(p);
  assert.deepEqual(payloads, [{ a: 1 }, { b: 2 }]);
});

// ── stream → SessionEvent mapping (the happy path) ───────────────────────────────
test('★★ start() maps a streamed completion → system_init + assistant deltas + ONE terminal success result', async () => {
  let captured: ApiAdapterHttpRequest | undefined;
  const body = sseBody([
    { choices: [{ delta: { content: 'def add(a, b):' } }] },
    { choices: [{ delta: { content: '\n    return a + b' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], total_cost_usd: 0.0004, usage: { total_tokens: 30 } },
  ]);
  const driver = new ApiAdapterDriver({
    config: CONFIG,
    env: KEY_ENV,
    httpClient: fakeClient(body, (r) => (captured = r)),
    sessionIdFn: () => 'sess-api-1',
  });
  const events = await collect(driver.start(startOpts()));

  // system_init first
  assert.equal(events[0]!.kind, 'system_init');
  const init = events[0] as Extract<SessionEvent, { kind: 'system_init' }>;
  assert.equal(init.sessionId, 'sess-api-1');
  assert.equal(init.model, 'deepseek-v4-flash');
  assert.deepEqual(init.tools, []);
  assert.deepEqual(init.mcpServers, []);

  // two assistant deltas
  const assistants = events.filter((e) => e.kind === 'assistant') as Extract<SessionEvent, { kind: 'assistant' }>[];
  assert.equal(assistants.length, 2);
  assert.equal(assistants[0]!.text, 'def add(a, b):');
  assert.equal(assistants[1]!.text, '\n    return a + b');

  // exactly ONE terminal result, assembled + cost
  const results = events.filter((e) => e.kind === 'result') as Extract<SessionEvent, { kind: 'result' }>[];
  assert.equal(results.length, 1);
  assert.equal(results[0]!.subtype, 'success');
  assert.equal(results[0]!.result, 'def add(a, b):\n    return a + b');
  assert.equal(results[0]!.costUsd, 0.0004);
  assert.equal(results[0]!.sessionId, 'sess-api-1');

  // the request was built correctly + carried the auth header from the env key (value transient, here only)
  assert.ok(captured);
  assert.equal(captured!.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(captured!.headers['Authorization'], 'Bearer ds-secret-value');
  assert.equal(captured!.body.model, 'deepseek-v4-flash');
  assert.deepEqual(captured!.body.thinking, THINKING_DISABLED);
});

test('start() also maps a backend that ignored stream:true and returned ONE full message object', async () => {
  const body = sseBody([{ choices: [{ message: { content: 'WHOLE ANSWER' }, finish_reason: 'stop' }] }]);
  const driver = new ApiAdapterDriver({ config: CONFIG, env: KEY_ENV, httpClient: fakeClient(body), sessionIdFn: () => 's' });
  const events = await collect(driver.start(startOpts()));
  const result = events.find((e) => e.kind === 'result') as Extract<SessionEvent, { kind: 'result' }>;
  assert.equal(result.subtype, 'success');
  assert.equal(result.result, 'WHOLE ANSWER');
});

// ── key-from-env-ONLY ────────────────────────────────────────────────────────────
test('★ MISSING key (env has no DEEPSEEK_API_KEY) → clean surfaced FAILURE result, NO crash, NO call', async () => {
  let called = false;
  const client: ApiAdapterHttpClient = { async stream() { called = true; return sseBody([]); } };
  const driver = new ApiAdapterDriver({ config: CONFIG, env: { PATH: '/x' } as NodeJS.ProcessEnv, httpClient: client, sessionIdFn: () => 's' });
  const events = await collect(driver.start(startOpts()));
  assert.equal(called, false, 'the HTTP client must NOT be called without a key');
  const result = events.find((e) => e.kind === 'result') as Extract<SessionEvent, { kind: 'result' }>;
  assert.equal(result.subtype, 'error_no_api_key');
  assert.ok(result.result!.includes('DEEPSEEK_API_KEY'));
  // system_init still emitted; result terminal — the stream did NOT throw
  assert.equal(events[0]!.kind, 'system_init');
});

test('the API key VALUE never appears in any emitted event (secret hygiene)', async () => {
  const body = sseBody([{ choices: [{ delta: { content: 'ok' } }] }]);
  const driver = new ApiAdapterDriver({ config: CONFIG, env: KEY_ENV, httpClient: fakeClient(body), sessionIdFn: () => 's' });
  const events = await collect(driver.start(startOpts()));
  const blob = JSON.stringify(events);
  assert.ok(!blob.includes('ds-secret-value'), 'the key value must never be in an emitted event');
});

// ── error → surfaced FAILED ──────────────────────────────────────────────────────
test('★ a non-2xx HTTP error → surfaced FAILED result (error_http_<status>), NOT a thrown crash', async () => {
  const driver = new ApiAdapterDriver({
    config: CONFIG,
    env: KEY_ENV,
    httpClient: throwingClient(new ApiAdapterHttpError('HTTP 429. rate limited', 429)),
    sessionIdFn: () => 's',
  });
  const events = await collect(driver.start(startOpts()));
  const result = events.find((e) => e.kind === 'result') as Extract<SessionEvent, { kind: 'result' }>;
  assert.equal(result.subtype, 'error_http_429');
  assert.ok(result.result!.includes('429'));
});

test('a network/transport error → surfaced FAILED result (error_network)', async () => {
  const driver = new ApiAdapterDriver({
    config: CONFIG,
    env: KEY_ENV,
    httpClient: throwingClient(new ApiAdapterHttpError('network error: ECONNREFUSED')),
    sessionIdFn: () => 's',
  });
  const events = await collect(driver.start(startOpts()));
  const result = events.find((e) => e.kind === 'result') as Extract<SessionEvent, { kind: 'result' }>;
  assert.equal(result.subtype, 'error_network');
});

test('an empty (no-content) response → surfaced FAILED result (error_empty_response)', async () => {
  const body = sseBody([{ choices: [{ delta: {} }] }]); // a delta with no content, then [DONE]
  const driver = new ApiAdapterDriver({ config: CONFIG, env: KEY_ENV, httpClient: fakeClient(body), sessionIdFn: () => 's' });
  const events = await collect(driver.start(startOpts()));
  const result = events.find((e) => e.kind === 'result') as Extract<SessionEvent, { kind: 'result' }>;
  assert.equal(result.subtype, 'error_empty_response');
});

test('an empty task (no bootstrap turns / no system prompt) → surfaced FAILED (error_empty_task), no call', async () => {
  let called = false;
  const client: ApiAdapterHttpClient = { async stream() { called = true; return sseBody([]); } };
  const driver = new ApiAdapterDriver({ config: CONFIG, env: KEY_ENV, httpClient: client, sessionIdFn: () => 's' });
  const events = await collect(driver.start(startOpts({ bootstrapTurns: [] })));
  assert.equal(called, false);
  const result = events.find((e) => e.kind === 'result') as Extract<SessionEvent, { kind: 'result' }>;
  assert.equal(result.subtype, 'error_empty_task');
});

test('a mid-stream transport drop → surfaced FAILED result (still terminates with one result)', async () => {
  // a body that yields one delta then throws while iterating
  const body: AsyncIterable<string> = (async function* () {
    yield 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'partial' } }] }) + '\n\n';
    throw new ApiAdapterHttpError('stream aborted');
  })();
  const driver = new ApiAdapterDriver({ config: CONFIG, env: KEY_ENV, httpClient: fakeClient(body), sessionIdFn: () => 's' });
  const events = await collect(driver.start(startOpts()));
  // one assistant delta got through, then a terminal error result (NOT a thrown crash)
  assert.ok(events.some((e) => e.kind === 'assistant' && e.text === 'partial'));
  const results = events.filter((e) => e.kind === 'result') as Extract<SessionEvent, { kind: 'result' }>[];
  assert.equal(results.length, 1);
  assert.equal(results[0]!.subtype, 'error_network');
});

// ── capability descriptor + lifecycle no-ops ─────────────────────────────────────
test('capabilities() declares no tools / no permission routing (OD-5) so FD4 skips it', () => {
  const caps = ApiAdapterDriver.capabilities();
  assert.equal(caps.supportsTools, false);
  assert.equal(caps.supportsPermissionRouting, false);
  assert.equal(caps.supportsResume, false);
  assert.equal(caps.supportsTeams, false);
});

test('send() is rejected (one-shot compute turn in v1); stop()/interrupt() are safe no-ops', async () => {
  const driver = new ApiAdapterDriver({ config: CONFIG, env: KEY_ENV, httpClient: fakeClient(sseBody([])), sessionIdFn: () => 's' });
  await assert.rejects(() => driver.send({ text: 'another turn' }), /one-shot/);
  await assert.doesNotReject(() => driver.stop());
  await assert.doesNotReject(() => driver.interrupt());
  assert.equal(driver.health().running, false);
});
