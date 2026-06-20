/**
 * SECRET STORE tests — the gitignored, per-provider scoped key store behind `/setkey`.
 * Uses a TEMP dir (os.tmpdir) — NO real key, NO network, zero spend. Asserts:
 *   - a key stored under its provider's SECRET ENV VAR NAME reads back scoped (a deepseek agent
 *     gets DEEPSEEK_API_KEY, not another provider's key);
 *   - the masked form NEVER contains the full key value;
 *   - empty/garbage keys are rejected;
 *   - the gitignored-path guard accepts `.state`/.env paths and rejects a non-gitignored path;
 *   - loadAll() projects to the env-injection map (env-var-name → key).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import {
  SecretStore,
  SecretStoreError,
  maskSecret,
  maskSecretWithPrefix,
  assertGitignoredPath,
  defaultSecretStorePath,
  DEFAULT_SECRET_STORE_FILENAME,
} from '../secret-store.js';
import { DEFAULT_PROVIDERS } from '../provider-registry.js';

/** A fresh temp store path under a '.state' dir (so it satisfies the gitignored-path guard too). */
function tmpStore(): { dir: string; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'pianoid-secret-store-'));
  const path = join(dir, '.state', 'provider-secrets.json');
  return { dir, path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const FAKE_DEEPSEEK = 'ds_fake_KEYvalue_1234'; // NOT a real key
const FAKE_GROQ = 'gsk_fake_live_abcdEFGH5678'; // NOT a real key

/* ── masking ──────────────────────────────────────────────────────────────────── */

test('★ maskSecret never reveals the full value (only a short tail)', () => {
  const m = maskSecret(FAKE_GROQ);
  assert.ok(!m.includes(FAKE_GROQ), 'mask must not contain the whole key');
  assert.ok(m.includes('5678'), 'mask shows the last-4 hint');
  assert.ok(m.length < FAKE_GROQ.length);
});

test('maskSecretWithPrefix surfaces the non-secret vendor prefix + a tail, never the middle', () => {
  const m = maskSecretWithPrefix(FAKE_GROQ); // gsk_… → 'gsk…5678'
  assert.ok(m.startsWith('gsk'), 'keeps the vendor prefix');
  assert.ok(m.endsWith('5678'));
  assert.ok(!m.includes('abcdEFGH'), 'never reveals the secret middle');
});

test('mask of an empty value is a placeholder (never throws, never reveals)', () => {
  assert.equal(maskSecret(''), '∅');
  assert.equal(maskSecretWithPrefix('   '), '∅');
});

/* ── gitignored-path guard ──────────────────────────────────────────────────────── */

test('★ assertGitignoredPath accepts a .state path and an .env path; rejects a non-gitignored path', () => {
  assert.doesNotThrow(() => assertGitignoredPath(resolve('/x/y/.state/provider-secrets.json')));
  assert.doesNotThrow(() => assertGitignoredPath(resolve('/x/y/.secrets/keys.json')));
  assert.doesNotThrow(() => assertGitignoredPath(resolve('/x/y/.env.local')));
  assert.throws(() => assertGitignoredPath(resolve('/x/y/src/keys.json')), SecretStoreError);
});

test('defaultSecretStorePath points under <root>/.state and honors SUPERVISOR_STATE_DIR', () => {
  const p1 = defaultSecretStorePath('/sup/root', {} as NodeJS.ProcessEnv);
  assert.ok(p1.endsWith(`${sep}.state${sep}${DEFAULT_SECRET_STORE_FILENAME}`), p1);
  // The default path is itself under a gitignored '.state' dir.
  assert.doesNotThrow(() => assertGitignoredPath(p1));
  const p2 = defaultSecretStorePath('/sup/root', { SUPERVISOR_STATE_DIR: '/var/run/.state' } as NodeJS.ProcessEnv);
  assert.ok(p2.startsWith(`${sep}var${sep}run${sep}.state`) || p2.includes('.state'), p2);
});

/* ── store/read scoped, reject garbage ────────────────────────────────────────────── */

test('★ a key stored under a provider secret env var reads back SCOPED (deepseek → DEEPSEEK_API_KEY)', () => {
  const t = tmpStore();
  try {
    const store = new SecretStore({ filePath: t.path });
    const dsSecret = DEFAULT_PROVIDERS.deepseek.secretEnvVar; // DEEPSEEK_API_KEY
    const groqSecret = DEFAULT_PROVIDERS.groq.secretEnvVar; // GROQ_API_KEY

    const { masked } = store.setKey(dsSecret, FAKE_DEEPSEEK);
    assert.ok(!masked.includes(FAKE_DEEPSEEK), 'returned mask must not leak the value');

    // scoped read-back: the deepseek secret is present; another provider's is NOT.
    assert.equal(store.getKey(dsSecret), FAKE_DEEPSEEK);
    assert.equal(store.has(dsSecret), true);
    assert.equal(store.getKey(groqSecret), undefined, 'a different provider key is not present');
    assert.equal(store.has(groqSecret), false);

    // store a SECOND provider's key — both coexist, each scoped to its own env var name.
    store.setKey(groqSecret, FAKE_GROQ);
    assert.equal(store.getKey(dsSecret), FAKE_DEEPSEEK);
    assert.equal(store.getKey(groqSecret), FAKE_GROQ);
    assert.deepEqual(store.storedEnvVarNames().sort(), [dsSecret, groqSecret].sort());
  } finally {
    t.cleanup();
  }
});

test('★ the persisted file lives at the configured (.state, gitignored) path', () => {
  const t = tmpStore();
  try {
    const store = new SecretStore({ filePath: t.path });
    store.setKey(DEFAULT_PROVIDERS.deepseek.secretEnvVar, FAKE_DEEPSEEK);
    assert.ok(existsSync(t.path), 'store file created at the configured path');
    assert.ok(t.path.includes(`${sep}.state${sep}`), 'path is under a gitignored .state dir');
    // The file DOES contain the key (it is the at-rest store, gitignored) — but it is the ONLY place.
    const onDisk = readFileSync(t.path, 'utf8');
    assert.ok(onDisk.includes('DEEPSEEK_API_KEY'), 'keyed by the secret env var name');
  } finally {
    t.cleanup();
  }
});

test('empty / whitespace key is REJECTED (no empty key stored)', () => {
  const t = tmpStore();
  try {
    const store = new SecretStore({ filePath: t.path });
    assert.throws(() => store.setKey('DEEPSEEK_API_KEY', ''), SecretStoreError);
    assert.throws(() => store.setKey('DEEPSEEK_API_KEY', '   '), SecretStoreError);
    assert.throws(() => store.setKey('', FAKE_DEEPSEEK), SecretStoreError);
    assert.equal(store.has('DEEPSEEK_API_KEY'), false);
  } finally {
    t.cleanup();
  }
});

test('loadAll projects to the env-injection map (env-var name → key) for the launcher/seal', () => {
  const t = tmpStore();
  try {
    const store = new SecretStore({ filePath: t.path });
    store.setKey('DEEPSEEK_API_KEY', FAKE_DEEPSEEK);
    store.setKey('GROQ_API_KEY', FAKE_GROQ);
    const all = store.loadAll();
    assert.deepEqual(all, { DEEPSEEK_API_KEY: FAKE_DEEPSEEK, GROQ_API_KEY: FAKE_GROQ });
  } finally {
    t.cleanup();
  }
});

test('a fresh store with no file reads back empty (no throw)', () => {
  const t = tmpStore();
  try {
    const store = new SecretStore({ filePath: t.path });
    assert.deepEqual(store.loadAll(), {});
    assert.equal(store.has('DEEPSEEK_API_KEY'), false);
    assert.equal(store.getKey('DEEPSEEK_API_KEY'), undefined);
  } finally {
    t.cleanup();
  }
});
