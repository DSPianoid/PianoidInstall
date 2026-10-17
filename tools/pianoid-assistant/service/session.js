/**
 * One assistant session for the pane: the driver (real SDK or fake), the policy gate on every tool
 * call (canUseTool -> policy.js, with confirms answered in the pane), model choice + escalation
 * (D2) with the v2 router (service/router.js: pre-route, tool / failure triggers, self-escalation,
 * stickiness), the activity log, usage (D7), Stop, and the per-turn UI / health context. One installation
 * = one user (D5: no user management). Changing the data opt-out restarts the session (the MCP
 * server is spawned with it, so the filter holds in two places).
 * v2 P2: per-category Ask / Auto approvals (approvals.js; installation default in config.json, session
 * overrides in memory), the hard-confirm list and the A2 envelope (policy.js, envelope.js); the MCP
 * server executes through service/autoWrite.js (permits, undo groups, level watch, auto-revert).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide, HARD_CONFIRM, HARD_CONFIRM_EXTRA } from '../policy.js';
import { applyChange, describe, modeOf, usesEnvelope } from '../approvals.js';
import { check as checkEnvelope } from '../envelope.js';
import { commandName } from '../lib/registry.js';
import { SdkDriver } from '../drivers/sdk.js';
import { childEnv, saveConfig } from './home.js';
import { contextBlock, systemPrompt } from './prompt.js';
import { buildDigest } from './contextDigest.js';
import { Router } from './router.js';
import { AutoWriter } from './autoWrite.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MCP_SERVER = path.resolve(HERE, '..', 'mcp', 'server.js');
export const MODELS = { sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' };
const PIANOID_PREFIX = 'mcp__pianoid__';
const ESCALATE_TOOL = 'mcp__assistant__escalate_model';
const ENV_TTL_MS = 30000;

const summarize = (v, n = 300) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > n ? `${s.slice(0, n)}…` : s;
};

export class AssistantSession {
  constructor({
    paths, config, commands, driverFactory, broadcast = () => {}, fetchImpl = fetch,
    backendUrl = 'http://127.0.0.1:5000', launcherUrl = 'http://127.0.0.1:3001', commandsDir, limits, settleMs,
  }) {
    Object.assign(this, { paths, config, driverFactory, broadcast, fetchImpl, backendUrl, launcherUrl, commandsDir });
    this.sessionApprovals = {};       // "this session only" overrides (the service's lifetime)
    this.notes = [];                  // auto-revert notes for the next turn's context
    this.execUrl = null;              // set by the server once it listens (the MCP server's executor)
    this.auto = new AutoWriter({
      backendUrl, launcherUrl, fetchImpl, limits, settleMs,
      log: (f) => this.logActivity(f), update: (e, f) => this.updateActivity(e, f), note: (n) => this.notes.push(n),
    });
    this.byName = new Map(commands.map((c) => [c.name, c]));
    this.driver = null;
    this.busy = false;
    this.transcript = [];
    this.activity = [];
    this.usage = { rateLimit: null, lastTurn: null, totals: { inputTokens: 0, outputTokens: 0, turns: 0 } };
    this.model = { current: this.baseModel(), escalated: false, reason: null };
    this.router = new Router();
    this.driverModel = null;          // the model the running driver was last set to
    this.pending = new Map();         // confirm id -> {resolve, entry}
    this.turnJobs = [];
    this.nextId = 1;
    this.status = 'idle';
  }

  baseModel() { return this.config.model === 'opus' ? MODELS.opus : MODELS.sonnet; }

  /** The full pane state (sent on connect). */
  state() {
    return {
      type: 'state', modelChoice: this.config.model,
      model: this.model, dataOptOut: !!this.config.dataOptOut, busy: this.busy, transcript: this.transcript,
      activity: this.activity, usage: this.usage, status: this.status,
      pendingConfirms: [...this.pending.values()].map((p) => p.request), approvals: this.approvalsView(),
    };
  }

  approvalState() { return { installation: this.config.approvals || {}, session: this.sessionApprovals }; }

  approvalsView() {
    const hard = [...Object.entries(HARD_CONFIRM).map(([command, reason]) => ({ command, reason })),
      ...HARD_CONFIRM_EXTRA.map((reason) => ({ command: null, reason }))];
    return describe(this.approvalState(), hard);
  }

  /** Change one category (the popover, or "Don't ask again"); installation scope persists in config.json. */
  updateApprovals({ category, mode, scope = 'session' }) {
    const next = applyChange(this.approvalState(), { category, mode, scope });
    this.sessionApprovals = next.session;
    if (scope === 'installation') {
      this.config.approvals = next.installation;
      saveConfig(this.paths, this.config);
    }
    this.logActivity({ command: 'approvals', tier: 'settings', decision: mode, status: 'ok', reason: `${category} -> ${mode} (${scope === 'installation' ? 'this installation' : 'this session'})` });
    this.broadcast({ type: 'approvals', approvals: this.approvalsView() });
  }

  /** The SDK options of the runtime (exported for the isolation tests). */
  sdkOptions() {
    const settings = { dataOptOut: !!this.config.dataOptOut };
    const env = childEnv(this.paths);
    const mcpEnv = {
      PATH: env.PATH || env.Path || '', SYSTEMROOT: env.SYSTEMROOT || env.SystemRoot || '',
      PIANOID_BACKEND_URL: this.backendUrl, PIANOID_LAUNCHER_URL: this.launcherUrl,
    };
    if (this.commandsDir) mcpEnv.PIANOID_COMMANDS_DIR = this.commandsDir;
    const pianoid = {
      type: 'stdio',
      command: process.execPath,
      args: [MCP_SERVER, '--source', 'assistant', '--data-opt-out', String(settings.dataOptOut),
        ...(this.execUrl ? ['--exec-url', this.execUrl] : [])],
      env: mcpEnv,
    };
    const assistant = SdkDriver.assistantTools((reason) => this.escalate(reason));
    assistant.escalate = (reason) => this.escalate(reason);     // the fake driver calls it directly
    return {
      cwd: this.paths.workspace,
      env,
      model: this.model.current,
      systemPrompt: systemPrompt(),
      tools: [],                       // NO built-in tools (no Bash / Read / Edit / Web)
      settingSources: [],              // no user / project / local settings, no CLAUDE.md
      strictMcpConfig: true,           // only the servers below
      mcpServers: { pianoid, assistant },
      permissionMode: 'default',
      includePartialMessages: true,
      canUseTool: (toolName, input, opts) => this.canUseTool(toolName, input, opts),
    };
  }

  async ensureStarted() {
    if (this.driver) return;
    this.status = 'starting';
    this.driver = this.driverFactory();
    await this.driver.start(this.sdkOptions(), (ev) => this.onEvent(ev));
    this.driverModel = this.model.current;
    this.status = 'ready';
  }

  async restart() {
    await this.stop();
    if (this.driver) await this.driver.stop();
    this.driver = null;
    this.model = { current: this.baseModel(), escalated: false, reason: null };
    this.router.reset();
    this.status = 'idle';
    this.broadcast(this.state());
  }

  // ---- policy gate ------------------------------------------------------------------------

  async canUseTool(toolName, input, { signal, toolUseID } = {}) {
    if (toolName === ESCALATE_TOOL) return { behavior: 'allow', updatedInput: input };
    if (!toolName.startsWith(PIANOID_PREFIX)) {
      return { behavior: 'deny', message: `${toolName} is not available to the Pianoid assistant` };
    }
    const tool = toolName.slice(PIANOID_PREFIX.length);
    if (tool === 'search_docs') return { behavior: 'allow', updatedInput: input };
    const cmd = this.byName.get(commandName(tool));
    if (!cmd) return { behavior: 'deny', message: `unknown Pianoid tool ${tool}` };
    await this.trigger(this.router.onToolCall(cmd.name));      // layer 2, before the call runs
    const liveAudio = cmd.family === 'render' ? await this.liveAudio() : false;
    const category = cmd.approval_category;
    const approvals = this.approvalState();
    let before = null;
    let envelope = null;
    if (usesEnvelope(category) && modeOf(category, approvals) === 'auto') {
      before = await this.auto.before(cmd, input);       // the values the envelope compares against
      envelope = checkEnvelope({ cmd, input, before, limits: this.auto.limits, autoWrites: this.auto.autoWrites });
    }
    const verdict = decide({
      command: cmd.name, tier: cmd.tier, family: cmd.family, category,
      settings: { dataOptOut: !!this.config.dataOptOut, liveAudio, tainted: false, approvals, envelope },
    });
    const decision = verdict.action === 'allow' && verdict.auto ? 'auto' : verdict.action;
    const entry = this.logActivity({ command: cmd.name, tier: cmd.tier, category, input, decision, reason: verdict.reason, toolUseId: toolUseID });
    if (verdict.action === 'allow') {
      this.auto.permit(cmd, input, { auto: !!verdict.auto, watch: !!verdict.watch, before, entry });
      return { behavior: 'allow', updatedInput: input };
    }
    if (verdict.action === 'deny') {
      this.router.onRefused(cmd.name);
      return { behavior: 'deny', message: `Denied by the Pianoid policy: ${verdict.reason}` };
    }
    const { allow, remember } = await this.askConfirm(entry, cmd, input, verdict, signal);
    this.updateActivity(entry, { decision: allow ? 'confirmed' : 'rejected', status: allow ? 'pending' : 'rejected' });
    if (!allow) {
      this.router.onRefused(cmd.name);
      return { behavior: 'deny', message: `The user declined ${cmd.name}.` };
    }
    if (remember && verdict.canAuto) this.updateApprovals({ category, mode: 'auto', scope: remember });
    this.auto.permit(cmd, input, { entry });
    return { behavior: 'allow', updatedInput: input };
  }

  /**
   * Is the engine producing live audio (R6)? = realtime thread running AND loaded with audio_on.
   * Unknown (backend unreachable) counts as live: the gate fails closed.
   */
  async liveAudio() {
    try {
      const get = async (p) => (await this.fetchImpl(`${this.backendUrl}${p}`, { signal: AbortSignal.timeout?.(2500) })).json();
      const [health, load] = await Promise.all([get('/health'), get('/load_settings')]);
      if (!health.pianoid_loaded) return false;
      return !!health.backend_thread_running && Number(load?.settings?.audio_on) === 1;
    } catch (e) {
      return true;
    }
  }

  /** A confirm dialog in the pane -> {allow, remember: null | 'session' | 'installation'}. */
  askConfirm(entry, cmd, input, verdict, signal) {
    const id = `c${this.nextId++}`;
    const request = {
      type: 'confirm', id, activityId: entry.id, command: cmd.name, title: cmd.title, tier: cmd.tier, args: input,
      reason: verdict.reason, category: cmd.approval_category, hard: !!verdict.hard, canAuto: !!verdict.canAuto,
    };
    return new Promise((resolve) => {
      const done = (allow, remember = null) => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        this.broadcast({ type: 'confirm_done', id, allow });
        resolve({ allow, remember: allow && ['session', 'installation'].includes(remember) ? remember : null });
      };
      this.pending.set(id, { request, resolve: done });
      signal?.addEventListener?.('abort', () => done(false));
      this.broadcast(request);
    });
  }

  confirm(id, allow, remember) {
    const p = this.pending.get(id);
    if (p) p.resolve(!!allow, remember);
  }

  logActivity(fields) {
    const entry = { id: `a${this.nextId++}`, at: Date.now(), status: 'pending', ...fields, input: summarize(fields.input) };
    if (fields.decision === 'deny') entry.status = 'denied';
    this.activity.push(entry);
    if (this.activity.length > 200) this.activity.shift();
    this.broadcast({ type: 'activity', entry });
    return entry;
  }

  updateActivity(entry, fields) {
    Object.assign(entry, fields);
    this.broadcast({ type: 'activity', entry });
  }

  // ---- model (D2) -------------------------------------------------------------------------

  /** Layer 3: the model's own escalate_model call. */
  async escalate(reason) {
    if (this.config.model !== 'auto') {
      return `The user fixed the model to ${this.config.model}; continuing on ${this.model.current}.`;
    }
    await this.trigger(this.router.onEscalated(reason));
    return `Escalated to ${MODELS.opus} for this turn (${reason}).`;
  }

  /** Switch the running turn to Opus for a layer-2/3 trigger (null = nothing fired). Auto only. */
  async trigger(why) {
    if (!why || this.config.model !== 'auto') return;
    await this.useModel(MODELS.opus, `Opus: ${why}`);
    this.logRoute('opus', `Opus: ${why}`);
  }

  /** Set the model of the session (the driver only when it changes) and tell the pane. */
  async useModel(model, reason) {
    if (this.driver && this.driverModel !== model) {
      await this.driver.setModel(model);
      this.driverModel = model;
    }
    this.model = { current: model, escalated: model === MODELS.opus && this.config.model === 'auto', reason };
    this.broadcast({ type: 'model', ...this.model });
  }

  logRoute(model, reason) {
    this.logActivity({ command: 'model route', tier: 'router', decision: model, reason, status: 'ok' });
  }

  /** Layer 1 + stickiness at the start of a turn (the picker's forced model wins). */
  async routeTurn(text, ctx) {
    if (this.config.model !== 'auto') {
      this.logRoute(this.config.model, `picker: ${this.config.model} (forced)`);
      return;
    }
    const d = this.router.beginTurn(text, ctx);
    const reason = `${d.model === 'opus' ? 'Opus' : 'Sonnet'}: ${d.rule}`;
    await this.useModel(MODELS[d.model], d.model === 'opus' ? reason : null);
    this.logRoute(d.model, reason);
  }

  // ---- turns ------------------------------------------------------------------------------

  async context() {
    const timeout = (ms) => AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined;
    const get = async (url, init) => {
      try {
        const r = await this.fetchImpl(url, { ...init, signal: timeout(2500) });
        return await r.json();
      } catch (e) {
        return { unreachable: true };
      }
    };
    const post = (url) => get(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pianoid-Source': 'assistant' }, body: '{}' });
    const notes = this.notes.splice(0);
    const [ui, health, runtime, load, presets, jobs, outputMask, environment] = await Promise.all([
      post(`${this.launcherUrl}/api/command/ui.snapshot`),
      get(`${this.backendUrl}/health`),
      get(`${this.backendUrl}/get_runtime_parameters`),
      get(`${this.backendUrl}/load_settings`),
      get(`${this.backendUrl}/preset/list`),
      post(`${this.backendUrl}/command/job.list`),
      get(`${this.backendUrl}/get_parameter/feedback_mask/output`),
      this.environment(get),
    ]);
    const digest = buildDigest({ health, runtime, load, presets, jobs, ui, outputMask, environment });
    const auto = this.approvalsView().autoActive;
    return { ...digest, approvals: { auto: auto.length ? auto : 'none' }, ...(notes.length ? { assistant_notes: notes } : {}) };
  }

  /** GET /system/environment, re-read at most every ENV_TTL_MS (it runs git / nvidia-smi in the backend). */
  async environment(get) {
    const now = Date.now();
    if (!this.envCache || now - this.envCache.at > ENV_TTL_MS || this.envCache.body.unreachable) {
      this.envCache = { at: now, body: await get(`${this.backendUrl}/system/environment`) };
    }
    return this.envCache.body;
  }

  async turn(text) {
    if (this.busy) return this.broadcast({ type: 'error', message: 'A turn is already running (Stop it first).' });
    this.busy = true;
    this.turnJobs = [];
    this.auto.beginTurn();
    this.broadcast({ type: 'busy', busy: true });
    this.transcript.push({ role: 'user', text, at: Date.now() });
    this.broadcast({ type: 'message', role: 'user', text });
    try {
      const ctx = await this.context();
      await this.routeTurn(text, ctx);
      await this.ensureStarted();
      this.currentAssistant = { role: 'assistant', text: '', model: this.model.current, at: Date.now() };
      await this.driver.send(contextBlock(ctx) + text);
    } catch (e) {
      this.endTurn();
      this.broadcast({ type: 'error', message: e?.message || String(e) });
    }
  }

  endTurn() {
    this.busy = false;
    this.broadcast({ type: 'busy', busy: false });
  }

  async stop() {
    for (const p of [...this.pending.values()]) p.resolve(false);
    this.auto.clearPermits();
    if (this.busy && this.driver) {
      try { await this.driver.interrupt(); } catch (e) { /* not running */ }
    }
    for (const jobId of this.turnJobs) {
      try {
        await this.fetchImpl(`${this.backendUrl}/command/job.cancel`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pianoid-Source': 'assistant' }, body: JSON.stringify({ jobId }),
        });
      } catch (e) { /* backend down */ }
    }
    this.turnJobs = [];
  }

  async updateSettings({ model, dataOptOut }) {
    let restart = false;
    if (typeof dataOptOut === 'boolean' && dataOptOut !== !!this.config.dataOptOut) {
      this.config.dataOptOut = dataOptOut;
      restart = true;
    }
    if (model && ['auto', 'sonnet', 'opus'].includes(model) && model !== this.config.model) {
      this.config.model = model;
      this.router.reset();
      this.model = { current: this.baseModel(), escalated: false, reason: null };
      if (this.driver && !restart) {
        await this.driver.setModel(this.model.current);
        this.driverModel = this.model.current;
      }
    }
    saveConfig(this.paths, this.config);
    if (restart) await this.restart();
    else this.broadcast(this.state());
  }

  // ---- driver events ----------------------------------------------------------------------

  onEvent(ev) {
    switch (ev.type) {
      case 'init':
        this.sessionInfo = { sessionId: ev.sessionId, model: ev.model, tools: ev.tools || [], mcpServers: ev.mcpServers || [] };
        this.broadcast({ type: 'session', ...this.sessionInfo });
        break;
      case 'delta': {
        // a text block after tool calls starts a new paragraph (it used to run on: "arriving.I found")
        const sep = this.textBreak && this.currentAssistant?.text ? '\n\n' : '';
        this.textBreak = false;
        if (this.currentAssistant) this.currentAssistant.text += sep + ev.text;
        this.broadcast({ type: 'delta', text: sep + ev.text });
        break;
      }
      case 'assistant':
        if (ev.toolUses.length) this.textBreak = true;
        for (const tu of ev.toolUses) {
          if (tu.name === ESCALATE_TOOL) this.broadcast({ type: 'escalation', reason: tu.input?.reason });
        }
        break;
      case 'tool_result': {
        // by tool-use id: parallel calls finish in any order (dev-0a88: the newest-pending guess
        // showed one call's result on another); the oldest pending entry only when no id is known
        const entry = this.activity.findLast((a) => ev.toolUseId && a.toolUseId === ev.toolUseId)
          || this.activity.find((a) => a.status === 'pending' && !a.toolUseId);
        if (entry) this.updateActivity(entry, { status: ev.isError ? 'error' : 'ok', result: summarize(ev.text, 400) });
        this.trigger(this.router.onToolResult(ev.isError)).catch(() => {});
        const m = /"jobId":\s*"([^"]+)"/.exec(ev.text || '');
        if (m) this.turnJobs.push(m[1]);
        break;
      }
      case 'rate_limit':
        this.usage.rateLimit = { ...ev.info, at: Date.now() };
        this.broadcast({ type: 'usage', usage: this.usage });
        break;
      case 'result': {
        const u = ev.usage || {};
        this.usage.lastTurn = { inputTokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), outputTokens: u.output_tokens || 0, durationMs: ev.durationMs, model: this.model.current, modelsUsed: ev.models || null };
        this.usage.totals.inputTokens += this.usage.lastTurn.inputTokens;
        this.usage.totals.outputTokens += this.usage.lastTurn.outputTokens;
        this.usage.totals.turns += 1;
        if (this.currentAssistant) {
          this.currentAssistant.text = this.currentAssistant.text || ev.text || '';
          this.transcript.push(this.currentAssistant);
          this.broadcast({ type: 'message', role: 'assistant', text: this.currentAssistant.text, model: this.model.current, subtype: ev.subtype });
          this.currentAssistant = null;
        }
        this.broadcast({ type: 'usage', usage: this.usage });
        if (this.config.model === 'auto') {
          // stickiness: Opus stays for the next STICKY_TURNS turns after an Opus turn (router.js)
          const next = this.router.endTurn();
          if (MODELS[next] !== this.model.current) {
            this.useModel(MODELS[next], next === 'opus' ? this.model.reason : null).catch(() => {});
          }
        }
        this.endTurn();
        break;
      }
      case 'error':
        this.broadcast({ type: 'error', message: ev.message });
        this.endTurn();
        break;
      case 'closed':
        this.driver = null;
        this.status = 'idle';
        if (this.busy) this.endTurn();
        break;
      default:
    }
  }
}
