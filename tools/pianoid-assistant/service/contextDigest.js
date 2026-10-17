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
const FULL_SCALE = 2147483647;       // INT32 full scale: the limiter ceiling / clip rail
// The output is NOT limited: MainKernel.cu (W5-A, dev-excenergy) writes it UNLIMITED and the Sint32 cast
// saturates at the INT32 rail (SYNTHESIS_ENGINE.md "Output-clipping telemetry (dev-538e)"). The /health
// `limiting` / `limiting_info.gain_reduction_db` are host-side TELEMETRY (backendServer._gain_reduction_db
// computes what a limiter would apply from the peak); no stage attenuates. A peak above full scale = hard clipping.

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

/** The worst latched output peak over full scale (telemetry; nothing attenuates it, see above). */
function overFullScale(health) {
  const info = health.limiting_info || health.limiter?.limiting_info;
  if (!info || info.peak == null || info.peak < FULL_SCALE) return null;
  const x = info.peak / FULL_SCALE;
  return { peak_x_full_scale: Number(x.toPrecision(3)), db_over: Math.round(200 * Math.log10(x)) / 10, channel: info.channel };
}

/** Strings axis: channels whose whole feedback_mask output row is 0 (= muted), from GET feedback_mask/output. */
function channelsDigest(outputMask) {
  if (!outputMask || outputMask.unreachable) return {};
  const rows = Object.entries(outputMask).filter(([k, r]) => /^[0-9]+$/.test(k) && Array.isArray(r))
    .sort(([a], [b]) => Number(a) - Number(b));
  if (!rows.length) return {};
  const on = [];
  const muted = [];
  rows.forEach(([, r], ch) => (r.some((v) => Number(v) !== 0) ? on : muted).push(ch));
  return { channels_on: on, channels_muted: muted };
}

export function levelDigest(health, runtime = {}) {
  const os = health.output_scale && !health.output_scale.error ? health.output_scale : null;
  return {
    over_full_scale: overFullScale(health),
    clipping: health.clipping ?? null,
    clipping_now: health.clipping_now ?? null,
    peak_level: health.peak_level ?? null,
    limiting: health.limiting ?? null,
    gate_trip_count: health.gate_trip_count ?? null,
    volume_level: runtime.volume_level ?? null,
    deck_feedback_coefficient: runtime.deck_feedback_coefficient ?? null,
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
  const over = level.over_full_scale;
  if (over) {
    w.push(`Output far above full scale since the last load: worst peak ${over.peak_x_full_scale} x full scale (+${over.db_over} dB) on channel ${over.channel}. The output is not limited, so it hard-clips at the INT32 rail: harsh distortion. Check load.mismatches and output_scale.`);
  } else if (level.clipping) {
    w.push(`Output CLIPPED since the last load: latched peak ${pct(level.peak_level ?? 1)} of full scale. It hard-clips at the INT32 rail (distortion): the level is too high.`);
  } else if (level.limiting) {
    w.push(`Peaks above ${LIMITER_KNEE_DBFS} dBFS (near full scale) since the last load${level.peak_level != null ? `, latched peak ${dbfs(level.peak_level)}` : ''}. Telemetry only: nothing is attenuated.`);
  }
  if (layout?.channels_on && layout.channels_on.length === 0) {
    w.push('EVERY output channel is muted (all feedback_mask rows 128+ are 0): nothing can sound. Unmute with param__mute_channels (channels all, unmute).');
  } else if (layout?.channels_muted?.length) {
    w.push(`Muted output channels: ${layout.channels_muted.join(', ')} (their feedback_mask rows 128+ are all 0).`);
  }
  if (level.gate_trip_count > 0) w.push(`The amplitude crash guard tripped ${level.gate_trip_count} times (runaway or NaN displacement; each trip resets the strings, which sounds like silence or clicks).`);
  if (level.output_scale?.stale) {
    w.push(`The preset's output level (output_scale ${level.output_scale.value?.toExponential?.(2) ?? level.output_scale.value}) is STALE${level.output_scale.settings_match === false ? ': it was measured at other load settings than the running ones' : ''}${level.output_scale.warning ? ` (${level.output_scale.warning})` : ''}.`);
  }
  if (load?.mismatches?.length) {
    w.push(`Loaded with settings the preset does not declare: ${load.mismatches.map((m) => `${m.param} ${m.requested} (preset: ${m.required})`).join(', ')}. The sound and level are an approximation; reloading with the declared values is the fix.`);
  }
  if (level.volume_level === 0) w.push('The volume slider is at 0.');
  if (level.deck_feedback_coefficient === 0) w.push('Deck feedback is 0 (no soundboard coupling).');
  const sel = ui?.selection;
  if (layout?.num_modes != null && sel) {
    const modes = [sel.mode, ...(sel.modes || [])].filter((m) => typeof m === 'number');
    if (modes.some((m) => m >= layout.num_modes)) {
      w.push(`The UI mode selection (${modes.join(', ')}) is outside this preset's modes 0-${layout.num_modes - 1}: ignore it.`);
    }
  }
  return w;
}

/**
 * The environment fingerprint line (v2 P1): GPU, build variant, repo branch@SHA ('*' = dirty), output map,
 * from GET /system/environment `fingerprint`, so the model notices an engine / build change between turns.
 * The full environment is the system__environment tool.
 */
export function environmentDigest(environment) {
  const fp = environment && !environment.unreachable ? environment.fingerprint : null;
  return fp ? { gpu: fp.gpu, build: fp.build, repos: fp.repos, output_map: fp.output_map ?? null } : null;
}

/** The whole digest. `raw` = {health, runtime, load, presets, jobs, ui, outputMask, environment} (unreachable -> {unreachable: true}). */
export function buildDigest(raw) {
  const { health = {}, runtime = {}, load = null, presets = {}, jobs = {}, ui = {}, outputMask = null, environment = null } = raw;
  if (health.unreachable) {
    return { backend: { unreachable: true }, ui: uiDigest(ui), environment: environmentDigest(environment), warnings: ['The backend (:5000) is not reachable: no engine is running.'] };
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
    ...(!health.listen_mode ? channelsDigest(outputMask) : {}),
  } : null;
  const uiD = uiDigest(ui);
  const running = (jobs.result?.jobs || []).filter((j) => j.state === 'running').map((j) => ({ id: j.id, name: j.name, pct: j.pct }));
  return {
    backend, environment: environmentDigest(environment), audio, level, load: loadD, layout,
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
