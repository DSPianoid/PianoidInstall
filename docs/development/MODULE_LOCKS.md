# Module Locks

Active file locks held by dev agents. A locked file must not be edited by another agent until released.

Locks are released after: commit (wrap-up), revert (reset), or commit/stash (pause). Never edit another agent's lock entries.

<!-- dev-modal-mass-p2 locks RELEASED 2026-05-24 at Step 10a Phase 1.
     Phase 2 of Modal Mass + Q-factor improvement plan committed on
     feature/dev-modal-mass-p2 (PianoidCore + PianoidTunner) + docs
     commit on master (PianoidInstall). NOT merged to dev yet —
     awaits user verification (Phase 2 wrap-up). Files: 4 PianoidCore
     orchestration files (modal_mass_orchestrator.py NEW + 3 facade
     edits), modal_mass/ kernels (3 NEW), 4 test files (NEW), 4
     PianoidTunner files (ModalMassPanel + useModalMass NEW +
     ModalAdapter.jsx edit + Jest test NEW). -->
| Agent | Files | Locked At | Task |
|-------|-------|-----------|------|
| dev-e9d9 | `tools/supervisor/launch-prod-orch.mjs` | 2026-06-21T09:00:00Z | GO-LIVE STAGING: set the dispatch-activation env (SUPERVISOR_ROLE_ROUTING + the 2 spend caps + est-cost) in the prod launcher; back up + rebuild prod dist. DeepSeek bridge env left OFF pending USER (not coordinator) sign-off. No live-process touch; no merge/push. |
<!-- dev-e9d9 FOLLOW-UP locks RELEASED 2026-06-21 at Step 10a Phase 1 (2nd commit on feature/supervisor-dispatch-activation;
     NOT merged/pushed — STOP before Phase 2). EDITED: tools/supervisor/src/{config,index}.ts + NEW deepseek-key-bridge.ts
     + test/{config,dispatch-spend-wiring[NEW]}.test.ts. (result-relay.ts was LOCKED precautionarily but NOT edited this
     round — its release(tokens,costUsd) from the prior commit already carries the cost; git shows no new M → released
     untouched.) (1) C1 ENFORCEMENT WIRING: index.ts dispatch closure now builds ONE AgentConcurrencyGate from the config
     caps + per dispatch tryAcquire(0, estCostUsd) → refuse-on-breach CLEAN {ok:false,text:'refused: spend cap …'} (never
     crash) + passes the lease into dispatchRoleAgentWithFallback (result-relay release(tokens,costUsd) charges real cost);
     estCostUsd = NEW config.dispatchEstCostUsd (SUPERVISOR_DISPATCH_EST_COST_USD, default 0). Caps 0 ⇒ admit-all = byte-for-
     byte. (2) DEEPSEEK KEY BRIDGE (default-OFF SUPERVISOR_DEEPSEEK_KEY_BRIDGE): NEW pure deepseek-key-bridge.ts reads ONLY
     mcpServers["deepseek-codegen"].env.DEEPSEEK_API_KEY from ~/.claude.json (narrow single-key, fail-soft, value never
     logged); index.ts injects it into the dispatch env ONLY when ownSecretName===DEEPSEEK_API_KEY AND !secretStore.has(...)
     (sealed /setkey WINS; seal preserved — non-DeepSeek backends never see it). ★CONTAINMENT: the only key source is the
     user-scope ~/.claude.json (the file the supervisor avoids for hijack containment) → bridge GATED default-OFF + FLAGGED
     for USER sign-off (coordinator-relayed approval is NOT user authority; see WIP NEEDS-USER-DECISION). config.ts +2
     fields/resolvers/loadConfig lines (dispatchEstCostUsd + deepseekKeyBridge). +12 tests (3 config + 9 wiring). Full
     supervisor node:test 670/670 (658 baseline +12; env -u SUPERVISOR_STARTUP_HANDOFF_FILE), tsc --noEmit clean. LOC:
     index.ts 752→792, config.ts 684→728(YELLOW), deepseek-key-bridge.ts NEW 123(GREEN). ★HOST-SAFETY: prod dist/ NOT
     regenerated (throwaway dist-test-e9d9 only, removed; prod dist/ mtimes 2026-06-21 09:15:06 UNCHANGED; new module
     deepseek-key-bridge.js ABSENT from prod dist/; new symbols absent from prod dist/index.js via grep=0); live supervisor
     [8790, PID 68908] NOT touched (zero lifecycle/kill/restart); the REAL ~/.claude.json NEVER read by any test (temp files
     only); NO real claude spawn / Telegram / API spend. Dirty/untracked OTHER-agent files NOT touched. SHA in session log. -->
