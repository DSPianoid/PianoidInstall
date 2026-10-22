/**
 * Plan pre-approval of the assistant (dev-28f1; ON by default since dev-28f2, user approval 2026-10-22). Pure.
 * Kill-switch: PIANOID_ASSISTANT_PLAN_APPROVAL=0 (or false / off / no) in the service's environment turns it
 * off; then nothing here is reached and the service is the pre-feature one.
 *
 * The assistant may only REQUEST a plan approval (validateRequest): plan steps plus an envelope
 * (commands, max level dBFS, output / input channels, max total drive time, allowed folders, expiry).
 * Only the user's click in the pane creates a grant (createGrant, called from the WS handler for a
 * pending request id); the assistant can never create, widen or extend one. A hard-confirm command
 * (policy.js HARD_CONFIRM / category hard_confirm: rig drives, preset writes, ...) is in the grant ONLY
 * when the user ticked it; unticked it still asks. Irreversible ones (overwrite / delete / external
 * filing) are flagged in the dialog and are never pre-ticked.
 *
 *   validateRequest(req, byName)          -> {ok, request?, error?}
 *   createGrant(request, {ticked, now})   -> grant
 *   matchGrant(grant, {cmd, input, now})  -> {ok, reason, ticked?, driveS?}
 *   recordUse(grant, {command, driveS, now}) -> grant (new object)
 *   describeGrant(grant, now)             -> the pane's view
 *   planState(grant, ended, now)          -> the model's per-turn view (context plan_approval)
 *
 * Fail closed: a value the matcher cannot read (an unknown level default, a drive time it cannot
 * compute, a path outside the folders) is OUTSIDE the envelope, so the step asks as before.
 */
export const FLAG = 'PIANOID_ASSISTANT_PLAN_APPROVAL';
const OFF_VALUES = new Set(['0', 'false', 'off', 'no']);
/** ON unless the kill-switch is set: absent / empty / any other value = on. */
export const enabled = (env = process.env) => !OFF_VALUES.has(String(env?.[FLAG] ?? '').trim().toLowerCase());

export const LEVEL_CAP_DBFS = -24;            // the policy cap (rig schemas, prompt); a plan never raises it
export const MAX_EXPIRY_MIN = 120;
export const MAX_DRIVE_S = 3600;
const MAX_STEPS = 30;
const MAX_COMMANDS = 30;

/** Irreversible: never pre-ticked, shown with a warning. Names that do not exist yet are pinned too. */
export const IRREVERSIBLE = {
  'preset.save': 'saves over a preset file',
  'preset.promote': 'overwrites the original preset JSON',
  'preset.unload': 'unloads a library entry (unsaved edits are lost)',
  'modal.apply_to_preset': 'writes measured modes into the preset',
  'calibration.synthesis': 'rewrites the levels',
  'calibration.acoustic': 'rewrites hammer_mass',
  'calibration.attack_equalize': 'rewrites hammer_mass of every key',
};
const IRREVERSIBLE_RE = /(^|[._])(delete|remove|purge|erase|github|external)/i;
export const isIrreversible = (name) => !!IRREVERSIBLE[name] || IRREVERSIBLE_RE.test(name);
/** Never in a plan: analysis code (its own confirm, V1), and what is never available. */
const NOT_PLANNABLE_CATEGORIES = new Set(['code', 'excluded']);

const DRIVE = new Set(['modal.rig_capture', 'modal.rig_sine']);
const NEEDS_INPUTS = new Set(['modal.rig_capture', 'modal.rig_record']);

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const chan = (c) => String(c).trim().toLowerCase();
const prop = (schema, key) => schema?.properties?.[key];
const def = (schema) => schema?.default;
const isHard = (cmd) => cmd?.approval_category === 'hard_confirm';

/** A folder normalized for the prefix compare (null for a path with a `..` segment). */
export function normFolder(p) {
  if (typeof p !== 'string' || !p.trim()) return null;
  const s = p.trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '').toLowerCase();
  return s.split('/').includes('..') ? null : s;
}
const inFolder = (f, allowed) => allowed.some((a) => f === a || f.startsWith(`${a}/`));

