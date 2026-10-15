/**
 * One assistant session for the pane: the driver (real SDK or fake), the policy gate on every tool
 * call (canUseTool -> policy.js, with confirms answered in the pane), model choice + escalation
 * (D2), per-user activity log (D5), usage (D7), Stop, and the per-turn UI / health context.
 * Changing the user, role or data opt-out restarts the session (the MCP server is spawned with the
 * role's arguments, so the role filter holds in two places).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide } from '../policy.js';
import { commandName } from '../lib/registry.js';
import { SdkDriver } from '../drivers/sdk.js';
import { childEnv, saveConfig } from './home.js';
import { contextBlock, systemPrompt } from './prompt.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MCP_SERVER = path.resolve(HERE, '..', 'mcp', 'server.js');
export const MODELS = { sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' };
const PIANOID_PREFIX = 'mcp__pianoid__';
const ESCALATE_TOOL = 'mcp__assistant__escalate_model';

const summarize = (v, n = 300) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > n ? `${s.slice(0, n)}…` : s;
};

export class AssistantSession {
  constructor({
    paths, config, commands, driverFactory, broadcast = () => {}, fetchImpl = fetch,
    backendUrl = 'http://127.0.0.1:5000', launcherUrl = 'http://127.0.0.1:3001', commandsDir,
  }) {
    Object.assign(this, { paths, config, driverFactory, broadcast, fetchImpl, backendUrl, launcherUrl, commandsDir });
    this.byName = new Map(commands.map((c) => [c.name, c]));
    this.driver = null;
    this.busy = false;
    this.transcript = [];
    this.activity = [];
    this.usage = { rateLimit: null, lastTurn: null, totals: { inputTokens: 0, outputTokens: 0, turns: 0 } };
    this.model = { current: this.baseModel(), escalated: false, reason: null };
    this.pending = new Map();         // confirm id -> {resolve, entry}
    this.turnJobs = [];
    this.nextId = 1;
    this.status = 'idle';
  }

  get user() { return this.config.users.find((u) => u.id === this.config.activeUser) || this.config.users[0]; }
  get role() { return this.user.role; }
  baseModel() { return this.config.model === 'opus' ? MODELS.opus : MODELS.sonnet; }

  /** The full pane state (sent on connect). */
  state() {
    return {
      type: 'state', user: this.user, users: this.config.users, role: this.role, modelChoice: this.config.model,
      model: this.model, dataOptOut: !!this.config.dataOptOut, busy: this.busy, transcript: this.transcript,
      activity: this.activity, usage: this.usage, status: this.status,
      pendingConfirms: [...this.pending.values()].map((p) => p.request),
    };
  }

  /** The SDK options for this user / role (exported for the isolation tests). */
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
      args: [MCP_SERVER, '--role', this.role, '--source', 'assistant', '--client', `assistant/${this.user.id}`,
        '--data-opt-out', String(settings.dataOptOut)],
      env: mcpEnv,
    };
    const assistant = SdkDriver.assistantTools((reason) => this.escalate(reason));
    assistant.escalate = (reason) => this.escalate(reason);     // the fake driver calls it directly
    return {
      cwd: this.paths.workspace,
      env,
      model: this.model.current,
      systemPrompt: systemPrompt({ role: this.role, userName: this.user.name }),
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
    this.status = 'ready';
  }

  async restart() {
    await this.stop();
    if (this.driver) await this.driver.stop();
    this.driver = null;
    this.model = { current: this.baseModel(), escalated: false, reason: null };
    this.status = 'idle';
    this.broadcast(this.state());
  }

  // ---- policy gate ------------------------------------------------------------------------

  async canUseTool(toolName, input, { signal } = {}) {
    if (toolName === ESCALATE_TOOL) return { behavior: 'allow', updatedInput: input };
    if (!toolName.startsWith(PIANOID_PREFIX)) {
      return { behavior: 'deny', message: `${toolName} is not available to the Pianoid assistant` };
    }
    const tool = toolName.slice(PIANOID_PREFIX.length);
    if (tool === 'search_docs') return { behavior: 'allow', updatedInput: input };
    const cmd = this.byName.get(commandName(tool));
    if (!cmd) return { behavior: 'deny', message: `unknown Pianoid tool ${tool}` };
    const verdict = decide({ command: cmd.name, tier: cmd.tier, family: cmd.family, role: this.role, settings: { dataOptOut: !!this.config.dataOptOut } });
    const entry = this.logActivity({ command: cmd.name, tier: cmd.tier, input, decision: verdict.action, reason: verdict.reason });
    if (verdict.action === 'allow') return { behavior: 'allow', updatedInput: input };
    if (verdict.action === 'deny') return { behavior: 'deny', message: `Denied by the Pianoid policy: ${verdict.reason}` };
    const allowed = await this.askConfirm(entry, cmd, input, verdict.reason, signal);
    this.updateActivity(entry, { decision: allowed ? 'confirmed' : 'rejected', status: allowed ? 'pending' : 'rejected' });
    return allowed
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: `The user declined ${cmd.name}.` };
  }

  askConfirm(entry, cmd, input, reason, signal) {
    const id = `c${this.nextId++}`;
    const request = { type: 'confirm', id, activityId: entry.id, command: cmd.name, title: cmd.title, tier: cmd.tier, args: input, reason, user: this.user.name };
    return new Promise((resolve) => {
      const done = (allow) => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        this.broadcast({ type: 'confirm_done', id, allow });
        resolve(allow);
      };
      this.pending.set(id, { request, resolve: done });
      signal?.addEventListener?.('abort', () => done(false));
      this.broadcast(request);
    });
  }

  confirm(id, allow) {
    const p = this.pending.get(id);
    if (p) p.resolve(!!allow);
  }

  logActivity(fields) {
    const entry = { id: `a${this.nextId++}`, at: Date.now(), user: this.user.name, role: this.role, status: 'pending', ...fields, input: summarize(fields.input) };
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

  async escalate(reason) {
    if (this.config.model !== 'auto') {
      return `The user fixed the model to ${this.config.model}; continuing on ${this.model.current}.`;
    }
    if (!this.model.escalated) {
      await this.driver?.setModel(MODELS.opus);
      this.model = { current: MODELS.opus, escalated: true, reason };
      this.broadcast({ type: 'model', ...this.model });
    }
    return `Escalated to ${MODELS.opus} for this turn (${reason}).`;
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
    const [ui, health, presets, jobs] = await Promise.all([
      post(`${this.launcherUrl}/api/command/ui.snapshot`),
      get(`${this.backendUrl}/health`),
      get(`${this.backendUrl}/preset/list`),
      post(`${this.backendUrl}/command/job.list`),
    ]);
    const h = health.unreachable ? { unreachable: true } : {
      status: health.status, pianoid_loaded: health.pianoid_loaded, lifecycle: health.lifecycle, limiting: health.limiting,
      exception: health.exception, audio_driver_fallback: health.audio_driver_fallback?.active,
    };
    const running = (jobs.result?.jobs || []).filter((j) => j.state === 'running').map((j) => ({ id: j.id, name: j.name, pct: j.pct }));
    return {
      user: { name: this.user.name, role: this.role },
      backend: h,
      preset: presets.unreachable ? null : { active: presets.active, entries: (presets.presets || []).map((p) => `${p.name} (${p.kind})`) },
      ui: ui.ok ? ui.result : { unavailable: ui.error || 'no leader tab' },
      runningJobs: running,
    };
  }

  async turn(text) {
    if (this.busy) return this.broadcast({ type: 'error', message: 'A turn is already running (Stop it first).' });
    this.busy = true;
    this.turnJobs = [];
    this.broadcast({ type: 'busy', busy: true });
    this.transcript.push({ role: 'user', text, user: this.user.name, at: Date.now() });
    this.broadcast({ type: 'message', role: 'user', text, user: this.user.name });
    try {
      await this.ensureStarted();
      const ctx = await this.context();
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

  async updateSettings({ user, model, dataOptOut, addUser }) {
    let restart = false;
    if (addUser && typeof addUser.name === 'string' && addUser.name.trim() && ['owner', 'collaborator'].includes(addUser.role)) {
      const base = addUser.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'user';
      let id = base;
      for (let i = 2; this.config.users.some((u) => u.id === id); i += 1) id = `${base}-${i}`;
      this.config.users = [...this.config.users, { id, name: addUser.name.trim(), role: addUser.role }];
    }
    if (user && user !== this.config.activeUser && this.config.users.some((u) => u.id === user)) {
      this.config.activeUser = user;
      restart = true;
    }
    if (typeof dataOptOut === 'boolean' && dataOptOut !== !!this.config.dataOptOut) {
      this.config.dataOptOut = dataOptOut;
      restart = true;
    }
    if (model && ['auto', 'sonnet', 'opus'].includes(model) && model !== this.config.model) {
      this.config.model = model;
      this.model = { current: this.baseModel(), escalated: false, reason: null };
      if (this.driver && !restart) await this.driver.setModel(this.model.current);
    }
    saveConfig(this.paths, this.config);
    if (restart) await this.restart();
    else this.broadcast(this.state());
  }

  // ---- driver events ----------------------------------------------------------------------

  onEvent(ev) {
    switch (ev.type) {
      case 'init':
        this.broadcast({ type: 'session', sessionId: ev.sessionId, model: ev.model, mcpServers: ev.mcpServers });
        break;
      case 'delta':
        if (this.currentAssistant) this.currentAssistant.text += ev.text;
        this.broadcast({ type: 'delta', text: ev.text });
        break;
      case 'assistant':
        for (const tu of ev.toolUses) {
          if (tu.name === ESCALATE_TOOL) this.broadcast({ type: 'escalation', reason: tu.input?.reason });
        }
        break;
      case 'tool_result': {
        const entry = [...this.activity].reverse().find((a) => a.status === 'pending');
        if (entry) this.updateActivity(entry, { status: ev.isError ? 'error' : 'ok', result: summarize(ev.text, 400) });
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
        this.usage.lastTurn = { inputTokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), outputTokens: u.output_tokens || 0, durationMs: ev.durationMs, model: this.model.current };
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
        if (this.model.escalated && this.config.model === 'auto') {
          this.model = { current: MODELS.sonnet, escalated: false, reason: null };
          this.driver?.setModel(MODELS.sonnet).catch(() => {});
          this.broadcast({ type: 'model', ...this.model });
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
