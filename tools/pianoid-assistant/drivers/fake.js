/**
 * Zero-spend driver (PIANOID_ASSISTANT_DRIVER=fake): replays a script instead of calling Claude,
 * through the SAME path as the real driver — every tool call goes through the session's
 * canUseTool policy hook and then the REAL Pianoid MCP server (spawned over stdio from the
 * session's mcpServers config). Script: [{match: "regex", steps: [{say: "text"} |
 * {tool: "mcp__pianoid__ui__pane__open", input: {...}} | {escalate: "reason"}]}]; the first rule
 * whose regex matches the user text runs. No match → a canned reply. A tool step passes the
 * session's PreToolUse hooks first (as the real runtime does), then canUseTool; `mcp__analysis__*`
 * runs the session's in-process analysis handler; `{$ref: "<n>.<json path>"}` in an input value
 * substitutes a value from the JSON result of the n-th tool step (0-based; e.g. an exported artefact id).
 */
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export const DEFAULT_SCRIPT = [
  {
    match: 'open (\\w+)',
    steps: [{ say: 'Opening the pane.' }, { tool: 'mcp__pianoid__ui__pane__open', input: { pane: '$1' } }, { say: 'Done.' }],
  },
  { match: 'play', steps: [{ tool: 'mcp__pianoid__play__note', input: { pitch: 60, velocity: 80 } }, { say: 'Played C4.' }] },
  { match: 'save', steps: [{ tool: 'mcp__pianoid__preset__save', input: { path: 'presets/assistant_fake_test.json' } }, { say: 'Save step finished.' }] },
  { match: 'calibrate', steps: [{ tool: 'mcp__pianoid__calibration__synthesis', input: { pitches: [60] } }, { say: 'Calibration step finished.' }] },
  { match: 'research', steps: [{ escalate: 'multi-step analysis' }, { say: 'Escalated.' }] },
];

export class FakeDriver {
  constructor({ script = null, scriptPath = process.env.PIANOID_ASSISTANT_FAKE_SCRIPT } = {}) {
    this.script = script || (scriptPath ? JSON.parse(fs.readFileSync(scriptPath, 'utf8')) : DEFAULT_SCRIPT);
    this.model = null;
    this.aborter = null;
  }

  async start(options, onEvent) {
    this.options = options;
    this.onEvent = onEvent;
    this.model = options.model;
    const cfg = options.mcpServers?.pianoid;
    this.mcp = new Client({ name: 'fake-driver', version: '0' });
    await this.mcp.connect(new StdioClientTransport({ command: cfg.command, args: cfg.args, env: { ...process.env, ...(cfg.env || {}) } }));
    this.escalate = options.mcpServers?.assistant?.escalate;   // set by the session for the fake runtime
    this.runPython = options.mcpServers?.analysis?.runPython;
    this.bugReport = options.mcpServers?.assistant?.bugReport;
    onEvent({ type: 'init', sessionId: 'fake-session', model: this.model, tools: [], mcpServers: [{ name: 'pianoid', status: 'connected' }] });
  }

  async send(text) {
    const rule = this.script.find((r) => new RegExp(r.match, 'i').test(text));
    const m = rule ? new RegExp(rule.match, 'i').exec(text) : null;
    const sub = (v) => (typeof v === 'string' ? v.replace(/\$(\d)/g, (_, i) => m?.[i] ?? '') : v);
    const steps = rule ? rule.steps : [{ say: '(fake driver) no scripted reply for that.' }];
    this.aborter = new AbortController();
    const { signal } = this.aborter;
    let n = 0;
    const results = [];
    const ref = (v) => {
      if (Array.isArray(v)) return v.map(ref);
      if (!v || typeof v !== 'object' || !v.$ref) return v;
      const [i, ...keys] = String(v.$ref).split('.');
      return keys.reduce((o, k) => o?.[k], results[Number(i)]);
    };
    for (const step of steps) {
      if (signal.aborted) break;
      if (step.say) {
        this.onEvent({ type: 'delta', text: step.say });
        this.onEvent({ type: 'assistant', text: step.say, toolUses: [], model: this.model });
      } else if (step.escalate) {
        const reply = this.escalate ? await this.escalate(step.escalate) : 'no escalation hook';
        this.onEvent({ type: 'assistant', text: '', toolUses: [{ id: `t${++n}`, name: 'mcp__assistant__escalate_model', input: { reason: step.escalate } }], model: this.model });
        this.onEvent({ type: 'tool_result', toolUseId: `t${n}`, isError: false, text: reply });
      } else if (step.tool) {
        const input = Object.fromEntries(Object.entries(step.input || {}).map(([k, v]) => [k, ref(sub(v))]));
        const id = `t${++n}`;
        this.onEvent({ type: 'assistant', text: '', toolUses: [{ id, name: step.tool, input }], model: this.model });
        const hookDeny = await this.preToolUse(step.tool, input, id);
        const verdict = hookDeny ? { behavior: 'deny', message: hookDeny }
          : await this.options.canUseTool(step.tool, input, { signal, toolUseID: id });
        if (verdict.behavior !== 'allow') {
          this.onEvent({ type: 'tool_result', toolUseId: id, isError: true, text: verdict.message });
          results.push(null);
          continue;
        }
        const args = verdict.updatedInput || input;
        let text;
        let isError = false;
        if (step.tool.startsWith('mcp__analysis__')) {
          text = JSON.stringify(await this.runPython(args));
        } else if (step.tool === 'mcp__assistant__bug_report') {
          text = JSON.stringify(await this.bugReport(args));
        } else {
          const r = await this.mcp.callTool({ name: step.tool.replace(/^mcp__pianoid__/, ''), arguments: args });
          text = r.content?.[0]?.text || '';
          isError = !!r.isError;
        }
        let parsed = null;
        try { parsed = JSON.parse(text); } catch (e) { /* not JSON */ }
        results.push(parsed);
        this.onEvent({ type: 'tool_result', toolUseId: id, isError, text });
      }
    }
    this.onEvent({ type: 'result', subtype: signal.aborted ? 'interrupted' : 'success', usage: { input_tokens: 0, output_tokens: 0 }, costUsd: 0, numTurns: 1 });
    this.onEvent({ type: 'rate_limit', info: { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.01 } });
  }

  /** The session's PreToolUse hooks, as the real runtime runs them: the deny reason, or null. */
  async preToolUse(toolName, toolInput, toolUseId) {
    for (const m of this.options.hooks?.PreToolUse || []) {
      for (const h of m.hooks) {
        const out = await h({ hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput, tool_use_id: toolUseId });
        if (out?.hookSpecificOutput?.permissionDecision === 'deny') return out.hookSpecificOutput.permissionDecisionReason;
      }
    }
    return null;
  }

  async interrupt() { this.aborter?.abort(); }
  async setModel(model) { this.model = model; }
  async stop() { await this.mcp?.close(); this.mcp = null; }
}
