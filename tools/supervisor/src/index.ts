#!/usr/bin/env node
/**
 * Supervisor CLI entrypoint (Phase 1).
 *
 * Wires: config → logger → Supervisor (bus + capture + registry) → Telegram
 * adapter → read-only panel, with graceful shutdown on SIGINT/SIGTERM.
 *
 * ⚠️ SAFETY — the LIVE grammY poller is OFF by default. Starting a getUpdates
 * poller on the production token would 409-sever the running orchestrator's own
 * Telegram channel (Telegram permits one poller per token). So this entrypoint:
 *   - With NO `--live`: registers the Telegram adapter on a LOOPBACK transport
 *     (no network) — the safe default; the supervisor shell runs, the bus +
 *     capture + panel work, nothing touches the live bot.
 *   - With `--live`: starts the REAL grammY transport, but ONLY against the
 *     token in `SUPERVISOR_TELEGRAM_TOKEN` (a DEDICATED/TEST token), NEVER the
 *     plugin's production `TELEGRAM_BOT_TOKEN`. If that dedicated token is
 *     absent it refuses to start a live poller and falls back to loopback.
 *
 * This guarantees the Phase-1 shell is runnable now without any risk to the
 * live channel; the production cut-over is a Phase-3 step.
 *
 * Usage:
 *   node dist/index.js                 # safe: loopback transport, panel optional
 *   node dist/index.js --panel 8790    # also serve the read-only panel
 *   node dist/index.js --live          # live grammY ONLY if SUPERVISOR_TELEGRAM_TOKEN set
 *   node dist/index.js --live --echo --panel 8790
 *                                      # connectivity test: echo inbound back (dev/test)
 *                                      # SUPERVISOR_ECHO=1 also enables echo
 */

import { openSync, writeSync } from 'node:fs';
import { loadConfig } from './config.js';
import { Logger } from './logger.js';
import { Supervisor } from './supervisor.js';
import { TelegramAdapter } from './adapters/telegram.js';
import { AccessGate } from './adapters/access-gate.js';
import { LoopbackTelegramTransport } from './adapters/loopback-transport.js';
import { GrammyTelegramTransport } from './adapters/grammy-transport.js';
import { VoiceCodec } from './voice.js';
import { Panel } from './panel.js';
import { resolveTransportDecision } from './transport-policy.js';
import { makeEchoHook } from './echo.js';
import { SessionHost } from './session-host.js';
import { SdkSessionDriver } from './adapters/sdk-session-driver.js';
import { PtySessionDriver } from './adapters/pty-session-driver.js';
import type { SessionDriver } from './session-driver.js';
import { resolveProfile, isDestructiveShellCommand } from './profiles.js';
import { loadMcpServers } from './mcp-config.js';
import { buildSupervisorChannelServer, SUPERVISOR_CHANNEL_SERVER_NAME, SUPERVISOR_CHANNEL_REPLY_TOOL } from './channel-tool.js';
import { ControllerBridge } from './controller-bridge.js';
import type { TelegramTransport } from './adapters/telegram-transport.js';

interface CliArgs {
  live: boolean;
  panelPort: number;
  /** Dev/test echo mode (host hook echoes inbound back). --echo or SUPERVISOR_ECHO=1. */
  echo: boolean;
  /** Phase 2: host a real Claude Code session as the inbound handler. --session or SUPERVISOR_SESSION=1. */
  session: boolean;
  /**
   * Phase 3a: which session profile to host — 'demo' (safe persona, route-most,
   * Phase-2 behavior) or 'orchestrator' (the REAL orchestrator: project context,
   * broad allow-list + safety floor, agent-teams, MCP wired, channel reply tool).
   * --profile <name> or SUPERVISOR_PROFILE. Default 'demo'.
   */
  profile: 'demo' | 'orchestrator';
  /**
   * Phase 3 (Option 3c): which SessionDriver backs the hosted session —
   *   'sdk' (DEFAULT) = the headless Agent SDK (structured stream-json, API-billed);
   *   'pty'           = the interactive `claude` TUI in node-pty (subscription-billed,
   *                     bounded render-parse output). The SDK driver stays the default +
   *                     instant fallback; --driver pty is validated via this flag + a live
   *                     smoke before the default is flipped. --driver <x> or SUPERVISOR_DRIVER.
   */
  driver: 'sdk' | 'pty';
}

