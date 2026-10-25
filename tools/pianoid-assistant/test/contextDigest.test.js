// dev-0a88: the per-turn context digest and the render-result shaping (pure), on the shapes the
// 2026-10-16 live session saw.
import test from 'node:test';
import assert from 'node:assert/strict';
import { audioDigest, buildDigest } from '../service/contextDigest.js';
import { seriesStats, shapeResult } from '../mcp/tools.js';

const HEALTH = {
  status: 'healthy', pianoid_loaded: true, exception: false, message: 'ok',
  lifecycle: { audio_driver_active: true, gpu_initialized: true, main_loop_should_continue: true },
  audio_driver_fallback: { occurred: false, requested: 'ASIO_CALLBACK', active: 'ASIO_CALLBACK', message: null },
  limiting: true, clipping: true, clipping_now: false, peak_level: 3.2, gate_trip_count: 0,
  listen_mode: false, mode_layout: { num_modes: 196, flat_tier: null },
  output_scale: { value: 3.46e16, calibrated: true, stale: true, settings_match: false, target_dbfs: -27.91 },
};
const LOAD = {
  loaded: true, path: 'presets/F15_measured_plywood_2026-10-15.json',
  settings: { string_iterations: 8, sound_derivative_order: 2, array_size: 512 },
  declared: { string_iteration: 16, sound_derivative_order: 1 },
  mismatches: [{ param: 'string_iterations', required: 16, requested: 8 }, { param: 'sound_derivative_order', required: 1, requested: 2 }],
};
const UI = { ok: true, result: { leader: true, layout: { first: 'Strings', second: 'Modes' }, panes: ['Strings'], selection: { mode: 442, modes: [442, 461] } } };

test('audio: requested == active with occurred false is NOT a fallback', () => {
  const a = audioDigest(HEALTH);
  assert.deepEqual(a, { driver_active: true, requested: 'ASIO_CALLBACK', active: 'ASIO_CALLBACK', fallback: false });
  const fb = audioDigest({ ...HEALTH, audio_driver_fallback: { occurred: true, requested: 'ASIO_CALLBACK', active: 'SDL3', message: 'ASIO_CALLBACK unavailable - using SDL3' } });
  assert.equal(fb.fallback, true);
  assert.equal(fb.fallback_reason, 'ASIO_CALLBACK unavailable - using SDL3');
});

