// v2 P6 minimal (dev-947d): bug.report -> the native collector POST /bug_report (never GitHub).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, fileReport, preview, validateDraft, BUG_CMD } from '../service/bugReport.js';
import { decide } from '../policy.js';
import { CATEGORIES } from '../approvals.js';
import { AssistantSession } from '../service/session.js';

const DRAFT = {
  title: 'Listing chart types is refused as a render', classification: 'app_bug',
  description: 'render.chart_types (a registry read) was denied by R6 while live audio ran.',
  steps: ['live audio on', 'ask for a mode chart'], expected: 'the list', actual: 'Denied by the Pianoid policy',
  evidence: ['06:07:43 render.chart_types -> denied'],
};

test('draft validation: title, description and an app_bug / environment classification are required', () => {
  assert.doesNotThrow(() => validateDraft(DRAFT));
  assert.throws(() => validateDraft({ ...DRAFT, title: ' ' }), /title is required/);
  assert.throws(() => validateDraft({ ...DRAFT, classification: 'user_state' }), /not a bug/);
  assert.throws(() => validateDraft(null), /object/);
});

test('the host attaches context, versions, the transcript excerpt and the activity; trigger.source assistant', () => {
  const context = { backend: { status: 'healthy' }, environment: { repos: { core: 'dev@15896da' }, build: 'release', gpu: 'RTX 4090' } };
  const transcript = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `m${i}`, at: 1e12 + i }));
  const activity = Array.from({ length: 40 }, (_, i) => ({ command: `c${i}`, decision: 'allow', status: 'ok', at: 1e12 }));
  const r = buildReport({ draft: DRAFT, transcript, activity, context, model: 'claude-opus-5-5', now: new Date('2026-10-18T07:30:00Z'), reportId: 'abcdef0123456789' });
  assert.equal(r.schemaVersion, 2);
  assert.deepEqual(r.trigger, { auto: false, source: 'assistant', kind: 'app_bug' });
  assert.equal(r.createdAt, '2026-10-18T07:30:00.000Z');
  assert.equal(r.description, `ASSISTANT: ${DRAFT.title}`);
  assert.deepEqual(r.versions, { repos: { core: 'dev@15896da' }, build: 'release', gpu: 'RTX 4090', assistant_model: 'claude-opus-5-5' });
  assert.equal(r.pianoid_context, context);
  assert.deepEqual(r.transcript_excerpt.map((m) => m.text), transcript.slice(-12).map((m) => m.text));
  assert.equal(r.activity.length, 30);
  assert.deepEqual(r.report.steps, DRAFT.steps);
  const p = preview(r);
  assert.equal(p.title, DRAFT.title);
  assert.match(p.destination, /never GitHub/);
  assert.deepEqual(p.attached, ['pianoid_context', 'versions', 'transcript (last 12 messages)', 'activity (last 30 entries)']);
});

test('category bug_local: Ask by default (switchable), Auto when set, hard in a web-tainted turn', () => {
  assert.equal(CATEGORIES.find((c) => c.id === 'bug_local').default, 'ask');
  const d = (settings) => decide({ ...BUG_CMD, command: BUG_CMD.name, settings });
  assert.deepEqual(d({}), { action: 'confirm', canAuto: true, reason: 'bug_local: Ask' });
  assert.equal(d({ approvals: { installation: { bug_local: 'auto' } } }).action, 'allow');
  assert.equal(d({ tainted: true }).hard, true);
});

test('fileReport POSTs the report to the collector and reports the saved file', async () => {
  let seen = null;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return { ok: true, status: 200, json: async () => ({ ok: true, saved: 'bugreport-x-assistant-app_bug-ab.json', path: 'D:/r/x.json' }) };
  };
  const out = await fileReport({ reportId: 'ab', x: 1 }, { backendUrl: 'http://b:5012', fetchImpl });
  assert.equal(seen.url, 'http://b:5012/bug_report');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers['X-Pianoid-Source'], 'assistant');
  assert.deepEqual(JSON.parse(seen.init.body), { reportId: 'ab', x: 1 });
  assert.deepEqual(out, { ok: true, saved: 'bugreport-x-assistant-app_bug-ab.json', path: 'D:/r/x.json', reportId: 'ab', duplicate: false });
  assert.equal((await fileReport({}, { backendUrl: 'http://b', fetchImpl: async () => { throw new Error('down'); } })).ok, false);
});

test('session: the dialog shows the full draft; only a confirmed draft is filed, once; declined files nothing', async () => {
  const posts = [];
  const make = (answer) => {
    const confirms = [];
    const s = new AssistantSession({
      paths: {}, config: { model: 'auto' }, commands: [], driverFactory: () => null,
      broadcast: (m) => { if (m.type === 'confirm') { confirms.push(m); setImmediate(() => s.confirm(m.id, answer)); } },
      fetchImpl: async (url, init) => {
        posts.push({ url, body: JSON.parse(init.body) });
        return { ok: true, status: 200, json: async () => ({ ok: true, saved: 'f.json', path: 'p' }) };
      },
    });
    s.lastContext = { environment: { repos: { install: 'master@6369d60' } } };
    s.transcript = [{ role: 'user', text: 'File both issues as bugs', at: 1 }];
    return { s, confirms };
  };
  const yes = make(true);
  assert.equal((await yes.s.canUseTool('mcp__assistant__bug_report', DRAFT, { toolUseID: 't1' })).behavior, 'allow');
  assert.equal(yes.confirms[0].command, 'bug.report');
  assert.equal(yes.confirms[0].category, 'bug_local');
  assert.equal(yes.confirms[0].args.description, DRAFT.description);
  assert.equal(yes.confirms[0].canAuto, true);
  assert.equal(posts.length, 0);                                   // nothing filed before the handler runs
  const res = await yes.s.fileBug(DRAFT);
  assert.equal(res.ok, true);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.trigger.source, 'assistant');
  assert.deepEqual(posts[0].body.versions.repos, { install: 'master@6369d60' });
  assert.equal(posts[0].body.transcript_excerpt[0].text, 'File both issues as bugs');
  assert.equal((await yes.s.fileBug(DRAFT)).error, 'not_permitted');   // a permit files once
  const no = make(false);
  assert.equal((await no.s.canUseTool('mcp__assistant__bug_report', DRAFT, {})).behavior, 'deny');
  assert.equal((await no.s.fileBug(DRAFT)).error, 'not_permitted');
  assert.equal(posts.length, 1);
  const bad = make(true);
  const v = await bad.s.canUseTool('mcp__assistant__bug_report', { ...DRAFT, classification: 'user_state' }, {});
  assert.equal(v.behavior, 'deny');
  assert.equal(bad.confirms.length, 0);
  assert.deepEqual(bad.s.preToolUse({ tool_name: 'mcp__assistant__bug_report', tool_input: DRAFT }), {});
});
