# M12 Phase 3a — Fully-Functional-Orchestrator Wiring DESIGN

**Agent:** dev-m12p3a · **Date:** 2026-06-15 · **Status:** DESIGN — awaiting team-lead OK before deep wiring.
**Scope:** make the supervisor host a REAL orchestrator session (not the demo persona), reachable on the DEDICATED TEST BOT. ADDITIVE; NO production cut-over (3b). Branch `feature/m12-supervisor-phase3a`.

> Grounding: SDK facts from claude-code-guide (doc-cited, below) + the current `sdk-session-driver.ts` option surface + `.claude/commands/orchestrator.md` (the skill we must host). Three items are **FLAGGED** — they need a tiny live probe on the test bot before the deep build; the design notes exactly which.

---

## 0. The shape (what changes)

Today (Phase 2) the hosted session gets a minimal option set: `canUseTool`, a plain-string `systemPrompt` (the demo persona), `resume`, `cwd`, `model`, `allowedTools`. To host a real orchestrator we extend `SessionStartOptions` + the driver's options block with: `settingSources`, `mcpServers`, `env`, `disallowedTools`, `permissionMode`, and the preset+append systemPrompt form. All of this is driven by a new **"profile"** config (demo | orchestrator) so the same code runs either the safe demo OR the full orchestrator, selected at launch.

---

## 1. SYSTEM PROMPT / how the session becomes the orchestrator

**SDK fact (doc-cited):** `systemPrompt` accepts `{ type:'preset', preset:'claude_code', append:'<text>' }` → loads Claude Code's own system prompt AND appends custom text. `settingSources:['project']` (or omit for all) loads `CLAUDE.md` + `.claude/commands/` skills + settings; `[]` disables all of it.

**Recommendation (two-part, robust):**
- **(a) Load project context** via `settingSources: ['user','project','local']` + `cwd = D:/repos/PianoidInstall`. This makes the session load the repo `CLAUDE.md`, `.claude/commands/` (so `/orchestrator` exists as a skill), `.claude/settings*.json`, and memory — exactly the orchestrator's runtime context.
- **(b) Become the orchestrator** by INVOKING the skill on the first turn: the supervisor injects a synthetic first user turn `"/orchestrator"` (before any user message) so the session adopts the role, THEN forwards real user turns. This is more faithful than copying the skill body into `append` (the skill is 1154 lines + references companions; re-pasting it drifts). `append` is still used for a SHORT supervisor-context preamble (see §2 — "your channel is the bus, not the telegram tool").

**★FLAGGED — PROBE 1:** whether a `.claude/commands/*.md` skill is actually *invokable* in a headless `query()` session by sending `/orchestrator` as a turn (vs only being loadable as context). If the probe shows skills don't auto-trigger headless, fallback = `append` the skill body (read the .md, strip companions) into the preset systemPrompt. Either way the role gets loaded; the probe just picks the cleaner mechanism.

---

## 2. CHANNEL under the supervisor — the central design tension

**The conflict (load-bearing):** `orchestrator.md` §"CRITICAL: All Output via Telegram" (l.51-66) is a HARD rule — *every* orchestrator message MUST go out via the **Telegram channel reply tool** (`mcp__plugin_telegram_telegram__reply`). But under the supervisor the **production telegram plugin is EXCLUDED** (the supervisor owns the channel; FC-3 = every byte on the bus). So the hosted orchestrator's instinct ("call the telegram reply tool") points at a tool that won't be present.

**Two ways to resolve it — I recommend BOTH, layered:**

