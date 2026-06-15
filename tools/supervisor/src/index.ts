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
import type { TelegramTransport } from './adapters/telegram-transport.js';

interface CliArgs {
  live: boolean;
  panelPort: number;
  /** Dev/test echo mode (host hook echoes inbound back). --echo or SUPERVISOR_ECHO=1. */
  echo: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let live = false;
  let panelPort = 0;
  let echo = process.env.SUPERVISOR_ECHO === '1';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--live') live = true;
    else if (argv[i] === '--echo') echo = true;
    else if (argv[i] === '--panel') panelPort = Number(argv[++i] ?? '0') || 0;
  }
  return { live, panelPort, echo };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig({ panelPort: args.panelPort });
  const logger = new Logger({ level: config.logLevel, filePath: config.logFile, component: 'supervisor' });

  // config carries only hasToken (never the secret) — safe to log.
  logger.info('supervisor starting (Phase 1)', {
    stateDir: config.stateDir,
    hasProductionToken: config.hasToken,
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

  // Host inbound hook. In Phase 1 there is no hosted session yet (Phase 2
  // replaces this with the real M1 session). Two modes:
  //   - DEFAULT: log inbound so the operator can see the shell working.
  //   - ECHO (dev/test, --echo or SUPERVISOR_ECHO=1): echo each inbound back
  //     through the adapter so a LIVE Telegram round-trip is demonstrable
  //     against a DEDICATED test bot (text + voice both directions).
  if (args.echo) {
    logger.warn('ECHO MODE (dev/test) — host hook echoes inbound back; NOT the real session');
    const echoHook = makeEchoHook(
      (channel, handle, msg) => supervisor.sendOutbound(channel, handle, msg),
      { onEcho: (note, fields) => logger.info(note, fields) },
    );
    supervisor.onInbound(echoHook);
  } else {
    supervisor.onInbound((msg) =>
      logger.info('inbound (no session hosted yet — Phase 2)', {
        channel: msg.channel,
        user: msg.user,
        hasText: !!msg.text,
        hasVoice: !!msg.voicePath,
      }),
    );
  }

  await supervisor.start();

  let panel: Panel | undefined;
  if (config.panelPort > 0) {
    panel = new Panel({ port: config.panelPort, supervisor, logger });
    await panel.start();
  }

  logger.info('supervisor ready', { ...supervisor.health() });

  const shutdown = async (sig: string): Promise<void> => {
    logger.info('shutting down', { signal: sig });
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