test('digest: the user session state raises clipping, stale level, load mismatch, stale selection; no fallback', () => {
  const d = buildDigest({ health: HEALTH, runtime: { volume_level: 36, deck_feedback_coefficient: 1 }, load: LOAD, presets: { active: 'F15 (working 1)', presets: [] }, jobs: {}, ui: UI });
  const w = d.warnings.join('\n');
  assert.match(w, /CLIPPED/);
  assert.match(w, /STALE/);
  assert.match(w, /string_iterations 8 \(preset: 16\)/);
  assert.match(w, /sound_derivative_order 2 \(preset: 1\)/);
  assert.match(w, /mode selection \(442, 442, 461\) is outside this preset's modes 0-195/);
  assert.doesNotMatch(w, /fell back/);
  assert.equal(d.layout.listen_to_modes, 0);
  assert.match(d.layout.channel_mute_mask, /feedback_mask/);
  assert.equal(d.level.volume_level, 36);
  assert.equal(d.ui.layout, undefined);          // the tree is left to ui.snapshot
  assert.deepEqual(d.ui.panes, ['Strings']);
});

test('digest: a healthy normal state has no warnings', () => {
  const h = { ...HEALTH, limiting: false, clipping: false, peak_level: 0.3, output_scale: { ...HEALTH.output_scale, stale: false, settings_match: true } };
  const d = buildDigest({ health: h, runtime: { volume_level: 64, deck_feedback_coefficient: 1 }, load: { ...LOAD, mismatches: [] }, presets: {}, jobs: {}, ui: { ok: true, result: { selection: { mode: 3 } } } });
  assert.deepEqual(d.warnings, []);
});

test('digest: unreachable backend / limiter only / gate trips / no driver', () => {
  assert.match(buildDigest({ health: { unreachable: true }, ui: {} }).warnings[0], /not reachable/);
  const lim = buildDigest({ health: { ...HEALTH, clipping: false, peak_level: 0.9, output_scale: null }, runtime: {}, load: null, ui: {} });
  assert.match(lim.warnings.join(), /Telemetry only: nothing is attenuated/);
  const g = buildDigest({ health: { ...HEALTH, clipping: false, limiting: false, gate_trip_count: 4, lifecycle: { audio_driver_active: false }, output_scale: null }, ui: {} });
  assert.match(g.warnings.join(), /crash guard tripped 4 times/);
  assert.match(g.warnings.join(), /No audio driver is active/);
});

test('render results: audio and samples replaced by per-series stats', () => {
  const res = {
    ok: true, status: 200,
    result: { audio_data: ['UklGRiR3...'], chart_headers: ['Generated Sound (Channel 0)'], data: [[0, 0, 0.5, -1, 0.25]], text_fields: { 'Generated Sound Max': '0.000000' } },
  };
  const out = shapeResult({ family: 'render' }, res);
  assert.match(out.result.audio_data, /omitted/);
  assert.equal(out.result.data, undefined);
  assert.deepEqual(out.result.series[0].name, 'Generated Sound (Channel 0)');
  assert.equal(out.result.series[0].peak_abs, 1);
  assert.equal(out.result.series[0].all_zero, false);
  assert.equal(out.result.text_fields['Generated Sound Max'], '0.000000');
  assert.equal(shapeResult({ family: 'param' }, res), res);          // only renders are shaped
  assert.deepEqual(seriesStats([0, 0]), { samples: 2, peak_abs: 0, rms: 0, all_zero: true, units: 'raw (before output_scale and volume)' });
});

test('activity: parallel tool results are attributed by tool-use id, not to the newest pending call', async () => {
  const { AssistantSession } = await import('../service/session.js');
  const s = new AssistantSession({ paths: {}, config: { model: 'auto' }, commands: [], driverFactory: () => null });
  const a = s.logActivity({ command: 'param.mute_modes', toolUseId: 'tu1', decision: 'allow' });
  const b = s.logActivity({ command: 'ui.select.mode_range', toolUseId: 'tu2', decision: 'allow' });
  s.onEvent({ type: 'tool_result', toolUseId: 'tu1', isError: false, text: 'mute result' });
  s.onEvent({ type: 'tool_result', toolUseId: 'tu2', isError: false, text: 'ui result' });
  assert.equal(a.result, 'mute result');
  assert.equal(b.result, 'ui result');
});

test('compact: long mask rows become on / off ranges; short ones and value rows stay', async () => {
  const { compact, maskSummary } = await import('../mcp/tools.js');
  const row = [1, 1, ...Array(194).fill(0)];
  assert.deepEqual(maskSummary(row), { mask_length: 196, on: '0-1', off: '2-195' });
  assert.deepEqual(compact({ 60: row }), { 60: { mask_length: 196, on: '0-1', off: '2-195' } });
  assert.deepEqual(maskSummary([0, 1, 0, 1, 1]), { mask_length: 5, on: '1, 3-4', off: '0, 2' });
  assert.deepEqual(compact([1, 0, 1]), [1, 0, 1]);
  assert.equal(compact(Array(100).fill(0.5)).length, 65);
});

test('streamed text after tool calls starts a new paragraph', async () => {
  const { AssistantSession } = await import('../service/session.js');
  const s = new AssistantSession({ paths: {}, config: { model: 'auto' }, commands: [], driverFactory: () => null });
  s.currentAssistant = { role: 'assistant', text: '' };
  s.onEvent({ type: 'delta', text: 'Checking.' });
  s.onEvent({ type: 'assistant', toolUses: [{ name: 'mcp__pianoid__play__stats', input: {} }] });
  s.onEvent({ type: 'delta', text: 'I found' });
  s.onEvent({ type: 'delta', text: ' it.' });
  assert.equal(s.currentAssistant.text, 'Checking.\n\nI found it.');
});

test('over full scale: the -72 dB telemetry of the user session is hard clipping, never silence', () => {
  const h = {
    ...HEALTH, clipping: true, peak_level: 4037,
    limiting_info: { gain_reduction_db: -72.1, peak: 8.67e12, channel: 0 },
    limiter: { channels: [{ channel: 0, gain_reduction_db: -71.9 }] },
  };
  const d = buildDigest({ health: h, runtime: {}, load: LOAD, ui: {} });
  assert.deepEqual(d.level.over_full_scale, { peak_x_full_scale: 4040, db_over: 72.1, channel: 0 });
  const w = d.warnings.join('\n');
  assert.match(w, /far above full scale .* hard-clips at the INT32 rail: harsh distortion/);
  assert.doesNotMatch(w, /silen|mute/i);
  const below = buildDigest({ health: { ...HEALTH, clipping: false, limiting_info: { gain_reduction_db: -1.2, peak: 1.9e9, channel: 3 } }, ui: {} });
  assert.equal(below.level.over_full_scale, null);
  assert.match(below.warnings.join('\n'), /Telemetry only: nothing is attenuated/);
});

test('channels: all feedback_mask output rows 0 (the measured completely-mute cause) is the first-class warning', () => {
  const zero = Array(196).fill(0);
  const one = Array(196).fill(1);
  const allMuted = Object.fromEntries([128, 129, 130].map((p) => [String(p), zero]));
  const d = buildDigest({ health: { ...HEALTH, limiting: false, clipping: false }, load: LOAD, ui: {}, outputMask: allMuted });
  assert.deepEqual(d.layout.channels_on, []);
  assert.match(d.warnings.join('\n'), /EVERY output channel is muted/);
  const some = buildDigest({ health: { ...HEALTH, limiting: false, clipping: false }, ui: {}, outputMask: { 128: one, 129: zero, 130: one } });
  assert.deepEqual(some.layout.channels_muted, [1]);
  assert.match(some.warnings.join('\n'), /Muted output channels: 1/);
  const modesAxis = buildDigest({ health: { ...HEALTH, listen_mode: true }, ui: {}, outputMask: allMuted });
  assert.equal(modesAxis.layout.channels_on, undefined);
});

test('R6 (dev-947d): with live audio the stop/render/restart renders ask, reads never, any other render is denied', async () => {
  const { decide, LIVE_RENDER_REASON, LIVE_RENDER_CONFIRM, LIVE_RENDERS } = await import('../policy.js');
  const live = { liveAudio: true };
  for (const command of LIVE_RENDERS) {
    assert.deepEqual(decide({ command, tier: 'act', family: 'render', category: 'renders', settings: live }),
      { action: 'confirm', canAuto: true, category: 'renders_live', reason: LIVE_RENDER_CONFIRM });
  }
  // reads are never gated (the transcript's render.chart_types refusal)
  assert.equal(decide({ command: 'render.chart_types', tier: 'read', family: 'render', category: 'view', settings: live }).action, 'allow');
  // a render that does not stop / restart the engine (e.g. an output_scale calibration render) stays blocked
  assert.deepEqual(decide({ command: 'render.recalibrate_output_level', tier: 'act', family: 'render', category: 'renders', settings: live }), { action: 'deny', reason: LIVE_RENDER_REASON });
  // renders Auto does not skip the live-audio confirm; a web-tainted turn makes it hard
  const auto = { ...live, approvals: { installation: { renders: 'auto' } } };
  assert.equal(decide({ command: 'render.note_playback', tier: 'act', family: 'render', category: 'renders', settings: auto }).action, 'confirm');
  assert.equal(decide({ command: 'render.note_playback', tier: 'act', family: 'render', category: 'renders', settings: { ...live, tainted: true } }).hard, true);
  assert.equal(decide({ command: 'render.note_playback', tier: 'act', family: 'render', category: 'renders', settings: {} }).action, 'allow');
  assert.equal(decide({ command: 'play.note', tier: 'act', family: 'playback', category: 'playback', settings: live }).action, 'allow');
  // dev-auto1: renders_live Auto skips the live-audio confirm (renders then decides); tainted / non-LIVE_RENDERS unchanged
  const liveAuto = { ...live, approvals: { installation: { renders_live: 'auto' } } };
  assert.deepEqual(decide({ command: 'render.note_playback', tier: 'act', family: 'render', category: 'renders', settings: liveAuto }),
    { action: 'allow', auto: true, reason: 'renders: Auto' });
  assert.equal(decide({ command: 'render.note_playback', tier: 'act', family: 'render', category: 'renders',
    settings: { ...liveAuto, approvals: { installation: { renders_live: 'auto', renders: 'ask' } } } }).reason, 'renders: Ask');
  assert.equal(decide({ command: 'render.note_playback', tier: 'act', family: 'render', category: 'renders', settings: { ...liveAuto, tainted: true } }).hard, true);
  assert.equal(decide({ command: 'render.recalibrate_output_level', tier: 'act', family: 'render', category: 'renders', settings: liveAuto }).action, 'deny');

  const { AssistantSession } = await import('../service/session.js');
  const cmds = [
    { name: 'render.note_playback', tier: 'act', family: 'render', approval_category: 'renders' },
    { name: 'render.chart_types', tier: 'read', family: 'render', approval_category: 'view' },
  ];
  const make = (routes, answer) => {
    const confirms = [];
    const s = new AssistantSession({
      paths: {}, config: { model: 'auto' }, commands: cmds, driverFactory: () => null,
      broadcast: (m) => { if (m.type === 'confirm') { confirms.push(m); setImmediate(() => s.confirm(m.id, answer)); } },
      fetchImpl: async (url) => {
        const r = Object.entries(routes).find(([k]) => url.endsWith(k));
        if (!r) throw new Error('down');
        return { json: async () => r[1] };
      },
    });
    return { s, confirms };
  };
  const LIVE = { '/health': { pianoid_loaded: true, backend_thread_running: true }, '/load_settings': { settings: { audio_on: 1 } } };
  const yes = make(LIVE, true);
  assert.equal((await yes.s.canUseTool('mcp__pianoid__render__note_playback', { pitch: 60 }, { toolUseID: 't' })).behavior, 'allow');
  assert.equal(yes.confirms.length, 1);
  assert.match(yes.confirms[0].reason, /live audio pauses/);
  assert.deepEqual([yes.confirms[0].canAuto, yes.confirms[0].category], [true, 'renders_live']);
  const no = make(LIVE, false);
  assert.equal((await no.s.canUseTool('mcp__pianoid__render__note_playback', { pitch: 60 }, {})).behavior, 'deny');
  assert.equal((await make(LIVE, false).s.canUseTool('mcp__pianoid__render__chart_types', {}, {})).behavior, 'allow');
  const off = make({ ...LIVE, '/load_settings': { settings: { audio_on: 0 } } }, false);
  assert.equal((await off.s.canUseTool('mcp__pianoid__render__note_playback', {}, {})).behavior, 'allow');
  assert.equal(off.confirms.length, 0);
  // backend unreachable counts as live: the render asks (fail closed), the read still runs
  const down = make({}, false);
  assert.equal((await down.s.canUseTool('mcp__pianoid__render__note_playback', {}, {})).behavior, 'deny');
  assert.equal(down.confirms.length, 1);
  assert.equal((await down.s.canUseTool('mcp__pianoid__render__chart_types', {}, {})).behavior, 'allow');

  // dev-auto1: "Don't ask again" on the live-render confirm switches renders_live (not renders) and persists per installation
  const fsMod = await import('node:fs');
  const osMod = await import('node:os');
  const pathMod = await import('node:path');
  const root = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'pianoid-liverender-'));
  const confirms = [];
  const s = new AssistantSession({
    paths: { root, config: pathMod.join(root, 'config.json') }, config: { model: 'auto' }, commands: cmds, driverFactory: () => null,
    broadcast: (m) => { if (m.type === 'confirm') { confirms.push(m); setImmediate(() => s.confirm(m.id, true, 'installation')); } },
    fetchImpl: async (url) => ({ json: async () => LIVE[Object.keys(LIVE).find((k) => url.endsWith(k))] }),
  });
  assert.equal((await s.canUseTool('mcp__pianoid__render__note_playback', { pitch: 60 }, { toolUseID: 'a' })).behavior, 'allow');
  assert.equal(JSON.parse(fsMod.readFileSync(pathMod.join(root, 'config.json'), 'utf8')).approvals.renders_live, 'auto');
  assert.equal((await s.canUseTool('mcp__pianoid__render__note_playback', { pitch: 61 }, { toolUseID: 'b' })).behavior, 'allow');
  assert.equal(confirms.length, 1);                                    // the second live render did not ask
  assert.equal(s.activity.findLast((a) => a.command === 'render.note_playback').decision, 'auto');
});

