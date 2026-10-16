/**
 * The per-turn <pianoid_context> digest (dev-0a88). Pure: built from the raw /health,
 * /get_runtime_parameters, /load_settings, /preset/list, job.list and ui.snapshot responses.
 *
 * It states the engine facts the 2026-10-16 live session got wrong in plain fields, and adds
 * precomputed `warnings` for the level / audio / load-settings problems the model should raise:
 *  - audio: {requested, active, fallback} — the old digest passed `audio_driver_fallback.active`
 *    alone ("ASIO_CALLBACK"), which the model read as "fell back to ASIO";
 *  - level: clipping / peak / limiter / gate trips / output_scale state / slider level;
 *  - load: the live load settings and the mismatch with what the preset declares;
 *  - layout: num_modes and the listen mode (which mask mutes a channel), and a UI selection that
 *    no longer fits the loaded preset (a stale mode 442 on a 196-mode preset).
 * Field meanings: REST_API.md GET /health, GET /load_settings.
 */

const LIMITER_KNEE_DBFS = -1.94;     // 0.8 of full scale (REST_API.md Layer B / limiter)

const pct = (x) => `${Math.round(x * 1000) / 10}%`;
const dbfs = (x) => (x > 0 ? `${(20 * Math.log10(x)).toFixed(1)} dBFS` : '-inf dBFS');

export function audioDigest(health) {
  const fb = health.audio_driver_fallback;
  const active = health.lifecycle?.audio_driver_active ?? null;
  if (!fb) return { driver_active: active, requested: null, active: null, fallback: false };
  return {
    driver_active: active,
    requested: fb.requested ?? null,
    active: fb.active ?? null,
    fallback: fb.occurred === true,
    ...(fb.occurred ? { fallback_reason: fb.message || fb.reason || null } : {}),
    ...(health.audio_health?.alert ? { alert: health.audio_health.alert.message } : {}),
  };
}

export function levelDigest(health, runtime = {}) {
  const os = health.output_scale && !health.output_scale.error ? health.output_scale : null;
  return {
    clipping: health.clipping ?? null,
    clipping_now: health.clipping_now ?? null,
    peak_level: health.peak_level ?? null,
    limiting: health.limiting ?? null,
    gate_trip_count: health.gate_trip_count ?? null,
    volume_level: runtime.volume_level ?? null,
    feedback: runtime.deck_feedback_coefficient ?? null,
    output_scale: os && {
      value: os.value, calibrated: os.calibrated, stale: os.stale, settings_match: os.settings_match,
      target_dbfs: os.target_dbfs, ...(os.warning ? { warning: os.warning } : {}),
    },
  };
}

export function loadDigest(load) {
  if (!load || !load.loaded) return null;
  return { path: load.path, settings: load.settings, declared: load.declared, mismatches: load.mismatches };
}

/** Plain-language warnings the model must not miss (empty when everything looks normal). */
export function warnings({ backend, audio, level, load, layout, ui }) {
  const w = [];
  if (backend.exception) w.push('The engine reports an exception (status crashed): the backend needs a restart.');
  if (audio.driver_active === false && backend.pianoid_loaded) w.push('No audio driver is active: nothing can be heard.');
  if (audio.fallback) w.push(`Audio fell back from ${audio.requested} to ${audio.active}${audio.fallback_reason ? ` (${audio.fallback_reason})` : ''}.`);
  if (audio.alert) w.push(`Audio watchdog: ${audio.alert}`);
  if (level.clipping) {
    w.push(`Output CLIPPED since the last load: latched peak ${pct(level.peak_level ?? 1)} of full scale (${dbfs(level.peak_level ?? 1)}). The level is far too high; hard clipping and the amplitude guard can make the output distorted or silent.`);
  } else if (level.limiting) {
    w.push(`The limiter engaged since the last load (peaks above ${LIMITER_KNEE_DBFS} dBFS${level.peak_level != null ? `, latched peak ${dbfs(level.peak_level)}` : ''}).`);
  }
  if (level.gate_trip_count > 0) w.push(`The amplitude crash guard tripped ${level.gate_trip_count} times (runaway or NaN displacement; each trip resets the strings, which sounds like silence or clicks).`);
  if (level.output_scale?.stale) {
    w.push(`The preset's output level (output_scale ${level.output_scale.value?.toExponential?.(2) ?? level.output_scale.value}) is STALE${level.output_scale.settings_match === false ? ': it was measured at other load settings than the running ones' : ''}${level.output_scale.warning ? ` (${level.output_scale.warning})` : ''}.`);
  }
  if (load?.mismatches?.length) {
    w.push(`Loaded with settings the preset does not declare: ${load.mismatches.map((m) => `${m.param} ${m.requested} (preset: ${m.required})`).join(', ')}. The sound and level are an approximation; reloading with the declared values is the fix.`);
  }
  if (level.volume_level === 0) w.push('The volume slider is at 0.');
  if (level.feedback === 0) w.push('Deck feedback is 0 (no soundboard coupling).');
  const sel = ui?.selection;
  if (layout?.num_modes != null && sel) {
    const modes = [sel.mode, ...(sel.modes || [])].filter((m) => typeof m === 'number');
    if (modes.some((m) => m >= layout.num_modes)) {
      w.push(`The UI mode selection (${modes.join(', ')}) is outside this preset's modes 0-${layout.num_modes - 1}: ignore it.`);
    }
  }
  return w;
}

/** The whole digest. `raw` = {health, runtime, load, presets, jobs, ui} (unreachable -> {unreachable: true}). */
export function buildDigest(raw) {
  const { health = {}, runtime = {}, load = null, presets = {}, jobs = {}, ui = {} } = raw;
  if (health.unreachable) {
    return { backend: { unreachable: true }, ui: uiDigest(ui), warnings: ['The backend (:5000) is not reachable: no engine is running.'] };
  }
  const backend = {
    status: health.status, pianoid_loaded: health.pianoid_loaded, exception: health.exception,
    message: health.message,
  };
  const audio = audioDigest(health);
  const level = levelDigest(health, runtime.unreachable ? {} : runtime);
  const loadD = loadDigest(load && !load.unreachable ? load : null);
  const layout = health.pianoid_loaded ? {
    num_modes: health.mode_layout?.num_modes ?? null,
    listen_to_modes: health.listen_mode == null ? null : Number(health.listen_mode),
    channel_mute_mask: health.listen_mode ? 'sound_channel_mask (modes axis)' : 'feedback_mask on output pitches 128+ch (strings axis)',
  } : null;
  const uiD = uiDigest(ui);
  const running = (jobs.result?.jobs || []).filter((j) => j.state === 'running').map((j) => ({ id: j.id, name: j.name, pct: j.pct }));
  return {
    backend, audio, level, load: loadD, layout,
    preset: presets.unreachable ? null : { active: presets.active, entries: (presets.presets || []).map((p) => `${p.name} (${p.kind})`) },
    ui: uiD,
    runningJobs: running,
    warnings: warnings({ backend, audio, level, load: loadD, layout, ui: uiD }),
  };
}

/** The leader tab's snapshot without the layout tree (the pane list carries it; ui.snapshot has the tree). */
function uiDigest(ui) {
  if (!ui?.ok) return { unavailable: ui?.error || 'no leader tab' };
  const { layout, ...rest } = ui.result || {};
  return rest;
}
