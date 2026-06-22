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

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { CliStreamDriver } from './adapters/cli-stream-driver.js';
import { resolveDriverSelection, type DriverName } from './driver-policy.js';
import type { SessionDriver } from './session-driver.js';
import { resolveProfile } from './profiles.js';
import { assertCostSafe } from './cost-safety.js';
import { loadMcpServers, HOSTED_MCP_EXCLUDE_SUBSTRINGS } from './mcp-config.js';
import { buildSupervisorChannelServer, SUPERVISOR_CHANNEL_SERVER_NAME, SUPERVISOR_CHANNEL_REPLY_TOOL } from './channel-tool.js';
import { ControllerBridge } from './controller-bridge.js';
import type { TelegramTransport } from './adapters/telegram-transport.js';
// ★ P6 — model-agnostic agent routing (DORMANT unless SUPERVISOR_ROLE_ROUTING is ON). All of the
// machinery below was built + unit-tested in P0–P5/Q; index.ts is the ONLY composition-root edit
// (the activation cut-over). NONE of these are constructed when the switch is OFF (the default).
import { SecretStore, defaultSecretStorePath } from './secret-store.js';
import { RoleRoutingStore, defaultRoleRoutingStorePath } from './role-routing-store.js';
import { BackendRegistry } from './backend-registry.js';
import { dispatchRoleAgentWithFallback } from './result-relay.js';
import { mergeRoleRoutingOverrides, resolveRoleBackend, DEFAULT_ROLE_ROUTING_CONFIG } from './role-router.js';
import { DEFAULT_API_ADAPTER_CONFIGS } from './api-adapter-driver.js';
import { AgentConcurrencyGate } from './agent-concurrency.js';
// ★ T3 — model-agnostic-ORCHESTRATOR teams-replacement wiring (DORMANT; SAME SUPERVISOR_ROLE_ROUTING
// gate as the dispatch closure above). The async registry turns the sealed dispatchRoleAgent closure
// into a "run several + observe" surface for the operator panel's async coordinate routes; ABSENT when
// the switch is OFF ⇒ the Panel ctor-args are byte-for-byte today. The tool-runner choke-point factory
// (createOrchestratorToolRunner) is the runTool a non-Claude orchestrator driver gets at T4 — it is NOT
// constructed in the live path here (the live orchestrator still runs cli-stream/Claude).
import { AsyncDispatchRegistry } from './async-dispatch-registry.js';
import { resolveDeepseekKeyFromMcpConfig, DEEPSEEK_SECRET_ENV_VAR } from './deepseek-key-bridge.js';
import type { RoleDispatchFn, RoleDispatchResult, RestartIntent, RestartControlResult } from './session-host.js';

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
   * Which SessionDriver backs the hosted session. Both are STRUCTURED + run on the
   * user's Claude SUBSCRIPTION (see the cost-safety guard):
   *   'cli-stream' = `claude -p --output-format stream-json` — exposes AGENT-TEAMS
   *                  (SendMessage/Monitor/Task*) which the orchestrator skill requires;
   *                  the ORCHESTRATOR profile DEFAULTS to this.
   *   'sdk'        = the in-process Agent SDK `query()` — lighter, in-process channel
   *                  reply tool + canUseTool router, but does NOT expose agent-teams;
   *                  the DEMO profile defaults to this. Selectable for non-team use.
   * Precedence: --driver / SUPERVISOR_DRIVER (explicit) > the profile's default. The
   * PTY/TUI screen-scrape driver was RETIRED (2026-06-17 review). Here this carries
   * the resolved driver for non-session paths; the session block re-resolves with the
   * profile default folded in (see resolveDriverSelection).
   */
  driver: DriverName;
  /** The raw explicit --driver argv value (undefined if not passed) — for profile-aware re-resolution. */
  argvDriver?: string;
}

