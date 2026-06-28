import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccessGate } from '../adapters/access-gate.js';
import { rawText } from './helpers.js';

test('allowlisted private sender is delivered', () => {
  const gate = new AccessGate({
    staticConfig: { dmPolicy: 'allowlist', allowFrom: ['999'], groups: {} },
  });
  assert.equal(gate.decide(rawText('hi', { fromUserId: '999' })), 'deliver');
});

test('non-allowlisted private sender is dropped', () => {
  const gate = new AccessGate({
    staticConfig: { dmPolicy: 'allowlist', allowFrom: ['111'], groups: {} },
  });
  assert.equal(gate.decide(rawText('hi', { fromUserId: '999' })), 'drop');
});

test('disabled policy drops everyone', () => {
  const gate = new AccessGate({
    staticConfig: { dmPolicy: 'disabled', allowFrom: ['999'], groups: {} },
  });
  assert.equal(gate.decide(rawText('hi', { fromUserId: '999' })), 'drop');
});

test('pairing-mode unpaired private sender is dropped (plugin owns pairing)', () => {
  const gate = new AccessGate({
    staticConfig: { dmPolicy: 'pairing', allowFrom: [], groups: {} },
  });
  assert.equal(gate.decide(rawText('hi', { fromUserId: '999' })), 'drop');
});

test('group requires mention by default', () => {
  const gate = new AccessGate({
    staticConfig: {
      dmPolicy: 'allowlist',
      allowFrom: [],
      groups: { '-100': { requireMention: true, allowFrom: [] } },
    },
    botUsername: 'mybot',
  });
  const inGroup = (text: string) =>
    gate.decide(rawText(text, { chatType: 'supergroup', chatId: '-100', fromUserId: '5' }));
  assert.equal(inGroup('hello there'), 'drop');
  assert.equal(inGroup('hey @mybot help'), 'deliver');
});

test('group allowFrom restricts senders', () => {
  const gate = new AccessGate({
    staticConfig: {
      dmPolicy: 'allowlist',
      allowFrom: [],
      groups: { '-100': { requireMention: false, allowFrom: ['42'] } },
    },
  });
  const from = (id: string) =>
    gate.decide(rawText('hi', { chatType: 'group', chatId: '-100', fromUserId: id }));
  assert.equal(from('42'), 'deliver');
  assert.equal(from('43'), 'drop');
});

test('missing access file → deny-all (does not fail open)', () => {
  const gate = new AccessGate({ accessFile: '/no/such/access.json' });
  assert.equal(gate.decide(rawText('hi', { fromUserId: '999' })), 'drop');
});
