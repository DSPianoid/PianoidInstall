# Generic-Core Manifest — the lift-list

**Date:** 2026-06-11 · **Status:** classification reference (placement-independent).
**Purpose:** The per-artifact GENERIC / HYBRID / PROJECT-SPECIFIC classification of the Pianoid agentic-dev skillset, and where each piece goes when the generic core is separated out. This is the document a future "lift" reads to know exactly **what is the reusable methodology (liftable)** vs **what is Pianoid-specific (stays with the project)**.

**Companion to:** `docs/proposals/generic-project-separation-plan-2026-06-11.md` (the separation plan + the multi-project / hoist addenda) and `docs/proposals/generic-dev-skillset-opensource-2026-06-11.md` (Part 1c classification, the open-source kit design).

> **"Lifts to" column — placement is being decided** (DP-1: (i) hoist to user-level `~/.claude/` now, or (ii) stage in-repo `generic-core/` first). The classification below is the SAME either way. The destination is written as **`<GENERIC>/...`**, which resolves to:
> - **(i)** `<GENERIC>` = `~/.claude/` (user level — shared across every project immediately), mirrored in `~/claude-config` for `/self-update` distribution; and eventually `agentkit/` (the public repo).
> - **(ii)** `<GENERIC>` = `<repo>/generic-core/` (a distinct in-repo unit), hoisted to `~/.claude/` later.
>
> Either way, **PROJECT** artifacts stay at `<repo>/` (the project layer).

---

## Legend

- **GENERIC** — reusable in any software project; the methodology. Lifts verbatim or with only `{{placeholder}}` / config-reference parameterization.
- **HYBRID** — generic skeleton + project-specific parameters. The *body* lifts (generic); the *parameters* factor out to the project's `docs/PROJECT_CONFIG.md`. These are the bulk of the work — each needs its Pianoid hardcodes replaced by active-project config references before it can lift.
- **PROJECT** — Pianoid-specific; stays at the project level. Its *structure* may be a useful template in the kit, but its content does not lift.
- **PROJECT (template)** — stays, but its shape becomes an `examples/` / `templates/` reference in the kit.

---

## 1. Skills (`.claude/commands/*.md`)

| Skill | LOC | Class | Lifts to | Project params it resolves (from `PROJECT_CONFIG.md`) |
|---|---:|---|---|---|
| **review** | 491 | **GENERIC** | `<GENERIC>/commands/review.md` | layer names, ports (server audit), terminology table, `cuda_lock` → `#repos`/`#ports` + a project "layers/terminology" note |
| **dev** | 1288 | **HYBRID** | `<GENERIC>/commands/dev.md` | build, venv, ports, test paths, verification-surfaces, doc-hierarchy, key-paths, port-sweep, repos → `#docs-first-build--run` `#interpreters` `#ports` `#verification-surfaces` `#doc-hierarchy` `#key-paths` `#repos` |
| **multitask** | 325 | **HYBRID** | `<GENERIC>/commands/multitask.md` | layer→repo table, build cmds, "one compiler at a time", ports, test paths → `#repos` `#docs-first-build--run` `#ports` |
| **fn** | 300 | **HYBRID** | `<GENERIC>/commands/fn.md` | build, venv, test runner, key-paths → `#docs-first-build--run` `#interpreters` `#key-paths` |
| **orchestrator** | 1200 | **HYBRID** | `<GENERIC>/commands/orchestrator.md` | the channel, ports, repos+branches, build, holders, doc paths, voice STT/TTS, team, port-sweep → `#channel` `#ports` `#repos` `#build-holders` `#team` + the project registry + per-dispatch `PROJECT_ROOT` binding (multi-project) |
| **sync** | 214 | **HYBRID** | `<GENERIC>/commands/sync.md` | 4-repo map+branches, rebuild cmds, smoke endpoint → `#repos` `#rebuild-matrix` `#rest-endpoints` |
| **analyse** | 304 | **HYBRID** | `<GENERIC>/commands/analyse.md` | layer names, terminology, REST, audio-pipeline perf criteria, key-paths → `#repos` `#rest-endpoints` `#verification-surfaces` `#key-paths` |
| **update-docs** | 166 | **HYBRID** | `<GENERIC>/commands/update-docs.md` | doc tree paths, module names → `#doc-hierarchy` |
| **cli-control** | 94 | **HYBRID** | `<GENERIC>/commands/cli-control.md` | the editor window title, transcript path, `/orchestrator start` cmd → `#channel` + active-project |
| **test-ui** | 320 | **HYBRID** | `<GENERIC>/commands/verify.md` *(as generic `/verify`)* OR stays PROJECT this pass | chrome-devtools, `note_playback`, MUI chips, ports, hotkeys, WAV-decode → `#verification-surfaces` `#ports` `#frontend-stack`. **DP-8: most project-entangled "generic" skill — recommended to keep PROJECT-level this pass and hoist as `/verify` later.** |
| **update-pianoid** | 294 | **PROJECT** | stays `<repo>/.claude/commands/` | names the 4 repos, build flags, required-MCP list, Node version — too project-bound to lift now; unique name (no clash). Generalize to a `/update-project` later. |
| **diagnose** | 1111 | **PROJECT (template)** | stays `<repo>/.claude/commands/`; shape → `agentkit/templates/diagnose.md.example` | the whole 8-phase Pianoid diagnostic (mic/Goertzel/drivers/REST). Liftable *structure*: Phase-0 commit gate, `-fix` auto-repair loop, sequential layer verification. |
| **pianoid-ui** | 429 | **PROJECT (template)** | stays; shape → `agentkit/templates/ui-control.md.example` | chrome + Pianoid REST map + MUI. Liftable *principle*: UI-only interaction. |
| **startup** | 318 | **PROJECT (template)** | stays; shape → `agentkit/templates/startup.md.example` | the whole Pianoid install/build/toolchain knowledge base. Liftable *structure*: docs-first → classify → verify-with-smoke-test. |

