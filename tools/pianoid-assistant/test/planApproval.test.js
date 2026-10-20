// Plan pre-approval (dev-28f1, DORMANT behind PIANOID_ASSISTANT_PLAN_APPROVAL): the request, the user-only grant,
// envelope matching, expiry, revoke, the activity log, the policy invariants and the flag-off no-change proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, HARD_CONFIRM } from '../policy.js';
import { CATEGORIES } from '../approvals.js';
import { loadCommands } from '../lib/registry.js';
import { SdkDriver } from '../drivers/sdk.js';
import { systemPrompt } from '../service/prompt.js';
import {
  FLAG, enabled, validateRequest, createGrant, matchGrant, recordUse, describeGrant, footprint, LEVEL_CAP_DBFS,
} from '../planApproval.js';
import { AssistantSession, PLAN_TOOL } from '../service/session.js';

const COMMANDS = loadCommands();
const byName = new Map(COMMANDS.map((c) => [c.name, c]));
const C = (n) => byName.get(n);
const dec = (name, settings = {}) => {
  const c = C(name);
  return decide({ command: c.name, tier: c.tier, family: c.family, category: c.approval_category, settings });
};

// a rig plan: capture on Out 9 / Out 10 at <= -36 dBFS, process, a new preset
const RIG_REQ = {
  title: 'Board measurement',
  steps: ['capture E1/E2 sweeps', 'frf + polymax', 'build the preset'],
  commands: ['modal.rig_capture', 'modal.rig_process', 'preset.create', 'play.note', 'param.mute_modes', 'preset.save'],
  max_level_dbfs: -36,
  output_channels: ['Out 9', 'Out 10'],
  input_channels: ['In 1', 'In 2'],
  max_drive_s: 130,
  folders: ['rig_runs', 'presets/BoardA'],
  expires_in_min: 30,
};
const CAPTURE = {
  exciters: [{ output: 'Out 9', level_dbfs: -40 }, { output: 'Out 10' }],          // default level -42
  inputs: [{ input: 'In 1' }, { input: 'In 2' }],
  sweep: { duration_s: 20 }, timing: { repeats: 3 },                               // 2 x 3 x 20 = 120 s
};
const NOW = 1_800_000_000_000;
const req = (over = {}) => {
  const v = validateRequest({ ...RIG_REQ, ...over }, byName);
  assert.ok(v.ok, v.error);
  return v.request;
};

test('the flag: OFF unless PIANOID_ASSISTANT_PLAN_APPROVAL is exactly "1"', () => {
  assert.equal(FLAG, 'PIANOID_ASSISTANT_PLAN_APPROVAL');
  assert.equal(enabled({}), false);
  for (const v of ['0', '', 'true', 'yes', ' 1']) assert.equal(enabled({ [FLAG]: v }), false, v);
  assert.equal(enabled({ [FLAG]: '1' }), true);
  // the test process itself runs with the default (off): every session below that does not opt in is dormant
  assert.equal(new AssistantSession({ paths: {}, config: {}, commands: COMMANDS, driverFactory: () => null }).plan.enabled, enabled());
});

test('the request: validated against the registry; the -24 dBFS cap cannot be raised; code / excluded never plannable', () => {
  const r = req();
  assert.deepEqual(r.envelope.outputs, ['out 9', 'out 10']);
  assert.equal(r.envelope.maxLevelDbfs, -36);
  assert.deepEqual(r.commands.filter((c) => c.hard).map((c) => c.name), ['modal.rig_capture', 'modal.rig_process', 'preset.create', 'preset.save']);
  assert.deepEqual(r.commands.filter((c) => c.irreversible).map((c) => c.name), ['preset.save']);
  const bad = (over, re) => {
    const v = validateRequest({ ...RIG_REQ, ...over }, byName);
    assert.equal(v.ok, false, JSON.stringify(over));
    assert.match(v.error, re);
  };
  bad({ max_level_dbfs: -20 }, /-24/);
  bad({ max_level_dbfs: 0 }, /-24/);
  bad({ max_level_dbfs: undefined }, /max_level_dbfs/);
  bad({ commands: ['analysis.run_python'] }, /unknown|cannot/);
  bad({ commands: ['launcher.backend.stop'] }, /cannot be in a plan/);
  bad({ commands: ['nope.cmd'] }, /unknown command/);
  bad({ expires_in_min: 0 }, /expires_in_min/);
  bad({ expires_in_min: 121 }, /expires_in_min/);
  bad({ folders: ['../etc'] }, /folders/);
  bad({ input_channels: [] }, /input_channels/);
  bad({ steps: [] }, /steps/);
  assert.equal(LEVEL_CAP_DBFS, -24);
});