function parseArgs(argv: string[]): CliArgs {
  let live = false;
  let panelPort = 0;
  let echo = process.env.SUPERVISOR_ECHO === '1';
  let session = process.env.SUPERVISOR_SESSION === '1';
  let profile: 'demo' | 'orchestrator' = process.env.SUPERVISOR_PROFILE === 'orchestrator' ? 'orchestrator' : 'demo';
  let driver: 'sdk' | 'pty' = process.env.SUPERVISOR_DRIVER === 'pty' ? 'pty' : 'sdk';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--live') live = true;
    else if (argv[i] === '--echo') echo = true;
    else if (argv[i] === '--session') session = true;
    else if (argv[i] === '--panel') panelPort = Number(argv[++i] ?? '0') || 0;
    else if (argv[i] === '--profile') profile = (argv[++i] === 'orchestrator' ? 'orchestrator' : 'demo');
    else if (argv[i] === '--driver') driver = (argv[++i] === 'pty' ? 'pty' : 'sdk');
  }
  return { live, panelPort, echo, session, profile, driver };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig({ panelPort: args.panelPort });
  const logger = new Logger({ level: config.logLevel, filePath: config.logFile, component: 'supervisor' });

  // config carries only the file-presence boolean (never the secret) — safe to log.
  logger.info('supervisor starting', {
    stateDir: config.stateDir,
    productionTokenFilePresent: config.productionTokenFilePresent,
    live: args.live,
    echo: args.echo,
    panelPort: config.panelPort,
  });

  const supervisor = new Supervisor({ captureFile: config.captureFile, logger });

  // Voice codec (degrades gracefully if the helper scripts are absent).
  const voice = new VoiceCodec({
    python: config.python,
    sttScript: config.sttScript,
    ttsScript: config.ttsScript,
    tmpDir: config.downloadDir,
  });

  // Pick the transport. SAFE DEFAULT = loopback. --live uses a DEDICATED token
  // only (never the production token).
  const transport = resolveTransport(args.live, logger);
  const gate = new AccessGate({ accessFile: config.accessFile });

  const telegram = new TelegramAdapter({
    transport,
    gate,
    queueDir: config.telegramQueueDir,
    voice,
    downloadDir: config.downloadDir,
  });
  supervisor.register(telegram);

  // Host inbound hook — pick ONE of three modes (precedence: session > echo > log):
  //   - SESSION (Phase 2, --session / SUPERVISOR_SESSION=1): host a REAL Claude
  //     Code session via the SDK; inbound → session turns, session output →
  //     channel, permission decisions routed over the channel (FC-1).
  //   - ECHO (dev/test, --echo): echo inbound back (connectivity test).
  //   - DEFAULT: log inbound so the operator can see the shell working.
  let sessionHost: SessionHost | undefined;
  if (args.session) {
    const profile = resolveProfile(args.profile);
    logger.info(`SESSION MODE — hosting a Claude Code session (profile: ${profile.name}, driver: ${args.driver})`, {
      teams: profile.agentTeams,
      settingSources: profile.settingSources,
      roleBootstrap: profile.roleBootstrap,
      driver: args.driver,
    });

    // Phase-3 (3c) driver selection. SDK = default (structured stream, API-billed,
    // already validated). PTY = interactive TUI (subscription-billed, bounded
    // render-parse). The SDK driver stays the instant fallback; --driver pty is
    // validated via a live smoke before we flip the default.
    // Opt-in RAW render capture (diagnostics): when SUPERVISOR_RAW_CAPTURE=<path> is set,
    // every node-pty render chunk is appended to that file. Lets us capture the EXACT
    // rendered bytes of an intermittent TUI gate (e.g. the $()-subexpression security
    // prompt) from a LIVE session to tune the grid detector. Off by default → zero impact.
    const rawCapturePath = process.env.SUPERVISOR_RAW_CAPTURE;
    let onRaw: ((chunk: string) => void) | undefined;
    if (args.driver === 'pty' && rawCapturePath) {
      const fd = openSync(rawCapturePath, 'a');
      onRaw = (chunk: string): void => {
        try {
          writeSync(fd, chunk);
        } catch {
          /* best-effort diagnostic sink */
        }
      };
      logger.warn(`RAW render capture ENABLED → ${rawCapturePath} (diagnostics; never the token)`);
    }
    const sessionDriver: SessionDriver =
      args.driver === 'pty'
        ? new PtySessionDriver(
            // ORCHESTRATOR-only pre-allow for the `$()` command-substitution security
            // gate: auto-answer it for the orchestrator's OWN routine startup commands
            // (NOT destructive) so the state-dependent gate can't hang the startup; a
            // destructive `$()` command still routes through the safety floor. The demo
            // profile gets no auto-allow (every gate routes).
            {
              ...(profile.name === 'orchestrator'
                ? {
                    autoAllowSubexpr: (toolName: string, input: Record<string, unknown>): boolean => {
                      if (toolName !== 'Bash' && toolName !== 'PowerShell') return false;
                      const cmd = String((input['command'] ?? input['cmd'] ?? '') as string);
                      return !isDestructiveShellCommand(cmd);
                    },
                    // CONTAINMENT SEAL: the hosted orchestrator is a REAL claude child that
                    // loads the full ~/.claude.json → without sealing it can reach the user's
                    // PRODUCTION telegram plugin (an isolation breach, observed live). The seal
                    // (--strict-mcp-config + curated --mcp-config + disable the telegram plugin
                    // + deny its tools) forces the orchestrator to reach the user via plain
                    // assistant text, which the supervisor forwards to the TEST bot.
                    sealContainment: true,
                  }
                : {}),
              ...(onRaw ? { onRaw } : {}),
            },
          )
        : new SdkSessionDriver();

    // Build the MCP server map for the orchestrator profile: the in-process channel
    // reply tool + the project's servers (from ~/.claude.json, minus telegram).
    let mcpServers: Record<string, unknown> | undefined;
    if (profile.wireProjectMcp) {
      mcpServers = { ...loadMcpServers() };
      const channelServer = await buildSupervisorChannelServer(async (text) => {
        const operator = sessionHost?.currentOperator();
        if (!operator) return { ok: false };
        const r = await supervisor.sendOutbound('telegram', operator, { text });
        return { ok: r.ok };
      });
      if (channelServer) mcpServers[SUPERVISOR_CHANNEL_SERVER_NAME] = channelServer;
    }

    // System prompt: orchestrator → preset 'claude_code' + the supervisor preamble;
    // demo → the SUPERVISOR_SYSTEM_PROMPT persona string (Phase-2 behavior).
    const systemPrompt =
      profile.name === 'orchestrator'
        ? { preset: 'claude_code' as const, append: profile.systemPromptAppend }
        : process.env.SUPERVISOR_SYSTEM_PROMPT;

    sessionHost = new SessionHost({
      driver: sessionDriver,
      bus: supervisor.bus,
      logger,
      send: (handle, msg) => supervisor.sendOutbound('telegram', handle, msg),
      // Profile-driven policy (demo = config default / route-most; orchestrator =
      // broad allow-list + the safety-floor route predicate).
      policy: profile.name === 'orchestrator' ? profile.policy : config.permissionPolicy,
      systemPrompt,
      cwd: process.cwd(),
      settingSources: profile.settingSources,
      mcpServers,
      disallowedTools: profile.policy.deny,
      allowedTools: profile.policy.allow,
      permissionMode: 'default',
      env: profile.agentTeams ? { ...process.env, CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' } : undefined,
      // Role-adoption prefix applied to the FIRST user turn (NOT a pre-user
      // bootstrap turn — see SessionHostOptions.roleTurnPrefix; live-surfaced fix).
      roleTurnPrefix: profile.roleBootstrap === 'orchestrator-skill' ? '/orchestrator' : undefined,
      // Per-turn de-dup: orchestrator profile (has the reply tool) → auto-out the
      // final answer UNLESS the reply tool fired this turn. Demo → no reply tool.
      replyToolName: profile.suppressAutoOutbound ? SUPERVISOR_CHANNEL_REPLY_TOOL : undefined,
    });
    supervisor.onInbound(sessionHost.handleInbound);
  } else if (args.echo) {
    logger.warn('ECHO MODE (dev/test) — host hook echoes inbound back; NOT the real session');
    const echoHook = makeEchoHook(
      (channel, handle, msg) => supervisor.sendOutbound(channel, handle, msg),
      { onEcho: (note, fields) => logger.info(note, fields) },
    );
    supervisor.onInbound(echoHook);
  } else {
    supervisor.onInbound((msg) =>
      logger.info('inbound (no session hosted — use --session to host one)', {
        channel: msg.channel,
        user: msg.user,
        hasText: !!msg.text,
        hasVoice: !!msg.voicePath,
      }),
    );
  }

  await supervisor.start();
  if (sessionHost) await sessionHost.start();

  // CONTROLLER BRIDGE (Phase 3a, additive): route M6 signals through the captured
  // bus. Observes stall/restart/lifecycle events from the bus and surfaces them as
  // structured controller signals — additive to (not a replacement for) the
  // log-scraping controller.
  const controllerBridge = new ControllerBridge({
    bus: supervisor.bus,
    onSignal: (sig) => logger.info('controller signal', { kind: sig.kind, seq: sig.seq }),
  });
  controllerBridge.start();

  let panel: Panel | undefined;
  if (config.panelPort > 0) {
    panel = new Panel({ port: config.panelPort, supervisor, logger, sessionHost, controllerBridge });
    await panel.start();
  }

  logger.info('supervisor ready', { ...supervisor.health() });

  const shutdown = async (sig: string): Promise<void> => {
    logger.info('shutting down', { signal: sig });
    if (sessionHost) await sessionHost.stop();
    if (panel) await panel.stop();
    await supervisor.stop();
    await logger.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

/**
 * Resolve the Telegram transport from the PURE policy decision
 * (`resolveTransportDecision`). The decision sees only `--live` + the DEDICATED
 * `SUPERVISOR_TELEGRAM_TOKEN` — never the production `TELEGRAM_BOT_TOKEN` — so a
 * live poller can only ever start on the dedicated token (reviews TG2/TG3).
 */
function resolveTransport(live: boolean, logger: Logger): TelegramTransport {
  const decision = resolveTransportDecision({
    live,
    dedicatedToken: process.env.SUPERVISOR_TELEGRAM_TOKEN,
  });
  if (decision.refusedLive) logger.warn(`telegram: ${decision.reason}`);
  else logger.info(`telegram: ${decision.reason}`);
  if (decision.kind === 'grammy') {
    return new GrammyTelegramTransport({ token: decision.token! });
  }
  return new LoopbackTelegramTransport();
}

main().catch((err) => {
  process.stderr.write(`supervisor: fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