// ---- the request (from the assistant) -------------------------------------------------------

/** Validate the assistant's request against the registry. Never creates anything. */
export function validateRequest(req, byName) {
  const bad = (error) => ({ ok: false, error });
  if (!req || typeof req !== 'object') return bad('the request must be an object');
  const steps = arr(req.steps).map((s) => String(s ?? '').trim()).filter(Boolean);
  if (!steps.length || steps.length > MAX_STEPS) return bad(`steps: 1..${MAX_STEPS} plan steps`);
  if (steps.some((s) => s.length > 300)) return bad('steps: at most 300 characters each');
  const names = [...new Set(arr(req.commands).map(String))];
  if (!names.length || names.length > MAX_COMMANDS) return bad(`commands: 1..${MAX_COMMANDS} command names`);
  const get = (n) => (byName instanceof Map ? byName.get(n) : byName?.[n]);
  for (const n of names) {
    const c = get(n);
    if (!c) return bad(`unknown command ${n}`);
    if (c.tier === 'excluded' || NOT_PLANNABLE_CATEGORIES.has(c.approval_category)) return bad(`${n} cannot be in a plan`);
  }
  const lvl = req.max_level_dbfs;
  const drives = names.some((n) => DRIVE.has(n));
  if (lvl !== undefined && lvl !== null && (!isNum(lvl) || lvl > LEVEL_CAP_DBFS || lvl < -90)) {
    return bad(`max_level_dbfs must be a number -90..${LEVEL_CAP_DBFS} (the policy cap)`);
  }
  const drive = req.max_drive_s;
  if (drive !== undefined && drive !== null && (!isNum(drive) || drive < 0 || drive > MAX_DRIVE_S)) {
    return bad(`max_drive_s must be 0..${MAX_DRIVE_S}`);
  }
  if (drives && (!isNum(lvl) || !isNum(drive) || !arr(req.output_channels).length)) {
    return bad('a plan that drives the rig needs max_level_dbfs, max_drive_s and output_channels');
  }
  if (names.some((n) => NEEDS_INPUTS.has(n)) && !arr(req.input_channels).length) {
    return bad('a plan that records needs input_channels');
  }
  const folders = arr(req.folders).map(normFolder);
  if (folders.includes(null)) return bad('folders: non-empty paths without ".."');
  const exp = req.expires_in_min;
  if (!isNum(exp) || exp <= 0 || exp > MAX_EXPIRY_MIN) return bad(`expires_in_min must be 1..${MAX_EXPIRY_MIN}`);
  const commands = names.map((n) => {
    const c = get(n);
    return { name: n, title: c.title || n, hard: isHard(c), irreversible: isIrreversible(n), why: IRREVERSIBLE[n] || null };
  });
  return {
    ok: true,
    request: {
      title: String(req.title ?? 'Plan').slice(0, 120),
      steps,
      commands,
      envelope: {
        maxLevelDbfs: isNum(lvl) ? lvl : null,
        outputs: arr(req.output_channels).map(chan),
        inputs: arr(req.input_channels).map(chan),
        maxDriveS: isNum(drive) ? drive : 0,
        folders,
        expiresInMin: exp,
      },
    },
  };
}

// ---- the grant (from the user's click) ------------------------------------------------------

let seq = 0;

/**
 * The grant the user approved. `ticked` = the hard-confirm commands the user explicitly ticked;
 * a hard-confirm command not ticked is left out (it asks). Non-hard commands are in as requested.
 */
export function createGrant(request, { ticked = [], now = Date.now() } = {}) {
  const tick = new Set(arr(ticked).map(String));
  const commands = request.commands.filter((c) => !c.hard || tick.has(c.name)).map((c) => c.name);
  const hardTicked = request.commands.filter((c) => c.hard && tick.has(c.name)).map((c) => c.name);
  seq += 1;
  return {
    id: `plan${now.toString(36)}${seq}`,
    title: request.title,
    steps: [...request.steps],
    commands,
    hardTicked,
    envelope: { ...request.envelope, outputs: [...request.envelope.outputs], inputs: [...request.envelope.inputs], folders: [...request.envelope.folders] },
    createdAt: now,
    expiresAt: now + request.envelope.expiresInMin * 60000,
    driveUsedS: 0,
    log: [],
    revoked: false,
  };
}

