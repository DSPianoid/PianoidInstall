/**
 * P4 — SECOND api-adapter backend (Codex / OpenAI = `reviewing`) tests.
 *
 * Proves the model-agnostic claim that the SAME {@link ApiAdapterDriver} serves a SECOND
 * vendor (OpenAI/Codex) purely by CONFIG (base-URL/model/key) — ZERO new driver — and that
 * the `reviewing` role resolves to that Codex backend END-TO-END through the DEFAULT registry
 * config (no per-call override), with per-backend key scoping (OPENAI_API_KEY only, no foreign
 * billing key) and secret-from-env-only (never logged / never in args).
 *
 * ZERO SPEND: every test injects a FAKE ApiAdapterHttpClient returning canned SSE — NO network,
 * NO real OpenAI/DeepSeek call. The key value is asserted to appear ONLY in the transient
 * Authorization header the driver builds, never in any diagnostic line.
 *
 * Traces: proposal P4; OD-4 (Codex=OpenAI-API, USER-APPROVED); §C api-adapter taxonomy; FD5/M4.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ApiAdapterDriver,
  CODEX_REVIEWING_CONFIG,
  DEEPSEEK_CODING_CONFIG,
  DEFAULT_API_ADAPTER_CONFIGS,
  buildChatCompletionRequest,
  type ApiAdapterHttpClient,
  type ApiAdapterHttpRequest,
} from '../api-adapter-driver.js';
import { BackendRegistry } from '../backend-registry.js';
import { dispatchRoleAgent } from '../result-relay.js';
import { resolveRoleBackend, DEFAULT_ROLE_ROUTING_CONFIG } from '../role-router.js';
import { capabilitiesFor } from '../backend-kinds.js';
import type { SessionEvent, SessionStartOptions } from '../session-driver.js';

/** A canned OpenAI-compatible SSE body (text chunks) — fake client returns this; NO network. */
function openaiSseBody(text: string, costUsd?: number): AsyncIterable<string> {
  const finalChunk: Record<string, unknown> = { choices: [{ delta: {}, finish_reason: 'stop' }] };
  if (costUsd !== undefined) finalChunk['total_cost_usd'] = costUsd;
  const chunks = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
    `data: ${JSON.stringify(finalChunk)}\n\n`,
    'data: [DONE]\n\n',
  ];
  return (async function* () {
    for (const c of chunks) yield c;
  })();
}

// ── (a) config wiring: the SAME driver, OpenAI base-URL/model/key ──────────────────
test('★ Codex config: OpenAI base-URL + configurable model id + OPENAI_API_KEY (parameterization, zero new driver)', () => {
  assert.equal(CODEX_REVIEWING_CONFIG.baseUrl, 'https://api.openai.com/v1');
  assert.equal(CODEX_REVIEWING_CONFIG.secretEnvVar, 'OPENAI_API_KEY');
  // the model id is a CONFIGURABLE DEFAULT (placeholder confirmed before activation) — assert it is a
  // non-empty string the route keys on, NOT a specific hardcoded value the test pins forever.
  assert.equal(typeof CODEX_REVIEWING_CONFIG.model, 'string');
  assert.ok(CODEX_REVIEWING_CONFIG.model.length > 0);
});

test('★ buildChatCompletionRequest with the Codex config pins the OpenAI model + assembles messages', () => {
  const opts: SessionStartOptions = {
    onPermission: async () => ({ behavior: 'deny', message: 'n/a' }),
    systemPrompt: 'You are a code reviewer.',
    bootstrapTurns: ['review this diff: ...'],
  };
  const req = buildChatCompletionRequest(CODEX_REVIEWING_CONFIG, opts);
  assert.equal(req.model, CODEX_REVIEWING_CONFIG.model); // the configured Codex model, not DeepSeek's
  assert.equal(req.stream, true);
  // system prompt → system message, the task → user message
  assert.deepEqual(req.messages[0], { role: 'system', content: 'You are a code reviewer.' });
  assert.deepEqual(req.messages[1], { role: 'user', content: 'review this diff: ...' });
  // Codex config leaves thinking OFF (disableThinking:false) — no thinking toggle sent (OpenAI no-op)
  assert.equal(req.thinking, undefined);
});