test('the grant: hard-confirm commands only when ticked; irreversible ones too (never implied)', () => {
  const g0 = createGrant(req(), { now: NOW });
  assert.deepEqual(g0.commands, ['play.note', 'param.mute_modes']);         // nothing hard without a tick
  assert.deepEqual(g0.hardTicked, []);
  const g = createGrant(req(), { ticked: ['modal.rig_capture', 'modal.rig_process', 'preset.create', 'not.requested'], now: NOW });
  assert.deepEqual(g.commands, ['modal.rig_capture', 'modal.rig_process', 'preset.create', 'play.note', 'param.mute_modes']);
  assert.ok(!g.commands.includes('preset.save'));
  assert.ok(!g.commands.includes('not.requested'));                          // a tick cannot add a command
  assert.equal(g.expiresAt, NOW + 30 * 60000);
});

test('envelope matching: commands, level, channels, drive budget, folders (fail closed)', () => {
  let g = createGrant(req(), { ticked: ['modal.rig_capture', 'modal.rig_process', 'preset.create'], now: NOW });
  const m = (name, input, now = NOW + 1000) => matchGrant(g, { cmd: C(name), input, now });
  const ok = m('modal.rig_capture', CAPTURE);
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(ok.ticked, true);
  assert.equal(ok.driveS, 120);
  assert.deepEqual(footprint(C('modal.rig_capture'), CAPTURE).levels, [-40, -42]);
  const no = (r, re) => { assert.equal(r.ok, false); assert.match(r.reason, re); };
  no(m('modal.rig_capture', { ...CAPTURE, exciters: [{ output: 'Out 9', level_dbfs: -30 }] }), /level -30/);
  no(m('modal.rig_capture', { ...CAPTURE, exciters: [{ output: 'Out 3', level_dbfs: -40 }] }), /output Out 3/);
  no(m('modal.rig_capture', { ...CAPTURE, inputs: [{ input: 'In 5' }] }), /input In 5/);
  no(m('modal.rig_capture', { ...CAPTURE, timing: { repeats: 4 } }), /drive 160/);           // 160 > 130
  no(m('modal.rig_capture', { ...CAPTURE, loopback: { output: 'Out 9', input: 'In 1' } }), /level is unknown/);
  assert.equal(m('modal.rig_capture', { ...CAPTURE, dry_run: true }).driveS, 0);
  no(m('modal.rig_sine', { frequency_hz: 100, outputs: [{ output: 'Out 9' }] }), /not in the approved plan/);
  no(m('preset.save', { path: 'presets/BoardA.json' }), /not in the approved plan/);
  assert.equal(m('preset.create', { name: 'BoardA', num_strings: 8, num_channels: 2, array_size: 512 }).ok, true);
  no(m('preset.create', { name: 'Other', num_strings: 8, num_channels: 2, array_size: 512 }), /folder presets\/Other/);
  assert.equal(m('modal.rig_process', { step: 'frf', run: '20261020T120000-capture' }).ok, true);
  no(m('modal.rig_process', { step: 'frf', run: 'x', area: 'rig_checks' }), /folder rig_checks\/x/);
  no(m('modal.rig_process', { step: 'frf', run: '../../x' }), /folder/);
  // the drive budget is cumulative over the grant
  g = recordUse(g, { command: 'modal.rig_capture', driveS: 120, now: NOW + 2000 });
  no(m('modal.rig_capture', { ...CAPTURE, exciters: [{ output: 'Out 9' }], timing: { repeats: 1 } }), /drive 20 s \+ 120 s/);
  assert.equal(m('play.note', { pitch: 60 }).ok, true);
});