<!-- dev-e9d9 locks RELEASED 2026-06-21 at Step 10a Phase 1 (commit on feature/supervisor-dispatch-activation,
     off master 066b6f5; NOT merged/pushed — STOP before Phase 2; this is the LAST 2 phases of the supervisor
     control-plane proposal, folds into the control-plane → master activation; the activation restart that rebuilds
     dist/ also loads this). EDITED (existing): tools/supervisor/src/{agent-concurrency,result-relay,config,
     control-command,session-host,panel}.ts + test/{agent-concurrency,config,result-relay,control-plane,panel}.test.ts.
     P-B1 DISPATCH SURFACE: ctl:dispatch menu action (conditionally offered when SUPERVISOR_ROLE_ROUTING ON via
     buildControlMenu({includeDispatch})) → controlDispatch → dispatchRoleAndRelayTurn (dispatchRole + relay the
     [SUPERVISOR dispatch-result]… turn via lifecycle.sendUserTurn + a channel ack) + POST /api/dispatch {role,task}
     → sessionHost.dispatchRole → RoleDispatchResult JSON; dormant when unwired (button not shown, {ok:false,
     enabled:false}, no turn). P-C1 ENFORCED SPEND CAP: AgentConcurrencyGate +spentUsd ledger + dispatchCostCapUsd
     (per-dispatch) + dispatchCostWindowUsd (rolling) checked in tryAcquire/acquire (fail-closed reasons
     dispatch-cost-cap/dispatch-cost-window), release(tokens, costUsd) charges actual cost, pump re-checks, resetWindow
     rolls both; result-relay.ts:251 passes report.costUsd; config.ts +3 resolvers (USD fractional) + 3 fields + 3
     loadConfig lines + DEFAULT_DISPATCH_COST_WINDOW_MS(5h). BOTH USD caps default 0 = unlimited = byte-for-byte today;
     SUPERVISOR_ROLE_ROUTING OFF ⇒ dispatch dormant. +25 tests (P-B1: 7 control-plane + 4 panel; P-C1: 8 gate + 4 config
     + 2 relay). Full supervisor node:test 658/658 (633 baseline +25; env -u SUPERVISOR_STARTUP_HANDOFF_FILE for the
     pre-existing dev-fa3d startup-handoff env-leak), tsc --noEmit clean. LOC: agent-concurrency 230→363, result-relay
     398→400, config 622→684(YELLOW), control-command 659→734(YELLOW), session-host 3064→3129(pre-existing RED, additive
     within control-plane concern), panel 354→399. ★HOST-SAFETY: prod dist/ NOT regenerated (built ONLY to throwaway
     dist-test-e9d9, removed; prod dist/{agent-concurrency,result-relay,config,control-command,session-host,panel,index}.js
     mtime 2026-06-21 09:15:06 UNCHANGED, verified before+after; new symbols dispatchCostCapUsd/formatDispatchResultTurn/
     spendCapBreach ABSENT from prod dist/ via grep=0); the live supervisor [8790] NOT started/touched/killed, NO
     /api/lifecycle/* call, NO restart-supervisor.ps1 / launcher, NO supervisor PID touched (all behavior via
     FakeSessionDriver + fake dispatch closure + capturing send + loopback transport — NO real claude spawn / Telegram
     send / API spend). README env-var update = Phase-2 deferred (dev-vio1 holds README; DOC DEFERRAL block filed in WIP).
     Dirty/untracked OTHER-agent files (controller logs, 3 proposals, dist.bak*) NOT touched. SHA in the session log. -->
<!-- dev-0c8c locks RELEASED 2026-06-21 at Step 10a Phase 1 (commit on fix/dev-0c8c-liveness-watchdog-timeout, off
     feature/supervisor-control-plane; NOT merged/pushed — STOP before Phase 2; folds into the control-plane →
     master merge; the activation restart that rebuilds dist/ also loads this fix). EDITED (existing):
     tools/supervisor/src/{config,index,session-host}.ts + test/{config,session-host}.test.ts. (lifecycle.ts was
     LOCKED precautionarily but NOT edited — isIdle() was REUSED, not modified; git shows no M on it → released
     untouched.) LIVENESS-WATCHDOG FALSE-POSITIVE FIX for the ALWAYS-ON D4 tier-b path (pingResponseTimeoutMs /
     pingLiveness → onUnresponsive restart) that restarted the hosted orchestrator 4× on 2026-06-20 (a legitimately
     long / just-started real turn misread as unresponsive). DISTINCT from + leaves UNTOUCHED dev-acb7's gated
     turnWatchdogMs (A5, alert-not-kill, SUPERVISOR_PROACTIVE_ALERTS=OFF) + dev-3e66's gated recovery ladder.
     (a) CONFIG-IZE the deadline + raise default: config.ts NEW DEFAULT_PING_RESPONSE_TIMEOUT_MS(180_000) +
     DEFAULT_PING_INTERVAL_MS(120_000) + resolvers resolvePingResponseTimeoutMs / resolvePingIntervalMs (mirror
     resolveTurnWatchdogMs) + interface fields pingResponseTimeoutMs/pingIntervalMs wired into loadConfig; index.ts
     :559/:563 now read config.pingResponseTimeoutMs / config.pingIntervalMs (KEEPING the orchestrator-only gating —
     non-orch profiles stay undefined). Default deadline 60s→180s (matches DEFAULT_TURN_WATCHDOG_MS); env
     SUPERVISOR_PING_RESPONSE_TIMEOUT_MS / SUPERVISOR_PING_INTERVAL_MS. (b) CLOSE the in-flight race: session-host.ts
     NEW lastRealTurnStartedAt field (sole owner SessionHost) + NEW private onRealTurnStarted() (records the start
     time + clears any armed ping deadline), called at the two real-work inject seams (handleInbound user turn +
     injectChannelCheckTurn); pingLiveness stamps pingScheduledAt at arming + the timeout callback RE-VALIDATES
     (skip tier-b if lastRealTurnStartedAt >= pingScheduledAt). NOTE: the callback must NOT key off isIdle() — the
     ping turn itself counts in outstandingTurns, so isIdle() is always false there; lastRealTurnStartedAt (non-internal
     turns only) is the correct discriminator (an isIdle clause regressed the genuine-hang tier-b test, caught + dropped).
     +6 tests (3 config-resolver + 3 session-host pingLiveness: a real turn past the deadline NOT restarted / a real
     turn start clears the armed deadline / a real turn after the ping → no tier-b). Full supervisor node:test 633/633
     (627 baseline +6), tsc --noEmit clean. session-host.ts 3014→3062 LOC (pre-existing RED; +48 additive within its
     inbound-routing/liveness/control concern — split already WIP-flagged by dev-3e66/dev-6ca1). config.ts 564→622 (YELLOW).
     ★HOST-SAFETY: prod dist/ NOT regenerated (built ONLY to throwaway dist-test-0c8c[+-base], removed; prod
     dist/{config,index,session-host}.js mtime 2026-06-20 22:51:25 [dev-f8f2 build] UNCHANGED, verified before+after;
     onRealTurnStarted/resolvePingResponseTimeoutMs ABSENT from prod dist/ via grep=0); the live supervisor
     [8790, PID 64920] NOT started/touched/killed, NO /api/lifecycle/* call, NO restart-supervisor.ps1 / launcher,
     NO supervisor PID touched (all behavior verified via FakeSessionDriver + capturing send + loopback — NO real
     claude spawn / Telegram send / spend). README env-var update = Phase-2 deferred (dev-vio1 holds README; NEW DOC
     DEFERRAL block filed in WIP). Dirty/untracked OTHER-agent files (dev-0efd/c9fb/ce3c/f8f2/vio1 logs, controller
     logs, proposals, dist.bak*) NOT touched. The eventual activation rebuild includes this. SHA in the session log. -->
<!-- dev-6ca1 locks RELEASED 2026-06-20 at Step 10a Phase 1 (commit 269e12f on feature/supervisor-control-plane;
     NOT merged/pushed — STOP before Phase 2; folds into the control-plane → master merge; the activation restart
     that rebuilds dist/ also loads these two voice-channel features). EDITED (existing): tools/supervisor/src/
     {session-host,panel}.ts + test/{voice-modality,panel,control-plane,session-host,startup-handoff,
     setrole-roles-host,setkey-command}.test.ts. TWO voice-channel features for the hosted orchestrator:
     (1) MODE-AWARENESS — (a) on-change `[SUPERVISOR output-mode] ...` note injected into the orchestrator turn
     via injectModeChangeNotice (no-op on prev===next / no running session; READER of outputMode, never a writer
     — P1) wired into BOTH handleModeCommand (typed /mode, awaited) and controlSetMode (panel Mode submenu,
     fire-and-forget); (b) one-shot first-turn current-mode notice via NEW modeNoticePending field (init true;
     re-armed true at BOTH restart re-arm sites restartUnresponsive + restart-approved) spliced into the
     handleInbound first-turn seam AFTER role-prefix + startup-handoff; (c) NEW `outputMode` field in panel.ts
     sessionView() → GET /api/session. (2) FORCE-TEXT MARKER — NEW exported FORCE_TEXT_MARKER='[[FORCE_TEXT]]'
     + pure applyForceText() (case-insensitive, strips EVERY occurrence, tidies whitespace); sendToOperator
     detects it → forces modality='text' for THAT send (local override, outputMode UNCHANGED — P1) + sends the
     STRIPPED text. v1 whole-message; text-mode=no-op(still strip); dual-mode=text-only(no voice copy). NEW pure
     buildOutputModeNotice(mode,onChange). Adapter (telegram.ts) UNCHANGED (already honors modality:'text').
     session-host.ts 2866→3014 LOC (pre-existing RED, +148 additive within its inbound-routing/control/modality
     concern — dev-3e66's WIP FILE-SIZE FLAG already tracks the split). +15 tests (14 voice-modality + 1 panel),
     7 pre-existing first-turn/mode assertions across 5 files updated to the new behavior (never weakened). Full
     supervisor node:test 627/627 (617 baseline +10 net; env -u SUPERVISOR_STARTUP_HANDOFF_FILE for the pre-existing
     dev-fa3d startup-handoff env-leak), tsc --noEmit clean. ★HOST-SAFETY: prod dist/ NOT regenerated (built ONLY
     to throwaway dist-test-6ca1, deleted; prod dist/{index,session-host,panel}.js mtime 2026-06-20 17:29:29
     UNCHANGED, verified before+after); the live supervisor [8790, PID 64920] NOT started/touched/killed, NO
     /api/lifecycle/* call, NO restart-supervisor.ps1 / launcher / `node dist/index.js --session`, NO supervisor
     PID touched (all behavior via FakeSessionDriver + capturing send + loopback transport — NO real claude spawn /
     Telegram send / spend). README + orchestrator-skill-doc token = Phase-2 deferred (dev-vio1 holds README; DOC
     DEFERRAL block filed in WIP). Dirty/untracked OTHER-agent files (dev-0efd/c9fb/ce3c/vio1 logs, controller
     logs, 2 proposals) NOT touched. The eventual activation rebuild includes this. SHA in the session log. -->
<!-- dev-ae2a RESUME#2 locks RELEASED 2026-06-20 at Step 10a Phase 1 (commit 3a00c34 on
     fix/dev-ae2a-workbench-empty-render, stacked on f48c0c6/fd52a41; NOT merged/pushed — held for the user's
     live test, then Phase 2). EDITED: PianoidTunner/src/PianoidTuner.js. ISSUE 2 (reversed by coordinator
     clarification — user wants the icons IDENTICAL): panel-following open-workbench toolbar button icon
     TimelineIcon → BarChartIcon (matches the fixed-workbench per-row BarChartIcon exactly, all panels);
     import TimelineIcon→BarChartIcon; comment updated. Verified live (CDP): every panel toolbar workbench
     button = BarChartIcon, Timeline gone. Full Jest 1316/1316, eslint 0 err. Frontend-only, NO CUDA. -->
| <!-- (none active for dev-ae2a) --> | | | |
<!-- dev-ae2a FOLLOW-UP locks RELEASED 2026-06-20 at Step 10a Phase 1 (commit f48c0c6 on
     fix/dev-ae2a-workbench-empty-render, stacked on render fix fd52a41; NOT merged/pushed — held for the
     user's live test, then Phase 2). EDITED: PianoidTunner/src/PianoidTuner.js + src/index.css +
     src/__tests__/workbenchTileGeometry.source.test.js. ISSUE 1 DONE: moved the 2-D workbench accent
     color (workbenchColor: hue[param groupe]×brightness[type]) from the pane TITLE to the BAR CHART bars
     via chartProps.seriesColor (seriesColor wins over isDynamic in DrawableChart); titles now plain+uniform;
     removed the .wb-accent-host wrapper + the --wb-accent var + the title CSS rules → renderTile returns
     MosaicWindow directly (also the cleanest empty-workbench geometry fix). Verified live (CDP pixel sample):
     Strings·damper_string bar = rgb(90,137,174)=#5a89ae, title bar white/no accent. ISSUE 2 = ★FLAGGED, NOT
     CHANGED: code+live show fixed=BarChartIcon vs panel-following=TimelineIcon are ALREADY DISTINCT (coordinator's
     "currently same" premise is wrong); per the coordinator's own flag-if-distinct instruction, left as-is pending
     the user's direct confirmation. Full Jest 1316/1316, eslint 0 err, CRA build OK. Frontend-only, NO CUDA. -->
| <!-- (none active for dev-ae2a) --> | | | |
<!-- dev-85bb locks RELEASED 2026-06-20 at Step 10a Phase 1 (commit 9898793 on feature/supervisor-control-plane;
     NOT merged/pushed — STOP before Phase 2; folds into the control-plane → master merge; the activation restart
     that rebuilds dist/ also loads this MCP wiring). EDITED (existing): tools/supervisor/src/{mcp-config,index,
     profiles,backend-seal}.ts + adapters/cli-stream-driver.ts + test/{mcp-config,cli-stream-driver,profiles,
     backend-seal}.test.ts. Wired deepseek-codegen + hostinger-email + whatsapp(+whatsapp-work) MCP into the
     hosted `claude -p` orchestrator, containment-safe. ROOT: the hosted child got ZERO MCP servers — it runs
     settingSources ['project','local'] (NOT 'user', the token-hijack containment) so the user-scope ~/.claude.json
     mcpServers don't auto-load, AND the cli-stream driver ignored opts.mcpServers. FIX: (1) cli-stream-driver
     honours opts.mcpServers — NEW pure writeMcpConfigFile() writes the curated map to a private 0600 temp file in
     os.tmpdir() (unlinked on stop()/blockRelaunch/re-start; contents NEVER logged), buildCliArgs (KEPT PURE; new
     optional path param) passes `--mcp-config <file>`; ★NO --strict-mcp-config (keeps the claude.ai Drive/Gmail/
     Calendar connector servers). (2) mcp-config NEW HOSTED_MCP_EXCLUDE_SUBSTRINGS=['telegram'] (hosted map excludes
     ONLY telegram); index.ts uses it (was OUTWARD_SEND_EXCLUDE which also dropped whatsapp). (3) profiles WhatsApp
     read-allowed/send-gated: allow-list the 9 READ tools per account (search_contacts/list_messages/list_chats/
     get_chat/get_direct_chat_by_contact/get_contact_chats/get_last_interaction/get_message_context/download_media);
     REMOVE the blanket mcp__whatsapp__*/-work deny so SEND tools (send_message/send_file/send_audio_message) route
     via the EXISTING safety floor (routeWhen=isDestructiveOp, unchanged) for user allow/deny — NOT auto-allowed,
     NOT hard-denied. (4) backend-seal UNIVERSAL_CHANNEL_DENY now TELEGRAM-ONLY (whatsapp removed). Telegram (both
     name forms) + email/gmail SEND stay HARD-DENIED everywhere; whatsapp/email READ reachable. DeepSeek+Hostinger
     secrets inline in ~/.claude.json → flow through loadMcpServers, no host env change. +13 tests covering all 6
     criteria (a --mcp-config + never --strict / b hosted-map telegram-only / c whatsapp READ allowed / d whatsapp
     SEND routed [via the REAL PermissionRouter: not allow-listed, not hard-denied] / e telegram fully blocked / f
     temp file 0600 + unlinked on stop + secrets never logged). Full supervisor node:test 617/617 (604 baseline +13,
     env -u SUPERVISOR_STARTUP_HANDOFF_FILE for the pre-existing dev-0efd-documented startup-handoff env-leak), tsc
     --noEmit clean. cli-stream-driver.ts 733→805 LOC (was already YELLOW; +72 additive within concern). ★HOST-SAFETY:
     prod dist/ NOT regenerated (built ONLY to throwaway dist-test-85bb[+-base/-cnt], all removed; prod
     dist/{index,profiles,mcp-config,backend-seal}.js + dist/adapters/cli-stream-driver.js mtime 2026-06-20T17:29
     [dev-3e66 build] UNCHANGED, verified before+after); the live supervisor [8790] NOT started/touched/killed, NO
     /api/lifecycle/* call, NO restart-script run, NO supervisor PID touched (all behavior verified via fakes +
     FakeCliChild + the REAL PermissionRouter with a fake channel — NO real claude spawn / Telegram / WhatsApp send /
     spend). README doc-deferred (dev-vio1 holds the README lock; NEW DOC DEFERRAL block filed in WIP). NOTED
     pre-existing out-of-scope: the dev-fa3d startup-handoff.test env-leak (run with SUPERVISOR_STARTUP_HANDOFF_FILE
     cleared). The eventual activation rebuild includes this. SHA in the session log. -->
<!-- dev-3e66 locks RELEASED 2026-06-20 at Step 10a Phase 1 (PART 1 commit ff30dcb + PART 2 commit 9427195 on
<!-- dev-3e66 locks RELEASED 2026-06-20 at Step 10a Phase 1 (PART 1 commit ff30dcb + PART 2 commit 9427195 on
     feature/supervisor-control-plane; NOT merged/pushed — STOP before Phase 2; folds into the control-plane →
     master merge; the activation restart that rebuilds dist/ also loads this redesign). EDITED (existing):
     tools/supervisor/src/{control-command,session-host,index,config}.ts + test/{control-plane,config}.test.ts +
     test/{control-activation-wiring,button-rows}.test.ts. CONTROL-PANEL REDESIGN (control-panel-redesign-2026-06-20.md).
     PART 1 = menu restructure: main menu now 10 buttons 2/row (Status/Approvals/Log/New session[was Clear]/Resume/
     Interrupt/Change model/Mode/Advanced/Help); REMOVED Ping/Reconnect top-level (folded into PART-2 auto behaviors);
     NEW Advanced submenu (Restart/Parent restart/Flush, each keeps its confirm); NEW Mode submenu (Voice/Text/Dual,
     no confirm, surfaces the existing /mode outputMode — same single writer); NEW supervisor-side Parent restart
     (a NEW injected parentRestart dep; index.ts spawns the DETACHED restart-supervisor.ps1 → performed
     SUPERVISOR-SIDE on the operator tap, NOT an agent shell cmd → bypasses dev-0efd's cli-stream relaunch guard;
     confirm-gated; dormant when unwired); controlHelpText rewritten to the spec's exact spoken per-button lines.
     PART 2 = 4 automatic behaviors, ALL gated default-OFF/0 (config) → running host byte-for-byte until activation:
     recovery ladder (SUPERVISOR_RECOVERY_LADDER — reconnect-then-reset on unresponsive; index.ts routes
     handleUnresponsive→handleUnresponsiveRecovery when ON, OFF=existing direct restart UNCHANGED); auto-snapshot
     (SUPERVISOR_AUTO_SNAPSHOT — periodic timer + carry into EVERY restart incl. the cold watchdog path via
     restartUnresponsive's snapshot re-inject → closes the cold-watchdog gap); restart hard-kill escalation
     (SUPERVISOR_RESTART_DRAIN_MS>0 — graceful restart drains up to the deadline then hard-restarts via
     gracefulRestartWithEscalation wrapping runRestartConfirm's restartFresh); status live-probe
     (SUPERVISOR_STATUS_PROBE_MS>0 — controlStatus fires a real ping + latency + last-turn; snapshot ALWAYS returns
     on timeout). ★HOST-SAFETY: existing auto-restart-on-death UNCHANGED; lifecycle.ts UNTOUCHED (reused
     isIdle/restartFresh/ping); EVERY watchdog/recovery/snapshot/escalation/probe path tested with a FAKE driver +
     FAKE clock/delay + FAKE transport — NEVER a real wait or real restart; prod dist/ NOT regenerated (built ONLY
     to throwaway dist-test-3e66[+-base], removed; prod dist/{control-command,session-host,index,config}.js mtime
     2026-06-20T17:29 UNCHANGED, my redesign symbols ABSENT from prod dist/); the live supervisor [8790] + the
     Pianoid stack NOT started/touched/killed; NO /api/lifecycle/* call, NO restart script run. config.ts ADDITIVE
     default-OFF flags only (dev-vio1's config.ts lock is on the SEPARATE feature/supervisor-voice-io branch,
     committed @71074cc — env fix, no field overlap; dev-acb7+dev-fa3d already precedent-edited config.ts here).
     +27 tests (10 PART-1 + 17 PART-2), full supervisor node --test 604/604 (577 baseline +27, env -u
     SUPERVISOR_STARTUP_HANDOFF_FILE to clear the pre-existing dev-0efd-documented startup-handoff.test env-leak),
     tsc --noEmit clean. session-host.ts ~2866 LOC (pre-existing RED, +331 additive within concern — split flagged
     as a follow-up audit, see WIP). README + parent-proposal fold-in + spec archival = Phase-2 deferred (WIP note).
     SHAs in the session log. -->
<!-- dev-ae2a locks RELEASED 2026-06-20 at Step 10a Phase 1 (commit fd52a41 on PianoidTunner
     fix/dev-ae2a-workbench-empty-render; NOT merged/pushed — held for the user's live test, then Phase 2).
     EDITED (existing): PianoidTunner/src/PianoidTuner.js + src/index.css. NEW: src/__tests__/workbenchTileGeometry.source.test.js.
     FIX: the renderTile `.wb-accent-host` wrapper (commit 941fedd, 2-D workbench color schema) used `display:contents`
     → generates no box → react-mosaic's `.mosaic-tile > * {height:100%;width:100%}` no-op'd → the grandchild
     `.mosaic-window` got no height, collapsed to its 30px toolbar, workbench BODY = 0px → all 3 workbench TYPES
     (global-dynamic/panel-following/fixed) spawned EMPTY (no ruler/barchart). Wrapper now FILLS the tile
     (100%×100%, not display:contents) + `.wb-accent-host > .mosaic-window {height/width:100%}` CSS so the window
     fills the wrapper; --wb-accent delivery kept (accent feature intact). Measured live (CDP): Workbench body 0→115px.
     Full Jest 1315/1315, eslint 0 err, CRA build OK. Frontend-only, NO CUDA. -->
<!-- dev-0efd locks RELEASED 2026-06-20 at Step 10a Phase 1 (commit on feature/supervisor-control-plane; NOT
     merged/pushed — STOP before Phase 2; folds into the control-plane → master merge; the activation restart
     that rebuilds dist/ also loads this fix). EDITED (existing): tools/supervisor/src/{profiles,index}.ts +
     adapters/cli-stream-driver.ts + test/profiles.test.ts. NEW: test/cli-stream-relaunch-guard.test.ts.
     CLOSED the PARENT-RESTART gate HOLE: dev-fa3d's isSupervisorRelaunchCommand floor branch only ran on a
     can_use_tool permission request, and MEASURED against live `claude -p` (a) an allow-listed Bash/PowerShell
     raises NO such request + (b) a bypassPermissions/background/Task sub-agent suppresses it entirely → a
     relaunch from a bypass sub-agent ran UN-GATED (defeatable by bypass). FIX = a MODE-INDEPENDENT relaunch
     guard in the cli-stream driver: NEW pure detectRelaunchToolUse(raw) scans every assistant tool_use on
     stdout (the one chokepoint independent of permission mode, BEFORE the control-protocol + sub-agent drop)
     for a relaunch carrier (Bash/PowerShell command OR Agent/Task prompt matching isSupervisorRelaunchCommand;
     fromSubAgent from parent_tool_use_id/subagent_type) → HARD-KILLS the child tree (the tool_use line precedes
     execution, measured) before the relaunch tears the host down, then fires onRelaunchBlocked (index.ts → an
     operator "blocked a host-restart" note; the kill is UNCONDITIONAL, works without the callback). + hardened
     isSupervisorRelaunchCommand to also test a separator-stripped copy (extracted matchesRelaunch) so backslash-
     mangled forms match (distindex.js --session / …supervisorlaunch-prod-orch.mjs / …tmprestart-supervisor.ps1),
     no false positives on reads. +11 tests (6 pure detect + 4 driver e2e + 1 mangled-forms in profiles.test),
     full supervisor node --test 577/577 (566 baseline +11), tsc --noEmit clean. ★Verification UNIT-TEST ONLY
     (cannot restart the live host). Prod dist/ NOT regenerated (built only to throwaway dist-test-0efd, removed;
     prod dist/ byte-for-byte dev-fa3d's build — grep confirms prod dist/ lacks the fix); live supervisor NOT
     restarted/killed, NO /api/lifecycle/* call, NO restart script. The eventual activation rebuild includes it.
     README doc-deferred (dev-vio1 holds it). Proposal §6 follow-on block + WIP note added. NOTED out-of-scope:
     dev-fa3d startup-handoff.test.js env-leak (reads process.env directly → 1/566 fails inside a launched
     supervisor env; run with SUPERVISOR_STARTUP_HANDOFF_FILE cleared). SHA in the session log. -->
<!-- dev-fa3d locks RELEASED 2026-06-20 at Step 10a Phase 1 (commit on feature/supervisor-control-plane; NOT
     merged/pushed — STOP before Phase 2; folds into the control-plane → master merge; the activation restart
     that loads the rebuilt dist/ also live-tests these fixes). EDITED (existing): tools/supervisor/src/{profiles,
     config,session-host,index,control-command,contract}.ts + adapters/{grammy-transport,telegram-transport,
     telegram}.ts + launch-prod-orch.mjs + test/{profiles,control-plane}.test.ts. NEW: test/{button-rows,
     startup-handoff}.test.ts. (config.test.ts + session-host.test.ts were locked precautionarily but NOT edited —
     the new resolver + first-turn tests live in the dedicated startup-handoff.test.ts → released untouched.)
     THREE post-activation follow-on fixes the user surfaced live-testing /control:
     (1) RESTORED the regressed PARENT-restart confirmation gate — a NEW isSupervisorRelaunchCommand branch in the
     safety floor (profiles.ts isDestructiveShellCommand) routes the orchestrator firing restart-supervisor.ps1 /
     launch-(prod|pty)-orch.mjs / a `node dist/index.js --session` host launch → a confirm over the channel that
     BLOCKS (matching the in-channel ctl:restart/restart-request gate). Execution-context-aware: fires on INVOKE
     (powershell/-File/&/. for the .ps1; node for the launcher/host) but NOT a cat/grep/ls READ. Root cause
     (git-archaeology): the parent-restart capability (restart-supervisor.ps1, commit 1bad4d9 on the p0 branch)
     shipped with only an ADVISORY orchestrator-skill "user-gated" instruction + NO structural floor entry (the
     script's own taskkill /PID is inside the script, not on the orchestrator's command line) → the relaunch ran
     un-gated. profiles.ts only (the floor predicate); the LifecycleManager child-restart confirm is UNCHANGED.
     (2) NEW supervisor-STARTUP context-pickup: SUPERVISOR_STARTUP_HANDOFF_FILE (env → config.startupHandoffFile/
     config.startupHandoff via the FAIL-SOFT resolveStartupHandoff) → SessionHost.startupHandoff is spliced into the
     FRESH session's FIRST real user turn AFTER the /orchestrator role prefix (same first-turn seam as roleTurnPrefix,
     operator bound, NOT a pre-user bootstrap), one-shot (index.ts deletes the staged file after construction).
     launch-prod-orch.mjs auto-points the env at D:\tmp\supervisor-startup-handoff.txt when present+non-empty (explicit
     env wins). So a parent/dist restart AUTO-RESUMES from the staged brief instead of booting cold (the human had to
     re-send "Hi"). UNSET/absent ⇒ byte-for-byte today. (3) /control 14-button menu LAYOUT: a NEW optional buttonsPerRow
     hint threaded OutboundOptions (contract) → RawSendOptions (telegram-transport) → telegram adapter → grammy
     buildInlineKeyboard (chunks rows of N; default 1 = single row); SessionHost.sendControlMenu (the SINGLE point all
     /control menus route through) passes CONTROL_MENU_BUTTONS_PER_ROW=2 → 7 readable rows of 2. The permission
     Allow/Deny prompts send NO hint → still a single row (byte-for-byte; regression-checked: permission-buttons +
     permission-router + control-plane 119/119). +15 tests (relaunch-floor incl. read-vs-invoke no-false-positives +
     routeWhen end-to-end; startup-handoff resolution + first-turn splice/one-shot/byte-for-byte + fail-soft; the REAL
     grammy keyboard row-structure). Full supervisor node --test dist/test/ 566/566 (551 baseline +15), tsc --noEmit
     clean. ★The prod dist/ WAS rebuilt (folds into the activation build — loaded by the SAME restart-supervisor.ps1
     -Launcher prod restart); the live supervisor was NOT restarted/killed, NO /api/lifecycle/* call, NO restart-script
     run, NO supervisor PID touched (all behavior verified via fakes/injected deps + the loopback transport — NO real
     Telegram/claude spawn/spend). Rollback: dev-fa3d backed up the PRE-fix control-plane dist/ to dist.bak.prectlfix/
     (distinct from dist.bak/ = the older pre-control-plane build); restore dist.bak.prectlfix/→dist/ to revert ONLY
     these fixes, or dist.bak/→dist/ to revert the whole control plane. README doc-deferred (dev-vio1 holds the lock;
     dev-ctl1's deferral note extended with the fa3d line). Spec §6 + the WIP continuation block updated. SHA in the
     session log. -->
<!-- dev-2503 locks RELEASED 2026-06-20 at Step 10a Phase 1 (commit on feature/supervisor-control-plane; NOT
     merged/pushed — STOP before Phase 2; the orchestrator triggers the supervisor RESTART that loads the
     rebuilt dist/, then Phase 2). EDITED (existing): tools/supervisor/src/{index.ts, session-host.ts,
     lifecycle.ts, panel.ts}. NEW: tools/supervisor/src/test/control-activation-wiring.test.ts. Supervisor
     control-plane ACTIVATION WIRING (the index.ts composition-root cut-over that makes the A1–A5 `/control`
     menu FUNCTIONAL): wired the FIVE dormant injected control-plane deps into the hosted SessionHost ctor —
     reconnectChannel→supervisor.reconnectChannel('telegram'), flushChannel→supervisor.flushChannel('telegram'),
     captureRecent→supervisor.captureStore.replay(), restartControl→a closure composing the EXISTING audited
     SessionHost.requestRestart (restart/kill/resume/change-model) + clearContext (clear) [the menu confirm +
     the lifecycle user-confirm both STAND — NOT bypassed; change-model also sets the next-launch model first],
     interruptTurn→SessionHost.interruptCurrentTurn()→lifecycle.interruptTurn()→driver.interrupt(). UNLIKE P6
     these wire UNCONDITIONALLY for the hosted session (general supervisor control, not SUPERVISOR_ROLE_ROUTING-
     gated) + COEXIST with the UNTOUCHED P6 conditional-spread block. +3 ADDITIVE dormant-safe passthroughs so
     the closures reach their targets via SessionHost's existing delegate pattern: LifecycleManager.setModel
     (mutates this.opts.model, the next-launch model consumeOnce reads), SessionHost.interruptCurrentTurn
     (→lifecycle.interruptTurn; named NOT `interruptTurn` to avoid the private-field clash), SessionHost.
     setOrchestratorModel (sets BOTH lifecycle.setModel AND a NEW SessionHost-held `currentModel` the status/
     change-model-submenu display → closes a latent stale-model-display gap so change-model is fully coherent).
     +trivial panel POST /api/interrupt→sessionHost.interruptCurrentTurn() (mirrors /api/clear; the only missing
     panel route — closes A4's deferred panel-interrupt). SUPERVISOR_PROACTIVE_ALERTS left OFF (A5 auto-push =
     a separate later follow-up; the on-demand /control menu doesn't need it). index.ts +68, session-host.ts +42,
     lifecycle.ts +15, panel.ts +25 (all additive, within concern; session-host.ts pre-existing RED). ★ACTIVATION:
     the prod dist/ WAS rebuilt this round (the intentional activation step — npm run build; dist/control-command.js
     now PRESENT [was absent in the stale 2026-06-19 build]; sits on disk READY) — but the live supervisor was NOT
     restarted (the orchestrator triggers it). NO /api/lifecycle/* call, NO restart-supervisor.ps1 run, NO supervisor
     PID touched; dist.bak/ = the byte-copy rollback net. +11 tests (control-activation-wiring.test.ts, mirrors
     p6-activation-wiring.test.ts: the wired SessionHost exposes /control end-to-end — all 14 actions reach their
     REAL targets; UNWIRED host → every action "not available"). Full supervisor node:test 551/551 (540 A5 baseline
     +11) on the REAL dist/, tsc --noEmit clean. NO real Telegram/claude spawn/spend (loopback + fakes). Dirty/
     untracked files (dev-c9fb/ce3c/vio1 logs, controller logs, 2 proposals) NOT touched; dist/ gitignored. Restart
     procedure (to reload the supervisor dist/) documented in the session log: D:\tmp\restart-supervisor.ps1 -Launcher
     prod (DETACHED by design). SHA in the session log. -->
<!-- dev-acb7 locks RELEASED 2026-06-20 at Step 10a Phase 1 (commit on feature/supervisor-control-plane; NOT
     merged/pushed — STOP before Phase 2). EDITED (existing): tools/supervisor/src/{control-command.ts, config.ts,
     session-host.ts, test/control-plane.test.ts}. tools/supervisor/src/lifecycle.ts was LOCKED precautionarily but
     NOT edited (A5 only USES the existing latent in-flight watchdog → ZERO structural change to lifecycle.ts; git
     shows no M on it) → released untouched. Supervisor control-plane Phase A5 (P-A5) = the PROACTIVE stuck/dead PUSH
     + the in-flight turn-watchdog ENABLEMENT (ALERT-not-kill). When the orchestrator goes STUCK (idle + a missed
     liveness ping OR a surfaced in-flight-watchdog stall) or DEAD (child not running), the supervisor PUSHES exactly
     ONE DEBOUNCED alert to the channel (one per stuck/dead EVENT; re-armed only after recovery — the user is
     flood-sensitive). Three detection signals, all REUSING existing machinery: (1) the latent in-flight watchdog is
     now CONFIG-ENABLED in `surface` mode at turnWatchdogMs (default 180s) — a turn outstanding past the deadline →
     an ALERT, NEVER a kill; its onStall latches lastStall + alerts; (2) the missed-ping pingLiveness timeout latches
     lastStall + alerts BEFORE the EXISTING onUnresponsive (the existing auto-restart-on-unresponsive is UNCHANGED —
     A5 adds NO new kill path); (3) a periodic proactive-watch re-checks liveness to catch a DEAD child (which emits
     no events). classifyLiveness widened to STUCK on `running && lastStall != null` (the in-flight-wedged case is
     genuinely STUCK, §5) — SAFE because A5 CLEARS lastStall on any recovery (a result/pong/mid-turn activity →
     onProactiveRecovery), so a present lastStall always denotes a CURRENT stall, never a stale one; this CLOSES the
     A1 "stuck needs the watchdog" gap so `status` resolves STUCK end-to-end. control-command.ts = PURE (+formatProactiveAlert
     + DEFAULT_TURN_WATCHDOG_MS(180000)/DEFAULT_PROACTIVE_WATCH_INTERVAL_MS(20000) + the classifyLiveness widen;
     491→533 LOC, crossed 500→YELLOW, a single cohesive control-plane-pure concern). config.ts = +proactiveAlerts
     (SUPERVISOR_PROACTIVE_ALERTS, default OFF) + turnWatchdogMs (SUPERVISOR_TURN_WATCHDOG_MS) + proactiveWatchIntervalMs
     (SUPERVISOR_PROACTIVE_WATCH_INTERVAL_MS) fields + 3 pure resolvers; 324→392 LOC. session-host.ts WIRES it
     (+4 opts incl. an INJECTABLE proactiveWatchTimers + private proactive{enabled,turnWatchdogMs,watchIntervalMs} +
     alertedState debounce latch + proactiveWatchTimer; ctor conditional-spread of turnTimeoutMs+onStallAction:'surface'
     into the LifecycleManager ONLY when enabled; onStall + the ping-timeout both call maybeProactiveAlert; +maybeProactiveAlert/
     startProactiveWatch/stopProactiveWatch/onProactiveRecovery; onResult/onInternalResult/onMidTurnProgress call
     onProactiveRecovery [gated]; 2157→2339 LOC, pre-existing RED, additive within its inbound-routing/control concern).
     ★HOST-SAFETY: the WHOLE A5 behavior is gated behind the NEW SUPERVISOR_PROACTIVE_ALERTS flag DEFAULT-OFF — OFF ⇒
     the watchdog is NOT wired (its timers do not arm), the proactive-watch never starts, maybeProactiveAlert
     early-returns, onProactiveRecovery leaves lastStall untouched → BYTE-FOR-BYTE today (SACRED INVARIANT). The
     watchdog is ALERT-ONLY (onStallAction fixed to 'surface') — A5 introduces NO auto-kill/restart (it composes with
     the existing auto-restart-on-unresponsive). The watchdog/proactive-watch timers are clock-INJECTABLE + .unref()'d
     → the fake clock fires ticks synchronously (NO real 180s wait, the test process never hangs); the push goes to a
     FAKE transport. Additive + gated → non-control inbound BYTE-FOR-BYTE. +9 tests (1 pure + 5 host ON [in-flight
     watchdog alert-not-kill, watchdog debounce, missed-ping STUCK end-to-end, DEAD fake-clock, re-arm] + 3 host OFF
     [watchdog never arms, watch+ping never arm, normal turn forwarded]), full supervisor node:test 540/540 (531
     baseline +9), tsc clean (built ONLY to throwaway dist-test-a5[+-base], removed — prod dist/ NOT regenerated
     [dist/{index,lifecycle,session-host,config,control-command}.js mtime 2026-06-19 20:21:52 UNCHANGED]; the live
     supervisor [8790] + the Pianoid stack [3000/3001/5000] were ALREADY RUNNING [user/production-owned] — NOT started,
     NOT touched, NOT killed by this agent; NO /api/lifecycle/* call, NO restart). README doc-deferred (dev-vio1 holds
     the lock; dev-ctl1's deferral note extended with the A5 line). Proposal: P-A5 marked SHIPPED + the proactive-push/
     watchdog/alert-not-kill/debounce design documented (§2 row, §5 note, §6 P-A5 row, A4+A5 summary blocks). SHA in the
     session log. -->
<!-- dev-c9fb locks RELEASED 2026-06-20 at Step 10a Phase 1 (commit on feature/supervisor-control-plane; NOT
     merged/pushed — STOP before Phase 2). EDITED (existing): tools/supervisor/src/{control-command.ts, lifecycle.ts,
     session-host.ts, test/control-plane.test.ts, test/fake-session-driver.ts}. Supervisor control-plane Phase A4 (P-A4) =
     the `interrupt` (alias `cancel`) menu action — STOP the orchestrator's CURRENT turn WITHOUT killing it (a fast ESC).
     NON-destructive → it runs DIRECTLY (NO confirm sub-menu, unlike the A3 restart family). NEW public
     `lifecycle.interruptTurn()` = a thin wrapper → `driver.interrupt()` (session-driver.ts:189; tears down NOTHING — no
     stop/restart/sessionId-drop/restart-counter bump → the process + context stay alive; additive, no behavior change
     unless called — the latent H2 watchdog at lifecycle.ts:413 is the only other interrupt() caller). control-command.ts
     = PURE (+`interrupt` CONTROL_ACTIONS row + A4 registry doc; 484→491 LOC, <YELLOW). session-host.ts WIRES it
     (+`InterruptTurnFn` type + the optional injected `interruptTurn` opt + the private `interruptTurn|null` field + ctor
     wiring + the `ctl:interrupt`/`ctl:cancel` switch cases [direct, no confirm] + the `controlInterrupt` handler [reads
     isIdle() BEFORE → "Interrupt sent" vs "Nothing in flight"]; 2087→2157 LOC, pre-existing RED, additive within its
     inbound-routing/control-plane concern). ★HOST-SAFETY: the live interrupt is reached ONLY through the NEW optional
     injected `interruptTurn` dep — dormant/unavailable when unwired ⇒ reports "not available", NOTHING is interrupted;
     index.ts wires it AT ACTIVATION (NOT this agent) to lifecycle.interruptTurn(). test/fake-session-driver.ts gained an
     additive `interrupts` getter (counts interrupt() calls) for the propagation assertion. Additive + gated to the new
     `ctl:*` actions → non-control inbound BYTE-FOR-BYTE. +7 tests (1 pure registry + 1 lifecycle propagation [lifecycle
     .interruptTurn()→driver.interrupt(), driver.starts unchanged] + 5 host [in-flight/idle/alias/unwired/failure]), full
     supervisor node:test 531/531 (524 baseline +7), tsc clean (built ONLY to throwaway dist-test-a4[+-base], removed —
     prod dist/ NOT regenerated [dist/{index,lifecycle,session-host}.js mtime 2026-06-19 20:21:52 UNCHANGED]; the live
     orchestrator NEVER interrupted/restarted — FAKE interruptTurn + FAKE driver only RECORD, driver.starts constant; NO
     /api/lifecycle/* call). README doc-deferred (dev-vio1 holds the lock; dev-ctl1's deferral note extended with the A4
     line). Proposal: P-A4 marked SHIPPED + the interrupt design documented. SHA in the session log. -->
<!-- dev-ce3c locks RELEASED 2026-06-20 at Step 10a Phase 1 (commit on feature/supervisor-control-plane; NOT
     merged/pushed — STOP before Phase 2). EDITED (existing): tools/supervisor/src/{control-command.ts, session-host.ts,
     test/control-plane.test.ts}. Supervisor control-plane Phase A3 (P-A3) = the restart/lifecycle menu actions, each a
     CONTROL_ACTIONS row + a `ctl:*` handler, ALL destructive → a CONFIRM sub-menu (the flush pattern): `restart` (GRACEFUL —
     drain + handoff snapshot + relaunch preserving the channel; intent {kind:restart,drain:true,handoff?}) · `kill` (HARD —
     no drain, for a wedged child; {kind:kill,drain:false}) · `clear`/`new` (fresh orchestrator context, NO handoff = a clean
     slate; {kind:clear,drain:false}) · `handoff` (NON-destructive — capture a state SNAPSHOT now into the supervisor-owned
     in-memory store, the note a future restart/resume re-injects) · `resume` (re-inject the last snapshot; {kind:resume,handoff})
     + the `change-model` restart wiring (a model pick → CONFIRM ctl:model-set-confirm:<model> → set the next-launch Tier-1 model
     + restart on it with drain+handoff so context carries across the switch; {kind:change-model,model,drain:true,handoff}).
     ★HOST-SAFETY: the actual restart/relaunch is performed ONLY through a NEW optional injected dep `restartControl(intent)`
     (RestartIntent {kind,drain,handoff?,model?} → RestartControlResult {ok,detail?}) — dormant/unavailable when unwired ⇒
     NOTHING restarts; index.ts wires it AT ACTIVATION (NOT this agent) to a closure composing the EXISTING requestRestart
     (confirm/rate-limit/audit graceful path) + clearContext — the safety gate is NOT bypassed; the LifecycleManager stays the
     sole restart EXECUTOR. control-command.ts = PURE (+rows restart/kill/clear/handoff/resume + buildConfirmMenu +
     buildModelSetConfirmMenu + the confirm-text consts; 418→484 LOC, still <YELLOW). session-host.ts WIRES it (+RestartIntent/
     RestartControlFn/RestartControlResult types + the optional restartControl opt + the handoffSnapshot store [SOLE WRITER =
     the host] + the switch cases + handlers controlRestart/controlChangeModel/controlHandoff/buildRestartIntent/
     composeHandoffNote/restartOkMessage; 1820→2009 LOC, pre-existing RED, additive within its inbound-routing/control concern).
     `clear` landed HERE (moved from A2). Additive + gated to the new `ctl:*` actions → non-control inbound BYTE-FOR-BYTE.
     +13 tests (3 pure builder + 10 SessionHost), full supervisor node:test 524/524 (511 baseline +13), tsc clean (built ONLY
     to throwaway dist-test-a3[+-base], removed — prod dist/ NOT regenerated [session-host.js/index.js mtime 2026-06-19 20:21:52
     unchanged]; the live supervisor NEVER restarted/killed/relaunched — FAKE restartControl only RECORDS the intent, driver.starts
     stays constant; NO /api/lifecycle/* call, NO restart script). README doc-deferred (dev-vio1 holds the lock; dev-ctl1's
     deferral note extended with the A2+A3 lines). Proposal: P-A3 marked SHIPPED + the restart/handoff/change-model design
     documented. SHA in the session log. -->
<!-- dev-ctl2 locks RELEASED 2026-06-20 at Step 10a Phase 1 (commit on feature/supervisor-control-plane; NOT
     merged/pushed — STOP before Phase 2). EDITED (existing): tools/supervisor/src/{control-command.ts, session-host.ts,
     test/control-plane.test.ts}. Supervisor control-plane Phase A2 (P-A2) = channel↔panel parity menu actions, each a
     CONTROL_ACTIONS row + a `ctl:*` handler reusing the Phase-1 framework: `reconnect` (re-establish the channel transport
     → reconnectChannel; ACK new sender/poller state) · `flush` (DESTRUCTIVE → a CONFIRM sub-menu ctl:flush→ctl:flush-confirm/
     ctl:menu; only the confirm drops un-acked inbound via flushChannel — a bare flush does NOT) · `log` (formatControlLog over
     the capture tail: recent inbound/outbound/delivery, compact, newest-last, capped) · `approvals` (lists pending perms with
     per-ask ✅Allow/❌Deny buttons ctl:appr-allow:<code>/ctl:appr-deny:<code> that resolve via operatorDecide — the SAME
     permission path the perm:* buttons + panel /api/approve use). control-command.ts = PURE (+rows + buildFlushConfirmMenu +
     buildApprovalsSubmenu/approvalsMenuText + formatControlLog + ControlLog* types; 285→418 LOC). session-host.ts WIRES it
     (+6 switch cases + 4 handlers + 3 ADDITIVE optional injected supervisor-side deps reconnectChannel/flushChannel/captureRecent,
     dormant/no-op when unwired — mirrors the deleteMessage/dispatchRoleAgent P6 conditional-spread pattern; index.ts wires them
     at ACTIVATION, NOT this agent; 1726→1820 LOC, pre-existing RED, additive within its inbound-routing/control concern).
     `clear` DEFERRED to A3 (a fresh-context child-restart variant). Additive + gated to the new `ctl:*` actions → non-control
     inbound BYTE-FOR-BYTE. +13 tests, full supervisor node:test 511/511 (498 baseline +13), tsc clean (built ONLY to throwaway
     dist-test-a2[+-base], removed — prod dist/ NOT regenerated [mtime 2026-06-18 16:58:24 unchanged]; the live supervisor NOT
     restarted). NO real Telegram, NO real reconnect/flush against the live supervisor (loopback fakes). Proposal: P-A2 marked
     SHIPPED + `clear` moved to A3. README doc-deferred (dev-vio1 holds the lock; dev-ctl1's deferral covers A2). SHA in the
     session log. -->
<!-- dev-ctl1 locks RELEASED 2026-06-20 at Step 10a Phase 1 (commit on feature/supervisor-control-plane; NOT
     merged/pushed — STOP before Phase 2). EDITED (existing): tools/supervisor/src/session-host.ts. NEW:
     tools/supervisor/src/control-command.ts + test/control-plane.test.ts. Supervisor control-plane Phase 1 (P-A1):
     a single supervisor-intercepted `/control` command renders a native inline-keyboard MENU; an extensible
     `ctl:*` callback ROUTER (the CONTROL_ACTIONS registry) routes taps OUT-OF-BAND (works when the orchestrator
     child is dead/stuck). v1 ACTIONS: status (active/stuck/dead + model + uptime + context%[n/a] + pending
     approvals + restarts), ping (liveness round-trip), help (lists actions) + a change-model menu entry & model
     sub-menu SCAFFOLD (restart-on-model wiring → A3). control-command.ts = pure (matcher/`ctl:*` parse/registry/
     menu builders/classifyLiveness+formatStatus); session-host.ts WIRES it (intercept after /mode before
     sendUserTurn; `ctl:*` routed first in the callback block, perm:* falls through; startedAt for uptime;
     lastStall latched via the lifecycle onStall — dormant watchdog → byte-for-byte today). Additive + gated to
     `/control`+`ctl:*` → non-control inbound BYTE-FOR-BYTE. +20 tests, full supervisor node:test 498/498 (478
     baseline +20), tsc clean (built ONLY to throwaway dist-test-ctrl, removed — prod dist/ NOT regenerated; the
     live supervisor NOT restarted). NO real Telegram, NO model restart (loopback fakes). Proposal revised to the
     `/control`-menu interface (§2.5) + the change-model action. README doc-deferred (dev-vio1 holds the lock).
     SHA in the session log. -->
<!-- dev-2870 P6 locks RELEASED 2026-06-20 at Step 10a Phase 1 (config commit 62cb2ff + session-host commit
     b375fb1 + index.ts+tests commit 007d3a8 + proposal commit 96d9f71, on feature/model-agnostic-agents;
     NOT merged/pushed — activation/merge is the separately-approved P6 step the USER triggers). EDITED
     (existing): tools/supervisor/src/{index.ts, config.ts, session-host.ts}. NEW: test/p6-activation-wiring.test.ts.
     Phase P6 = the activation WIRING (switch-gated, DORMANT) into the LIVE orchestrator construction path —
     the FIRST + ONLY edit to index.ts in the whole Campaign. index.ts: a SINGLE `if (config.roleRoutingEnabled)
     { construct secretStore + roleRoutingStore + deleteMessage + the dispatchRoleAgent FD1 closure }` block
     (else all four undefined) + conditional-spread of those into the SessionHost ctor (OFF passes ZERO P6
     keys → identical ctor args to today) + Tier-1 `model: config.orchestratorModel ?? profile.model`
     (env unset → EXACTLY profile.model). config.ts: roleRoutingEnabled (SUPERVISOR_ROLE_ROUTING, same gate
     as isRoleRoutingEnabled, default OFF) + resolveOrchestratorModel (SUPERVISOR_ORCHESTRATOR_MODEL Tier-1).
     session-host.ts: RoleDispatchFn/RoleDispatchResult + optional dispatchRoleAgent option + the
     orchestrator-invokable dispatchRole() (mirror of setRoleRouting; dormant when not wired). FD1 mechanism
     = a supervisor-provided method (the cli-stream orchestrator can't receive an in-process MCP tool);
     scoped-key loading at spawn (secretStore.loadAll() overlaid onto the dispatch env) + ownSecretName from
     the resolved selection (seal scoping) + FD6 no-key clean fallback. THE SACRED INVARIANT proven: switch
     OFF ⇒ byte-for-byte today (test/p6-activation-wiring.test.ts OFF-path tests). +12 tests, full supervisor
     node:test 478/478, tsc clean (built ONLY to a throwaway dir, removed — prod dist/ NOT regenerated; the
     live supervisor NOT restarted). NO real paid API call (fakes + temp .state/ + fake keys). Held docs
     (dev-vio1 log, controller logs, standalone-process proposal, .process seed) NOT touched. SHAs in the
     session log. Mechanism + activation sequence: proposal §Q.6. -->
<!-- dev-2870 Q.5/M8 locks RELEASED 2026-06-20 at Step 10a Phase 1 (commits 2df2ab4 persisted-store + 5d075eb
     /setrole+/roles + fbc2b70 proposal, on feature/model-agnostic-agents; NOT merged/pushed — activation/merge
     is the separately-approved P6 step). EDITED (existing): tools/supervisor/src/{role-router,session-host}.ts.
     supervisor.ts was locked precautionarily but NOT edited (/setrole+/roles carry no secret → no redaction needed)
     → released untouched. NEW: role-routing-store.ts + setrole-command.ts + test/{role-routing-store,setrole-command,
     setrole-roles-host}.test.ts. Q.5 = Tier-2 per-role model selection: a gitignored .state/role-routing.json
     persisted override store (SOLE writer) + /setrole <role> <provider> [model] + /roles SUPERVISOR-INTERCEPTED
     commands (symmetric with /setkey + /mode; NOT forwarded) + an orchestrator-invokable setRoleRouting() routing
     through the ONE writer applyRoleRouting(). role-router precedence: persisted override > DEFAULT_ROLE_ROUTING_CONFIG
     > fail-safe claude-cli (existing resolveRoleBackend UNCHANGED). /roles shows merged map + key-PRESENCE booleans
     (never values). DORMANT (default-OFF SUPERVISOR_ROLE_ROUTING; gated on a wired roleRoutingStore); index.ts /
     live path / prod dist/ / running supervisor UNTOUCHED. +30 tests, full node:test 466/466, tsc clean (built to
     throwaway dist-test-q6/ then dist-test-final/, both removed — prod dist/ NOT regenerated). NO real paid API call. -->

<!-- dev-2870 P4+P5 locks RELEASED 2026-06-19 at Step 10a Phase 1 (P4 commit f436812 + P5 commit cb2460c on
     feature/model-agnostic-agents; NOT merged/pushed — activation/merge is the separately-approved P6 step).
     Edited (existing): tools/supervisor/src/{api-adapter-driver,backend-registry,role-router}.ts (P4) +
     {backend-kinds,result-relay}.ts (P5). NEW: agent-concurrency.ts + agent-worktree.ts (P5) +
     test/{p4-codex,agent-concurrency,worktree-isolation,fallback}.test.ts. P4 = second api-adapter backend
     (Codex/OpenAI=reviewing) — ZERO new driver, pure config (CODEX_REVIEWING_CONFIG configurable default +
     DEFAULT_API_ADAPTER_CONFIGS so reviewing→Codex resolves with no override; OPENAI_API_KEY scoping via the
     existing assertBackendCostSafe). P5 = X2 concurrency/token cap (AgentConcurrencyGate, pure) + X3
     worktree-for-FS-writers (planAgentWorktree REUSES SUPERVISOR_SESSION_CWD; pure planning, no git) + FD6
     fallback EXECUTION (dispatchRoleAgentWithFallback — ADDITIVE; re-dispatch ONCE then surface; env scrubbed).
     DORMANT (default-OFF SUPERVISOR_ROLE_ROUTING); index.ts / live path / prod dist / running supervisor
     UNTOUCHED; LIVE assertCostSafe byte-for-byte unchanged. +39 tests (11 P4 + 28 P5), full node:test 375/375,
     tsc clean (built to throwaway dist-test-p4p5/, removed — prod dist/ NOT regenerated). NO real paid API call. -->
<!-- dev-2870 P2+P3 locks RELEASED 2026-06-19 at Step 10a Phase 1 (P2 commit 30ecb15 + P3 commit 9d23a12 on
     feature/model-agnostic-agents; NOT merged/pushed — activation/merge is the separately-approved P6 step).
     Edited (existing): tools/supervisor/src/{cost-safety,backend-seal,backend-registry,role-router,result-relay}.ts
     + test/{cost-safety,backend-seal,backend-registry,role-router,result-relay}.test.ts. NEW:
     api-adapter-driver.ts + test/api-adapter-driver.test.ts. P2 = backend-aware cost/secret guard (assertBackendCostSafe,
     per-backend key scoping OD-1) — LIVE assertCostSafe byte-for-byte UNCHANGED (pure append). P3 = api-adapter
     SessionDriver (DeepSeek=coding deepseek-v4-flash; injectable HTTP, zero spend; no tools/permission routing OD-5)
     + registry registration + DEFAULT_ROLE_ROUTING_CONFIG. DORMANT (default-OFF SUPERVISOR_ROLE_ROUTING);
     index.ts/live path/prod dist/running supervisor UNTOUCHED. +42 tests, full node:test 336/336, tsc clean
     (built to throwaway dist-test/, reverted — prod dist/ not regenerated). NO real paid API call. -->
<!-- dev-2870 P0+P1 locks RELEASED 2026-06-19 at Step 10a Phase 1 (P0 commit 655af72 + P1 commit 66357c8 on
     feature/model-agnostic-agents; NOT merged/pushed — activation/merge is the separately-approved P6 step).
     Held + edited: tools/supervisor/src/session-driver.ts (additive BackendCapabilities type only). NEW files
     (no lock conflict): backend-kinds.ts, role-router.ts, backend-registry.ts, backend-seal.ts, result-relay.ts
     + test/{backend-kinds,role-router,backend-seal,backend-registry,result-relay}.test.ts. DORMANT model-agnostic
     agent-routing (default-OFF SUPERVISOR_ROLE_ROUTING); index.ts/live path/dist/running supervisor UNTOUCHED.
     +39 tests, full node:test 294/294, tsc clean (built to throwaway dist-test/, reverted — prod dist/ not regenerated). -->
<!-- dev-f982 locks RELEASED 2026-06-19 at Step 10a Phase 1 (commit f7f9bb5 on feature/supervisor-voice-io;
     NOT merged/pushed — held for the orchestrator-owned supervisor RESTART + verification, then Phase 2).
     Held: tools/supervisor/src/adapters/{cli-stream-driver,sdk-session-driver}.ts + test/{cli-stream-sidechain,
     sdk-session-driver}.test.ts (cli-stream-driver.test.ts + sdk-envelope.test.ts were locked precautionarily but
     NOT edited — the new cases live in cli-stream-sidechain + sdk-session-driver tests) + the raw-envelope diagnostic.
     FIX: completes 2224ed4 — drop BACKGROUND-task sub-agent narration (Agent run_in_background) from channel
     forwarding. 2224ed4 dropped only foreground sidechain (parent_tool_use_id != null); background sub-agents leaked
     (their assistant messages arrive with parent_tool_use_id == null). Discriminator MEASURED from raw claude -p
     stream-json (diagnostics/dev-f982-raw-envelope-probe.mjs): a sub-agent assistant carries top-level `subagent_type`
     (+task_description); orchestrator-OWN messages carry neither → no over-drop. Both mappers now drop
     `if (parent_tool_use_id != null || subagent_type != null)`. +6 unit tests, full node:test 235/235, tsc clean.
     dist/ is gitignored → rebuilt in the working tree (verify-landed done); needs the orchestrator-owned restart to
     load. NO restart performed by dev-f982. -->
<!-- dev-93e1 locks RELEASED 2026-06-19 at Step 10a Phase 1 (commit on feature/supervisor-voice-io;
     NOT merged/pushed — held for the orchestrator-owned supervisor RESTART that loads the rebuilt dist/,
     then Phase 2). Held: tools/supervisor/src/{channel-permission,contract,session-host,supervisor,config,
     index}.ts + adapters/{telegram-transport,grammy-transport,telegram,loopback-transport}.ts +
     test/{channel-permission,config,session-host}.test.ts + test/permission-buttons.test.ts (NEW).
     FIX1: native Telegram inline-keyboard BUTTONS for permission + lifecycle-restart-confirm prompts —
     ChannelPermission.askUser now attaches ✅ Allow / ❌ Deny (callback_data `perm:allow:<code>` /
     `perm:deny:<code>`, the existing 4-hex code, ≤15 bytes); inbound callback_query handled in the grammy
     transport → adapter (toCallbackInbound, transient — NOT queued) → SessionHost.handlePermissionCallback
     resolves the SAME pending promise via submitReplyDetailed, ACKs (answerCallbackQuery), and edits the
     prompt to its outcome. Text `allow/deny <code>` parser KEPT as fallback. ★permission-router.ts core
     UNTOUCHED (merge-hazard avoided vs dev-ee27 feature/supervisor-permission-robustness-p0). FIX2:
     supervisor auto-initiates `/orchestrator` on startup — config.roleTurnPrefix (DEFAULT_ROLE_TURN_PREFIX
     '/orchestrator', DEFAULT ON; env SUPERVISOR_ROLE_TURN_PREFIX; off via ''/none/off); index.ts uses the
     config value for the orchestrator profile (was hardcoded); applied to the first turn (NOT a pre-user
     bootstrap — documented anti-pattern); composes with restart-handoff (no double-invoke). +20 unit tests,
     full node:test 255/255, tsc clean. dist/ gitignored → rebuilt in the working tree (verify-landed done);
     needs the orchestrator-owned restart to load. NO restart performed. README.md doc update DEFERRED
     (dev-vio1 holds it) — WIP doc-deferral note filed. SHA in the session log. -->
| dev-vio1 | tools/supervisor/src/test/voice-tts-isolation.test.ts (NEW), tools/supervisor/README.md | 2026-06-19T14:33Z | RESUME (2nd restart): OUTBOUND-voice fix. Root cause MEASURED — edge-tts not installed in PianoidCore/.venv → tts_voice.py fails at `import edge_tts` → VoiceCodec.synthesize() throws → telegram.ts outbound catch falls back to text (adapter+config logic CORRECT). Fix = install edge-tts into that venv (env, no src-logic change) + ADD a real-TTS isolation test + an adapter-modality unit test (in the existing telegram-adapter.test.ts, already locked-clear: covered by this lock). dist/ rebuild. NO restart of the live supervisor. |
<!-- dev-2870 H-1+M-1 locks RELEASED 2026-06-20 at Step 10a Phase 1 (M-1 commit a3ddc2c + H-1 commit 1763430 +
     review-doc commit 8e18633 on feature/model-agnostic-agents; NOT merged/pushed — activation/merge is the
     separately-approved P6 step). Edited (existing): tools/supervisor/src/{agent-worktree,result-relay,
     api-adapter-driver,session-driver,backend-kinds}.ts + test/{worktree-isolation,result-relay,
     api-adapter-driver}.test.ts. NEW doc: docs/development/reviews/model-agnostic-agents-review-2026-06-20.md.
     H-1 = REAL per-agent git-worktree create+teardown for FS-writing claude agents (injectable
     GitWorktreeRunner REUSES the index.ts/launch git pattern; created at the result-relay choke-point opt-in
     manageWorktree, torn down in finally incl. on crash; compute agent gets none; already-isolated reuses;
     tests MOCK git → NO real worktree in this repo, verified via git worktree list). M-1 = real token/cost
     metering for api-adapter (stream_options.include_usage → usage block → result.tokens + costUsd computed
     from a CONFIGURABLE per-model rate table when the backend reports none → AgentReport.tokens + X2 gate
     lease released with the REAL token count). + stale-docstring cleanup. DORMANT default-OFF
     (SUPERVISOR_ROLE_ROUTING); index.ts / live path / prod dist / running supervisor UNTOUCHED; LIVE
     assertCostSafe byte-for-byte unchanged; NO real paid API call (injected fake clients). Full supervisor
     node:test 404/404 (+29), tsc clean (--noEmit + a throwaway dist dir, removed — prod dist/ NOT regenerated). -->
<!-- dev-2870 multi-provider + /setkey locks RELEASED 2026-06-20 at Step 10a Phase 1 (provider-registry commit ce11890
     + /setkey commit 6d1199a + proposal/bookkeeping commit on feature/model-agnostic-agents; NOT merged/pushed —
     activation/merge is the separately-approved P6 step). Edited (existing): tools/supervisor/src/{cost-safety,
     api-adapter-driver,session-host,supervisor,contract}.ts + test/cost-safety.test.ts. NEW:
     {provider-registry,secret-store,setkey-command}.ts + test/{provider-registry,secret-store,setkey-command}.test.ts.
     (backend-registry.ts was locked precautionarily but NOT edited — DEFAULT_API_ADAPTER_CONFIGS it imports is now
     registry-derived in api-adapter-driver.ts, no registry-code change needed.)
     PROVIDER REGISTRY: generalized the api-adapter config into a Provider table (provider-registry.ts) — any
     OpenAI-compatible provider pluggable by ONE entry; DeepSeek/Codex (byte-identical) + NEW Groq + NEW Gemini (via
     its OpenAI-compat endpoint → same ApiAdapterDriver, no new driver); DEFAULT_API_ADAPTER_CONFIGS + BACKEND_SECRET_ENV_VARS
     DERIVED from it → cross-provider key scoping covers every provider/pair for free; LIVE assertCostSafe byte-for-byte
     unchanged. /SETKEY: supervisor-intercepted `/setkey <provider> <key>` (same seam as /mode) — raw key NEVER reaches
     the orchestrator; gitignored per-provider scoped store (secret-store.ts under .state/); key REDACTED from capture
     (supervisor redactInbound hook, default-OFF) + logs; MASKED confirm only; deleteMessage of the user's message;
     unknown-provider/empty-key handled; GATED on a wired secretStore → absent (current default) /setkey falls through
     to a normal turn BYTE-FOR-BYTE unchanged. Two-tier model selection documented in the proposal (Tier-1 supervisor
     model/restart; Tier-2 runtime role models — /setrole NEXT batch). DORMANT default-OFF (SUPERVISOR_ROLE_ROUTING);
     index.ts / live orchestrator construction / prod dist / running supervisor UNTOUCHED; NO real paid API call (injected
     fakes + temp store dirs + fake keys). +32 tests; full supervisor node:test 436/436 (404 baseline + 32), tsc clean
     (--noEmit prod tsconfig + a throwaway dist dir, removed — prod dist/ NOT regenerated). Held docs (dev-vio1 log,
     controller logs, standalone-process proposal, .process seed) NOT touched. SHAs in the session log. -->
| <!-- (none active for dev-2870) --> | | | |
<!-- dev-vio1 RESUME locks RELEASED 2026-06-19 at Step 10a Phase 1 (inbound-STT FIX committed on feature/supervisor-voice-io;
     NOT merged/pushed — held for the user's live-test after the orchestrator-coordinated supervisor RESTART, then Phase 2
     merge handled by the post-restart orchestrator). Held: tools/supervisor/src/config.ts + launch-prod-orch.mjs +
     src/test/voice-stt-isolation.test.ts (NEW) + README.md. (config.test.ts was locked then RELEASED un-edited — the pure
     path-resolution tests live in the new dedicated voice file.) FIX: the running supervisor delivered the literal
     "(voice message)" placeholder instead of the faster-whisper transcript because config.ts loadConfig had TWO wrong
     defaults — toolsDir→~/.claude (sttScript not found → isSttAvailable() false → silent placeholder) AND python→bare
     `python` (lacks faster-whisper → transcribe() throws → placeholder). Now: toolsDir defaults to the repo tools/ (derived
     from the module's import.meta.url, cwd-independent) + python to the repo venv (PianoidCore/.venv/.../python) when present,
     both env-overridable (SUPERVISOR_TOOLS_DIR / SUPERVISOR_PYTHON); launcher pins both belt-and-suspenders. 219/219 green
     (the 2 real-STT tests actually transcribe the captured sample .oga end-to-end → real transcript, not the placeholder).
     Safety gates UNCHANGED (only config.ts among src/). dist/ rebuilt clean. SHA in the session log. -->
<!-- dev-vio1 locks RELEASED 2026-06-19 at Step 10a Phase 1 (commit 1025079 on feature/supervisor-voice-io; NOT merged/pushed —
     held for the user's live-test after the supervisor RESTART, then Phase 2 merge handled by the post-restart orchestrator).
     Held: tools/supervisor/src/{contract,config,session-host,index}.ts + adapters/telegram.ts + test/{telegram-adapter,voice-modality}.test.ts.
     Feature: input+output channels — inbound auto-STT (already at adapter layer, re-verified) + switchable text/voice/dual outbound
     (default text, in-memory SessionHost state) + /mode switch command (supervisor-intercepted, ACK'd, not forwarded). 215/215 green.
     Safety gates (permission router / settingSources containment / outward-send seal / cost guard) UNCHANGED. -->
<!-- dev-m12p3a locks RELEASED 2026-06-19 at the M12 production cut-over wrap (Stage 2). Held:
     tools/supervisor/** (Phase 3a — the structured I/O drivers [cli-stream default w/ agent-teams + SDK hedge
     behind the SessionDriver seam; PTY/TUI scraper RETIRED], the hosted-agent lifecycle-restart control, the
     I/O-boundary redesign D1-D4 + F1/F3, internal-liveness heartbeat, the production safety gates [cost guard,
     permission router, settingSources containment/hijack-fix, outward-send seal, Windows tree-kill teardown],
     and the production launcher launch-prod-orch.mjs). tsc clean; node:test 200/200. M12 Phase 3a committed
     feature/m12-supervisor-phase3a d06e087, MERGED --no-ff → master 5b0c501. NOT pushed (origin push pending the
     user's yes — LOCAL on master). -->
<!-- upd-rebuild lock CLEARED 2026-06-19 (was a working-tree-only row, never committed to master). /update-pianoid
     (scoped) pull+rebuild of PianoidCore/PianoidBasic/PianoidTunner (origin/dev FF + HEAVY CUDA rebuild) — the
     pull+build completed; the stack is currently DOWN/clean. Log archived to logs/archive/. -->
| <!-- (none active) --> | | | |
<!-- dev-m12p2 locks RELEASED 2026-06-15 at Step 10a Phase 2 (user-approved "close+commit+proceed", merged). Held:
     tools/supervisor/** (Phase 2 — subprocess ownership; added lifecycle/permission-router/channel-permission/session-host/
     session-driver/sdk-session-driver + edits to index.ts/config.ts). M12 Phase 2 committed feature/m12-supervisor-phase2
     770d1b3, MERGED --no-ff → master daafa6f. NOT pushed. -->
<!-- dev-m12p1 locks RELEASED 2026-06-15 at Step 10a Phase 2 (user-approved, merged). Held: tools/supervisor/** (entire NEW
     TS/Node subtree, greenfield — no conflict possible). M12 Phase 1 committed feature/m12-supervisor-phase1 7db3dec, MERGED
     to master 93ffa66 (--no-ff). NOT pushed. -->
<!-- dev-dynwb refinement locks RELEASED 2026-06-14 at Step 10a Phase 1 (refinement commit). Held:
     PianoidTunner/src/components/DrawableChart/DrawableChart.jsx, BarChart.jsx, PianoidTuner.js (+
     NEW DrawableChart/__tests__/DrawableChart.dynamicColor.test.jsx). RowEditor.js + SoundChannelsAggregateChart.jsx
     were re-locked but NOT edited this round (isDynamic threads PianoidTuner→RowEditor chartProps→BarChart→
     DrawableChart; RowEditor's existing chartProps spread carries it unchanged). User msg 3515 refinements:
     (c) DYNAMIC workbench bars in a DISTINCT theme accent (DrawableChart isDynamic → secondary.main vs
     fixed primary.main; explicit seriesColor wins; default false = byte-identical); (d) bars FILL the field
     with a small gap (removed barMaxWidth:40 cap, kept barCategoryGap:"10%"; ruler alignment unaffected).
     Committed feature/dev-dynwb-avgsc-workbench-reuse 91266eb. Full Jest 107/1123 green, eslint 0, build
     compiles. ★Live pixel-verified: dynamic=rgb(255,165,0) orange vs fixed=rgb(25,118,210) blue, bars fill
     field (screenshots). Frontend-only, NO CUDA. NOT merged — held for user live test (same hold as the rest
     of the batch). -->
| <!-- (none active for dev-dynwb) --> | | | |
<!-- dev-dynwb locks RELEASED 2026-06-14 at Step 10a Phase 1 commit. Held: PianoidTunner/src/PianoidTuner.js,
     src/utils/workbenchTitle.js (NEW), src/components/BarChart.jsx, src/components/RowEditor.js,
     src/components/SoundChannelsAggregateChart.jsx (+ 2 NEW test files: utils/__tests__/workbenchPaneTitle.test.js,
     components/__tests__/SoundChannelsAggregateChart.fanOutDecouple.test.jsx). SoundChannelsPane.jsx was locked but
     NOT edited (the avg-SC drawing reuse landed entirely inside SoundChannelsAggregateChart, which SoundChannelsPane
     already renders — no pane-level change needed). TWO independent pieces of the workbench batch (user msgs 3503+3512):
     (1) TITLE (msg 3512): workbench pane title = the edited param, "Workbench" word dropped; pure
         utils/workbenchTitle.js workbenchPaneTitle helper + collapsed PianoidTuner.renderTile's 2 duplicated branches
         + non-empty "Workbench" fallback. Committed PianoidTunner feature/dev-dynwb-avgsc-workbench-reuse 329957c.
     (2) AVG-SC reuses workbench DRAWING (msg 3503): avg-SC strings axis now renders via RowEditor→BarChart→DrawableChart
         (shared workbench drawing) instead of its own DrawableChart+ruler; BarChart/RowEditor widened with optional
         pass-throughs (omit=byte-identical for all existing callers); EMIT stays the 1→N fan-out (modesVectorDrawn/
         pitch="averaged"), SC channel-decouple preserved (mode axis only, never selectedPitches). Committed 501d66c.
     Branch feature/dev-dynwb-avgsc-workbench-reuse off dev 62696e4. Full Jest 106/1119 green (+2 suites/+11 tests,
     ZERO regressions; named SC-decouple guards green); eslint 0 errors; production build compiles; live-verified
     (avg-SC renders via RowEditor — docs/development/screenshots/dev-dynwb-avgsc-via-roweditor.png). Frontend-only,
     NO CUDA. NOT merged — HOLD for user live test (Step 9). ★PARTS 1+2 (dynamic/fixed workbench WIRING) NOT touched —
     verdict Q2 (already work in merged dev), held for the user's a/b/c/d answer. Docs (OVERVIEW
     SoundChannelsAggregateChart/RowEditor/BarChart rows + NEW "Workbench pane title" subsection) + session log on
     PianoidInstall master. -->
| <!-- (none active for dev-dynwb) --> | | | |
<!-- dev-tbmirror locks RELEASED 2026-06-14 at Step 10a Phase 2 (user-approved merge msg 3506). Toolbar BATCH MERGED to
     PianoidTunner dev 62696e4 (--no-ff, off 19756de) + PUSHED origin/dev. Held: ToolBar.jsx, PianoidTuner.js,
     useWindowManager.js, MidiComponent.jsx (precautionary, not edited), useMidiStatus.js (NEW), + 4 NEW/edited test
     files (useMidiStatus.test.jsx, useWindowManager.midiRemoved.test.jsx, ToolBar.presetSelector.test.jsx,
     toolbarMidiRemoved.source.test.js). 5 feature commits: 25ce0de mirror-field removal (blur fix) · db624bb MIDI
     button+indicator+popup+drop-mosaic-pane · 5982cc8 MIDI tests · cb34e5a reorder+preset-name removal · 8c52e03
     BOTH-windowCategories guard. Frontend-only, NO CUDA. Full Jest 104/1108 green, eslint 0, build compiles.
     ★dev-dynwb branched off the SAME dev 19756de in parallel — this merge moved dev to 62696e4; dev-dynwb reconciles
     later (expected/planned). Session log archived to logs/archive/. -->
| <!-- (none active for dev-tbmirror) --> | | | |
<!-- dev-tbmirror locks RELEASED 2026-06-14 at Step 10a Phase 1 commit (mirror-removal). Held: PianoidTunner/src/components/ToolBar.jsx,
     src/PianoidTuner.js, src/components/__tests__/ToolBar.commitKey.test.jsx (DELETED), src/components/__tests__/ToolBar.presetSelector.test.jsx.
     Removed the redundant top-toolbar "mirroring" selected-parameter NumInput (echoed selectedParameter.value — a second
     edit surface for a value every pane already edits in place; as a shared persist-on-blur instance it was the
     contamination surface the dev-blur commitKey guard existed to patch). ToolBar.jsx: delete mirror block + Divider +
     NumInput import + selectedParameter/onValueChange props + update responsive-overflow comment (695→650 LOC, YELLOW).
     PianoidTuner.js: stop passing selectedParameter/onValueChange to <ToolBar> (both stay defined — pane-shared).
     Deleted ToolBar.commitKey.test.jsx (tested the removed field); added a field-removed negative assertion to
     ToolBar.presetSelector.test.jsx. Committed feature/dev-tbmirror-remove-toolbar-mirror 25ce0de (off dev 19756de).
     Full Jest 101/1098 green (baseline 102/1101; -1 suite/-4 + 1 new = net -3), eslint 0 new errors, build compiles.
     Frontend-only, NO CUDA. Live-verified (chrome-devtools): toolbar has no mirror field; all other controls + responsive
     overflow intact. NOT merged — HOLD for user live test. Docs (OVERVIEW ToolBar+NumInput rows) + log on master. -->
<!-- dev-excwb ALL locks RELEASED 2026-06-14 at Phase 2 (user msg 3485 "commit merge push"). The whole dev-excwb batch —
     Excitation workbenches (3941714) + maximized-Close-icon fix (b222b66) + A+B kernel-traffic fix (a5e2fd0) — was
     MERGED to PianoidTunner dev 19756de (--no-ff) and PUSHED origin/dev (1a2dba2..19756de, no force). Held files
     across the batch: PianoidTuner.js, useLayout.js, useValuesHistory.js, components/Excitation.jsx,
     ExcitationProperties.jsx, GaussEditor.jsx, GaussCell.jsx, hooks/usePreset.js, WorkbenchFunctionTools.jsx (+ 4 NEW
     test files). Full Jest 102/1101 green, eslint 0, build compiles. Frontend-only, NO CUDA rebuild. User-tested +
     approved. Deferred follow-up logged: string per-pitch GPU uploads inside one bulk backend call (GPU-batching). -->
| <!-- (none active for dev-excwb) --> | | | |
<!-- dev-excwb close-icon-fix locks RELEASED 2026-06-11 at Step 10a Phase 1 commit. Held PianoidTunner/src/PianoidTuner.js
     + hooks/useLayout.js (+ 1 NEW test). GENERAL bug (user msg 3476): renderToolbarControls suppressed Close (X)
     whenever isFullscreen → maximized panes (incl. Excitation workbenches) showed only Restore. Fix: render Close in
     both states; maximized → useLayout.closeMaximized(id) (removeLeaf prunes the leaf from layoutBackup → restore
     pruned backup → exit fullscreen; default-layout fallback). Committed feature/dev-excwb-excitation-workbench
     b222b66. Full Jest 101/1098 green, eslint 0, build compiles, live-verified. Frontend-only. NOT merged — HOLD
     (merge gate: this fix + Excitation-workbench feature + user axis-confirm + user live test). -->
| <!-- (none active for dev-excwb) --> | | | |
<!-- dev-excwb locks RELEASED 2026-06-11 at Step 10a Phase 1 commit. Held: PianoidTunner/src/PianoidTuner.js,
     components/Excitation.jsx, components/ExcitationProperties.jsx, components/GaussEditor.jsx,
     hooks/useValuesHistory.js (+ 2 NEW test files). GaussCell.jsx was locked but NOT edited (affordance lives on
     the GaussEditor param-row label, not the cell). Excitation→Workbench: every hammer + gauss param now opens a
     Workbench (BarChart IconButton) editing across pitches, mirroring Strings/Modes; reused the shared mechanism
     (updateDefaultWorkbench/handleOpenWorkbench/computeWorkbenchValues/handleVectorChange). Fixed 2 latent bugs:
     handleVectorChange Excitation branch wrote stringsHistory (→ excitationHistory) + calcChange pitchesVectorDrawn
     was flat-only (→ gauss-aware nested write). Committed feature/dev-excwb-excitation-workbench 3941714 (off dev
     1a2dba2). Full Jest 100/1095 green, eslint 0, build compiles. Frontend-only, NO CUDA. NOT merged — HOLD for
     user live test. Docs (pianoid-tunner OVERVIEW) + log on PianoidInstall master. -->
| <!-- (none active for dev-excwb) --> | | | |
<!-- dev-mwfix locks RELEASED 2026-06-11 at Step 10a (Workbench feature wrap; user-approved merge+push+sync msg 3458).
     Held: PianoidTunner/src/utils/curveShapes.js (NEW) + curveShapes.test.js (NEW) + WorkbenchFunctionTools.jsx (NEW) +
     PianoidTuner.js. Workbench range-edit feature: apply-anchored-function (7 shapes, anchor value unchanged) + 2x-sticky
     linear c=0 wheel detent + extend/shrink (Excitation-style); uniform-value control removed per user. Committed
     079101d/30490cc/78e921c/9f3a8eb on feature/dev-mwfix-matrix-fixes, MERGED to PianoidTunner dev 23a1d38 (--no-ff).
     Full Jest 96/1080 green, eslint 0, build compiles. Frontend-only. (The earlier items 1-5 locks were already released
     at the prior Step 10a Phase 1 — see the comment below.) -->
| <!-- (none active for dev-mwfix) --> | | | |
<!-- dev-mwfix locks RELEASED 2026-06-10T18:30:00Z at Step 10a Phase 1 (all 5 items committed on
     PianoidTunner feature/dev-mwfix-matrix-fixes, off dev 5758019: 0c38c80 avg-SC ruler-align + ModesRule
     windowed positioning [item 1]; 925c96a P1-A tie/untie rollout complete + delete legacy shared-range zoom
     [item 2]; b732b31 P1-B delete dead mute write-path [item 3]; 9bb71f9 P2 cleanups (double calcChange,
     mutedMatrix, scListenToModes source, Feedback dead zoom) [item 4]; 71b2398 P3 render-without-range guard +
     cell-click decouple + explicit row order [item 5]). Held 9 files: SoundChannelsAggregateChart.jsx, ModesRule.js,
     PianoidTuner.js, useCurrentValues.js, SoundChannelsPane.jsx, MeasuredMatrix.jsx, usePreset.js, useSoundChannels.js,
     useMatrixHistory.js, PitchesModesMatrixCanvas.jsx (+2 NEW test files). ★SC channel-row decouple PRESERVED
     throughout (only SC MODE axis ties to global selection). Full Jest 95 suites/1030 tests green, eslint 0 errors,
     production build compiles. Frontend-only, NO CUDA build. NOT merged — HOLD on feature branch for user's live test.
     Docs (pianoid-tunner OVERVIEW) + session log on PianoidInstall master. -->
| <!-- (none active for dev-mwfix) --> | | | |
<!-- dev-bug1rt locks RELEASED 2026-06-10 at Step 10a Phase 2 (user-confirmed live debug test "Works ok" msg 3438; team-lead-authorized LOCAL merge + wrap). Held: PianoidCore pianoid_cuda/MainKernel.cu, Pianoid_synthesis.cu, OnlinePlaybackEngine.cu (probes-only, reverted to net-zero), Pianoid.cu (read-only, not edited), pianoid_middleware/chartFunctions.py.
     BUG-1 = DEBUG addKernel cudaErrorCooperativeLaunchTooLarge (recordOutputData register pressure + online SDL3 audio-driver SM consumption exceed cooperative co-residency → realtime thread 0-cycles at launcher/APPLY boot → silent no-sound + empty kernel). FIX-2 = debug-only __launch_bounds__(512,1) on addKernel (#ifdef PIANOID_DEBUG_DATA macro → empty in release → release codegen byte-identical, preserves live debug-online extraction). FIX-3 = check cudaLaunchCooperativeKernel return → PLOG_ERR + return 500 (fail-fast; also makes the steinway 58-block-on-56-SM kernel_status-500 failure loud). BUG-2 = _stop_online_engine clears endMainLoop on stuck loop-flag regardless of isRunning() (→ "Cannot render offline" after dead thread). Committed feature/debug-online-realtime-fix f96e266 (3 files +58/-4), MERGED to LOCAL PianoidCore dev d0136e5 (--no-ff). Docs (DEBUG_DATA.md RCA+fix) + session log on PianoidInstall master (e58cc6a + Phase-2 wrap). All 5 verify gates PASS + user-tested OK. NOT pushed — origin reconcile + push HELD pending user push decision. Session log archived. -->
| <!-- (none active for dev-bug1rt) --> | | | |
<!-- dev-debugboot-bacd Fix-B locks RELEASED 2026-06-09 at Step 10a Phase 1 commit. Held:
     PianoidCore/pianoid_middleware/backendServer.py + chartFunctions.py. /get_chart_test offline
     render no longer leaves the realtime playback thread stopped: backendServer _spawn_realtime_thread
     helper + pianoid._restart_realtime_thread hook (registered by load_preset); _restart_online_engine
     prefers the hook (restores long_running_procedure + `running` flag), falls back to start_pianoid()
     for serverless callers. Committed feature/debug-at-boot 3c4244a (+123/-5, incl.
     tests/unit/test_chart_restart_realtime_thread.py 3/3). Docs (SYSTEM_OVERVIEW threading) on master.
     3/3 Fix-B + 5/5 Fix-A unit; live: note_playback+mode_test keep backend_thread_running=TRUE (was
     dropping to False). Python middleware — NO CUDA rebuild. NOT merged — awaits user test + approval. -->
<!-- dev-debugboot-bacd lock RELEASED 2026-06-09 at Step 10a Phase 1 commit. Held:
     PianoidCore/pianoid_middleware/pianoid.py. Honor PIANOID_USE_DEBUG at module-import
     boot (select_cuda_variant_at_boot) so DEBUG wins the first pianoidCuda import + no-downgrade
     rule (release-request on a debug-active process is a no-op). Fixes debug-via-UI first-import
     race (frontend APPLY debug_mode=0 imported RELEASE first → later debug_mode=1 was a no-op).
     Committed PianoidCore feature/debug-at-boot cdee490 (pianoid.py + tests/unit/test_debug_variant_at_boot.py,
     +156/-1). Docs (BUILD_SYSTEM Runtime selection) + log on PianoidInstall master 40dc5c9. 5/5 unit +
     4/4 live tests (a-d) PASS. Python middleware, loads from source — NO CUDA rebuild. NOT merged —
     awaits user live-test + approval. -->
<!-- dev-cudaguard locks RELEASED 2026-06-10 at Step 10a Phase 1 commit (NOT merged/pushed — Phase 2
     after the user's live test on the no-CUDA box). No-CUDA graceful mode (Opt C). COMMITTED, 3 feature
     branches (held for the user's test, then merge per team-lead):
       - PianoidCore feature/no-cuda-gate `fa22dda` (off dev 8df0e56): pianoid_middleware/backendServer.py
         (_gpu_available cached CuPy probe + /load_preset 503 gate BEFORE destroyPianoid + /health gpu_available)
         + tests/system/test_no_cuda_gate.py (NEW, 7/7). Python-only, NO CUDA build.
       - PianoidTunner feature/no-cuda-apply-gate `3c8dad5` (off dev 5758019): src/hooks/useBackendHealth.js
         (gpuAvailable, default-true unless explicit false) + src/PianoidTuner.js (ensureBackendAndLoadPreset
         no-CUDA short-circuit + dep) + src/components/BackendStatusIndicator.jsx ("No CUDA" amber chip) +
         2 NEW Jest (BackendStatusIndicator.noCuda 5, useBackendHealth.gpuAvailable 3). Jest 8/8; BSI suite 11/11.
       - Outer worktree feature/dev-cudaguard `d6142af`: check-cuda.ps1 (limited-mode warning wording; detection
         logic from the prior broken-NVML fix). .ps1 only.
     Diagnostic diagnose-cuda.ps1 already SHIPPED to master (fa2cde1). PianoidBasic CPU synth DEFERRED (docs only:
     docs/proposals/no-cuda-cpu-synthesis-2026-06-10.md + WIP). Bookkeeping/docs committed on PianoidInstall master.
     start-pianoid.bat was locked precautionarily but NOT edited (contract sound; the gate lives in check-cuda.ps1
     + the backend). NO merge, NO push (Phase 2 pending user live test). -->
<!-- (no active dev-cudaguard locks — released at Phase 1) -->
<!-- dev-nvmldiag locks RELEASED 2026-06-10 at orchestrator Phase-2 wrap. Held (OUTER PianoidInstall, master):
     diagnose-cuda.ps1 (edit) + docs/development/diagnostics/dev-nvmldiag-mismatch-verdict-tests.ps1 (NEW harness).
     diagnose-cuda.ps1 4-round hardening SHIPPED to master (fa2cde1 -> 2cef064 -> 9b53ad9 -> 27f908e); verdict
     harness (28/28) PRESERVED to master in this wrap. .ps1-only, NO CUDA build. Tree clean. -->
<!-- dev-drvinstall locks RELEASED 2026-06-10 at orchestrator Phase-2 wrap (lock row was working-tree-only, never
     committed to master). Held (OUTER PianoidInstall, master): install-nvidia-driver.ps1, check-driver-health.ps1
     (NEW), setup-packages.bat (option 7), setup-dev.ps1 + 2 NEW harnesses. Driver detect+reinstall option 7 SHIPPED
     to master (ccf1b0c -> 04a3080 -> 60fcbeb); harnesses PRESERVED to master in this wrap. .ps1/.bat-only, NO CUDA
     build. All driver ops logic-tested only (no real choco/pnputil/DDU/reboot on this box). Tree clean. -->
<!-- dev-upcheck locks RELEASED 2026-06-10 at Step 10a Phase 1 commit (NOT merged/pushed — team-lead FFs
     feature/check-updates-integration-branch onto master + pushes). Held (OUTER PianoidInstall repo root):
     check-updates.ps1 (edit) + docs/development/diagnostics/dev-upcheck-edge-tests.ps1 (NEW, edge-test diagnostic).
     Hardened the launcher origin-ahead detector: compare HEAD vs the explicit REMOTE INTEGRATION BRANCH
     (origin/dev for Core/Tunner/Basic, origin/master for outer) instead of the current-branch upstream @{u},
     so a no-upstream local feature branch (or detached HEAD / merged-but-not-deleted branch) no longer reports
     "unknown" and silently skips the prompt. @{u} kept as secondary fallback; unresolvable ref + no upstream ->
     -1 unknown/skip (never errors). Added -WhatIf dry-run (prints per-repo decision, no MessageBox). PRESERVED:
     timeout-guarded fetch; git-missing/offline/any-failure -> exit 0 silent; Yes=10/No=0 pop-up; "+N" listing.
     VERIFIED non-disruptively (NO launch/pull/modal): -WhatIf on this machine = Core +4 / Tunner +13 behind
     origin/dev, Basic + outer up to date (exit 10); no-upstream bug condition still detects Core +4 (old code
     skipped it); git-unreachable -> exit 0; edge unit tests 10/10; AST-clean (209 LOC). Committed on
     feature/check-updates-integration-branch 6f99d68 (off master b5f9051, +222/-29, 6 files). .ps1-only — NO CUDA
     build, NO backend, NO stack. Docs (QUICK_START update-check paragraph) + session log on this branch. -->
<!-- dev-syschecks locks RELEASED 2026-06-09 at Step 10a Phase 1 (option-(a) /auto adjustment; NOT merged/pushed —
     team-lead FFs the feature branch onto master + pushes). Held: check-running-servers.ps1 (edit), check-cuda.ps1
     (edit); start-pianoid.bat NOT edited this round (already passes -Auto; per-case decision moved into the helpers).
     Adjusted the /auto routing per the user's option (a): running-servers /auto → SHOW Kill&restart/Cancel pop-up
     (timed WScript.Shell.Popup 30s; Yes→kill+0, No/timeout→cancel/20 = don't-kill-don't-launch); CUDA no-device /auto
     → SHOW (timed; OK/timeout→0, Cancel→30); CUDA SM<60 /auto → SUPPRESS (informational, shown only bare/interactive);
     bare/interactive → all 3 blocking MessageBox (unchanged). Show-ServerPrompt NEW; Show-CudaWarning gains -Kind
     [no-device|low-sm]. POPUP_TIMEOUT_SEC=30. VERIFIED static/AST/sim only (stack LEFT RUNNING — NO launch, NO live-
     port kill): both .ps1 AST-clean; REAL /auto+SM<60 on this 56-SM box → suppressed (exit0, no warning); REAL timed
     WScript.Shell.Popup → rc=-1 on 2s timeout (no hang); decision matrix + .bat RC routing all pass team-lead's
     required matrix (/auto+servers→shown, /auto+no-CUDA→shown, /auto+SM<60→NO popup, bare+SM<60→shown,
     bare+servers→shown). Committed feature/launcher-prelaunch-checks 749aba5 (+125/-51). Docs (QUICK_START /auto
     column) on this branch. NOT merged/pushed. Prior Phase-1 commits this branch: 2dff830 feat + 1951b83 docs +
     e72f505 chore (off master c6baf4e). -->
<!-- (none active for dev-syschecks — released at Phase 1) -->
<!-- dev-syschecks locks RELEASED 2026-06-09 at Step 10a Phase 1 commit (NOT merged/pushed — team-lead FFs the
     feature branch onto master + pushes). Held (OUTER PianoidInstall repo root): start-pianoid.bat (edit),
     check-running-servers.ps1 (NEW), check-cuda.ps1 (NEW). TWO best-effort pre-launch checks added to
     start-pianoid.bat, each a self-contained PowerShell helper invoked like check-updates.ps1 (exit code read by
     the .bat; any failure → exit 0 = launch): (1) check-running-servers.ps1 — Get-NetTCPConnection -State Listen on
     3000/3001/5000/5001; if a stack is up → MessageBox (Yes=Kill&restart via PORT-TARGETED Stop-Process on those
     ports' OwningProcess PIDs ONLY, never /IM; No=Cancel→exit 20). -Auto = warn+leave-untouched+proceed (never kills
     a live stack unattended). (2) check-cuda.ps1 — venv python + cupy (getDeviceCount + multiProcessorCount) via a
     TEMP FILE (python -c mangles embedded quotes), nvidia-smi availability fallback; no device → warn, SM<60 → warn
     (cooperative block_count=strings/4 may exceed SMs; use *_56SM), ≥60 → silent; Cancel→exit 30; -Auto = print+proceed.
     start-pianoid.bat: running-servers block (RC20→cancel) after node_modules check L97-124, CUDA block (RC30→cancel)
     after :after_update_check L170-198; both gated by `if not exist ...ps1`+`where powershell`, pass -Auto when
     NOPROMPT=1. FLAG DESIGN (flagged to team-lead): under /auto both run NON-interactively (safe-default+proceed) so
     an unattended shortcut never hangs on a pop-up. VERIFIED static/AST/sim only (stack LEFT RUNNING — NO launch, NO
     live-port kill): both .ps1 AST-clean; check-cuda -Auto via prod path detected RTX 4070 SUPER=56 SMs→correct <60
     warning; check-running-servers -Auto detected live [3000,3001,5001]+left untouched; .bat full routing S1-S5 (bare
     all-clear→LAUNCH, servers-up Cancel→abort, CUDA Cancel→abort, /auto→both run w/-Auto→LAUNCH, /auto-noupdate→update
     skipped+both run→LAUNCH). Committed feature/launcher-prelaunch-checks (2dff830 feat + 1951b83 docs, off master
     c6baf4e). NO CUDA build, NO backend, NO stack launched. Docs (QUICK_START Pre-launch-safety-checks subsection) +
     session log on this branch. NOT merged/pushed. -->
<!-- (none active for dev-syschecks — released at Phase 1) -->
<!-- dev-b70f locks RELEASED 2026-06-09 at Step 10a Phase 1 commit (NOT merged/pushed — team-lead FFs onto
     master + pushes). Held (OUTER PianoidInstall repo root): start-pianoid.bat (edit), check-updates.ps1 (NEW),
     make-shortcut.bat (NEW), make-shortcut.ps1 (NEW). Launcher enhancements: (1) start-pianoid.bat parses %1 →
     /auto (alias --no-prompt) skips both keypress pauses; /auto-noupdate (alias /no-update-check) also skips the
     update check; bare = current interactive prompts; error path still pauses in /auto so a shortcut-launched
     failure stays visible. (2) Best-effort origin-ahead update check before launch via check-updates.ps1 →
     Yes/No pop-up → Yes calls update-repos.bat then launches; fully guarded (git-missing/offline/no-upstream/any
     failure → silent fall-through to launch, NEVER blocks/hangs/errors). check-updates.ps1 = timeout-guarded
     git fetch + rev-list ahead-count for Core/Tunner/Basic(current branch)+Install(master); exit 10=update/0=skip.
     (3) make-shortcut.ps1+.bat = WScript.Shell COM → Desktop\Pianoid.lnk targeting `start-pianoid.bat /auto`,
     repo-root workdir, favicon.ico icon. VERIFIED non-disruptively (stack left running): both .ps1 AST-parse clean;
     start-pianoid.bat all 4 flag branches sim-tested via stubbed copy through cmd /c; check-updates.ps1 git-unreachable→
     exit 0 + ahead-detection unit-tested (up-to-date/ahead/no-upstream/missing) + real read-only 4-repo probe (6.0s,
     no pop-up) + Main Yes→10/No→0 decision; make-shortcut real run → Desktop\Pianoid.lnk created, all props asserted.
     Committed feature/launcher-update-check-shortcut da7c1d5 (off master d7465a3). NO CUDA/backend, NO stack launched,
     NO real pull. Docs (QUICK_START.md launch subsection) + session log on this branch too. -->
<!-- dev-09cf locks RELEASED 2026-06-09 at Step 10a Phase 1 commit (user-approved scroll fix, "OK"). Held:
     PianoidTunner/src/components/ToolBar.jsx. Top-toolbar responsive truncation fix — `<Toolbar>` gets a contained
     `sx` (overflowX:auto + overflowY:hidden + `& > * {flexShrink:0}` + thin dark-theme scrollbar) so the dense
     heterogeneous control row scrolls instead of clipping its rightmost controls at narrow widths; wide layout
     byte-identical. Verified live (chrome-devtools @1600/800/500 — all controls reachable, no page-level h-scroll,
     wide unchanged) + full Jest 91 suites/1003 tests green + eslint 0 new. Committed on PianoidTunner
     feature/toolbar-responsive-overflow (off current HEAD feature/eslint-casing-fix; SHA in session log). NOT
     merged/pushed — team-lead FFs onto dev + pushes (+ Phase 2 wrap). Docs (OVERVIEW ToolBar row) + session log on
     PianoidInstall master. Frontend-only, NO CUDA/backend. -->
<!-- dev-pipefix locks RELEASED 2026-06-09 — merged: eslint fix → PianoidTunner dev (8b9acf3); synthetic-dataset → dev (Core a35800a, Tunner 8b9acf3); outer setup-pianoid scripts + update-repos.{bat,sh} (NEW) + docs (QUICK_START/LINUX_BUILD Status_indicator_OK→dev) → master. -->
<!-- dev-setuppath locks RELEASED 2026-06-08 at Step 10a Phase 1 commit. Held (OUTER PianoidInstall repo root):
     setup-dev.ps1, setup-path-guard.ps1 (NEW), tests/setup-path-guard.Tests.ps1 (NEW). PATH-preserving guard so
     setup-dev.ps1 stops breaking NI LabWindows/CVI: the script doesn't persist PATH itself, but the installers it
     launches (Python PrependPath, VS Build Tools, CUDA, Node MSI) rewrite the persistent PATH and drop NI/CVI
     entries. Fix: setup-path-guard.ps1 (8 pure/unit-tested helpers) snapshots Machine+User PATH before installers +
     writes a timestamped backup + NI/CVI heads-up, then reconciles dropped entries after (dedup, survivors-first,
     2047-char truncation guard refuses-not-truncates); Python PrependPath=0 by default (-PythonPrependPath opt-in).
     Also ASCII-cleaned the 4 pre-existing em-dashes (removes a latent no-BOM ParseFile fragility). Unit test 17/17
     PASS (PS 5.1, no Pester dep); ParseFile clean. NO CUDA build, no stack, no audio, no servers. Committed on
     feature/setup-path-preserve-cvi bec2ccf, MERGED to master d7df7f4 (--no-ff), pushed to origin. Docs (BUILD_SYSTEM.md Step-1
     PATH-preservation subsection + encoding caveat) + session log on master. -->
<!-- dev-synthfe Phase-4b locks RELEASED 2026-06-08 at Step 10a Phase 1 commit (NOT merged/pushed —
     awaits user live-test + merge approval). Held (PianoidTunner repo, off dev): SynthesizeSection.jsx,
     SynthComparisonView.jsx, SynthGridSelector.jsx (3 NEW under modules/panels/collection/), useSynthesize.js
     (NEW hook), utils/synthScorecard.js (NEW, 8 DeepSeek helpers) + GridLayoutEditor.jsx (edit: additive
     selectMode/onSelectCell/cellRender) + CollectionSubpanel.jsx (edit: Record|Synthesize toggle) + 3 NEW
     test files. Synthetic-dataset Phase 4b FRONTEND — the MA Collect "Synthesize" sub-mode + the
     reconstructed-vs-ground-truth comparison charts (the headline comment-1 deliverable). HYBRID routing
     (dev.md Step 4b): 8 pure JS/Jest helpers via the DeepSeek batch pipeline (8/8 shipped first-try, $0.0043,
     node --test gate); the hook + 4 components + 2 edits Opus-inline. REUSE per DECISIONS comment 2:
     GridLayoutEditor EXTENDED (additive select-mode, not cloned), ImpulseShapeChart reused as the impulse
     preview, NumInput for every numeric field — no recreation. ACCEPTANCE: 62 new Jest tests (synthScorecard
     49 + SynthesizeSection 9 + GridLayoutEditor.selectMode 4) + 0 regression (CollectionSubpanel 4/4) + 0
     eslint errors. ★LIVE UI end-to-end PASSED on the full stack (launcher+React 3000/3001 + modal adapter
     5001): Record|Synthesize toggle → Synthesize section (mode table + dead-channel grid + impulse) →
     Synthesize 201 → Validate 200 → comparison charts rendered with PASS verdict, MAC 1.000, recall 1.000,
     both modes recovered exactly; live ECharts clean. Live-fix during verify: SYNTH_TIMEOUT_MS 180→600s (GPU
     cold-start). Committed PianoidTunner feature/synthetic-dataset `e707408` (feat) + `a99a41f` (timeout fix).
     Frontend-only, NO CUDA build. NOT merged/pushed. Docs (OVERVIEW Synthesize sub-mode + proposal status
     PHASES 1-4 ALL BUILT) + log + ledger + screenshot on PianoidInstall master. -->
<!-- (none active for dev-synthfe — released at Phase 1) -->
<!-- dev-synth1 Phase-4a locks RELEASED 2026-06-08 at Step 10a Phase 1 commit (NOT merged/pushed —
     orchestrator sequences Phase 4b frontend; team-lead said the backend is fully done after 4a).
     Held (PianoidCore repo): synth/synth_routes.py (NEW), routes/__init__.py (edit: register_synth_routes),
     tests/integration/test_synth_routes.py (NEW). Synthetic-dataset Phase 4a — the synthesize/validate REST
     routes on modal_bp wiring the P1-3 backend into REST: POST /modal/measurements/synthesize (→201 +
     synthetic Measurement) + POST /modal/measurements/<id>/validate (→200 + ValidationScorecard JSON).
     Reuses import_folder_as_measurement UNCHANGED. 100% Opus-inline, 0 DeepSeek. 8/8 route tests; synth
     integration 16/16 (1 PRE-EXISTING unrelated fail proven at clean HEAD). Committed PianoidCore
     feature/synthetic-dataset `a35800a` (off P3 37bd432, +379/3 files). Pure Python + CuPy — NO CUDA/.cu, NO
     rebuild. NOT merged/pushed. Docs (TESTING.md + proposal status BACKEND-COMPLETE) + log + ledger + the
     REST contract on PianoidInstall master.
     ★INCIDENT (recovered, no harm): a pre-existing-failure check used `git stash push -- <untracked files>`
     (fails) + bare `git stash pop` → popped the unrelated preserved stash@{0} (dev-35a3 CUDA work) with
     conflicts; restored via `git checkout HEAD -- <9 files>` + rm; the dev-35a3 stash is PRESERVED (intact).
     LESSON: never stash/bare-pop in a shared tree with pre-existing stashes. -->
<!-- dev-synth1 Phase-3 locks RELEASED 2026-06-08 at Step 10a Phase 1 commit (NOT merged/pushed —
<!-- dev-synth1 Phase-3 locks RELEASED 2026-06-08 at Step 10a Phase 1 commit (NOT merged/pushed —
     orchestrator sequences Phase 4). Held (PianoidCore repo):
       pianoid_middleware/modal_adapter/synth/validate.py (NEW — validation harness)
       tests/integration/test_synth_validate.py (NEW)
       pianoid_middleware/modal_adapter/synth/forward_model.py (re-edit: interior-receiver default fix)
     Synthetic-dataset Phase 3 — validation harness: runs the REAL EspritRunner on a synthetic dataset →
     match_modes#15 → precision_scorecard#17, scoring with the INDEPENDENT synth.metrics.compute_mac#12 (NOT
     band_merging — circular-dep). 100% Opus-inline, 0 DeepSeek. ★Lowest-band-first surfaced + I root-caused
     (by measurement, probe7) a DEAD-CHANNEL regime: default receivers sat on plate-boundary nodes (simply-
     supported eigenmodes = 0 there) → noise poisoning ESPRIT. FIX: forward_model default receivers inset to
     the plate INTERIOR (physics untouched — P2 CPU↔GPU parity still bit-exact) + harness amplitude-normalize
     + a per-channel dead-channel diagnostic (channel_diagnostics, for the Phase-4 UI; captured into
     DECISIONS.md comment 3 ★INTERIOR PLACEMENT). ACCEPTANCE both green: clean lowest-band hits thresholds on
     5×5 AND 7×7 (median freq err 7e-5/1.3e-4 <1%, MAC 0.995 >0.95, recall 0.92 >0.9, all 4 modes); band-
     mismatch → recall 0.0. 5/5 integration tests; 367 no-regression. Committed PianoidCore
     feature/synthetic-dataset `37bd432` (off P2 e3658e4, +474/3 files). Pure Python + CuPy — NO CUDA/.cu, NO
     rebuild. NOT merged/pushed. Docs (TESTING.md + proposal status PHASES-1-3) + log + ledger on
     PianoidInstall master. -->
<!-- dev-synth1 Phase-2 locks RELEASED 2026-06-08 at Step 10a Phase 1 commit (NOT merged/pushed —
<!-- dev-synth1 Phase-2 locks RELEASED 2026-06-08 at Step 10a Phase 1 commit (NOT merged/pushed —
     orchestrator sequences Phases 3-4). Held 3 NEW PianoidCore files + the synth/__init__.py edit:
       PianoidCore: pianoid_middleware/modal_adapter/synth/forward_model.py (NEW)
       PianoidCore: pianoid_middleware/modal_adapter/synth/dataset_writer.py (NEW)
       PianoidCore: tests/integration/test_synth_forward_model.py (NEW)
       PianoidCore: pianoid_middleware/modal_adapter/synth/__init__.py (Phase-2 exports added)
     Synthetic-dataset Phase 2 — GPU sim orchestration (forward_model.py xp-switch mirroring
     esprit_core._to_gpu_or_cpu; oversample→scipy.signal.decimate→48kHz; grid/modes parametric, default
     7×7+12) + dataset_writer.py (exact Measurement import layout). 100% Opus-inline, 0 DeepSeek. ACCEPTANCE:
     CPU↔GPU parity BIT-EXACT (0.000e+00); live POST /modal/measurements/import_folder → HTTP 201 (3 sc /
     25 ch / 48k — confirms the (samples,n_channels) float32 npy contract via the REAL importer); 11/11
     integration tests. Committed PianoidCore feature/synthetic-dataset `e3658e4` (off Phase-1 b9c0380,
     +619/4 files). Pure Python + CuPy — NO CUDA/.cu, NO rebuild. NOT merged/pushed (awaits Phases 3-4 + user
     gate). Docs (TESTING.md + proposal status) + log + ledger on PianoidInstall master. -->
<!-- dev-synth1 locks RELEASED 2026-06-08 at Step 10a Phase 1 commit (NOT merged/pushed — orchestrator
     sequences Phases 2-4). Held 11 NEW files, ALL in the **PianoidCore** repo (repo-relative paths;
<!-- dev-synth1 locks RELEASED 2026-06-08 at Step 10a Phase 1 commit (NOT merged/pushed — orchestrator
     sequences Phases 2-4). Held 11 NEW files, ALL in the **PianoidCore** repo (repo-relative paths;
     all created this session, no conflict possible):
       PianoidCore: pianoid_middleware/modal_adapter/synth/{__init__,geometry,pulse,oscillator,metrics}.py
       PianoidCore: tests/unit/conftest.py (the `xp` fixture) + tests/unit/test_synth_{geometry,pulse,oscillator,metrics,parity}.py
     Synthetic-dataset Phase 1 — pure-fn core (17 xp-agnostic numpy/cupy fns) via the dev.md Step-4b
     delegation model: DeepSeek batch pipeline shipped 16 routine fns first-try ($0.0107, 0 escalated, 0
     harness errors); Opus authored the 1 judgment fn integrate_modal_oscillator (#8, exact-ZOH IIR). 3
     dependents CALL their deps (compute_mac/relative_error/oscillator_zoh_coeffs). DUAL-BACKEND GATE:
     356/356 green on numpy AND cupy (178+178, cupy genuinely ran on GPU). §3.4.2 parity cross-check
     <1e-2 at the validated band. Committed PianoidCore feature/synthetic-dataset `b9c0380` (off dev
     9f2c3b5, +1634/11 files). Pure Python + CuPy — NO CUDA/.cu, NO rebuild. NOT merged, NOT pushed
     (awaits Phases 2-4 + user gate). Docs (TESTING.md + proposal status header) + session log + ledger
     ref on PianoidInstall master. Stats ledger: D:/tmp/synthds-build/{ledger.json,LEDGER.md}. -->
<!-- dev-minopus locks RELEASED 2026-06-07 at Phase-2 merge. tools/dev-pipeline/ (common.py + the 4 bookkeeping
     scripts + marker_hook.py + README + tests) committed 5be7efa, merged to master a02b67b + pushed (d60fb57). -->
<!-- dev-dsfix locks RELEASED 2026-06-06 at Step 10a Phase 1 commit (user-approved option A — commit only, NO
     merge/push). Took over dead deepseek-phase0's tools/deepseek-codegen-mcp/** lock and CONTINUED the
     integration: FIX deepseek-codegen MCP reliability (dir-1) + add NON-THINKING codegen mode (dir-2).
     Held: tools/deepseek-codegen-mcp/core.py, README.md, test_core.py (server.py + test_integration.py
     locked precautionarily, NOT edited).
     ROOT CAUSE (measured): deepseek-v4-flash is a dual-mode REASONING model; with thinking ENABLED it
     spends reasoning_tokens (measured 1.1k-11.8k) before the answer, counting against max_tokens → the
     4096 cap truncated complex bodies (no closing fence → unusable) or let reasoning eat the whole budget
     (no visible content → "empty implementation"); intermittent because reasoning length varies.
     FIX: (1) disable thinking for codegen (`{"thinking":{"type":"disabled"}}` = DEEPSEEK_THINKING_DISABLED)
     — the real speed/cost lever, eliminates the failure structurally; (2) DEFAULT_MAX_TOKENS 4096→32768
     (env-overridable DEEPSEEK_MAX_TOKENS) as defense-in-depth; (3) hardened extract_code (3-tier: closed
     fence / unterminated-fence recovery / bare-code; never returns a ```lang marker as code). v4-flash pin
     + temp 0.0 unchanged. +10 unit tests; README updated. NESTED-backtick extractor edge (review Medium #1)
     DEFERRED.
     MEASURED: thinking-fix 6/6 usable + oracle-correct (calc 71/71, csv 53/53); non-thinking 9/9 usable
     (finish=stop, reasoning_tokens=0), ~3-19x fewer completion tokens/call, much faster, with a small
     first-pass oracle dip on the hardest specs (csv 44-52/53; the /fn test is the correctness gate). Tool
     suite 48/48 (46 unit + 2 integration incl. 1 live call). Pure-Python, NO CUDA/engine/middleware;
     server.py untouched.
     COMMITTED on feature/deepseek-codegen-mcp (Phase 1 — SHA in session log). NOT merged, NOT pushed
     (awaiting user merge/push approval — Phase 2 pending team-lead relay). Session log NOT yet archived
     (Phase 2). -->
<!-- dev-dsfix locks RELEASED 2026-06-07 at Step 10a Phase 1 commit (user-approved "commit your scope ONLY",
     NO merge/push). PRODUCTIONISED the L3 batch codegen pipeline: NEW tools/deepseek-codegen-mcp/
     batch_pipeline.py + test_batch_pipeline.py (standalone CLI: manifest → parallel delegate → DeepSeek
     self-review → test gate → re-delegate ≤K → escalate; never ships a failing body, invariant shipped-iff-
     passed) + the 2 real-life gap fixes (conftest/_candidate gate convention; collection-error→harness_error
     no-retry) + Gap A (dual-backend xp_untested signals) + Gap B (deps DAG: validate/topo-layer/expose,
     --expose). core.py UNCHANGED (context_snippets already existed). Held: tools/deepseek-codegen-mcp/
     batch_pipeline.py + test_batch_pipeline.py + README.md (server.py/test_integration.py/core.py NOT edited
     this phase). PROVEN: full repo suite 67/67; real Arm B re-run 17/17 (dual-backend both [numpy]+[cupy],
     3 dependents CALL their helpers). Committed on feature/deepseek-codegen-mcp (Phase-1 SHA in session log);
     NOT merged, NOT pushed. Design/analysis proposals (docs/proposals/deepseek-*.md) committed by team-lead.
     fn.md/dev.md = orchestrator-owned (untouched). Session log NOT archived (Phase 2 pending — not merged). -->
<!-- (none active for dev-dsfix — released at Phase 1) -->
| <!-- (none) --> | | | |
<!-- dev-wave3split-f634 locks RELEASED 2026-06-06 at Step 10a Phase 2 (user-approved "Merge and push" via Telegram;
     executed by sync-release as part of the multi-repo release). Held 9 files: modal_adapter.py, chain_editor.py (NEW),
     project_store.py (NEW), apply_service.py, esprit_orchestrator.py (NEW), tests/unit/test_modal_adapter_state.py,
     tests/unit/test_qc_curves.py, tests/integration/test_project_v2_branch.py (renamed → test_project_store.py),
     tests/integration/test_measurement_rename.py. Wave 3 Modal Adapter facade split (Option A): extract ChainEditor +
     ProjectStore, migrate deferred-QC/ESPRIT logic out of facade to ApplyService/EspritOrchestrator, rename
     test_project_v2_branch → test_project_store (§8.2). modal_adapter.py 4253 → 1755 LOC (−58.7% wave, −69% from 5649).
     613 tests pass / 1 skipped / 1 pre-existing-failure (documented). /modal smoke 200. Behaviour identical. 2 endorsed
     judgment calls: kept run_full_pipeline on the facade (5-service orchestrator); did NOT fold test_measurement_rename
     into test_project_store. Committed PianoidCore feature/modal-adapter-wave3-split (4 commits: 3a26270 ChainEditor,
     aeaa717 ProjectStore, 7e8e9d7 deferred-QC/ESPRIT migration, 0248b46 test rename), MERGED to dev `9f2c3b5` (--no-ff).
     Pure-Python refactor — no CUDA rebuild. Literal ~400-LOC thin-facade rewrite DEFERRED to follow-up proposal
     docs/proposals/modal-adapter-facade-shim-removal-2026-06-06.md (300-test rewrite). Session log archived to
     logs/archive/. -->
<!-- (none active for dev-wave3split-f634) -->
<!-- dev-fbsl PianoidTunner locks RELEASED 2026-06-05 (team-lead-directed, to unblock dev-mzoom's PianoidTuner.js SC-zoom work). Frontend slider work is COMMITTED on feature/feedback-coeff-slider 9aa0e3e (usePreset.js + useBackendHealth.js + ToolBar.jsx + PianoidTuner.js); no further frontend edits needed. PianoidCore/PianoidBasic locks KEPT (switch-path test + merge). -->
<!-- dev-fbsl locks RELEASED 2026-06-06 (Step 10a Phase 2, reconciled by sync-release — work already MERGED + PUSHED
     2026-06-06 by dev-mzoom per the user's "include in the push", all CLEAN no conflicts). Held: ModelParams.py,
     pianoid.py, backendServer.py, tests/system/test_feedback_coeff_sound_channels.py. Feedback-coefficient slider:
     per-preset deck_feedback_coefficient persistence + runtime feedback_coeff/store_feedback_coeff + switch_preset
     ownership inversion + /health flags + sound-channels/switch-path tests. Backend: PianoidCore dev ed99d42 (slider
     tip 9a88518 incl. UNRUN switch-lifecycle test); PianoidBasic dev d86b477 (slider 4660f6b); frontend PianoidTunner
     dev 05ce924 (slider 9aa0e3e). ★UNVERIFIED — needs a BACKEND REBUILD to function; preset-switch lifecycle test
     (9a88518) UNRUN; user rebuilds + live-tests on another system. Frontend Jest stays green (88/941, eslint 0).
     NO CUDA build done by dev-fbsl itself (frontend composition + middleware/Python). -->
<!-- (none active for dev-fbsl) -->
<!-- dev-mzoom locks RELEASED 2026-06-06 (Step 10a Phase 2, reconciled by sync-release — (1)+(2) and the P0/P1 of (3)
     already MERGED to PianoidTunner dev + PUSHED to origin). Held: PianoidTuner.js, hooks/useCurrentValues.js,
     utils/chartView.js (NEW), SoundChannelsPane.jsx, MeasuredMatrix.jsx, RowEditor.js, BarChart.jsx,
     DrawableChart/DrawableChart.jsx, SoundChannelsAggregateChart.jsx. Three sub-features: (1) matrices-zoom +
     selection-scoped edits + AVG-mode zoom/mute (f3ff30a); (2) bar-chart auto-scale toggle (795f559); (3) system-wide
     selection + per-chart tie/untie zoom (docs/proposals/system-wide-selection-2026-06-06.md) — P0 core + P1 Feedin
     reference MERGED to dev (41b4737). ★HARD CONSTRAINT preserved: SC channel-ROW axis stays SC-LOCAL, NEVER global
     pitch (dev-snmtxleak/fa3c64b) — only SC MODE axis ties to global selectedModes. Jest 88/941, eslint 0. Frontend-only,
     NO CUDA build. ★DEFERRED follow-up (REAL pending work — see WORK_IN_PROGRESS.md): (3) P2 (highlight band in
     DrawableChart) + P3 (rollout to Feedback/Modes/Workbench/SC mode-axis) PENDING the user's cross-system test of the
     Feedin reference. Do NOT lose this — it is greenlit, partially-shipped work awaiting a user gate. -->
<!-- (none active for dev-mzoom) -->
<!-- dev-mzoom locks RELEASED 2026-06-05 at Step 10a Phase 1 commit. Held:
     PianoidTunner/src/PianoidTuner.js + src/components/SoundChannelsPane.jsx. Unlock existing
     matrix zoom for Sound Channels (mode-axis): un-gate SC in renderToolbarControls zoom-button
     id list + wire SC mode-COLUMN axis to shared rangeOfModes/selectedModes (zooms like
     Feedin/Feedback). Channel-ROW axis kept full (SC rows = output channels 0..N-1, not piano
     pitches — shared piano-space rangeOfPitches would blank them; deferred follow-up). Reset
     [0,63] modes bug is PRE-EXISTING + SHARED (Feedin/Feedback too) — NOT fixed here, flagged in
     WIP. Committed PianoidTunner feature/mzoom-sc-zoom ba38453 (off dev e2aaacf, +25/-3, 2 files).
     Jest 83 suites/903 tests green; 0 eslint errors. Frontend-only, NO build, no servers.
     NOT merged — awaits user test + approval. Co-edits PianoidTuner.js with dev-fbsl's COMMITTED
     feature/feedback-coeff-slider (disjoint regions: fbsl=ToolBar/usePreset wiring + Feedback
     Alert; mzoom=renderToolbarControls zoom buttons + SC call-site) → clean 3-way merge expected,
     team-lead sequences fbsl-then-mzoom at integration. Docs (OVERVIEW SC row + WIP follow-ups)
     + session log on PianoidInstall master. -->
<!-- (none active for dev-mzoom) -->
<!-- dev-mtxfix locks RELEASED 2026-06-05 at Step 10a (team-lead-approved single batch wrap + push). Held:
     PianoidTunner MatrixTools.jsx/.css + __tests__/MatrixTools.theme.test.jsx (deleted), SoundChannelsPane.jsx,
     MeasuredMatrix.jsx, RowEditor.js, hooks/useSettings.js + 2 test files (RowEditor.axisVariant.test.jsx new +
     SoundChannelsPane.localChannel.test.jsx). Matrices-UI live-fix batch: (1) REVERT M1 dark-theme toolbar
     (restore raster icons + #ddd light bg = visible edit buttons; deleted M1-only theme test); (2) PART 3 SC pitch
     control still showed a keyboard after Rotate — bottom RowEditor ruler ignored axisVariant; threaded axisVariant
     MeasuredMatrix->RowEditor + FlatBarAxis for channel rows; (3) PART 4 SC per-channel matrix chart rendered as a
     LINE — soundChannelSettings.visualization='line' (aggregate-only default, pre-existing from dev-drawable-sc
     Wave 3) leaked into MeasuredMatrix's RowEditor; SoundChannelsPane now overrides visualization='bar' for the
     matrix path (aggregate keeps 'line'); corrected the misleading useSettings comment. All other dev-uimtx work
     (C1/H1/H2/H3/M3/bar-chart/clip) intact. Full Jest 83 suites/903 tests green; frontend-only, NO build.
     PianoidTunner feature/dev-mtxfix-revert-m1 278ee39 MERGED to dev e2aaacf (--no-ff). Docs (OVERVIEW RowEditor
     row + WIP matrix-zoom gap follow-up) + session log on PianoidInstall master. Pushed to origin. -->
<!-- (none active) -->
<!-- dev-steinway-preset locks RELEASED 2026-06-05 at Step 10a Phase 2 (user-approved SHIP option A). Held:
     PianoidCore/pianoid_middleware/presets/Belarus_196modesC_Steinway1860 (NEW),
     .../Belarus_196modesC_Steinway1860_56SM (NEW), pianoid_middleware/auto_tuner.py,
     tests/unit/test_auto_tuner_robust.py (NEW). 2 Steinway 1860 mensur presets (full 88-key 58-block +
     56-SM 84-key trim) + robust harmonic-comb FrequencyTuner (R1 adaptive window/zero-pad, R2 comb f0,
     R3 comb-consistency confidence [deleted the 0.5 floor], R4 inharmonic stretched comb + treble window).
     Committed feature/steinway-1860-presets f30ba32 + 5655f02, MERGED to dev 7394188 (--no-ff, branch kept).
     NOT pushed (/sync handles origin reconcile + push-all). Regression: test_auto_tuner_robust 14/14 +
     test_tune_pipeline 59/59. Source preset Belarus_196modesC was READ-ONLY (untouched). -->
<!-- (none active) -->
<!-- dev-asioload locks RELEASED 2026-06-03 at Step 10a Phase 2 (recovery wrap of the orphaned 2026-06-02 HOLD,
     same agent ID; user-approved merge + Phase 2 via Telegram). Held: PianoidCore/pianoid_cuda/Pianoid.cu,
     Pianoid.cuh, AddArraysWithCUDA.cpp, pianoid_middleware/backendServer.py, tests/system/test_asio_fallback.py (new).
     ASIO→SDL3 auto-fallback (option B) + USER-VISIBLE warning. C++: startAudioDriver() catches the ASIO init throw →
     reconstructs SDL3 (createDriverWithType(SDL3, chunks=16)+setupCuda+init); engine records requested/active driver +
     reason (engine = sole writer, P1); rethrows on non-ASIO failure OR if the SDL3 fallback ALSO fails (fail-fast S5).
     pybind getters (didAudioDriverFallback/getRequestedDriverType/getActiveDriverType/getAudioDriverFallbackReason) in
     AddArraysWithCUDA.cpp. Middleware: /health `audio_driver_fallback` dict + WS lifecycle push (mirrors cfl_redline
     precedent, same _audio_driver_fallback_status() helper). pianoid.py was locked then RELEASED 2026-06-02T19:22Z —
     no edit needed (fallback fully in C++). --heavy --release build verified (4 getters bound into correct-venv .pyd).
     END-TO-END VERIFIED on this no-ASIO machine: /health audio_driver_active=TRUE + audio_driver_fallback dict
     populated (occurred:true, requested:ASIO_CALLBACK, active:SDL3); engine isAudioDriverActive()=True / didFallback=True;
     test_asio_fallback.py 3/3; perf 5/5 + sound_regression PASS (synthesis byte-identical). COMMITTED PianoidCore
     feature/asio-sdl-fallback `3ef4e69` (5 files +330/-3), MERGED to dev `b88a627` (--no-ff). Feature branch KEPT.
     NOT pushed (local dev was 5 behind origin/dev — origin reconciliation deferred to orchestrator/user, same
     "LANDED VIA PULL MERGE" pattern as dev-7032/dev-eac2). Docs (AUDIO_DRIVERS/REST_API/STARTUP_TROUBLESHOOTING/
     TESTING) + session log on root master (9ab2571 + this Phase-2 bookkeeping commit). DEFERRED follow-up: Layer 3
     (PianoidTunner FE warning chip consuming the WS audio_driver_fallback field) is UNBUILT — correctly deferred while
     the FE tree was held by dev-blur; now an UNBLOCKED clean follow-up since PianoidTunner dev is clear (dev-blur
     COMPLETED 2026-06-03 @234e1b9). NO PianoidTunner edits this session. Session log archived to logs/archive/. -->
<!-- dev-3580 lock RECONCILED 2026-06-03 by dev-asioload (STALE — guards nothing). The active `| dev-3580 |` row that
     stood below on PianoidCore/pianoid_cuda/Pianoid_excitation.cu has been removed. Its content was a diagnostic
     NOTE_OFF_PROBE in `_add_string_for_playback` (a live note-off bisect probe, explicitly NOT a real fix and NOT to be
     merged to dev). The probe was preserved ONLY in `stash@{0}` = `26799bf` (alongside the dev-soundint-live work) —
     and that stash/branch/commit are VERIFIABLY GONE (confirmed by the dev-soundint-live RELEASED comment + the
     2026-05-30/05-31 verification: `git stash list` carries no soundint entry, `git branch -a | grep -i soundint`
     empty, `git cat-file -t 26799bf` → "Not a valid object name"). The 55/56/57 trichotomy this probe was investigating
     was independently RESOLVED by dev-427c (P1-1 GPU-pointer authority race, merged to PianoidCore dev `a352b2f`). With
     the protected stash gone and the bug resolved, the row protects nothing and is reconciled to this comment. The
     PianoidCore tree is clean on dev (Pianoid_excitation.cu committed-clean — no orphaned probe in the working tree). -->
<!-- dev-blur locks RELEASED 2026-06-03 at Step 10a Phase 2 (recovery wrap, user-approved full merge).
     Held: PianoidTunner NumInput/NumInput.js, Mode.jsx, Strings.jsx, GaussCell.jsx,
     ToolBar.jsx, NumInput/__tests__/numInput.blur.test.jsx (new),
     __tests__/ToolBar.commitKey.test.jsx (new). NumInput persist-on-blur: shared
     commitValue(rawString) (Enter+blur), handleBlur decision table, optional commitKey
     edit-identity guard (+editKeyRef). All 4 Group-1 callers wired — Mode/Strings (commitKey=key),
     GaussCell (`${level}-${chart}-${name}`), ToolBar (composite of selectedParameter
     groupe/name/gaussIndex/levelValue + pitch/mode, on the shared selected-param NumInput).
     Committed PianoidTunner feature/numinput-persist-on-blur 76a56fd (7 files, +471/-67),
     MERGED to PianoidTunner dev 234e1b9 (--no-ff). Feature branch KEPT. NOT pushed (PianoidTunner
     dev is local-only since dev-numsplit). Full Jest 70/830 → 71/834 (+1 suite ToolBar.commitKey /
     +4 tests; ZERO regressions); 0 new eslint warnings on changed files. Docs (OVERVIEW NumInput row +
     CODE_QUALITY God Objects NumInput.js RED rank 16 @1036 + P2-1 config-editor split named) already
     updated by the prior dev-blur session; recovery verified accuracy. FRONTEND-ONLY, NO CUDA/backend,
     no servers started (Jest jsdom). PianoidCore untouched (off-limits — on dev-asioload's
     feature/asio-sdl-fallback). Session log archived to logs/archive/. -->
<!-- dev-8085 locks RECONCILED 2026-06-03 by dev-blur (STALE — the 2 active `| dev-8085 |` rows that
     stood here are now removed). Per the dev-df69 consolidation (2026-05-31, comment further below):
     feature/lower-default-volume-100 (120→100 default preset-load volume) is an ANCESTOR of PianoidTunner
     dev (usePreset.js:152 default = 100, merged at 2d23254; ToolBar.jsx volume change history 88a016f) —
     the work shipped, the rows were orphaned leftovers the consolidation noted ("2 duplicate rows
     collapsed") but never deleted. dev-blur legitimately re-acquired + released ToolBar.jsx this session
     (persist-on-blur commitKey wiring) and usePreset.js is committed-clean on dev, so reconciling both
     dev-8085 files into this single RELEASED comment is in-scope. Held files were: ToolBar.jsx,
     usePreset.js. Tree clean. -->
<!-- dev-numsplit locks RELEASED 2026-06-01 at Step 10a Phase 1 commit (user-approved, live-tested "works"). Held:
     PianoidTunner/src/components/NumInput/NumInput.js + numInputMath.js (new) + useNumInputCaret.js (new) +
     __tests__/numInputMath.test.js (new). NumInput god-object split 1555 RED → 995 YELLOW (review R-1):
     pure math (formatNumber/anchorExponentCaret/getStepFromCursorPosition/computeExponentStep/getInputTitle/
     generateUniqueId) → numInputMath.js; caret machinery → useNumInputCaret hook; arrow-handler + config-commit
     dedup in-component. Public prop API byte-identical. Committed PianoidTunner feature/numinput-split c8edfa1
     (+962/-829, 4 files). Full Jest 68/795→69/820 (zero regressions); 3 files eslint-clean. Docs (CODE_QUALITY
     God Objects RED→YELLOW + OVERVIEW NumInput row) + session log on root master. MERGED to PianoidTunner dev
     (--no-ff) at Phase 2. NOT pushed (user did not request push — local only). -->
<!-- dev-df69 lock RELEASED 2026-05-31T09:35Z: PianoidTunner/src/PianoidTuner.js merge conflict resolved
     (feature/preset-settings-ui → dev), committed b24dead + pushed (origin/dev == b24dead, verified).
     dev-177a even-scheduler ONLINE + dev-8abf offline-WAV OFFLINE both survive; stopSweep + unmount
     cleanup tear down both. Full Jest 68/795 PASS, build0, eslint0. -->
<!-- ★dev-df69 consolidation NOTE: the merged feature/preset-settings-ui carried dev-bbcb (c19bb1e) +
     dev-e9ed (89cf124) + dev-8abf (bb46876) work into PianoidTunner dev. dev-bbcb's + dev-e9ed's ACTIVE
     lock rows below (ObjectInspector.jsx, NumInput.js, PaneSettingsDialog.jsx, PresetPanel.jsx + tests)
     are now STALE — their committed work is in dev; they will be reconciled (rows cleared) in the
     lock/WIP housekeeping at the end of this consolidation, after PianoidCore + master are pushed. -->

<!-- dev-8abf RE-ACQUIRED + RE-RELEASED 2026-05-31T09:20Z: post-Phase-1 NUL-byte correction in
     PianoidTunner/src/utils/__tests__/audioPlayback.test.js (Write tool turned a 4-space run in the
     SAMPLE_B64 literal into 4 NUL bytes → committed blob flagged binary). Rewrote NUL-free + amended the
     held FE commit (64ce7de → bb46876, NOT merged/pushed). 7/7 + full Jest 68/795 still PASS; committed blob
     now 0 NULs (git treats as text). -->
<!-- dev-8abf locks RELEASED 2026-05-31T09:13Z at Step 10a Phase 1 commit. Held:
     PianoidCore/pianoid_middleware/backendServer.py, PianoidTunner/src/PianoidTuner.js,
     PianoidTunner/src/utils/audioPlayback.js (new), PianoidTunner/src/utils/__tests__/audioPlayback.test.js (new),
     docs/development/diagnostics/dev-8abf-offline-audio-data-roundtrip.py (new).
     OFFLINE "Play All" playback fix (Option A): offline /play_keyboard now returns base64 `audio_data`
     (list-shaped, matches /get_chart_test) read from the already-written WAV; FE startSweep offline branch
     decodes audio_data[0] and plays via a hidden <audio>, idiom extracted to utils/audioPlayback.js (+7 Jest).
     Committed BE PianoidCore feature/start-right-away-binary `bdfc7c0` (+10); FE PianoidTunner
     feature/preset-settings-ui `bb46876` (+212/-1, on top of dev-e9ed 89cf124); docs/log/diagnostic on root master.
     FE Jest 68/795 PASS (+1 suite/+7 tests, 0 regressions) + build clean; BE 12/12 isolated round-trip.
     NEITHER branch merged — held for the user's post-release batch test (orchestrator consolidates later).
     ★dev-eac2's stale lock on backendServer.py/pianoid.py (CFL already merged to dev@ce2818b) flagged again
     for reconciliation — did NOT collide (different branch, file clean on my branch). NO CUDA build. -->
<!-- dev-5c3b locks RELEASED 2026-05-30T21:13Z at Step 10a Phase 1 commit. Held:
     PianoidCore/pianoid_middleware/backendServer.py + tests/unit/test_start_right_away_binary.py (new).
     start_right_away made BINARY 0/1 — deleted dead value-2 (deprecated inline, no caller) + value-3
     (no-op pass, byte-identical to else) dispatch branches in load_preset_route; kept the `==1` bg-thread
     branch byte-for-byte; non-1/0 = init only. Committed on PianoidCore feature/start-right-away-binary
     (b5815d6, +204/-12 incl. the 5-test unit suite). Docs (REST_API.md field → binary, TESTING.md test
     registration) + session log on root master. 5/5 new tests PASS + 17/17 sibling route regression PASS;
     no engine spin-up (heavy deps monkeypatched per the stall-avoidance constraint). NO CUDA build.
     NOT merged — branch awaits the user's test + approval. ★FLAGGED: dev-eac2's lock row (above) on
     backendServer.py/pianoid.py is STALE — its CFL work is already merged into dev@ce2818b (tree clean);
     orchestrator should reconcile dev-eac2's lock + WIP "HOLDING uncommitted" status. -->
<!-- dev-bbcb lock RELEASED 2026-05-31T09:42Z by dev-df69 consolidation (STALE — work merged to PianoidTunner dev).
     Held: ObjectInspector.jsx, NumInput/NumInput.js, PaneSettingsDialog.jsx, PresetPanel/PresetPanel.jsx,
     __tests__/PaneSettingsDialog.test.jsx, __tests__/ObjectInspector.test.jsx. Preset-load settings UI
     (integer NumInput + Save-Config-in-dialog). Committed c19bb1e on feature/preset-settings-ui, MERGED to
     PianoidTunner dev via b24dead (--no-ff) + pushed (origin/dev == b24dead). Tree clean. -->
<!-- dev-e9ed lock RELEASED 2026-05-31T09:42Z by dev-df69 consolidation (STALE — work merged to PianoidTunner dev).
     Held: ObjectInspector.jsx, __tests__/ObjectInspector.test.jsx. Virtual-keyboard settings refactor
     (selectors + integer fields, type-preserving Switch). Committed 89cf124 on feature/preset-settings-ui,
     MERGED to PianoidTunner dev via b24dead + pushed. Tree clean. -->

<!-- dev-177a lock RELEASED 2026-05-30T17:04:00Z at Step 10a Phase 1 commit. Held: PianoidTunner/src/PianoidTuner.js.
     Option A uneven-keyboard-timing fix — online "Play All" sweep now routes through the backend even-scheduler
     (ONE POST /play_keyboard {mode:"online"}) instead of a per-note setTimeout chain; visual-only setInterval drives
     the sweepingNote highlight; stopSweep halts the highlight (no backend mid-flight cancel — documented limitation);
     offline branch unchanged. Frontend-only, NO CUDA/backend. Committed on PianoidTunner feature/even-keyboard-sweep
     (27fcb56, +62/-23); docs (OVERVIEW Play All subsection + WIP deferred follow-up) + session log on root master
     (bd06676). Jest 66 suites / 745 tests PASS.
     MERGED + PUSHED 2026-05-30 by dev-e9ed (Phase 1 wrap-up of orphaned dev-177a): feature/even-keyboard-sweep
     merged to PianoidTunner dev `a593396` (--no-ff) and pushed (origin/dev 2d23254..a593396, clean fast-forward,
     verified by re-fetch ref-compare). Session log archived to logs/archive/dev-177a-2026-05-30-195124.md;
     WIP Active-Sessions row removed. -->

<!-- ===== Active/held lock rows from the release-2026-05-30 sync (PianoidInstall master) ===== -->
<!-- dev-7032 locks RELEASED 2026-05-30 at Step 10a Phase 2 wrap-up. Held (CFL ratio chart):
     PianoidCore pianoid_middleware/chartFunctions.py + chart_config.json + NEW
     tests/unit/test_cfl_ratio_chart.py + NEW docs/development/diagnostics/dev-7032-cfl-courant-varies.py.
     Per-pitch worst-string Courant number scatter across the keyboard with redline 1.0 + CFL_MARGIN
     reference via render_hints. Pure-Python (pianoid.param_manager._pitch_upload_amp, no GPU);
     cfl_stability.py NOT modified (only called). 13/13 unit + real-preset Courant-varies proof +
     registry E2E. ★LANDED VIA PULL MERGE (not via this agent's wrap-up): PianoidCore code committed
     a43f008 on feature/cfl-test-on-p1fix, merged to dev at ce2818b (Merge feature/cfl-test-on-p1fix
     into dev — co-merged with dev-eac2's CFL guard v2 a9d0aec); PianoidTunner render_hints
     thresholds-array commit 5e5d546 on feature/cfl-stability-chart, merged to dev at 9e7cb39 (Merge
     feature/cfl-stability-chart into dev). Both merges already on PianoidCore dev tip / PianoidTunner
     dev tip when this wrap-up ran — the user's upd-origin-9a1d pull (2026-05-30) had already brought
     them in. Step W2–W7 of the brief's plan corresponded to already-landed work; only the
     bookkeeping tail (locks/WIP/log) was executed in this session, recorded as
     PianoidInstall master commit (this commit). Live tested + approved by the user prior to
     wrap-up ("CFL chart already tested and approved, wrap up"). -->
<!-- dev-eac2 + dev-395e locks RELEASED 2026-05-30 at Step 10a Phase 2 wrap-up. Held (CFL guard v2,
     host-side, granular-only gate + CFL_MARGIN on the Courant number + flag-lifecycle fixes):
     PianoidCore pianoid_middleware/parameter_manager.py + pianoid.py + backendServer.py +
     cfl_stability.py (4 files; dev-eac2 explicitly took over dev-395e's lock per the dev-eac2
     log Step 0, so the 4 files = combined dev-eac2 + dev-395e scope on the same shared branch
     feature/cfl-test-on-p1fix). dev-395e's all-path gate (granular + 2 bulk sites) was
     SUPERSEDED by dev-eac2's directive-A REVERT (granular-only — bulk ungated per the user's
     "no gate on bulk update for now"); dev-eac2 then layered USER REVISION 2717 (CFL_MARGIN=0.99
     on the Courant number, granular-only) + USER REVISION 2720 (CFL_LIMIT restored 0.96→1.0 to
     fix the never-reset bug + _clear_cfl_redline added in switch_preset/load_preset for fresh
     preset = fresh stability state). cfl_stability.py exact math (max_amplification/is_stable_amp)
     UNCHANGED — only constants + acceptance threshold added. ★LANDED VIA PULL MERGE (not via this
     agent's wrap-up): PianoidCore code commit a9d0aec on feature/cfl-test-on-p1fix, merged to dev
     at ce2818b (Merge feature/cfl-test-on-p1fix into dev — co-merged with dev-7032's CFL ratio
     chart a43f008 + Belarus preset edits); PianoidTunner CFL redline warning chip commit 983f0c2
     on feature/lower-default-volume-100, merged to dev at 2d23254 (co-merged with the
     120→100 default volume change). Both merges already on PianoidCore dev tip / PianoidTunner
     dev tip when this wrap-up ran — the user's upd-origin-9a1d pull (2026-05-30) had already
     brought them in. Pure-Python verified pre-merge: dev-eac2-cfl-revert-verify.py 6/6,
     dev-eac2-cfl-margin-verify.py 6/6 (boundary EXACTLY at courant 0.99),
     dev-eac2-cfl-flag-lifecycle.py 5/5 (over-edge→set, safe→CLEARS),
     dev-eac2-cfl-preset-switch-reset.py 3/3 (library switch_preset clears stale flag); +
     test_cfl_amp.py 16/16 (exact math unchanged); dev-395e-cfl-allpath-gate.py 6/6 (pre-revert
     legacy). NO CUDA build (Python-middleware-only). Live tested + approved by the user prior
     to wrap-up. Step W2–W7 of the brief's plan corresponded to already-landed work; only the
     bookkeeping tail (locks/WIP/log) was executed in this session, recorded as PianoidInstall
     master commit (this commit). -->

<!-- dev-7032 lock RELEASED 2026-05-31T09:42Z by dev-df69 consolidation (STALE — work shipped in PianoidCore dev).
     Held: chartFunctions.py, chart_config.json, tests/unit/test_cfl_ratio_chart.py (new),
     docs/development/diagnostics/dev-7032-cfl-courant-varies.py (new). Per-pitch CFL ratio (Courant) chart.
     feature/cfl-test-on-p1fix (tip 94c7901) is an ANCESTOR of dev → dev has cfl_ratio (chart_config.json) +
     cfl_ratio_function (chartFunctions.py) + test_cfl_ratio_chart.py; diagnostic tracked on master. Tree clean.
     The earlier "HELD UNCOMMITTED" note predated the feature/cfl-test-on-p1fix → dev merge (ce2818b). -->
<!-- dev-eac2 lock RELEASED 2026-05-31T09:42Z by dev-df69 consolidation (STALE — work shipped in PianoidCore dev;
     orchestrator-directed). Held: parameter_manager.py, pianoid.py, backendServer.py, cfl_stability.py.
     CFL guard v2 (granular-only gate + CFL_MARGIN=0.99 on Courant [REV 2717] + flag-reset/CFL_LIMIT=1.0 [REV 2720]).
     feature/cfl-test-on-p1fix (tip 94c7901) is an ANCESTOR of dev → dev cfl_stability.py has CFL_MARGIN +
     is_stable_with_margin (13 refs) + CFL_LIMIT=1.0; pianoid.py + backendServer.py have _clear_cfl_redline.
     Tree clean (all 4 files committed-clean on dev). -->

<!-- dev-427c locks RELEASED 2026-05-29 by the sync wrap-up (completing dev-427c's halted Step 10).
     Held: PianoidCore Pianoid.cuh, Pianoid_synthesis.cu, Pianoid_presets.cu, UnifiedGpuMemoryManager.cu,
     UnifiedGpuMemoryManager.h. P1-1 GPU-pointer authority-race fix (engine sole-writer of the swappable
     TUNABLE sub-pointers via release/acquire publish/consume). USER-VERIFIED live (55/56/57 trichotomy
     GONE, no recurrence); race measured 1842→0 mid-cycle mutations; 5/5 perf + 11/11 functional.
     COMMITTED PianoidCore feature/p1-authority-fix `80fc9ed` (+90/-20) and MERGED to dev `a352b2f`
     (--no-ff). Docs (SYSTEM_OVERVIEW/MEMORY_MANAGEMENT/PARAMETER_SYSTEM/DATA_FLOWS/CODE_QUALITY +
     bug-55-56-57 §7b) + diagnostic dev-427c-p1-authority-race-stress.py + session log committed on root
     master by the same sync. stash@{0}=26799bf (dev-soundint-live) NOT popped/touched. Other feature
     branches untouched. NOT pushed yet (awaiting user push-confirm). -->
<!-- (dev-8085's 2 stale active rows removed 2026-06-03 — see the "dev-8085 locks RECONCILED 2026-06-03 by dev-blur" comment near the top active-rows region.) -->
<!-- dev-8085 ACTIVE rows REMOVED 2026-06-04 (Phase 2 wrap, stale-row reconcile). These two rows were
     leftover ACTIVE entries for the 120→100 default-volume work; that work has long been an ancestor of
     PianoidTunner dev — already documented RELEASED 2026-05-31 by the dev-df69 consolidation (see the
     "dev-8085 locks RELEASED 2026-05-31T09:42Z by dev-df69 consolidation" comment further below). The
     rows simply weren't deleted at that time. No active lock; nothing held. -->
<!-- dev-stest-4a7c locks RELEASED 2026-05-31 at Step 10a Phase 1 (Sound Test diagnostic chart).
     Sound Test diagnostic chart — Phase B + M9 + M12 + M14 (audio attach for chart-native playback).
     M12: bool URL-string coercion fix in ChartRegistry.extract_arguments — bug where
     `bool("false")==True` made boolean params always-true for URL-routed requests.
     Unified PianoidResult architecture per user A3 directive: new fields `post_fir_sound` +
     `sint_sound` + loaders; engine-side new rings (Sint + FIR) + multi-channel offline writer
     fix; chart-fn reads ONLY via `PianoidResult.get_*_audio()` accessors (architectural assertion
     in unit test that raw C++ getters are never called by chart fn).
     Engine + middleware + tests committed locally on PianoidCore `feature/sound-test-chart`
     branched off dev `37f664a` (SHA reported in dev-m17-454a session log). Doc-gap closures
     (`docs/modules/pianoid-cuda/SYNTHESIS_ENGINE.md`, `docs/modules/pianoid-cuda/DEBUG_DATA.md`)
     + proposals (`docs/proposals/sound-test-chart-2026-05-30.md` + `chart-native-playback-2026-05-31.md`)
     committed on PianoidInstall master. Pre-edit regression baseline captured:
     sha256 e5654ec6...4e for BaselinePreset1 pitch 60 vel 100 (preserved in
     /tmp/dev-stest-4a7c-baseline.{npy,json}). dev-soundint-live PAUSED lock released this round
     (stash+branch confirmed gone). NOT merged to dev yet — Phase 2 awaits user re-confirmation. -->
<!-- dev-m17-454a locks RELEASED 2026-05-31 at Step 10a Phase 1 (M17 follow-up + M18/M18b/M18c).
     M17 follow-up: appended `TestRenderLayerCombinations` class (+18 parametrised tests + 2 symptom
     regression pins) to `PianoidCore/tests/unit/test_sound_test_chart.py` (620→861 LOC). Locks the
     parent's M17 architectural invariants — synthesis-always-runs; per-boolean rendering — by
     enumerating all 16 (kernel,fir,sint,mic) boolean combinations + Symptom A/B spot-checks.
     M18/M18b/M18c: NewWindowChart React.StrictMode-safe fetch in
     `PianoidTunner/src/components/newWindowChart.jsx` (540→~590 LOC) — `fetchedRef` one-shot
     fence prevents the dev double-invoke duplicate POST that the user heard as "note plays twice
     BEFORE the chart renders"; `isMountedRef` guards late setState onto an unmounted root; M18c
     swaps `useApi` → direct `axios.post(...)` to side-step `useApi.js:28`'s own
     auto-abort-on-unmount cleanup which was cancelling the only POST under StrictMode
     (`net::ERR_ABORTED` → Loading-hang). 4 strictMode regression tests committed in
     `PianoidTunner/src/components/__tests__/newWindowChart.strictMode.test.jsx`. Live-verified
     via chrome-devtools both OFFLINE + ONLINE modes — 1 POST → HTTP 200 → chart renders with
     Kernel/Sint per-source Play buttons. NO CUDA rebuild. NO backend edits. Frontend HMR
     pickup. Committed locally on PianoidTunner `feature/sound-test-chart` (NEW branch off dev
     `71bc77f`; SHA reported in session log). NOT merged to dev — Phase 2 awaits user
     re-confirmation. No collision with dev-snmtxleak-7e3d (their files MeasuredMatrix.jsx /
     SoundChannelsPane.jsx / useSoundChannels.js / useHotkeys.js — disjoint). -->
<!-- dev-stest-4a7c row removed 2026-06-10 (cleanup-bkkp) — was a stale placeholder; release documented in the comment block above. -->
<!-- dev-snmtxleak-7e3d locks RELEASED 2026-05-31 at Step 10a Phase 1. Held (architectural SC
     strings-axis decouple + useHotkeys falsy-zero guard hardening):
     PianoidTunner/src/components/SoundChannelsPane.jsx (~+24/-2 LOC: local `selectedChannel`
     useState, `onPitchSelect` gated by `listenToModes`, pitchInView axis-aware), useHotkeys.js
     (2 LOC: `!pitch` → `pitch == null` on lines 58 `play` + 65 `stopNote`), 2 NEW Jest test
     files (SoundChannelsPane.localChannel.test.jsx + useHotkeys.zeroPitch.test.jsx — 10 new
     tests, 5/5 existing useHotkeys.cyclePreset still PASS, sweep 15/15 PASS). Committed on
     PianoidTunner `feature/sc-decouple-spacebar-fix` (off dev tip 71bc77f), commit `4b0ce71`
     (+347/-5 across 4 files). NOT merged to dev. NOT pushed. Awaits user live re-test of
     both bugs: (1) spacebar after SC strings-axis matrix click → should fire WS `play` frame
     with the previous selectedPitch (not silent), (2) modes-axis behaviour unchanged
     (cross-pane sync to global setSelectedPitch preserved). Frontend-only, HMR pickup, no
     CUDA rebuild. No file collision with dev-m17-454a (newWindowChart.jsx), dev-stest-4a7c
     (PianoidCore backend), or dev-8085 (ToolBar.jsx + usePreset.js — different files). Live
     UI verified via chrome-devtools post-commit: fiber-prop onPitchSelect(2) on strings axis
     sets local selectedChannel=2 ONLY; global selectedPitch stays at 60; spacebar fires
     `play({pitch: 60})` post-click (pre-fix the same gesture fired `play({pitch: 2})`).
     [LOCK RELEASED] 2026-05-31T18:25:00Z. -->

<!-- dev-m17-454a row removed 2026-06-10 (cleanup-bkkp) — was a stale placeholder; release documented in the comment block above. -->
<!-- dev-pyspawn-8b3a lock RELEASED 2026-05-31 at Step 10a Phase 1. Held:
     docs/guides/STARTUP_TROUBLESHOOTING.md (re-scoped from code to docs).
     Original brief targeted backendServer.py + launcher.js for an alleged
     "venv→system Python child spawn" bug. Phase A measurement-based diagnosis
     against the live engine (3 diagnostic probes preserved in
     docs/development/diagnostics/dev-pyspawn-8b3a-*.py) REFUTED all 4 brief
     hypotheses (Werkzeug reloader / Flask-SocketIO async_mode / sys._base_executable
     / corrupted venv shim). The two-PID structure under the launcher is normal
     Python 3.12 venv launcher-shim architecture: .venv/Scripts/python.exe is a
     274 KB launcher stub that spawns C:\Python312\python.exe as the actual
     interpreter via CreateProcess; the child's sys.prefix correctly resolves to
     the venv via pyvenv.cfg discovery and imports the FRESH venv pyd (with
     getRawSoundRecordInt + getRawFilteredFloatRecord bound, verified by direct
     probe with launcher-exact env). User re-tested chart against running PID 73984
     — no AttributeError; cause was hypothesis D (running backend predated dev-stest-4a7c's
     working-tree edits to PanoidResult.py + chartFunctions.py; clean backend restart
     picks up the new module). Same misdiagnosis previously seen in dev-stest-4a7c
     log line 406 + the brief itself — STARTUP_TROUBLESHOOTING.md entry documents
     the pattern + decisive sys.prefix/pianoidCuda.__file__ probes so it doesn't
     recur. COMMITTED PianoidInstall master c21fadb (7 files +345/-1: STARTUP doc
     entry + 3 diagnostic .py probes + session log + WIP transition + this lock
     release). NO source code modified. Independent of dev-stest-4a7c's ongoing
     Phase B work (different files, different concerns). Live stack PRESERVED
     (PID 86072/58276/73984) per orchestrator direction — dev-stest-4a7c's
     continuing work needs it. -->

<!-- dev-8085 locks RELEASED 2026-05-31T09:42Z by dev-df69 consolidation (STALE — work shipped in PianoidTunner dev;
     2 duplicate rows collapsed). Held: ToolBar.jsx, usePreset.js. Lower default preset-load volume 120→100.
     feature/lower-default-volume-100 is an ANCESTOR of dev (dev usePreset.js:152 default volume = 100, merged
     at 2d23254). Tree clean. (Diagnostic rig .py are committed-free under docs/; instrumentation already reverted.) -->

<!-- dev-ratiochart locks RELEASED 2026-05-24 at Step 10a Phase 1 commit. Held (CFL chart Part 1, frontend):
     newWindowChart.jsx, NEW src/utils/chartOption.js, NEW src/utils/__tests__/chartOption.test.js.
     Committed on PianoidTunner feature/cfl-stability-chart (0a3973f). Full Jest 62/693 PASS, 0 regressions.
     NOT merged — branch awaits user test + approval. Part 2 (PianoidCore chartFunctions.py +
     chart_config.json) PENDING, blocked on the CFL guard merge to PianoidCore dev (needs dev-cfl getters;
     avoids working-tree collision). See WORK_IN_PROGRESS.md deferred follow-up #1. -->
<!-- dev-cfl-3 (v1) locks RELEASED 2026-05-26: v1 impl committed to feature/cfl-stability-guard (13b68dd); superseded by v2. -->
<!-- dev-cfl-v2 locks RELEASED 2026-05-26 at Step 10a Phase 1 commit. Held (CFL stability guard v2, host-side):
     PianoidCore pianoid_middleware/parameter_manager.py, pianoid.py, backendServer.py, NEW cfl_stability.py,
     NEW tests/system/test_cfl_stability_guard.py, NEW tests/unit/test_cfl_amp.py. Committed on
     feature/cfl-stability-guard-v2 (off dev); docs (SYNTHESIS_ENGINE, REST_API, TESTING, proposal archive-move),
     session log, and dev-cfl-* diagnostics on root master. Fresh --heavy build verified (dead v1 getters gone);
     27/27 tests green (16 unit + 11 system incl. 2 route-level regressions); live note_playback pitch-57 = SUSTAIN
     (click gone). Two route-level bugs found+fixed during live verify (stability_ratio jsonify-sort 500 → str keys;
     CflRejected → 400+cfl_redline handler, was a 416). NOT merged — branch awaits the user's final live re-test + approval. -->
<!-- dev-ratiochart's PianoidTunner-only locks (above) do not collide with these PianoidCore files. -->
<!-- dev-cfl locks RELEASED 2026-05-24 at Step 10a Phase 1 commit. Held (CFL stability guard):
     Kernels.cu, Kernels.cuh, constants.h, Pianoid.cu, Pianoid.cuh, Pianoid_synthesis.cu,
     Pianoid_parameters.cu, Pianoid_debug.cu, AddArraysWithCUDA.cpp, Pianoid_internal.cuh (locked
     precautionarily, not edited), pianoid.py, parameter_manager.py, backendServer.py,
     tests/system/test_cfl_stability_guard.py. Committed on feature/cfl-stability-guard (PianoidCore
     2a37faa); docs/diagnostics/log on root master. NOT merged — branch awaits the user's test + approval. -->
<!-- dev-vpnoteoff lock RELEASED 2026-05-27 at Step 10a Phase 1 commit. Held: PianoidTunner/src/components/VirtualPiano.js. Committed on feature/vp-noteoff-fix (f3ce378); 62/693 Jest PASS. NOT merged — awaits user test + approval. -->
<!-- dev-3580 active row REMOVED 2026-06-03 by dev-asioload (reconciled to RELEASED — see the
     "dev-3580 lock RECONCILED 2026-06-03 by dev-asioload" comment in the active-rows region near the top).
     Was: `PianoidCore/pianoid_cuda/Pianoid_excitation.cu` — diagnostic NOTE_OFF_PROBE preserved only in the
     now-lost stash@{0}=26799bf; guards nothing (stash GONE, trichotomy resolved by dev-427c). Tree clean. -->
<!-- dev-soundint-live PAUSED-lock RELEASED 2026-05-31 (orchestrator + user-approved cleanup;
     Telegram msg 3059 "Go as recommended" = α = release the PAUSED lock now over β = let
     dev-stest-4a7c override it). HONEST-RECORD CLEANUP — UNLIKE dev-eac2/dev-7032 (whose code
     reached dev via the morning's pull merge), dev-soundint-live's preserved work is VERIFIABLY
     GONE. Held 8 files: 6 PianoidCore C++ (Pianoid.cuh, Pianoid.cu, Pianoid_debug.cu,
     AddArraysWithCUDA.cpp, Pianoid_synthesis.cu, MainKernel.cu) + 2 PianoidCore Python
     (pianoid_middleware/chartFunctions.py, pianoid_middleware/chart_config.json). The protected
     work container `stash@{0}` = `26799bf` (stashed by dev-35a3 2026-05-29 for a clean bisect
     tree), branch `feature/soundint-readback`, and commit `26799bf` were ALL verified GONE on
     2026-05-30/2026-05-31 (verified independently by dev-stest-4a7c and again by this cleanup):
     `git stash list` carries no soundint entry, `git branch -a | grep -i soundint` empty,
     `git reflog | grep -i soundint` empty, `git cat-file -t 26799bf` → "Not a valid object name".
     No recovery is possible — the PAUSED lock has been protecting nothing for an unknown period.
     Cleanup driven by Phase A3 collision detection during dev-stest-4a7c design review (the new
     Sound Test feature needs the same `dev_soundInt` readback surface this lock guarded).
     Superseded by `dev-stest-4a7c` which is RE-DERIVING the Sint-readback hook from the archived
     dev-soundint-live session log (not from the lost stash) — the actual hook code will be NEW
     code, not the preserved stash. ★KEY RESULT that survives in the archived log for
     dev-stest-4a7c's reference: post-volume OVERFLOW REFUTED via direct kernel probe (mvc=7.999e8
     exact; soundInt ±6e6 ≈ 340× UNDER INT32 rail; engine CLEAN at vol=100; the railed M1/M2
     readings were a READBACK BUG — layout mismatch: kernel writes dev_soundInt at stride
     samplesInCycle, hook reshape used mode_iteration). Original task was POST-volume dev_soundInt
     readback hook (soundInt ring + getRawSoundRecordInt() + pybind + sound_int chart +
     getMainVolumeCoefficient() getter + TEMP kernel probe at MainKernel.cu:492) for the H1/H2
     trichotomy discriminators; trichotomy itself was independently resolved by dev-427c
     (P1-1 GPU-pointer authority race fix, merged to PianoidCore dev `a352b2f`). -->
<!-- damper-probe-ea77 lock RELEASED 2026-05-29 at Step 10a Phase 1 (lightweight).
     Held: PianoidCore/pianoid_cuda/Pianoid_synthesis.cu — DAMPER_PROBE inserted (+7 lines)
     at the existing UPLOAD_PROBE site (around line 204-210). Probe LEFT IN SOURCE for ongoing
     investigation (not reverted, not committed). Backend kept alive (orchestrator drove the
     reproduction directly; PID 80416 on port 5000 SDL3).
     Result: damper_string[201..203] = 3.6e-05 (matches preset, NOT zero) → H_A (damper-wipe) refuted.
     H_B (mode ringout) is the leading follow-up hypothesis.
     Log: docs/development/logs/damper-probe-ea77-2026-05-29-210147.md (kept open in logs/, not archived). -->
<!-- ===== Released-lock entries from origin/master (other-machine sessions, unioned in) ===== -->
<!-- dev-asiocrash-b20f locks RELEASED 2026-05-27 at Step 10a Phase 1.
     CoInitializeEx(COINIT_APARTMENTTHREADED) in PianoidUnifiedPlaybackThread
     fixes 2nd-/load_preset ASIO crash. ASIO printf -> PLOG hygiene.
     Launcher captures backend stdout to PianoidCore/logs/backend_stdout.log.
     Live-verified: 3 x /load_preset adt=4 healthy + mic FFT SNR 24.0x/7.3x/10.4x
     for pitches 60/67/72 vel=100. PianoidCore commit 5d297a6,
     PianoidTunner commit 735d523. PianoidInstall docs + log on master. -->
<!-- dev-mstat-30b6 locks RELEASED 2026-05-26 at Step 10a Phase 1.
     Per-chain mass_inversion_status field on modal mass (enum:
     valid / insufficient_band_width / no_full_row / only_unmapped_full_row).
     Committed on feature/dev-mstat-30b6 (PianoidCore 39798bc + PianoidTunner
     7dc9763). PianoidInstall master commit pending — docs + session log +
     verify script. NOT merged yet — orchestrator merge sweep will handle.
     +17 backend tests (181/181 PASS in modal_adapter + external_export
     sweep), +9 frontend tests (37/37 PASS on touched suites). Live verified
     on LG_p3 via docs/development/diagnostics/dev-mstat-30b6-verify.py:
     classifier output matches the audit exactly — 386 valid / 242
     insufficient / 126 no_full_row / 3 only_unmapped out of 757 chains. -->
<!-- dev-collreorg-7a3f locks RELEASED 2026-05-26 at Step 10a Phase 1.
     Collection subpanel reorganization per proposal
     docs/proposals/collection-subpanel-reorg-2026-05-26.md — 6 commits on
     feature/dev-collreorg-7a3f (PianoidTunner): 54ccc25 Step 1
     SECTIONS_WITH_SETTINGS gate, 4c52d5b Step 2 CollectionSettingsPanel
     extraction, 6ad08f9 Step 3 useCollectionStatus hook + toolbar
     Start/Cancel, 80745df Step 4 default-true localStorage showSettings,
     287fdfb Step 5 Save All + gear Badge counter, 44a1617 Step 6 new
     tests + ModalAdapter architecture guards. Jest baseline 64 suites/739
     tests -> 66 suites/765 tests = +2 suites + +26 tests (11
     useCollectionStatus + 3 CollectionSettingsPanel + 12 architecture
     guards in lockSettings.test.jsx). Files: ModalAdapter.jsx (+177 net),
     CollectionSubpanel.jsx (+68 net), CollectionSettingsPanel.jsx NEW
     (+134), useCollectionStatus.js NEW (+162), 5 sub-section files +2
     each (additive onDirtyChange prop), 2 new test files, lockSettings
     test extended. CollectionToolbarActions.jsx + CollectionLog.jsx +
     CollectionSubpanel.test.jsx + CollectionLog.test.jsx locked-but-never-edited
     (CollectionToolbarActions inlined into ModalAdapter per Compute-Modal-Mass
     precedent; CollectionLog poll de-dup deferred to follow-up). PianoidCore +
     PianoidBasic untouched. Live verification deferred — test-ui blocked by
     PowerShell permission denial; full Jest suite + 12 architecture-guard
     source-text assertions cover the regression surface. NOT merged to dev
     yet — orchestrator handles the merge sweep per dispatch. Worked in
     dedicated worktree D:\repos\PianoidInstall\PianoidTunner-collreorg-wt
     to avoid shared-main-worktree collisions with dev-mstat-30b6 +
     dev-dlgrm-4b1a (Step 1 + Step 2 commits had to be cherry-picked /
     reconstructed once after another agent's git operations clobbered
     my HEAD — see session log "Worktree-sharing incident" section). -->


<!-- dev-dlgrm-4b1a locks RELEASED 2026-05-26 at Step 10a Phase 1.
     Delete dead dialogs + Copy-mode branch per proposal
     modal-adapter-dialog-review-2026-05-26.md §6.1 #7 + §6.4 #1, #2, #4.
     Committed on feature/dev-dlgrm-4b1a (PianoidTunner): 3 commits totalling
     -1880 LOC (CreateProjectDialog.jsx + test 937; EffectiveSignalLengthRerunDialog
     .jsx + test 825; ProjectBrowserDialog Copy-mode branch 118 net).
     Files: CreateProjectDialog.jsx + test (DELETED in 9391fb7),
     EffectiveSignalLengthRerunDialog.jsx + test (DELETED in dd5c8cf),
     ProjectBrowserDialog.jsx + test (edited in 4154b6c), ProjectSubpanel.jsx
     (1-line `mode="open"` removal in 4154b6c). Jest baseline 64 suites/739
     tests -> 62 suites/694 tests; -2 suites + -45 tests = exactly the deleted
     test count (-25 CreateProjectDialog + -16 ESL + -4 Copy-mode); no
     regression in surviving tests. NOT merged to dev yet — orchestrator
     handles the merge sweep per dispatch. PianoidCore + PianoidBasic
     untouched. Heads-up: orphaned hook methods (importProject, copyProject,
     reaverageProject, fetchEffectiveSignalLength in useProjectCRUD.js +
     useModalAdapter.js facade) confirmed orphaned at production-caller
     level — deletion deferred to a separate /dev session per proposal §8 #2. -->

<!-- dev-mmexp2-f492 locks RELEASED 2026-05-26 at Step 10a Phase 1.
     Filter relative_modal_mass.txt to export set (matches omega_coef.txt
     selected_chains filter from build_export_payload) + drop NaN
     m_relative rows defensively. PianoidCore feature/dev-mmexp2-f492
     commit f6464cc. PianoidInstall master commit 3c5e919 (docs + log).
     NOT merged to dev yet — orchestrator merge-sweep will handle.
     +8 net new tests (71 -> 78 PASS in test_external_export.py;
     1 renamed). Live verified on D:/modal_projects/LG_p3: 386 data
     rows (was 757) with selected_chains=None, 6 data rows with an
     explicit 10-chain selection (4 of the 10 dropped by NaN drop —
     chain 5 was in the export set but had NaN m_relative). 0 NaN
     rows in any output. external_export.py crossed C4 RED at 1033
     LOC (was 993; +40); CODE_QUALITY.md updated. -->


<!-- dev-mmexp-5561 locks RELEASED 2026-05-26 at Step 10a Phase 1.
     Add relative_modal_mass.txt to Apply text export bundle.
     PianoidCore feature/dev-mmexp-5561 commit 9ad8ae1. PianoidInstall
     master commit 1c14dcd (docs + log). NOT merged to dev yet — awaits
     user verification / orchestrator merge sweep. 15 new tests
     (test_external_export.py 56 -> 71 PASS). Live verified on
     D:/modal_projects/LG_p3 — bundle now ships 8 files including
     relative_modal_mass.txt (757 rows, 386 finite m_relative + 371
     NaN; reference chain 312 @ 867.52 Hz m_relative=1.000000). -->


<!-- ana-madlg-7c2e lock RELEASED 2026-05-26 at Step 10a Phase 1.
     Proposal at docs/proposals/modal-adapter-dialog-review-2026-05-26.md
     (1071 LOC) committed on PianoidInstall master. Read-only /analyse; no
     code touched. Inventoried 20 dialogs (17 live + 2 dead + 1 shared
     reference) reachable from the Modal Adapter pane; cross-cutting
     analysis across 5 progress-UI patterns, 16 timeout sites, 2
     near-duplicate dialog pairs; consolidation roadmap with 8 quick
     wins / 8 medium refactors / 3 architectural changes / 6 code-quality
     reductions (~2000 LOC dead code identified for deletion). -->

<!-- ana-csub-4f12 lock RELEASED 2026-05-26 at Step 10a Phase 1.
     Proposal at docs/proposals/collection-subpanel-reorg-2026-05-26.md
     committed on master. Read-only /analyse; no code touched. -->


<!-- dev-cptmto-9d7e locks RELEASED 2026-05-25 at Step 10a Phase 1.
     Fix for 5-min hardcoded polling timeout in
     CreateProjectFromMeasurementDialog round-30 async path.
     Committed on feature/dev-cptmto-9d7e (PianoidTunner ee54470):
     POLL_MAX_MS bump 5min->60min + live mm:ss elapsed-chip + 10-min
     "still running" banner + improved timeout error message + 8 new
     Jest tests. Docs commit on PianoidInstall master pending:
     MODAL_COLLECTION.md async-path note, CODE_QUALITY.md God Objects
     update (file crossed 1000 LOC RED), WIP doc-gap entry for
     REST_API.md async surface. 37/37 dialog tests PASS; 64/64
     broader related Jest sweep PASS. PianoidCore untouched. NOT
     merged to dev yet — awaits user verification (live retry on the
     large measurement that triggered the original bug). -->

<!-- dev-msdel-3b1a locks RELEASED 2026-05-25 at Step 10a Phase 1.
     Fix for 5000 ms axios timeout on measurement-set deletion.
     Committed on feature/dev-msdel-3b1a (PianoidTunner 1a6a3de):
     useMeasurementCatalog.js timeout bump 5000->60000 + new Jest
     regression test. Docs commit on PianoidInstall master:
     MODAL_COLLECTION.md callout for the new timeout + the threaded=
     False / rmtree-cost rationale. PianoidCore untouched (backend
     handler was correct). 18/18 useMeasurementCatalog tests PASS;
     78/78 broader measurement-related Jest sweep PASS. Held files
     were the 4 candidates investigated; only 2 (useMeasurementCatalog
     .js + its Jest test) ended up edited. NOT merged to dev yet -
     awaits user verification (live browser test of delete from
     Measurements Management dialog). -->

<!-- dev-mmui-6e97 round 3 locks RELEASED 2026-05-25 at Step 10a Phase 1.
     Backend fix (get_project_state() data_status pass-through) +
     latent Rules-of-Hooks fix in ModalMassFreqChart.jsx + 4 backend
     integration tests + 3 frontend reactivity tests. Committed on
     feature/dev-mmui-6e97-r3 (PianoidCore) + feature/dev-mmui-6e97
     (PianoidTunner) + docs commit on PianoidInstall master. NOT
     merged to dev yet. Backend tests 4/4 PASS + related modal_adapter
     sweep 142/142 PASS. Frontend 64 suites / 730 tests PASS. -->


<!-- dev-frfres-9c41 locks RELEASED 2026-05-25 at Step 10a Phase 1.
     Fix for v2 open_project not setting ctx.source_folder (caused FRF
     resolver to return None → "No usable measurement source folder
     for FRF" on every measurement-backed v2 project). Committed on
     feature/dev-frfres-9c41 (PianoidCore) + docs commit on
     PianoidInstall master. NOT merged to dev yet — awaits user
     verification (live browser test of Compute Modal Mass toolbar
     button on PlyWoodLGtemp1_p4). New regression test
     test_v2_open_project_source_folder.py PASS (2/2); related v2 +
     FRF suites untouched (41/41 PASS). Live repro on real _p4 data
     confirmed pre-fix=None, post-fix=D:\modal_measurements\PlyWoodLGtemp1.
     Files: scenario_loader.py (24-line addition), new regression
     test, MODAL_COLLECTION.md doc edit, diagnostic script. -->


<!-- dev-mmui-6e97 round 2 locks RELEASED 2026-05-25 at Step 10a Phase 1.
     Modal Mass UI round 2 fixes committed on the existing
     feature/dev-mmui-6e97 (PianoidTunner: round-2 commit TBD on top of
     round-1 d616fb7). PianoidInstall docs commit on master. NOT merged
     to dev yet — awaits user verification (live browser test of moved
     checkbox + new toolbar button + progress banner). 18 new Jest
     tests (15 useModalMassRun + 3 chart in-progress); full 727-test
     suite green (64 suites). Backend untouched. -->


<!-- dev-mmui-6e97 round 1 locks RELEASED 2026-05-25 at Step 10a Phase 1.
     Modal Mass UI refactor committed on feature/dev-mmui-6e97 (PianoidTunner d616fb7).
     PianoidInstall docs commit on master. NOT merged to dev yet — awaits user
     verification (live testing on PlyWoodLGtemp1 dataset). 22 new Jest tests
     pass; full 709-test suite green. Backend untouched (PianoidCore unchanged). -->

<!-- dev-frf-q-phase01 locks RELEASED 2026-05-24 at Step 10a Phase 1.
     Phase 0 + Phase 1 of Modal Mass + Q-factor improvement plan
     committed on feature/dev-frf-q-phase01 + merged to dev on both
     repos. PianoidCore: 9c35c4f → ddbf997 (merge). PianoidTunner:
     3f41819 → c472997 (merge). PianoidInstall docs: 07508e4. NOT
     pushed (awaits user verification). -->

<!-- dev-preset-bugs locks RELEASED 2026-05-23 at Step 10e wrap-up. Held: usePreset.js,
     useSoundChannels.js, PianoidTuner.js, useBackendProcess.js on feature/preset-1-leak-trace.
     Finding A (mount-race) committed 06cf96b + 0d31856. #1 string-param working-copy leak FIXED +
     live-verified (strings back-sync dep-array: drop parametersOfStrings + changeParametersOfStrings)
     committed 908a6c5; docs/log/screenshot on root master e3d2677. [#1-trace] stripped (0 markers).
     Full Jest 61/681 PASS. Stack DOWN (3000/3001/5000/5001 clear). NOT merged — branch awaits the
     user's test + approval. -->
<!-- dev-d52b locks RELEASED 2026-06-04 (Phase 2 wrap, user-approved). Held:
     PianoidBasic/Pianoid/StringMap.py + 8 PianoidCore CUDA files (Pianoid.cu/.cuh, MainKernel.cu/.cuh,
     constants.h, Pianoid_parameters.cu, Pianoid_debug.cu, AddArraysWithCUDA.cpp) +
     pianoid.py / pianoid_cuda_placeholder.py / backendServer.py. PROPORTIONAL piano-only feedback coeff
     (slider × feedin; output/sound 128+ excluded via per-string dev_feedback_output_mask) + int-domain
     tanh output soft-limiter (LIMITER_CEILING 1.2) + non-silent limiting signal (dev_limiter_peak buffer,
     getLimiterPeaks/resetLimiterPeaks pybind, /health get_limiter_status). KERNEL CHANGE (--heavy --both).
     PianoidCore feature/dev-d52b-feedback-coeff 24d5251 MERGED to dev at f332838 (--no-ff);
     PianoidBasic feature/dev-d52b-feedback-coeff 5758dae MERGED to dev at 206ea96 (--no-ff). Pushed to origin. -->
<!-- dev-uimtx locks RELEASED 2026-06-04 (Phase 2 wrap, user-approved). Held: ~23 PianoidTunner frontend
     files (MeasuredMatrix.jsx, PitchesModesMatrixCanvas.jsx, MatrixTools.jsx/.css, SoundChannelsPane.jsx,
     FlatBarAxis.jsx new, PianoidTuner.js, matrixEmit.js new, RowEditor.js, DrawableChart.jsx,
     useBackendHealth.js, BackendStatusIndicator.jsx, ToolBar.jsx + 8 new test files). Matrices-UI review
     fixes C1/H1/H3/M1/M3 + clip/limit indicator (binds dev-d52b's /health limiting contract read-only) +
     React-warning fixes + #208 bar-chart fixes. Frontend-only, HMR, NO CUDA build.
     PianoidTunner feature/matrices-ui-fixes 1132b4a MERGED to dev at 2488168 (--no-ff). Pushed to origin. -->
<!-- dev-lmode locks RELEASED 2026-06-05 at Step 10a (user-approved commit + push). Held:
     PianoidCore/pianoid_middleware/backendServer.py + tests/unit/test_health_listen_mode_regression.py (new).
     Fix: GET /health `listen_mode` now reads pianoid.mp.listen_to_modes (engine listen-to-modes truth, set
     from /load_preset) instead of pianoid.listen (the MIDI-listener loop flag) — pre-fix /health always
     reported listen_mode=false under the listen_to_midi=0 default regardless of the modes setting. Diagnosis
     (B) REPORTING GAP, measurement-confirmed (in-process probe: mp.listen_to_modes tracks request True/False,
     pianoid.listen independent). Feature was applied engine-side all along (StringMap.py:444 gates the
     sound-channel feedin cell); only the report was wrong. +3 unit tests (8/8 PASS incl. 5 sibling
     play/listen-gate). Python-middleware-only, NO CUDA build. PianoidCore feature/dev-lmode-health-listen-mode
     6125b69 MERGED to dev at a139971 (--no-ff). Docs (REST_API.md GET /health field semantics + TESTING.md
     test registration) + diagnostic probe + session log on PianoidInstall master. Pushed to origin. -->
<!-- (none active) -->
<!-- dev-preset-bugs locks RELEASED 2026-05-23 at Step 10a wrap-up (user-approved merge). Held:
     ToolBar.jsx, useHotkeys.js, PianoidTuner.js, usePreset.js — all committed on
     feature/preset-library-bugs (99bed57, b7af146, bbe8638) and MERGED to PianoidTunner `dev` via
     984434a (--no-ff, local, NOT pushed; feature branch kept). useSoundChannels.js had only TEMP
     trace (stripped, never committed). #2/#3/#4 user-verified; #1 fix merged, live re-verify still
     pending the user's fresh post-restart test. Session log archived to logs/archive/. -->
<!-- dev-voice-docs lock RELEASED 2026-05-22 at Step 10a Phase 1 commit (voice-I/O durability + setup docs). Held: tools/tts_voice.py, tools/apply_telegram_voice_patch.py, tools/server.ts.voicepatch.diff (all new), docs/guides/TELEGRAM_CHANNEL_SETUP.md, mkdocs.yml. -->
<!-- dev-maimport round 30 lock RELEASED on 2026-05-22 after commits
     PianoidCore f1b5197 + PianoidTunner 9778416 landed on
     feature/dev-maimport-import. Held files: measurement_import.py,
     measurement_routes.py, modal_adapter.py, scenario_averager.py,
     routes/project_routes.py, NEW import_session.py, NEW
     test_round30_import_session.py (PianoidCore); NEW
     ImportScenariosDialog.jsx, NEW useImportSession.js, NEW
     ImportScenariosDialog.test.jsx, DELETED
     MeasurementImportDialog.jsx + tests, DELETED
     AddScenariosToMeasurementDialog.jsx + tests, MeasurementSelector.jsx
     (comment-only), MeasurementsManagementDialog.jsx,
     CollectionSubpanel.jsx, useProjectCRUD.js,
     CreateProjectFromMeasurementDialog.jsx (PianoidTunner). -->

