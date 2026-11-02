/**
 * The execution side of the assistant's approvals (v2 P2: the A2 envelope, parent proposal §4.3, D3).
 *
 * The MCP server spawned by the service sends every tool call here (`--exec-url`) instead of the
 * backend, so this module is the ONE executor of the assistant's commands:
 *  - permits: canUseTool's policy verdict leaves a permit; a call without one is refused (403);
 *  - grouped undo: every params / runtime write carries its own X-Pianoid-Group
 *    (`assistant-<tag>-t<turn>-w<n>`): one assistant action = one backend undo group (I3);
 *  - the physical gates of every params / runtime write (dev-free1: no step limits): read the values
 *    before (envelope.readsFor) + a /health level baseline; after a string write the engine's CFL flag
 *    (envelope.cflBreach) -> on a violation the write is undone AT ONCE and the call returns an error;
 *    then a level check (settle, then a watch window) with AUTO-REVERT on a breach (D3: ON):
 *    POST /history/undo {group} for the undoable domains, a runtime.set of the values read before for
 *    runtime (not in the backend history: REST_API I3, EXEMPT);
 *  - the pane's Undo (one group) / Undo turn use the same revert; env.set (dev-aenv1) is recorded too and
 *    reverts by an env.set of its `previous` setting.
 * Pure decisions live in policy.js / envelope.js; this file does the HTTP.
 */
import crypto from 'node:crypto';
import { callCommand } from '../mcp/tools.js';
import { cflBreach, cflGated, levelBreach, readsFor, revertPlan } from '../envelope.js';

const RECORDED = new Set(['params', 'runtime']);
/** Commands outside those categories that are still undoable (dev-aenv1): env.set reverts to its `previous` setting. */
const UNDOABLE = new Set(['env.set']);
const isRecorded = (cmd) => RECORDED.has(cmd.approval_category) || UNDOABLE.has(cmd.name);
const PERMIT_TTL_MS = 120000;
export const SETTLE_MS = 1200;

/** Stable JSON (sorted keys): the permit key must not depend on the property order. */
export const canonical = (v) => (Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
    : JSON.stringify(v ?? null));

export class AutoWriter {
  constructor({ backendUrl, launcherUrl, fetchImpl = fetch, limits, log, update, note, settleMs = SETTLE_MS, now = Date.now }) {
    Object.assign(this, { backendUrl, launcherUrl, fetchImpl, limits, log, update, note, settleMs, now });
    this.tag = crypto.randomBytes(2).toString('hex');
    this.turn = 0;
    this.writes = 0;            // writes this turn (group numbering)
    this.permits = [];
    this.records = [];          // executed params / runtime writes, newest last: {groupId, turn, cmd, plan, entry, reverted}
    this.watchMs = (limits?.global?.level_breach?.watch_s ?? 15) * 1000;
  }

  beginTurn() {
    this.turn += 1;
    this.writes = 0;
    return this.turn;
  }

  async get(path) {
    try {
      const r = await this.fetchImpl(`${this.backendUrl}${path}`, { signal: AbortSignal.timeout?.(2500) });
      return await r.json();
    } catch (e) {
      return { unreachable: true };
    }
  }

  /** The reads a revert needs + the /health level baseline. */
  async before(cmd, input) {
    const paths = [...new Set([...readsFor(cmd, input), '/health'])];
    const bodies = await Promise.all(paths.map((p) => this.get(p)));
    return Object.fromEntries(paths.map((p, i) => [p, bodies[i]]));
  }

  /**
   * Leave a permit for a call the policy allowed (or the user confirmed). `guard()` -> null | why the call may no
   * longer run (checked right before it does); `onOk(res)` runs after it succeeded (dev-auto1: preset ownership).
   */
  permit(cmd, input, { auto = false, watch = false, before = null, entry = null, guard = null, onOk = null, tainted = false }) {
    const t = this.now();
    this.permits = this.permits.filter((p) => t - p.at < PERMIT_TTL_MS);
    const recorded = isRecorded(cmd);
    const groupId = recorded ? `assistant-${this.tag}-t${this.turn}-w${++this.writes}` : null;
    this.permits.push({ key: `${cmd.name}\u0000${canonical(input)}`, at: t, cmd, input, auto, watch, before, entry, groupId, turn: this.turn, guard, onOk, tainted });
    return groupId;
  }

  clearPermits() { this.permits = []; }

  take(name, args) {
    const key = `${name}\u0000${canonical(args)}`;
    const i = this.permits.findIndex((p) => p.key === key && this.now() - p.at < PERMIT_TTL_MS);
    return i < 0 ? null : this.permits.splice(i, 1)[0];
  }