test('expiry and revoke: an expired / revoked grant matches nothing and is not shown', () => {
  const g = createGrant(req(), { ticked: ['modal.rig_capture'], now: NOW });
  assert.equal(matchGrant(g, { cmd: C('play.note'), now: g.expiresAt - 1 }).ok, true);
  assert.match(matchGrant(g, { cmd: C('play.note'), now: g.expiresAt }).reason, /expired/);
  assert.equal(describeGrant(g, g.expiresAt), null);
  assert.ok(describeGrant(g, NOW).remainingS > 0);
  assert.match(matchGrant({ ...g, revoked: true }, { cmd: C('play.note'), now: NOW }).reason, /revoked/);
  assert.match(matchGrant(null, { cmd: C('play.note') }).reason, /no active/);
});

test('policy: a plan never bypasses the deny rows, a tainted turn, code, or an unticked hard-confirm', () => {
  const plan = { ok: true, ticked: true, grantId: 'g', reason: 'plan' };
  // the point of the feature: a ticked rig hard-confirm command runs inside the plan
  for (const n of ['modal.rig_capture', 'modal.rig_sine', 'modal.rig_record', 'modal.rig_process', 'preset.create', 'modal.set_measurements_dir']) {
    const v = dec(n, { plan });
    assert.deepEqual([v.action, v.auto, v.plan], ['allow', true, 'g'], n);
  }
  // tainted turn: hard confirm, never canAuto, plan or not (dev-c0de invariant)
  for (const n of ['modal.rig_capture', 'play.note', 'param.set', 'preset.switch']) {
    const v = dec(n, { plan, tainted: true });
    assert.deepEqual([v.action, v.hard, !!v.canAuto], ['confirm', true, false], n);
  }
  // analysis code (category code) never takes a plan verdict
  const code = decide({ command: 'analysis.run_python', tier: 'act', family: 'analysis', category: 'code', settings: { plan } });
  assert.equal(code.action, 'confirm');
  assert.ok(!code.plan);
  // a hard-confirm command the user did not tick stays a hard confirm
  for (const n of Object.keys(HARD_CONFIRM).filter((x) => C(x))) {
    const v = dec(n, { plan: { ...plan, ticked: false } });
    assert.deepEqual([v.action, v.hard], ['confirm', true], n);
  }
  // deny rows win
  assert.equal(dec('launcher.backend.stop', { plan }).action, 'deny');
  assert.equal(dec('modal.rig_capture', { plan, dataOptOut: true }).action, 'deny');
  assert.equal(decide({ command: 'render.calibration_x', tier: 'act', family: 'render', category: 'renders', settings: { plan, liveAudio: true } }).action, 'deny');
  // params / runtime: a plan still needs the A2 envelope
  assert.equal(dec('param.mute_modes', { plan }).action, 'confirm');
  const env = dec('param.mute_modes', { plan, envelope: { ok: true, reason: 'mask switch' } });
  assert.deepEqual([env.action, env.watch, env.plan], ['allow', true, 'g']);
  assert.equal(dec('runtime.set', { plan, envelope: { ok: false, reason: 'outside' } }).action, 'confirm');
  // a failed match (ok false) is the same as no plan
  assert.deepEqual(dec('modal.rig_capture', { plan: { ok: false, reason: 'x' } }), dec('modal.rig_capture', {}));
});

test('policy flag-off no-change: without settings.plan every verdict equals the pre-feature table', () => {
  // the pre-feature decide() for every registry command x every settings combination; planStep returns null
  // without settings.plan, so a plan-less call is unchanged (no plan field, same action / reason / flags)
  const ALL_AUTO = Object.fromEntries([...CATEGORIES.map((c) => c.id)].map((id) => [id, 'auto']));
  const combos = [];
  for (const approvals of [undefined, { installation: ALL_AUTO, session: {} }]) {
    for (const envelope of [undefined, { ok: true, reason: 'e' }, { ok: false, reason: 'o' }]) {
      for (const tainted of [false, true]) for (const liveAudio of [false, true]) for (const dataOptOut of [false, true]) {
        combos.push({ approvals, envelope, tainted, liveAudio, dataOptOut });
      }
    }
  }
  for (const c of COMMANDS) {
    for (const s of combos) {
      const v = dec(c.name, s);
      assert.equal('plan' in v, false, c.name);
      assert.deepEqual(dec(c.name, { ...s, plan: undefined }), v, c.name);
      assert.deepEqual(dec(c.name, { ...s, plan: { ok: false, reason: 'x' } }), v, c.name);
    }
  }
});

