// dev-tuneskill: the tuning skill travels with the repo: the page + one prompt routing block, every anchor the prompt
// names resolves, no machine facts on the page, the knowledge base is well-formed (JSON = SSOT, md rendered from it,
// every entry complete and sourced), every case has the fixed layout, and the docs nav + index list the pages.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { INSTALL_ROOT } from '../lib/registry.js';
import { buildIndex, readSection } from '../mcp/docsIndex.js';
import { systemPrompt } from '../service/prompt.js';

const PAGE = 'guides/TUNING_FOR_ASSISTANT.md';
const MAP = 'tuning/knowledge/PARAMETER_EFFECTS.md';
const DOCS = path.join(INSTALL_ROOT, 'docs');
const source = fs.readFileSync(path.join(DOCS, PAGE), 'utf8');
const kb = JSON.parse(fs.readFileSync(path.join(DOCS, 'tuning', 'knowledge', 'parameter_effects.json'), 'utf8'));
const index = buildIndex(DOCS);

test('routing: the prompt names the page and the map by their docs paths, and every anchor it names resolves in one read', () => {
  const line = systemPrompt().split('\n').find((l) => l.includes(PAGE));
  assert.ok(line, 'no routing line');
  const anchors = /\(anchors: ([^)]+)\)/.exec(line)[1].split(/,\s*/);
  assert.ok(anchors.length >= 9);
  assert.equal(readSection(index, { page: PAGE }).error, undefined);
  for (const anchor of anchors) {
    const r = readSection(index, { page: PAGE, anchor });
    assert.equal(r.error, undefined, anchor);
    assert.ok(!r.truncated, `${anchor} does not fit one read`);
  }
  assert.ok(systemPrompt().includes(MAP));
  assert.equal(readSection(index, { page: MAP, anchor: 'index' }).error, undefined);
  for (const tool of ['samples_add', 'samples_compare', 'tuning_record']) assert.ok(systemPrompt().includes(tool), tool);
});

test('page: no machine facts (paths, drives, device names, artefact ids), and every internal link resolves', () => {
  const banned = [/\b[A-Za-z]:[\\/]/, /\\Users\\/, /\/media\//, /\/home\//, /\bCOM\d+\b/, /\bUMC\d*/, /Behringer/, /a-\d{14}-/, /\bon this (machine|board)\b/];
  assert.deepEqual(source.split('\n').filter((l) => banned.some((b) => b.test(l))), []);
  for (const [, anchor] of source.matchAll(/\]\(#([\w-]+)\)/g)) assert.equal(readSection(index, { page: PAGE, anchor }).error, undefined, anchor);
  for (const [, page] of source.matchAll(/\]\((tuning\/[\w/.-]+\.md)/g)) assert.equal(readSection(index, { page }).error, undefined, page);
});

test('knowledge map: every entry has every field, a known aspect, a confidence with a source; the md is rendered from the JSON', () => {
  const fields = ['id', 'parameter', 'aspect', 'direction', 'magnitude', 'register', 'side_effects', 'confidence', 'source'];
  const ids = new Set();
  for (const e of kb.entries) {
    for (const f of fields) assert.ok(typeof e[f] === 'string' && e[f].trim(), `${e.id}: ${f}`);
    assert.ok(Object.hasOwn(kb.aspects, e.aspect), `${e.id}: aspect ${e.aspect}`);
    assert.match(e.confidence, /^(measured|literature|anecdotal|unknown)/, e.id);
    assert.ok(!ids.has(e.id), `duplicate ${e.id}`);
    ids.add(e.id);
  }
  assert.ok(kb.entries.length >= 25);
  assert.ok(kb.entries.some((e) => e.confidence === 'unknown'), 'unknowns are stated');
  const md = fs.readFileSync(path.join(DOCS, MAP), 'utf8');
  assert.ok(md.includes('**Generated** from `parameter_effects.json`'));
  for (const e of kb.entries) assert.ok(md.includes(`### ${e.id} {#`), `${e.id} missing from the rendered md: run tools/tuning/render_knowledge.py`);
  assert.equal((md.match(/^### /gm) || []).length, kb.entries.length);
  for (const aspect of Object.keys(kb.aspects)) {
    if (kb.entries.some((e) => e.aspect === aspect)) assert.equal(readSection(index, { page: MAP, anchor: aspect.replace(/[^a-z0-9]+/g, '-') }).error, undefined, aspect);
  }
  // the page's vocabulary names only aspects / card fields that exist
  for (const aspect of ['brightness', 'sustain', 'noise', 'beating', 'thump', 'attack']) assert.ok(md.includes(`## ${aspect} {#`), aspect);
});

test('cases: one file per case with the fixed layout, listed in the cases index', () => {
  const dir = path.join(DOCS, 'tuning', 'cases');
  const idx = fs.readFileSync(path.join(dir, 'index.md'), 'utf8');
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}-[\w-]+\.md$/.test(f));
  assert.ok(files.length >= 8);
  for (const f of files) {
    const t = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.match(t, /^# Tuning case: /, f);
    for (const h of ['**Verdict:**', '**Preset before:**', '**Evidence:**', '**Confidence:**', '## Goal (the user\'s words)', '## Interpreted target', '## What was done', '## Measurements', '## Lessons']) {
      assert.ok(t.includes(h), `${f}: ${h}`);
    }
    assert.ok(idx.includes(`](${f})`), `${f} not in cases/index.md`);
  }
});

test('docs nav + index list the pages; the sample library is git-ignored except its README and schema', () => {
  const nav = fs.readFileSync(path.join(INSTALL_ROOT, 'mkdocs.yml'), 'utf8');
  for (const p of [PAGE, MAP, 'tuning/index.md', 'tuning/cases/index.md']) assert.ok(nav.includes(`: ${p}`), p);
  const idx = fs.readFileSync(path.join(DOCS, 'index.md'), 'utf8');
  assert.ok(idx.includes(`](${PAGE})`) && idx.includes('](tuning/index.md)'));
  const ignore = fs.readFileSync(path.join(INSTALL_ROOT, '.gitignore'), 'utf8');
  assert.ok(ignore.includes('/samples/*') && ignore.includes('!/samples/README.md') && ignore.includes('!/samples/schema.json'));
  assert.ok(fs.existsSync(path.join(INSTALL_ROOT, 'samples', 'README.md')) && fs.existsSync(path.join(INSTALL_ROOT, 'samples', 'schema.json')));
});