## 2. User-level / personal skills (`~/.claude/commands/`, synced from `~/claude-config/`)

| Skill | Class | Disposition |
|---|---|---|
| **self-update** | **GENERIC (infra)** | already user-level; the distribution+sync mechanism. Needs a small edit to also sync the new generic CLAUDE.md + CONTROLLER + tools (see plan B6). |
| setup-mcp / setup-google-workspace / setup-hostinger-email / pair-whatsapp / project-management / investigate / setup-openai-gate | **OUT OF SCOPE** (personal infra/productivity) | NOT part of the dev-kit (D8). Stay in `~/claude-config`. The generic **MCP extension mechanism** stays (a project can add MCP servers); the specific personal ones don't ship in the kit. |

## 3. Rule docs (`CLAUDE.md`)

`.claude/CLAUDE.md` (project) — 13 `##` sections. Split: the GENERIC methodology rules lift to `<GENERIC>/CLAUDE.md` (user-level / generic-core); the PROJECT rules stay at `<repo>/.claude/CLAUDE.md` (with a "these override user-level on conflict" precedence header).

| § | Section | Class | Lifts to |
|---|---|---|---|
| 1 | Orchestrator Sub-Agent Permission Rule + Known gaps | **HYBRID** | generic lesson + failure-mode catalogue → `<GENERIC>/CLAUDE.md`; `pianoid-dev`/`Start-Process`/port-3001 → `#team`/`#channel`/`#ports` |
| 2 | Repository Roots & Path Convention | **HYBRID** | generic convention → `<GENERIC>/CLAUDE.md`; the paths → `#repos`/`#interpreters` |
| 3 | Auto-Trigger Rules | **GENERIC** | `<GENERIC>/CLAUDE.md` (the `.cu/.cpp/...` token → a project "compiled-langs" config note) |
| 4 | UI Interaction Rule | **PROJECT** | `<repo>/.claude/CLAUDE.md` (names `/pianoid-ui`) |
| 5 | Audio Verification Rule | **HYBRID** → generalizes to **Verification-Surface Rule** | generic rule → `<GENERIC>/CLAUDE.md`; audio_on/off + mic + `note_playback` → `#verification-surfaces` |
| 6 | Backend Startup Rule | **PROJECT** | `<repo>/.claude/CLAUDE.md` (refs launcher/REST + `#defaults`) |
| 7 | Documentation-First Rule | **GENERIC** | rule → `<GENERIC>/CLAUDE.md`; doc paths + high-stakes fact categories → `#doc-hierarchy` + `#data-model-facts` |
| 8 | Startup & Build Failure Rule | **PROJECT** | `<repo>/.claude/CLAUDE.md` (names `start-pianoid.bat`/`/startup`) |
| 9 | Build & Environment Problems | **PROJECT** | `<repo>/.claude/CLAUDE.md` / `#docs-first-build--run` |
| 10 | Documentation Links | **HYBRID** | generic convention → `<GENERIC>/CLAUDE.md`; `localhost:8001` + nav → project |
| 11 | Key Paths | **PROJECT** | `#key-paths` |
| 12 | Frontend UI Standards | **PROJECT** | `#frontend-stack` |
| 13 | Self-Update Rule | **GENERIC (infra)** | `<GENERIC>/CLAUDE.md` |

