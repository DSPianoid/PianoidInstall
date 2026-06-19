/**
 * The LOCAL PANEL — an operator view (OD-3: minimal web).
 *
 * A dependency-free Node HTTP server exposing:
 *   GET  /            → a minimal HTML page (auto-refreshing)
 *   GET  /api/health  → supervisor + adapter health JSON
 *   GET  /api/capture → the recent captured event stream (JSON)
 *   GET  /api/session → hosted-session view: pending approvals, cost, stall,
 *                       verification-evidence, session id (Phase 3a; if a session
 *                       is hosted)
 *   POST /api/approve → CLICK-approve/deny a pending permission (Phase 3a)
 *   POST /api/clear   → self-context-clean the hosted session (Phase 3a)
 *
 * Phase 3a makes it OPERATOR-GRADE (click-approve + metrics views) per the
 * proposal (Phase-3 deliverable 4). It binds to LOOPBACK only — an operator view,
 * not public; the write endpoints are local-only by construction.
 *
 * Concern (P2): present the operator view + relay operator approve/clear actions
 * to the session host. It holds no project state.
 *
 * Traces: proposal OD-3 + Phase-3 deliverable 4 (operator-grade: pending
 * approvals click-to-approve, session/health, cost + stall + verification views).
 */

import { createServer, type Server } from 'node:http';
import type { Supervisor } from './supervisor.js';
import type { Logger } from './logger.js';
import type { SessionHost } from './session-host.js';
import type { BusEvent } from './io-bus.js';
import type { ControllerBridge } from './controller-bridge.js';

export interface PanelOptions {
  port: number;
  supervisor: Supervisor;
  logger: Logger;
  /** The hosted session (enables the operator-grade views + approve/clear). Optional. */
  sessionHost?: SessionHost;
  /** The controller bridge (surfaces M6 signals from the bus in the session view). Optional. */
  controllerBridge?: ControllerBridge;
  /** Max capture records returned by /api/capture. Default 200. */
  captureLimit?: number;
}

export class Panel {
  private server: Server | null = null;
  private readonly port: number;
  private readonly supervisor: Supervisor;
  private readonly logger: Logger;
  private readonly sessionHost?: SessionHost;
  private readonly controllerBridge?: ControllerBridge;
  private readonly captureLimit: number;

