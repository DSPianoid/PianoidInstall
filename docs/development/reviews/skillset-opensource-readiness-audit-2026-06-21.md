# Skillset Open-Source-Readiness Audit — 21 skills vs the governing proposals (2026-06-21)

**What this is:** a deep review of every skill in `.claude/commands/` against the two governing
proposals, to answer one question — *how close is the dev-kit to open-source publishing, and what
remains?* Coupling is **measured** (grep token counts per skill), not eyeballed.

**Governing documents (the principles judged against):**
- **`docs/proposals/generic-dev-skillset-opensource-2026-06-11.md`** — THE encompassing proposal.
  Principles CP1–CP7, architectural AP1–AP8, flows FD–FO, modules **M1–M12**, publishing decisions
  D1–D11, roadmap **P0–P5** (P5 = public release). This is the spine.
- **`docs/proposals/model-agnostic-agents-2026-06-19.md`** — the "model-agnostic" runtime half
  (per-role model routing; mostly *supervisor code*, shipped dormant). Relevant to each skill only as
  a **model-agnostic-readiness** lens (does the skill's text hardcode Claude-only assumptions?).

**Method:** 4 parallel read-only review agents, one per skill group, each mapping every skill to its
proposal module, scoring principle correspondence, **grep-measuring project/channel/model coupling**,
and listing concrete finalization actions.

---

## 1. Executive summary

**The methodology core is strong and substantially publish-worthy; the *packaging* is not yet.** The
generic workflow skills already realize CP1/CP5/CP6/FF/FK faithfully and — importantly — are **nearly
free of Pianoid-domain tokens** (project facts are already externalized to `PROJECT_CONFIG.md` anchors
+ per-skill `skill-examples/*.md` companions). AP3 generic/project separation is **largely done for
the core**.

The remaining work is **four other kinds of coupling + four module-map corrections**, not domain
de-Pianoid'ing:

1. **Channel coupling** — Telegram + named personal MCP servers are hardwired into `orchestrator.md`
   (≈50 mentions), violating AP8/M10 "code to the adapter contract, not one channel."
2. **Model coupling** — Claude-teams tools (`SendMessage`/`Monitor`/`Skill`) assumed across the
   dispatch skills, and a **hardcoded `Claude Opus 4.8 (1M context)` commit trailer** in `sync.md`.
3. **Toolchain coupling** — `update-docs.md` hardwires MkDocs; `cli-control.md` hardwires
   Windows/VS-Code/`claude.exe` keystroke glue.
4. **The five project-specific skills** (startup/diagnose/pianoid-ui/test-ui/update-pianoid) are
   genuinely project-tier (24–125 tokens each, ≈360 total) — they need the generic-spine extraction +
   fact-externalization the kit prescribes.

Plus four **module-map contradictions** the kit must resolve before it can ship a coherent module set:
`multitask` should fold into M1, `/review` collides with the built-in and needs renaming, `dev`'s
`MODULE_LOCKS` mechanism is the thing the proposal **explicitly replaces**, and `cli-control` is the
legacy keystroke workaround M12 is designed to **subsume**.

**Publish-readiness tally (21 skills):**

| Verdict | Count | Skills |
|---|---|---|
| **READY** (ship ~as-is) | 1 | `compose-proposal` |
| **NEEDS-LIGHT-WORK** | 3 | `fn`, `analyse`, `sync` |
| **NEEDS-WORK** (substantive) | 4 | `orchestrator`, `dev`, `review`, `update-docs` |
| **FOLD / SUBSUME** (don't ship standalone) | 2 | `multitask`→M1, `cli-control`→M12 |
| **GENERALIZE** (extract generic mechanism) | 2 | `setup-mcp`, `self-update` |
| **PROJECT-TIER** (extract spine → externalize → keep private as D9 example) | 5 | `startup`, `diagnose`, `pianoid-ui`, `test-ui`, `update-pianoid` |
| **EXCLUDE** (D8 personal → private pack) | 4 | `setup-google-workspace`, `setup-hostinger-email`, `pair-whatsapp`, `project-management` |

---

## 2. Skill → module → disposition matrix

| Skill | Proposal module | Project coupling (measured) | Model/channel coupling | Disposition |
|---|---|---|---|---|
| `orchestrator.md` | **M1** Orchestrator | LIGHT (≈0 domain; ~50 Telegram) | HEAVY (teams + channel) | NEEDS-WORK |
| `dev.md` | **M2** /dev | GENERIC-CLEAN (1 example) | LIGHT (Skill/SendMessage) | NEEDS-WORK |
| `fn.md` | **M3** /fn | LIGHT (numpy/cupy examples) | GENERIC (mostly) | NEEDS-LIGHT-WORK |
| `multitask.md` | **FOLD → M1** (+ M8 tooling) | LIGHT (illustrative) | LIGHT | FOLD |
| `compose-proposal.md` | §0.10b proposal author | **GENERIC-CLEAN (0)** | **GENERIC (0)** | **READY** |
| `review.md` | **M4** /review ⚠ | GENERIC-CLEAN | GENERIC | NEEDS-WORK (rename) |
| `analyse.md` | **M5** /analyse | GENERIC-CLEAN (illustr.) | GENERIC | NEEDS-LIGHT-WORK |
| `update-docs.md` | §0.10d doc-system (M4/M8 arm) | GENERIC-CLEAN; MkDocs-coupled | GENERIC | NEEDS-WORK |
| `sync.md` | **M9** Version-Control Mgr | GENERIC-CLEAN (0) | model trailer only | NEEDS-LIGHT-WORK |
| `cli-control.md` | **SUBSUME → M12** | 0 domain; HEAVY platform | Claude-CLI structural | EXCLUDE/SUBSUME |
| `startup.md` | (generic `/startup` + M8) | **HEAVY (87)** | n/a | PROJECT-TIER |
| `diagnose.md` | (§0.11 capability-doctor + FF) | **HEAVY (125)** | n/a | PROJECT-TIER |
| `pianoid-ui.md` | (generic `/run` + M10/M12) | HEAVY (48) | chrome-MCP (pluggable) | PROJECT-TIER |
| `test-ui.md` | (generic `/verify` + FF) | LIGHT (24) | GENERIC | PROJECT-TIER (GENERALIZE) |
| `update-pianoid.md` | **M9 + M8** (split) | HEAVY (76) | n/a | PROJECT-TIER (GENERALIZE) |
| `setup-mcp.md` | AP8/D8 MCP-extension | personal recipes | n/a | GENERALIZE (extract kernel) |
| `setup-google-workspace.md` | D8 personal MCP | personal account | n/a | EXCLUDE |
| `setup-hostinger-email.md` | D8 personal MCP | provider-specific | n/a | EXCLUDE |
| `pair-whatsapp.md` | D8 personal MCP / M10 | machine-local | n/a | EXCLUDE |
| `project-management.md` | D8 personal-assistant | densest personal | n/a | EXCLUDE |
| `self-update.md` | `devkit update` (∼M11 companion) | personal bindings | n/a | GENERALIZE |

---

## 3. How the skillset corresponds to the principles

### Where it is strong (genuinely realized)
- **CP1 autonomy + FF test-yourself** — exemplary across `dev` (baseline→verify gate), `test-ui` (the
  reproduce→measure→before/after→pass-fail loop *is* FF), `diagnose` (reproduces the real mic→speaker
  experience with SNR proof; the mic-loopback gate is the §0.11 capability-doctor done right).
- **CP5 quality gates** — `dev`'s P1/P2 authority-&-concern gate before writing code; `review`'s
  three-level Critical/High-blocks rubric; `sync`'s **Step 5.5 post-merge rebuild gate** (compiled-diff
  → rebuild → 2-level smoke-test → *then* push) is the best single CP5/FF realization in the kit.
- **CP6 cost-tiering** — `dev` Step-4b → `fn` is a clean, provider-neutral script→cheap-model→frontier
  seam ("delegated output is never trusted, only tested").
- **CP7 safety** — uniform and correct: **port/PID-scoped kills everywhere, zero blanket image-name
  kills**, confirm-before-push, never-force-push, DryRun-first. This is the kit's strongest principle.
- **CP4 traceability & §0.10b governance** — `compose-proposal` *is* the operationalized
  traces-to/governed-top-down discipline (it authored both proposals); `analyse` enforces
  one-doc-per-topic + the T1 artifact taxonomy.
- **AP3 generic/project separation (for the core)** — `compose-proposal` (0 tokens), `sync` (0), `dev`
  (1), `review`/`analyse`/`update-docs` (≈0 domain) prove the resolve-from-`PROJECT_CONFIG.md` +
  `skill-examples/` pattern works. **This group is the model for the separation.**

### Where it diverges from the target design
- **FN adaptive user-interaction loop is absent.** M1's signature new capability — the three
  meta-choices (GO-AS-RECOMMENDED / DECIDE-YOURSELF / EXPLAIN) + response-statistics + the autonomy
  dial under the CP7 floor — appears **nowhere**. Only the modality (voice/text) axis exists.
- **AP7 multi-project binding is documented, not operational.** `$PROJECT_ROOT` is named in headers but
  **no spawn template injects it**; two skills hardcode absolute paths (`D:/repos/.../PianoidTunner`;
  `C:/Users/astri/.claude.json`).
- **M4 `/review` does only half its job** — the **FL semantic doc-audit** (docs-match-*measured*-
  behavior) it is assigned lives in `analyse`/`update-docs` instead.
- **AP4 "same gate on every tier" is under-stated** — `review` never says findings apply identically to
  cheap-model output.

---

## 4. Publishing blockers (grouped, ranked)

### A. Module-map contradictions (must resolve — the kit currently contradicts its own proposal)
1. **`multitask` vs M1 subsumption + FM double-encoding.** The parallel-dev flow (FM) lives in **two**
   non-canonical places — standalone `multitask.md` AND inline in `orchestrator.md` (the worktree +
   merge-sweep sections) — while the proposal puts it in **M1 + M8 tooling**. `compose-proposal.md`
   itself names this exact fold ("a 'multi-task' capability folds into the coordinator"). → Fold FM into
   M1, move overlap/port/GPU-token mechanics to M8, leave a one-line pointer where `multitask` was.
2. **`/review` name collision.** `review.md` → `/review` shadows the **built-in `/review`** and overlaps
   the built-in `/code-review`. → **Rename to `code-quality-review`** (the proposal's first option), and
   fold in the missing FL doc-audit.
3. **`dev`'s `MODULE_LOCKS` vs §0.10e.** The advisory per-file lock apparatus (Step 4) is precisely what
   §0.10e **"replaces ... with deterministic partition + worktree isolation."** Shipping as-is publishes
   a superseded mechanism as canonical. → Migrate to the worktree-partition model (locks → GPU/runtime
   token only), or mark it explicitly transitional.
4. **`cli-control` → M12.** It is the legacy keystroke/monkey-patch glue the supervisor (M12, D2,
   roadmap-P2 "retire the keystroke/patch glue") is built to dissolve. → Do not publish as a user skill;
   port its two capabilities (remote clear+relaunch; release a stuck invisible-prompt agent) into M12 as
   programmatic operations, carrying its safety design (DryRun-first, verify-before-clear, receipt-nonce)
   forward as M12 requirements.

### B. AP3 separation for the five project-tier skills (the largest extraction effort)
Each decomposes into the proposal's three layers: a **generic spine** (extract once), a
**`PROJECT_CONFIG.md` fact-set** (externalize), and a **private D9 dogfood example** (keep). They also
reveal **generic modules the kit is missing** (see §C/D below). Measured coupling: diagnose 125 ·
startup 87 · update-pianoid 76 · pianoid-ui 48 · test-ui 24.
- `test-ui` → the generic **`/verify`** skill (it *is* FF) — lowest coupling, the ready-made template.
- `pianoid-ui` → the generic **`/run`** (drive-app-via-UI) skill — browser-driving is triplicated across
  pianoid-ui/test-ui/diagnose, so the missing `/run` is the strongest "missing-module" signal.
- `startup` → a generic **`/startup` (recover-stack)** skill backed by M8 rebuild-fn + port-sweep.
- `diagnose` → the **§0.11 capability-doctor / `devkit doctor`** (declare surfaces → probe-reachable /
  skip-unreachable-loudly → measure → dated evidence report).
- `update-pianoid` → **splits into M9 (git-update) + M8 (rebuild function)** per the proposal's explicit
  "legacy `/update` dissolves here."

### C. AP8 pluggability / model-agnostic coupling (in the core skills)
- **Channel:** abstract Telegram + personal-MCP names in `orchestrator.md` behind the M10 adapter
  contract; keep "Telegram = reference channel" as one pointer.
- **Model/commit-trailer:** the `Claude Opus 4.8 (1M context)` `Co-Authored-By` literal (`sync.md` + the
  machine-global commit rule) must become a **config/runtime-resolved agent attribution**.
- **Teams plumbing:** gate `SendMessage`/`Monitor`/`Skill`/`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`
  behind a "when orchestrated under Claude teams" abstraction (orchestrator's new **Mode-A/B/D split is
  the leading edge** — it already marks teams Claude-specific and makes model-agnostic dispatch the
  default; propagate that stance to dev/fn/multitask).
- **Doc toolchain:** `update-docs.md` MkDocs commands → a config-resolved doc-build command.

### D. Missing generic modules the audit surfaced
Of M1–M12: M1/M2/M3/M4/M5/M9 have skill realizations; **M11 Init tool (`devkit init`) is unbuilt** (the
P5 onboarding generator); M6 Controller lives inline in `orchestrator` (proposal wants it split to a
script + gated cheap-model — P4); M7/M8/M10/M12 are partial/in-flight. The project-tier skills argue the
kit should also surface **`/verify`, `/run`, `/startup`** as first-class generic skills (today they are
only flows/§0.11), plus the **`add-mcp-server`** kernel (from `setup-mcp`) and **`devkit update`** (from
`self-update`).

### E. SSOT / DRY duplication (AP2 — "drift can't recur")
- The **controller marker grammar** is duplicated verbatim in `dev` + `fn` → extract to one shared doc.
- The **detached-`Start-Process` launch block** is triplicated across pianoid-ui/test-ui/diagnose →
  one M8/M12 launch helper.
- The **"2026-04-23 stale-.pyd war-story"** recurs in all five project skills → one PROJECT-RULES caution.
- `test-ui`'s **~100-line logging boilerplate** (log before/after every tool call) is exactly the state
  the M12 supervisor captures structurally → delete, reference the supervisor's transcript capture.

### F. Safety / correctness fixes
- **`update-pianoid` Step 6 does `git push origin master` autonomously** — violates CP7
  confirm-before-push. Gate it on extraction.
- **Hardcoded absolute paths** (`D:/repos/.../PianoidTunner`, `C:/Users/astri/.claude.json`) violate
  AP7 → resolve from `PROJECT_ROOT`/harness.
- `OAUTHLIB_INSECURE_TRANSPORT=1` shipped without a security caveat (google-workspace) — moot once
  excluded, but note if any sample ships.

### G. Secret-handling convergence
MCP-server credentials are written **plaintext** to `~/.claude.json` (only `setup-hostinger-email` even
warns), while the model-agnostic campaign already specifies a **scoped, gitignored, redacted** secret
intake (`/setkey` → module M7). → Route MCP creds through the same scoped store: one CP7-compliant
secret path for both LLM keys and MCP creds.

---

## 5. Finalization plan (mapped to the proposal roadmap P1–P5)

**P1 — Generic/project separation + de-drift (the bulk of publishing readiness):**
1. Resolve the four module-map contradictions (§4.A): fold `multitask`→M1; rename `/review`→
   `code-quality-review` + add FL; reconcile `dev` locks↔§0.10e; mark `cli-control` for M12 subsumption.
2. Extract the five project-tier generic spines (§4.B) → new generic skills **`/verify`, `/run`,
   `/startup`** + the `devkit doctor` capability-probe; externalize every fact to `PROJECT_CONFIG.md`;
   keep the Pianoid skills private as D9 examples.
3. Abstract the channel + the commit-trailer + the doc-build tool + the teams plumbing (§4.C).
4. Kill the dead text / de-duplicate (§4.E); fix the safety/path items (§4.F).
5. Extract the `add-mcp-server` kernel from `setup-mcp`; generalize `self-update`→`devkit update`;
   relocate the four D8-excludes to a private personal-MCP pack.

**P2 — Supervisor app:** subsume `cli-control` into M12; let M12's transcript capture retire `test-ui`'s
logging boilerplate and the long-running-process launch workarounds.

**P3 — Verification gate + capability matrix:** promote `test-ui`→`/verify` and `diagnose`→`devkit
doctor`; generalize verification surfaces into `PROJECT_CONFIG.md`; add the warn-first→enforce gate.

**P4 — Tier migration:** split M6 Controller (inline in `orchestrator`) into a script core + a gated
cheap-model judgment layer; wire the M8 marker hook.

**P5 — Public release:** build the **`devkit init`** onboarding generator (M11, currently unbuilt);
MIT license (D3); a sanitized generic `examples/` project (D9); the kit's own CI (lint + tests +
capability-aware matrix); the permission allow-list as a `devkit init` artifact (§2c).

**Add to the proposal (the audit's two new findings):** (a) the kit needs first-class generic
**`/verify` + `/run` + `/startup`** skills — the project-tier skills prove they're missing; (b) the
**FN adaptive-interaction loop** (M1's signature capability) is unbuilt and should be a named P1/P3 item.

---

## 6. Decisions for the user (ranked)

1. **`/review` rename** → `code-quality-review` (vs. wrap the built-in `/code-review`). *Recommend rename.*
2. **`dev` locks** — migrate to §0.10e worktree-partition now, or keep `MODULE_LOCKS` as a labeled
   transitional mechanism? *(Load-bearing; affects dev + multitask + orchestrator.)*
3. **Confirm the four D8 excludes** (project-management + the 3 personal-server setups) leave the public
   kit for a private pack — and extract the `add-mcp-server` kernel + `devkit update` mechanism.
4. **Secret convergence** — route MCP creds through the model-agnostic M7 scoped store? (Couples this
   work to the model-agnostic campaign.)
5. **Scope of the project-tier extraction** — do all five generic spines now (`/verify`,`/run`,
   `/startup`,`devkit doctor`,M9+M8 split), or stage `/verify` first (lowest coupling, highest value)?

---

## Appendix — per-skill highlights (load-bearing only)

- **orchestrator.md (M1, NEEDS-WORK):** strong CP1/CP7/AP5(Controller inline)/FK; **gaps:** no FN loop,
  doesn't subsume multitask, ~50 Telegram + personal-MCP hardwired (AP8), heavy teams coupling, 1192-line
  multi-module monolith (extract M6 Controller + M10 channel/voice). Mode-A/B/D split = the right model-
  agnostic direction.
- **dev.md (M2, NEEDS-WORK):** textbook FF/CP5/CP6/AP6; **gaps:** `MODULE_LOCKS`↔§0.10e contradiction,
  REUSE-CHECK weaker than the mandated capability-index gate, marker grammar duplicated with fn. Domain-clean.
- **fn.md (M3, NEEDS-LIGHT):** cleanest dispatch skill; the CP6 cost seam done well. Generalize the
  numpy/cupy dual-backend examples; promote the REUSE-CHECK to a named gate.
- **multitask.md (FOLD→M1):** the most complete FM realization, but wrong module (standalone) + uses the
  older worktree-only model; neutralize Pianoid example strings; adopt the §0.10e LIGHT/HEAVY two-tier.
- **compose-proposal.md (READY):** the exemplary AP3 + model-agnostic citizen — **0 project tokens, 0
  Claude coupling.** Ship as-is; only link the forthcoming approval-procedure doc.
- **review.md (M4, NEEDS-WORK):** faithful FH/CP5; **rename** (collision) + **add the FL semantic
  doc-audit** (its assigned job, currently missing) + state cheap-model parity + resolve integration
  branch from config (drop bare `main`).
- **analyse.md (M5, NEEDS-LIGHT):** precise M5 + carries the FL doc-reconciliation `review` lacks;
  genericize the illustrative subsystem menu; reconcile Phase-2 in-place doc edits with `/update-docs`.
- **update-docs.md (NEEDS-WORK):** good CP2/CP7; **MkDocs hardwired** (AP8) — decouple the doc-build
  tool; move SVG house-style to a project styleguide.
- **sync.md (M9, NEEDS-LIGHT):** exemplary FK + the standout **Step 5.5 rebuild gate** + never-force-push;
  **one fix:** the hardcoded `Claude Opus 4.8 (1M context)` trailer → config/runtime attribution.
- **cli-control.md (EXCLUDE/SUBSUME→M12):** strong safety design but it *is* the workaround M12 dissolves;
  port capabilities + safety guarantees into the supervisor; `D:\tmp` hardcoded path.
- **startup/diagnose/pianoid-ui/test-ui/update-pianoid (PROJECT-TIER):** strong CP1/CP7; extract the
  generic spine (`/startup`,`devkit doctor`,`/run`,`/verify`,M9+M8) + externalize facts + keep private as
  D9 examples; fix update-pianoid's autonomous push + the two hardcoded absolute paths.
- **setup-mcp (GENERALIZE):** extract the ~5-line MCP-extension kernel → `add-mcp-server`; discard the
  four personal recipes to the private pack; de-hardcode `C:\Users\astri\…` paths.
- **setup-google-workspace / setup-hostinger-email / pair-whatsapp / project-management (EXCLUDE, D8):**
  bundled personal MCP / personal-assistant — relocate to a private pack; harvest two things into the
  generic core (the plaintext-secret caveat; the draft-before-send/confirm-before-outward rule → CP7/FJ).
- **self-update (GENERALIZE):** IS the kit-update mechanism; the credential-preserving MCP merge is the
  kernel — parameterize the config-repo URL + targets, drop MkDocs/personal-memory → `devkit update`.

**Source:** 4 read-only review agents (groups: core-workflow · quality/docs/VC/host · project-specific ·
personal/MCP/infra), each grep-measuring coupling and mapping to the proposal modules. No skill was
edited; this is an AUDIT report (read-only), findings vs the proposal rubric.
