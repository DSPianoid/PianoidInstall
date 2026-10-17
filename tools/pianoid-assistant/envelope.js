/**
 * The A2 envelope of the assistant's Auto writes (parent proposal §4.3, D3; v2 proposal §9). Pure.
 *
 * The LIMITS are data: the `envelope` entries of schemas/params (lib/paramLimits.js), written from
 * the docs. A write the entries do not cover is OUTSIDE the envelope, so it asks even when its
 * category is Auto (an UNKNOWN limit is never invented here).
 *
 *   readsFor(cmd, input)                  -> the GET paths the check needs (the session reads them)
 *   check({cmd, input, before, limits, autoWrites}) -> {ok, reason}
 *   revertPlan(cmd, input, before)        -> how to undo the write: {kind: 'history'} | {kind: 'runtime', values}
 *   levelBreach(before, after, limits)    -> null | reason   (the post-write level watch)
 */
const MUTE_COMMANDS = new Set(['param.mute_modes', 'param.mute_channels']);

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const listLen = (v) => (Array.isArray(v) ? v.length : 1);
const out = (reason) => ({ ok: false, reason: `outside the envelope: ${reason}` });

/** The GET paths a check needs (`before` is keyed by these paths). */
export function readsFor(cmd, input = {}) {
  if (cmd.name === 'runtime.set') return ['/get_runtime_parameters', '/health'];
  if (cmd.name === 'param.set' && input.parameter === 'mode' && typeof input.key_no === 'string') {
    return [`/get_parameter/mode/${encodeURIComponent(input.key_no)}`];
  }
  return [];
}

function checkMode(input, before, lim) {
  const env = lim.fields['mode.decrement'];
  if (!env) return out('mode has no envelope entry');
  const values = input.values && !Array.isArray(input.values) ? input.values : null;
  if (!values) return out('mode values must be {mode: {decrement}}');
  const keys = Object.keys(values);
  if (!keys.length) return out('no modes given');
  if (keys.length > lim.global.max_keys_per_command) return out(`${keys.length} modes > ${lim.global.max_keys_per_command} per command`);
  const now = before[readsFor({ name: 'param.set' }, input)[0]] || {};
  for (const k of keys) {
    const v = values[k];
    const extra = v && typeof v === 'object' ? Object.keys(v).filter((f) => f !== 'decrement') : ['?'];
    if (extra.length) return out(`mode ${k}: ${extra.join(', ')} has no documented limit (only decrement is in the envelope)`);
    const from = now[k]?.decrement;
    const to = v.decrement;
    if (!isNum(to) || to < env.min) return out(`mode ${k} decrement ${to} (must be a number >= ${env.min})`);
    if (!isNum(from) || from <= 0) return out(`mode ${k}: the current decrement is ${from ?? 'unknown'} (no ratio)`);
    const r = to / from;
    if (r < env.min_step_ratio || r > env.max_step_ratio) {
      return out(`mode ${k} decrement ${from} -> ${to} (x${r.toFixed(2)}; one step allows x${env.min_step_ratio}..x${env.max_step_ratio})`);
    }
  }
  return { ok: true, reason: `mode decrement within x${env.min_step_ratio}..x${env.max_step_ratio} per step` };
}

function checkRuntime(input, before, lim) {
  const fields = Object.keys(input);
  const outside = fields.filter((f) => !lim.fields[`runtime.${f}`]);
  if (!fields.length) return out('no runtime field given');
  if (outside.length) return out(`${outside.join(', ')} has no documented limit`);
  const rt = before['/get_runtime_parameters'] || {};
  const health = before['/health'] || {};
  if ('volume' in input) {
    const env = lim.fields['runtime.volume'];
    const to = input.volume;
    const from = rt.volume_level;
    if (!Number.isInteger(to) || to < env.min || to > env.max) return out(`volume ${to} (an integer ${env.min}..${env.max})`);
    if (!isNum(from)) return out('the current volume level is unknown');
    if (to - from > env.max_up_per_step) return out(`volume ${from} -> ${to} (+${to - from}; at most +${env.max_up_per_step} per step)`);
  }
  if ('feedback_coeff' in input) {
    const env = lim.fields['runtime.feedback_coeff'];
    const to = input.feedback_coeff;
    const from = rt.deck_feedback_coefficient;
    const stored = health.stored_feedback_coeff;
    if (!isNum(to) || to <= 0) return out(`feedback_coeff ${to} (must be > 0)`);
    if (!isNum(from) || from <= 0 || !isNum(stored) || stored <= 0) return out('the current / stored feedback coefficient is unknown');
    const r = to / from;
    if (r > env.max_step_ratio || r < 1 / env.max_step_ratio) {
      return out(`feedback ${from} -> ${to} (x${r.toFixed(2)}; one step allows x${(1 / env.max_step_ratio).toFixed(2)}..x${env.max_step_ratio})`);
    }
    if (to / stored > env.max_multiplier_of_stored) {
      return out(`feedback ${to} = x${(to / stored).toFixed(2)} of the stored ${stored} (at most x${env.max_multiplier_of_stored})`);
    }
  }
  return { ok: true, reason: 'runtime change within the envelope' };
}