`~/.claude/CLAUDE.md` (user) — already user-level; the generic dev-methodology rules append below the existing personal notes.

## 4. Tooling & controller

| Artifact | Class | Lifts to | Notes |
|---|---|---|---|
| `tools/dev-pipeline/*` (dev_init, dev_wrap_phase2, env_sweep, verify_phase1, run_perf, build_pianoid, dev_commit, common) | **GENERIC** (params via env/flags) | `<GENERIC>/tools/dev-pipeline/` (DP-9) | already resolve the repo root via `PIANOID_REPO_ROOT` env → rename convention to `DEVKIT_PROJECT_ROOT` (accept both). `build_pianoid.py`/`run_perf.py` take the build/test cmd as args. 145 tests. |
| `tools/dev-pipeline/lint_skills.py` | **GENERIC** | `<GENERIC>/tools/dev-pipeline/` | the forbidden-build-form + dup-block lint. Patterns (`--heavy --release`, `cmd //c …--heavy`) are Pianoid-flavored but the mechanism is generic; parameterize the patterns per project later. |
| `tools/deepseek-codegen-mcp/*` (core, server, batch_pipeline + tests) | **GENERIC** (cheap-model adapter) | `<GENERIC>/adapters/codegen/deepseek/` | already a clean interface (spec+test → body). No Pianoid coupling. |
| `docs/development/CONTROLLER.md` | **GENERIC** | `<GENERIC>/CONTROLLER.md` (or `<GENERIC>/rules/controller.md`) | the read-only compliance-monitor spec + marker grammar. Project-agnostic. |
| `tools/cli_control.ps1` | **HYBRID** | `<GENERIC>/tools/` | the keystroke-control mechanism is generic; the VS Code window title + transcript path are project/machine → `#channel`. |
| `tools/apply_telegram_patch.py` / `apply_telegram_voice_patch.py` / `transcribe_voice.py` / `tts_voice.py` | **HYBRID (channel adapter)** | `<GENERIC>/adapters/channels/telegram/` | the Telegram channel adapter (the eventual supervisor's channel layer). Generic mechanism, Telegram-specific. |
| `tools/kill_pianoid.ps1` / `clean_and_start.ps1` | **PROJECT** | stays | Pianoid env ops (superseded by `env_sweep.py` for the kill). |

## 5. Project config + state (all PROJECT — by definition per-project)

| Artifact | Class | Notes |
|---|---|---|
| `docs/PROJECT_CONFIG.md` | **PROJECT** | the complete project-config SSOT (this project's facts). NOT lifted; the `init` wizard *generates* one per project. It IS the params the HYBRID skills resolve. |
| `docs/development/MODULE_LOCKS.md`, `WORK_IN_PROGRESS.md`, `logs/` | **PROJECT** | per-project workflow state (the generic skills create/consume these under the active `PROJECT_ROOT`). |
| `docs/development/CODE_QUALITY.md` | **HYBRID** | the P1/P2/C4/S5 principles are generic (could lift to the kit as the review rubric's basis); the God-Objects list + entity tables are Pianoid. |
| `docs/**` (architecture, modules, guides), synthesis source, `PianoidCore/.venv`, presets, etc. | **PROJECT** | all Pianoid. |

---

## 6. Headline split

| Bucket | Count (skills) | Examples |
|---|---|---|
| **GENERIC** (lift ~verbatim + config refs) | 1 skill + self-update + CONTROLLER + dev-pipeline + deepseek-adapter + ~5 CLAUDE.md sections | review; the methodology rules; the tooling |
| **HYBRID** (generic body + project params → config) | 9 skills + ~4 CLAUDE.md sections | dev, fn, multitask, orchestrator, sync, analyse, update-docs, cli-control, test-ui |
| **PROJECT** (stays; some as kit templates) | 4 skills + ~4 CLAUDE.md sections + PROJECT_CONFIG + state | diagnose, pianoid-ui, startup, update-pianoid |

**The HYBRID bucket is the work:** each HYBRID skill must have its Pianoid hardcodes replaced by active-project `PROJECT_CONFIG.md#anchor` references (the `$PROJECT_ROOT/docs/PROJECT_CONFIG.md` resolution) before it can lift. That edit-set is delivered as the apply-ready change-set once placement (i)/(ii) is confirmed. PROJECT_CONFIG.md (H1, complete) is the target every HYBRID resolves against.

> **Liftability note:** the generic core is liftable *as a unit* once the HYBRID skills are project-agnostic. Under (i) the unit lives at `~/.claude/` + `~/claude-config` (synced via `/self-update`); under (ii) at `<repo>/generic-core/` then hoisted. The public-release split into a dedicated `agentkit` repo (D10) is a later, separate step.