/** Levels (dBFS), output / input channels, drive seconds and write folders of one call. */
export function footprint(cmd, input = {}) {
  const a = cmd.args;
  const fp = { levels: [], outputs: [], inputs: [], driveS: 0, folders: [] };
  const dry = input.dry_run === true;
  if (cmd.name === 'modal.rig_capture') {
    const exItem = prop(a, 'exciters')?.items;
    const lvlDef = def(prop(exItem, 'level_dbfs'));
    for (const e of arr(input.exciters)) {
      fp.levels.push(e?.level_dbfs ?? lvlDef);
      fp.outputs.push(e?.output);
    }
    fp.inputs = arr(input.inputs).map((i) => i?.input);
    if (input.loopback) {
      fp.outputs.push(input.loopback.output);
      if (input.loopback.input !== undefined) fp.inputs.push(input.loopback.input);
      fp.levels.push(input.loopback.level_dbfs ?? def(prop(prop(a, 'loopback'), 'level_dbfs')));
    }
    const repeats = input.timing?.repeats ?? def(prop(prop(a, 'timing'), 'repeats'));
    const dur = input.sweep?.duration_s ?? def(prop(prop(a, 'sweep'), 'duration_s'));
    fp.driveS = dry ? 0 : (isNum(repeats) && isNum(dur) ? arr(input.exciters).length * repeats * dur : null);
    if (!dry) fp.folders.push('rig_runs');
  } else if (cmd.name === 'modal.rig_sine') {
    const outItem = prop(a, 'outputs')?.items;
    const lvlDef = def(prop(outItem, 'level_dbfs'));
    const steps = arr(input.sequence);
    const outs = [...arr(input.outputs), ...steps.flatMap((s) => arr(s?.outputs))];
    for (const o of outs) {
      fp.levels.push(o?.level_dbfs ?? lvlDef);
      fp.outputs.push(o?.output);
    }
    fp.inputs = arr(input.record_inputs).map((i) => i?.input);
    const durDef = input.duration_s ?? def(prop(a, 'duration_s'));
    let drive;
    if (steps.length) drive = steps.reduce((t, s) => t + (s?.duration_s ?? durDef), 0);
    else if (input.until_stopped === true) drive = input.max_duration_s ?? def(prop(a, 'max_duration_s'));
    else drive = durDef;
    fp.driveS = dry ? 0 : (isNum(drive) ? drive : null);
    if (!dry) fp.folders.push('rig_runs');
  } else if (cmd.name === 'modal.rig_record') {
    fp.inputs = arr(input.inputs).map((i) => i?.input);
    if (input.trigger?.input !== undefined) fp.inputs.push(input.trigger.input);
    if (input.dry_run !== true) fp.folders.push('rig_runs');
  } else if (cmd.name === 'modal.rig_process') {
    fp.folders.push(`${input.area ?? def(prop(a, 'area')) ?? 'rig_runs'}/${input.run}`);
  } else if (cmd.name === 'preset.create') {
    fp.folders.push(`presets/${input.name}`);
  } else if (cmd.name === 'preset.save' || cmd.name === 'modal.set_measurements_dir') {
    fp.folders.push(input.path);
  }
  return fp;
}

const out = (reason) => ({ ok: false, reason: `outside the plan approval: ${reason}` });