function checkMute(cmd, input, lim) {
  if (!lim.masks.has(cmd.name)) return out(`${cmd.name} has no envelope entry`);
  const n = Math.max(listLen(input.pitches ?? 'all'), listLen(input.modes ?? input.channels));
  if (n > lim.global.max_keys_per_command) return out(`${n} keys > ${lim.global.max_keys_per_command} per command`);
  return { ok: true, reason: 'mask switch (mute / solo / unmute) within the envelope' };
}

/** Is one Auto write inside the envelope? */
export function check({ cmd, input = {}, before = {}, limits, autoWrites = 0 }) {
  if (!limits) return out('the envelope limits are not loaded');
  if (autoWrites >= limits.global.max_auto_writes_per_turn) {
    return out(`${autoWrites} automatic writes this turn (at most ${limits.global.max_auto_writes_per_turn})`);
  }
  if (MUTE_COMMANDS.has(cmd.name)) return checkMute(cmd, input, limits);
  if (cmd.name === 'runtime.set') return checkRuntime(input, before, limits);
  if (cmd.name === 'param.set') {
    if (input.parameter === 'mode') return checkMode(input, before, limits);
    return out(`${input.parameter} edits have no documented step limit`);
  }
  return out(`${cmd.name} has no envelope entry`);
}

/** How the service undoes one write: runtime is not in the backend history (REST_API I3: EXEMPT). */
export function revertPlan(cmd, input = {}, before = {}) {
  if (cmd.name !== 'runtime.set') return { kind: 'history' };
  const rt = before['/get_runtime_parameters'] || {};
  const values = {};
  if ('volume' in input && isNum(rt.volume_level)) values.volume = rt.volume_level;
  if ('feedback_coeff' in input && isNum(rt.deck_feedback_coefficient)) values.feedback_coeff = rt.deck_feedback_coefficient;
  return { kind: 'runtime', values };
}

const db = (x) => 20 * Math.log10(x);

/**
 * Did the output level breach after an Auto write? `before` / `after` are /health bodies. Signals
 * (REST_API GET /health, dev-538e): clipping_now; clipping newly latched; the amplitude guard
 * tripped (gate_trip_count grew); the latched peak newly above target + over_target_db (target =
 * output_scale.target_dbfs, default -2 dBFS). An unreadable /health decides nothing (null).
 */
export function levelBreach(before = {}, after = {}, limits) {
  if (!after || after.unreachable || !before || before.unreachable) return null;
  if (after.clipping_now === true) return 'clipping now (a sample at full scale)';
  if (after.clipping === true && before.clipping !== true) return 'the output clipped (latched)';
  if (isNum(after.gate_trip_count) && isNum(before.gate_trip_count) && after.gate_trip_count > before.gate_trip_count) {
    return `the amplitude guard tripped (${after.gate_trip_count - before.gate_trip_count} times)`;
  }
  const over = limits?.global?.level_breach?.over_target_db ?? 3;
  const target = isNum(after.output_scale?.target_dbfs) ? after.output_scale.target_dbfs : -2;
  const limit = 10 ** ((target + over) / 20);
  if (isNum(after.peak_level) && after.peak_level > limit && !(isNum(before.peak_level) && before.peak_level > limit)) {
    return `peak ${db(after.peak_level).toFixed(1)} dBFS above the target ${target} dBFS + ${over} dB`;
  }
  return null;
}
