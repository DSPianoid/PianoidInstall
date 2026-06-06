# Proposal: Modal Adapter facade — final slim to ~400 LOC (shim removal wave)

**Date:** 2026-06-06
**Status:** Proposed (follow-up to the completed 3-wave split).
**Author tag:** `[dev-wave3split-f634]` (Wave 3 wrap-up).
**Scope:** `PianoidCore/pianoid_middleware/modal_adapter/modal_adapter.py`
(currently 1,755 LOC after Wave 3) — the residual reduction from
~1,550 LOC of property shims + composition + delegations down toward the
proposal's original ~400 LOC target.
**Supersedes:** nothing. **Superseded by:** nothing.
**Related:**
- `docs/proposals/modal-adapter-split-2026-05-21.md` §6.1 (thin-facade
  contract), §9.2 (test-preservation mandate), §14 (implementation log)
- `docs/development/CODE_QUALITY.md` §C4 / §C4.1 (RED-flag + thin-facade
  policy)

---

## 0. Why this is a separate wave

The 3-wave Modal Adapter split (proposal 2026-05-21) is **complete**:
all 7 service modules are extracted, plus the Wave-2-deferred QC +
ESPRIT logic landed in Wave 3 (Option A). The facade dropped from
**4,253 → 1,755 LOC (−58.7%)** and is now pure composition + delegation
+ context-access shims.

The original proposal targeted **~400 LOC** for the facade. Wave 3
measurement showed that target is **blocked by one thing the proposal
did not fully account for**: the facade's `@property`/`@setter`
context-access shims (the `self._foo → self._ctx.foo` proxies) are
**referenced ~300+ times by external test code** (`adapter._projects_base`
41×, `a._tracked_chains` 40×, `adapter._mapping` 36×,
`adapter._measurements` 19×, …) AND by the facade's own composition
methods 60+ times. Proposal §9.2 mandates "Existing tests importing
`ModalAdapter` — Preserved." Removing the shims is therefore a
**test-migration project of its own** — out of scope for the
concern-extraction waves, and high-risk to bundle with them.

This proposal isolates that work so the ~400 LOC target is not lost.

---

## 1. Current facade composition (post-Wave-3, 1,755 LOC)

| Bucket | ~LOC | Removable? |
|---|---|---|
| `@property` / `@setter` ctx-access shims (33 + 26) | ~140 | Only after the 300-ref test rewrite |
| Composition methods (`data_status`, `state`, `get_project_state`, `reset`) | ~250 | No — genuine facade-level composition (read across all services) |
| `run_full_pipeline` + `_update_pipeline_progress` | ~170 | No — multi-service orchestration (P2: facade is the composition point) |
| ~80 one-line REST-delegation methods (the REST surface) | ~700 | No — these ARE the preserved REST API (§9.1) |
| `__init__` (composition of 10 services) | ~120 | No |
| module docstring + section comments + helpers | ~175 | Partially (cosmetic) |

**The only large removable bucket is the ~140 LOC of shims** — and only
after the test references move off them.

---

## 2. The work

### 2.1 Migrate the ~300 test references

For each `@property`/`@setter` shim, rewrite external test access from
`adapter._foo` to `adapter._ctx.foo` (the canonical home). Files
affected (by ref count, from the Wave-3 sweep):

- `tests/unit/test_modal_adapter_state.py` — the bulk (`a._tracked_chains`,
  `a._per_scenario_results`, `a._mapping`, `a._sample_rate`,
  `a._scenario_indices`, `a._chain_undo_stack`, `a._chain_redo_stack`,
  `a._feedin_data`, `a._tracked_chains_version`, …)
- `tests/integration/test_project_store.py`,
  `test_modal_copy_project.py`, `test_project_state_data_status_complete.py`,
  `test_v2_open_project_source_folder.py`,
  `test_add_scenarios_to_measurement.py`, others — `adapter._projects_base`,
  `adapter._project_dir`, `adapter._current_project`, `adapter._mapping`,
  `adapter._measurements`, `adapter._run_state`, `adapter._progress`,
  `adapter._applied`, …
- `pianoid_middleware/modal_adapter/routes/pipeline_routes.py:287` —
  `getattr(adapter, '_nuclei_stage_chains', [])` → route should read
  `adapter._ctx.nuclei_stage_chains` (or a new facade accessor).

Mechanical but large (~300 edits). A scripted `adapter._X → adapter._ctx.X`
rewrite (AST or careful regex with a field allow-list) makes it
tractable; each shim's field name maps 1:1 to a `ctx` field.

### 2.2 Rewrite the facade's own composition methods to read `ctx`

`data_status`, `state`, `reset`, `get_project_state` currently read
`self._mapping`, `self._measurements`, etc. Rewrite to `self._ctx.mapping`,
`self._ctx.measurements`, …  (these stay on the facade — they compose;
they just stop going through the shim indirection).

### 2.3 Delete the shims

Once §2.1 + §2.2 land, the 59 `@property`/`@setter` definitions are
dead. Delete them. Facade → ~1,400 LOC, then with the cosmetic trims
(§1 last row) approaches the original estimate. **Note:** the original
~400 LOC estimate assumed the ~80 REST delegations would be far fewer;
the realistic floor with the full REST surface preserved is closer to
**~1,000–1,200 LOC**. A true ~400 LOC would additionally require
collapsing the REST surface (e.g. a generic `__getattr__` dispatch),
which trades explicitness for line-count and is NOT recommended.

### 2.4 (Optional) ProjectStore sub-split — separate concern

`project_store.py` landed at **1,754 LOC (RED)** — expected per the
original proposal §4.1 (~1,800 est) + §10 risk #1. If it keeps growing,
split into `ProjectStore` + `ProjectImporter` (export/import/create-from-zip)
+ `ProjectExporter`. This is independent of the facade shim removal and
can be its own wave.

---

## 3. Acceptance criteria

- [ ] Zero `adapter._<shimfield>` references remain in tests/routes
      (all moved to `adapter._ctx.<field>`).
- [ ] The 59 `@property`/`@setter` shims deleted from the facade.
- [ ] Facade composition methods read `self._ctx.*` directly.
- [ ] Full modal_adapter suite green (same 613-test surface as Wave 3).
- [ ] `wc -l modal_adapter.py` ≤ ~1,200 (realistic floor; the literal
      ~400 needs the not-recommended REST-collapse).
- [ ] CODE_QUALITY §C4 God Objects list updated.

---

## 4. Risk

| Risk | Mitigation |
|---|---|
| 300-edit rewrite introduces a typo'd field name → silent `AttributeError` | Scripted rewrite with an explicit shim→ctx field map; full suite gates. |
| A shim has a non-trivial getter (not a plain proxy) | Audit each of the 59 before scripting; the Wave-1 shims are plain proxies, but re-verify. |
| Removing a shim breaks a route doing `getattr(adapter, '_X')` | Grep routes for `getattr(adapter` first (one known: pipeline_routes.py:287). |

---

## 5. Recommendation

Schedule as a **single dedicated wave** after the Wave-3 merge to `dev`
settles. It is low-conceptual-risk but high-edit-volume; bundling it
with the concern-extraction waves would have endangered the
behaviour-identical guarantee. The concern extraction (the architecturally
valuable part) is done; this is the cosmetic LOC tail.

---

**Investigation history:** the blockers were measured during
`dev-wave3split-f634` Wave 3 (session log
`docs/development/logs/archive/dev-wave3split-f634-2026-06-05-210342.md`);
the ~300-reference count + the run_full_pipeline P2 rationale are recorded
there.
