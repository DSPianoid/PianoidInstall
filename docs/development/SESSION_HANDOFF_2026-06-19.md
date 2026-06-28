# Session Handoff — 2026-06-19 — FOR THE HOSTED PRODUCTION ORCHESTRATOR

> Read this on startup. It is addressed to **you** — the production orchestrator now hosted by the M12
> supervisor. The previous CLI-based orchestrator wrote it as it stepped down.

---

## (a) Who you are now

You are the **LIVE production orchestrator**, hosted by the **M12 supervisor** (`tools/supervisor/`). You run:

- on the user's **production Telegram** (bot **@LeonidsForClaudeBot**) — reached via the supervisor's own
  Telegram **adapter** (a durable inbox-queue), NOT the Telegram plugin. The user types in their normal
  Telegram chat; the supervisor injects each message as your user turn and forwards your replies back. You
  do **not** call a telegram tool to reply — your assistant text is auto-forwarded by the supervisor.
- on the **REAL repo**: your cwd is `D:\repos\PianoidInstall` (no worktree isolation). You have **full
  project access** and **full responsibility** — real dev work on the Pianoid subrepos, spawning dev agents,
  running the loop. Adopt the `/orchestrator` role (the supervisor bootstraps it on your first turn).
- on **Opus 4.8 [1m]**, **subscription-billed** (a cost guard refuses to start if an API key is in the env).
- with **agent-teams ON** (cli-stream driver) — you **must** spawn dev sub-agents for code work (never edit
  engine/CUDA/middleware yourself; use `/dev`, `/fn`, etc.). The methodology in `~/.claude/CLAUDE.md` is
  folded into your system prompt (it is not auto-loaded, because the `user` setting source is excluded for
  containment — see below).

### Your guardrails (these are SAFETY, not test-scaffolding — do not try to defeat them)
- **Permission router**: your dangerous ops AND your sub-agents' dangerous ops are routed to the USER over
  Telegram for approval (allow/deny). A timeout = deny.
- **Containment / hijack fix**: you run `settingSources = project,local` (the `user` source is dropped) so
  you do **not** boot the production Telegram plugin (which would seize the getUpdates token and cut the user
  off). Keep it that way.
- **Outward-send seal**: telegram + both whatsapp servers are excluded and denied; email/gmail **send** is
  denied (email **read** is available). Your only channel to the user is the supervisor's Telegram adapter —
  you cannot message arbitrary third parties.
- **Self-management**: you can request your own restart (context reset) via
  `POST <panel>/api/lifecycle/restart-request {reason, handoffNote?}` — the supervisor confirms with the
  user, then restarts you fresh while preserving the Telegram conversation. Use the `/channel-check` command
  + the loopback panel (`/api/channel/*`) if the user reports the channel is broken.

### Your TOOL POSTURE (explicit scope — confirmed for this cut-over)
- **Full dev capability**: the core tools (Read/Edit/Write/Glob/Grep/**Bash**/**PowerShell**/Agent/Skill/
  Task*/WebFetch/WebSearch) + **agent-teams** are always-on. You do real dev work and spawn dev sub-agents.
- **MCP servers (read/compute)**: `hostinger-email`, `context7`, `chrome-devtools`, `google-workspace`,
  `deepseek-codegen` — the full Pianoid dev workflow (code-gen, docs lookup, UI testing, email read). This
  set is **accepted as-is** for production.
- **Email = READ-only** (send / reply / gmail-send are DENIED). **WhatsApp = fully excluded** (no read, no
  send). **External SEND is SEALED at the deny-list** (not merely routed) — defense-in-depth for a first
  autonomous deployment.
- **Net**: you can do ALL the dev work + read email + talk to the user, but your **only outbound is the
  supervisor's channel to the user** — you cannot message third parties. This is **EXPANDABLE on the user's
  say-so** (e.g. flip email-send from DENY to route-with-user-confirm); do not widen it yourself.

---

## (b) M12 is DONE + merged

The M12 supervisor work is complete and merged to **master** (`--no-ff`):

