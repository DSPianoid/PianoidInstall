/**
 * Observe mode (dev-tuneskill): the operator tunes in the UI, the assistant watches. The ONE owner of the live step
 * buffer of an observe session (in memory; one session at a time). It reads the backend's state broadcast through a
 * read-only JournalStream and never renders, plays or writes anything: the renders stay with the model through the
 * normal command + approval path, and the described steps are persisted by the library CLI (observe_describe).
 *
 * Edits: every `state_changed` not caused by the assistant itself (source kind `assistant`) becomes an edit
 * {t, domain, key, label, before, after, source}; `after` is the event's stored value of the key, `before` the last
 * value this session saw (the stream or the GET seed of the focus pitches at start), else null = "not observed".
 * Steps are delimited by RENDERS: a step is ready to render after `gap_s` without edits and is SEALED when an
 * offline render starts (engine_busy start of /get_chart_test or /play_keyboard): its after-renders, which are also
 * the next step's before-renders. An edit after the quiet gap but before any render re-opens the step ("merged"); an
 * edit before all of a sealed step's renders ran (pitches x velocities) or while one runs marks that step and the new
 * one "contaminated" (their renders mix two states); a preset load / switch / unload breaks the chain
 * ("preset_changed").
 * Step 0 is the baseline: the focus pitches rendered before the first edit.
 */
import crypto from 'node:crypto';
import { JournalStream, socketUrl } from './journalStream.js';

/** Domains whose keys are pitches (a render of exactly those pitches observes the change); the rest are shared. */
export const PER_PITCH = new Set(['string', 'hammer', 'gauss', 'excitation', 'string_excitation_curves', 'feedin',
  'feedin_mask', 'sound_channel', 'sound_channel_mask', 'string_sound_channel', 'excitation_energy', 'excitation_mode']);
/** Level-only changes: a peak-normalised offline render cannot hear them, so they are not steps (counted, not kept). */
const LEVEL_ONLY = (domain, key) => domain === 'output_level' || (domain === 'runtime' && /^(volume|effective_volume)/.test(key));
export const SEED_DOMAINS = ['string', 'hammer', 'excitation'];
const REPLACING = new Set(['load_full', 'load_structural', 'switch', 'unload']);
const RENDER = /get_chart_test|play_keyboard/;
const MAX_STEPS = 60;
const MAX_EDITS = 200;
const MAX_MS = 4 * 3600 * 1000;

/** The value of `key` in a state_changed `after`: {key: v}, or {field: {key: v}} (excitation_energy). */
export function valueOf(after, key) {
  if (!after || typeof after !== 'object') return undefined;
  if (Object.hasOwn(after, key)) return after[key];
  const nested = Object.entries(after).filter(([, v]) => v && typeof v === 'object' && Object.hasOwn(v, key));
  return nested.length ? Object.fromEntries(nested.map(([f, v]) => [f, v[key]])) : undefined;
}

const short = (v) => (typeof v === 'number' ? Number(v.toPrecision(6)) : v);

/** before -> after in a few words: the changed fields of an object, the changed cells of a row, or a scalar. */
export function diffLabel(before, after) {
  if (after === undefined) return 'values not in the event (more than 16 keys): refetch';
  if (before === undefined || before === null) return `-> ${JSON.stringify(after).slice(0, 120)} (before not observed)`;
  if (Array.isArray(before) && Array.isArray(after)) {
    const idx = after.map((v, i) => i).filter((i) => before[i] !== after[i]);
    const shown = idx.slice(0, 6).map((i) => `[${i}] ${short(before[i])} -> ${short(after[i])}`).join(', ');
    return `${shown}${idx.length > 6 ? ` (+${idx.length - 6} more)` : ''}`;
  }
  if (before && after && typeof before === 'object' && typeof after === 'object') {
    const keys = Object.keys(after).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    return keys.slice(0, 6).map((k) => `${k} ${JSON.stringify(short(before[k]))} -> ${JSON.stringify(short(after[k]))}`).join(', ');
  }
  return `${JSON.stringify(short(before))} -> ${JSON.stringify(short(after))}`;
}

export class TuningObserver {
  constructor({ backendUrl, fetchImpl = fetch, now = Date.now, streamFactory = null }) {
    this.backendUrl = backendUrl;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.streamFactory = streamFactory || ((opts) => new JournalStream({ url: socketUrl(backendUrl), ...opts }).start());
    this.session = null;           // the active session
    this.last = null;              // the last stopped session (for describe / tuning_record after stop)
  }

