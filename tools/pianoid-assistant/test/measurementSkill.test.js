// dev-measskill: the measurement skill (a docs page + one routing line) travels with the repo: no machine facts on
// the page, every anchor the prompt names resolves, and the docs root does not depend on the install location.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { INSTALL_ROOT, docsDir, loadCommands } from '../lib/registry.js';
import { buildIndex, readSection } from '../mcp/docsIndex.js';
import { createPianoidMcpServer } from '../mcp/server.js';
import { systemPrompt } from '../service/prompt.js';

const PAGE = 'guides/MEASUREMENT_PIPELINE_FOR_ASSISTANT.md';
const DOCS = path.join(INSTALL_ROOT, 'docs');
const source = fs.readFileSync(path.join(DOCS, PAGE), 'utf8');

test('routing line: the prompt names the page by its docs-relative path, and every anchor resolves', () => {
  const line = systemPrompt().split('\n').find((l) => l.includes(PAGE));
  assert.ok(line, 'no routing line');
  const anchors = /\(anchors: ([^)]+)\)/.exec(line)[1].split(/,\s*/);
  assert.ok(anchors.length >= 7);
  const index = buildIndex(DOCS);
  assert.deepEqual(readSection(index, { page: PAGE }).error, undefined);
  for (const anchor of anchors) {
    const r = readSection(index, { page: PAGE, anchor });
    assert.equal(r.error, undefined, anchor);
    assert.ok(!r.truncated, `${anchor} does not fit one read`);
  }
});

test('page: no machine facts (paths, drives, ports, device or channel names, preset or artefact ids)', () => {
  const banned = [
    /\b[A-Za-z]:[\\/]/, /\bD: /, /\\Users\\/, /\/media\//, /\/home\//, /\bCOM\d+\b/, /\bUMC\d*/, /Behringer/,
    /\b(Out|In) \d+/, /a-\d{14}-/, /\bon this (machine|board)\b/,
  ];
  const offending = source.split('\n').filter((l) => banned.some((b) => b.test(l)));
  assert.deepEqual(offending, []);
});

test('page: recipes take rig facts as inputs; hum and sample rate are never literals', () => {
  const code = [...source.matchAll(/```python\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n');
  assert.ok(code.includes('in HUM') && code.includes('* SR') && code.includes('BAND['));
  assert.doesNotMatch(code, /\(50, 100, 150\)|48000|\b1100\b/);
});

test('page: links into the Mode Discovery guide resolve, every named command is in the registry', () => {
  const index = buildIndex(DOCS);
  for (const [, anchor] of source.matchAll(/MODE_DISCOVERY_FOR_ASSISTANT\.md#([\w-]+)/g)) {
    assert.equal(readSection(index, { page: 'guides/MODE_DISCOVERY_FOR_ASSISTANT.md', anchor }).error, undefined, anchor);
  }
  for (const [, anchor] of source.matchAll(/\]\(#([\w-]+)\)/g)) {
    assert.equal(readSection(index, { page: PAGE, anchor }).error, undefined, anchor);
  }
  const names = new Set(loadCommands().map((c) => c.name));
  for (const [, name] of source.matchAll(/`((?:modal|system|audio|calibration|preset|job|env)\.[a-z_]+)(?:\s[^`]*)?`/g)) {
    if (name === 'calibration.*') continue;
    assert.ok(names.has(name), name);
  }
});

test('docs nav + index list the page', () => {
  assert.ok(fs.readFileSync(path.join(INSTALL_ROOT, 'mkdocs.yml'), 'utf8').includes(`: ${PAGE}`));
  assert.ok(fs.readFileSync(path.join(DOCS, 'index.md'), 'utf8').includes(`](${PAGE})`));
});

test('docs root: relative to the code, overridable; a missing root is a tool error, not a crash', async () => {
  assert.equal(docsDir({}), DOCS);
  assert.equal(docsDir({ PIANOID_DOCS_DIR: 'X' }), 'X');
  const server = createPianoidMcpServer({ docsDir: path.join(INSTALL_ROOT, 'no-such-docs'), commands: [] });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '1' });
  await Promise.all([server.connect(b), client.connect(a)]);
  for (const [name, args] of [['read_docs', { page: PAGE }], ['search_docs', { query: 'sweep' }]]) {
    const r = await client.callTool({ name, arguments: args });
    assert.equal(r.isError, true);
    assert.equal(JSON.parse(r.content[0].text).error, 'docs_unavailable');
  }
  await client.close();
});
