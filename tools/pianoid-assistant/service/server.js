#!/usr/bin/env node
/**
 * The Pianoid assistant service (phase A1): 127.0.0.1:3002, spawned by the launcher.
 *   GET  /status   {ok, login, driver, paths, loginCommand}
 *   GET  /auth/status [?recheck=1]   {ok, login, flow}; POST /auth/login | /auth/login/code {code} |
 *                  /auth/login/cancel | /auth/logout {confirm: true}: the in-app subscription connect of the
 *                  isolated home (service/auth.js, dev-dc2a). POSTs: JSON only, from a localhost page or no page
 *   POST /internal/command/<name>   the executor of the service's own MCP server (v2 P2, autoWrite.js):
 *                  runs a command the policy just allowed (a permit), else 403 not_permitted
 *   GET  /artifacts/<id>/<file>   one file of an analysis artefact (the pane shows the PNGs; v2 P5)
 *   WS   /ws       the pane protocol: client {type: hello | turn | stop | confirm {id, allow, remember?} |
 *                  settings | approvals {category, mode, scope} | undo {groupId} | undo_turn {turn} |
 *                  plan_grant {id, accept, ticked} | plan_revoke (dev-28f1, ignored with PIANOID_ASSISTANT_PLAN_APPROVAL=0)};
 *                  server {type: state | message | delta | activity | confirm | confirm_done |
 *                  usage | model | escalation | busy | session | error | login | approvals}
 * Runs on the user's Claude SUBSCRIPTION in the isolated home (service/home.js); refuses to start
 * with an API key in its environment (D1). PIANOID_ASSISTANT_DRIVER=fake = zero-spend scripted
 * driver (tests, demos).
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { commandsDir, loadCommands } from '../lib/registry.js';
import { loadLimits, paramsDir } from '../lib/paramLimits.js';
import { SdkDriver } from '../drivers/sdk.js';
import { FakeDriver } from '../drivers/fake.js';
import { assertSubscriptionOnly, assistantPaths, ensureHome, loadConfig, loginCommand } from './home.js';
import { AuthManager, publicLogin } from './auth.js';
import { AssistantSession } from './session.js';
import { analysisPaths, artifactFile, CONTENT_TYPES, kindOf } from '../analysis/store.js';

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export function createAssistantService({
  env = process.env, port = Number(env.PIANOID_ASSISTANT_PORT) || 3002, driver = env.PIANOID_ASSISTANT_DRIVER || 'sdk',
  driverFactory = null, authOptions = {}, fetchImpl = fetch, settleMs,
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
  const analysis = analysisPaths(env);
  const session = new AssistantSession({
    analysis,
    paths, config: loadConfig(paths), commands: loadCommands(dir), driverFactory: factory, broadcast, fetchImpl,
    commandsDir: dir, backendUrl: env.PIANOID_BACKEND_URL || 'http://127.0.0.1:5000',
    launcherUrl: env.PIANOID_LAUNCHER_URL || 'http://127.0.0.1:3001', limits: loadLimits(paramsDir(env)), settleMs,
  });

  let login = null;
  const sendLogin = (ws) => ws.send(JSON.stringify({ type: 'login', login, loginCommand: loginCommand(paths, auth.cli) }));
  const auth = new AuthManager({
    paths, env, ...authOptions,
    onChange: (s) => { login = publicLogin(s); for (const ws of clients) if (ws.readyState === 1) sendLogin(ws); },
  });
  const checkLogin = () => {
    try {
      login = driver === 'fake' && !authOptions.cli ? { loggedIn: true, authMethod: 'fake' }
        : publicLogin(auth.status()) || { loggedIn: false, error: `The Claude Code CLI (${auth.cli.join(' ')}) failed to report its login status` };
    } catch (e) {
      login = { loggedIn: false, error: e.message };
    }
    return login;
  };
  const statusBody = () => ({
    ok: true, driver, login, paths: { root: paths.root, claudeHome: paths.claudeHome, workspace: paths.workspace },
    loginCommand: loginCommand(paths, auth.cli), busy: session.busy, model: session.model,
    session: session.sessionInfo || null,     // the runtime's own init: its tool list (isolation evidence)
    usage: session.usage,
  });

  const exec = (req, res, name) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      let out;
      try {
        out = await session.auto.exec(name, raw ? JSON.parse(raw) : {});
      } catch (e) {
        out = { status: 400, body: { ok: false, status: 400, error: 'bad_request', message: e.message } };
      }
      res.statusCode = out.status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(out.body));
    });
  };

  const authRoute = (req, res, route) => {
    const origin = req.headers.origin;
    if (origin && !LOCAL_ORIGIN.test(origin)) {
      res.statusCode = 403;
      return res.end();
    }
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.statusCode = 204;
      return res.end();
    }
    const reply = (status, body) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(body));
    };
    const run = (fn) => {
      try {
        reply(200, { ok: true, ...fn() });
      } catch (e) {
        reply(409, { ok: false, error: e.message, login, flow: auth.flowState() });
      }
    };
    if (route === 'status' && req.method === 'GET') {
      return run(() => {
        if (/[?&]recheck=1/.test(req.url) || !login) checkLogin();
        return { login, flow: auth.flowState() };
      });
    }
    // a POST must be JSON (a cross-site form cannot send it without a preflight, refused above)
    if (req.method !== 'POST' || !String(req.headers['content-type'] || '').startsWith('application/json')) return reply(405, { ok: false });
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch (e) { return reply(400, { ok: false, error: 'bad JSON' }); }
      if (route === 'login') return run(() => ({ flow: auth.login() }));
      if (route === 'login/code') return run(() => ({ flow: auth.submitCode(body.code) }));
      if (route === 'login/cancel') return run(() => ({ flow: auth.cancel() }));
      if (route === 'logout') {
        if (body.confirm !== true) return reply(400, { ok: false, error: 'logout needs {confirm: true}' });
        return run(() => ({ ...auth.logout(), login, flow: auth.flowState() }));
      }
      return reply(404, { ok: false });
    });
  };

  const server = http.createServer((req, res) => {
    const authUrl = /^\/auth\/(status|login|login\/code|login\/cancel|logout)(\?.*)?$/.exec(req.url || '');
    if (authUrl) return authRoute(req, res, authUrl[1]);
    const internal = /^\/internal\/command\/([\w.]+)$/.exec(req.url);
    if (internal && req.method === 'POST') {
      // the service's own MCP child only: no browser page (an Origin header) and JSON only (no CORS)
      if (req.headers.origin || !String(req.headers['content-type'] || '').startsWith('application/json')) {
        res.statusCode = 403;
        return res.end();
      }
      return exec(req, res, internal[1]);
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.url === '/status') {
      if (req.headers['x-recheck'] || !login) checkLogin();
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(statusBody()));
      return;
    }
    const m = /^\/artifacts\/([^/]+)\/([^/?]+)$/.exec(req.url || '');
    const file = m && artifactFile(analysis.artifacts, m[1], decodeURIComponent(m[2]));
    if (req.method === 'GET' && file) {
      res.setHeader('Content-Type', CONTENT_TYPES[kindOf(file)] || 'application/octet-stream');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      fs.createReadStream(file).pipe(res);
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
          checkLogin();
          ws.send(JSON.stringify(session.state()));
          sendLogin(ws);
        } else if (msg.type === 'turn' && typeof msg.text === 'string' && msg.text.trim()) {
          if (!(login || checkLogin())?.loggedIn) return sendLogin(ws);
          await session.turn(msg.text.trim());
        } else if (msg.type === 'stop') {
          await session.stop();
        } else if (msg.type === 'confirm') {
          session.confirm(msg.id, msg.allow, msg.remember);
        } else if (msg.type === 'settings') {
          await session.updateSettings(msg);
        } else if (msg.type === 'approvals') {
          session.updateApprovals(msg);
        } else if (msg.type === 'plan_grant') {
          session.answerPlan(msg);              // dev-28f1: ignored with PIANOID_ASSISTANT_PLAN_APPROVAL=0
        } else if (msg.type === 'plan_revoke') {
          session.revokePlan();
        } else if (msg.type === 'undo' && typeof msg.groupId === 'string') {
          await session.auto.undoGroup(msg.groupId);
        } else if (msg.type === 'undo_turn' && Number.isInteger(msg.turn)) {
          await session.auto.undoTurn(msg.turn);
        }
      } catch (e) {
        ws.send(JSON.stringify({ type: 'error', message: e?.message || String(e) }));
      }
    });
  });

  return {
    session, paths, server, auth,
    listen: () => new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
      session.execUrl = `http://127.0.0.1:${server.address().port}/internal/command`;
      session.publicUrl = `http://127.0.0.1:${server.address().port}`;   // the pane loads the plots from here
      resolve(server.address().port);
    })),
    close: async () => {
      auth.cancel();
      session.auto.stopWatches();
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