// ---- the service -----------------------------------------------------------------------------

const fakeFetch = async (url) => ({ json: async () => (String(url).includes('get_parameter') ? {} : { pianoid_loaded: false }) });
const mkSession = (planApproval) => {
  const sent = [];
  const s = new AssistantSession({
    paths: {}, config: { model: 'sonnet' }, commands: COMMANDS, driverFactory: () => null,
    broadcast: (m) => sent.push(m), fetchImpl: fakeFetch, planApproval,
  });
  return { s, sent };
};
const tool = (n) => `mcp__pianoid__${n.replace(/\./g, '__')}`;

test('flag OFF (default): the session is byte-for-byte the pre-feature one', async () => {
  const { s, sent } = mkSession(enabled({}));        // the default environment (no flag)
  assert.equal(s.plan.enabled, false);
  assert.equal('planApproval' in s.state(), false);
  assert.deepEqual(Object.keys(s.state()), ['type', 'modelChoice', 'model', 'dataOptOut', 'busy', 'transcript', 'activity', 'usage', 'status', 'pendingConfirms', 'approvals']);
  const opts = s.sdkOptions();
  assert.equal(opts.systemPrompt, systemPrompt());
  assert.equal(opts.mcpServers.assistant.requestPlan, undefined);
  // the plan tool does not exist: canUseTool / the hook deny it exactly like any foreign tool
  assert.deepEqual(await s.canUseTool(PLAN_TOOL, {}), { behavior: 'deny', message: `${PLAN_TOOL} is not available to the Pianoid assistant` });
  assert.equal(s.preToolUse({ tool_name: PLAN_TOOL }).hookSpecificOutput.permissionDecision, 'deny');
  // WS plan messages do nothing; requestPlan refuses
  s.answerPlan({ id: 'p1', accept: true, ticked: ['modal.rig_capture'] });
  s.revokePlan();
  assert.deepEqual(await s.requestPlan(RIG_REQ), { ok: false, error: 'plan approval is not enabled' });
  assert.equal(s.plan.grant, null);
  assert.deepEqual(sent, []);
  assert.deepEqual(s.activity, []);
  // a hard-confirm rig command still asks, hard, with no plan in the request
  const p = s.canUseTool(tool('modal.rig_capture'), CAPTURE, { toolUseID: 't1' });
  await new Promise((r) => setImmediate(r));
  const confirm = sent.find((m) => m.type === 'confirm');
  assert.equal(confirm.hard, true);
  assert.equal(confirm.reason, HARD_CONFIRM['modal.rig_capture']);
  s.confirm(confirm.id, false);
  assert.equal((await p).behavior, 'deny');
  assert.ok(!s.activity.some((a) => 'plan' in a));
});

test('flag OFF: the SDK assistant server is built exactly as before (no plan tool)', () => {
  const a = SdkDriver.assistantTools(async () => '', async () => ({}));
  const b = SdkDriver.assistantTools(async () => '', async () => ({}), undefined);
  const names = (srv) => Object.keys(srv.instance?._registeredTools || {});
  assert.deepEqual(names(a), names(b));
  assert.ok(!names(a).includes('request_plan_approval'));
  assert.ok(names(SdkDriver.assistantTools(async () => '', async () => ({}), async () => ({}))).includes('request_plan_approval'));
});

