// dev-4324 (assistant v2 P2 live check): a pass-through proxy in front of an ISOLATED backend for the
// assistant service only. Every request is forwarded unchanged; while breach mode is armed, GET /health
// answers the real body with `clipping: true` ONCE a write went through (a mocked level breach with audio
// off: no note is played, nothing reaches the rig). The service's auto-revert then runs against the REAL
// backend history (POST /history/undo {group} is forwarded).
//   node dev-4324-health-breach-proxy.js <listenPort> <backendUrl>
//   POST /__proxy/breach {"armed": true|false}   GET /__proxy/state
import http from 'node:http';

const [port = '5014', backend = 'http://127.0.0.1:5012'] = process.argv.slice(2);
const state = { armed: false, wrote: false, injected: 0 };
const WRITE = /^\/(command\/(param\.|runtime\.set)|set_parameter|mute\/)/;

http.createServer((req, res) => {
  let body = [];
  req.on('data', (c) => body.push(c));
  req.on('end', async () => {
    body = Buffer.concat(body);
    if (req.url.startsWith('/__proxy/')) {
      if (req.method === 'POST') Object.assign(state, JSON.parse(body.toString() || '{}'), { wrote: false });
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(state));
    }
    if (req.method === 'POST' && WRITE.test(req.url)) state.wrote = true;
    const headers = { ...req.headers };
    delete headers.host;
    try {
      const r = await fetch(`${backend}${req.url}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
      let out = Buffer.from(await r.arrayBuffer());
      if (req.url === '/health' && state.armed && state.wrote) {
        const h = JSON.parse(out.toString());
        h.clipping = true;
        state.injected += 1;
        out = Buffer.from(JSON.stringify(h));
      }
      res.statusCode = r.status;
      res.setHeader('Content-Type', r.headers.get('content-type') || 'application/json');
      res.end(out);
    } catch (e) {
      res.statusCode = 502;
      res.end(JSON.stringify({ error: 'proxy_upstream', message: e.message }));
    }
  });
}).listen(Number(port), '127.0.0.1', () => console.log(`[breach-proxy] :${port} -> ${backend}`));