- **Merge SHA: `5b0c501`** (feature/m12-supervisor-phase3a → master). Feature tip: `d06e087`.
- Delivered: structured I/O drivers (cli-stream[claude -p] default with agent-teams + an SDK hedge behind the
  `SessionDriver` seam; the PTY/TUI screen-scraper was retired); the hosted-agent **lifecycle-restart**
  control; the **I/O-boundary redesign** (D1 `/channel-check`, D2 channel-control panel, D3 own-messages-only
  forwarding, D4 idle-aware ping/pong liveness, F1 delivery read-back, F3 sub-agent permission routing);
  the **internal-liveness heartbeat**; and the production safety gates (cost guard, permission router,
  settingSources containment, outward-send seal, Windows tree-kill teardown, tier-b restart counter).
- `tsc` clean; `node --test` **200/200**. Build holder: `tools/supervisor/` (TypeScript; `npm run build`).
- Archived: this campaign's session log → `docs/development/logs/archive/dev-m12p3a-2026-06-15-082752.md`;
  the two implemented proposals → `docs/proposals/archive/` (Status: IMPLEMENTED).

---

## (c) Pianoid stack state (for when you resume real dev work)

The Pianoid subrepos were pulled + rebuilt this campaign (the `/update-pianoid` pass). Current HEADs (all on
`dev`):

- **PianoidCore** `818bd9b` — `Merge feature/dev-excenergy-coeff-consolidation into dev` (consolidated coeff
  updater; all edits <10ms). The last round (818bd9b) was a LIGHT update (middleware `.py` only — no `.cu`
  change); the `.venv` `.pyd` is current + verified. (Earlier dev-excenergy rounds did the HEAVY CUDA rebuild.)
- **PianoidBasic** `5d28b67` — `Merge feature/dev-excenergy-coeff-consolidation into dev` (pack_excitation_factors
  split). Wheel rebuilt this session.
- **PianoidTunner** `02d2662` — `…dev-pitchfix-hammerchart-convertpixel…` (the excitation-API pair, up to date).

The Core/Basic pair is the **excitation-energy (dev-excenergy) B2** physics-energy API. The stack is currently
**DOWN / clean** (no backend, no frontend, ports free). The user re-**APPLY**s in the UI for a fresh backend
(default preset + init params per `docs/PROJECT_CONFIG.md#defaults`). If a build/startup issue arises, invoke
`/startup`; follow `docs/architecture/BUILD_SYSTEM.md` + `docs/guides/STARTUP_TROUBLESHOOTING.md` verbatim
(`.bat --heavy --both`, never release-only — the APPLY dialog defaults to debug).

---

## (d) OPEN ITEMS to carry

1. **Two supervisor defaults awaiting the user's confirm** (sensible defaults already coded; confirm or adjust
   if the user raises them):
   - **Env teardown scope on restart = minimal** — no port sweep, no worktree re-init; the supervisor process
     + your cwd persist across a restart, only your *context* resets.
   - **Restart rate-limit = 3 requests / 30 min** (loop guardrail).
   - Detail: `docs/proposals/archive/hosted-agent-lifecycle-restart-2026-06-18.md` §8.
2. **The M12 merge push is PENDING the user's yes.** Everything is **LOCAL on master** (merge `5b0c501`).
   `master` is ahead of `origin/master` by the M12 commits AND behind origin by unrelated commits — do **NOT**
   push or pull origin until the user explicitly approves; the team lead relays that decision.
3. **The Telegram channel is now the supervisor's adapter** (not the plugin). If the user says messages aren't
   arriving, the cause is no longer "reload the plugin" — inspect via `/channel-check` + `/api/channel/state`
   and reconnect/flush from the panel.

---

## (e) The prior orchestrator is stepping down

The previous **CLI-based** orchestrator (the terminal Claude Code session that drove this campaign) is handing
the user relationship to **you**. From now on, the user reaches the orchestrator **through the supervisor** on
their normal Telegram. There is no separate CLI orchestrator to coordinate with; you own the loop.

Welcome — you're live.
