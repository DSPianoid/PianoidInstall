# Generic Agentic-Development Skillset — Review & Open-Source Design Proposal

**Date:** 2026-06-11
**Author:** skillset-arch (architecture review)
**Status:** PROPOSAL — review + design only. No code/skill/source changes. Decision points for the user at the end (Part 3c).
**Scope:** A deep review of the entire Pianoid agentic-development skillset (skills + rule-docs + tooling + controller), a generic/project-specific classification, and a design for extracting the reusable methodology into a robust, consistent, intuitive open-source dev-kit — including: an init tool that generates project-specific rules, packaging the orchestrator as a controllable app with full I/O control, elevating "test yourself" to the central tenet, environment-capability detection + upgrade prompting, and tiering recurring procedures (script → cheap-model → frontier).

> Companion/source material: `.claude/commands/*.md` (20 project skills), `~/.claude/commands/*.md` (6 user skills), `.claude/CLAUDE.md` + `~/.claude/CLAUDE.md` (rule-sets), `docs/development/CONTROLLER.md`, `tools/dev-pipeline/` (+ README), `tools/deepseek-codegen-mcp/` (+ README), `docs/proposals/minimize-opus-calls-dev-pipeline-2026-06-06.md`, `~/claude-config/` (the existing distribution repo). Classified extracts: `D:\tmp\skillset-review\extract-*.md` (scratch, not committed).

---

## Executive Summary (the one-page TL;DR)

The Pianoid project has, over ~3 months and dozens of incident-driven iterations, grown one of the most sophisticated agentic-development methodologies in existence: a 10-step disciplined `/dev` workflow, a remote orchestrator that coordinates parallel sub-agents, a permanent read-only compliance **controller**, a `/multitask` wave-scheduler, a single-function `/fn` lane, a three-level `/review` rubric, and a growing tier of **deterministic scripts** (`tools/dev-pipeline/`) and **cheap-model delegation** (`tools/deepseek-codegen-mcp/`). **~70% of this is generic software-engineering methodology** that would make any serious project's AI-assisted development dramatically more reliable. The other ~30% is Pianoid specifics (CUDA build, ports, REST, ASIO/audio, the 4-repo layout).

**The headline split.** Of 20 project skills: **3 are essentially generic** (`review`, plus the *workflows* inside `dev` and `multitask`), **10 are HYBRID** (generic skeleton + project parameters — these define exactly what an init tool must parameterize), **and 4 are project-specific** (`diagnose`, `pianoid-ui`, `startup`, and the audio half of `test-ui`). The two rule-docs (`CLAUDE.md`) are ~55% generic methodology, ~45% Pianoid build/path/audio detail. The crown jewels — the marker-discipline signal grammar, the lock model, the Data Model Card, the cost-model-driven tiering, and the incident-derived "Known gaps in bypassPermissions" failure-mode catalogue — are **fully generalizable lessons** that must survive into the kit.

**The biggest quality defect found (evidence-based).** The canonical CUDA build command has **drifted across 11 skills**: `dev.md` + `CLAUDE.md` + `update-pianoid.md` + `sync.md` correctly mandate `--heavy --both` via *detached* `Start-Process` (and document *why* `--release`-alone and `cmd //c` are destructive in agent context), but **7 skills** (`fn`, `multitask`, `analyse`, `test-ui`, `diagnose`, `pianoid-ui`, `startup`) still tell the agent to use the **stale, documented-as-dangerous** `--heavy --release` / `cmd //c` form. Root cause: a ~7-line "Docs-first" preamble was **copy-pasted into 9 skill headers** and never re-synced — the textbook S3 (no-duplication) violation, committed by the skillset against itself. This is the strongest single argument for the kit's central design principle: **build/run/test discipline lives in ONE referenced place, never copied into N skills.**

**Orchestrator form-factor — DECIDED: the standalone supervisor (D2 locked).** Today the orchestrator runs *inside* the Claude Code CLI and is glued together by a Telegram plugin + 2 monkey-patches + a file-based inbox queue + **keystroke injection into the VS Code window** (`tools/cli_control.ps1`) — fragile against VS Code reloads, MCP stdio drift, and invisible CLI permission prompts. **The chosen design is a standalone "supervisor" process that owns the Claude Code CLI as a subprocess via the Agent SDK / `claude -p` headless mode** (stream-json I/O), exposing programmatic stdin/stdout, a durable pluggable channel adapter (CLI + Telegram core, others pluggable — D5), and a thin local web/TUI control panel. This replaces all three fragile mechanisms with one supervised, restartable process and gives the user the requested *full control over input and output*. ("Stay-in-CLI + harden" and "Claude Code plugin" are documented as *alternatives considered* in §2c, not the path.)

**"Test yourself" — the DEBUGGING-REPRODUCTION stance (the central tenet, reframed per the user).** The core principle is about *debugging*: **when something is wrong, never ask the user to test, reproduce, or paste logs — reproduce the user's experience EXACTLY yourself and debug from that reproduction.** This is the direct extension of the orchestrator's existing autonomy principle (the user supplies decisions/approvals/information, *never operations*) into the failure case. Two mechanisms make it real: (1) **ENABLEMENT** — an environment-capability *doctor* so the agent *can* reproduce the user's experience; when the box can't (no GPU, no ASIO, no mic-loopback, headless), it does NOT silently degrade — it PROMPTS the user with concrete steps to upgrade the environment for maximum reproduction/testing capability. (2) **ENFORCEMENT** — a **Verification Gate** (warn-first, graduating to enforce — D11) so a "done"/Phase-1 report carries a matching evidence artifact, with the binary audio routing generalized into a project-declared **"verification-surface" map**. The gate and the doctor are the scaffolding *around* the debugging-reproduction core, not the point itself.

**Procedure tiering is already 3 real codebases.** `tools/dev-pipeline/` (scripts), `tools/deepseek-codegen-mcp/` (cheap-model), and the Opus agents (frontier) already exist. The proposal **formalizes the migration**: ~14 of ~15 recurring `/dev` bookkeeping turns are scriptable (most already are); the **Controller and Monitors are the prime cheap-model (DeepSeek) targets** — their checks run over a known marker grammar, which is exactly the bounded, rule-based judgment a cheap model does reliably. A validated A/B already showed **~300× variable-cost reduction** on routine codegen with the test gate as the correctness guarantee.

**Bottom line.** The methodology is worth open-sourcing; it is *not yet* shippable as-is (drift, duplication, dead text, Pianoid-coupling). The work decomposes into a clean phased roadmap (Part 3b): **(P0 — DONE 2026-06-11, applied + verified)** de-drift + single-point-of-truth in place (the build-command drift across 11 skills is fixed; `docs/PROJECT_CONFIG.md` is the new operational-facts SSOT; a forbidden-form lint makes the drift unable to recur), **(P1)** extract the generic core + write the `init` wizard, **(P2)** the supervisor app + I/O control, **(P3)** the Verification Gate + capability doctor, **(P4)** complete the tier migration, **(P5)** the public release (a new dedicated public repo, MIT, with a sanitized generic example — Pianoid stays the private dogfood). **All 11 decision points are now LOCKED (2026-06-11) — see the "Decisions (locked 2026-06-11)" section below;** Part 3c records them as the chosen direction with rationale.

---

## Design evolution (2026-06-11, post-first-push) — MULTI-PROJECT + in-place (ii) separation

After the first push (commit `6335869`), two requirements reshaped the P1 separation. **This is a DESIGN checkpoint** — the ~45 generic-skill edits are designed + apply-ready but **NOT yet executed**; what is *done* is the design + the groundwork (`PROJECT_CONFIG.md`, the manifest, the script alias). Full detail: **`docs/proposals/generic-project-separation-plan-2026-06-11.md`** (the dedicated plan + Addenda 1–3), with `docs/PROJECT_CONFIG.md` (the complete 17-anchor project-config SSOT) and `docs/development/GENERIC_CORE_MANIFEST.md` (the per-artifact lift-list).

