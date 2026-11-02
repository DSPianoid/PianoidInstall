// The preset ownership manifest (dev-auto1 provenance rule): classify / record / atomic write, without a session.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MANIFEST_FILE, PresetOwnership } from '../service/presetOwnership.js';

const tmp = (p = 'pianoid-own-') => fs.mkdtempSync(path.join(os.tmpdir(), p));

function setup() {
  const root = tmp();
  const mw = tmp('pianoid-mw-');
  fs.mkdirSync(path.join(mw, 'presets'));
  const events = [];
  const own = new PresetOwnership({ file: path.join(root, MANIFEST_FILE), middleware: mw, audit: { write: (e, f) => events.push({ event: e, ...f }) } });
  return { root, mw, own, events };
}

test('ownership: a creation is recorded atomically (no temp file left); an unknown / non-string path or no home is never own', () => {
  const { root, mw, own } = setup();
  const pre = own.classify('presets/A');
  assert.deepEqual([pre.status, pre.own], ['new', true]);
  fs.writeFileSync(path.join(mw, 'presets', 'A.json'), '{}');
  own.recordAfterSave(pre, path.join(mw, 'presets', 'A.json'));
  assert.deepEqual(fs.readdirSync(root), [MANIFEST_FILE]);
  assert.equal(own.classify('presets/A.json').status, 'owned');
  assert.equal(own.classify(null).own, false);
  assert.equal(new PresetOwnership({ file: null, middleware: mw }).classify('presets/C').own, true);   // a creation...
  assert.equal(new PresetOwnership({ file: null, middleware: mw }).classify('presets/A.json').own, false);  // ...never owned
  assert.equal(new PresetOwnership({ file: path.join(root, MANIFEST_FILE), middleware: null }).classify('presets/A').own, false);
});

test('ownership: a manifest of the wrong shape is corrupt (fail closed), audited once until it changes', () => {
  const { root, mw, own, events } = setup();
  fs.writeFileSync(path.join(mw, 'presets', 'A.json'), '{}');
  for (const bad of ['[]', '{"version": 1, "entries": {"x": {"path": "p", "sha256": "short"}}}', '{"version": 2, "entries": {}}']) {
    fs.writeFileSync(path.join(root, MANIFEST_FILE), bad);
    assert.equal(own.classify('presets/A.json').status, 'error', bad);
  }
  own.classify('presets/A.json');
  assert.equal(events.filter((e) => e.action === 'manifest_problem').length, 1);
});

test('ownership: the backend saved another file than the checked one -> nothing recorded, every later check fails closed', () => {
  const { root, mw, own, events } = setup();
  const pre = own.classify('presets/D');
  const other = path.join(tmp('pianoid-othermw-'), 'D.json');
  fs.writeFileSync(other, '{}');
  own.recordAfterSave(pre, other);
  assert.ok(!fs.existsSync(path.join(root, MANIFEST_FILE)));
  assert.ok(events.some((e) => e.action === 'path_mismatch'));
  assert.deepEqual([own.classify('presets/E').status, own.classify('presets/E').own], ['error', false]);
  own.recordAfterSave(own.classify('presets/F'), undefined);                  // no path reported: also fail closed
  assert.equal(own.classify('presets/F').own, false);
});

test('ownership: the check-to-save guard (a creation must still be new, an owned file unchanged)', () => {
  const { mw, own } = setup();
  const pre = own.classify('presets/B');
  fs.writeFileSync(path.join(mw, 'presets', 'B.json'), 'someone else');
  assert.match(own.unchanged(pre), /changed after the check/);
  assert.equal(own.unchanged({ ...pre, own: false }), null);                  // an approved not-own save: no guard
});
