import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Supervisor } from '../supervisor.js';
import { Logger } from '../logger.js';
import { Panel } from '../panel.js';
import { TelegramAdapter } from '../adapters/telegram.js';
import { AccessGate } from '../adapters/access-gate.js';
import { LoopbackTelegramTransport } from '../adapters/loopback-transport.js';
import { tmpDir } from './helpers.js';
import { SessionHost } from '../session-host.js';
import { IoBus } from '../io-bus.js';
import { FakeSessionDriver } from './fake-session-driver.js';
import type { OutboundResult } from '../contract.js';

function silentLogger(): Logger {
  return new Logger({ level: 'error', stderr: false });
}

async function withPanel(
  dir: string,
  fn: (base: string, supervisor: Supervisor) => Promise<void>,
): Promise<void> {
  const supervisor = new Supervisor({
    captureFile: join(dir, 'capture.ndjson'),
    logger: silentLogger(),
    unbufferedCapture: true,
  });
  supervisor.register(
    new TelegramAdapter({
      transport: new LoopbackTelegramTransport(),
      gate: new AccessGate({ staticConfig: { dmPolicy: 'allowlist', allowFrom: [], groups: {} } }),
      queueDir: join(dir, 'q'),
      downloadDir: join(dir, 'd'),
    }),
  );
  await supervisor.start();
  // Port 0 = ephemeral; read the actual port from the server.
  const panel = new Panel({ port: 0, supervisor, logger: silentLogger() });
  await panel.start();
  const base = `http://127.0.0.1:${panel.boundPort}`;
  try {
    await fn(base, supervisor);
  } finally {
    await panel.stop();
    await supervisor.stop();
  }
}

test('panel /api/health returns supervisor health JSON', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    await withPanel(dir, async (base) => {
      const res = await fetch(`${base}/api/health`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { started: boolean; adapters: unknown[] };
      assert.equal(body.started, true);
      assert.equal(body.adapters.length, 1);
    });
  } finally {
    cleanup();
  }
});

test('panel /api/capture returns the captured event stream', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    await withPanel(dir, async (base) => {
      const res = await fetch(`${base}/api/capture`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { count: number; records: unknown[] };
      assert.ok(body.count >= 1); // lifecycle start at minimum
      assert.ok(Array.isArray(body.records));
    });
  } finally {
    cleanup();
  }
});

test('panel serves the read-only HTML page at /', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    await withPanel(dir, async (base) => {
      const res = await fetch(`${base}/`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /text\/html/);
      const html = await res.text();
      assert.match(html, /Pianoid Supervisor/);
    });
  } finally {
    cleanup();
  }
});

test('panel /api/session reports hosted:false when no session is hosted', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    await withPanel(dir, async (base) => {
      const res = await fetch(`${base}/api/session`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        hosted: boolean;
        pendingApprovals: unknown[];
        totalCostUsd: number;
        outputMode: string | null;
      };
      assert.equal(body.hosted, false);
      assert.deepEqual(body.pendingApprovals, []);
      assert.equal(typeof body.totalCostUsd, 'number');
      // ★ MODE-AWARENESS (dev-6ca1): outputMode is present in the loopback; null with no session.
      assert.equal(body.outputMode, null, 'outputMode is null when no session is hosted');
    });
  } finally {
    cleanup();
  }
});

test('panel POST /api/approve without a hosted session → 409', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    await withPanel(dir, async (base) => {
      const res = await fetch(`${base}/api/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ verdict: 'allow' }),
      });
      assert.equal(res.status, 409);
    });
  } finally {
    cleanup();
  }
});

test('panel rejects an unknown method (e.g. DELETE) with 405', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    await withPanel(dir, async (base) => {
      const res = await fetch(`${base}/api/health`, { method: 'DELETE' });
      assert.equal(res.status, 405);
    });
  } finally {
    cleanup();
  }
});

// ── D2: channel state + repair endpoints ──
test('★ D2: GET /api/channel/state returns adapters + recentDeliveries + pid', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    await withPanel(dir, async (base) => {
      const res = await fetch(`${base}/api/channel/state`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { pid: number; adapters: unknown[]; recentDeliveries: unknown[] };
      assert.equal(typeof body.pid, 'number');
      assert.equal(body.adapters.length, 1, 'the telegram adapter');
      assert.ok(Array.isArray(body.recentDeliveries));
    });
  } finally {
    cleanup();
  }
});

test('★ D2: POST /api/channel/reconnect re-establishes the transport (ok:true)', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    await withPanel(dir, async (base) => {
      const res = await fetch(`${base}/api/channel/reconnect`, { method: 'POST' });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { action: string; ok: boolean };
      assert.equal(body.action, 'reconnect');
      assert.equal(body.ok, true, 'loopback adapter reconnects');
    });
  } finally {
    cleanup();
  }
});

test('★ D2: POST /api/channel/flush returns ok + dropped count', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    await withPanel(dir, async (base) => {
      const res = await fetch(`${base}/api/channel/flush`, { method: 'POST' });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { ok: boolean; dropped: number };
      assert.equal(body.ok, true);
      assert.equal(typeof body.dropped, 'number');
    });
  } finally {
    cleanup();
  }
});

test('★ D2: POST /api/channel/kill-stale-sender reports the current sender pid + reconnects', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    await withPanel(dir, async (base) => {
      const res = await fetch(`${base}/api/channel/kill-stale-sender`, { method: 'POST' });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { action: string; currentSenderPid: number; reconnected: boolean };
      assert.equal(body.action, 'kill-stale-sender');
      assert.equal(body.currentSenderPid, process.pid);
    });
  } finally {
    cleanup();
  }
});

// ── ★ MODE-AWARENESS (dev-6ca1): /api/session exposes the hosted session's outputMode ──
test('★ MODE-AWARENESS: GET /api/session reports the hosted session outputMode (loopback query/recovery)', async () => {
  const { dir, cleanup } = tmpDir();
  const bus = new IoBus();
  const supervisor = new Supervisor({
    captureFile: join(dir, 'capture.ndjson'),
    logger: silentLogger(),
    unbufferedCapture: true,
  });
  // A hosted session parked at idle (system_init then awaitTurn), started in VOICE mode.
  const driver = new FakeSessionDriver([
    [{ do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } }, { do: 'awaitTurn' }],
  ]);
  const sessionHost = new SessionHost({
    driver,
    bus,
    logger: silentLogger(),
    send: async () => ({ ok: true, sentIds: ['1'] }) as OutboundResult,
    policy: { allow: ['Read'] },
    outputMode: 'voice',
  });
  await supervisor.start();
  const panel = new Panel({ port: 0, supervisor, logger: silentLogger(), sessionHost });
  await panel.start();
  const base = `http://127.0.0.1:${panel.boundPort}`;
  try {
    const res = await fetch(`${base}/api/session`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { hosted: boolean; outputMode: string | null };
    assert.equal(body.hosted, true, 'a session is hosted');
    assert.equal(body.outputMode, 'voice', 'the loopback exposes the current output mode');
  } finally {
    await panel.stop();
    await supervisor.stop();
    bus.close();
    cleanup();
  }
});