1. **MULTI-PROJECT is now a first-class requirement** (user: *"one system can manage several projects; one orchestrator may run two SIMULTANEOUSLY"*). A generic section duplicated inside each project's `CLAUDE.md` would be cross-project drift one level up — so the **generic core must be a SHARED unit (one copy across projects), not per-project.** Validated against the official Claude Code docs (memory/settings/sub-agents/agent-sdk):
   - **User-level `~/.claude/` is the shared layer** — `~/.claude/CLAUDE.md` + `~/.claude/commands/` + `~/.claude/rules/` load for *every* project regardless of cwd. Project-level (`<repo>/.claude/`) loads per-project by walking up from cwd. User + project are **additive** (no hard precedence → "state precedence explicitly in the more specific file").
   - **THE CRUX (simultaneous two-project):** per-subagent `cwd` is an **UNSHIPPED** Claude Code capability (open issues #31940/#12748) — sub-agents inherit the parent's single cwd. So correct per-project config resolution under concurrency **cannot be implicit (cwd-derived); it requires an EXPLICIT `PROJECT_ROOT` binding passed in every dispatch brief** — a new hard orchestrator rule (on the order of the `bypassPermissions` rule).
   - **Counterintuitive precedence (verified):** when a skill name exists at both levels, **personal (user) OVERRIDES project** — so the eventual hoist must *delete* the project copy of a hoisted skill (else it is silently shadowed).
   - **Three-layer design:** USER `~/.claude/` = shared project-agnostic generic core · PROJECT `<repo>/` = its own `PROJECT_CONFIG.md` + project rules + project-specific skills · DISPATCH = explicit per-task `PROJECT_ROOT` binding.

2. **P1 is executed IN-PLACE via (ii) stage-in-repo-first** (DP-1 = (ii), over (i) immediate hoist), with the **mark-in-place** mechanism. Verified: Claude Code does **not** load skills/commands from a separate top-level dir (only `.claude/commands` + `~/.claude/commands`), and `.claude/commands/` symlinks are undocumented + Windows-fragile (empirically `ln -s` here makes a copy, and native symlinks need Dev-Mode). So the generic skills **stay physically in `.claude/commands/`, tagged `tier: generic` and made genuinely project-agnostic** (every Pianoid fact → a `$PROJECT_ROOT/docs/PROJECT_CONFIG.md#anchor` reference), proven by a **grep gate** (zero `pianoid`/`PianoidCore`/port-quad/`build_pianoid`/`note_playback` tokens in a generic skill = machine-checkable liftability). The generic `CLAUDE.md` rules split into a new `.claude/CLAUDE.generic.md` (`@`-imported by `.claude/CLAUDE.md`). **The physical hoist to `~/.claude/` is a later, separately-approved step** (the agnostic-ization is the real value + is location-independent; the move is then trivial).

> **Naming note (surfaced 2026-06-11):** the harness ships built-in skills named `/verify`, `/run`, `/init`, `/code-review`, and **`/review`** — our project's `review` skill **collides** with the built-in `/review`; at hoist/extraction it must be renamed (e.g. `code-quality-review`). And the kit's generalized verification skill must **not** be named `/verify` (built-in collision) — the built-in `/verify` + `PROJECT_CONFIG.md#verification-surfaces` may *be* the generic verify path (the `2d` stance), avoiding a new skill entirely. (Deferred-skill concern; `test-ui` generalization is a later pass.)

---

# PART 1 — REVIEW & CLASSIFICATION

## 1a. Complete inventory (purpose · size · maturity · dispatch graph)

### Project skills (`.claude/commands/*.md`)

| Skill | LOC | Purpose (one line) | Maturity |
|---|---:|---|---|
| **dev** | 1288 | The disciplined development cycle: docs → baseline → branch → lock → edit → build → test → debug → verify → doc → merge → commit, + 5 exit procedures | Very mature, heavily incident-hardened |
| **orchestrator** | 1200 | Remote (Telegram) coordinator: receive → classify → spawn sub-agents → relay; owns full-clearance, conflict-resolution, queue-review, stall-recovery | Very mature, incident-hardened |
| **diagnose** | 1111 | 8-phase full-stack health check; `-fix` auto-repairs via `/dev`; audio_on canonical surface | Mature, project-specific |
| **review** | 491 | 3-level (local/module/system) code review vs `CODE_QUALITY.md`; severity matrix + confidence scoring | Mature, mostly generic |
| **pianoid-ui** | 429 | Drive the live UI via chrome-devtools MCP; adjust any param, capture sound | Mature, project-specific |
| **multitask** | 325 | N tasks → classify → conflict-graph → wave-schedule → parallel spawn → test → merge | Mature, generic engine |
| **test-ui** | 320 | E2E feature verification via UI + deterministic `note_playback` render; pass/fail with numbers | Mature, hybrid |
| **startup** | 318 | Install/build/startup failure reference: toolchain, CUDA, ports, audio drivers | Mature, project knowledge-base |
| **analyse** | 304 | Deep module analysis: docs audit → update → 9-axis quality assessment → improvement+test proposal | Mature, hybrid |
| **fn** | 300 | Single-function edit with a test gate; standalone or `/dev` sub-agent; opt-in DeepSeek codegen | Mature, hybrid |
| **update-pianoid** | 294 | Fetch all repos → smart-rebuild decision matrix → pull → sync skills → rebuild → doc-update | Mature, hybrid |
| **sync** | 214 | Analyze changes → conflict-detect → branch-check → doc-gap → commit → rebuild-gate → push | Mature, hybrid |
| **update-docs** | 166 | Sync docs to code: change→section map, lean style, Mermaid/SVG | Mature, hybrid |
| **cli-control** | 94 | Keystroke-drive the orchestrator's OWN CLI window (remote /clear+relaunch, release stuck prompt) | Mature, project-infra |
| *(setup-mcp, setup-google-workspace, setup-hostinger-email, pair-whatsapp, project-management, self-update — duplicated from user-level, see below)* | | | |

### User-level skills (`~/.claude/commands/*.md`, synced from `~/claude-config/`)

| Skill | LOC | Purpose | Class |
|---|---:|---|---|
| self-update | 164 | Pull `claude-config` repo → sync skills + MCP templates + memory to local | GENERIC infra (the distribution model) |
| setup-mcp | 219 | Install + configure all MCP servers (email, WhatsApp, Google) | Personal infra |
| project-management | 227 | Track projects from email/WhatsApp, draft actions, sync to GitHub | Personal productivity |
| setup-google-workspace / setup-hostinger-email / pair-whatsapp | 81–142 | Per-channel MCP setup/auth | Personal infra |

### Rule-docs & tooling

| Artifact | Size | Purpose |
|---|---|---|
| `.claude/CLAUDE.md` (project) | ~7k tok / 28 KB | Project rules: permission gaps, build discipline, auto-triggers, docs-first, audio routing, paths, frontend standards |
| `~/.claude/CLAUDE.md` (user) | small | User-global: skill org, MCP table, config-repo pointer |
| `docs/development/CONTROLLER.md` | 488 lines | The read-only compliance-monitor spec (invariants, markers, tiers, failure-mode catalogue) |
| `tools/dev-pipeline/` | 8 scripts + 145 tests | Deterministic bookkeeping (Step-0 scaffold, Phase-2 wrap, env-sweep, verify, perf, build, commit) |
| `tools/deepseek-codegen-mcp/` | core + server + batch + tests | Cheap-model codegen delegation (single + batch pipeline) |
| `tools/cli_control.ps1`, `kill_pianoid.ps1`, `clean_and_start.ps1` | 3 PS scripts | Orchestrator I/O + env ops |
| `tools/apply_telegram_*.py`, `transcribe_voice.py`, `tts_voice.py` | 4 py | Telegram channel patches + STT/TTS |
| `~/claude-config/` | repo | Distribution repo (skills + MCP templates + memory) synced via `/self-update` |

### The dispatch graph (how it interlocks)

```
                          USER (Telegram / CLI)
                               │
                       ┌───────▼────────┐         spawns once ┌──────────────┐
                       │  ORCHESTRATOR  │────────────────────▶│  CONTROLLER  │ (read-only monitor,
                       │  (coordinator) │◀── alerts (warn/    │  (Opus today)│  watches logs+locks+
                       └───────┬────────┘    escalate/halt)   └──────────────┘  git, marker grammar)
        classify + spawn (mode: bypassPermissions, per-dispatch notify controller)
            │            │            │             │             │           │
      ┌─────▼──┐   ┌─────▼────┐  ┌────▼─────┐  ┌────▼────┐   ┌─────▼───┐  ┌────▼──────┐
      │  /dev  │   │/multitask│  │ /review  │  │/test-ui │   │/analyse │  │/update-*  │
      └───┬────┘   └────┬─────┘  └──────────┘  └─────────┘   └─────────┘  └───────────┘
          │      spawns /dev per wave (worktree-isolated)
   Step 4b routes codegen by KIND:
          ├──▶ routine  → DeepSeek batch_pipeline (zero-Opus-per-fn)   [CHEAP-MODEL tier]
          ├──▶ judgment → inline (pruned)  OR  spawn Opus /fn          [FRONTIER tier]
          └──▶ C++/CUDA or cross-cutting → stays on /dev (never DeepSeek)
   Bookkeeping (Step 0, Phase-2 wrap, env-sweep, perf, build, commit) → tools/dev-pipeline/*  [SCRIPT tier]
```

**Key interlocks:** the orchestrator never executes — it dispatches; every dispatch notifies the controller (so it can arm the Step-0 SLA timer); `/dev` is the hub that all code change flows through and that spawns `/fn`/`/test-ui`/`/review`; `/multitask` is `/dev` × N with a conflict-graph scheduler; the **marker grammar** (emitted by `/dev` and `/fn`) is the shared signal the controller consumes; the **cost model** decides script-vs-cheap-vs-frontier for each unit.

## 1b. Quality audit (ROBUST · CONSISTENT · INTUITIVE) — evidence-based

### Inconsistencies & contradictions (cite file:line)

| # | Finding | Evidence | Severity |
|---|---|---|---|
| **Q1** | **Build-command drift across 11 skills (the dominant defect).** 4 skills mandate `--heavy --both` + detached `Start-Process`; 7 still say `--heavy --release` and/or `cmd //c` — which `CLAUDE.md` + `dev.md` explicitly document as **destructive in agent context** (`cmd //c` removes the `.pyd` before reinstall → bricks the venv; `--release`-alone leaves the debug `.pyd` stale → silent symbol error). **→ APPROVED P0 ACTION (2026-06-11): the exact 7-skill / 8-edit change-set is specced in `D:\tmp\skillset-review\p0-dedrift-ssot-spec.md` (Part A), and the root-cause fix — concentrating these facts in a single-point-of-truth so the drift cannot recur — is Part B (the build SSOT is `BUILD_SYSTEM.md#canonical-install--rebuild`; the operational-facts SSOT is a new `docs/PROJECT_CONFIG.md`; a forbidden-form lint enforces it).** | Correct: `dev.md:33,641`, `CLAUDE.md` Build block, `update-pianoid.md:17`, `sync.md:177`. Stale (the 8 edits): `analyse.md:19`, `diagnose.md:36`, `fn.md:25` + the `fn.md:185–195` `cmd //c` build block (HIGHEST risk — a direct `/fn` on a `.cu` file bricks the venv), `multitask.md:26`, `pianoid-ui.md:27`, `startup.md:28`, `test-ui.md:34`. | **High** |
| **Q2** | **Dead/contradictory "SendMessage is NOT available" text in orchestrator.** Three passages assert SendMessage is unavailable and prescribe respawn-instead-of-continue, directly contradicting Step 0 (which *mandates* SendMessage) and the entire team model. Pre-dates agent-teams; never removed. | `orchestrator.md:686` ("NOTE: Since SendMessage is NOT available…"), `:1099`, `:1133`. Contradicts `orchestrator.md:109–118` (Step 0). | **High** (an agent following the stale text respawns unnecessarily, losing context) |
| **Q3** | **`git add` philosophy split.** `sync.md:144` stages with `git add -A` (everything); `dev_commit.py` deliberately stages *exactly the named files, never `-A`* (and `dev.md` Phase-1 audits dirty-vs-locks). Two opposite commit-hygiene stances. | `sync.md:144` vs `dev-pipeline/README.md` (`dev_commit.py` "never `git add -A`"). | Medium |
| **Q4** | **Docs-first preamble duplicated 9×, already drifted.** The ~7-line "Docs-first (MANDATORY)" block is copy-pasted near-verbatim into dev/fn/multitask/analyse/test-ui/diagnose/pianoid-ui/update-pianoid/startup. Q1 is the drift this duplication caused. | All 9 skill headers. | **High** (root cause of Q1) |
| **Q5** | **Port-kill sweep duplicated ~8× (and 4× *within* `dev.md`).** The `for port in 3000 3001 5000 5001 … taskkill //F //PID` loop appears verbatim in dev (Step 1b kill, Step 1b cleanup, Step 10a hygiene), orchestrator, test-ui, diagnose, pianoid-ui. `env_sweep.py` exists but not all copies reference it. | `dev.md:391,480,1075`; `orchestrator.md:96`; `test-ui.md:151,272`; etc. | Medium |
| **Q6** | **Three overlapping git-merge-push flows.** `/sync` (push local), `/update-pianoid` (pull+rebuild), and orchestrator Phase-2 (merge-features→reconcile-origin) each implement subtly different merge/rebuild/push sequences. A user can't tell which to use without reading all three. | `sync.md`, `update-pianoid.md`, `orchestrator.md:80–92`. | Medium (intuitiveness) |
| **Q7** | **Doc-taxonomy stated in 3 places.** Full rule in `dev.md`, summaries in `orchestrator.md` + `analyse.md`. The summaries correctly say "full rule in dev.md" (acceptable referencing) but it's still 3 maintenance points. | `dev.md:40–66`, `orchestrator.md:1055`, `analyse.md:41`. | Low |

### Redundancy / duplication
Q4 + Q5 + Q7 above are the duplication hotspots. Additionally, the **failure-mode catalogue** ("Known gaps in bypassPermissions") exists in **three copies** — `CLAUDE.md`, `orchestrator.md` (Stalled Agent Recovery), and `CONTROLLER.md` (Failure-Mode Catalogue §12a–e). `CONTROLLER.md` explicitly resolves precedence ("where this doc and the skills disagree, the skills are authoritative") — good — but it's still 3 places.

### Dead / never-triggered rules
- Q2 (the SendMessage-unavailable passages) is the clearest dead rule.
- `orchestrator.md` UI-Testing crash-monitoring writes to `/tmp/test-ui-session.log` (POSIX path) on a **Windows** host — `/tmp` resolves via the bash sandbox but the PowerShell-launched processes write to `D:/tmp/`; the two are not the same directory, so some "read the session log after a crash" paths can miss. Minor robustness gap.
- The `marker_hook.py` PostToolUse hook is built but **unregistered and unusable** for its intended purpose (can't bind harness `agent_id` → `dev-XXXX` log under concurrency) — correctly deferred, but it sits as dead-ish code.

### Over-complex / unintuitive flows
- **Sheer size:** `dev.md` (1288) + `orchestrator.md` (1200) + `diagnose.md` (1111) = 3,599 lines an operator must internalize. The marker grammar alone (~35 markers) is ~70 lines repeated across dev + fn + controller.
- **UI-skill trichotomy:** `/test-ui` vs `/diagnose` vs `/pianoid-ui` — routing among them (audio_off synthesis-render vs audio_on mic-comparison vs interactive control) is documented in the Audio Verification Rule but a newcomer cannot pick correctly without reading it. Names don't disambiguate.
- **The Phase-1/Phase-2 wrap-up + 5 exit procedures (10a–10e)** are correct and necessary but dense; a first-time `/dev` agent faces a lot of state-machine before its first edit.

### Missing-but-implied rules
- **No single "verification gate"** — "test yourself / no claim without evidence" is spread across the Audio Verification Rule, `test-ui` principles, `dev` Step 7, and `diagnose`; nothing structurally *blocks* a "done" claim that lacks evidence. (Designed in 2d.)
- **No capability-probe** — the env gaps (no CUDA, no ASIO, no mic-loopback, headless) are documented reactively in memory/incidents but there's no proactive "detect + prompt to upgrade." (Designed in 2e.)
- **No self-test of the skillset** — there are 145 tests for `dev-pipeline` but nothing that lints the skills for drift (Q1 would have been caught by a trivial grep-lint in CI). (Proposed in 3a.)

### What is genuinely excellent (must be preserved)
The **marker discipline** (a precise, machine-readable signal grammar emitted into append-only session logs) is the best-engineered piece — it makes stall-detection, Documentation-First compliance, and the whole controller possible. The **lock model**, the **Data Model Card** (forcing doc-cited facts before high-stakes edits), the **cost-model-driven tiering**, the **worktree-per-parallel-agent** rule, and the **incident-derived failure-mode catalogue** are all top-tier, hard-won, and generalize cleanly.

## 1c. GENERIC vs PROJECT-SPECIFIC vs HYBRID classification

### Skills

| Skill | Class | Generic core (reusable) | Project parameters (what an init tool fills) |
|---|---|---|---|
| **review** | **GENERIC** | 3-level local/module/system; severity matrix; confidence scoring (≥50 report); P1-authority/P2-concern audit; S5 patch-hunt; C4 LOC god-object gate; required output sections | layer names, ports 5000/5001, terminology table, `cuda_lock`, grep patterns |
| **dev** | **HYBRID** | the entire 10-step workflow + 5 exit procedures; marker grammar; lock model; Data Model Card; context-hygiene; doc-gap-closure; folder taxonomy | build cmds, venv path, ports, test paths, audio-verification routing, doc hierarchy |
| **multitask** | **HYBRID** | conflict-matrix (8 rules) + greedy-graph-coloring wave scheduler + parallel-spawn + per-wave-test + post-wave-merge | layer table, build cmds, "one compiler at a time" resource, ports |
| **fn** | **HYBRID** | input contract; single-fn workflow; marker discipline; context-hygiene; opt-in cheap-model delegation; dual-backend test rule; parent-lock inheritance | build cmds, venv path, test runner |
| **orchestrator** | **HYBRID** | autonomy principle; no-direct-skill-exec; agent lifecycle state-machine; conflict resolution; queue review; full-clearance; stall recovery; worktree rule; merge-sweep | channel (Telegram), ports, repo names, build cmd, `.pyd`/DLL holders, doc paths, voice STT/TTS |
| **test-ui** | **HYBRID** | crash-logging discipline (log before+after EVERY tool call); measure-via-deterministic-surface; UI-only interaction; every-claim-a-number; mandatory cleanup | chrome-devtools MCP, `note_playback`, MUI chips, ports, hotkeys |
| **sync** | **HYBRID** | change-analysis → conflict-detect → branch-check → doc-gap → commit → **rebuild-gate (L1 import + L2 smoke-200)** → push; no-force-push | 4-repo map, branches, rebuild cmds |
| **analyse** | **HYBRID** | docs-audit-first; 9-axis quality assessment; health-summary + improvement + test-proposal templates | layer names, terminology, REST, audio-pipeline perf criteria |
| **update-docs** | **HYBRID** | change→section mapping; lean-style rules; Mermaid/SVG; infographic-sync | doc tree, module names |
| **update-pianoid** | **HYBRID** | fetch → smart-rebuild decision-matrix → pull → skill-sync → rebuild → doc-update; venv isolation; rebuild-gate | 4 repos, build cmds, required MCP list, Node version |
| **cli-control** | **HYBRID** | keystroke-drive the coordinator's own CLI; remote clear+relaunch via detached process; release stuck prompt; receipt-verify via transcript-tail | VS Code window title, transcript path, `/orchestrator start` cmd |
| **diagnose** | **PROJECT-SPECIFIC** | (structure only: Phase-0 commit gate; `-fix` auto-repair loop; sequential layer verification; audio parametric) | all 8 phases (mic loopback, Goertzel transferRatio, drivers, REST) are Pianoid |
| **pianoid-ui** | **PROJECT-SPECIFIC** | (principle only: UI-only interaction) | chrome-devtools, REST surface, MUI, ports |
| **startup** | **PROJECT-SPECIFIC** | (structure only: docs-first; classify→branch; verify-with-smoke-test) | the entire knowledge base (toolchain, CUDA, ASIO/SDL, ports, REST params) |
| self-update | **GENERIC** (infra) | the distribution+sync model (pull repo → sync skills+MCP+memory; merge MCP preserving creds) | repo URL, paths |
| setup-mcp / setup-* / pair-whatsapp | personal infra | per-channel MCP setup (generalizes to "channel adapter setup") | the specific MCP servers |
| project-management | personal productivity | project tracking from comms channels | the channels |

### Major rule blocks (`CLAUDE.md`)

| Rule block | Class | Generic lesson to keep | Project specifics to drop/parameterize |
|---|---|---|---|
| Orchestrator Sub-Agent Permission Rule + **Known gaps in bypassPermissions** | **HYBRID — the most valuable** | "a coordinator's sub-agents must run permission-suppressed because their prompts are invisible to the remote user; blanket-allow BOTH shells; long-running starters / TTY-openers / system-PID kills / MCP-reauth gate *regardless* — route them through no-prompt methods" | `pianoid-dev` team name, `Start-Process` exact form, port 3001 launcher REST |
| Repository Roots & Path Convention | HYBRID | "repo lives at different absolute paths per machine → use repo-relative paths; flag OS-specific binaries" | the Windows/Linux paths, `.venv/Scripts` vs `bin` |
| Auto-Trigger Rules | GENERIC | "a code-change request auto-invokes the dev workflow; investigation→implementation handoff must pause for the decision; compiled-language edits MUST go through the build-aware workflow" | `.cu/.cpp/.cuh/.h/setup.py` → CUDA |
| Documentation-First Rule | **GENERIC** | "consult docs before grepping source, at every stage, especially debugging; the doc hierarchy IS the context; high-stakes facts need doc support or measurement before an edit" | the specific doc paths + the axis/unit/index fact categories (Pianoid data-model) |
| Audio Verification Rule | HYBRID → generalizes to **"Verification-Surface Rule"** | "a change to output X must be verified on the surface that observes X, with measured before/after evidence" | audio_on/audio_off, mic loopback, `note_playback` |
| Build & Environment / Startup-failure / Build-commands | PROJECT-SPECIFIC | (structure: "the build is fiddly + has a destructive-stall failure mode in agent context → wrap it in ONE script that encodes the discipline; never substitute a force-reinstall") | everything CUDA/`.pyd`/venv |
| Frontend UI Standards | PROJECT-SPECIFIC | (pattern: "pin a design system + fetch its current docs before using its API") | MUI v6 / ECharts / mosaic / the exact rules |
| Self-Update Rule | GENERIC (infra) | "config syncs from a versioned repo via a skill" | the repo |

**The HYBRID items are the key insight.** Their *generic skeleton* ships in the kit; their *project parameters* are exactly the fields the `devkit init` wizard collects (Part 2b). Concretely the wizard must capture: **build command(s)** (+ the "destructive-in-agent-context" variant if any), **test command(s)** per level, **run/start command(s)**, **repo list + integration branches**, **ports/services**, **the control channel**, **verification surfaces** (which observable proves which kind of change), **interpreter/venv path**, **lock-file + WIP + log locations**, the **long-running-starter patterns** (what trips the harness gate), and the **doc-hierarchy entry points** for docs-first.

---

*(Part 2 — the design — continues below.)*

---

# PART 2 — THE DESIGN

## 2a. The open-source generic dev-kit package

**Name — DEFERRED (D4).** Final name is still open; *AFKode* is the current front-runner (registries checked — `hammock`, `offleash`, `codenomad` all collide). **Throughout this doc the placeholder `agentkit`/`devkit` stands in for the eventual name** (the CLI is written `devkit <cmd>`; rename on naming). Tagline: *"A disciplined agentic-development methodology for Claude Code — the dev workflow, orchestrator, controller, and tiered automation that any serious project can adopt."*

> **Pluggable-everywhere (D1 + D6 + D8).** Three extension points are *interfaces*, not hard-wired: the **codegen tier** (`adapters/codegen/` — DeepSeek is the reference impl, any cheap model can back it), the **control channel** (`adapters/channels/` — CLI + Telegram core, Slack/web pluggable), and **MCP servers** (the kit ships the *generic MCP extension mechanism* — a project adds MCP servers as pluggable functionality; per D8 the kit does NOT bundle the personal email/WhatsApp/gcal skills, only the mechanism to register MCP servers).

**Design principles for the package** (directly answering robust/consistent/intuitive):
1. **Single source of truth for every cross-cutting rule.** Build/run/test discipline, the port/process-sweep, the marker grammar, the doc-taxonomy, and the failure-mode catalogue each live in **exactly one** referenced file. Skills *reference* them; they are never copy-pasted. (This structurally prevents the Q1/Q4/Q5 drift class.)
2. **Generic core is read-only; project specifics are generated.** The kit ships unmodifiable generic skills + rule fragments; `devkit init` generates a project layer *on top*. Upgrading the kit never clobbers project rules.
3. **Composition over inheritance at runtime.** A skill = generic body + `{{placeholders}}` resolved from one generated `project.devkit.toml`. No forked skills.
4. **Self-testing.** The kit ships a `devkit lint` that fails CI on drift (a rule referenced in two places that diverged, a `{{placeholder}}` with no value, a skill that inlines a command instead of referencing the discipline doc).

**Proposed repository structure:**

```
agentkit/
├── README.md                      # what it is, the 60-second adoption flow, the philosophy
├── LICENSE                        # MIT or Apache-2.0 (decision point)
├── CHANGELOG.md                   # semver
├── devkit/                        # the installer/CLI (Python, stdlib-first)
│   ├── __main__.py                # `devkit init | install | upgrade | lint | doctor`
│   ├── init.py                    # the project-rules wizard (2b)
│   ├── compose.py                 # resolve generic skill + project.devkit.toml -> rendered skill
│   ├── lint.py                    # drift/placeholder/duplication linter
│   ├── doctor.py                  # capability probe (2e)
│   └── templates/                 # project-layer templates (CLAUDE.project.md.j2, etc.)
├── skills/                        # GENERIC skills (parameterized with {{placeholders}})
│   ├── dev/SKILL.md               # the 10-step workflow, build/test refs externalized
│   ├── fn/SKILL.md
│   ├── multitask/SKILL.md
│   ├── orchestrator/SKILL.md
│   ├── review/SKILL.md            # ships near-verbatim (most generic)
│   ├── analyse/SKILL.md
│   ├── verify/SKILL.md            # NEW — the generalized verification surface (was test-ui's generic half)
│   ├── update-docs/SKILL.md
│   └── sync/SKILL.md
├── rules/                         # the SINGLE-SOURCE cross-cutting rule fragments
│   ├── CLAUDE.core.md             # autonomy, docs-first, auto-trigger, verification-surface, no-direct-skill-exec
│   ├── permission-gaps.md         # the failure-mode catalogue (generic lessons)
│   ├── marker-grammar.md          # the ~35-marker signal spec (referenced by dev/fn/controller)
│   ├── doc-taxonomy.md            # folder taxonomy + one-doc-per-topic
│   ├── lock-model.md              # MODULE_LOCKS + lock-before-edit + worktree-per-parallel-agent
│   └── tiering.md                 # script->cheap-model->frontier doctrine + the cost model
├── controller/
│   └── CONTROLLER.md              # the read-only monitor spec (generic)
├── tools/                         # the SCRIPT tier (generalized dev-pipeline)
│   ├── dev_init.py  dev_wrap_phase2.py  env_sweep.py  verify_phase1.py
│   ├── run_tests.py  build.py  dev_commit.py            # generalized from run_perf/build_pianoid
│   ├── common.py    capability_probe.py                 # + the probe matrix
│   └── tests/                                            # the kit's own test suite
├── adapters/                      # pluggable integrations
│   ├── codegen/deepseek/          # the cheap-model codegen adapter (generalized)
│   ├── channels/                  # control-channel adapters (telegram/, slack/, cli/, web/)
│   └── supervisor/                # the orchestrator-app supervisor (2c)
└── examples/
    └── pianoid/                   # a worked project.devkit.toml + generated layer (dogfood)
```

**Exactly which generic skills ship:** `dev`, `fn`, `multitask`, `orchestrator`, `review`, `analyse`, `verify` (generalized from `test-ui`), `update-docs`, `sync`. **Not shipped as generic:** `diagnose`, `pianoid-ui`, `startup` (these become *templates* in `devkit/templates/` showing how to write a project-specific diagnostic/UI/startup skill — their *structure* is the reusable part, not their content). The personal-assistant skills (`setup-*`, `pair-whatsapp`, `project-management`) are **out of scope** for the dev-kit (they belong in the user's `claude-config`, a separate concern).

**Licensing:** **MIT** (recommended) for maximum adoption of a methodology/tooling kit; Apache-2.0 if patent-grant matters to the user. (Decision point.)

**Versioning + onboarding:** semver; the kit is a git repo + (optionally) a `pipx`-installable `devkit` CLI. **Adoption flow (60 seconds):**
```
pipx install agentkit           # or: git clone + pip install -e .
cd my-project
devkit init                     # interactive wizard -> writes .claude/ project layer + project.devkit.toml
devkit doctor                   # capability probe -> prints what's testable + upgrade prompts
# (reload the editor) -> /dev, /orchestrator, /review ... now work, parameterized for THIS project
devkit upgrade                  # later: pull new kit version, re-render, lint — never clobbers project rules
```

## 2b. The project-rules builder tool (`devkit init`)

**Goal:** interrogate a project and *generate* the project-specific layer (the equivalent of this repo's `.claude/CLAUDE.md` + the per-skill parameter blocks) on top of the generic core — intuitively, with detection + confirmation rather than a blank questionnaire.

**UX model: detect -> confirm -> fill gaps (a guided wizard, not a bare form).**
1. **Auto-detect** what it can: language/stack (lockfiles, `package.json`, `pyproject.toml`, `Cargo.toml`, `*.sln`), test runner (pytest/jest/go test/cargo test), build command (Makefile/scripts/`npm build`), repo list + integration branches (`git remote`, `git branch -r`), services/ports (scan `docker-compose`, `.env`, common run scripts), doc hierarchy (`docs/`, `README`).
2. **Confirm** each detected value with the user (pre-filled, editable). This is the bulk of the wizard — fast because most fields are guessed correctly.
3. **Ask only what can't be detected:** the control channel (CLI / Telegram / Slack / web), the **verification surfaces** (the central question — "for a change to <X>, what observable proves it works, and how do I capture it?"), any **destructive-in-agent-context build variant**, and the **long-running-starter patterns** (what commands spawn detached servers / trip a long-running gate).

**The generated artifacts:**
- `project.devkit.toml` — the single config the composer reads (see schema below).
- `.claude/CLAUDE.md` — generic `rules/CLAUDE.core.md` (referenced) + a generated project section (paths, build/test/run, ports, channel, verification surfaces, doc hierarchy).
- `.claude/commands/*.md` — the generic skills, **rendered** with placeholders resolved (so `/dev` says the project's real build command, once, by reference).
- `docs/development/{MODULE_LOCKS.md, WORK_IN_PROGRESS.md, logs/}` scaffolding.
- `.claude/settings.local.json` — the blanket-allow (`Bash(*)`, `PowerShell(*)`, core tools, MCP) the permission model needs.

**`project.devkit.toml` schema (the HYBRID parameters, made explicit):**
```toml
[project]
name = "pianoid"
repos = [
  { name = "PianoidCore",   path = "PianoidCore",   branch = "dev" },
  { name = "PianoidTunner", path = "PianoidTunner", branch = "dev" },
  { name = "root",          path = ".",             branch = "master" },
]
interpreter = "PianoidCore/.venv/Scripts/python"   # OS-resolved

[build]
default = "PianoidCore/build_pianoid_cuda.bat --heavy --both"
agent_context = "detached"        # detached | inline   <- the "cmd //c bricks the venv" fact, captured ONCE
stop_holder_first = "curl -X POST http://127.0.0.1:3001/api/stop-backend"
verify_landed = "import pianoidCuda"               # the L1 marker
post_merge_smoke = "POST /load_preset -> 200"      # the L2 gate

[test]
unit = ".venv/Scripts/python -m pytest tests/unit"
baseline = ".venv/Scripts/python -m pytest tests/system/test_performance_audio_off.py -s"
regression = { gpu_mean_pct = 10, corr_min = 0.95 }   # the hard-fail thresholds

[run]
start = "start-pianoid.bat"
ports = [3000, 3001, 5000, 5001]
long_running_starters = ["npm run dev", "cmd //c start*", "python backendserver.py"]  # gate-tripping patterns

[channel]
kind = "telegram"                 # cli | telegram | slack | web
# ... channel-specific config

[[verify_surface]]                # <- the heart of "test yourself" (2d)
name = "synthesis-output"
triggers = ["volume", "excitation", "physical params", "hammer", "kernel"]
surface = "note_playback offline render"
capture = "POST /get_chart_test {chartType:'note_playback'} -> decode WAV -> max/rms"
mode = "audio_off"
[[verify_surface]]
name = "mic-path"
triggers = ["calibration", "MicAnalyzer", "measurement_engine"]
surface = "mic-vs-synth Goertzel transferRatio"
mode = "audio_on"
requires = "mic_loopback"

[docs]
hierarchy = ["docs/index.md", "docs/architecture/SYSTEM_OVERVIEW.md", "docs/architecture/DATA_FLOWS.md"]
```

**How generic + project compose at runtime:** the rendered skill in `.claude/commands/dev.md` is the generic body with `{{build.default}}`, `{{test.baseline}}`, `{{verify_surface}}` etc. substituted, plus a one-line reference to the single `rules/marker-grammar.md`. There is exactly one place each fact lives -> no drift. `devkit lint` verifies every placeholder resolved and no rule got inlined.

**Why this is the right shape:** the HYBRID classification in 1c *is* the wizard's field list. The user asked to "separate generic rules from project-specific ones ... provide a tool to build project specific rules intuitively" — detect-confirm-fill on the exact HYBRID parameter set is that tool.

## 2c. Orchestrator-as-app + full I/O control — THE DESIGN: standalone supervisor (D2 locked)

**The problem (grounded in the code).** The orchestrator runs *inside* the Claude Code CLI session and is held together by fragile glue: a Telegram plugin + two monkey-patches (`apply_telegram_patch.py` for a file-based inbox queue because the plugin **drops inbound messages**, `apply_telegram_voice_patch.py` for voice), a file inbox under `~/.claude/channels/`, and — most tellingly — **keystroke injection into the VS Code window** (`tools/cli_control.ps1`) to remote-`/clear`+relaunch or to release an invisible permission prompt. Failure modes documented across `CLAUDE.md` + `orchestrator.md` + memory: a **VS Code reload kills the session**; **MCP stdio drift** (npx `@latest` re-resolves mid-session) silently breaks tool pipes; **invisible CLI permission prompts** stall sub-agents with no remote approval path; there is **no programmatic stdin/stdout** — output reaches the user only by the orchestrator remembering to mirror to the channel.

### THE DESIGN — a standalone supervisor process (DECIDED)

A separate OS process (Python, Agent SDK / `claude -p` headless) that **owns the Claude Code CLI as a subprocess**, pipes its stdin/stdout via stream-json, runs a **pluggable channel adapter**, and supervises restarts. It is the only form-factor that gives the user the literally-requested *"full control over the input and output"* — because the supervisor process *is* the stdin/stdout owner of the Claude Code subprocess (the Agent SDK supports headless `claude -p`/streaming with `--output-format stream-json` + `--input-format stream-json`, which is exactly a programmatic I/O channel). It dissolves the three worst failure modes at once:

| Failure mode (today) | How the supervisor design dissolves it |
|---|---|
| **No programmatic I/O** (output only reaches the user if the orchestrator remembers to mirror) | The supervisor's I/O bus is the boundary — *every* byte in/out passes through it and is captured; mirroring is structural, not a remembered rule. |
| **VS Code reload kills the session** | The supervisor is independent of the editor; it (re)spawns the CLI subprocess. |
| **Invisible CLI permission prompts** stall remote agents | The supervisor reads the prompt from the subprocess stdout and relays/answers it programmatically (or runs sandboxed skip-permissions) — no keystroke injection. |
| **MCP stdio drift** (npx `@latest` mid-session) | Health-checks the MCP pipes + restarts the subprocess cleanly. |
| **Remote control bound to one channel + 2 monkey-patches** | A **pluggable channel adapter** (CLI + Telegram core; Slack/web pluggable — D5) + an optional local web/TUI control panel; `cli_control.ps1` and the channel patches collapse into the one supervisor. |

Architecture:

```
   +--------------------------- SUPERVISOR PROCESS (Python, Agent SDK) ---------------------------+
   |   channel adapter <=>  I/O bus  <=>  Claude Code subprocess (claude -p, stream-json in/out)  |
   |   (telegram/slack/      |            ^                                                         |
   |    web/cli)             |            | reads prompts/output, writes instructions              |
   |   control panel (web/TUI)|           |                                                         |
   |   health-check: MCP pipes, ports, subprocess liveness -> auto-restart                          |
   |   transcript capture (durable log of ALL I/O — the audit trail the user asked for)             |
   +----------------------------------------------------------------------------------------------+
```
The supervisor enforces the "all output mirrored + captured" rule **structurally** (every byte in/out passes through its I/O bus and is logged) rather than relying on the orchestrator to remember to mirror to the channel.

**Incremental migration path (de-risks the build):** ship the **pluggable channel adapter + transcript capture first** (works alongside today's in-CLI orchestrator), then add subprocess ownership (`claude -p` stream-json), then retire `cli_control.ps1` + the Telegram monkey-patches. Each step is independently useful and reversible, so the supervisor can be adopted gradually rather than as a big-bang cutover.

### Alternatives considered (NOT the path)

| Alternative | Why not chosen |
|---|---|
| **A — Stay in CLI, harden** (formalize `cli_control.ps1` + the channel patches, pin all MCP versions) | Lowest effort, but the fragility *remains* — keystroke injection is inherently brittle, the reload-kills-session and invisible-prompt classes are only mitigated, never dissolved, and there is still no real programmatic I/O. Falls short of the user's "full control over input and output." |
| **B — Claude Code plugin** (package the orchestrator as a first-class plugin with a stable channel + lifecycle hooks) | Bounded by whatever the harness plugin API exposes (uncertain); a plugin gets channel-in/out at best, not raw stdin/stdout, and its lifecycle is still tied to the harness/editor — so it cannot guarantee survival across reloads or own the subprocess. |

Both remain available as **fallbacks** if the supervisor build hits an SDK limitation — the incremental migration path above keeps Stay-in-CLI (A) working until the supervisor fully lands.

## 2d. "Test yourself" — the DEBUGGING-REPRODUCTION stance (THE central tenet)

**The core principle (the central statement — user-authoritative, 2026-06-11).**

> **When something is wrong, do NOT ask the user to test it, reproduce it, narrow it down, or paste logs. Reproduce the user's experience EXACTLY yourself, observe the failure first-hand, and debug from that reproduction.**

This is the **debugging** stance, and it is the heart of "test yourself." It is the direct extension of the orchestrator's **existing autonomy principle** — *the user supplies decisions, approvals, and information; never operations* — into the failure case. A bug report is not a request for the user to keep operating the machine on the agent's behalf; it is information. The agent owns the reproduction and the diagnosis end-to-end: stand up the exact stack, drive the exact inputs, capture the exact symptom, then fix from the observed behavior — never from a guess, and never by bouncing "can you try X and tell me what you see?" back to the user. (This is also why "measure, don't guess" and the Data Model Card already live in the methodology — they are the same stance applied to *understanding* before editing; the debugging-reproduction rule applies it to *failure*.)

**Why it needs scaffolding.** Two things can break the stance, and each gets a dedicated mechanism so the principle holds in practice rather than just on paper:

- it requires the agent to be **able** to reproduce the user's experience (the box must have the right tools) → the **ENABLEMENT** mechanism (2e: the capability *doctor*);
- it must not quietly decay into "I'll just assert it's fixed" without ever reproducing → the **ENFORCEMENT** mechanism (the Verification Gate below).

Both are *scaffolding around* the debugging-reproduction core, not the core itself.

### ENABLEMENT — reproduce the user's experience, or PROMPT to make it reproducible (2e)

The agent cannot debug from a reproduction it cannot create. So before/at the point of reproduction the **capability doctor** (full design in 2e) checks whether this environment can reach the user's actual experience for the affected surface. If it can, the agent reproduces and debugs. **If it cannot** (no GPU, no ASIO, no mic-loopback, headless — all real documented gaps), the agent does **not** silently substitute a weaker check and does **not** offload the reproduction to the user — it **PROMPTS the user with the concrete steps to upgrade the environment for maximum reproduction/testing capability**, and reports exactly which part of the user's experience it could and couldn't reproduce. "I can't reproduce it here" becomes an explicit, actionable upgrade prompt, never a silent gap and never a "can you try it on your machine?".

### ENFORCEMENT — the Verification Gate (warn-first → enforce, D11)

So the stance can't decay into an unverified "done," a fix is only finished when the agent has **observed** the corrected behavior on the surface that exhibits it — and left the evidence:

1. **Generalize "audio_on/audio_off" → "verification surfaces."** Each project declares (in `project.devkit.toml`, 2b) a set of `verify_surface` entries: `{triggers, surface, capture, mode, requires}`. A surface is *whatever observable exhibits a class of behavior* — the very thing you reproduce a bug on and then re-observe to confirm the fix (an offline render, an HTTP 200 + payload assertion, a screenshot diff, a benchmark delta, a golden-file compare, a mic recording). The Pianoid audio_off/audio_on binary becomes two rows in a generic table.

2. **The Verification Gate (structural, warn-first then enforce — D11).** A `/dev` (or `/fn`) agent's Phase-1 "done" report is checked for a `[VERIFY-INVOKE] surface=<name> mode=<...>` **and** a `[VERIFY-EVIDENCE] artifact=<path> metric=<value>` whose surface matches the trigger-class of the files it edited — i.e. proof it reproduced + re-observed the behavior, not just asserted it. **Rollout per D11:** ship as **warn-first** (the controller flags a missing-evidence "done" as a Tier-1 warn and the orchestrator surfaces it, but does not block) for an initial window, then **graduate to enforce** (Tier-3 "unverified done" halt + `verify_phase1.py` fails closed unless the evidence marker references a real artifact). The graduation matches the project's own incident-driven tightening style — prove the gate is right before making it hard.

3. **Evidence artifacts are durable.** Every verification produces a file under `docs/development/evidence/<agent-id>-<surface>.<ext>` (metrics JSON, WAV, screenshot, benchmark table) referenced from the session log — the captured reproduction/observation. "Done" means "here is the surface I reproduced it on and the number," not "I believe it works."

4. **A surface the box can't reach → routes to ENABLEMENT, never a silent skip.** If a change's declared surface `requires` a capability the box lacks, the gate does not pass quietly — it routes to 2e (prompt the user to upgrade), and the agent reports "reproduced + verified on surfaces X,Y; surface Z BLOCKED — needs <capability>, here's how to enable it." (Same rule as ENABLEMENT, reached from the gate side.)

**Net:** the central tenet is the **debugging-reproduction stance** — reproduce the user's experience exactly and debug from it, never offload operations to the user. The capability doctor makes that stance *possible* (or prompts the user to make it possible); the Verification Gate makes it *stick* (warn-first → enforced evidence). "Test yourself" stops being a scattered sentence and becomes the operating posture of every agent facing a problem.

## 2e. Environment-capability detection + upgrade prompting

**Goal (user's words):** "When orchestrator lacks tools to reproduce user experience exactly, it should prompt user how to upgrade the environment for maximum testing capability." Grounded in **real documented gaps**: no CUDA GPU (the no-CUDA CPU-synthesis mode, `docs/proposals/no-cuda-cpu-synthesis-2026-06-10.md`), **no ASIO driver** (`reference_asio_not_installed_gigaport` — the machine has no ASIO; ASIO->SDL3 auto-fallback exists but a failed ASIO would otherwise = silence), **no mic-loopback** (`_MIC_LOOPBACK_CONFIGURED` gates audio_on tests), **chrome-devtools MCP fragility** (the `@latest` stdio-pipe break + isolated-profile lock), and headless-vs-interactive.

**Design: a capability-probe matrix + a `devkit doctor` command + a runtime gate hook.**

| Capability | How to detect | What it unlocks (verification surface) | How to upgrade (the prompt) |
|---|---|---|---|
| **CUDA GPU** | `nvidia-smi` / `import <gpu-module>` succeeds | full-fidelity synthesis render; GPU perf baseline | "No CUDA GPU detected -> running CPU-synthesis mode (lower fidelity). For GPU verification, run on a CUDA box or enable the GPU." |
| **ASIO driver** | `HKLM\SOFTWARE\ASIO` present / driver enumerates | low-latency audible playback (ASIO driver type) | "No ASIO driver -> using SDL3 fallback. For ASIO testing, install ASIO4ALL or your interface driver." |
| **Speaker->mic loopback** | `_MIC_LOOPBACK_CONFIGURED` + a 1 kHz round-trip probe | **audio_on** mic-vs-synth verification (only way to verify the mic path) | "No mic-loopback -> audio_on (mic) tests are BLOCKED. To enable: route system audio to an input (VB-Cable/Loopback) and set `_MIC_LOOPBACK_CONFIGURED=True`." |
| **Browser automation (chrome-devtools MCP)** | tool reachable + a trivial `new_page` returns | live-UI verification (`/test-ui`, `/pianoid-ui`) | "chrome-devtools MCP unreachable -> UI verification BLOCKED. Pin `chrome-devtools-mcp@<v>` + `--isolated` in `~/.claude.json` and reload." |
| **Interactive (vs headless)** | TTY present / display available | anything needing keystrokes or a window | "Headless environment -> routing interactive ops via the `! <command>` user prefix." |
| **The control channel** | channel adapter health-check | remote orchestration + I/O | per-channel setup prompt |

**Mechanics:**
1. **`devkit doctor`** runs the full matrix at setup/onboarding and prints a capability report: available / degraded-with-fallback / blocked, with the upgrade prompt for each non-available capability. (Generalizes Pianoid's `diagnose` Phase-0 + the ASIO/CUDA/mic checks scattered in conftest + memory.)
2. **Runtime gate (the "test yourself when you can, prompt when you can't" loop).** When the Verification Gate (2d) needs surface Z and Z `requires` capability C, a `tools/capability_probe.py` check runs; if C is absent, the agent does **not** silently pass — it emits `[CAP-GAP] capability=C surface=Z` and reports to the user (via the channel): "I verified X and Y by measurement; surface Z needs <C> which this environment lacks — to reach maximum testing capability, <upgrade prompt>. Proceed without Z, or enable it?"
3. **Probes are declared, not hard-coded.** Each `verify_surface.requires` names a capability; each capability has a probe + an upgrade prompt in `tools/capability_probe.py` (project-extensible). New env (e.g. a second GPU vendor) = one probe entry.

This makes the user's directive actionable and *honest*: the orchestrator reproduces the user's experience **as exactly as the box allows**, measures what it can, and — precisely when it can't reach a surface — tells the user the concrete step to upgrade the environment for maximum testing capability.

## 2f. Procedure tiering: SCRIPT-FIRST -> CHEAP-MODEL -> FRONTIER

**The doctrine (already proven in `minimize-opus-calls-dev-pipeline-2026-06-06.md`):** an op is **scriptable** iff deterministic + no-branch-on-meaning + loud-local-failure. A frontier (Opus) turn re-reads the agent's whole accumulated context (~65% of cost); removing a turn (-> script) is always a win; a fresh frontier sub-agent re-pays a ~$0.15 startup tax (so N isolated Opus workers lose to one pruned agent — isolation pays *only* with a cheap model). So: **script the deterministic, cheap-model the bounded-judgment-over-a-known-grammar, keep frontier for genuine open-ended judgment.**

**Audit of every recurring procedure -> cheapest correct tier:**

| Procedure | Current tier | Target | Justification |
|---|---|---|---|
| Step-0 scaffold (id, log header, WIP row, branch) | **SCRIPT** (`dev_init.py`) done | SCRIPT | Pure templating. |
| Phase-2 wrap (archive log, remove WIP row, archive proposal) | **SCRIPT** (`dev_wrap_phase2.py`) done | SCRIPT | Deterministic moves. |
| Env/port sweep (kill listeners on N ports, verify free) | **SCRIPT** (`env_sweep.py`) done | SCRIPT | Structurally port-scoped-only. The ~8 prose copies (Q5) should all *reference* it. |
| Phase-1 verify (4 boolean checks) | **SCRIPT** (`verify_phase1.py`) done | SCRIPT | Pure assertions. |
| Perf run + parse + delta table | **SCRIPT** (`run_perf.py`) done | SCRIPT (verdict -> frontier) | Parse/format scripted; the *acceptable-regression?* verdict stays frontier. |
| Build discipline (precheck->stop-holder->detached->poll->verify-marker) | **SCRIPT** (`build_pianoid.py`) done | SCRIPT (diagnosis -> frontier) | Encodes the destructive-stall discipline; build-*failure* diagnosis stays frontier. |
| Commit with `[agent-id]` prefix | **SCRIPT** (`dev_commit.py`) done | SCRIPT | Plumbing + prefix; wording stays frontier. |
| Routine single-function codegen | **CHEAP-MODEL** (DeepSeek batch_pipeline) done | CHEAP-MODEL | Test gate = correctness guarantee; ~300x cheaper. |
| Marker emission (`[BASH-CALL]`/`[READ]`/... per tool call) | FRONTIER (hand-emitted) | **SCRIPT (hook)** *blocked* | Mechanical echo, but a PostToolUse hook can't bind harness-id->`dev-XXXX` log under concurrency (`marker_hook.py` verdict). **Unblocked by 2c** — the *supervisor* sees every tool call on the I/O bus and can write markers keyed correctly. Migrate when the supervisor lands. |
| Merge sweep / reconcile-origin sequence | FRONTIER | **SCRIPT (plumbing) + FRONTIER (conflicts)** | Branch-merge ordering + push is deterministic plumbing (`merge_sweep.py`); *code-conflict* resolution stays frontier (registry/doc conflicts union-merge by script). |
| Stale-agent scan (read logs, find last marker, compute age, classify tier) | **FRONTIER (the Controller)** | **CHEAP-MODEL (+ script for the booleans)** | The age computation + marker-presence is a **script**; the "classify last marker against the failure-mode catalogue + recommend action" is **bounded judgment over a known grammar = a DeepSeek call**. The user's explicit target. |
| Documentation-First sliding-window check | **FRONTIER (the Controller)** | **SCRIPT** | Pure pattern over `[READ]`/`[GREP]` markers with declared exemptions — fully deterministic. |
| Per-agent invariant checks (Step-0 SLA, lock-vs-dirty, commit-prefix, premature-Phase-2) | **FRONTIER (the Controller)** | **SCRIPT (booleans) + CHEAP-MODEL (the rare judgment)** | Almost all are boolean cross-refs of files/markers -> script; only "is this stall a real permission gate vs a legitimate long op?" is judgment -> cheap-model. |
| Health checks / pulse / port-and-git-status reporting | **FRONTIER (orchestrator turn)** | **SCRIPT** (`clearance.py`/`doctor`) | Deterministic gather -> one script call. |
| Dispatch notification to controller | FRONTIER (orchestrator turn) | **SCRIPT/HOOK** | Mechanical message-send; a hook on spawn. |
| Task classification (which skill for this request) | FRONTIER | **FRONTIER** | Genuine semantic judgment — stays. |
| Conflict/merge *resolution*, regression *verdict*, build-failure *diagnosis*, DMC *authorship*, hypothesis-confirmed *decision* | FRONTIER | **FRONTIER** | The judgment slivers — must stay (the cost-model "what must STAY Opus" table). |

**The Controller + Monitors migration (the user's explicit ask), concretely.** The Controller is the prime cheap-model target because **its enforcement runs over a precisely-specified marker grammar** (`CONTROLLER.md` + `marker-grammar.md`) — exactly the bounded, structured input a cheap model handles reliably. Migration design:
- **Split the Controller into (1) a deterministic core (`controller_core.py`, SCRIPT)** that does all the boolean invariants (SLA timers, lock-vs-dirty cross-ref, marker-presence, sliding-window doc-first, stale-age computation) — no model needed; and **(2) a thin "judgment" layer (CHEAP-MODEL/DeepSeek)** for the few genuinely-interpretive calls (classify a stalled agent's last marker against the failure-mode catalogue + recommend inline-approve / user-prompt / kill-respawn; decide if a perf breach "looks intentional"). The judgment layer gets a **structured prompt** (the marker grammar + the catalogue are already a fixed schema) and returns a structured verdict.
- **Reliability mechanism for the cheap-model judgment:** the same pattern that makes the DeepSeek codegen safe — a **deterministic gate around a cheap-model call**. The cheap model proposes a classification; `controller_core.py` validates it against the catalogue's allowed values (a hallucinated tier/action is rejected -> fall back to the script's conservative default: escalate to the orchestrator). The Controller's cost drops from a full Opus agent alive all session to a script + occasional bounded DeepSeek calls.
- **Monitors** (the `Monitor`-tool log watches) are already event-driven; the *reaction* to a Monitor notification becomes a `controller_core.py` invocation (script), escalating to the cheap-model judgment layer only when a stall is suspected.

**Net tiering outcome:** ~14 of ~15 recurring `/dev` bookkeeping turns are SCRIPT (most already are); routine codegen is CHEAP-MODEL (done); the Controller/Monitors move from a full frontier agent to **script + cheap-model**; only genuine open-ended judgment (classification, conflict/verdict/diagnosis/DMC, hypothesis-confirmation) stays FRONTIER. This is the user's "switch regular procedures from agent-driven to scripts wherever possible; next best is cheap models (primarily DeepSeek)" — made concrete, per-procedure, with the existing 3 codebases as the foundation.

---

# PART 3 — SYNTHESIS

## 3a. Other improvements (beyond the user's list)

1. **Lint the skillset itself (would have caught Q1) — DONE 2026-06-11.** **SHIPPED** as `tools/dev-pipeline/lint_skills.py`: **R1** fails the build on a re-introduced stale `build_pianoid_cuda.bat … --heavy --release`; **R2** fails on the agent-context-destructive `cmd //c "…build_pianoid_cuda…--heavy"` form *without* `--both` (the venv-bricker) — and correctly does NOT flag the legitimate interactive `… --heavy --both` line (`update-pianoid.md:216`) via a `--both` discriminator; **R3** advisory-flags a prose block duplicated across >1 skill. **Verified:** clean against the post-Part-A tree (exit 0, R1/R2 = 0), with a file-based negative test confirming R1+R2 fire on the bad forms. This is the **can't-recur guard** the user's 2026-06-11 directive asked for (the 11-skill build-command drift is now a CI failure, not a silent regression). Paired with the operational-facts SSOT `docs/PROJECT_CONFIG.md` (skills reference its `#docs-first-build--run` anchor instead of inlining). **The single highest-leverage robustness win — and now in place.**

2. **Kill the dead text now (cheap, in-place).** Remove the three "SendMessage is NOT available" passages from `orchestrator.md` (Q2) — they actively misdirect agents into wasteful respawns. De-duplicate the docs-first preamble and the port-sweep into single references (Q4/Q5). These are in-place fixes that improve the *current* skillset before any extraction, and they de-risk the extraction.

3. **The "team config bloat" problem.** The orchestrator's permission model requires a blanket-allow list in `settings.local.json`, and the failure-mode catalogue is the standing evidence that *pre-allowing specific patterns is whack-a-mole*. The generic kit should ship the blanket-allow as a generated artifact of `devkit init` (both shells + core tools + MCP), documented as *the* model, so no project re-discovers the whack-a-mole trap. (This also fixes the latent issue that `settings.local.json` is machine-local/gitignored — the kit should template it and document that the user regenerates it per machine via `devkit init`/`doctor`.)

4. **Observability beyond the controller.** With the supervisor (2c) capturing all I/O, add a lightweight **session-replay / metrics** view: per-`/dev`-session token cost, tier breakdown (script vs cheap-model vs frontier turns), stall events, verification-evidence index. This makes the cost-model real-time rather than a retrospective proposal, and lets the user *see* the tiering payoff.

5. **A capability-aware test matrix in CI.** Generalize `diagnose` Phase-0 into a `devkit doctor --ci` that, on each runner, reports which verification surfaces are reachable and **skips-with-a-loud-marker** (never silently) the ones that aren't — so a GPU-less CI run says "synthesis-render surface BLOCKED here" rather than green-washing.

6. **Cross-platform parity as a first-class concern.** The Windows/Linux path table + the OS-specific binary flags are already a pattern in `CLAUDE.md`; the kit's `project.devkit.toml` should make OS resolution explicit (interpreter path, process-kill mechanism, build invocation) so a project is portable by construction rather than by scattered inline caveats.

7. **Document the "investigation -> implementation handoff" rule as a first-class generic principle.** The `CLAUDE.md` rule ("a hypothesis drives *measurement*, never a *code edit*, until confirmed") is one of the deepest lessons in the whole corpus and is currently buried in Auto-Trigger Rules. Promote it to a top-level tenet in `rules/CLAUDE.core.md` — it pairs naturally with the Verification Gate (2d) and the Data Model Card.

8. **Skill discoverability.** Reduce the UI-skill trichotomy confusion (`test-ui`/`diagnose`/`pianoid-ui`) by making `/verify` the single generic entry that *routes* to the right surface from the `verify_surface` table, so a newcomer invokes one skill and the routing is data-driven, not a manual choice among three similarly-named skills.

## 3b. Phased roadmap (quick wins -> full release)

| Phase | Scope | Depends on | Effort | Payoff |
|---|---|---|---|---|
| **P0 — De-drift + single-point-of-truth (DONE 2026-06-11 — applied + verified)** | **SHIPPED:** (A) the **8 de-drift edits across 7 skills** (the dangerous `--heavy --release` / `cmd //c …--heavy` build form → `--heavy --both` detached, pointing at `BUILD_SYSTEM.md#canonical-install--rebuild`); (B) **`docs/PROJECT_CONFIG.md`** — the operational-facts SSOT (anchors: ports/roles, interpreters, repos+branches, defaults, rest-endpoints, rebuild-matrix, doc-hierarchy, verification-surfaces, process-sweep, **`#docs-first-build--run`**); (C) the **9-skill docs-first preamble collapse → the SSOT pointer** (dev, fn, multitask, analyse, test-ui, update-pianoid, diagnose, startup, pianoid-ui); (D) **`tools/dev-pipeline/lint_skills.py`** — the forbidden-form drift lint (R1/R2 fail-build, R3 advisory). **VERIFIED:** lint exit 0 / R1–R2 = 0 (legit `update-pianoid:216` not flagged); all 9 skills reference the SSOT anchor; a dev.md off-by-one (a duplicated `/startup` line) was caught + fixed during apply. Port-sweep → `env_sweep.py` reference swaps DEFERRED to P1 (latent, not hazardous; different change class). Spec: `D:\tmp\skillset-review\{p0-dedrift-ssot-spec,p1-preamble-collapse-spec}.md`. | none | **Low** (days) | Fixed the active venv-brick hazard; made the drift structurally unable to recur; de-risked + seeded P1. **Highest ROI — delivered.** |
| **P1 — Comprehensive in-place generic/project separation** (DESIGN COMPLETE 2026-06-11; execution PENDING) | **Re-scoped to IN-PLACE (ii) stage-in-repo-first** per the user (no new repo yet — D10 deferred). DONE: `docs/PROJECT_CONFIG.md` (complete 17-anchor project-config SSOT), `docs/development/GENERIC_CORE_MANIFEST.md` (lift-list), the `DEVKIT_PROJECT_ROOT` script alias. DESIGNED + apply-ready (spec at `D:\tmp\skillset-review\p2-ii-separation-spec.md`): create `.claude/CLAUDE.generic.md` (project-agnostic rules, `@`-imported) + thin `.claude/CLAUDE.md` + tier-tag (`tier: generic|project`) + the ~45 per-skill agnostic edits (every Pianoid fact → `$PROJECT_ROOT/docs/PROJECT_CONFIG.md#anchor`) + the multi-project `PROJECT_ROOT` dispatch binding + the grep-gate. PENDING: applying the gated `.claude/` edits. **Later, separately-approved step:** the physical **hoist** of the `tier: generic` core to `~/.claude/` (the shared layer for true multi-project) + the public-kit extraction (`agentkit` repo, `devkit init` wizard, `{{placeholder}}` parameterization). Full plan: `docs/proposals/generic-project-separation-plan-2026-06-11.md`. | P0 | **Medium-High** (2–3 wk) | A clean generic/project boundary in-place (the methodology genuinely project-agnostic + grep-gate-proven liftable); Pianoid stays the dogfood; the hoist + public release follow. |
| **P2 — Supervisor app + I/O control** | Build the standalone supervisor (2c Option C): channel adapter + transcript capture first (alongside current orchestrator), then subprocess ownership (`claude -p` stream-json), then retire `cli_control.ps1` + the channel monkey-patches | P1 (skills must be channel-agnostic) | **Medium-High** (2–3 wk) | Eliminates reload-kill, invisible-prompt, stdio-drift; gives the user full programmatic I/O + remote control. |
| **P3 — Verification Gate + capability matrix** | Generalize audio-routing -> `verify_surface`; add the structural Verification Gate (controller Tier-3 + `verify_phase1.py` fail-closed + evidence artifacts, 2d); build `capability_probe.py` + `devkit doctor` + the runtime `[CAP-GAP]` loop (2e) | P1 (config schema), benefits from P2 (supervisor relays prompts) | **Medium** (1–2 wk) | "Test yourself" becomes structurally enforced + honest about env gaps. |
| **P4 — Complete the tier migration** | Split the Controller into `controller_core.py` (script booleans) + a gated cheap-model judgment layer; move Doc-First check + per-agent invariants to script; add `merge_sweep.py`; wire the supervisor-based marker hook (now unblocked by P2) | P2 (marker hook needs the supervisor I/O bus), P1 (tiering doctrine) | **Medium** (1–2 wk) | The Controller/Monitors move off frontier to script+cheap-model — the user's explicit cost target, realized. |
| **P5 — Public open-source release** | License (decision), README/onboarding, CHANGELOG/semver, `pipx` packaging, `examples/pianoid/`, contribution guide, the kit's own CI (lint + tests + capability-aware matrix) | P1–P4 | **Medium** (1–2 wk) | Robust, consistent, intuitive, self-testing public kit. |

**Sequencing rationale:** P0 is free and fixes live bugs — ship it regardless of the rest. P1 is the backbone everything else composes on. P2 (the app) and P3 (the gate) are independent after P1 and can run in parallel. P4 depends on P2 (the marker hook). P5 is the wrap. P0–P1 alone deliver most of the open-sourcing value; P2 is the biggest single user-facing improvement (the app); P3+P4 are the "test-yourself + cheap-model" deepening.

## 3c. Decisions (locked 2026-06-11)

All 11 decision points are **LOCKED** — this is the chosen direction, not open options. Recorded with rationale; the rest of the doc reflects these.

**P1-separation decisions (added 2026-06-11, in the dedicated plan `generic-project-separation-plan-2026-06-11.md`):** **DP-1 = (ii) stage-in-repo-first** (in-place separation now; the physical hoist to `~/.claude/` is a later deliberate step) · **DP-3 = comprehensive** (all fact-classes factored to `PROJECT_CONFIG.md`) · **DP-4 = port-sweep → `env_sweep.py`** in scope · **DP-8 = `test-ui` stays project-level this pass** (generalize to the verify path later — and NOT named `/verify`, which is a built-in) · **DP-11 = graceful-no-config fallback** (a generic skill run with no `PROJECT_CONFIG.md` prompts the user / falls back to detected generics, never assumes another project's facts). The multi-project guarantee rests on a new hard rule: the orchestrator passes an explicit `PROJECT_ROOT` in every dispatch (per-subagent cwd is unshipped in Claude Code).

| # | Decision | LOCKED choice | Rationale |
|---|---|---|---|
| **D1** | Open-source scope | **Full kit + pluggable everywhere** | Ship the whole methodology (no held-back parts); the cheap-model, channel, and codegen layers are all pluggable interfaces so the kit is provider-agnostic. The value is in the whole. |
| **D2** | Orchestrator form-factor (§2c) | **C — standalone supervisor process** owning the Claude Code CLI subprocess (stream-json I/O) | The only form-factor that delivers literal full programmatic I/O control + survives reloads + dissolves the invisible-prompt/stdio-drift classes. A ("stay-in-CLI") and B ("plugin") are documented as *alternatives considered* (§2c) and remain fallbacks. |
| **D3** | License | **MIT** | Maximizes adoption of a methodology/tooling kit. |
| **D4** | Package name | **DEFERRED** (front-runner *AFKode*; placeholder used in the doc) | Naming is still open — registries checked: `hammock`, `offleash`, `codenomad` all collide. `AFKode` is the current front-runner; a final name is a later call. (Doc uses a working placeholder where a name is needed.) |
| **D5** | Control channel(s) | **CLI + Telegram core; pluggable channel adapter** (Slack/web/etc. via the adapter) | Telegram is the proven remote channel; CLI is the local default; everything else plugs into the supervisor's adapter (D2). |
| **D6** | Cheap-model provider | **Pluggable interface; DeepSeek = reference/default** | Don't hard-wire one provider. DeepSeek is the validated default (the ~300× routine-codegen result), but the tier is an interface so any cheap model can back it. |
| **D7** | P0 de-drift + SSOT now? | **DONE 2026-06-11** (applied + verified) | Shipped: 8 de-drift edits / 7 skills + `docs/PROJECT_CONFIG.md` (SSOT) + 9-skill preamble collapse to its `#docs-first-build--run` anchor + `tools/dev-pipeline/lint_skills.py` (R1/R2 fail-build, R3 advisory). Verified clean (lint exit 0; legit `update-pianoid:216` not flagged). Fixed the active venv-brick hazard; the SSOT + lint make the drift unable to recur. Port-sweep→`env_sweep.py` swaps deferred to P1. (Specs: `D:\tmp\skillset-review\{p0-dedrift-ssot-spec,p1-preamble-collapse-spec}.md`.) |
| **D8** | Personal-assistant skills | **EXCLUDE the skills; KEEP MCP as pluggable functionality** | The specific email/WhatsApp/gcal *skills* don't ship (separate concern, live in `claude-config`). The **generic MCP extension mechanism stays** — the kit supports adding MCP servers as pluggable functionality; it just doesn't bundle the personal ones. |
| **D9** | Public reference example | **Sanitized generic example; Pianoid stays private dogfood** | `examples/` ships a clean generic project, not Pianoid. Pianoid remains the private proving ground (regenerated from its own `project.devkit.toml` to validate the generic/project split). |
| **D10** | Where the kit lives | **New dedicated public repo** | Clean separation from personal `claude-config`; its own CI (lint + tests + capability-aware matrix). |
| **D11** | Verification-Gate strictness (§2d) | **Warn-first → graduate to enforce** | Ship the gate as a non-blocking warn for an initial window, then harden to a fail-closed halt. Matches the project's incident-driven tightening style — prove the gate is right before making it hard. |

---

## Appendix — method & evidence

- **Coverage:** every one of the 20 project skills + 6 user skills was read in full or (for the 3 largest project-specific ones: `diagnose`, `pianoid-ui` beyond headers) classified from header + structure; both `CLAUDE.md` rule-sets, `CONTROLLER.md`, both tooling READMEs, the `core.py` gate, and the cost-model proposal were read in full; `~/claude-config` + `self-update.md` establish the existing distribution model.
- **Classified extracts (scratch, not committed):** `D:\tmp\skillset-review\extract-orchestrator.md`, `extract-dev.md`, `extract-fn-multitask.md`, `extract-auxiliary-ops.md`, `extract-tooling-config.md`.
- **The drift finding (Q1) is mechanically verifiable:** grep `--heavy --release` vs `--heavy --both` across `.claude/commands/*.md` + `CLAUDE.md` reproduces the 7-vs-4 split cited in 1b.
- **Cost-model figures** (~65% cache, ~$0.15 spawn tax, N-worker loss, ~300× DeepSeek saving) are quoted from `docs/proposals/minimize-opus-calls-dev-pipeline-2026-06-06.md` + the `deepseek-codegen-mcp/README.md` + memory (`project_synthds_ab_optimized_rerun_2026-06-07`), not re-derived here.
- **This document made no code/skill/source changes** and committed nothing — it is a proposal for the user/orchestrator to review.
