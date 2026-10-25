// dev-free1: the assistant's physical gates measured end to end against a REAL backend (no Claude spend).
// The real service (fake driver -> real MCP server -> the service executor) in Autonomous mode drives an isolated
// backend (default http://127.0.0.1:5012, a preset loaded, audio off). Prints each tool result, the engine's
// /health CFL flag and the string value read back after every step.
//   node docs/development/diagnostics/dev-free1-gates-live.mjs [backendUrl] [pitch]
// Run from tools/pianoid-assistant's parent tree (it imports the service by relative path).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from '../../../tools/pianoid-assistant/node_modules/ws/wrapper.mjs';
import { createAssistantService } from '../../../tools/pianoid-assistant/service/server.js';
import { FakeDriver } from '../../../tools/pianoid-assistant/drivers/fake.js';

const BACKEND = process.argv[2] || 'http://127.0.0.1:5012';
const P = process.argv[3] || '60';
const get = async (p) => (await fetch(`${BACKEND}${p}`)).json();
const tension = async () => (await get(`/get_parameter/string/${P}`))[P].tension;
const original = await tension();
const volBefore = (await get('/get_runtime_parameters')).volume_level;
const set = (t) => ({ tool: 'mcp__pianoid__param__set', input: { parameter: 'string', key_no: P, values: { [P]: { tension: t } } } });
// Courant is linear in tension (coeff_tension ~ T; measured on BaselinePreset1 p60: 0.0253 at the original 650.49 N,
// 2.5256 at x100), so the steps are multiples of the original tension.
const STEPS = [
  ['step-stable-x36', original * 36.9],      // Courant ~0.93 < CFL_MARGIN 0.99
  ['step-unstable-x40', original * 40],      // Courant ~1.01 > 0.99
  ['step-unstable-x100', original * 100],    // |g| ~8
  ['step-restore', original],
];
const SCRIPT = STEPS.map(([name, t]) => ({ match: name, steps: [set(t), { say: 'ok' }] }));
SCRIPT.push({ match: 'volume-max', steps: [{ tool: 'mcp__pianoid__runtime__set', input: { volume: 127 } }, { say: 'ok' }] });
SCRIPT.push({ match: 'volume-back', steps: [{ tool: 'mcp__pianoid__runtime__set', input: { volume: volBefore } }, { say: 'ok' }] });

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-free1-live-'));
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ autonomous: true }));
const svc = createAssistantService({
  env: { ...process.env, ANTHROPIC_API_KEY: '', PIANOID_ASSISTANT_HOME: home, PIANOID_BACKEND_URL: BACKEND, PIANOID_LAUNCHER_URL: 'http://127.0.0.1:1' },
  port: 0, driver: 'fake', driverFactory: () => new FakeDriver({ script: SCRIPT }),
});
const port = await svc.listen();
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
const msgs = [];
ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
await new Promise((r) => ws.on('open', r));
const idle = async () => {
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    if (msgs.some((m) => m.type === 'busy' && m.busy === false)) return;
    if (msgs.some((m) => m.type === 'confirm')) throw new Error('a confirm was raised (must not happen)');
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timeout');
};
const turn = async (text) => {
  msgs.length = 0;
  ws.send(JSON.stringify({ type: 'turn', text }));
  await idle();
  const acts = msgs.filter((m) => m.type === 'activity').map((m) => m.entry);
  const call = acts.filter((e) => e.command === 'param.set' || e.command === 'runtime.set').pop();
  const rev = acts.filter((e) => e.command === 'revert').pop();
  const h = await get('/health');
  return { decision: call?.decision, result: (call?.result || '').slice(0, 400), revert: rev?.reason || null,
    health_cfl: { redline: h.cfl_redline, courant: h.cfl_redline_info?.courant ?? null, margin: h.cfl_redline_info?.margin ?? null } };
};

const out = { backend: BACKEND, pitch: P, original_tension: original, steps: [] };
try {
  for (const [name, t] of STEPS) {
    const r = await turn(name);
    out.steps.push({ step: name, requested_tension: t, ...r, tension_after: await tension() });
  }
  const v = await turn('volume-max');
  out.steps.push({ step: `volume ${volBefore} -> 127`, ...v, volume_after: (await get('/get_runtime_parameters')).volume_level, health_clipping: (await get('/health')).clipping });
  const b = await turn('volume-back');
  out.steps.push({ step: `volume back ${volBefore}`, decision: b.decision, volume_after: (await get('/get_runtime_parameters')).volume_level });
  out.confirms_raised = 0;
} finally {
  ws.close();
  await svc.close();
}
console.log(JSON.stringify(out, null, 2));
process.exit(0);
