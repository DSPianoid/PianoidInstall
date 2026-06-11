# Comprehensive In-Place Generic / Project Separation — Plan & Structural Design

**Date:** 2026-06-11 · **Author:** skillset-arch · **For:** team-lead → user review before execution.
**Directive (user, 2026-06-11):** *"Make comprehensive separation to generic and project-specific inside pianos, do not create new repo as yet."* — Execute the proposal's P1 generic/project separation **IN-PLACE** within the Pianoid repo. **NO new public repo** (D10 deferred). Goal: a clear, comprehensive in-place separation so the generic methodology is cleanly delineated from Pianoid-specifics and **liftable** to the public repo later.
**Status:** PLAN + structural design only. No `.claude/` edits applied (gated — team-lead applies the change-set), no commits.
**Builds on:** `docs/proposals/generic-dev-skillset-opensource-2026-06-11.md` (the parent proposal; Part 1c classification, Part 2a/2b kit design) and the now-shipped P0 SSOT (`docs/PROJECT_CONFIG.md` + `tools/dev-pipeline/lint_skills.py`).

---

## 0. Objective & principle

Make the generic methodology (the `/dev` workflow, orchestrator, controller, multitask, fn, review, the marker grammar, lock model, tiering, cost model) **physically separable** from Pianoid specifics (CUDA build, ports, REST, ASIO/audio, the 4-repo layout, venv paths) **inside the current repo**, with a single document that lists exactly what is liftable. After this work:

- a reader can point at **one set of files** and say "this is the generic kit" and **another set** and say "this is Pianoid's config";
- every skill body is **generic prose + references to the project config** — no project fact is inlined twice;
- lifting to the public repo later = copy the generic set + run the (already-designed) `init` wizard to regenerate the project layer. No re-discovery.

**The guiding rule (from P0, now applied comprehensively):** *every project-specific fact lives in exactly ONE place; generic text references it.* P0 did this for the build command + the docs-first preamble; this plan extends it to **all** project facts (venv, ports, repos, REST, preset, doc-hierarchy, the port-sweep, audio routing) and to **CLAUDE.md** itself.

---

## PART 1 — THE GENERIC / PROJECT BOUNDARY (definitive)

### 1.1 Per-skill classification (from Part 1c, made actionable)

| Skill | Class | Generic core (liftable body) | Project-specific fields that factor out → `PROJECT_CONFIG.md` |
|---|---|---|---|
| **review** | **GENERIC** | the entire 3-level rubric, severity matrix, confidence scoring, P1/P2 audit, S5 hunt, C4 LOC gate, required output sections | layer names, ports 5000/5001 (server audit), terminology table, `cuda_lock`, the grep file-globs |
| **dev** | **HYBRID** | the 10-step workflow + 5 exit procedures + marker grammar + lock model + Data Model Card + context-hygiene + folder taxonomy | build cmd, venv interpreter, ports, test paths (baseline/perf), audio-verification routing, doc-hierarchy, the port-sweep, repo roots |
| **multitask** | **HYBRID** | conflict-matrix + graph-coloring wave scheduler + parallel-spawn + per-wave-test + post-wave-merge | layer→repo table, build cmds, "one compiler at a time", ports, test paths |
| **fn** | **HYBRID** | input contract + single-fn workflow + marker discipline + context-hygiene + cheap-model delegation + dual-backend rule + parent-lock inheritance | build cmd, venv interpreter, test runner |
| **orchestrator** | **HYBRID** | autonomy principle, no-direct-skill-exec, agent lifecycle state-machine, conflict resolution, queue review, full-clearance, stall recovery, worktree rule, merge-sweep, controller integration | the channel (Telegram), ports, repo names+branches, build cmd, `.pyd`/DLL holder names, doc paths, voice STT/TTS, the port-sweep |
| **test-ui** | **HYBRID** | crash-logging discipline, measure-via-deterministic-surface, UI-only interaction, every-claim-a-number, mandatory cleanup, 7-phase shape | chrome-devtools MCP, `note_playback`, MUI chips, ports, hotkeys, the WAV-decode snippet, the port-sweep |
| **sync** | **HYBRID** | change-analysis → conflict-detect → branch-check → doc-gap → commit → rebuild-gate (L1+L2) → push; no-force-push | 4-repo map+branches, rebuild cmds, the smoke endpoint |
| **analyse** | **HYBRID** | docs-audit-first, 9-axis quality assessment, health-summary + improvement + test-proposal templates | layer names, terminology, REST, audio-pipeline perf criteria |
| **update-docs** | **HYBRID** | change→section mapping, lean-style rules, Mermaid/SVG, infographic-sync | doc tree paths, module names |
| **update-pianoid** | **HYBRID** | fetch → smart-rebuild decision-matrix → pull → skill-sync → rebuild → doc-update → report; venv isolation; rebuild-gate | 4 repos, build cmds, required-MCP list, Node version, the smoke endpoint |
| **cli-control** | **HYBRID** | keystroke-drive the coordinator's own CLI, remote clear+relaunch via detached process, release stuck prompt, receipt-verify via transcript-tail | the editor window title, transcript path, `/orchestrator start` cmd |
| **diagnose** | **PROJECT-SPECIFIC** | (liftable *structure* only: Phase-0 commit gate, `-fix` auto-repair loop, sequential layer verification, audio parametric) | all 8 phases (mic loopback, Goertzel transferRatio, drivers, REST) are Pianoid → becomes a TEMPLATE in the kit |
| **pianoid-ui** | **PROJECT-SPECIFIC** | (liftable *principle* only: UI-only interaction) | chrome-devtools, the full REST map, MUI, ports → TEMPLATE |
| **startup** | **PROJECT-SPECIFIC** | (liftable *structure* only: docs-first, classify→branch, verify-with-smoke-test) | the entire knowledge base (toolchain, CUDA, ASIO/SDL, ports, REST params) → TEMPLATE |
| **self-update** | **GENERIC (infra)** | the distribution+sync model (pull repo → sync skills+MCP+memory, merge MCP preserving creds) | the repo URL |
| setup-mcp / setup-* / pair-whatsapp / project-management | **OUT OF SCOPE** (personal infra) | — | live in `claude-config`, not the dev-kit (D8) |

### 1.2 Per-CLAUDE.md-section classification (the split surface)

`CLAUDE.md` has 13 `##` sections (296 lines). Classified:

| § | Section | Class | Disposition |
|---|---|---|---|
| 1 | Orchestrator Sub-Agent Permission Rule + Known gaps | **HYBRID** | generic *lesson* (sub-agents run permission-suppressed; blanket-allow both shells; the failure-mode catalogue) → `CLAUDE.generic.md`; the `pianoid-dev` team name + exact `Start-Process` form + port 3001 → `PROJECT_CONFIG.md` |
| 2 | Repository Roots & Path Convention | **HYBRID** | generic *convention* (repo-relative paths, flag OS-specific binaries) → generic; the Win/Linux paths + `.venv/Scripts` vs `bin` → `PROJECT_CONFIG.md#repos`/`#interpreters` |
| 3 | Auto-Trigger Rules | **GENERIC** | → `CLAUDE.generic.md` (the `.cu/.cpp/.cuh/.h/setup.py` list is the one project token → a config ref) |
| 4 | UI Interaction Rule | **PROJECT** | → project section (it names `/pianoid-ui`) |
| 5 | Audio Verification Rule | **HYBRID** → generalizes to **Verification-Surface Rule** | generic rule → generic; the audio_on/off + mic-loopback + `note_playback` → `PROJECT_CONFIG.md#verification-surfaces` |
| 6 | Backend Startup Rule | **PROJECT** | → project section (refs the launcher/REST docs + default preset → `PROJECT_CONFIG.md`) |
| 7 | Documentation-First Rule | **GENERIC** | the rule → generic; the doc-lookup-order paths + the high-stakes data-model fact categories (axis/unit/index) → `PROJECT_CONFIG.md#doc-hierarchy` + a project "data-model facts" note |
| 8 | Startup & Build Failure Rule | **PROJECT** | → project section (names `start-pianoid.bat` / `/startup`) |
| 9 | Build & Environment Problems | **PROJECT** | → project section / already mostly references `BUILD_SYSTEM.md`; the quick-ref block → `PROJECT_CONFIG.md#docs-first-build--run` |
| 10 | Documentation Links | **HYBRID** | generic convention (link docs by their served URL) → generic; the `localhost:8001` + nav specifics → project |
| 11 | Key Paths | **PROJECT** | → `PROJECT_CONFIG.md` (it IS a project-fact table) |
| 12 | Frontend UI Standards | **PROJECT** | → project section (MUI/ECharts/mosaic — all Pianoid stack) |
| 13 | Self-Update Rule | **GENERIC (infra)** | → generic |

**Headline:** ~5 sections are GENERIC, ~4 HYBRID (generic rule + project params), ~4 PROJECT-SPECIFIC. The generic ones + the generic halves of the hybrids are the liftable methodology rules.

---

## PART 2 — IN-PLACE STRUCTURE (how the separation is represented WITHOUT a new repo)

### 2.1 The four structural pillars

```
docs/
  PROJECT_CONFIG.md                  # (a) THE COMPLETE project-config SSOT — every project-specific fact
  development/
    GENERIC_CORE_MANIFEST.md         # (d) THE LIFT-LIST — what is generic (liftable) vs project (stays)
.claude/
  CLAUDE.md                          # loaded entry point — thin: includes/links the two below
  CLAUDE.generic.md                  # (b) generic methodology rules (liftable)
  CLAUDE.project.md                  # (b) Pianoid-specific rules — facts point to PROJECT_CONFIG.md
  commands/*.md                      # (c) each skill = generic body + references to the config (no inlined project facts)
```

### 2.2 (a) `PROJECT_CONFIG.md` = the COMPLETE project-config SSOT

Already seeded by P0 with 10 anchors. **Expand it to hold EVERY project-specific fact** so a skill never inlines one. Add/confirm these anchors (★ = new in this phase):

`#ports` · `#interpreters` · `#repos` · `#defaults` · `#rest-endpoints` · `#rebuild-matrix` · `#doc-hierarchy` · `#verification-surfaces` · `#process-sweep` · `#docs-first-build--run` (all exist) **+** ★`#key-paths` (the consolidated path table — PianoidCore/Basic/Tunner, tests, logs, MODULE_LOCKS, venv) · ★`#data-model-facts` (the high-stakes axis/unit/index categories from CLAUDE.md §7) · ★`#frontend-stack` (MUI v6 / ECharts / mosaic / NumInput rules — the §12 content) · ★`#channel` (Telegram + voice STT/TTS specifics) · ★`#build-holders` (`pianoidCuda.*.pyd` / `cudart64_12.dll` names) · ★`#midi-listener-flag` and any other "named project constant" referenced by >1 skill.