  /** Start watching. The model then renders the baseline (step 0) of the focus pitches. */
  async start({ operator, pitches, velocities = [95], duration_ms = 3000, gap_s = 6, note = null }) {
    if (this.session) return { ok: false, error: `already observing (${this.session.id}); stop it first` };
    const id = `obs${new Date(this.now()).toISOString().slice(0, 10).replace(/-/g, '')}${crypto.randomBytes(2).toString('hex')}`;
    const s = {
      id, operator, pitches: [...new Set(pitches)], velocities: [...new Set(velocities)], duration_ms, gapMs: gap_s * 1000, note,
      started: this.now(), cache: new Map(), steps: [{ n: 0, status: 'closed', edits: [], flags: [], opened: this.now(), closed: this.now(), renders: 0 }],
      rendering: false, skipped: 0, levelOnly: 0, events: 0, link: 'connecting', seedErrors: [],
    };
    this.session = s;
    await this.seed(s);
    s.stream = this.streamFactory({ onEvent: (name, p) => this.ingest(name, p), onState: (st) => this.linkState(st) });
    return { ok: true, ...this.view() };
  }

  /** The stored values of the focus pitches before any edit, so the first edit of each has a `before`. */
  async seed(s) {
    for (const domain of SEED_DOMAINS) {
      for (const p of s.pitches) {
        try {
          const r = await this.fetchImpl(`${this.backendUrl}/get_parameter/${domain}/${p}`);
          const v = r.ok ? valueOf(await r.json(), String(p)) : undefined;
          if (v !== undefined) s.cache.set(`${domain}:${p}`, v);
          else s.seedErrors.push(`${domain}/${p}: ${r.status}`);
        } catch (e) {
          s.seedErrors.push(`${domain}/${p}: ${e.message}`);
        }
      }
    }
  }

  linkState(st) {
    const s = this.session;
    if (!s) return;
    s.link = st;
    if (st === 'gap') this.flagOpen('journal_gap');
  }

  current() { const s = this.session; return s.steps[s.steps.length - 1]; }

  flagOpen(flag) {
    const step = this.current();
    if (step.n > 0 && !step.flags.includes(flag)) step.flags.push(flag);
  }

  /** One broadcast event (the JournalStream calls this; tests feed recorded events). */
  ingest(name, p = {}) {
    const s = this.session;
    if (!s) return;
    s.events += 1;
    this.tick();
    if (name === 'engine_busy') return this.busy(p);
    if (name === 'preset_changed' && REPLACING.has(p.kind)) {
      this.flagOpen('preset_changed');
      s.cache.clear();
      return undefined;
    }
    if (name === 'domain_invalidated') return this.edit({ domain: p.domain, key: null, label: `${p.domain}: changed (coarse: values not in the event)`, source: p.source?.kind ?? null, ts: p.ts });
    // the hammer / bow choice of a key is session state, but it changes the sound of that key
    if (name !== 'state_changed' && !(name === 'session_changed' && p.domain === 'excitation_mode')) return undefined;
    if (p.source?.kind === 'assistant') { s.skipped += 1; return undefined; }
    for (const key of (p.keys || []).map(String)) {
      if (LEVEL_ONLY(p.domain, key)) { s.levelOnly += 1; continue; }
      const after = valueOf(p.after, key);
      const before = s.cache.get(`${p.domain}:${key}`);
      if (after !== undefined) s.cache.set(`${p.domain}:${key}`, after);
      else s.cache.delete(`${p.domain}:${key}`);
      this.edit({ domain: p.domain, key, label: `${p.domain} [${key}] ${diffLabel(before, after)}`, before: before ?? null, after: after ?? null, source: p.source?.kind ?? null, ts: p.ts });
    }
    return undefined;
  }

  /** A render start seals the current step (its state is what the render hears); the step counts its renders. */
  busy(p) {
    const s = this.session;
    if (!RENDER.test(String(p.reason || ''))) return;
    if (p.phase === 'end') { s.rendering = false; return; }
    s.rendering = true;
    const step = this.current();
    if (!step.sealed) {
      if (step.status === 'open') { step.status = 'closed'; step.closed = this.now(); }
      step.sealed = this.now();
      const plan = step.n === 0 ? { pitches: s.pitches } : this.plan(s, step);
      step.expected = plan.pitches.length * s.velocities.length;
    }
    step.renders = (step.renders || 0) + 1;
  }

  /** Add an edit: a new step after a sealed one (or the baseline), the same (merged) step before its first render. */
  edit(e) {
    const s = this.session;
    let step = this.current();
    if (step.sealed || step.n === 0) {
      if (s.steps.length > MAX_STEPS) return;
      const flags = [];
      if (!step.sealed) flags.push('no_baseline_render');
      else if (step.renders < step.expected || s.rendering) {
        flags.push('contaminated');
        if (!step.flags.includes('contaminated')) step.flags.push('contaminated');
      }
      step = { n: step.n + 1, status: 'open', edits: [], flags, opened: this.now(), closed: null, renders: 0 };
      s.steps.push(step);
    } else if (step.status === 'closed') {
      step.status = 'open';
      step.closed = null;
      if (!step.flags.includes('merged')) step.flags.push('merged');
    }
    if (step.edits.length < MAX_EDITS) step.edits.push({ t: new Date(this.now()).toISOString(), ...e });
    step.last = this.now();
  }

