/**
 * The physical gates of the assistant's params / runtime writes (dev-free1, user decision 2026-10-25:
 * "make change parameters free ... volume limited at clipping, string parameters by the Courant criterion"). Pure.
 *
 * There are NO step / ratio / count limits: every synthesis-parameter edit is free. What stays:
 *  - value validity (`check`): a value the engine cannot take (a non-integer or out-of-range volume, a negative
 *    mode decrement) is REJECTED (a tool error, never a prompt). The bounds are data: the `envelope` entries of
 *    schemas/params (lib/paramLimits.js), validity only (min / max / integer);
 *  - the CFL gate (`cflGated` / `cflBreach`): a string-physics write (param.set string) is applied, then the
 *    engine's own CFL flag is read (`/health cfl_redline`, ParameterManager._flag_cfl_indication: worst-string
 *    Courant number coeff_tension - 8*coeff_bending >= CFL_MARGIN (0.99, measured), or max|g| > 1; SYNTHESIS_ENGINE.md
 *    "FDTD Stability (CFL / Courant) Bound"). On a violation the write is undone at once and the model gets a
 *    tool error. Applied-then-checked: the engine has no dry-run route (v3 uploads every edit, the flag is an
 *    indicator), so a prospective check is not available to the assistant;
 *  - the clipping gate (`levelBreach`): after every params / runtime write the output level is watched; on
 *    clipping (or a guard trip / a peak far over the target) the write is reverted automatically.
 *
 *   readsFor(cmd)                         -> the GET paths a revert needs (the session reads them, plus /health)
 *   check({cmd, input, limits})           -> {ok: true, reason} | {ok: false, reject: true, reason}
 *   cflGated(cmd, input)                  -> does the write need the CFL check?
 *   cflBreach(health)                     -> null | reason   (the engine's flag after the write)
 *   revertPlan(cmd, input, before)        -> how to undo the write: {kind: 'history'} | {kind: 'runtime', values}
 *   levelBreach(before, after, limits)    -> null | reason   (the post-write level watch)
 */
const MUTE_COMMANDS = new Set(['param.mute_modes', 'param.mute_channels']);
/** The param.set domains whose values feed the FDTD string coefficients (schemas/params/string.json). */
export const CFL_DOMAINS = new Set(['string']);

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const reject = (reason) => ({ ok: false, reject: true, reason: `rejected: ${reason}` });

/** The GET paths a write needs before it runs (`before` is keyed by these paths; /health is always read). */
export function readsFor(cmd) {
  if (cmd.name === 'runtime.set') return ['/get_runtime_parameters', '/health'];
  return [];
}

/** One value against its validity entry ({min, max, integer}); null = valid. */
function invalid(name, v, env) {
  if (!env) return null;
  if (!isNum(v)) return `${name} ${v} is not a number`;
  if (env.integer && !Number.isInteger(v)) return `${name} ${v} must be an integer`;
  if (isNum(env.min) && v < env.min) return `${name} ${v} is below ${env.min}`;
  if (isNum(env.max) && v > env.max) return `${name} ${v} is above ${env.max}`;
  return null;
}

function invalidMode(input, lim) {
  const values = input.values && !Array.isArray(input.values) ? input.values : null;
  for (const [k, v] of Object.entries(values || {})) {
    if (!v || typeof v !== 'object') continue;
    for (const [f, x] of Object.entries(v)) {
      const why = invalid(`mode ${k} ${f}`, x, lim.fields[`mode.${f}`]);
      if (why) return why;
    }
  }
  return null;
}

/** Is one params / runtime write valid? Otherwise free: the CFL and clipping gates run after the write. */
export function check({ cmd, input = {}, limits }) {
  if (!limits) return reject('the parameter inventory (schemas/params) is not loaded');
  let why = null;
  if (cmd.name === 'runtime.set') {
    for (const [f, v] of Object.entries(input)) why = why || invalid(f, v, limits.fields[`runtime.${f}`]);
  } else if (cmd.name === 'param.set' && input.parameter === 'mode') {
    why = invalidMode(input, limits);
  }
  if (why) return reject(why);
  if (cflGated(cmd, input)) return { ok: true, reason: 'free edit; CFL checked after the write (undone on a violation), level watched' };
  if (MUTE_COMMANDS.has(cmd.name)) return { ok: true, reason: 'mask switch; level watched' };
  return { ok: true, reason: 'free edit; level watched (reverted on clipping)' };
}

export const cflGated = (cmd, input = {}) => cmd?.name === 'param.set' && CFL_DOMAINS.has(input.parameter);

/**
 * The engine's CFL verdict after a string write: `/health` `cfl_redline` (+ `cfl_redline_info` {pitch, string,
 * amplification, courant?, message}). The flag is the worst offender of the LAST granular string edit, so right
 * after our write it is ours. An unreadable /health fails closed (the write cannot be verified, so it is undone).
 */
export function cflBreach(health) {
  if (!health || health.unreachable || typeof health.cfl_redline !== 'boolean') {
    return 'the CFL state could not be read after the write (GET /health), so the write cannot be verified';
  }
  if (!health.cfl_redline) return null;
  const i = health.cfl_redline_info || {};
  const at = isNum(i.pitch) ? ` at pitch ${i.pitch}${isNum(i.string) ? ` (string ${i.string})` : ''}` : '';
  const c = isNum(i.courant) ? `Courant ${i.courant.toFixed(3)}` : null;
  const g = isNum(i.amplification) ? `|g| ${i.amplification.toFixed(4)}` : null;
  const nums = [c, g].filter(Boolean).join(', ');
  const margin = isNum(i.margin) ? i.margin : 'CFL_MARGIN';
  return `CFL violation${at}${nums ? `: ${nums}` : ''} (stable needs the Courant number coeff_tension - 8*coeff_bending `
    + `< ${margin} and max|g| <= 1)`;
}

/**
 * The runtime fields and where their value-before is read (GET /get_runtime_parameters, /health): runtime is not
 * in the backend history (REST_API I3: EXEMPT), so a revert re-sets the values read before. [path, key, set as].
 */
const RUNTIME_BEFORE = {
  volume: ['/get_runtime_parameters', 'volume_level'],
  feedback: ['/get_runtime_parameters', 'deck_feedback_coefficient', 'feedback_coeff'],
  feedback_coeff: ['/get_runtime_parameters', 'deck_feedback_coefficient'],
  volume_center: ['/get_runtime_parameters', 'volume_center'],
  volume_range: ['/get_runtime_parameters', 'volume_range'],
  store_feedback_coeff: ['/health', 'stored_feedback_coeff'],
};

/** How the service undoes one write. A runtime field whose value-before is unknown cannot be undone (omitted). */
export function revertPlan(cmd, input = {}, before = {}) {
  if (cmd.name !== 'runtime.set') return { kind: 'history' };
  const values = {};
  for (const f of Object.keys(input)) {
    const [path, key, as] = RUNTIME_BEFORE[f] || [];
    const v = path ? before[path]?.[key] : undefined;
    if (isNum(v)) values[as || f] = v;
  }
  return { kind: 'runtime', values };
}

const db = (x) => 20 * Math.log10(x);

/**
 * Did the output level breach after a write? `before` / `after` are /health bodies. Signals
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
