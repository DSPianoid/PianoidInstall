/**
 * The LOCAL PANEL — a thin, READ-ONLY operator view (OD-3: minimal web,
 * read-only in Phase 1).
 *
 * A dependency-free Node HTTP server exposing:
 *   GET /            → a minimal HTML page (auto-refreshing)
 *   GET /api/health  → supervisor + adapter health JSON
 *   GET /api/capture → the recent captured event stream (JSON)
 *
 * Phase-1 is read-only: no approve-click, no controls (those land in Phase 3
 * per the proposal). It binds to localhost only.
 *
 * Concern (P2): present a read-only operator view. It mutates nothing.
 *
 * Traces: proposal OD-3 ("Minimal web … ship read-only in Phase 1") + PART B.2
 * "Local panel" border ("be a full IDE; hold project state" — it does neither).
 */

import { createServer, type Server } from 'node:http';
import type { Supervisor } from './supervisor.js';
import type { Logger } from './logger.js';

export interface PanelOptions {
  port: number;
  supervisor: Supervisor;
  logger: Logger;
  /** Max capture records returned by /api/capture. Default 200. */
  captureLimit?: number;
}

export class Panel {
  private server: Server | null = null;
  private readonly port: number;
  private readonly supervisor: Supervisor;
  private readonly logger: Logger;
  private readonly captureLimit: number;

  constructor(opts: PanelOptions) {
    this.port = opts.port;
    this.supervisor = opts.supervisor;
    this.logger = opts.logger.child('panel');
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
    // Read-only: reject anything that isn't a GET.
    if (req.method !== 'GET') {
      res.writeHead(405, { 'content-type': 'text/plain' });
      res.end('read-only panel: GET only');
      return;
    }
    try {
      if (url.startsWith('/api/health')) {
        this.json(res, this.supervisor.health());
      } else if (url.startsWith('/api/capture')) {
        const records = this.supervisor.captureStore.replay();
        const tail = records.slice(-this.captureLimit);
        this.json(res, { count: records.length, returned: tail.length, records: tail });
      } else if (url === '/' || url.startsWith('/index')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(this.html());
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
<h1>Pianoid Supervisor <span class="badge">Phase 1 · read-only</span></h1>
<div class="card"><div class="k">health</div><pre id="health">loading…</pre></div>
<div class="card"><div class="k">recent capture (latest last)</div><pre id="capture">loading…</pre></div>
<script>
async function refresh(){
  try{
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