  constructor(opts: PanelOptions) {
    this.port = opts.port;
    this.supervisor = opts.supervisor;
    this.logger = opts.logger.child('panel');
    this.sessionHost = opts.sessionHost;
    this.controllerBridge = opts.controllerBridge;
    this.captureLimit = opts.captureLimit ?? 200;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      // Bind to loopback only — the panel is an operator view, not public.
      this.server!.listen(this.port, '127.0.0.1', () => {
        this.server!.off('error', reject);
        resolve();
      });
    });
    this.logger.info('panel listening', { url: `http://127.0.0.1:${this.boundPort}/` });
  }

  /** The actual bound port (resolves an ephemeral port-0 to the real one). */
  get boundPort(): number {
    const addr = this.server?.address();
    if (addr && typeof addr === 'object') return addr.port;
    return this.port;
  }

  private handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void {
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';
    try {
      if (method === 'GET' && url.startsWith('/api/health')) {
        this.json(res, this.supervisor.health());
      } else if (method === 'GET' && url.startsWith('/api/capture')) {
        const records = this.supervisor.captureStore.replay();
        const tail = records.slice(-this.captureLimit);
        this.json(res, { count: records.length, returned: tail.length, records: tail });
      } else if (method === 'GET' && url.startsWith('/api/session')) {
        this.json(res, this.sessionView());
      } else if (method === 'POST' && url.startsWith('/api/approve')) {
        this.handleApprove(req, res);
      } else if (method === 'POST' && url.startsWith('/api/clear')) {
        this.handleClear(res);
      } else if (method === 'GET' && url.startsWith('/api/channel/state')) {
        // D2: channel state for the orchestrator's self-check.
        this.json(res, this.supervisor.channelState());
      } else if (method === 'POST' && url.startsWith('/api/channel/reconnect')) {
        void this.handleChannelReconnect(res);
      } else if (method === 'POST' && url.startsWith('/api/channel/flush')) {
        this.json(res, this.supervisor.flushChannel('telegram'));
      } else if (method === 'POST' && url.startsWith('/api/channel/kill-stale-sender')) {
        // D2: the supervisor can't safely kill an EXTERNAL process from inside; it
        // reports the current sender (its own PID) + reconnects to re-acquire the token.
        // The orchestrator does any actual stale-PID kill via Bash at its discretion.
        void this.handleKillStaleSender(res);
      } else if (method === 'POST' && url.startsWith('/api/lifecycle/restart-request')) {
        // LIFECYCLE-RESTART: the hosted agent requests its own restart; the supervisor
        // confirms with the user + executes OUT-OF-BAND. Returns queued/refused immediately.
        this.handleRestartRequest(req, res);
      } else if (method === 'GET' && (url === '/' || url.startsWith('/index'))) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(this.html());
      } else if (method !== 'GET' && method !== 'POST') {
        res.writeHead(405, { 'content-type': 'text/plain' });
        res.end('method not allowed');
      } else {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
      }
    } catch (err) {
      this.logger.warn('panel request error', { url, err: String(err) });
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('internal error');
    }
  }

  /** Compute the operator session view from the capture stream + the session host. */
  private sessionView(): Record<string, unknown> {
    const records = this.supervisor.captureStore.replay().map((r) => (r as { event: BusEvent }).event ?? r);
    // Derive cost (sum of result costUsd), last stall, last verification marker.
    let totalCostUsd = 0;
    let lastResult: unknown = null;
    let lastStall: unknown = null;
    for (const e of records as BusEvent[]) {
      if (e.type === 'stream.result') {
        const c = (e.payload as { costUsd?: number }).costUsd;
        if (typeof c === 'number') totalCostUsd += c;
        lastResult = e.payload;
      } else if (e.type === 'lifecycle' && (e.payload as { event?: string }).event === 'stall') {
        lastStall = e.payload;
      }
    }
    const health = this.sessionHost?.health();
    return {
      hosted: !!this.sessionHost,
      session: health ?? null,
      pendingApprovals: this.sessionHost?.pendingPermissions() ?? [],
      totalCostUsd: Number(totalCostUsd.toFixed(6)),
      lastResult,
      lastStall,
      // Controller (M6) signals derived from the bus (additive).
      controllerSignals: this.controllerBridge?.signals().slice(-20) ?? [],
    };
  }

  /** POST /api/approve { code?, verdict } → resolve a pending permission by click. */
  private handleApprove(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void {
    if (!this.sessionHost) {
      res.writeHead(409, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'no hosted session' }));
      return;
    }
    this.readBody(req, (body) => {
      const verdict = body.verdict === 'allow' ? 'allow' : body.verdict === 'deny' ? 'deny' : null;
      if (!verdict) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: "verdict must be 'allow' or 'deny'" }));
        return;
      }
      const ok = this.sessionHost!.operatorDecide(verdict, typeof body.code === 'string' ? body.code : undefined);
      this.logger.info('operator panel decision', { verdict, code: body.code, ok });
      this.json(res, { ok, verdict, code: body.code ?? null });
    });
  }

  /**
   * POST /api/lifecycle/restart-request { reason, handoffNote? } → the hosted agent
   * requests its own restart. Returns the queued/refused outcome IMMEDIATELY; the
   * user-confirm + teardown happen out-of-band.
   */
  private handleRestartRequest(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void {
    if (!this.sessionHost) {
      res.writeHead(409, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', error: 'no hosted session' }));
      return;
    }
    this.readBody(req, (body) => {
      const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : '(no reason given)';
      const handoffNote = typeof body.handoffNote === 'string' ? body.handoffNote : undefined;
      const outcome = this.sessionHost!.requestRestart(reason, handoffNote);
      this.logger.info('lifecycle restart-request received', { reason, status: outcome.status });
      this.json(res, outcome);
    });
  }

  /** POST /api/channel/reconnect → re-establish the telegram transport (D2 repair). */
  private async handleChannelReconnect(res: import('node:http').ServerResponse): Promise<void> {
    const r = await this.supervisor.reconnectChannel('telegram');
    this.logger.info('panel: channel reconnect requested', r);
    this.json(res, { action: 'reconnect', ...r });
  }

  /**
   * POST /api/channel/kill-stale-sender → reconnect to re-acquire the single getUpdates
   * poller (the supervisor can't kill an external process safely from inside). Returns
   * the current sender (this supervisor's PID) so the orchestrator can kill a DIFFERENT
   * stale process via Bash if one is found. (D2 repair.)
   */
  private async handleKillStaleSender(res: import('node:http').ServerResponse): Promise<void> {
    const r = await this.supervisor.reconnectChannel('telegram');
    this.logger.info('panel: kill-stale-sender (reconnect to re-acquire poller)', r);
    this.json(res, {
      action: 'kill-stale-sender',
      reconnected: r.ok,
      error: r.error,
      currentSenderPid: process.pid,
      note: 'reconnected to re-acquire the single getUpdates poller; kill any DIFFERENT stale sender PID via Bash',
    });
  }

  /** POST /api/clear → self-context-clean the hosted session. */
  private handleClear(res: import('node:http').ServerResponse): void {
    if (!this.sessionHost) {
      res.writeHead(409, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'no hosted session' }));
      return;
    }
    void this.sessionHost.clearContext();
    this.logger.info('operator panel: context clear requested', {});
    this.json(res, { ok: true, action: 'clear' });
  }

  /** Read + parse a small JSON request body (bounded; loopback only). */
  private readBody(req: import('node:http').IncomingMessage, cb: (body: Record<string, unknown>) => void): void {
    let data = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 8192) tooBig = true; // bound it
    });
    req.on('end', () => {
      if (tooBig) {
        cb({});
        return;
      }
      try {
        cb(data ? (JSON.parse(data) as Record<string, unknown>) : {});
      } catch {
        cb({});
      }
    });
  }

  private json(res: import('node:http').ServerResponse, body: unknown): void {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body, null, 2));
  }

  /** A minimal self-contained operator page (polls the JSON endpoints). */
  private html(): string {
    return `<!doctype html><html><head><meta charset="utf-8"><title>Pianoid Supervisor</title>
<style>
  body{font:13px ui-monospace,Menlo,Consolas,monospace;background:#0b0f14;color:#cdd6f4;margin:0;padding:16px}
  h1{font-size:15px;color:#89b4fa;margin:0 0 12px}
  .card{background:#11161d;border:1px solid #1e2630;border-radius:8px;padding:12px;margin-bottom:12px}
  .k{color:#94a3b8}
  pre{white-space:pre-wrap;word-break:break-word;margin:0;max-height:50vh;overflow:auto}
  .badge{display:inline-block;padding:2px 8px;border-radius:10px;background:#1e2630}
  .ok{color:#a6e3a1}.warn{color:#f9e2af}
</style></head><body>
<h1>Pianoid Supervisor <span class="badge">operator panel</span></h1>
<div class="card"><div class="k">hosted session</div><pre id="session">loading…</pre>
  <div id="pending"></div>
  <button id="clearBtn" style="margin-top:8px">/clear (self-context-clean)</button>
</div>
<div class="card"><div class="k">health</div><pre id="health">loading…</pre></div>
<div class="card"><div class="k">recent capture (latest last)</div><pre id="capture">loading…</pre></div>
<script>
async function decide(code,verdict){
  await fetch('/api/approve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code,verdict})});
  refresh();
}
document.getElementById('clearBtn').onclick=async()=>{
  await fetch('/api/clear',{method:'POST'}); refresh();
};
async function refresh(){
  try{
    const s=await (await fetch('/api/session')).json();
    const summary={hosted:s.hosted,sessionId:s.session&&s.session.lifecycle&&s.session.lifecycle.sessionId,
      restarts:s.session&&s.session.lifecycle&&s.session.lifecycle.restarts,
      totalCostUsd:s.totalCostUsd,pendingApprovals:s.pendingApprovals.length,lastStall:s.lastStall};
    document.getElementById('session').textContent=JSON.stringify(summary,null,2);
    const pend=document.getElementById('pending');
    pend.innerHTML='';
    (s.pendingApprovals||[]).forEach(p=>{
      const row=document.createElement('div'); row.style.margin='6px 0';
      row.innerHTML='🔐 <b>'+p.toolName+'</b> ('+p.code+') ';
      const a=document.createElement('button'); a.textContent='allow'; a.onclick=()=>decide(p.code,'allow');
      const d=document.createElement('button'); d.textContent='deny'; d.style.marginLeft='6px'; d.onclick=()=>decide(p.code,'deny');
      row.appendChild(a); row.appendChild(d); pend.appendChild(row);
    });
    const h=await (await fetch('/api/health')).json();
    document.getElementById('health').textContent=JSON.stringify(h,null,2);
    const c=await (await fetch('/api/capture')).json();
    const lines=c.records.map(r=>{
      const e=r.event; return e.seq+' '+e.ts+' ['+e.direction+'] '+e.type+' <'+e.source+'>';
    });
    document.getElementById('capture').textContent='events: '+c.count+' (showing '+c.returned+')\\n'+lines.join('\\n');
  }catch(err){ /* keep last good */ }
}
refresh(); setInterval(refresh,2000);
</script></body></html>`;
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
  }
}
