/**
 * The real driver: one long-lived Claude Agent SDK session (streaming input) on the user's
 * subscription, in the isolated Claude home (service/home.js). Normalises the SDK messages into
 * the service's events:
 *   {type: 'init', sessionId, model, tools, mcpServers}
 *   {type: 'delta', text}                         streamed assistant text
 *   {type: 'assistant', text, toolUses: [{id, name, input}]}
 *   {type: 'tool_result', toolUseId, isError, text}
 *   {type: 'rate_limit', info}                    SDK rate_limit_event (plan window status)
 *   {type: 'result', subtype, usage, costUsd, durationMs, numTurns}
 *   {type: 'error', message}
 */
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

/** An async queue usable as the SDK's streaming `prompt`. */
class InputQueue {
  constructor() { this.items = []; this.waiters = []; this.closed = false; }
  push(item) {
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false }); else this.items.push(item);
  }
  close() { this.closed = true; this.waiters.splice(0).forEach((w) => w({ value: undefined, done: true })); }
  [Symbol.asyncIterator]() {
    return {
      next: () => (this.items.length ? Promise.resolve({ value: this.items.shift(), done: false })
        : this.closed ? Promise.resolve({ value: undefined, done: true })
          : new Promise((r) => this.waiters.push(r))),
    };
  }
}

export const textOf = (content) => (Array.isArray(content)
  ? content.filter((b) => b.type === 'text').map((b) => b.text).join('')
  : typeof content === 'string' ? content : '');

/** Map one SDK message to service events (pure; exported for tests). */
export function normalize(msg) {
  switch (msg.type) {
    case 'system':
      return msg.subtype === 'init'
        ? [{ type: 'init', sessionId: msg.session_id, model: msg.model, tools: msg.tools, mcpServers: msg.mcp_servers }]
        : [];
    case 'stream_event': {
      const e = msg.event;
      return e?.type === 'content_block_delta' && e.delta?.type === 'text_delta' ? [{ type: 'delta', text: e.delta.text }] : [];
    }
    case 'assistant': {
      const blocks = msg.message?.content || [];
      const toolUses = blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input }));
      return [{ type: 'assistant', text: textOf(blocks), toolUses, model: msg.message?.model }];
    }
    case 'user': {
      const blocks = Array.isArray(msg.message?.content) ? msg.message.content : [];
      return blocks.filter((b) => b.type === 'tool_result').map((b) => ({
        type: 'tool_result', toolUseId: b.tool_use_id, isError: !!b.is_error, text: textOf(b.content),
      }));
    }
    case 'rate_limit_event':
      return [{ type: 'rate_limit', info: msg.rate_limit_info }];
    case 'result':
      return [{
        type: 'result', subtype: msg.subtype, usage: msg.usage || null, costUsd: msg.total_cost_usd ?? null,
        models: msg.modelUsage ? Object.keys(msg.modelUsage) : null,
        durationMs: msg.duration_ms ?? null, numTurns: msg.num_turns ?? null, text: msg.result ?? null,
      }];
    default:
      return [];
  }
}

export class SdkDriver {
  /** opts: the SDK Options built by the session (service/session.js sdkOptions) minus prompt. */
  constructor({ queryImpl = query } = {}) {
    this.queryImpl = queryImpl;
    this.q = null;
    this.input = null;
  }

  /** In-process MCP server with the escalate_model tool (the session supplies the handler). */
  static assistantTools(onEscalate) {
    return createSdkMcpServer({
      name: 'assistant',
      version: '0.1.0',
      tools: [tool('escalate_model',
        'Switch to the stronger model (Opus 5.5) for the rest of this turn: research, multi-step diagnosis, measurement analysis, preset generation / optimisation. Give a one-line reason; the user sees it.',
        { reason: z.string() },
        async ({ reason }) => ({ content: [{ type: 'text', text: await onEscalate(reason) }] }))],
    });
  }

  /**
   * In-process MCP server `analysis` with run_python (v2 P5). The handler (the session) only writes the code
   * to a run dir and spawns the OS sandbox; it never evaluates it.
   */
  static analysisTools(onRunPython) {
    return createSdkMcpServer({
      name: 'analysis',
      version: '0.1.0',
      tools: [tool('run_python',
        'Run Python analysis code in an isolated sandbox (no network, no processes, no files except its own run dir; '
        + 'numpy, scipy, matplotlib with the Agg backend, soundfile). Inputs are artefact ids: get them with export: true '
        + 'on render.note_playback / render.chart / render.keyboard / param.get / preset.summary. In the code: ARTIFACTS '
        + '(id -> meta: command, args, files, sample_rate, series_units), artifact_path(id, name=None) (the first file by '
        + 'default; render artefacts hold audio_<i>.wav and series_<i>.npy), OUT = "out". Files written to OUT '
        + '(.png .csv .json .npy .txt .wav, at most 20 files / 5 MB each) come back as artefact ids; PNGs are shown to the '
        + 'user in the pane. print() goes to stdout (20 kB cap). Limits: wall clock timeout_s (default 60, max 120), '
        + 'CPU half of it, memory 2 GB, disk 200 MB. Every run asks the user first. [category: code]',
        {
          code: z.string().describe('Python 3.12 source'),
          inputs: z.array(z.string()).max(10).optional().describe('artefact ids to copy into the run'),
          timeout_s: z.number().int().min(1).max(120).optional(),
          memory_mb: z.number().int().min(256).max(2048).optional(),
        },
        async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await onRunPython(args), null, 1) }] }))],
    });
  }

  async start(options, onEvent) {
    this.input = new InputQueue();
    this.q = this.queryImpl({ prompt: this.input, options });
    this.loop = (async () => {
      try {
        for await (const msg of this.q) normalize(msg).forEach(onEvent);
      } catch (e) {
        onEvent({ type: 'error', message: e?.message || String(e) });
      } finally {
        onEvent({ type: 'closed' });
      }
    })();
  }

  send(text) {
    this.input.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' });
  }

  async interrupt() { if (this.q) await this.q.interrupt(); }
  async setModel(model) { if (this.q) await this.q.setModel(model); }

  async stop() {
    if (this.input) this.input.close();
    if (this.q) {
      try { await this.q.interrupt(); } catch (e) { /* not running */ }
      try { this.q.close?.(); } catch (e) { /* ignore */ }
    }
    this.q = null;
  }
}