> Every fact a skill needs becomes a `PROJECT_CONFIG.md#anchor`. The lint (`lint_skills.py` R3) already flags re-inlined blocks; after this phase the R3 advisories for the path-table + port-loop should drop to zero.

### 2.3 (b) `CLAUDE.md` separation — RECOMMENDED: two companion files + a thin loaded entry

**Options considered:**

| Option | Shape | Verdict |
|---|---|---|
| **B-1 — single file, sectioned** | one `CLAUDE.md` with a hard `# ── GENERIC METHODOLOGY ──` / `# ── PROJECT-SPECIFIC (Pianoid) ──` divider | Lowest effort; keeps everything loaded. BUT "liftable" means a human still has to *extract* the generic half later → not physically separable. |
| **B-2 — two companion files (`CLAUDE.generic.md` + `CLAUDE.project.md`), `CLAUDE.md` includes both** | `CLAUDE.md` becomes a 5-line entry that `@`-references (or, if the harness doesn't auto-include, briefly summarizes + points to) the two files | **RECOMMENDED.** The generic file is *physically* the liftable artifact (copy it to the kit verbatim); the project file is what the `init` wizard regenerates. Matches Part 2a's `rules/CLAUDE.core.md` + generated project layer exactly. |
| **B-3 — generic stays in the kit-style `rules/` tree now** | create `.claude/rules/{CLAUDE.core,permission-gaps,marker-grammar,...}.md` already | Most faithful to the final kit, but heavier; better done at the actual lift. Over-engineering for in-place. |

**Recommendation: B-2.** Concretely:
- **`CLAUDE.md`** (loaded by the harness) shrinks to a short preamble + an explicit pointer: *"Generic methodology rules: `CLAUDE.generic.md`. Project-specific rules + facts: `CLAUDE.project.md` (which sources `docs/PROJECT_CONFIG.md`)."* If the harness auto-loads only `CLAUDE.md`, then `CLAUDE.md` **embeds both** via include-markers OR (safer, since Claude Code loads the single `CLAUDE.md`) `CLAUDE.md` *contains* the two clearly-delimited sections but each section is **maintained to be copy-paste-liftable** — i.e. B-2's content, B-1's delivery. **Decision point for the user (DP-1):** do we rely on Claude Code loading extra files, or keep one loaded `CLAUDE.md` with two liftable sections? (Safe default: one loaded `CLAUDE.md` with a GENERIC section that is verbatim-liftable + a PROJECT section that points to `PROJECT_CONFIG.md`.)
- **`CLAUDE.generic.md`** (or the GENERIC section): the methodology rules with project tokens replaced by references — Autonomy/no-direct-skill-exec, the permission-suppression lesson + failure-mode catalogue (generic form), Auto-Trigger, Documentation-First (rule), Verification-Surface rule (generalized), the distribution model, the marker-grammar pointer.
- **`CLAUDE.project.md`** (or the PROJECT section): UI Interaction, Backend Startup, Startup/Build-Failure, Build&Env, Frontend Standards, Key Paths — **each stating only the project specifics, sourced from `PROJECT_CONFIG.md`**.

### 2.4 (c) Each skill = generic body + config references (the full Tier-2 consolidation)

Now **in scope** (P0 deferred this): strip every remaining inlined project fact from the skills and replace with a `PROJECT_CONFIG.md#anchor` reference. The facts still inlined today (measured):

| Inlined fact | In skills (count) | → becomes |
|---|---|---|
| venv interpreter `PianoidCore/.venv/Scripts/python` | 9 (dev, fn, multitask, orchestrator, pianoid-ui, startup, test-ui, update-pianoid, diagnose) | `PROJECT_CONFIG.md#interpreters` ref |
| `## Key Paths` table | 4 (analyse, dev, fn, multitask) | `PROJECT_CONFIG.md#key-paths` ref |
| port quad 3000/3001/5000/5001 (+roles) | 6 (dev, diagnose, orchestrator, pianoid-ui, startup, test-ui) | `#ports` ref (+keep the bare quad where a loop iterates) |
| repo roots + branches | 4 (dev, orchestrator, sync, update-pianoid) | `#repos` ref |
| port-sweep `for port in … taskkill` loop | ~6 (dev ×3, diagnose, orchestrator, pianoid-ui, test-ui) | `python tools/dev-pipeline/env_sweep.py` ref |
| REST endpoints | 5 (pianoid-ui full, test-ui, diagnose, startup, dev) | `#rest-endpoints` ref (pianoid-ui keeps the full map as the endpoint-reference skill) |
| default preset | 3 (startup, dev, update-pianoid) | `#defaults` ref |

### 2.5 (d) `GENERIC_CORE_MANIFEST.md` = the future lift-list

A single index that, for each artifact, states **GENERIC (liftable) / HYBRID / PROJECT (stays)** and where it goes in the public kit. This is the document a future lift reads to know exactly what to copy. Shape:

```
| Artifact | Class | Lifts to (public kit path) | Project params it needs |
| .claude/commands/review.md | GENERIC | skills/review/SKILL.md (verbatim) | layer names, ports → from project.devkit.toml |
| .claude/commands/dev.md | HYBRID | skills/dev/SKILL.md (body) | build/test/run/ports/verify-surfaces |
| .claude/CLAUDE.generic.md | GENERIC | rules/CLAUDE.core.md | — |
| docs/PROJECT_CONFIG.md | PROJECT | (not lifted; the init wizard regenerates it) | IS the params |
| tools/dev-pipeline/*.py | GENERIC (params via env/flags) | tools/ | repo paths via PIANOID_REPO_ROOT etc. |
| tools/dev-pipeline/lint_skills.py | GENERIC | tools/ | forbidden-form patterns (parameterizable) |
| docs/development/CONTROLLER.md | GENERIC | controller/CONTROLLER.md | — |
| .claude/commands/diagnose.md | PROJECT (template) | devkit/templates/diagnose.md.example | all |
... (every file) ...
```

It also records the **generic/project split ratio** and the **liftability caveats** (e.g. the dev-pipeline scripts already parameterize the repo root via `PIANOID_REPO_ROOT` — liftable as-is; the build script wrapper needs the build cmd from config).

---

## PART 3 — COMPLETE CHANGE INVENTORY

### 3.1 Non-gated work (I do directly — `docs/`, new files)

| File | Action |
|---|---|
| `docs/PROJECT_CONFIG.md` | EXPAND — add anchors ★ (key-paths, data-model-facts, frontend-stack, channel, build-holders, midi-flag) so it holds every project fact |
| `docs/development/GENERIC_CORE_MANIFEST.md` | CREATE — the per-artifact lift-list (Part 2.5) |
| `.claude/CLAUDE.generic.md` *(if B-2 two-file)* | CREATE — generic methodology rules (NOTE: `.claude/` is GATED — see 3.3; if a new file under `.claude/` is gated for me, team-lead creates it from my drafted content) |
| `.claude/CLAUDE.project.md` *(if B-2)* | CREATE — project rules (same gating note) |
| this plan | CREATE (done) |

> ⚠ **Gating check needed (DP-2):** new files *under `.claude/`* may be gated for sub-agents just like edits to `.claude/commands/`. If so, I draft `CLAUDE.generic.md` / `CLAUDE.project.md` content in the plan / a scratch spec and **team-lead creates them**. `docs/**` and `tools/**` are non-gated (confirmed — I created PROJECT_CONFIG.md + lint_skills.py directly).

### 3.2 Gated `.claude/commands/` edits (team-lead applies — apply-ready change-set, exact old→new)

Delivered as a **follow-up change-set spec** (like the P0 specs) once the approach is approved, covering, per skill, the Tier-2 reference swaps from 2.4. Estimated edit count:

| Skill | Edits (reference swaps) |
|---|---|
| dev | ~5 (venv, key-paths, ports, repos, port-sweep ×3 → env_sweep) |
| orchestrator | ~4 (channel ref, ports, repos+branches, port-sweep) |
| test-ui | ~4 (chrome/note_playback stay [project skill], venv, ports, port-sweep, WAV-snippet ref) |
| diagnose, pianoid-ui | ~3 each (venv, ports, port-sweep) |
| multitask, fn, analyse, sync, update-pianoid, update-docs, startup, cli-control | ~1–3 each |
| **CLAUDE.md** | the §-by-§ split (the largest single edit) |

(The precise old→new blocks go in the change-set spec, after approach approval — same method as `p1-preamble-collapse-spec.md`.)

### 3.3 What does NOT change

- `tools/dev-pipeline/*` (already generic-with-params; the manifest just records them as liftable).
- `tools/deepseek-codegen-mcp/*` (the cheap-model adapter — already a clean interface).
- `docs/development/CONTROLLER.md` (generic spec; manifest records it liftable).
- The personal-assistant skills (out of scope, D8).
- Any synthesis source — this is methodology/config restructuring only.

---

## PART 4 — REPRESENTATIVE SAMPLE (the shape)

### 4.1 One skill before/after — `fn.md` "Key Paths" + venv (illustrative)

**BEFORE (inlined project facts):**
```markdown
## Key Paths

| Resource | Path |
|----------|------|
| PianoidCore | `PianoidCore` |
| PianoidBasic | `PianoidBasic` |
| PianoidTunner | `PianoidTunner` |
| Session logs | `docs\development\logs/` |
| Module locks | `docs\development\MODULE_LOCKS.md` |
| venv Python | `PianoidCore/.venv/Scripts/python` |
```

**AFTER (generic body + config reference):**
```markdown
## Key Paths

Paths, the venv interpreter (per-OS), and the lock/log locations are project facts —
see [`docs/PROJECT_CONFIG.md` → Key Paths](../../docs/PROJECT_CONFIG.md#key-paths)
and [→ Interpreters](../../docs/PROJECT_CONFIG.md#interpreters).
```

The *workflow* prose of `fn.md` (input contract, marker discipline, context-hygiene, the DeepSeek delegation, the dual-backend rule) is unchanged — that is the generic body. Only the fact-tables become references.

### 4.2 `CLAUDE.md` generic/project split — sample (B-2 shape)

**`CLAUDE.generic.md` (excerpt — liftable verbatim):**
```markdown
## Sub-Agent Permission Rule (generic)
A coordinator's sub-agents run permission-suppressed because their prompts render only in the
local CLI, invisible to a remote user. Blanket-allow BOTH shells + the core tools; do NOT
whack-a-mole specific commands. Known gaps that gate REGARDLESS of mode (route around them, never
relay the invisible prompt to the user): long-running starters, TTY-openers, system-PID kills,
MCP re-auth. [Full failure-mode catalogue → controller/CONTROLLER.md.]

## Documentation-First Rule (generic)
Consult docs before grepping/reading source — at every stage, especially debugging. The doc
hierarchy IS the context. High-stakes data-model facts need doc support or measurement before an
edit. [Project doc-hierarchy + the project's high-stakes fact categories → PROJECT_CONFIG.md.]

## Verification-Surface Rule (generic; was "Audio Verification")
A change to output X is verified on the surface that observes X, with measured before/after
evidence. [The project's surfaces (which observable proves which change) → PROJECT_CONFIG.md#verification-surfaces.]
```

**`CLAUDE.project.md` (excerpt — facts sourced from PROJECT_CONFIG.md):**
```markdown
## Build & Environment (Pianoid)
Canonical build, venv, ports, holders, smoke-test → docs/PROJECT_CONFIG.md
(#docs-first-build--run, #interpreters, #ports, #build-holders). On build/startup failure → /startup.

## Frontend UI Standards (Pianoid)
React 18 + MUI v6 + ECharts + react-mosaic; dark theme; NumInput. → PROJECT_CONFIG.md#frontend-stack.

## UI / Backend / Audio (Pianoid)
UI interaction → /pianoid-ui. Backend startup → PROJECT_CONFIG.md#defaults + the launcher REST.
Audio verification routing → PROJECT_CONFIG.md#verification-surfaces.
```

**`CLAUDE.md` (the loaded entry, B-2):**
```markdown
# Pianoid — Claude instructions
- Generic agentic-dev methodology rules: see `CLAUDE.generic.md` (liftable; project-agnostic).
- Pianoid-specific rules + the project-config SSOT: `CLAUDE.project.md` → `docs/PROJECT_CONFIG.md`.
(If the harness loads only this file, both sections are inlined below, kept liftable-verbatim.)
```

---

## PART 5 — SEQUENCING (comprehensive, phased to stay safe)

| Stage | Scope | Gated? | Risk |
|---|---|---|---|
| **S1 — Expand PROJECT_CONFIG.md to COMPLETE** | add the ★ anchors (key-paths, data-model-facts, frontend-stack, channel, build-holders, midi-flag) so every project fact has a home | non-gated (I do) | none (additive doc) |
| **S2 — Write GENERIC_CORE_MANIFEST.md** | the per-artifact lift-list | non-gated (I do) | none |
| **S3 — Draft the CLAUDE.md split** | produce `CLAUDE.generic.md` + `CLAUDE.project.md` content (B-2) + the thin `CLAUDE.md` — as drafts in a spec | gated to apply (team-lead) | medium — CLAUDE.md is always-loaded; review carefully, keep total rules intact |
| **S4 — Skill reference-swap change-set** | the apply-ready old→new per skill (Tier-2: venv/key-paths/ports/repos/port-sweep/REST/preset → config refs) | gated to apply (team-lead) | low (reference swaps; lint stays green; verify each new_string lint-clean as in P0) |
| **S5 — Verify** | lint exit 0 + R3 advisories drop; `grep -rl PROJECT_CONFIG.md .claude/commands/` covers the consumers; CLAUDE.md split loads + no rule lost; manifest matches reality | mixed | low |

**Sequencing rationale:** S1+S2 are pure-additive non-gated docs that establish the targets — do them first (and they're independently useful). S3 (CLAUDE.md) is the highest-care change (always-loaded) — draft + review before applying. S4 is the bulk mechanical reference-swap — safe, lint-guarded, done after the config targets exist. Comprehensive, but staged so the always-loaded CLAUDE.md is handled deliberately and the skill swaps are guarded by the existing lint.

---

## Decision points for the user (before execution)

- **DP-1 — CLAUDE.md form:** two companion files (`CLAUDE.generic.md` + `CLAUDE.project.md`) that the loaded `CLAUDE.md` references, **or** one loaded `CLAUDE.md` with two clearly-delimited liftable sections? (Recommendation: the latter is safest given Claude Code loads the single `CLAUDE.md`, while keeping the GENERIC section verbatim-liftable; the former is the cleanest physical separation if we confirm the harness will load the companions.)
- **DP-2 — `.claude/` new-file gating:** confirm whether sub-agents can create new files under `.claude/` (if not, team-lead creates `CLAUDE.generic/project.md` from my drafts).
- **DP-3 — Scope of the skill reference-swap (S4):** all 7 fact-classes now, or stage REST/preset (lower-traffic) to a follow-up? (Recommendation: do all now — it's the "comprehensive" the user asked for, and the lint guards it.)
- **DP-4 — Port-sweep swaps:** confirm now in scope (they were deferred in P0; this plan brings them in as part of S4).

---
---

# ADDENDUM (2026-06-11) — MULTI-PROJECT REDESIGN (supersedes the single-file CLAUDE.md in §2.3)

**New user requirement:** *"one system can manage several projects; one orchestrator may deal with two projects SIMULTANEOUSLY; the one-file CLAUDE.md approach does not work."* Correct — a generic section duplicated inside each project's `CLAUDE.md` = cross-project drift (our disease, one level up). **The generic core must be a SHARED unit — ONE copy across all projects — not duplicated per project.** This addendum reworks the separation around multi-project, grounded in the validated Claude Code mechanism below.

## A1 — VALIDATED Claude Code multi-project mechanism (from official docs, not memory)

> Sources: `code.claude.com/docs/en/memory`, `/settings`, `/sub-agents`, `/agent-sdk/claude-code-features`; plus open GitHub issues anthropics/claude-code #31940 + #12748. Confidence stated per finding.

| # | Question | Answer | Confidence |
|---|---|---|---|
| 1 | Is **`~/.claude/CLAUDE.md` (user-level)** loaded for EVERY project regardless of cwd? | **YES.** Docs: "User instructions — `~/.claude/CLAUDE.md` — Personal preferences for all projects — Just you (all projects)." The SDK `"user"` source loads from `~/.claude/`. **This is the shared layer.** | **HIGH** |
| 1b | Are **`~/.claude/commands/` skills + `~/.claude/rules/`** available globally? | **YES.** User-level skills/commands + `~/.claude/rules/*.md` ("apply to every project on your machine") load via the `"user"` source regardless of cwd. `~/.claude/rules/` is **loaded before project rules** (project rules win on conflict). | **HIGH** |
| 2 | Is **project `./CLAUDE.md` or `./.claude/CLAUDE.md`** loaded per-project based on cwd? | **YES — by walking UP the directory tree from cwd.** Docs: "Claude Code reads CLAUDE.md files by walking up the directory tree from your current working directory." SDK: the `"project"` source loads CLAUDE.md from `<cwd>` and every parent directory. | **HIGH** |
| 2b | Precedence/merge of user vs project? | **ADDITIVE, not override.** "All discovered files are concatenated... rather than overriding each other," ordered root->cwd (user before project, so project is read last = higher salience). "There is no hard precedence rule between levels; if instructions conflict, the outcome depends on how Claude interprets them. **State precedence explicitly in the more specific file.**" | **HIGH** |
| 3 | **`@path` import** to pull a shared file into CLAUDE.md? | **YES.** "CLAUDE.md files can import additional files using `@path/to/import` syntax... Both relative and absolute paths... recursively... max depth four." `@~/.claude/<file>` is the documented pattern to share personal instructions across worktrees. | **HIGH** |
| 3b | **`.claude/rules/` symlinks** for cross-project shared rules? | **YES.** "maintain a shared set of rules and link them into multiple projects... Symlinks are resolved and loaded normally." | **HIGH** |
| 4 | **THE CRUX — simultaneous two-project:** when the orchestrator spawns a sub-agent to work on project B, does that agent load B's CLAUDE.md / resolve B's `PROJECT_CONFIG.md` (NOT the orchestrator's project A)? | **NOT AUTOMATICALLY — and this is the load-bearing caveat.** Sub-agents **inherit the parent session's cwd**; there is **exactly one cwd** for the synchronous path, and **per-subagent `cwd`/`additionalDirectories` is NOT a stable, documented capability** (it is an OPEN feature request — issues #31940, #12748). CLAUDE.md resolves from `<cwd>`, so a sub-agent that shares the orchestrator's cwd resolves **project A's** CLAUDE.md, not B's. `--add-dir` does NOT load CLAUDE.md from the extra dir by default (needs `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`, and even then it's session-global). **Worktrees** (`EnterWorktree`/`cwd` change) DO move cwd, but that re-points the WHOLE session, not a single concurrent sub-agent. | **HIGH** (that cwd is shared + per-subagent cwd is unsettled); **MEDIUM** on the exact AsyncLocalStorage override behavior (mentioned in community write-ups, not in the official per-subagent dispatch docs) |

### A1-crux — what this MEANS for the design

Because per-subagent cwd-scoping is **not a reliable mechanism today**, **per-project config resolution under simultaneous multi-project CANNOT be left implicit (cwd-derived).** It must be **EXPLICIT**: the orchestrator passes the **target project's root + config path** in the dispatch brief, and the generic skills resolve every project fact from that **explicitly-provided project root** — never from cwd, never from a hardcoded path. Two robust patterns, combined:

- **(R1) Shared generic core at user level** (`~/.claude/`): loaded for every session/agent regardless of cwd -> ONE copy, zero drift. Fully supported.
- **(R2) Explicit active-project binding in the dispatch:** the orchestrator's brief to a sub-agent names `PROJECT_ROOT=<abs path to project B>` and `PROJECT_CONFIG=<PROJECT_ROOT>/docs/PROJECT_CONFIG.md`; the generic skill reads config from `{{PROJECT_ROOT}}` (a dispatch variable), not from cwd. For a sub-agent that will actually edit project B, the orchestrator **also** sets the agent's working directory to B's root (via worktree / cwd) so B's `./CLAUDE.md` auto-loads too — but the **load-bearing** binding is the explicit `PROJECT_ROOT`, because that survives even if cwd-scoping is unavailable. This is how a robust two-project dispatch is made deterministic.

## A2 — RE-DESIGNED separation: shared-generic + per-project-config

### A2.1 The three layers (replaces §2.1's four in-repo pillars)

```
USER LEVEL (~/.claude/)  -- the SHARED generic core, ONE copy, every project --
  ~/.claude/CLAUDE.md                 # generic methodology rules (the liftable core) -- project-AGNOSTIC
  ~/.claude/rules/*.md                # (optional) generic rule fragments (marker-grammar, permission-gaps, ...)
  ~/.claude/commands/*.md             # the GENERIC skills (dev, fn, multitask, orchestrator, review, analyse,
                                      #   verify, update-docs, sync) -- resolve the ACTIVE project's config at runtime
  (generic tools)                     # CONTROLLER spec, lint, dev-pipeline (already param-by-env)

PROJECT LEVEL (<repo>/)  -- one per project, the project's own config --
  <repo>/.claude/CLAUDE.md            # PROJECT rules ONLY (no generic methodology) -- "these override user-level on conflict"
  <repo>/docs/PROJECT_CONFIG.md       # the COMPLETE project-config SSOT (Pianoid's lives here today)
  <repo>/.claude/commands/*.md        # PROJECT-SPECIFIC skills only (diagnose, pianoid-ui, startup)

DISPATCH BINDING  -- how the orchestrator targets the right project per task --
  PROJECT_ROOT / PROJECT_CONFIG passed in every sub-agent brief (the explicit active-project binding, R2)
```

**Why this kills the drift:** the generic core is **physically one file set at `~/.claude/`**, shared by every project. No project carries a copy of the methodology, so there is nothing to drift. Each project carries only its own facts (`PROJECT_CONFIG.md`) + its own rules (`<repo>/.claude/CLAUDE.md`) + its own project-specific skills.

### A2.2 The generic core must be PROJECT-AGNOSTIC (the real engineering work)

Today every generic skill hardcodes Pianoid (paths, the 4-repo layout, `docs/PROJECT_CONFIG.md` location, ports, `PianoidCore/.venv`). For the core to be SHARED across projects, **it must resolve the active project's config at runtime, relative to an active-project root — never a hardcoded `D:\repos\PianoidInstall` or `PianoidCore/...`.** Mechanism:

- A generic skill refers to **`$PROJECT_ROOT`** (resolved per-dispatch from the brief's `PROJECT_ROOT`, or — when the skill genuinely runs at the session's own project — from the cwd-discovered project root) and reads **`$PROJECT_ROOT/docs/PROJECT_CONFIG.md`** for all facts.
- The skill body says e.g.: *"Canonical build, venv, ports -> the active project's `PROJECT_CONFIG.md` (`#docs-first-build--run`, `#interpreters`, `#ports`). Resolve `PROJECT_CONFIG.md` from the dispatch's `PROJECT_ROOT` (or the project root of the current working directory if running in-project)."* — **no Pianoid token in the generic skill at all.**
- The **convention** `docs/PROJECT_CONFIG.md` (relative to project root) becomes part of the generic kit's contract; every adopting project provides one at that path. (The `init` wizard generates it.)

### A2.3 The ORCHESTRATOR for multi-project (the skill that most assumes one project)

`orchestrator.md` today bakes in one project (Pianoid: the 4 repos, ports 3000/3001/5000/5001, the `pianoid-dev` team, `start-pianoid.bat`). A multi-project orchestrator must:

1. **Maintain a project registry** — a list of managed projects, each `{name, PROJECT_ROOT, PROJECT_CONFIG path, integration branches, channel}`. (Stored at user level, e.g. `~/.claude/projects-registry.md`, or passed at `/orchestrator start`.)
2. **Tag every task with its target project.** When a task arrives, the orchestrator resolves WHICH project it targets (explicit in the request, or asked). It then **dispatches with the explicit `PROJECT_ROOT`/`PROJECT_CONFIG` binding (R2)** so the sub-agent operates on the right project's config — even when a second project's agent is alive concurrently.
3. **Isolate concurrent projects' state.** The lock/WIP/log files (`MODULE_LOCKS.md`, `WORK_IN_PROGRESS.md`, `docs/development/logs/`) are **per-project** (under each `PROJECT_ROOT`), so two projects' agents never share a registry — the existing worktree-per-parallel-agent rule extends to project-per-root. The controller watches **each active project's** state files (it takes the set of active `PROJECT_ROOT`s).
4. **Per-project clearance.** Full-clearance sweeps the **active project's** ports (from its `PROJECT_CONFIG.md#ports`), not a hardcoded quad — so project A (ports 3000-5001) and project B (some other ports) are swept independently.

**Net:** the orchestrator becomes generic + a project registry; "which project" is an explicit dimension on every dispatch, and per-project facts come from each project's `PROJECT_CONFIG.md`. This is the concrete answer to "how does a multi-project orchestrator target the right project per dispatch": **explicit per-dispatch PROJECT_ROOT binding + per-project config/state resolution.**

## A3 — Placement: (i) HOIST to `~/.claude/` now  vs  (ii) STAGE in-repo now, hoist later

Both reach the same end state; the delta is **mostly physical location**. The **project-agnostic skill redesign (A2.2) is identical either way** — that is the real work, and it's location-independent.

| | **(i) HOIST now** — generic core -> `~/.claude/` immediately | **(ii) STAGE now** — generic core as a distinct in-repo unit (e.g. `generic-core/`), hoist later |
|---|---|---|
| Generic skills | live in `~/.claude/commands/` (shared, active immediately for all projects) | live in `<repo>/generic-core/commands/` (a clearly-delineated in-repo dir); still loaded for Pianoid via `<repo>/.claude/` or symlink; hoisted to `~/.claude/` at the lift |
| Generic CLAUDE.md | `~/.claude/CLAUDE.md` (or `~/.claude/rules/`) | `<repo>/generic-core/CLAUDE.generic.md` (Pianoid's `<repo>/.claude/CLAUDE.md` `@`-imports it for now) |
| Multi-project benefit | **immediate** — a second project gets the shared core today | **deferred** — only Pianoid sees it until hoisted; but the SHAPE is proven |
| Versioning / sync | uses the existing `~/claude-config` repo + `/self-update` (already the user-level distribution model!) | versioned in the Pianoid repo until lifted |
| Risk | edits to `~/.claude/` are **machine-global** — affect every existing session immediately; needs care + the user's go-ahead | **contained** to the repo; zero blast radius on other work; reversible |
| Reversibility | medium (global) | high (in-repo) |

**RECOMMENDATION: (ii) STAGE in-repo now, hoist later — with the generic core written project-AGNOSTIC from day one.** Rationale:
- The hard, valuable work — making every generic skill resolve config from `$PROJECT_ROOT` instead of hardcoded Pianoid paths — is **identical** in both options and is what the user is really asking for. Do that now, in-repo, where it's contained and reversible.
- Hoisting to `~/.claude/` is **machine-global** (touches every session the user runs) and couples to the existing `~/claude-config` + `/self-update` distribution — better done as a **deliberate, separately-approved step** once the project-agnostic core is proven against Pianoid (and ideally a second project).
- (ii) keeps the work **liftable** (the `generic-core/` dir is exactly what hoists to `~/.claude/` or the public kit) without the global blast radius now. It also matches the user's own pattern: their personal skills already live in `~/claude-config` and sync to `~/.claude/` via `/self-update` — the dev-kit generic core can ride the **same** rails when hoisted.
- The delta to later hoist is small + mechanical: move `generic-core/*` -> `~/.claude/` (or into `~/claude-config` for sync), drop the temporary `@`-import from Pianoid's `<repo>/.claude/CLAUDE.md`. No skill rewrite.

> **If the user prefers immediate multi-project capability** (they have a second project ready NOW), choose (i) — the skills are already project-agnostic, so hoisting is just the move; the only added care is the machine-global blast radius + doing it via `~/claude-config`//`self-update` so it's versioned.

## A4 — Skills that currently HARDCODE Pianoid -> must become active-project-relative (the flag-list)

Every generic skill must lose its Pianoid hardcodes. Measured offenders (these are the project-agnostic-ization targets, beyond the §2.4 fact-table swaps):

| Hardcode | Where | -> becomes |
|---|---|---|
| `PianoidCore/.venv/...` interpreter | 9 skills | `$PROJECT_ROOT` + `PROJECT_CONFIG.md#interpreters` |
| The 4-repo layout (Core/Tunner/Basic/Install) | orchestrator, sync, update-pianoid, multitask, dev | `PROJECT_CONFIG.md#repos` (a project may have 1 repo or 7) |
| `docs/PROJECT_CONFIG.md` location assumed at the Pianoid root | (all, once they reference it) | `$PROJECT_ROOT/docs/PROJECT_CONFIG.md` — the generic convention |
| Ports 3000/3001/5000/5001 | 6 skills | `PROJECT_CONFIG.md#ports` |
| `start-pianoid.bat`, `build_pianoid_cuda.bat`, `/load_preset`, `note_playback`, MUI/ECharts | orchestrator, dev, fn, multitask, test-ui, update-pianoid | the project-specific ones move to PROJECT skills (diagnose/pianoid-ui/startup) which STAY per-project; the generic skills reference `PROJECT_CONFIG.md#{build,rest-endpoints,verification-surfaces,frontend-stack}` |
| `pianoid-dev` team name | orchestrator | `$PROJECT.team` or a per-project registry field |
| `~/.claude/channels/telegram/...`, the Telegram plugin | orchestrator | `PROJECT_CONFIG.md#channel` (or the user-level channel config — channels can be shared) |

**The orchestrator is the biggest one** — it assumes a single project end-to-end; A2.3 is its redesign.

## A5 — Revised sequencing (multi-project)

| Stage | Scope | Gated? |
|---|---|---|
| **MS1** | Validate mechanism (DONE — A1). | — |
| **MS2** | Expand `PROJECT_CONFIG.md` to COMPLETE (S1 from the base plan) — unchanged; it's already per-project + at the right path. | non-gated (I do) |
| **MS3** | Define the **generic-core staging dir** (`generic-core/` per option (ii)) + write `GENERIC_CORE_MANIFEST.md` as the lift-list **with the user-level destination** recorded (`~/.claude/...`). | non-gated (I do) |
| **MS4** | **Project-agnostic-ize the generic skills** — the apply-ready change-set: replace every Pianoid hardcode (A4) with `$PROJECT_ROOT` + `PROJECT_CONFIG.md#anchor` references; split `CLAUDE.md` into generic (-> staging, project-agnostic) + project (`<repo>/.claude/CLAUDE.md`, "overrides user-level on conflict"). | gated to apply (team-lead) |
| **MS5** | **Orchestrator multi-project** — project registry + explicit `PROJECT_ROOT` dispatch binding + per-project clearance/locks/controller (A2.3). | gated to apply (team-lead) |
| **MS6** | Verify: lint clean; generic skills contain **zero** Pianoid tokens (a grep gate); Pianoid still works via the staged core (`@`-import + project skills); a dry-run two-project dispatch resolves the right config. | mixed |
| **MS7** (later, separately approved) | **HOIST** staging -> `~/.claude/` (or `~/claude-config` for sync) + drop the temporary import. | gated |

## A6 — Updated decision points (supersede DP-1)

- **DP-1' (replaces DP-1) — placement:** **(ii) stage in-repo now, hoist later** [recommended] vs **(i) hoist to `~/.claude/` now**. (The skill redesign is identical; the choice is blast-radius + whether a second project is needed immediately.)
- **DP-5 — generic-core staging location:** `generic-core/` at repo root, or under `docs/`/`tools/`? (Recommendation: a top-level `generic-core/` — it's the unit that hoists.)
- **DP-6 — channel scope:** is the control channel (Telegram) **shared across projects** (user-level) or **per-project** (`PROJECT_CONFIG.md#channel`)? (Recommendation: shared user-level — one orchestrator, one channel, many projects; per-project only if a project needs its own.)
- **DP-7 — orchestrator project registry home:** `~/.claude/projects-registry.md` (user-level, persists) vs passed at `/orchestrator start`. (Recommendation: user-level registry, overridable per start.)
- **(carried) DP-2 `.claude/` new-file gating · DP-3 swap scope · DP-4 port-sweep — unchanged.**

## A7 — Blocker / risk needing the user's awareness

**The simultaneous-two-project robustness rests on EXPLICIT `PROJECT_ROOT` dispatch binding (R2), because per-subagent cwd-scoping is an OPEN Claude Code feature (issues #31940, #12748), not a shipped guarantee.** This is fine — explicit binding is more robust than implicit cwd anyway — but it means: (a) the orchestrator MUST pass `PROJECT_ROOT` on every dispatch (a hard rule, like the `bypassPermissions` rule); (b) a generic skill MUST NOT assume cwd == the target project. If Anthropic later ships per-subagent `cwd`, it becomes a convenience on top, not a dependency. **No hard blocker — but the user should know the multi-project guarantee comes from our explicit-binding discipline, not from the harness auto-resolving per-agent cwd.**

---
---

# ADDENDUM 2 (2026-06-11) — CONCRETE (i) HOIST EXECUTION PLAN (DECIDED)

**User decision:** DP-1 = **(i) HOIST the generic core to user-level `~/.claude/` NOW** (true multi-project immediately). Plus DP-3 = ALL 7 fact-classes (comprehensive), DP-4 = port-sweep→`env_sweep.py` swaps IN scope. This addendum supersedes Addendum-1's (ii) recommendation and gives the concrete (i) execution plan. *(The (ii) in-repo-stage variant is dropped; it survives only as the fallback if the hoist needs reverting — `git`-tracked project copies + the `~/claude-config` repo make revert trivial.)*

## B0 — The precedence rule that shapes everything (VALIDATED, decisive)

> **Official docs (`code.claude.com/docs/en/skills`), verbatim:** *"When skills share the same name across levels, enterprise overrides personal, and **personal overrides project**. … If you have files in `.claude/commands/`, those work the same way."*
> Also: Personal `~/.claude/skills/` (and `~/.claude/commands/`) = **"All your projects"**; Project `.claude/skills/` = **"This project only."** Project skills load from cwd up to the repo root. **Confidence: HIGH.**

**Consequence (load-bearing):** **user-level (personal) WINS over project on a name clash.** So:
1. Once a generic skill is hoisted to `~/.claude/commands/`, it is the version used in **every** project. A project's leftover same-named copy in `<project>/.claude/commands/` is **SHADOWED (ignored)** — a dead file that *looks* authoritative. **Therefore the hoist MUST DELETE the project copies of hoisted skills** (else confusing dead files + the lint/manifest drift one more level).
2. A project **cannot** override a generic skill by re-defining the same name (personal wins) — so per-project customization is achieved NOT by shadowing but by **(a) the generic skill resolving the active project's `PROJECT_CONFIG.md` at runtime** (the core design) and **(b) optionally a differently-named project skill that extends/wraps it** (e.g. a project keeps `diagnose` which calls the generic `/dev`). This is actually the cleaner model: one generic skill, parameterized; projects differ by config + their own uniquely-named project skills.
3. **Verified clean to hoist:** none of the 10 generic skill names (`dev fn multitask orchestrator review analyse update-docs sync cli-control test-ui`) currently exist at `~/.claude/commands/` → first hoist has **no collision** to resolve.

## B1 — WHAT MOVES to `~/.claude/` vs WHAT STAYS in Pianoid

### MOVES to user level (the shared generic core — `~/.claude/`)

| Artifact (now) | → user-level destination | Note |
|---|---|---|
| `.claude/commands/review.md` | `~/.claude/commands/review.md` | GENERIC, ~verbatim (only layer-names/ports → config refs) |
| `.claude/commands/dev.md` | `~/.claude/commands/dev.md` | HYBRID body; agnostic edits (B3) |
| `.claude/commands/fn.md` | `~/.claude/commands/fn.md` | HYBRID body; agnostic edits |
| `.claude/commands/multitask.md` | `~/.claude/commands/multitask.md` | HYBRID body; agnostic edits |
| `.claude/commands/orchestrator.md` | `~/.claude/commands/orchestrator.md` | HYBRID; the biggest agnostic rework (B4 multi-project) |
| `.claude/commands/test-ui.md` | `~/.claude/commands/test-ui.md` | HYBRID body; the chrome/note_playback specifics → config refs (or a project `verify` skill — see note) |
| `.claude/commands/sync.md` | `~/.claude/commands/sync.md` | HYBRID; repos+branches → config |
| `.claude/commands/analyse.md` | `~/.claude/commands/analyse.md` | HYBRID; layer-names → config |
| `.claude/commands/update-docs.md` | `~/.claude/commands/update-docs.md` | HYBRID; doc-tree → config |
| `.claude/commands/cli-control.md` | `~/.claude/commands/cli-control.md` | HYBRID; transcript path/`/orchestrator start` → config/active-project |
| `.claude/CLAUDE.md` **generic sections** | `~/.claude/CLAUDE.md` (generic methodology rules) | the GENERIC half of CLAUDE.md (B5) — APPENDED to the existing user-level CLAUDE.md |
| `docs/development/CONTROLLER.md` | `~/.claude/CONTROLLER.md` (or `~/.claude/rules/controller.md`) | generic monitor spec, referenced by the generic orchestrator |
| `tools/dev-pipeline/*` | `~/.claude/tools/dev-pipeline/*` (or stays in-repo + referenced by abs path) | already param-by-env (`PIANOID_REPO_ROOT`); see B3-scripts |
| `tools/dev-pipeline/lint_skills.py` | with the dev-pipeline | forbidden-form patterns can stay generic |
| `self-update` | **already user-level** (`~/.claude/commands/self-update.md`) | no move |

### STAYS in Pianoid (the project layer — `<repo>/`)

| Artifact | Stays because |
|---|---|
| `.claude/commands/diagnose.md` | PROJECT-SPECIFIC (8 Pianoid phases, mic/Goertzel/REST) — unique name, no clash |
| `.claude/commands/pianoid-ui.md` | PROJECT-SPECIFIC (chrome + Pianoid REST + MUI) — unique name |
| `.claude/commands/startup.md` | PROJECT-SPECIFIC (the whole Pianoid build/toolchain knowledge base) — unique name |
| `.claude/commands/update-pianoid.md` | PROJECT-SPECIFIC enough (names the 4 repos, build flags, required-MCP list) — **keep project-level**, generalize later if a 2nd project needs it. Unique name. |
| `.claude/CLAUDE.md` **project sections** | the Pianoid rules (UI/Backend/Startup/Frontend-Standards/Build) — stays, "overrides user-level on conflict" |
| `docs/PROJECT_CONFIG.md` | the project's config SSOT — by definition per-project |
| `docs/**`, synthesis source, `PianoidCore/.venv`, etc. | all project |

> **test-ui note:** `test-ui` is HYBRID — its *discipline* (crash-logging, measure-via-deterministic-surface, every-claim-a-number, 7-phase) is generic, but its *body* is thick with chrome-devtools + `note_playback` + MUI chips. Two options (DP-8): **(a)** hoist `test-ui` as the generic **`/verify`** skill (discipline only, surfaces from `PROJECT_CONFIG.md#verification-surfaces`) and keep a thin project `test-ui` (or fold into `pianoid-ui`); **(b)** keep `test-ui` project-level for now and hoist only the other 9. **Recommendation: (b) for this hoist** — `test-ui` is the most project-entangled of the "generic" set; hoist it as `/verify` in a later pass once `PROJECT_CONFIG.md#verification-surfaces` is exercised. (Flagged; doesn't block the other 9.)

### CRITICAL post-move step (from B0): DELETE the shadowed project copies

After a generic skill is copied to `~/.claude/commands/`, **remove `<repo>/.claude/commands/<that-skill>.md`** (it would otherwise be a shadowed dead file). The orchestrator does this via `Move-Item` (not copy) for each hoisted skill, OR copy-then-delete. **Net:** `<repo>/.claude/commands/` ends up containing ONLY the project-specific skills (diagnose, pianoid-ui, startup, update-pianoid [+ maybe test-ui per DP-8]).

## B2 — USER/PROJECT PRECEDENCE & the override/extend model (the design)

Given **personal overrides project** (B0):

- **Generic skill, project-tuned by CONFIG (the norm):** the hoisted generic `dev`/`fn`/etc. read `$PROJECT_ROOT/docs/PROJECT_CONFIG.md` at runtime (B3). One skill, every project, behavior differs by config. No shadowing involved.
- **Project EXTENDS a generic skill (when it needs more):** the project adds a **uniquely-named** project skill (e.g. `pianoid-ui`, `diagnose`) that *invokes/wraps* the generic one (`/dev`, `/verify`). Unique name → no clash → both available. This is the clean extension path.
- **Project OVERRIDES a generic skill (rare, discouraged):** because personal wins, a project **cannot** override by same name. If a project genuinely must replace the generic `dev`, the options are: (a) the user removes/renames the user-level `dev` for that work, or (b) the project ships `dev-pianoid` and uses that. **Recommendation: don't override; parameterize via config + extend via uniquely-named project skills.** (Document this as the rule.)
- **The generic orchestrator at user level** is shared; per-project behavior comes from the **project registry + per-dispatch `PROJECT_ROOT` binding** (B4). A project does not need its own orchestrator.

## B3 — PROJECT-AGNOSTIC edits (apply-ready old→new; team-lead applies via Edit)

Every generic skill must resolve the ACTIVE project's `./PROJECT_CONFIG.md` (and `$PROJECT_ROOT`) at runtime — zero hardcoded Pianoid. The change-set is delivered as a follow-up apply-ready spec (one per skill, exact old→new, like the P0 specs) once this plan is approved. The edit classes + estimated counts:

| Edit class | Pattern: OLD → NEW | Skills (est. edits) |
|---|---|---|
| **Active-project preamble** (NEW, top of each generic skill) | *(add)* → "**Active project:** resolve `$PROJECT_ROOT` from the dispatch brief's `PROJECT_ROOT` (or, if running in-project, the repo root of the cwd). All project facts come from `$PROJECT_ROOT/docs/PROJECT_CONFIG.md`. This skill is project-agnostic — it contains no hardcoded project paths." | all 10 (1 each) |
| **venv interpreter** | `PianoidCore/.venv/Scripts/python` → "the active project's interpreter (`PROJECT_CONFIG.md#interpreters`)" | dev, fn, multitask, orchestrator, test-ui*, sync (≈6–9) |
| **4-repo layout** | the Core/Tunner/Basic/Install table/branches → `PROJECT_CONFIG.md#repos` | orchestrator, sync, multitask, dev (≈4–6) |
| **ports** | `3000/3001/5000/5001` (+ the kill-loop) → `PROJECT_CONFIG.md#ports`; the loop → `python <devkit>/dev-pipeline/env_sweep.py` (DP-4) | dev, orchestrator, test-ui* (≈6) |
| **`docs/PROJECT_CONFIG.md` location** | (implicit Pianoid-root) → `$PROJECT_ROOT/docs/PROJECT_CONFIG.md` | all that reference config |
| **build/REST/preset/frontend names** | `build_pianoid_cuda.bat`, `/load_preset`, `note_playback`, MUI/ECharts → the corresponding `PROJECT_CONFIG.md#{docs-first-build--run,rest-endpoints,verification-surfaces,frontend-stack}` refs | dev, fn, multitask, sync (≈4) |
| **Key Paths table** | the per-skill `## Key Paths` table → `PROJECT_CONFIG.md#key-paths` ref | dev, fn, multitask, analyse (4) |
| **team name** | `pianoid-dev` → "the active project's team (registry/`PROJECT_CONFIG.md`)" | orchestrator (1–3) |
| **channel** | Telegram-specific paths → user-level channel config or `PROJECT_CONFIG.md#channel` | orchestrator (several) |

**Estimated total agnostic edits:** ~40–55 across the 10 generic skills (orchestrator is ~15 of them; dev ~8; the rest 1–5 each). Plus the deletes (B1) and the CLAUDE.md split (B5). Each `new_string` will be verified lint-clean (the `cmd //c … --heavy` ellipsis trick) before handing over, as in P0.

**Scripts (`tools/dev-pipeline/`):** already resolve the repo root via `PIANOID_REPO_ROOT` (env) — **rename the convention to `DEVKIT_PROJECT_ROOT`** (or accept both) so a generic skill points the script at the active project. `${CLAUDE_SKILL_DIR}` (confirmed available) can resolve a hoisted script's own dir. Two placement options for the scripts (DP-9): **(a)** hoist `tools/dev-pipeline/` → `~/.claude/tools/dev-pipeline/` (fully shared); **(b)** leave them in the Pianoid repo and have the generic skills invoke them by an absolute/config path. **Recommendation: (a)** for true sharing — they're generic — but it's a clean either/or.

## B4 — The generic ORCHESTRATOR for multi-project (the big one)

The hoisted `~/.claude/commands/orchestrator.md` becomes project-agnostic + multi-project:

1. **Project registry** (DP-7) at `~/.claude/projects-registry.md` (user-level, persists): each entry `{name, PROJECT_ROOT, config=PROJECT_ROOT/docs/PROJECT_CONFIG.md, branches, team, channel}`. `/orchestrator start` loads it (overridable per start).
2. **Every dispatch carries the active project binding (the CRUX guarantee, B-crux):** the orchestrator's brief to every sub-agent includes — as a HARD RULE, like `bypassPermissions` — `PROJECT_ROOT=<abs path>` and `PROJECT_CONFIG=<…>/docs/PROJECT_CONFIG.md`. The generic skills read facts from that. This is what makes simultaneous two-project deterministic *despite* per-subagent cwd not being settable (B0/A1 crux). For agents that edit files, the orchestrator also sets the worktree/cwd to that project's root so `<repo>/.claude/CLAUDE.md` auto-loads — but the load-bearing binding is the explicit `PROJECT_ROOT`.
3. **Per-project state isolation:** `MODULE_LOCKS.md` / `WORK_IN_PROGRESS.md` / `logs/` live under each `PROJECT_ROOT`; the controller is told the set of active `PROJECT_ROOT`s and watches each. Two projects never share a lock registry.
4. **Per-project clearance:** full-clearance sweeps **each active project's** ports (from its `PROJECT_CONFIG.md#ports`), not a fixed quad.

## B5 — The CLAUDE.md split for the hoist

- **`~/.claude/CLAUDE.md`** (user-level, loaded for every project): **APPEND** the GENERIC methodology rules (Autonomy / no-direct-skill-exec / permission-suppression lesson + failure-mode-catalogue / Auto-Trigger / Documentation-First rule / Verification-Surface rule / the marker-grammar pointer / Self-Update). These are project-agnostic. *(The user's current `~/.claude/CLAUDE.md` has the personal "Skill Organization / MCP / Config Repo" notes — the generic dev-methodology rules append below them.)*
- **`<repo>/.claude/CLAUDE.md`** (Pianoid, stays): the PROJECT rules only (UI / Backend Startup / Startup-Build-Failure / Build&Env / Frontend Standards / Key Paths), each sourcing `docs/PROJECT_CONFIG.md`, **with a one-line precedence header**: *"These project instructions override conflicting user-level (generic) defaults."* (Per the docs' "state precedence explicitly in the more specific file" — necessary because user+project are additive with no hard precedence.)
- A `<repo>/.claude/CLAUDE.md` need NOT `@`-import the generic file (the user-level one auto-loads). The `@`-import path was only for the (ii) in-repo-stage variant; under (i) it's redundant.

## B6 — ~/claude-config SYNC (so the hoist is versioned + distributable)

The user already versions `~/.claude/` via the **`~/claude-config`** repo synced by **`/self-update`** (`skills/<name>/SKILL.md` → `~/.claude/commands/<name>.md`; `~/.claude/CLAUDE.md`; MCP templates; memory). The hoisted generic kit must land there so it's tracked + reproducible on another machine:

| Hoisted artifact | Lands in `~/claude-config` as | `/self-update` distributes it via |
|---|---|---|
| each generic skill `<name>.md` | `~/claude-config/skills/<name>/SKILL.md` | the existing skills-sync loop (`cp SKILL.md → ~/.claude/commands/<name>.md`) |
| generic `~/.claude/CLAUDE.md` rules | a new `~/claude-config/CLAUDE.md` (or a `claude-md/generic.md` the sync appends) | a new sync step (small addition to `self-update.md`) |
| `CONTROLLER.md` + `tools/dev-pipeline/` | `~/claude-config/` (e.g. `controller/`, `tools/`) | a new sync step (copies into `~/.claude/`) |
| `projects-registry.md` | NOT synced (machine-local; lists this machine's project roots) | — |

**Two sub-options (DP-10):** **(a)** put the generic dev-kit in the **existing** `~/claude-config` repo (one personal-config repo, simplest now); **(b)** a **separate** `claude-devkit` repo that `~/claude-config` references (cleaner for the eventual public release, more setup). **Recommendation: (a) now** (land it in `~/claude-config`, extend `/self-update` to sync the new generic CLAUDE.md + controller + tools), **(b) at the public-release step** (D10, deferred) — split the dev-kit out into its own repo then. `/self-update.md` itself needs a small edit to add the new sync steps (it's a user-level skill — orchestrator-editable).

## B7 — THE CRUX, restated with the (i) guarantee

**Q: simultaneous two-project — a sub-agent working on project B resolves B's config, not the orchestrator's project A?**
**A (validated):** Claude Code does NOT auto-guarantee this — sub-agents inherit the parent's single cwd and per-subagent cwd is unshipped (issues #31940/#12748). **The design guarantees it via the explicit per-dispatch `PROJECT_ROOT`/`PROJECT_CONFIG` binding (B4.2):** the generic skills (now at user level, shared) read every project fact from the `PROJECT_ROOT` handed to them in the brief, so a B-agent and an A-agent alive at the same time each operate on their own project's config — independent of cwd. The user-level generic core makes the *skills* shared (one copy); the explicit binding makes the *project* per-dispatch. **This is the whole point of (i) + explicit binding together.**

## B8 — EXECUTION SEQUENCE (concrete, (i))

| Step | Action | Who | Gated? |
|---|---|---|---|
| H1 | Expand `docs/PROJECT_CONFIG.md` to COMPLETE (all anchors) | me | non-gated |
| H2 | Write `docs/development/GENERIC_CORE_MANIFEST.md` (lift-list, with `~/.claude/` destinations) | me | non-gated |
| H3 | Deliver the **agnostic-edit change-set spec** (per generic skill, exact old→new; B3) + the CLAUDE.md-split spec (B5) | me (spec) | spec only |
| H4 | Apply agnostic edits to the 10 generic skills (in-repo first, so they're clean before the move) | team-lead (Edit) | gated |
| H5 | **Move** the 10 cleaned generic skills `<repo>/.claude/commands/*.md` → `~/.claude/commands/` (PowerShell `Move-Item`); **delete** any project copy left (B0/B1) | orchestrator (`.claude/` is orchestrator-only) | orchestrator |
| H6 | Append generic rules to `~/.claude/CLAUDE.md`; trim `<repo>/.claude/CLAUDE.md` to project-only + precedence header | orchestrator | orchestrator |
| H7 | Hoist `CONTROLLER.md` + `tools/dev-pipeline/` to `~/.claude/` (or config path); update script root-env convention | team-lead/orch | mixed |
| H8 | Reflect everything into `~/claude-config` + extend `/self-update` (B6) | orchestrator | orchestrator |
| H9 | **VERIFY:** generic skills at `~/.claude/commands/` contain ZERO Pianoid tokens (grep gate); `<repo>/.claude/commands/` has ONLY project skills (no shadowed dupes); lint clean; Pianoid still works (a `/dev`-style dry run resolves Pianoid's PROJECT_CONFIG via PROJECT_ROOT); a 2nd-project dry-run dispatch resolves a different config | mixed | — |

## B9 — Blocker / risk needing the user

- **No hard blocker.** The mechanism is validated and (i) is fully supported.
- **★ Behavioral blast radius the user must accept:** hoisting `dev`/`orchestrator`/etc. to `~/.claude/commands/` makes them active in **EVERY** Claude Code session on this machine, **immediately** — including non-Pianoid and ad-hoc sessions. A generic `/dev` invoked in a random directory will look for `$PROJECT_ROOT/docs/PROJECT_CONFIG.md` and, finding none, must **degrade gracefully** (the agnostic preamble must say: "if no `PROJECT_CONFIG.md` is found, ask the user for the project root / build+test+run commands, or fall back to generic defaults"). This graceful-no-config path is REQUIRED before hoist (else every non-configured project gets a confused `/dev`). **Flag for the user: the generic skills become machine-global the moment they're hoisted.**
- **Precedence gotcha (now handled):** personal-overrides-project means the project copies MUST be deleted on hoist (B0/B1) — if missed, the project's stale `dev.md` is silently ignored and edits to it do nothing. The H9 grep gate catches this.
- **`/self-update` edit:** the sync skill needs new steps for the generic CLAUDE.md + controller + tools (B6) — small, user-level, orchestrator-editable.

## B10 — New decision points (this addendum)

- **DP-8 — `test-ui`:** hoist now as generic `/verify` (surfaces from config) **or** keep project-level this pass [rec: keep this pass, hoist as `/verify` later].
- **DP-9 — dev-pipeline scripts:** hoist to `~/.claude/tools/` [rec] vs leave in-repo + reference by path.
- **DP-10 — config-repo home:** land the generic kit in the existing `~/claude-config` now [rec] vs a separate `claude-devkit` repo (defer to public release).
- **DP-11 — graceful-no-config path (REQUIRED):** confirm the generic skills must handle "no `PROJECT_CONFIG.md` found" by prompting/falling-back (needed because hoist makes them machine-global). [rec: yes, mandatory part of the agnostic edits.]

---
---

# ADDENDUM 3 (2026-06-11) — CONCRETE (ii) EXECUTION PLAN (DECIDED: stage-in-repo-first)

**User decision:** **(ii) STAGE in-repo first** (over (i) hoist), comprehensive (all fact-classes, port-sweep in). This addendum is the concrete (ii) execution plan and supersedes Addendum-2's (i) specifics. *(Addendum-2 stays as the validated reference for the eventual hoist (MS7).)*

## C0 — The skill-staging mechanism (VERIFIED) — RECOMMENDATION: (a) MARK-IN-PLACE

> The (ii) key unknown: `@`-import covers CLAUDE.md RULES, but **skills/commands load ONLY from `.claude/commands/` + `.claude/skills/` (project, walking up to repo root) and `~/.claude/` (user)** — a top-level `generic-core/commands/` would NOT auto-load. Verified the three options against the docs + an empirical symlink test:

**VERIFICATION (official docs `code.claude.com/docs/en/skills` + a local test):**
- **A top-level `generic-core/commands/` is NOT loaded.** Docs (verbatim): *"Other `.claude/` configuration such as **subagents, commands, and output styles is not loaded from additional directories**."* Even `--add-dir` only loads `.claude/skills/` (an explicit exception), NOT `.claude/commands/`. So a non-`.claude/` directory cannot supply skills. **[HIGH]**
- **`.claude/commands/` symlink-loading is UNVERIFIED + Windows-fragile.** The docs document symlinks **only for `.claude/rules/`** (*"`.claude/rules/` directory supports symlinks"*) — they say **nothing** about `.claude/commands/` resolving symlinks. Empirical test on THIS box: a real symlink could not be created reliably — `ln -s` under MSYS/Git-Bash silently produced a **regular-file copy** (`-rw-r--r--`, not `lrwxrwxrwx`), and native Windows symlinks need Admin/Developer Mode (already flagged in memory). So option (b) hinges on **two** unverified/fragile things: (1) does the commands loader follow a symlink? (undocumented) and (2) can we even make a real symlink here? (no, not reliably). **(b) is NOT safe to rely on.**
- **(c) sync/build-copy works** but adds a build step + a second physical copy that can drift from the source (the exact disease we're curing) unless the copy is generated + gitignored — more mechanism for no separation benefit during staging.

**RECOMMENDATION: (a) MARK-IN-PLACE.** The generic skills **stay physically in `<repo>/.claude/commands/`** (guaranteed to load), each **tagged generic** (frontmatter `tier: generic` + a one-line header banner) and **made project-agnostic** (the real work). The "distinct unit" is established **logically** by: the `GENERIC_CORE_MANIFEST.md` (the authoritative lift-list), the per-file `tier: generic` tag, and the agnostic content itself (zero Pianoid tokens → demonstrably liftable). **The physical move is deferred to the hoist (MS7) — and is then trivial: `Move-Item` the files tagged `tier: generic` to `~/.claude/commands/`.**

| Option | Loads in-repo? | Physical separation now | Risk | Verdict |
|---|---|---|---|---|
| **(a) mark-in-place** | ✅ guaranteed (they're in `.claude/commands/`) | logical (tag + manifest + agnostic content) | **lowest** | **RECOMMENDED** |
| (b) generic-core/ + symlink into `.claude/commands/` | ⚠️ ONLY if the commands loader follows symlinks (undocumented) AND a symlink can be made (Windows: no, not w/o Dev Mode) | physical | **high** (two unverified deps) | not safe |
| (c) generic-core/ + sync-copy → `.claude/commands/` | ✅ after the copy step | physical, but a 2nd copy that can drift | medium (build step + drift risk) | over-mechanism for staging |

**Trade-off stated plainly:** (a) gives **logical/marked** separation (least disruptive, the agnostic content is the proof of liftability); (b)/(c) give **physical** separation but (b) is unsafe here and (c) re-introduces a copy. Since the user wants "comprehensive" *separation of concerns* (not necessarily physical relocation **now**), (a) achieves the goal — the skills become genuinely project-agnostic + clearly marked + manifest-listed — and the eventual hoist is the physical step. **(a) is the safe, correct choice; (b)/(c) buy physical relocation we get for free at hoist-time anyway.**

> **Net for (ii):** there is NO `generic-core/commands/` directory. The generic skills live in `.claude/commands/`, tagged + agnostic. The `generic-core/` staging dir (DP-5) holds only the things that DON'T have the loader constraint — the generic **CLAUDE.md rules** (which `<repo>/.claude/CLAUDE.md` `@`-imports) and a pointer/README. (Or skip a `generic-core/` dir entirely and keep the generic CLAUDE.md at `.claude/CLAUDE.generic.md` — see C2.)

## C1 — What this (ii) pass produces (the end state)

```
<repo>/.claude/
  CLAUDE.md                      # thin: project preamble + @-import of CLAUDE.generic.md + project rules (or → CLAUDE.project.md)
  CLAUDE.generic.md              # GENERIC methodology rules (project-agnostic, liftable) — @-imported by CLAUDE.md
  commands/
    dev.md  fn.md  multitask.md  orchestrator.md  review.md  analyse.md  update-docs.md  sync.md  cli-control.md
                                 #   ^ GENERIC skills — tagged `tier: generic`, project-agnostic (resolve $PROJECT_ROOT/docs/PROJECT_CONFIG.md)
    diagnose.md  pianoid-ui.md  startup.md  update-pianoid.md  test-ui.md
                                 #   ^ PROJECT skills — tagged `tier: project` (test-ui stays project this pass, DP-8)
docs/PROJECT_CONFIG.md           # the COMPLETE project SSOT (H1 — done)
docs/development/GENERIC_CORE_MANIFEST.md   # the lift-list (H2 — done; the authoritative "which files are generic")
```

No `generic-core/commands/` (loader constraint, C0). The generic/project boundary is carried by: **`tier:` frontmatter tags + the manifest + the agnostic content + the CLAUDE.md split.** At hoist (MS7): move the `tier: generic` skills → `~/.claude/commands/`, the generic CLAUDE.md → `~/.claude/CLAUDE.md` / `~/claude-config`.

## C2 — The CLAUDE.md generic/project split + `@`-import wiring

**Mechanism (VERIFIED — Addendum-1 A1):** `@path` imports load at session start; relative paths resolve relative to the importing file; user+project are additive; "state precedence explicitly in the more specific file."

**This pass:**
- **`<repo>/.claude/CLAUDE.md`** becomes thin:
  ```markdown
  # Pianoid — Claude instructions
  @CLAUDE.generic.md      <!-- the project-agnostic methodology rules (liftable to ~/.claude/CLAUDE.md at hoist) -->

  ## Project-specific rules (Pianoid) — these OVERRIDE conflicting generic defaults above
  <UI Interaction · Backend Startup · Startup/Build-Failure · Build&Env · Frontend Standards · Key Paths>
  ... each sourcing docs/PROJECT_CONFIG.md#<anchor> ...
  ```
  (Keeping the project rules inline in `CLAUDE.md` after the `@`-import is fine — or split them to `CLAUDE.project.md` and `@`-import both. **Rec: project rules inline** in `CLAUDE.md`, generic rules in the `@`-imported `CLAUDE.generic.md` — one import, clean split, the generic file is the liftable artifact.)
- **`<repo>/.claude/CLAUDE.generic.md`** (NEW, project-agnostic): the GENERIC sections (Autonomy/no-direct-skill-exec, the permission-suppression lesson + failure-mode catalogue, Auto-Trigger, Documentation-First rule, Verification-Surface rule [generalized from Audio], Documentation-Links convention, Self-Update) — **zero Pianoid tokens** (project specifics → "see the active project's `docs/PROJECT_CONFIG.md`").
- The generic file is `@`-imported by `CLAUDE.md` now; at hoist it's **moved** to `~/.claude/CLAUDE.md` (appended) and the `@`-import line is dropped (user-level auto-loads).

> ⚠ **`.claude/` is orchestrator-only (gated for sub-agents).** So **I DRAFT** the full content of `CLAUDE.generic.md` + the trimmed `CLAUDE.md` (in the change-set spec); **team-lead/orchestrator CREATES `CLAUDE.generic.md` + edits `CLAUDE.md`.** (DP-2: confirm sub-agents can't create files under `.claude/` — assume not; orchestrator does it.)

## C3 — The project-agnostic edits (apply-ready change-set; team-lead applies via Edit)

Delivered as a **follow-up apply-ready spec** (one section per skill, exact old→new, each new_string verified lint-clean — the P0 method) once this plan's shape is confirmed. The edit classes (≈40–55 edits across the 9 generic skills [test-ui excluded this pass, DP-8]):

| # | Edit class | OLD → NEW pattern | Skills (≈edits) |
|---|---|---|---|
| 1 | **`tier: generic` tag + active-project banner** (NEW, each generic skill) | *(add to frontmatter)* `tier: generic` + a header line: "**Project-agnostic skill.** Resolve `$PROJECT_ROOT` from the dispatch brief's `PROJECT_ROOT` (or the repo root of the cwd if running in-project); all project facts come from `$PROJECT_ROOT/docs/PROJECT_CONFIG.md`. **If no `PROJECT_CONFIG.md` is found → graceful fallback (C5).**" | 9 (1 each) |
| 2 | **venv interpreter** | `PianoidCore/.venv/Scripts/python` → "the active project's interpreter (`PROJECT_CONFIG.md#interpreters`)" | dev, fn, multitask, orchestrator, sync (≈6) |
| 3 | **4-repo layout + branches** | the Core/Tunner/Basic/Install table → `PROJECT_CONFIG.md#repos` | orchestrator, sync, multitask, dev (≈4) |
| 4 | **ports + the kill-loop** (DP-4 in scope) | `3000/3001/5000/5001` → `#ports`; the `for port in … taskkill` loop → `python <devkit>/dev-pipeline/env_sweep.py` | dev (×3), orchestrator, diagnose*, pianoid-ui* (≈6) |
| 5 | **`## Key Paths` table** | the per-skill table → `PROJECT_CONFIG.md#key-paths` | dev, fn, multitask, analyse (4) |
| 6 | **build / REST / preset / frontend names** | `build_pianoid_cuda.bat`, `/load_preset`, `note_playback`, MUI/ECharts → `#docs-first-build--run` / `#rest-endpoints` / `#verification-surfaces` / `#frontend-stack` | dev, fn, multitask, sync, analyse (≈4) |
| 7 | **`docs/PROJECT_CONFIG.md` location** | implicit Pianoid-root → `$PROJECT_ROOT/docs/PROJECT_CONFIG.md` | all that reference config |
| 8 | **team name** | `pianoid-dev` → "the active project's team (`PROJECT_CONFIG.md#team`)" | orchestrator (1–3) |
| 9 | **channel** | Telegram-specific paths → `PROJECT_CONFIG.md#channel` | orchestrator (several) |

\* `diagnose`/`pianoid-ui` are PROJECT skills but carry the port-sweep loop — their loops also swap to `env_sweep.py` (a project skill may still use the generic script); they keep their Pianoid content otherwise.

**Scripts (`tools/dev-pipeline/`):** add a `DEVKIT_PROJECT_ROOT` env alias for `PIANOID_REPO_ROOT` (accept both) so a generic skill can point the script at the active project. Non-gated (`tools/` — I can do this) OR fold into the change-set; recommend I do the script alias now (it's `tools/`, non-gated) so the skills can reference the generic form.

**Estimated total:** ~40–55 generic-skill edits (orchestrator ~15, dev ~8, rest 1–5) + the CLAUDE.md split (C2) + the `tier:` tags on the 5 project skills (trivial). Each new_string lint-verified before handover.

## C4 — `update-pianoid` / `test-ui` this pass

- **`test-ui`** — **PROJECT this pass (DP-8 rec).** Tag `tier: project`. Hoist as generic `/verify` in a later pass once `#verification-surfaces` is exercised. (It's the most chrome/`note_playback`/MUI-entangled "generic" skill — agnostic-izing it now is disproportionate.)
- **`update-pianoid`** — **PROJECT.** Tag `tier: project`. (Names the 4 repos + build flags + required-MCP list; generalize to `/update-project` later.)

## C5 — DP-11: graceful-no-config fallback (DESIGN — required by the agnostic banner)

A generic skill (`/dev`, etc.) may be invoked where no `PROJECT_CONFIG.md` exists (a different project, an ad-hoc dir). Even though (ii) keeps the skills in Pianoid's repo (so Pianoid's config is always found here), the **agnostic banner must specify the fallback** so the skill is genuinely portable + the hoist (MS7, machine-global) is safe. The designed fallback, in order:

1. **Resolve `PROJECT_CONFIG.md`:** look for `$PROJECT_ROOT/docs/PROJECT_CONFIG.md` (from the dispatch `PROJECT_ROOT`), else walk up from cwd for `docs/PROJECT_CONFIG.md` or `.claude/PROJECT_CONFIG.md`.
2. **If found:** use it (the normal path).
3. **If NOT found:** the skill does NOT guess Pianoid defaults. It **(a) tells the user** "no `PROJECT_CONFIG.md` found for this project — I'll use generic defaults / please provide build, test, run commands + repo layout (or run `devkit init`)", and **(b) falls back to generic defaults**: build = none/`make` if a Makefile exists; test = the detected runner (pytest/jest/cargo/go) ; run = a detected start script; ports = none assumed; verification = "run the app + observe" (the generic verify stance). **(c)** it proceeds with what the user supplies, and offers to scaffold a minimal `PROJECT_CONFIG.md`.
4. **Never** apply one project's facts to another (no hardcoded Pianoid build/ports when config is absent).

This is a small, bounded addition to the agnostic banner (a "Config resolution" sub-section in each generic skill, or — better — ONE shared paragraph in `CLAUDE.generic.md` that all generic skills reference). **Rec: put the resolution+fallback algorithm ONCE in `CLAUDE.generic.md#config-resolution`; each generic skill's banner says "resolve config per CLAUDE.generic.md#config-resolution".** (SSOT for the resolution logic too.)

## C6 — WHO DOES WHAT (non-gated me vs gated team-lead)

| Work | Who | Gated? |
|---|---|---|
| H1 PROJECT_CONFIG.md complete | me (done) | non-gated |
| H2 GENERIC_CORE_MANIFEST.md | me (done) | non-gated |
| `DEVKIT_PROJECT_ROOT` alias in `tools/dev-pipeline/` | me | non-gated (`tools/`) |
| (optional) a `generic-core/README.md` pointer if DP-5 wants a marker dir | me | non-gated |
| **DRAFT** `CLAUDE.generic.md` content + the trimmed `CLAUDE.md` + the `#config-resolution` paragraph | me (in the change-set spec) | spec only |
| **DRAFT** the ~40–55 per-skill agnostic edits (old→new) + the `tier:` tags | me (in the change-set spec) | spec only |
| CREATE `<repo>/.claude/CLAUDE.generic.md`; edit `<repo>/.claude/CLAUDE.md` (thin + `@`-import + project rules) | team-lead/orchestrator | gated (`.claude/`) |
| APPLY the per-skill agnostic edits + `tier:` tags via Edit | team-lead | gated (`.claude/`) |
| VERIFY: lint clean; generic skills = ZERO Pianoid tokens (grep gate); `@`-import loads; Pianoid still works (a /dev-style dry run resolves Pianoid's config); the manifest matches | mixed | — |

## C7 — DECISION POINTS resolved / open for (ii)

- **DP-1 = (ii)** ✓ (confirmed). **DP-3 = all fact-classes** ✓. **DP-4 = port-sweep in** ✓. **DP-8 = test-ui project this pass** ✓ (rec). **DP-11 = graceful-no-config** ✓ designed (C5).
- **DP-5 (staging location/name) — RESOLVED by C0:** since generic skills can't physically live outside `.claude/commands/`, there is **no `generic-core/commands/`**. The only "staging" artifact is `CLAUDE.generic.md` (kept at `.claude/CLAUDE.generic.md`, `@`-imported). **Rec: no separate `generic-core/` dir** — the manifest + `tier:` tags + the agnostic content ARE the unit; a `generic-core/` dir would only hold the README/pointer (optional). *(If the user wants a visible marker dir, `generic-core/` can hold `README.md` + a copy-of-manifest pointer — cosmetic.)*
- **DP-9 (dev-pipeline scripts) — for (ii): leave in `tools/dev-pipeline/`** (already there, already loaded by the generic skills via path); just add the `DEVKIT_PROJECT_ROOT` alias. Hoist to `~/.claude/tools/` at MS7.
- **DP-2 (sub-agent `.claude/` file creation):** assume sub-agents CANNOT create files under `.claude/` → team-lead/orchestrator creates `CLAUDE.generic.md`. (Confirm.)

## C8 — Execution sequence (ii)

| Step | Action | Who | Gated? |
|---|---|---|---|
| ✅ H1 | PROJECT_CONFIG.md complete | me | done |
| ✅ H2 | GENERIC_CORE_MANIFEST.md | me | done |
| C-1 | `DEVKIT_PROJECT_ROOT` alias in dev-pipeline + (optional) `generic-core/README.md` marker | me | non-gated |
| C-2 | DELIVER the change-set spec: `CLAUDE.generic.md` content + trimmed `CLAUDE.md` + `#config-resolution` + the ~40–55 per-skill agnostic edits + `tier:` tags (all old→new, lint-verified) | me (spec) | spec |
| C-3 | Orchestrator creates `CLAUDE.generic.md` + edits `CLAUDE.md`; team-lead applies the per-skill edits + tags | team-lead/orch | gated |
| C-4 | VERIFY (C6 row) | mixed | — |
| (later) MS7 | HOIST: move `tier: generic` skills → `~/.claude/commands/`, generic CLAUDE.md → `~/.claude/`/`~/claude-config`, extend `/self-update`, drop the `@`-import | separate approval | gated |

## C9 — Blocker / risk

- **No hard blocker.** (ii) is fully supported; the staging mechanism is settled (mark-in-place).
- **One honesty note:** under (ii)+mark-in-place, the generic skills physically remain in Pianoid's `.claude/commands/` until the hoist — so the separation this pass is **logical (tag + manifest + agnostic content)**, not physical relocation. That is the correct (ii) shape (the user chose stage-first); the *value* — genuinely project-agnostic, clearly-marked, manifest-listed, lint-guarded skills — is fully delivered now, and the physical move is a trivial later step. **The agnostic-ization (zero Pianoid tokens) IS the real separation; the directory location is cosmetic until hoist.**
- **The grep gate (C4/C6) is the proof:** after the agnostic edits, `grep -iE 'pianoid|PianoidCore|3000/3001/5000/5001|build_pianoid|note_playback' <generic skill>` must return ZERO — that's the machine-checkable "this skill is liftable" assertion (and a candidate `lint_skills.py` rule).