function parseArgs(argv: string[]): CliArgs {
  let live = false;
  let panelPort = 0;
  let echo = process.env.SUPERVISOR_ECHO === '1';
  let session = process.env.SUPERVISOR_SESSION === '1';
  let profile: 'demo' | 'orchestrator' = process.env.SUPERVISOR_PROFILE === 'orchestrator' ? 'orchestrator' : 'demo';
  let argvDriver: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--live') live = true;
    else if (argv[i] === '--echo') echo = true;
    else if (argv[i] === '--session') session = true;
    else if (argv[i] === '--panel') panelPort = Number(argv[++i] ?? '0') || 0;
    else if (argv[i] === '--profile') profile = (argv[++i] === 'orchestrator' ? 'orchestrator' : 'demo');
    else if (argv[i] === '--driver') argvDriver = argv[++i];
  }
  // Provisional resolution (no profile default yet — the session block re-resolves
  // with profile.defaultDriver folded in). Explicit --driver/env still wins there.
  const driver = resolveDriverSelection({ argvDriver, envDriver: process.env.SUPERVISOR_DRIVER });
  return { live, panelPort, echo, session, profile, driver, argvDriver };
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
  // ★ T3 — the async dispatch registry (teams-replacement). Declared in the OUTER scope (like
  // sessionHost) so it is in scope at the Panel construction below; ASSIGNED inside the role-routing
  // block only. Stays `undefined` when SUPERVISOR_ROLE_ROUTING is OFF (the default) so the Panel ctor
  // omits it via conditional-spread = byte-for-byte today.
  let asyncDispatchRegistry: AsyncDispatchRegistry | undefined;
  // D4 tier-b handler — assigned in the session branch (closes over sessionHost+supervisor).
  let handleUnresponsive: (reason: string) => Promise<void> = async () => undefined;
  if (args.session) {
    const profile = resolveProfile(args.profile);
    // DRIVER SELECTION (the single construction site). Precedence: explicit
    // --driver/SUPERVISOR_DRIVER > the profile's default. The orchestrator profile
    // defaults to 'cli-stream' (`claude -p`) — the ONLY backend that exposes
    // agent-teams (SendMessage/Monitor/Task*), which the orchestrator skill requires.
    // Demo defaults to 'sdk'. (PTY/TUI scraper RETIRED 2026-06-17.)
    const driver = resolveDriverSelection({
      argvDriver: args.argvDriver,
      envDriver: process.env.SUPERVISOR_DRIVER,
      profileDefault: profile.defaultDriver,
    });
    logger.info(`SESSION MODE — hosting a Claude Code session (profile: ${profile.name}, driver: ${driver}, model: ${profile.model ?? 'driver-default'})`, {
      teams: profile.agentTeams,
      settingSources: profile.settingSources,
      roleBootstrap: profile.roleBootstrap,
      driver,
      model: profile.model,
    });

    // ★ COST-SAFETY GUARD (the user's hard constraint, made structural): both drivers
    // authenticate via the user's Claude SUBSCRIPTION OAuth login UNLESS an Anthropic
    // API key is present in the env the child inherits — in which case the child would
    // bill the pay-per-token Platform API. The supervisor never SETS such a key and
    // never injects one into query()/`claude -p`; this asserts the inherited env is
    // also key-free and FAILS FAST (loud) rather than silently spawning a billed child.
    assertCostSafe(process.env);
    logger.info('cost-safety: env is key-free → hosted session bills the Claude subscription (no ANTHROPIC_API_KEY)');

    const sessionDriver: SessionDriver =
      driver === 'cli-stream'
        ? new CliStreamDriver({
            onStderr: (line) => logger.warn(`cli-stream stderr: ${line}`),
          })
        : new SdkSessionDriver();

    // The in-process channel reply tool (createSdkMcpServer) can ONLY be wired into the
    // SDK driver (it runs in THIS process). A `claude -p` CHILD process can't receive
    // it — so under cli-stream the orchestrator reaches the user via AUTO-FORWARDED
    // assistant text (+ tool_result/error forwarding), and there is no reply tool.
    const useInProcessReplyTool = profile.wireProjectMcp && driver === 'sdk';

    // Build the MCP server map for the orchestrator profile: the project's servers
    // (from ~/.claude.json) MINUS only telegram (the channel-hijack vector — the prod
    // plugin would seize the getUpdates token). The user chose to give the LIVE hosted
    // orchestrator WhatsApp ("reading allowed, sending approval-gated"), Email, and
    // DeepSeek-codegen, so BOTH whatsapp servers + hostinger-email + deepseek-codegen are
    // KEPT in the map; the per-tool POLICY (profiles.ts) then ALLOWS whatsapp READ tools
    // and ROUTES whatsapp/email SEND tools to the user for approval (deny-list still hard-
    // blocks telegram). The in-process reply tool is added ONLY for the SDK driver.
    // ★ This map is now consumed by BOTH drivers: the SDK driver reads it as
    // options.mcpServers; the cli-stream (`claude -p`) driver writes it to a private 0600
    // --mcp-config temp file (cli-stream-driver.writeMcpConfigFile) — necessary because the
    // hosted child runs settingSources ['project','local'] (NOT 'user'), so the user-scope
    // ~/.claude.json mcpServers do NOT auto-load (the child would otherwise see ZERO servers).
    // (The earlier assumption that cli-stream loads MCP from settingSources was wrong.)
    let mcpServers: Record<string, unknown> | undefined;
    if (profile.wireProjectMcp) {
      mcpServers = { ...loadMcpServers({ excludeSubstrings: HOSTED_MCP_EXCLUDE_SUBSTRINGS }) };
      if (useInProcessReplyTool) {
        const channelServer = await buildSupervisorChannelServer(async (text) => {
          const operator = sessionHost?.currentOperator();
          if (!operator) return { ok: false };
          // The reply tool is the orchestrator's SUBSTANTIVE reply → honor the current
          // output modality (text/voice/dual), same as the auto-outbound path.
          const modality = sessionHost?.outputModeState() ?? 'text';
          const r = await supervisor.sendOutbound('telegram', operator, { text, options: { modality } });
          return { ok: r.ok };
        });
        if (channelServer) mcpServers[SUPERVISOR_CHANNEL_SERVER_NAME] = channelServer;
      }
    }

    // System prompt: orchestrator → preset 'claude_code' + the supervisor preamble +
    // the generic machine-global methodology. We DROP the 'user' setting source
    // (containment: it would load the prod telegram PLUGIN, which seizes the user's
    // token) — so the user-scope ~/.claude/CLAUDE.md methodology is no longer
    // auto-loaded; fold it into the append here so the orchestrator keeps its rules.
    // (project+local still load the project CLAUDE.md + the /orchestrator skill.)
    // demo → the SUPERVISOR_SYSTEM_PROMPT persona string (Phase-2 behavior).
    let systemPrompt: string | { preset: 'claude_code'; append?: string } | undefined;
    if (profile.name === 'orchestrator') {
      // Substitute the concrete panel URL into the preamble's SUPERVISOR_PANEL_URL token
      // (D1/D2 — the orchestrator curls it for /channel-check + repair).
      const panelUrl = config.panelPort > 0 ? `http://127.0.0.1:${config.panelPort}` : 'the loopback panel (no --panel port set)';
      let append = profile.systemPromptAppend.replace(/SUPERVISOR_PANEL_URL/g, panelUrl).replace(/<panel>/g, panelUrl);
      const generic = readGenericMethodology(logger);
      if (generic) {
        append += `\n\n--- MACHINE-GLOBAL METHODOLOGY (from ~/.claude/CLAUDE.md; auto-loaded here because the 'user' setting source is excluded for containment) ---\n${generic}`;
      }
      systemPrompt = { preset: 'claude_code', append };
    } else {
      systemPrompt = process.env.SUPERVISOR_SYSTEM_PROMPT;
    }

    // ★ P6 — MODEL-AGNOSTIC ROLE-ROUTING ACTIVATION (switch-gated; the cut-over).
    // When SUPERVISOR_ROLE_ROUTING is OFF (the DEFAULT — config.roleRoutingEnabled === false),
    // ALL FOUR locals below stay `undefined`, so the SessionHost is constructed EXACTLY as before
    // this feature existed: `/setkey`/`/setrole`/`/roles` are NOT intercepted (their interception is
    // gated on a wired store) and `dispatchRole()` returns {enabled:false}. The OFF path is therefore
    // byte-for-byte today. When ON, we wire: the gitignored scoped secret store (Q.2/`/setkey`), the
    // gitignored role-routing override store (Q.5/`/setrole`+`/roles`), the message-delete hook (so
    // `/setkey` can scrub the plaintext-key message), and the routed-dispatch capability (FD1) — a
    // closure that loads the persisted overrides, projects the stored provider keys into the dispatch
    // env (scoped-key loading at spawn), and runs result-relay's fallback dispatcher.
    let secretStore: SecretStore | undefined;
    let roleRoutingStore: RoleRoutingStore | undefined;
    let deleteMessage: ((handle: import('./contract.js').ReplyHandle, messageId: string) => Promise<void>) | undefined;
    let dispatchRoleAgent: RoleDispatchFn | undefined;
    if (config.roleRoutingEnabled) {
      // The supervisor PACKAGE root (tools/supervisor) — where the gitignored `.state/` dir lives.
      // Derived from this compiled module's location (dist/index.js → up one), cwd-independent.
      const supervisorRoot = dirname(dirname(fileURLToPath(import.meta.url)));
      secretStore = new SecretStore({
        filePath: defaultSecretStorePath(supervisorRoot),
        onNote: (line) => logger.info(line), // masked-only diagnostics (never a key value)
      });
      roleRoutingStore = new RoleRoutingStore({
        filePath: defaultRoleRoutingStorePath(supervisorRoot),
        onNote: (line) => logger.info(line),
      });
      // The plaintext-key message delete used by `/setkey` (best-effort).
      deleteMessage = (handle, messageId) => supervisor.deleteMessage('telegram', handle, messageId);
      // ★ FD1 — the routed-dispatch capability. ONE backend registry; the api-adapter env is the
      // PROCESS env OVERLAID with the scoped provider keys from the secret store (each provider's
      // key under its own secretEnvVar) → an api-adapter agent gets ONLY its provider's key and the
      // backend-aware seal rejects every foreign key. The persisted role-routing overrides are merged
      // over DEFAULT_ROLE_ROUTING_CONFIG per dispatch (so a `/setrole` change takes effect on the NEXT
      // dispatch, no restart). dispatchRoleAgentWithFallback runs the primary + (FD6) one fallback.
      const registry = new BackendRegistry();
      const storeForDispatch = secretStore;
      const routingForDispatch = roleRoutingStore;
      // ★ P-C1 ENFORCEMENT — ONE spend gate for the routed-dispatch path (the choke-point). The two USD
      // caps + the rolling window length come from config; BOTH caps default 0 = UNLIMITED, so with no
      // caps set the gate admits every dispatch (estCost is checked against 0 ⇒ never breaches) = byte-
      // for-byte today. The gate is the sole owner of the rolling spend ledger (P1); the closure
      // tryAcquire()s per dispatch and passes the lease through so result-relay charges the REAL cost.
      const spendGate = new AgentConcurrencyGate({
        ...(config.dispatchCostCapUsd > 0 ? { dispatchCostCapUsd: config.dispatchCostCapUsd } : {}),
        ...(config.dispatchCostWindowUsd > 0 ? { dispatchCostWindowUsd: config.dispatchCostWindowUsd } : {}),
      });
      const estCostUsd = config.dispatchEstCostUsd; // conservative per-dispatch estimate (default 0)
      dispatchRoleAgent = async (role: string, task: string): Promise<RoleDispatchResult> => {
        // Project the stored provider keys into the dispatch env (scoped-key loading at spawn).
        const apiAdapterEnv: NodeJS.ProcessEnv = { ...process.env, ...storeForDispatch.loadAll() };
        const overrides = routingForDispatch.loadAll();
        const merged = mergeRoleRoutingOverrides(overrides, DEFAULT_ROLE_ROUTING_CONFIG);
        // The own-secret name for the RESOLVED selection (covers BOTH a /setrole override AND a
        // default-map api-adapter role like coding/reviewing): resolve the role → if it lands on an
        // api-adapter backend, look its model up in the registry-derived config map to read that
        // provider's secretEnvVar. claude-cli selections carry no own secret (subscription-billed) →
        // undefined, so the seal asserts the env is fully key-free. This is what lets the seal scope
        // the foreign-key assertion to ONLY this backend's key (rather than rejecting its own).
        const selection = resolveRoleBackend(role, merged);
        const ownSecretName =
          selection.backend === 'api-adapter' && selection.model
            ? DEFAULT_API_ADAPTER_CONFIGS[selection.model]?.secretEnvVar
            : undefined;

        // ★ DEEPSEEK KEY BRIDGE (default-OFF) — when the resolved backend is the DeepSeek api-adapter
        // AND the sealed /setkey store has NO DeepSeek key, FALL BACK to the deepseek-codegen MCP's key
        // (narrow user-scope ~/.claude.json read; see deepseek-key-bridge.ts containment header). The
        // sealed store ALWAYS wins (we only bridge when it has none). The key is injected into THIS
        // dispatch's env ONLY when ownSecretName IS the DeepSeek key — so the seal's "only your own key"
        // invariant holds (no foreign key reaches a non-DeepSeek agent). OFF ⇒ no read, no injection.
        if (
          config.deepseekKeyBridge &&
          ownSecretName === DEEPSEEK_SECRET_ENV_VAR &&
          !storeForDispatch.has(DEEPSEEK_SECRET_ENV_VAR)
        ) {
          const bridged = resolveDeepseekKeyFromMcpConfig({ onNote: (line) => logger.info(line) });
          if (bridged) apiAdapterEnv[DEEPSEEK_SECRET_ENV_VAR] = bridged; // scoped to this DeepSeek dispatch only
        }

        // ★ P-C1 ENFORCEMENT — ADMISSION: try to acquire a spend slot with the per-dispatch estimate.
        // On a breach (per-dispatch or rolling cap) REFUSE with a CLEAN surfaced result — never a crash/
        // wedge (CP4/CP5). With caps 0 this always admits (byte-for-byte today).
        const acq = spendGate.tryAcquire(0, estCostUsd);
        if (!acq.ok) {
          const reason =
            acq.reason === 'dispatch-cost-cap'
              ? `per-dispatch cost cap $${config.dispatchCostCapUsd.toFixed(2)} (est $${estCostUsd.toFixed(2)})`
              : acq.reason === 'dispatch-cost-window'
                ? `rolling spend cap $${config.dispatchCostWindowUsd.toFixed(2)} reached (spent $${spendGate.spentCostUsd.toFixed(4)})`
                : `concurrency/budget (${acq.reason ?? 'unknown'})`;
          logger.warn('routed dispatch REFUSED by spend cap', { role, reason: acq.reason });
          return {
            ok: false,
            role: String(role),
            backend: selection.backend,
            fellBack: false,
            text: `refused: spend cap — ${reason}. Set a higher SUPERVISOR_DISPATCH_COST_* cap or wait for the window to reset.`,
          };
        }

        const report = await dispatchRoleAgentWithFallback({
          role,
          task,
          registry,
          config: merged,
          env: apiAdapterEnv,
          ...(ownSecretName ? { ownSecretName } : {}),
          // ★ P-C1 — pass the lease so the dispatcher RELEASES it with the REAL tokens + costUsd
          // (result-relay.ts release(reportTokensUsed, report.costUsd)); idempotent → safe on crash.
          lease: acq.lease!,
        });
        const result: RoleDispatchResult = {
          ok: report.ok,
          role: String(report.role),
          backend: report.backend,
          fellBack: report.fallback.used,
        };
        if (report.text !== undefined) result.text = report.text;
        if (report.costUsd !== undefined) result.costUsd = report.costUsd;
        return result;
      };

      // ★ T3 — the async dispatch registry (teams-replacement). It wraps the SAME sealed
      // `dispatchRoleAgent` closure just built (its EXACT role-router + backend seal + the
      // AgentConcurrencyGate spend/cost cap) into a non-blocking "run several + observe" surface.
      // The Panel's async coordinate routes (POST /api/dispatch/async · GET status · POST await ·
      // POST cancel) read it; a non-Claude orchestrator (T4) reaches it via the tool-runner
      // choke-point (createOrchestratorToolRunner over `sessionHost.permissionRouter.decide`). It
      // adds NO new spend authority (the gate inside the executor stays the sole ledger) and NO
      // channel reach (the dispatched agents are channel-mute — AP6). Built ONLY here under the
      // role-routing gate; OFF ⇒ undefined ⇒ the Panel ctor omits it (byte-for-byte today).
      asyncDispatchRegistry = new AsyncDispatchRegistry({ executor: dispatchRoleAgent });

      logger.info('ROLE-ROUTING ACTIVE (SUPERVISOR_ROLE_ROUTING on) — /setkey + /setrole + /roles wired; routed dispatch enabled', {
        secretStore: secretStore.path,
        roleRoutingStore: roleRoutingStore.path,
        spendCapPerDispatchUsd: config.dispatchCostCapUsd,
        spendCapWindowUsd: config.dispatchCostWindowUsd,
        deepseekKeyBridge: config.deepseekKeyBridge,
        asyncDispatchRegistry: true,
      });
    }

    // ★ OPERATOR CONTROL PLANE ACTIVATION (Parts A1–A5) — the `/control` menu's injected
    // capabilities. UNLIKE P6 these are NOT gated on SUPERVISOR_ROLE_ROUTING: the control plane is
    // GENERAL supervisor control (proposal §6 "Activation": "Part A's control plane is live as soon
    // as the matcher ships"), so the deps wire UNCONDITIONALLY for the hosted session here. They
    // COEXIST with the P6 block above (no overlap — different opts). Each is an ADDITIVE optional
    // ctor opt (the proven P6 conditional-spread); unwired ⇒ the action reports "not available".
    // HOST-SAFETY: wiring them does NOT itself touch the live host — they fire only when the operator
    // taps an action AFTER the user-triggered restart loads this build.
    //   • reconnect / flush / log → the SAME supervisor methods the loopback panel exposes
    //     (panel.ts /api/channel/{reconnect,flush} + /api/capture) — supervisor-owned, child-independent.
    //   • restart (restart/kill/clear/resume/change-model) → a closure over the EXISTING audited
    //     restart machinery (SessionHost.requestRestart's confirm/rate-limit/audit graceful path, or
    //     clearContext for a clean slate) — it does NOT bypass the safety gate; the LifecycleManager
    //     stays the sole restart EXECUTOR. change-model additionally sets the next-launch Tier-1 model
    //     (setOrchestratorModel) before the restart so context carries across the switch (drain+handoff).
    //   • interrupt → SessionHost.interruptCurrentTurn() (→ lifecycle.interruptTurn → driver.interrupt):
    //     stop the in-flight turn WITHOUT killing the process.
    // restartControl + interruptTurn close over `sessionHost` (assigned just below) — read lazily at
    // tap-time, exactly like the handleUnresponsive closure further down (never called during construction).
    const reconnectChannelControl = (): Promise<{ ok: boolean; error?: string }> =>
      supervisor.reconnectChannel('telegram');
    const flushChannelControl = (): { ok: boolean; dropped?: number; error?: string } =>
      supervisor.flushChannel('telegram');
    const captureRecentControl = () => supervisor.captureStore.replay();
    const restartControl = async (intent: RestartIntent): Promise<RestartControlResult> => {
      const host = sessionHost;
      if (!host) return { ok: false, detail: 'session not ready' };
      // `clear` = a clean slate (no confirm, no handoff) — the panel /api/clear path.
      if (intent.kind === 'clear') {
        await host.clearContext();
        return { ok: true, detail: 'context cleared (fresh slate)' };
      }
      // change-model: set the next-launch Tier-1 model BEFORE the restart (drain + handoff so the
      // conversation carries across the switch).
      if (intent.kind === 'change-model' && intent.model) {
        host.setOrchestratorModel(intent.model);
      }
      // restart / kill / resume / change-model → the EXISTING audited graceful restart (user-confirm
      // + rate-limit + handoff re-inject). The menu already confirmed; this is the lifecycle's own
      // safety gate (CP7) — intentionally NOT bypassed.
      const reason =
        intent.kind === 'change-model'
          ? `operator change-model${intent.model ? ` → ${intent.model}` : ''}`
          : `operator ${intent.kind}`;
      const outcome = host.requestRestart(reason, intent.handoff);
      if (outcome.status === 'queued') return { ok: true, detail: 'restart queued (awaiting your confirm)' };
      if (outcome.status === 'rate_limited') {
        return { ok: false, detail: `rate-limited — retry in ~${Math.round(outcome.retryAfterMs / 1000)}s` };
      }
      return { ok: false, detail: 'a restart confirm is already in flight' };
    };
    const interruptTurnControl = (): Promise<void> => {
      const host = sessionHost;
      if (!host) return Promise.resolve();
      return host.interruptCurrentTurn();
    };
    // ★ REDESIGN — PARENT (supervisor-process) restart: dispatch the canonical DETACHED,
    // out-of-process-tree relaunch (restart-supervisor.ps1) so the SUPERVISOR ITSELF reloads its
    // build. Performed SUPERVISOR-SIDE on the operator's confirmed `/control` → Advanced → Parent
    // restart tap — NOT by the agent issuing a shell command (the cli-stream relaunch guard hard-
    // blocks agent-issued relaunches, dev-0efd; this closure runs in the SUPERVISOR process, which
    // the guard does not touch). The script self-detaches via WMI (its child is parented to
    // WmiPrvSE, NOT to this supervisor), then kills this supervisor + re-runs the launcher — so we
    // launch it once, detached, and return immediately (the supervisor dies asynchronously). Only
    // the supervisor-side path triggers it (the agent-side guard stays a pure hard block). Env
    // overrides: SUPERVISOR_PARENT_RESTART_SCRIPT (path; default D:\tmp\restart-supervisor.ps1) +
    // SUPERVISOR_PARENT_RESTART_LAUNCHER (prod|test; default prod — the live host runs the prod
    // launcher). The hosted orchestrator (per dev-fa3d) auto-resumes from the staged handoff file.
    const parentRestartControl = async (): Promise<RestartControlResult> => {
      const script = process.env.SUPERVISOR_PARENT_RESTART_SCRIPT || 'D:\\tmp\\restart-supervisor.ps1';
      const launcher = process.env.SUPERVISOR_PARENT_RESTART_LAUNCHER === 'test' ? 'test' : 'prod';
      if (!existsSync(script)) {
        logger.error('parent-restart: relaunch script not found', { script });
        return { ok: false, detail: `relaunch script not found: ${script}` };
      }
      try {
        const { spawn } = await import('node:child_process');
        // Detached + ignored stdio + unref → the child outlives this process (which the script then
        // kills). The script's own WMI self-detach re-parents it outside our tree before the kill.
        const child = spawn(
          'powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Launcher', launcher],
          { detached: true, stdio: 'ignore', windowsHide: true },
        );
        child.unref();
        logger.warn('parent-restart: dispatched detached supervisor relaunch (the supervisor will be cycled shortly)', {
          script,
          launcher,
        });
        return { ok: true, detail: `relaunching via ${launcher} launcher` };
      } catch (err) {
        logger.error('parent-restart: failed to dispatch the relaunch', { err: String(err) });
        return { ok: false, detail: `dispatch failed: ${String(err)}` };
      }
    };

    sessionHost = new SessionHost({
      driver: sessionDriver,
      bus: supervisor.bus,
      logger,
      send: (handle, msg) => supervisor.sendOutbound('telegram', handle, msg),
      // INLINE-BUTTON permission UX: ACK a tap + edit the prompt to its outcome
      // (best-effort; the loopback transport records them, grammy calls the Bot API).
      answerCallback: (callbackId, text) => supervisor.answerCallback('telegram', callbackId, text),
      editMessage: (handle, messageId, text) => supervisor.editMessage('telegram', handle, messageId, text),
      // ★ P6 (DORMANT unless SUPERVISOR_ROLE_ROUTING is ON): the in-channel secret/role stores +
      // the message-delete hook + the routed-dispatch capability. When the switch is OFF these are
      // all `undefined` → `/setkey`/`/setrole`/`/roles` are NOT intercepted and dispatchRole() is
      // disabled → byte-for-byte the pre-feature behavior.
      ...(secretStore ? { secretStore } : {}),
      ...(roleRoutingStore ? { roleRoutingStore } : {}),
      ...(deleteMessage ? { deleteMessage } : {}),
      ...(dispatchRoleAgent ? { dispatchRoleAgent } : {}),
      // ★ CONTROL-PLANE deps (Parts A1–A5) — wired UNCONDITIONALLY for the hosted session (general
      // supervisor control, not switch-gated). Built just above; restart/interrupt close over
      // sessionHost lazily. These make the `/control` menu's reconnect/flush/log + restart/kill/
      // clear/resume/handoff/change-model + interrupt actions functional after the activation restart.
      reconnectChannel: reconnectChannelControl,
      flushChannel: flushChannelControl,
      captureRecent: captureRecentControl,
      restartControl,
      interruptTurn: interruptTurnControl,
      // ★ REDESIGN — supervisor-side PARENT restart (the detached restart-supervisor.ps1 relaunch).
      parentRestart: parentRestartControl,
      // ★ REDESIGN — the 4 control-panel automatic behaviors, from config (ALL default-OFF / no-op →
      // the running host is byte-for-byte until the operator-triggered activation restart loads them):
      //   • recoveryLadder → reconnect-then-reset on unresponsive (handleUnresponsive routes here below);
      //   • autoSnapshot (+ cadence) → periodic snapshot + carry into EVERY restart incl. the cold one;
      //   • restartDrainMs>0 → graceful restart escalates to a hard kill if the drain stalls;
      //   • statusProbeMs>0 → the status action fires a live responsiveness probe (latency + last-turn).
      recoveryLadder: config.recoveryLadder,
      autoSnapshot: config.autoSnapshot,
      autoSnapshotIntervalMs: config.autoSnapshotIntervalMs,
      restartDrainMs: config.restartDrainMs,
      statusProbeMs: config.statusProbeMs,
      // OUTPUT MODALITY startup default (text|voice|dual). The user chose 'text';
      // SUPERVISOR_OUTPUT_MODE overrides (config.outputModeDefault). The hosted session
      // flips it at runtime via the intercepted `/mode` command.
      outputMode: config.outputModeDefault,
      // Profile-driven policy (demo = config default / route-most; orchestrator =
      // broad allow-list + the safety-floor route predicate).
      policy: profile.name === 'orchestrator' ? profile.policy : config.permissionPolicy,
      systemPrompt,
      // ★ TIER-1 (proposal Q.3): the hosted orchestrator session's OWN model. Default = the
      // profile's pinned model (orchestrator → claude-opus-4-8[1m]); undefined = the driver's
      // own default. SUPERVISOR_ORCHESTRATOR_MODEL (config.orchestratorModel) overrides it for
      // THIS session (read at construction → a change needs a restart). When the env is UNSET,
      // config.orchestratorModel is undefined → this is EXACTLY `profile.model` (byte-for-byte
      // unchanged). Threaded to the driver as --model (cli-stream) / SDK model.
      model: config.orchestratorModel ?? profile.model,
      // SESSION CWD = where the hosted session runs. Default = the supervisor's own cwd.
      // OVERRIDE via SUPERVISOR_SESSION_CWD → #2 WORKTREE HARD ISOLATION: the launcher points
      // the hosted orchestrator at a SEPARATE git worktree of the repo, so its file writes
      // land there, NOT in the real working tree under an active /dev. The worktree is a full
      // checkout (CLAUDE.md + .claude/commands + settingSources all present) → role/skills
      // still load. The supervisor process itself keeps cwd=tools/supervisor (to find dist/).
      cwd: process.env.SUPERVISOR_SESSION_CWD || process.cwd(),
      settingSources: profile.settingSources,
      mcpServers,
      disallowedTools: profile.policy.deny,
      allowedTools: profile.policy.allow,
      permissionMode: 'default',
      env: profile.agentTeams ? { ...process.env, CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' } : undefined,
      // AUTO-INITIATE THE ORCHESTRATOR SKILL ON STARTUP (FIX 2). The role-adoption
      // prefix (default '/orchestrator', DEFAULT ON; config.roleTurnPrefix, env
      // SUPERVISOR_ROLE_TURN_PREFIX, OFF via empty/none/off) is prepended to the
      // session's FIRST turn so it boots AS the orchestrator. Applied to the first
      // turn — NOT a pre-user standalone bootstrap (that self-executes before an
      // operator is bound → reply fails + tokens burn pre-user; live-surfaced). The
      // restart-handoff path re-arms + consumes the same prefix → no double-invoke.
      // Gated to the orchestrator profile (the demo persona adopts no skill role).
      roleTurnPrefix: profile.roleBootstrap === 'orchestrator-skill' ? config.roleTurnPrefix : undefined,
      // ★ STARTUP CONTEXT-PICKUP (parent-restart handoff): when the supervisor was relaunched
      // (restart-supervisor.ps1 → fresh process + COLD orchestrator) and the parent-restart STAGED
      // a handoff file (config.startupHandoff resolved from SUPERVISOR_STARTUP_HANDOFF_FILE), inject
      // it into the fresh session's FIRST real user turn so it auto-resumes instead of booting blank
      // (today the human had to re-send "Hi"). Gated to the orchestrator profile (same as the role
      // prefix). Unstaged/unset ⇒ undefined ⇒ byte-for-byte today. The one-shot file is cleared just
      // below so a later PLAIN restart doesn't re-inject a stale brief.
      startupHandoff: profile.roleBootstrap === 'orchestrator-skill' ? config.startupHandoff : undefined,
      // ★ STARTUP GREETING — proactively greet the user on a fresh (re)started session instead of
      // waiting for them to nudge the cold orchestrator (the "had to re-send Hi" gap). Gated to the
      // orchestrator profile (the demo persona doesn't greet); needs the persisted operator file.
      startupGreeting: profile.roleBootstrap === 'orchestrator-skill' ? config.startupGreeting : false,
      operatorStateFile: config.operatorStateFile,
      // Per-turn de-dup applies ONLY when the in-process reply tool is wired (SDK
      // driver): auto-out the final answer UNLESS the reply tool fired this turn.
      // Under cli-stream there is NO reply tool → auto-forward assistant text (the
      // orchestrator's only channel to the user), so replyToolName is undefined.
      replyToolName: useInProcessReplyTool ? SUPERVISOR_CHANNEL_REPLY_TOOL : undefined,
      // ★ D3 (user-decided 2026-06-18): DEFAULT forwarding = the orchestrator's OWN
      // turn messages ONLY (onResult → sendToOperator). Passive tool activity (tool
      // calls / sub-agent spawns / raw tool-errors) is NOT pushed to the channel — that
      // per-tool push was the FLOOD. Everything is still CAPTURED to the bus/CaptureStore
      // (unchanged) and surfaced ON REQUEST via /channel-check (which reads /api/capture).
      // The PermissionRouter still routes permission PROMPTS to the user (separate path).
      // Opt back in ONLY via SUPERVISOR_FORWARD_TOOL_ACTIVITY=1 (diagnostics; off by default).
      forwardToolActivity: process.env.SUPERVISOR_FORWARD_TOOL_ACTIVITY === '1',
      // (The user-facing "still working…" heartbeat was REMOVED 2026-06-18 — it flooded the
      // channel. Mid-turn activity is now only the INTERNAL D4 liveness belt; the D4 ping/
      // pong is internal too. The user sees only substantive replies + the "was hung,
      // restarted" notice.)
      // D1/D2: the loopback panel URL the orchestrator curls for /channel-check + repair.
      panelUrl: config.panelPort > 0 ? `http://127.0.0.1:${config.panelPort}` : undefined,
      // D4: liveness ping response deadline (orchestrator profile only; other profiles → undefined =
      // ping disabled). A turn result (the pong, or any real turn) within this proves responsive
      // (tier-a); else tier-b. CONFIG-DRIVEN (was a hardcoded 60s, too tight for a legitimately long
      // Opus turn → false-positive restarts): default 180s, env SUPERVISOR_PING_RESPONSE_TIMEOUT_MS.
      pingResponseTimeoutMs: profile.name === 'orchestrator' ? config.pingResponseTimeoutMs : undefined,
      // D4: the IDLE-AWARE scheduler cadence — fire a ping every interval, but ONLY when the
      // orchestrator is idle (a turn in flight = a no-op, so a long turn / sub-agent wait is NEVER
      // pinged → never false-restarted). CONFIG-DRIVEN: default 120s, env SUPERVISOR_PING_INTERVAL_MS.
      // Orchestrator only. (interval may be ≤ deadline: pingLiveness is idle-skipped + clearPingTimer
      // replaces any prior armed deadline + the timeout callback re-validates, so no stale fire.)
      pingIntervalMs: profile.name === 'orchestrator' ? config.pingIntervalMs : undefined,
      // D4 tier-b: on unresponsive, restart+resume the session AND tell the user.
      onUnresponsive: (reason) => void handleUnresponsive(reason),
    });
    supervisor.onInbound(sessionHost.handleInbound);
    // ★ STARTUP CONTEXT-PICKUP: the handoff note is now captured in the SessionHost (it injects it
    // into the first turn). CONSUME the one-shot staging file so a LATER plain restart (with no new
    // brief staged) does NOT re-inject this stale handoff. Best-effort; a failure is non-fatal (the
    // worst case is a one-time stale re-inject, not a crash). Only when a handoff was actually staged.
    if (config.startupHandoff && config.startupHandoffFile && existsSync(config.startupHandoffFile)) {
      try {
        unlinkSync(config.startupHandoffFile);
        logger.info('consumed (cleared) the one-shot startup-handoff file', { file: config.startupHandoffFile });
      } catch (e) {
        logger.warn('could not clear the startup-handoff file (non-fatal; may re-inject once)', {
          file: config.startupHandoffFile,
          err: String(e),
        });
      }
    }
    // D4 tier-b handler (defined here so it closes over sessionHost + supervisor).
    handleUnresponsive = async (reason: string): Promise<void> => {
      logger.error('TIER-B: orchestrator unresponsive', { reason, recoveryLadder: config.recoveryLadder });
      // ★ REDESIGN — RECOVERY LADDER (reconnect → reset): when enabled, try a channel reconnect FIRST
      // and only reset if still unresponsive (the SessionHost owns the ladder + its own user notices).
      // When disabled (the default), the existing direct tier-b restart runs UNCHANGED (byte-for-byte).
      if (config.recoveryLadder && sessionHost) {
        await sessionHost.handleUnresponsiveRecovery(reason).catch((e) => logger.error('recovery ladder failed', { err: String(e) }));
        return;
      }
      const op = sessionHost?.currentOperator();
      if (op) {
        await supervisor
          .sendOutbound('telegram', op, {
            text: '⚠️ The orchestrator stopped responding (liveness check timed out). Restarting it now — your last request may need to be resent.',
          })
          .catch(() => undefined);
      }
      // Restart the hosted session (end → fresh start; the lifecycle re-bootstraps the
      // role). The session keeps the same supervisor/channel. ★M-2: route through
      // restartUnresponsive() (not clearContext) so the involuntary restart INCREMENTS the
      // `restarts` counter and is visible in /api/session.
      await sessionHost?.restartUnresponsive().catch((e) => logger.error('tier-b restart failed', { err: String(e) }));
    };
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
    // ★ T3 — inject the async dispatch registry (teams-replacement) ONLY when role-routing is ON.
    // The conditional-spread is the proven P6 dormant-default discipline: when the switch is OFF
    // `asyncDispatchRegistry` is undefined ⇒ the key is OMITTED (key-ABSENCE, not key:undefined) ⇒
    // the Panel ctor-args are byte-for-byte today + the async routes report {enabled:false}.
    panel = new Panel({
      port: config.panelPort,
      supervisor,
      logger,
      sessionHost,
      controllerBridge,
      ...(asyncDispatchRegistry ? { asyncDispatchRegistry } : {}),
    });
    await panel.start();
  }

  logger.info('supervisor ready', { ...supervisor.health() });

  const shutdown = async (sig: string): Promise<void> => {
    logger.info('shutting down', { signal: sig });
    if (sessionHost) await sessionHost.stop();
    if (panel) await panel.stop();
    await supervisor.stop();
    // #2 WORKTREE HARD ISOLATION teardown: if the launcher created an isolation worktree
    // for the hosted orchestrator (SUPERVISOR_WORKTREE_CLEANUP=<path>), remove it now that
    // the session is stopped (its claude child is dead). Best-effort: a leftover worktree is
    // harmless (just disk) and `git worktree prune` reaps it later. Tied to the SUPERVISOR's
    // shutdown (the session-lifecycle owner) since the launcher is detached + already exited.
    const wt = process.env.SUPERVISOR_WORKTREE_CLEANUP;
    if (wt) {
      try {
        const { execSync } = await import('node:child_process');
        execSync(`git worktree remove --force "${wt}"`, { cwd: process.cwd(), stdio: 'ignore' });
        execSync('git worktree prune', { cwd: process.cwd(), stdio: 'ignore' });
        logger.info('removed isolation worktree', { worktree: wt });
      } catch (err) {
        logger.warn('worktree cleanup failed (harmless — prune will reap it)', { worktree: wt, err: String(err) });
      }
    }
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

/**
 * Read the machine-global methodology (`~/.claude/CLAUDE.md`) to FOLD into the
 * orchestrator system prompt. The hosted session excludes the 'user' setting source
 * (containment — that source loads the prod telegram PLUGIN, which seizes the token),
 * so this file is no longer auto-loaded; we append it instead so the role survives.
 * Best-effort: returns '' (and logs) if absent — the role still works from the project
 * CLAUDE.md + the /orchestrator skill.
 */
function readGenericMethodology(logger: Logger): string {
  try {
    const path = join(homedir(), '.claude', 'CLAUDE.md');
    const text = readFileSync(path, 'utf8');
    logger.info('folded machine-global methodology into the orchestrator system prompt', { path, chars: text.length });
    return text;
  } catch {
    logger.warn('no ~/.claude/CLAUDE.md to fold in (role still loads from project CLAUDE.md + /orchestrator skill)');
    return '';
  }
}

main().catch((err) => {
  process.stderr.write(`supervisor: fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