test('environment fingerprint (v2 P1): GPU, build, repos, output map; absent when unreachable', () => {
  const environment = { gpu: { gpus: [{ name: 'RTX' }] }, fingerprint: { gpu: 'RTX', build: 'release', repos: { core: 'dev@abc1234*' }, output_map: '8,9' } };
  const d = buildDigest({ health: { status: 'healthy', pianoid_loaded: true }, environment });
  assert.deepEqual(d.environment, { gpu: 'RTX', build: 'release', repos: { core: 'dev@abc1234*' }, output_map: '8,9' });
  assert.equal(buildDigest({ health: { status: 'healthy' }, environment: { unreachable: true } }).environment, null);
  assert.equal(buildDigest({ health: { unreachable: true } }).environment, null);
});

// dev-f8f9 (bug report 2026-10-18T10-23-10): /health clipping_now / peak_level_now are the CURRENT
// output, clipping / peak_level the latched hold; the digest carries both and the clipping warning
// says when the held peak is not current.
test('level: current vs latched clipping', () => {
  const held = buildDigest({ health: { ...HEALTH, clipping: true, clipping_now: false, peak_level: 3.2, peak_level_now: 0.01 }, runtime: {}, load: null, ui: {} });
  assert.equal(held.level.peak_level_now, 0.01);
  assert.equal(held.level.clipping_now, false);
  assert.ok(held.warnings.some((w) => /CLIPPED since the last load.*Not clipping now \(current peak -40\.0 dBFS\)/.test(w)));
  const live = buildDigest({ health: { ...HEALTH, clipping: true, clipping_now: true, peak_level: 3.2, peak_level_now: 3.2 }, runtime: {}, load: null, ui: {} });
  assert.ok(live.warnings.some((w) => /CLIPPED/.test(w) && !/Not clipping now/.test(w)));
});

// dev-b21b: the leader tab's ACTIVE context (ui.snapshot `active`) reaches the model unchanged, so
// "raise this a bit" resolves to the active parameter at the active pitch / mode / channel.
test('ui: the active context passes through the digest (read-only)', () => {
  const active = {
    parameter: { groupe: 'Feedin', name: 'coefficient' }, pitch: 60, mode: 3, channel: null,
    step: 0.01, step_locked: true, follow_midi: false, value: 0.42,
  };
  const d = buildDigest({ health: HEALTH, runtime: {}, load: null, ui: { ok: true, result: { leader: true, layout: 'Feedin', selection: { mode: 3 }, active } } });
  assert.deepEqual(d.ui.active, active);
  assert.equal(d.ui.layout, undefined);
});
