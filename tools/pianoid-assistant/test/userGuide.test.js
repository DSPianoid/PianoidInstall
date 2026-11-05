// dev-asstlayout: the assistant answers "where is X" from the user guide. The guide pages are pymdownx.snippets
// wrappers around the in-app help, so the docs index must expand the include, and every anchor the prompt names must
// resolve on both languages' pages.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { INSTALL_ROOT } from '../lib/registry.js';
import { buildIndex, readSection } from '../mcp/docsIndex.js';
import { systemPrompt } from '../service/prompt.js';

const DOCS = path.join(INSTALL_ROOT, 'docs');
const HELP = path.join(INSTALL_ROOT, 'PianoidTunner', 'src', 'help', 'content', 'en.md');
const noHelp = !fs.existsSync(HELP) && 'PianoidTunner checkout not next to docs/';

test('docs index: a --8<-- include is expanded (base = the folder that holds docs/); missing / cyclic ones are not', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asst-snippets-'));
  fs.mkdirSync(path.join(root, 'docs'));
  fs.mkdirSync(path.join(root, 'inc'));
  fs.writeFileSync(path.join(root, 'inc', 'body.md'), '## Side bar {#side-bar}\n\nThe full screen toggle.\n--8<-- "inc/body.md"\n');
  fs.writeFileSync(path.join(root, 'docs', 'guide.md'), '# Guide\n\n--8<-- "inc/body.md"\n--8<-- "inc/missing.md"\n');
  const idx = buildIndex(path.join(root, 'docs'));
  const r = readSection(idx, { page: 'guide.md', anchor: 'side-bar' });
  assert.equal(r.error, undefined);
  assert.match(r.text, /The full screen toggle\./);
  assert.match(r.text, /--8<-- "inc\/body.md"/);           // the self-include stays a plain line
  assert.match(r.text, /--8<-- "inc\/missing.md"/);        // so does a missing file (check_paths: false)
  fs.rmSync(root, { recursive: true, force: true });
});

test('user guide: the prompt routes UI questions to it, every anchor resolves in EN and RU', { skip: noHelp }, () => {
  const line = systemPrompt().split('\n').find((l) => l.includes('guides/USER_GUIDE.md'));
  assert.ok(line, 'no routing line');
  assert.match(line, /guides\/USER_GUIDE_RU\.md/);
  const anchors = /Anchors: ([^;]+);/.exec(line)[1].split(/,\s*/);
  assert.ok(anchors.length >= 10);
  const index = buildIndex(DOCS);
  for (const page of ['guides/USER_GUIDE.md', 'guides/USER_GUIDE_RU.md']) {
    for (const anchor of anchors) assert.equal(readSection(index, { page, anchor }).error, undefined, `${page}#${anchor}`);
  }
  const sideBar = readSection(index, { page: 'guides/USER_GUIDE.md', anchor: 'side-bar' }).text;
  for (const control of ['Load Preset', 'Save Preset as', 'Spawn working copy', 'Manage layouts', 'Play All', 'Follow MIDI', 'Full screen']) {
    assert.ok(sideBar.includes(control), control);
  }
});

test('prompt: no stale layout facts (workbench auto-scale lives in the gear)', () => {
  const p = systemPrompt();
  assert.doesNotMatch(p, /Workbench and its clones, Feedin, Feedback, Sound Channels\) have an Auto-scale toggle in the pane title bar/);
  assert.match(p, /on every Workbench \(the main one and its clones\) it is the Auto-scale y-axis switch in the pane's gear/);
});