test('the default api-adapter config map carries BOTH DeepSeek (coding) and Codex (reviewing)', () => {
  assert.strictEqual(DEFAULT_API_ADAPTER_CONFIGS[DEEPSEEK_CODING_CONFIG.model], DEEPSEEK_CODING_CONFIG);
  assert.strictEqual(DEFAULT_API_ADAPTER_CONFIGS[CODEX_REVIEWING_CONFIG.model], CODEX_REVIEWING_CONFIG);
});

// ── (b) routing: reviewing → Codex resolves through the DEFAULT config (no override) ──
test('★ reviewing resolves → api-adapter / the Codex model / fallback claude-cli (DEFAULT config, no override)', () => {
  const sel = resolveRoleBackend('reviewing', DEFAULT_ROLE_ROUTING_CONFIG);
  assert.equal(sel.backend, 'api-adapter');
  assert.equal(sel.model, CODEX_REVIEWING_CONFIG.model);
  assert.equal(sel.fallbackBackend, 'claude-cli'); // FD6
});

test('★ the registry constructs a Codex ApiAdapterDriver for the reviewing selection (no override needed)', () => {
  // DEFAULT registry config map now includes Codex → the reviewing model resolves to the Codex backend.
  const registry = new BackendRegistry({ apiAdapterHttpClient: { stream: async () => openaiSseBody('') } });
  const sel = resolveRoleBackend('reviewing', DEFAULT_ROLE_ROUTING_CONFIG);
  const driver = registry.create(sel);
  assert.ok(driver instanceof ApiAdapterDriver);
  assert.equal(driver.health().detail, 'api-adapter-driver:codex'); // the Codex label, not deepseek
});

// ── capability descriptor: pure text-in/out, same as DeepSeek ──────────────────────
test('Codex backend is the api-adapter kind → supportsTools=false (pure text-in/out, OD-5), same as DeepSeek', () => {
  const caps = ApiAdapterDriver.capabilities();
  assert.equal(caps.supportsTools, false);
  assert.equal(caps.supportsPermissionRouting, false);
  assert.deepEqual(caps, capabilitiesFor('api-adapter'));
});