- **Primary (zero-skill-change): assistant-text auto-outbound.** The supervisor ALREADY maps `stream.assistant` text → `channel.outbound` (that's how the demo replied). So even if the orchestrator just "writes its reply as assistant text," it reaches the user over the bus. For the common case (status, questions, summaries) this Just Works — the orchestrator's normal narration IS the channel message.

- **Secondary (faithful to the skill's tool-call instinct): a supervisor-provided in-process MCP "channel" tool.** Add a tiny SDK MCP server (`createSdkMcpServer`) exposing e.g. `mcp__supervisor_channel__reply({ text })` that maps DIRECTLY to `supervisor.sendOutbound(operator, {text})`. We inject (via the §1(b) preamble `append`) a one-line override: *"Your channel is the supervisor bus. To message the user, either just write it as your reply, OR call `mcp__supervisor_channel__reply`. The telegram plugin is NOT available here."* This gives the skill a real reply-tool to call (matching its mental model) without the prod plugin, and is fully testable (the tool's a function).

  Inbound stays as today: `channel.inbound` → injected as the session's user turn (the Phase-2 envelope, now fixed).

**Why both:** the auto-outbound guarantees the user always hears the orchestrator even if it never calls a tool; the channel tool satisfies the skill's explicit "use the reply tool" contract + lets the orchestrator send deliberately (e.g. a file, a discrete status) distinct from its thinking narration. Voice/attachments can extend the channel tool later (the adapter already has STT/TTS).

**★Decision for you:** OK to add the in-process `mcp__supervisor_channel__reply` tool (Secondary)? Or ship Primary-only (auto-outbound) for 3a and defer the tool? I lean BOTH (small, and the skill expects a reply tool).

---

## 3. MCP SERVERS — wire the project's, exclude telegram

**SDK fact:** `options.mcpServers` is `Record<name,cfg>`; the shape matches `~/.claude.json`'s `mcpServers` EXCEPT `${VAR}` env placeholders must be resolved to literal values. Merge-vs-replace with config-file servers is **FLAGGED**.

**Recommendation:**
- Read the user's `~/.claude.json` `mcpServers` map at launch; build the SDK `mcpServers` option from it, **excluding** any telegram plugin entry (name match `telegram` / `plugin_telegram`), and **resolving** `${VAR}` env refs from `process.env`. INCLUDE: hostinger-email, whatsapp, whatsapp-work, google-workspace, context7, chrome-devtools, deepseek-codegen, etc. — whatever's configured.
- To GUARANTEE the prod telegram plugin can't reach the session regardless of merge/replace: ALSO pass `disallowedTools: ['mcp__plugin_telegram_telegram__*', 'mcp__telegram__*']` (deny-rules win over everything per the permission order). Belt-and-suspenders.

**★FLAGGED — PROBE 2:** does `options.mcpServers` MERGE with the settings-file servers (so I must explicitly drop telegram) or REPLACE them (so passing my curated map is sufficient)? The `disallowedTools` deny makes us safe either way, but the probe tells us whether the curated map is authoritative. Cheap to check (read `system_init`'s `mcp_servers` list from the stream).

---

## 4. ENV / AGENT-TEAMS

**SDK fact:** `options.env` REPLACES the subprocess env (must spread `...process.env`). `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` enables `Agent`/`SendMessage`/`Task*`; those must also be on the allow-list.

**Recommendation:** pass `env: { ...process.env, CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' }` for the orchestrator profile, and include `Agent`, `SendMessage`, `Task`, `TaskCreate`, `TaskUpdate`, `TaskList`, `ToolSearch` in the orchestrator allow-list. The supervisor's launch env already carries the test-bot token + (no) prod token; we just add the teams flag. (Confirm the hosted orchestrator's spawned sub-agents inherit the env — expected, since they're children of the same subprocess.)

---

## 5. PERMISSION PROFILE — configurable, two presets

**SDK fact:** order = deny → ask → mode → allow → `canUseTool` (only if unresolved). `bypassPermissions` is NOT constrained by `allowedTools` (use `disallowedTools`).

**Recommendation — a `profile` field on the session config, two built-ins:**

- **`demo` profile** (what Phase 2 shipped): narrow allow-list (`Read,Glob,Grep,mcp__supervisor_channel__*`), `fallback:'route'` → routes MOST tools to the user (shows off the FC-1 router). `permissionMode:'default'`.

- **`orchestrator` profile** (the real one): BROAD allow-list mirroring `.claude/settings.local.json` (`Bash`, `PowerShell`, `Read`, `Edit`, `Write`, `Glob`, `Grep`, `Agent`, `Skill`, `SendMessage`, `Task*`, `ToolSearch`, `mcp__*`) so heavy tool use is NOT user-gated, BUT the **safety floor still routes genuinely destructive ops** via `canUseTool`: a small deny/route predicate for e.g. `Bash`/`PowerShell` commands matching destructive patterns (`rm -rf`, `taskkill`/`Stop-Process` on system PIDs, `git push --force`, `git reset --hard`, disk-format). `permissionMode:'default'` (NOT bypass — we want `canUseTool` reachable for the safety floor). Routed-destructive → the same channel prompt + block-on-reply as the demo.

  Mechanism: allow-list covers the routine 95%; the destructive-pattern predicate in the router returns `route` (→ channel prompt) for the dangerous minority; everything else allowed. This keeps a real orchestrator usable while preserving the headline safety property on the truly risky ops.

- **Default for the full-orchestrator run = `orchestrator`**; the demo run keeps `demo`. Selected by a launch flag/env (e.g. `--profile orchestrator` / `SUPERVISOR_PROFILE`).

**★Decision for you:** the destructive-pattern set above (rm -rf / system-PID kill / force-push / hard-reset / format) — is that the right safety floor for 3a, or do you want it tighter/looser? It's config, so easy to tune.

---

## 6. PROPOSED BUILD ORDER (after your OK) + the probe gate

1. **Live PROBE (tiny, test-bot, ~1-2 throwaway queries)** — resolve the 3 FLAGGED items: (P1) skill-invokable-headless? (P2) mcpServers merge/replace? (P3) settingSources surfaces skills? Report results; adjust the design's mechanism choices.
2. **Config: `profile` + orchestrator option surface** (settingSources, mcpServers builder from ~/.claude.json minus telegram, env+teams flag, disallowedTools, permissionMode, preset+append systemPrompt). Unit-tested (no SDK).
3. **`mcp__supervisor_channel__reply` in-process tool** (if approved) + wire to sendOutbound. Unit-tested via the seam.
4. **Destructive-pattern safety-floor predicate** in the router (orchestrator profile). Unit-tested.
5. **Wire it through SessionHost/SdkSessionDriver** (extend SessionStartOptions; the Fake ignores the new fields). Re-green the deterministic suite.
6. **Live acceptance on the TEST BOT** — the user messages the bot, gets a genuinely functional orchestrator (takes a task, spawns a dev sub-agent, uses tools gated by the orchestrator profile, replies over the bus). Manual acceptance; suite stays green (Fake-driven).

The 4 Stream-A additive items (self-context-clean, operator-grade panel, Controller-via-bus, H2 watchdog) proceed in parallel/after — several are independent of this wiring (H2 watchdog + self-context-clean especially). I can start those now while this design awaits your OK, OR sequence everything after — your call.

---

## Open decisions for the team-lead (PAUSE here)

1. **§2** — add the in-process `mcp__supervisor_channel__reply` tool (BOTH), or auto-outbound-only for 3a?
2. **§5** — the destructive-pattern safety-floor set — right scope?
3. **§1(b)** — invoke `/orchestrator` as a first synthetic turn (preferred), vs append the skill body — OK to let PROBE 1 decide?
4. **Sequencing** — start the independent Stream-A items (H2 watchdog, self-context-clean) NOW in parallel with this design awaiting OK, or do everything strictly after your OK?
5. **Probe go** — OK to run the tiny live test-bot probe (1-2 throwaway orchestrator-context queries, minimal cost) to resolve the 3 FLAGGED items before the deep build?
