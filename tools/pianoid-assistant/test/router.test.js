// Assistant v2 P1 (dev-fcef): the model router — the routing corpus (2026-10-16 transcripts +
// requirement examples + Russian), stickiness and the in-turn triggers. Pure, zero spend.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { preRoute, Router, STICKY_TURNS } from '../service/router.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(fs.readFileSync(path.join(HERE, 'routing-corpus.json'), 'utf8'));

test('routing corpus: every case routes as labelled', () => {
  const wrong = [];
  for (const c of corpus.cases) {
    const r = preRoute(c.text);
    if (r.route !== c.expect || (c.category && r.category !== c.category)) {
      wrong.push(`${c.source}: "${c.text}" -> ${r.route} / ${r.rule} (expected ${c.expect}${c.category ? ` / ${c.category}` : ''})`);
    }
  }
  assert.deepEqual(wrong, []);
  assert.ok(corpus.cases.filter((c) => c.source.startsWith('transcript')).length >= 20);
});

test('the rule names the matched words (shown in the activity log)', () => {
  assert.equal(preRoute('make the sound brighter').rule, 'timbre edit ("make the sound brighter")');
  assert.equal(preRoute('lower the volume').rule, 'plain action / read');
});

test('context: a crashed engine routes to Opus; warnings alone do not', () => {
  assert.equal(preRoute('lower the volume', { backend: { status: 'crashed' } }).route, 'opus');
  assert.match(preRoute('lower the volume', { backend: { exception: true } }).rule, /context: the engine reports an exception/);
  const warned = { backend: { status: 'healthy' }, warnings: ['Loaded with settings the preset does not declare'] };
  assert.equal(preRoute('lower the volume', warned).route, 'sonnet');
  assert.equal(preRoute('lower the volume', { backend: { unreachable: true } }).route, 'sonnet');
});

test('stickiness: an Opus turn keeps Opus for the next 2 turns, which do not renew it', () => {
  const r = new Router();
  assert.equal(r.beginTurn('make the sound brighter').model, 'opus');
  assert.equal(r.endTurn(), 'opus');
  const f1 = r.beginTurn('and the bass?');
  assert.deepEqual([f1.model, f1.layer], ['opus', 'sticky']);
  assert.match(f1.rule, /1 of 2/);
  assert.equal(r.endTurn(), 'opus');
  const f2 = r.beginTurn('ok, play C4');
  assert.deepEqual([f2.model, f2.layer], ['opus', 'sticky']);
  assert.equal(r.endTurn(), 'sonnet');
  assert.equal(r.beginTurn('ok, play C4').model, 'sonnet');
  assert.equal(STICKY_TURNS, 2);
});

test('a new Opus-routed turn inside the sticky window renews it', () => {
  const r = new Router();
  r.beginTurn('why is it so dull?'); r.endTurn();
  r.beginTurn('and the bass?'); r.endTurn();          // sticky 1 of 2
  assert.equal(r.beginTurn('compare it with preset B').layer, 'pre-route');
  r.endTurn();
  assert.equal(r.stickyLeft, 2);
});

test('layer 2: two consecutive tool errors escalate once; a success resets the count', () => {
  const r = new Router();
  assert.equal(r.beginTurn('mute channel 3').model, 'sonnet');
  assert.equal(r.onToolResult(true), null);
  assert.equal(r.onToolResult(false), null);
  assert.equal(r.onToolResult(true), null);
  assert.equal(r.onToolResult(true), 'failure trigger: 2 consecutive tool errors');
  assert.equal(r.onToolResult(true), null);           // already on Opus
  assert.equal(r.endTurn(), 'opus');                   // an escalated turn is sticky
});

test('layer 2: a retry of a refused command and the first heavy-tool call escalate', () => {
  const r = new Router();
  r.beginTurn('set the volume');
  assert.equal(r.onToolCall('runtime.set'), null);
  r.onRefused('runtime.set');
  assert.equal(r.onToolCall('runtime.set'), 'failure trigger: retry of the refused runtime.set');
  const h = new Router();
  h.beginTurn('show me');
  assert.equal(h.onToolCall('analysis.run_python'), 'tool trigger: first code run (analysis.run_python)');
});

test('layer 3: self-escalation is recorded and makes the turn sticky', () => {
  const r = new Router();
  r.beginTurn('play C4');
  assert.equal(r.onEscalated('multi-step diagnosis'), 'self-escalation: multi-step diagnosis');
  assert.equal(r.endTurn(), 'opus');
});