/** Is one call inside the active grant? (The policy still decides: policy.js `settings.plan`.) */
export function matchGrant(grant, { cmd, input = {}, now = Date.now() } = {}) {
  if (!grant) return out('no active plan approval');
  if (grant.revoked) return out('the plan approval was revoked');
  if (now >= grant.expiresAt) return out('the plan approval expired');
  if (!cmd || !grant.commands.includes(cmd.name)) return out(`${cmd?.name} is not in the approved plan`);
  if (NOT_PLANNABLE_CATEGORIES.has(cmd.approval_category) || cmd.tier === 'excluded') return out(`${cmd.name} cannot be in a plan`);
  const env = grant.envelope;
  const fp = footprint(cmd, input);
  for (const l of fp.levels) {
    if (!isNum(l)) return out('a level is unknown');
    if (env.maxLevelDbfs === null || l > env.maxLevelDbfs || l > LEVEL_CAP_DBFS) {
      return out(`level ${l} dBFS > ${env.maxLevelDbfs ?? 'none'} dBFS`);
    }
  }
  for (const o of fp.outputs) {
    if (o === undefined || o === null || !env.outputs.includes(chan(o))) return out(`output ${o} is not an approved output channel`);
  }
  for (const i of fp.inputs) {
    if (i === undefined || i === null || !env.inputs.includes(chan(i))) return out(`input ${i} is not an approved input channel`);
  }
  if (fp.driveS === null) return out('the drive time cannot be computed');
  if (fp.driveS > 0 && grant.driveUsedS + fp.driveS > env.maxDriveS) {
    return out(`drive ${fp.driveS} s + ${grant.driveUsedS} s used > ${env.maxDriveS} s approved`);
  }
  for (const f of fp.folders) {
    const n = normFolder(typeof f === 'string' ? f : '');
    if (!n || !inFolder(n, env.folders)) return out(`folder ${f} is not an approved folder`);
  }
  const ticked = grant.hardTicked.includes(cmd.name);
  return {
    ok: true, ticked, driveS: fp.driveS, grantId: grant.id,
    reason: `plan approval "${grant.title}": inside the approved envelope${fp.driveS ? ` (drive ${grant.driveUsedS + fp.driveS} of ${env.maxDriveS} s)` : ''}`,
  };
}

/** The grant after one auto-approved step (a new object; the log is kept, capped). */
export function recordUse(grant, { command, driveS = 0, now = Date.now(), activityId = null }) {
  const log = [...grant.log, { at: now, command, driveS, activityId }].slice(-200);
  return { ...grant, driveUsedS: grant.driveUsedS + (driveS || 0), log };
}

/** "less than a minute ago" / "3 min ago" for an end time (the model's wording of a revoke / expiry). */
export function agoText(at, now = Date.now()) {
  const min = Math.floor(Math.max(0, now - at) / 60000);
  return min < 1 ? 'less than a minute ago' : `${min} min ago`;
}

/** The confirm-reason note for a step after the plan ended (`ended` = {title, how: revoked | expired, at}). */
export const endedReason = (ended, now = Date.now()) => out(`the plan "${ended.title}" ${ended.how === 'expired' ? 'expired' : 'was revoked'} ${agoText(ended.at, now)}`).reason;

/**
 * The model's per-turn view (context plan_approval): none / active with the envelope and the minutes
 * left / revoked or expired with when. `ended` is the last plan that ended (null = none).
 */
export function planState(grant, ended = null, now = Date.now()) {
  if (grant && !grant.revoked && now < grant.expiresAt) {
    const e = grant.envelope;
    return {
      state: 'active', title: grant.title, commands: grant.commands, hard_ticked: grant.hardTicked,
      max_level_dbfs: e.maxLevelDbfs, outputs: e.outputs, inputs: e.inputs, folders: e.folders,
      drive_used_s: grant.driveUsedS, max_drive_s: e.maxDriveS, uses: grant.log.length,
      remaining_min: Math.ceil((grant.expiresAt - now) / 60000),
    };
  }
  if (ended) return { state: ended.how, title: ended.title, at: new Date(ended.at).toISOString(), ago: agoText(ended.at, now) };
  return { state: 'none' };
}

/** The pane's view of the grant (null = none / inactive). */
export function describeGrant(grant, now = Date.now()) {
  if (!grant || grant.revoked || now >= grant.expiresAt) return null;
  return {
    id: grant.id, title: grant.title, steps: grant.steps, commands: grant.commands, hardTicked: grant.hardTicked,
    envelope: grant.envelope, createdAt: grant.createdAt, expiresAt: grant.expiresAt,
    remainingS: Math.max(0, Math.round((grant.expiresAt - now) / 1000)), driveUsedS: grant.driveUsedS, uses: grant.log.length,
    log: grant.log.slice(-20),
  };
}
