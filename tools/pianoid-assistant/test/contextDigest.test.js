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
  assert.equal(out.result.series[0].peak_db, 0);
  assert.equal(out.result.text_fields['Generated Sound Max'], '0.000000');
  assert.equal(shapeResult({ family: 'param' }, res), res);          // only renders are shaped
  assert.deepEqual(seriesStats([0, 0]), { samples: 2, peak_abs: 0, rms: 0, peak_db: null, silent: true });
});