test('flag ON: request -> only the user click grants -> steps auto-run, logged; outside still asks; revoke', async () => {
  const { s, sent } = mkSession(true);
  assert.equal(s.state().planApproval, null);                                   // the indicator is off
  assert.match(s.sdkOptions().systemPrompt, /request_plan_approval/);
  assert.equal((await s.canUseTool(PLAN_TOOL, RIG_REQ)).behavior, 'allow');     // the tool only requests
  assert.deepEqual(s.preToolUse({ tool_name: PLAN_TOOL }), {});
  // an invalid request never reaches the pane
  assert.equal((await s.requestPlan({ ...RIG_REQ, max_level_dbfs: -10 })).ok, false);
  assert.equal(sent.filter((m) => m.type === 'plan_request').length, 0);

  const pending = s.requestPlan(RIG_REQ);
  const shown = sent.find((m) => m.type === 'plan_request');
  assert.ok(shown.steps.length === 3 && shown.envelope.maxDriveS === 130);
  assert.equal(s.plan.grant, null);                                             // nothing until the user clicks
  assert.deepEqual(s.state().pendingPlanRequests.map((r) => r.id), [shown.id]);   // a reconnecting pane sees it
  s.answerPlan({ id: 'bogus', accept: true });                                  // an unknown id creates nothing
  assert.equal(s.plan.grant, null);
  s.answerPlan({ id: shown.id, accept: true, ticked: ['modal.rig_capture'] });
  const res = await pending;
  assert.equal(res.granted, true);
  assert.deepEqual(res.still_asking, ['modal.rig_process', 'preset.create', 'preset.save']);
  assert.ok(s.state().planApproval.expiresAt > Date.now());
  s.answerPlan({ id: shown.id, accept: true, ticked: ['preset.save'] });        // a replayed answer does nothing
  assert.ok(!s.plan.grant.commands.includes('preset.save'));

  // inside the plan: no confirm, logged with the grant id + the grant's own log + drive budget
  const r1 = await s.canUseTool(tool('modal.rig_capture'), CAPTURE, { toolUseID: 't1' });
  assert.equal(r1.behavior, 'allow');
  const e1 = s.activity.findLast((a) => a.command === 'modal.rig_capture');
  assert.deepEqual([e1.decision, e1.plan], ['plan', s.plan.grant.id]);
  assert.equal(s.plan.grant.driveUsedS, 120);
  assert.deepEqual(s.plan.grant.log.map((l) => [l.command, l.activityId]), [['modal.rig_capture', e1.id]]);
  assert.ok(!sent.some((m) => m.type === 'confirm'));

  // outside the plan (budget used up / unticked) still asks, and the reason says why
  const p2 = s.canUseTool(tool('modal.rig_capture'), CAPTURE, { toolUseID: 't2' });
  await new Promise((r) => setImmediate(r));
  const c2 = sent.find((m) => m.type === 'confirm');
  assert.equal(c2.hard, true);
  assert.match(c2.reason, /outside the plan approval: drive 120 s \+ 120 s/);
  s.confirm(c2.id, false);
  await p2;
  const p3 = s.canUseTool(tool('modal.rig_process'), { step: 'frf', run: 'r1' }, { toolUseID: 't3' });
  await new Promise((r) => setImmediate(r));
  const c3 = sent.filter((m) => m.type === 'confirm')[1];
  assert.match(c3.reason, /not in the approved plan/);
  s.confirm(c3.id, false);
  await p3;

  // one-click revoke: the indicator goes away, the next step asks again
  s.revokePlan();
  assert.equal(s.state().planApproval, null);
  assert.ok(s.activity.some((a) => a.command === 'plan approval' && a.decision === 'revoked'));
  assert.deepEqual(sent.findLast((m) => m.type === 'plan'), { type: 'plan', planApproval: null });
  const p4 = s.canUseTool(tool('play.note'), { pitch: 60 }, { toolUseID: 't4' });
  assert.equal((await p4).behavior, 'allow');                                    // playback is Auto by default anyway
  assert.equal(s.activity.findLast((a) => a.command === 'play.note').decision, 'auto');
});

test('flag ON: Stop declines a pending request; expiry revokes and logs', async () => {
  const { s, sent } = mkSession(true);
  const pending = s.requestPlan(RIG_REQ);
  await s.stop();
  assert.equal((await pending).granted, false);
  assert.equal(s.plan.grant, null);
  const p2 = s.requestPlan({ ...RIG_REQ, expires_in_min: 1 });
  const id = sent.filter((m) => m.type === 'plan_request')[1].id;
  s.answerPlan({ id, accept: true, ticked: [] });
  await p2;
  s.plan.grant.expiresAt = Date.now() - 1;                                      // time passes
  assert.equal(s.planMatch(C('play.note'), {}), null);
  assert.equal(s.plan.grant, null);
  assert.ok(s.activity.some((a) => a.command === 'plan approval' && a.decision === 'revoked' && a.reason === 'expired'));
  clearTimeout(s.plan.timer);
});