// ── (c) END-TO-END: dispatch reviewing → a SEALED Codex agent returns a review report ──
test('★★ P4 END-TO-END: dispatch reviewing → SEALED Codex agent returns a review as ONE report (OPENAI_API_KEY scoped)', async () => {
  let captured: ApiAdapterHttpRequest | undefined;
  const httpClient: ApiAdapterHttpClient = {
    async stream(req) {
      captured = req;
      return openaiSseBody('LGTM with one nit: rename `x` → `count`.', 0.0011);
    },
  };
  const registry = new BackendRegistry({
    apiAdapterHttpClient: httpClient,
    apiAdapterEnv: { OPENAI_API_KEY: 'sk-openai-test' } as NodeJS.ProcessEnv,
  });

  const report = await dispatchRoleAgent({
    role: 'reviewing',
    task: 'review the patch',
    registry,
    config: DEFAULT_ROLE_ROUTING_CONFIG, // reviewing → api-adapter / Codex
    env: { OPENAI_API_KEY: 'sk-openai-test' } as NodeJS.ProcessEnv, // seal asserts own-key-only
    ownSecretName: 'OPENAI_API_KEY',
  });

  assert.equal(report.backend, 'api-adapter');
  assert.equal(report.role, 'reviewing');
  assert.equal(report.ok, true);
  assert.equal(report.subtype, 'success');
  assert.equal(report.text, 'LGTM with one nit: rename `x` → `count`.');
  assert.equal(report.costUsd, 0.0011);
  // the request hit the OpenAI endpoint with the Codex model + the env key in the Authorization header
  assert.ok(captured);
  assert.equal(captured!.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(captured!.body.model, CODEX_REVIEWING_CONFIG.model);
  assert.equal(captured!.headers['Authorization'], 'Bearer sk-openai-test');
});

// ── (d) per-backend key scoping: OPENAI_API_KEY only; a foreign key is REFUSED ─────
test('★ a foreign key (stray DEEPSEEK_API_KEY) in a Codex dispatch is REFUSED by the seal (FD5 / per-backend scoping)', async () => {
  const registry = new BackendRegistry({ apiAdapterHttpClient: { async stream() { return openaiSseBody('x'); } } });
  await assert.rejects(
    () =>
      dispatchRoleAgent({
        role: 'reviewing',
        task: 't',
        registry,
        config: DEFAULT_ROLE_ROUTING_CONFIG,
        // Codex owns OPENAI_API_KEY; a stray DeepSeek key is FOREIGN → refused.
        env: { OPENAI_API_KEY: 'sk-openai', DEEPSEEK_API_KEY: 'ds-stray' } as NodeJS.ProcessEnv,
        ownSecretName: 'OPENAI_API_KEY',
      }),
    /Refusing to spawn|foreign|DEEPSEEK_API_KEY/,
  );
});

test('★ a stray ANTHROPIC_API_KEY in a Codex dispatch is REFUSED by the seal (no Claude key in a non-Claude agent)', async () => {
  const registry = new BackendRegistry({ apiAdapterHttpClient: { async stream() { return openaiSseBody('x'); } } });
  await assert.rejects(
    () =>
      dispatchRoleAgent({
        role: 'reviewing',
        task: 't',
        registry,
        config: DEFAULT_ROLE_ROUTING_CONFIG,
        env: { OPENAI_API_KEY: 'sk-openai', ANTHROPIC_API_KEY: 'sk-ant-x' } as NodeJS.ProcessEnv,
        ownSecretName: 'OPENAI_API_KEY',
      }),
    /Refusing to spawn|foreign|ANTHROPIC_API_KEY/,
  );
});

// ── (e) secret-from-env-only + never-logged ────────────────────────────────────────
test('★ the Codex key is read from env ONLY and NEVER appears in a diagnostic line', async () => {
  const stderrLines: string[] = [];
  // Force an error path that emits a diagnostic note (an empty response → note + error result),
  // then assert the key value never leaked into onStderr.
  const driver = new ApiAdapterDriver({
    config: CODEX_REVIEWING_CONFIG,
    env: { OPENAI_API_KEY: 'sk-secret-DO-NOT-LEAK' } as NodeJS.ProcessEnv,
    httpClient: { async stream() { throw new Error('forced transport failure'); } },
    onStderr: (line) => stderrLines.push(line),
    sessionIdFn: () => 'sess-codex',
  });
  const events: SessionEvent[] = [];
  for await (const ev of driver.start({
    onPermission: async () => ({ behavior: 'deny', message: 'n/a' }),
    bootstrapTurns: ['review'],
  })) {
    events.push(ev);
  }
  const result = events.find((e): e is Extract<SessionEvent, { kind: 'result' }> => e.kind === 'result');
  assert.ok(result);
  assert.notEqual(result!.subtype, 'success'); // a surfaced FAILED, not a crash
  // the key VALUE must never appear in any diagnostic line
  assert.ok(!stderrLines.some((l) => l.includes('sk-secret-DO-NOT-LEAK')), 'key value must never be logged');
});

test('the Codex driver surfaces a clean "no key" failure when OPENAI_API_KEY is absent (env-only; no crash, no leak)', async () => {
  const driver = new ApiAdapterDriver({
    config: CODEX_REVIEWING_CONFIG,
    env: {} as NodeJS.ProcessEnv, // no OPENAI_API_KEY
    httpClient: { async stream() { throw new Error('should never be called — no key'); } },
    sessionIdFn: () => 's',
  });
  const events: SessionEvent[] = [];
  for await (const ev of driver.start({ onPermission: async () => ({ behavior: 'deny', message: 'n/a' }), bootstrapTurns: ['x'] })) {
    events.push(ev);
  }
  const result = events.find((e): e is Extract<SessionEvent, { kind: 'result' }> => e.kind === 'result');
  assert.ok(result);
  assert.equal(result!.subtype, 'error_no_api_key');
  // the refusal message names the env var (so the operator knows what to set) but carries no value
  assert.ok((result!.result ?? '').includes('OPENAI_API_KEY'));
});
