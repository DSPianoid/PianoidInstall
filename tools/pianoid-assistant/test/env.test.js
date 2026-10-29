/**
 * dev-aenv1: env.get / env.set inside the uniform approval model, and the undo of an env.set.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../policy.js';
import { applyAutonomous } from '../autonomy.js';
import { ruleDef } from '../approvals.js';
import { loadCommands } from '../lib/registry.js';
import { loadLimits } from '../lib/paramLimits.js';
import { AutoWriter } from '../service/autoWrite.js';

const COMMANDS = loadCommands();
const BY = new Map(COMMANDS.map((c) => [c.name, c]));
const dec = (name, settings = {}) => {
  const c = BY.get(name);
  return decide({ command: c.name, title: c.title, tier: c.tier, family: c.family, category: c.approval_category, settings });
};

test('registry: env.get is a read, env.set an own command rule naming the allow-list', () => {
  assert.equal(BY.get('env.get').tier, 'read');
  const set = BY.get('env.set');
  assert.deepEqual([set.tier, set.approval_category, set.route.path], ['act', 'per_command', '/settings/env']);
  assert.deepEqual(set.args.required, ['name', 'value']);
  assert.deepEqual(set.args.properties.name.enum, ['PIANOID_AUDIO_OUTPUT_MAP', 'PIANOID_SPEAKER_OUTPUTS', 'PIANOID_ASIO_BUFFER_SIZE', 'PIANOID_LISTEN_TO_MIDI']);
});

test('policy: env.get runs; env.set asks (risky, with a warning) and offers its own Always allow; the Autonomous preset leaves it on Ask', () => {
  assert.equal(dec('env.get').action, 'allow');
  const v = dec('env.set');
  assert.deepEqual([v.action, v.rule.id, v.rule.kind, v.rule.dangerous], ['ask', 'env.set', 'command', true]);
  assert.match(v.rule.warning, /output map/);
  assert.equal(ruleDef('env.set', BY).default, 'ask');
  const always = dec('env.set', { rules: { 'env.set': 'auto' } });
  assert.deepEqual([always.action, always.auto], ['allow', true]);
  assert.equal(dec('env.set', { rules: { 'env.set': 'auto' }, tainted: true }).action, 'ask');   // a taint rule
  const preset = applyAutonomous({ rules: {}, autonomous: { on: false, previous: {} } }, true, BY).rules;
  assert.equal(dec('env.set', { rules: preset }).action, 'ask');
});

test('undo: an executed env.set is recorded and reverts by env.set of its previous setting', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push([String(url), JSON.parse(init?.body || '{}')]);
    const body = String(url).endsWith('/command/env.set') && calls.length === 1
      ? { ok: true, status: 200, result: { name: 'PIANOID_AUDIO_OUTPUT_MAP', value: '8,9,2,3,4,5,6', previous: '0,1,2,3' } }
      : { ok: true, status: 200, result: {} };
    return { ok: true, status: 200, json: async () => body };
  };
  const w = new AutoWriter({ backendUrl: 'http://b', launcherUrl: 'http://l', fetchImpl, limits: loadLimits(), log: () => {}, update: () => {} });
  const turn = w.beginTurn();
  const input = { name: 'PIANOID_AUDIO_OUTPUT_MAP', value: '8,9,2,3,4,5,6' };
  const group = w.permit(BY.get('env.set'), input, {});
  assert.ok(group);
  const res = await w.exec('env.set', input);
  assert.equal(res.body.ok, true);
  const [undo] = await w.undoTurn(turn);
  assert.equal(undo.ok, true);
  assert.deepEqual(calls.at(-1), ['http://b/command/env.set', { name: 'PIANOID_AUDIO_OUTPUT_MAP', value: '0,1,2,3' }]);
});