  /** Close the open step after the quiet gap; end a session that runs too long. */
  tick() {
    const s = this.session;
    if (!s) return;
    const step = this.current();
    if (step.status === 'open' && this.now() - step.last >= s.gapMs) {
      step.status = 'closed';
      step.closed = this.now();
    }
  }

  /** What a step needs rendered: its pitches (per-pitch domains), or the focus pitches for a shared change. */
  plan(s, step) {
    const touched = [...new Set(step.edits.filter((e) => PER_PITCH.has(e.domain) && e.key !== null).map((e) => Number(e.key)))].sort((a, b) => a - b);
    const shared = step.edits.some((e) => !PER_PITCH.has(e.domain));
    const pitches = touched.length && touched.length <= 8 && !shared ? touched : [...new Set([...s.pitches, ...touched.slice(0, 8)])].sort((a, b) => a - b);
    const known = new Set([...s.pitches, ...s.steps.filter((x) => x.n > 0 && x.n < step.n).flatMap((x) => this.plan(s, x).pitches)]);
    return { pitches, velocities: s.velocities, duration_ms: s.duration_ms, tags: [`obs-${s.id}`, `step-${step.n}`],
      no_before: pitches.filter((p) => !known.has(p)), shared };
  }

  stepView(s, step) {
    const status = step.sealed ? 'rendered' : step.n === 0 ? 'awaiting_render' : step.status === 'closed' ? 'ready_to_render' : 'open';
    const out = { n: step.n, status, flags: step.flags, renders_seen: step.renders || 0,
      opened: new Date(step.opened).toISOString(), closed: step.closed ? new Date(step.closed).toISOString() : null,
      edits: step.edits.map(({ t, domain, key, label, source }) => ({ t, domain, key, label, source })),
      described: step.described || null };
    if (step.n === 0) return { ...out, render: { pitches: s.pitches, velocities: s.velocities, duration_ms: s.duration_ms, tags: [`obs-${s.id}`, 'step-0'] } };
    return step.status === 'closed' || step.sealed ? { ...out, render: this.plan(s, step) } : out;
  }

  view(s = this.session) {
    if (!s) return { observing: false, last: this.last ? this.last.id : null };
    if (s === this.session) {
      this.tick();
      if (this.now() - s.started > MAX_MS) return this.stop('the 4 h limit');
    }
    return {
      observing: s === this.session, id: s.id, operator: s.operator, pitches: s.pitches, velocities: s.velocities, duration_ms: s.duration_ms,
      started: new Date(s.started).toISOString(), link: s.link, events: s.events, assistant_edits_ignored: s.skipped, level_only_ignored: s.levelOnly,
      seed_errors: s.seedErrors, render_settings: { duration_ms: s.duration_ms, observe: s.id },
      steps: s.steps.map((st) => this.stepView(s, st)),
      todo: s.steps.map((st) => this.todo(s, st)).filter(Boolean),
    };
  }

  /** What the session needs next for a step, in one line (the skill page has the procedure). */
  todo(s, st) {
    const tags = `tags [obs-${s.id}, step-${st.n}]`;
    if (st.n === 0) return st.sealed ? null : `render the baseline now, before the operator edits: each of pitches ${s.pitches.join(', ')} x velocities ${s.velocities.join(', ')}, then samples_add with ${tags}`;
    if (st.flags.includes('contaminated') || st.flags.includes('preset_changed')) return st.described ? null : `step ${st.n} is ${st.flags.join(', ')}: its delta is not trusted; still record the operator's words if they gave any`;
    if (!st.sealed) return st.status === 'open' ? `step ${st.n}: the operator is editing (ready after ${s.gapMs / 1000} s of quiet)` : `render step ${st.n}: pitches ${this.plan(s, st).pitches.join(', ')} x velocities ${s.velocities.join(', ')}, then samples_add with ${tags}; then ask the operator how it came out`;
    return st.described ? null : `observe_describe step ${st.n} with the operator's words`;
  }

  stop(reason = 'stopped') {
    const s = this.session;
    if (!s) return { ok: false, error: 'not observing' };
    s.stream?.close();
    this.tick();
    const open = this.current();
    if (open.status === 'open') { open.status = 'closed'; open.closed = this.now(); }
    this.session = null;
    this.last = s;
    return { ok: true, reason, ...this.view(s), undescribed: s.steps.filter((st) => st.n > 0 && !st.described).map((st) => st.n) };
  }

  /** The session (active or last) a describe / record refers to. */
  find(id) { return [this.session, this.last].find((s) => s && (id === undefined || s.id === id)) || null; }

  step(id, n) {
    const s = this.find(id);
    return s ? { s, step: s.steps.find((x) => x.n === n) || null } : { s: null, step: null };
  }

  /** The steps of a session for a tuning record: the host attaches them, never the model. */
  recordSteps(id) {
    const s = this.find(id);
    return s ? s.steps.filter((st) => st.n > 0).map((st) => ({ n: st.n, flags: st.flags, edits: st.edits.map(({ t, label, source }) => ({ t, label, source })), described: st.described || null })) : null;
  }
}
