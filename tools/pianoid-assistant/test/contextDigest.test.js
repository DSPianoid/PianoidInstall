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
  assert.match(lim.warnings.join(), /limiter engaged/);
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
