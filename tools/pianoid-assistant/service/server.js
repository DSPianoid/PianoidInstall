#!/usr/bin/env node
/**
 * The Pianoid assistant service (phase A1): 127.0.0.1:3002, spawned by the launcher.
 *   GET  /status   {ok, login, driver, paths, loginCommand}
 *   WS   /ws       the pane protocol: client {type: hello | turn | stop | confirm | settings};
 *                  server {type: state | message | delta | activity | confirm | confirm_done |
 *                  usage | model | escalation | busy | session | error | login}
 * Runs on the user's Claude SUBSCRIPTION in the isolated home (service/home.js); refuses to start
 * with an API key in its environment (D1). PIANOID_ASSISTANT_DRIVER=fake = zero-spend scripted
 * driver (tests, demos).
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { commandsDir, loadCommands } from '../lib/registry.js';
import { SdkDriver } from '../drivers/sdk.js';
import { FakeDriver } from '../drivers/fake.js';
import { assertSubscriptionOnly, assistantPaths, authStatus, ensureHome, loadConfig, loginCommand } from './home.js';
import { AssistantSession } from './session.js';

export function createAssistantService({
  env = process.env, port = Number(env.PIANOID_ASSISTANT_PORT) || 3002, driver = env.PIANOID_ASSISTANT_DRIVER || 'sdk',
  driverFactory = null, authCheck = authStatus, fetchImpl = fetch,
} = {}) {
  assertSubscriptionOnly(env);
  const paths = ensureHome(assistantPaths(env));
  const dir = commandsDir(env);
  const clients = new Set();
  const broadcast = (msg) => {
    const data = JSON.stringify(msg);
    for (const ws of clients) if (ws.readyState === 1) ws.send(data);
  };
  const factory = driverFactory || (() => (driver === 'fake' ? new FakeDriver() : new SdkDriver()));
  const session = new AssistantSession({
    paths, config: loadConfig(paths), commands: loadCommands(dir), driverFactory: factory, broadcast, fetchImpl,
    commandsDir: dir, backendUrl: env.PIANOID_BACKEND_URL || 'http://127.0.0.1:5000',
    launcherUrl: env.PIANOID_LAUNCHER_URL || 'http://127.0.0.1:3001',
  });

  let login = null;
  const checkLogin = () => {
    login = driver === 'fake' ? { loggedIn: true, authMethod: 'fake' } : authCheck(paths);
    return login;
  };
  const statusBody = () => ({
    ok: true, driver, login, paths: { root: paths.root, claudeHome: paths.claudeHome, workspace: paths.workspace },
    loginCommand: loginCommand(paths), busy: session.busy, model: session.model,
    session: session.sessionInfo || null,     // the runtime's own init: its tool list (isolation evidence)
    usage: session.usage,
  });

  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.url === '/status') {
      if (req.headers['x-recheck'] || !login) checkLogin();
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(statusBody()));
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch (e) { return; }
      try {
        if (msg.type === 'hello') {
          const l = checkLogin();
          ws.send(JSON.stringify(session.state()));
          ws.send(JSON.stringify({ type: 'login', login: l, loginCommand: loginCommand(paths) }));
        } else if (msg.type === 'turn' && typeof msg.text === 'string' && msg.text.trim()) {
          if (!(login || checkLogin())?.loggedIn) {
            ws.send(JSON.stringify({ type: 'login', login, loginCommand: loginCommand(paths) }));
            return;
          }
          await session.turn(msg.text.trim());
        } else if (msg.type === 'stop') {
          await session.stop();
        } else if (msg.type === 'confirm') {
          session.confirm(msg.id, msg.allow);
        } else if (msg.type === 'settings') {
          await session.updateSettings(msg);
        }
      } catch (e) {
        ws.send(JSON.stringify({ type: 'error', message: e?.message || String(e) }));
      }
    });
  });

  return {
    session, paths, server,
    listen: () => new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server.address().port))),
    close: async () => {
      await session.restart().catch(() => {});
      for (const ws of clients) ws.terminate();
      wss.close();
      await new Promise((r) => server.close(r));
    },
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const svc = createAssistantService();
    const port = await svc.listen();
    console.log(`[assistant] listening on http://127.0.0.1:${port} (driver ${process.env.PIANOID_ASSISTANT_DRIVER || 'sdk'}, home ${svc.paths.root})`);
  } catch (e) {
    console.error(`[assistant] ${e.message}`);
    process.exit(1);
  }
}