  /** The executor (POST /internal/command/<name>): {status, body}. */
  async exec(name, args) {
    const p = this.take(name, args);
    if (!p) {
      return { status: 403, body: { ok: false, status: 403, error: 'not_permitted', message: `${name} was not allowed by the assistant policy for these arguments` } };
    }
    const why = p.guard?.();
    if (why) return { status: 409, body: { ok: false, status: 409, error: 'changed', message: why } };
    const res = await callCommand(p.cmd, args, {
      source: 'assistant', fetchImpl: this.fetchImpl, group: p.groupId, urls: { backend: this.backendUrl, launcher: this.launcherUrl },
    });
    res.turn_tainted = p.tainted === true;   // dev-mem1: the MCP server records it on an export (and strips it)
    if (res.ok) p.onOk?.(res);
    if (!res.ok || !p.groupId) return { status: 200, body: res };
    const plan = p.cmd.name === 'env.set' ? { kind: 'env', values: { name: p.input.name, value: res.result?.previous ?? null } }
      : p.before ? revertPlan(p.cmd, p.input, p.before) : (p.cmd.name === 'runtime.set' ? null : { kind: 'history' });
    const rec = { groupId: p.groupId, turn: p.turn, cmd: p.cmd, plan, entry: p.entry, auto: p.auto, reverted: null };
    this.records.push(rec);
    if (this.records.length > 200) this.records.shift();
    if (p.entry) this.update(p.entry, { groupId: p.groupId, turn: p.turn, undoable: !!plan, auto: p.auto });
    if (p.watch && cflGated(p.cmd, p.input)) {
      const rejected = await this.cflGate(rec, res);
      if (rejected) return { status: 200, body: rejected };
    }
    if (p.watch) res.assistant = await this.levelCheck(rec, p.before?.['/health']);
    return { status: 200, body: res };
  }

  /**
   * The CFL gate of a string write (dev-free1): read the engine's flag right after the write; on a violation (or
   * an unreadable flag: fail closed) undo the write's group at once. Returns null (stable) or the error body.
   */
  async cflGate(rec, res) {
    const why = cflBreach(await this.get('/health'));
    if (!why) return null;
    const undo = await this.revert(rec, `CFL gate: ${why}`);
    const undone = undo.ok === true;
    return {
      ok: false, status: 422, error: 'cfl_violation',
      message: `${rec.cmd.name} rejected: ${why}. ${undone ? 'The write was undone; the engine is back on the values before it.'
        : `The automatic undo FAILED (${undo.error || undo.code || undo.status}): undo it now (history__undo) or restore the values.`}`,
      cfl: { reason: why },
      assistant: { group: rec.groupId, auto_reverted: undone, reason: why, undo },
      write_result: res.result ?? null,
    };
  }

  /** Settle, check once (the result tells the model), then keep watching for the window. */
  async levelCheck(rec, baseline) {
    await new Promise((r) => setTimeout(r, this.settleMs));
    const why = levelBreach(baseline, await this.get('/health'), this.limits);
    if (why) {
      const undo = await this.revert(rec, `level breach: ${why}`);
      return { auto: rec.auto, group: rec.groupId, auto_reverted: true, reason: why, undo };
    }
    this.watch(rec, baseline);
    return { auto: rec.auto, group: rec.groupId, level_check: 'ok', watching_s: this.watchMs / 1000 };
  }

  watch(rec, baseline) {
    const until = this.now() + this.watchMs;
    const tick = async () => {
      if (rec.reverted || this.now() > until) return;
      const why = levelBreach(baseline, await this.get('/health'), this.limits);
      if (why) {
        await this.revert(rec, `level breach: ${why}`);
        this.note?.(`Your ${rec.cmd.name} (${rec.groupId}) was reverted after a level breach: ${why}.`);
        return;
      }
      rec.timer = setTimeout(tick, 1000);
    };
    rec.timer = setTimeout(tick, 1000);
  }

  stopWatches() {
    for (const r of this.records) clearTimeout(r.timer);
  }

  /** Undo one recorded write (auto-revert, or the pane's Undo). Returns the backend answer. */
  async revert(rec, reason) {
    if (rec.reverted) return { ok: false, error: 'already_reverted' };
    clearTimeout(rec.timer);
    const headers = { 'Content-Type': 'application/json', 'X-Pianoid-Source': 'assistant' };
    let body;
    try {
      const via = { runtime: 'runtime.set', env: 'env.set' }[rec.plan?.kind];
      const r = via
        ? await this.fetchImpl(`${this.backendUrl}/command/${via}`, { method: 'POST', headers, body: JSON.stringify(rec.plan.values) })
        : await this.fetchImpl(`${this.backendUrl}/history/undo`, { method: 'POST', headers, body: JSON.stringify({ group: rec.groupId }) });
      body = await r.json();
      body = { ...body, status: r.status, ok: r.ok };
    } catch (e) {
      body = { ok: false, error: 'unreachable', message: e.message };
    }
    if (body.ok) rec.reverted = reason;
    this.log({
      command: 'revert', tier: 'assistant', decision: body.ok ? 'reverted' : 'revert failed', status: body.ok ? 'ok' : 'error',
      reason: `${rec.cmd.name} ${rec.groupId}: ${reason}${body.ok ? '' : ` (${body.code || body.error || body.status})`}`, groupId: rec.groupId,
    });
    if (rec.entry && body.ok) this.update(rec.entry, { reverted: reason, undoable: false });
    return body;
  }

  async undoGroup(groupId, reason = 'undo (pane)') {
    const rec = this.records.find((r) => r.groupId === groupId);
    if (!rec) return { ok: false, error: 'unknown_group' };
    return this.revert(rec, reason);
  }

  /** Undo every recorded write of one turn, newest first. */
  async undoTurn(turn, reason = 'undo turn (pane)') {
    const recs = this.records.filter((r) => r.turn === turn && !r.reverted && r.plan).reverse();
    const results = [];
    for (const r of recs) results.push(await this.revert(r, reason));
    return results;
  }
}
