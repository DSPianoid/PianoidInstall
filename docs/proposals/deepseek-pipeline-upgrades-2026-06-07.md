# DeepSeek Codegen Pipeline — Quality-Competitiveness Upgrades (Gap A + Gap B)

**Date:** 2026-06-07
**Status:** DESIGN — no code written. Awaiting sign-off before build. **DESIGN ONLY.**
**Motivation:** first real-life A/B test of the batch pipeline on **17 real numpy/CuPy functions**
(`D:\tmp\synthds-ab\`). A blind quality review scored **pure Claude 7.5/10 vs the DeepSeek pipeline
7.0/10** — a modest gap concentrated in exactly **two** avoidable failure classes. This proposal
closes both while keeping the pipeline's cost/latency wins (DeepSeek API ≈ free; zero-LLM-in-the-loop
orchestration).
**Companions:**
[`deepseek-batch-pipeline-production-2026-06-06.md`](deepseek-batch-pipeline-production-2026-06-06.md) (pipeline design) ·
[`deepseek-delegation-overhead-2026-06-06.md`](deepseek-delegation-overhead-2026-06-06.md) (the crossover model the quantitative section uses) ·
`tools/deepseek-codegen-mcp/{README.md, batch_pipeline.py, core.py}` (the implementation) ·
`.claude/commands/fn.md` Step 2a + `dev.md` Step 4b (the skill surface).
**Scope guard:** this proposal touches **only** the pipeline tool (`batch_pipeline.py`, `core.py`),
the manifest **convention** (conftest/spec/meta), and two skill files (`fn.md`, `dev.md`). **No
engine/middleware/CUDA. No source changes in this phase.** `tools/deepseek-codegen-mcp/` is held by
`dev-dsfix` — the build lands there, not here.

---

## 0. BLUF — the two fixes in one breath

1. **Gap A — dual-backend testing.** xp-agnostic functions (those that take `xp`) MUST be tested under
   **both** numpy **and** cupy. Today every manifest test hard-codes `xp = np`, so the cupy path is
   never executed and a latent host/device bug ships green. Fix = a **parametrised `xp` fixture** in
   the manifest `conftest.py` (numpy + cupy-if-importable, clean skip otherwise), a **`/fn`
   test-authoring rule** ("an xp-agnostic target's test MUST exercise both backends"), and a pipeline
   **`xp_untested` flag** (sibling to `thin_test_warning`) raised when an xp-agnostic spec's gate never
   ran cupy.

2. **Gap B — sibling-dependency awareness.** Each function is delegated **in isolation** (the prompt
   carries only that function's spec+test), so DeepSeek **re-implements** shared helpers — `compute_mac`
   inline in both `build_match_cost_matrix` and `precision_scorecard`, and a hand-rolled ZOH in
   `integrate_modal_oscillator` instead of calling `oscillator_zoh_coeffs`. Fix = the manifest
   **declares dependencies** per function; the pipeline schedules in **topological order** (leaf helpers
   first, parallelising **within** each DAG layer); and when delegating a dependent it **exposes the
   already-implemented dependencies' signatures (and bodies)** in the prompt with an instruction to
   **call them, never re-implement**. **Generalises to React/UI** components verbatim.

Both are real, both are mechanical, both keep DeepSeek's model-trait wins (readability, native
error-messaging) that prompting can't easily buy. **Honest residuals are in §6.**

---

## 1. Confirmed root causes (measured against the A/B artefacts)

The A/B test directory `D:\tmp\synthds-ab\` contains three arms over one 17-function manifest: the
DeepSeek pipeline output (`arm_pipeline/out/*.escalated`, which carry the bodies), the pure-Claude
arm (`arm_claude/impl.py`), and the private oracle (`_private_ref/reference_impls.py`). Reading the
bodies side by side pins both gaps to a **mechanism**, not a model-capability deficit.

### 1.1 Gap A — the cupy path is never tested (severe, trivially avoidable)

`snr_scale_noise` is the witness. Its spec prescribes the noise term verbatim:

```
noise = rng.standard_normal(signal.shape) * sqrt(P_noise)
return signal + noise
```

`rng` is a **host numpy** generator (`numpy.random.default_rng(seed)`), so `rng.standard_normal(...)`
returns a **host** array regardless of `xp`. Under `xp = cupy`, `signal` is a **device** array and
`signal + noise` is `cupy + numpy` → a runtime error (or an implicit, silent host-sync). The DeepSeek
body reproduces the bug exactly (`impl_snr_scale_noise.py.escalated`):

```python
noise = rng.standard_normal(signal.shape) * xp.sqrt(p_noise)
return signal + noise        # cupy + host-numpy under xp=cupy
```

The **private reference has the identical latent bug** (`reference_impls.py:334`) — so this is not a
DeepSeek-only slip; it's a hole the **gate** lets through. The pure-Claude arm happens to dodge it by
wrapping the noise back to device (`arm_claude/impl.py:372`: `noise = xp.array(noise, dtype=...)`),
which is why Claude scored higher here — but that is luck/diligence, not something the harness
enforced.

**Why it passed the gate:** `snr_scale_noise.test.py:5` is `xp = np`, hard-coded. Every assertion runs
under numpy. The cupy branch is **never executed**. The `conftest.py` docstring even codifies the
blind spot: *"tests pass `numpy` as xp (numpy-in-test, cupy-in-prod — same body)."* The manifest's
own README calls the tests **"thorough … 175 test cases"** — and they are, for **one** backend. A
single-backend gate cannot validate a two-backend contract.

**Root cause:** the test convention exercises one array module while the spec promises two. The fix is
to make the gate run both.

### 1.2 Gap B — helpers re-implemented across functions (isolation, not capability)

Three dependent functions, each delegated with **only its own** spec+test in the prompt:

| Dependent | DeepSeek did (isolated) | Claude did (shared module) | Reference |
|---|---|---|---|
| `build_match_cost_matrix` | **inlines** the MAC formula (`.escalated:45-51`) | `mac = compute_mac(si, ds[j], xp)` (`impl.py:321`) | calls `compute_mac` (`:292`) |
| `precision_scorecard` | **inlines** MAC again (`.escalated:55-57`) | `compute_mac(...)` + `relative_error(...)` (`impl.py:399-401`) | calls both (`:347-349`) |
| `integrate_modal_oscillator` | **re-derives** the full ZOH, hand-inverting `A` analytically (`.escalated:48-57`) | `Ad, Bd = oscillator_zoh_coeffs(...)` (`impl.py:210`) | calls it (`:195`) |

The specs **already state** the relationships in prose — "MAC is the same formula as `compute_mac`",
"same MAC and relative-error definitions as `compute_mac` / `relative_error`", "see
`oscillator_zoh_coeffs`". DeepSeek can't act on them because **it never sees the sibling**. Claude
got it right for the unglamorous reason that it wrote **all 17 functions in one module**
(`arm_claude/impl.py`) — siblings were lexically in scope, so reuse was the path of least resistance.

**Root cause:** the batch scheduler is a **flat all-parallel fan-out** with **per-function isolation**
(`batch_pipeline.py:438` — `ThreadPoolExecutor`, one `run_one_function` per function, each builds its
prompt from `fn["spec"]/fn["test"]/fn["constraints"]` only). There is no dependency graph, no
ordering, and no cross-function context. Three things are missing and all three are needed: **declared
deps**, **topological scheduling**, **dependency exposure in the prompt**.

The `integrate_modal_oscillator` body also illustrates the **non-canonical-factoring** residual (§6):
DeepSeek's hand-inverted `A^{-1} = [[-2ζ/w², -1/w²],[1,0]]` is *correct* but diverges from the
spec's canonical `xp.linalg.solve(A, …)`. Helper-exposure fixes this **only** if DeepSeek actually
calls the canonical helper instead of re-deriving — which is exactly what the instruction enforces.

### 1.3 Secondary finding (flagged, not a gap) — the harness was broken in this very run

`arm_pipeline/out/report.json` shows **shipped=0, escalated=17**: **every** function failed with
`ModuleNotFoundError: No module named '_candidate'`. The gate's `conftest/_candidate` wiring
(`batch_pipeline._run_test`) did not resolve the candidate in this run, so **no body's correctness was
actually measured by the pipeline** — these should have been classified `harness_error`
(`batch_pipeline.py:407`), not `escalated`. The blind quality review judged the **bodies** (the
`.escalated` files embed them), independent of the broken gate, so the 7.5-vs-7.0 result stands. But
this is a loud signal that the **conftest/SYNTHDS_CANDIDATE gate convention is fragile** — and it is
the same wiring both fixes touch. Recommendation: when the pipeline build lands the Gap-A conftest
change, **re-run the A/B manifest end-to-end and confirm the gate resolves `_candidate`** (a green
`compute_mac` gate is the canary). Tracked here so it isn't lost; it is **not** one of the two graded
gaps.

---

## 2. Gap A — dual-backend testing (numpy **and** cupy)

Three coordinated changes: the **manifest convention**, the **`/fn` rule**, the **pipeline signal**.

### 2.1 Manifest `conftest.py` — a parametrised `xp` fixture (the core change)

Today each `<name>.test.py` does `import numpy as np; xp = np` at module top. Replace that per-file
literal with a **shared, parametrised `xp` fixture** in `conftest.py`, and have each test **take `xp`
as an argument** instead of binding a module global.

**New `conftest.py` fixture (convention, authored by the manifest generator `gen_manifest.py`):**

```python
# conftest.py  (manifest dir) — parametrised array-module fixture
import importlib, pytest

def _available_xps():
    mods = [("numpy", __import__("numpy"))]
    try:
        cupy = importlib.import_module("cupy")
        cupy.zeros(1)                      # probe a real device alloc; CUDA may be absent
        mods.append(("cupy", cupy))
    except Exception:
        pass                               # cupy not importable / no device → numpy-only, cleanly
    return mods

_XPS = _available_xps()

@pytest.fixture(params=[m for _, m in _XPS], ids=[n for n, _ in _XPS])
def xp(request):
    """The array module under test. Parametrised over {numpy, cupy-if-available}.
    Every test that takes `xp` runs once per available backend."""
    return request.param

# Optional: expose which backends actually ran, for the pipeline's xp_untested signal (see §2.3).
def pytest_report_header(config):
    return "synthds xp backends: " + ", ".join(n for n, _ in _XPS)
```

**Test-shape change** (mechanical, generated by `gen_manifest.py` for every xp-agnostic function):
each test function gains an `xp` parameter and drops the module-level `xp = np`. Helpers that must
build **inputs** still use host numpy (inputs are constructed on host, then the function under test is
called with the parametrised `xp`); assertions that compare results convert device output to host with
a tiny helper. Illustration for `snr_scale_noise`:

```python
import numpy as np
import pytest
from _candidate import snr_scale_noise as f

def _host(a):                              # device→host for assertions (numpy passthrough)
    return a.get() if hasattr(a, "get") else np.asarray(a)

def test_target_snr_achieved(xp):
    rng = np.random.default_rng(0)
    sig = xp.asarray(np.sin(np.linspace(0, 200, 20000)))   # build on host, move to xp
    noisy = _host(f(sig, 20.0, rng, xp))
    sig_h = _host(sig)
    snr = 10*np.log10(np.mean(sig_h**2) / np.mean((noisy - sig_h)**2))
    assert abs(snr - 20.0) < 0.5
```

Under this fixture, `pytest` runs `test_target_snr_achieved[numpy]` **and**
`test_target_snr_achieved[cupy]` (when cupy is present). The cupy parametrisation **executes the
device path** and the `signal + noise` line **fails for the host-array bug** — exactly what we want the
gate to catch, and exactly what forces the implementer (Claude or DeepSeek) to wrap the noise with
`xp.asarray(...)`.

**Key design points:**
- **Clean skip, never a hard fail, when cupy is absent.** `_available_xps()` swallows ImportError and
  a failed device probe → the fixture parametrises over `[numpy]` only. On a CI box or a laptop with no
  GPU the suite still runs (numpy-only) and is honest about it via the report header + the pipeline
  flag (§2.3). **No test is skipped silently** in the misleading sense — the *backend* is simply
  unavailable, and that unavailability is surfaced, not hidden.
- **rng stays host by spec.** `snr_scale_noise`'s `rng` is intentionally a host generator (determinism
  contract). The fix is **not** to make `rng` device-aware; it's to make the **body** move the
  host-drawn noise onto `xp` (`xp.asarray(noise)`), which the dual-backend gate now demands.
- **The convention lives in `gen_manifest.py`.** The manifest author (the script that emits
  `<name>.spec.md/.test.py/.constraints.md`) is the single place the test template changes; the 17
  tests are regenerated, not hand-edited. This keeps "every xp-agnostic test is dual-backend" a
  **structural property of the generator**, not a per-test discipline that can rot.

### 2.2 `/fn` skill rule — dual-backend is mandatory for array-module-agnostic targets

`fn.md` is where Claude authors the test before delegating. Add an explicit rule so a Claude-written
test for an xp-agnostic function is **born** dual-backend. Concretely, in **Step 2 / Step 2a**:

> **Array-module-agnostic targets (MANDATORY dual-backend test).** If the function takes an array
> module (`xp`, or otherwise dispatches over numpy/cupy/torch), the test you write MUST exercise
> **both** backends — a numpy-only test does **not** validate the cupy path and will ship latent
> host/device bugs (e.g. mixing a host `rng.standard_normal(...)` into a device array). Parametrise
> the array module over `{numpy, cupy-if-importable}` (skip cupy cleanly when unavailable, but record
> that it was skipped). Only after the test runs under both may you delegate the body to DeepSeek
> (Step 2a) or write it yourself. **The cupy parametrisation is the gate that forces `xp.asarray`
> on any host-drawn array.**

And in **Step 2a's eligibility list**, add a bullet:

> - If the target is xp-agnostic, the test handed to DeepSeek **must already be dual-backend** (per the
>   rule above). Delegating against a numpy-only test re-introduces the Gap-A blind spot — DeepSeek
>   will (correctly, per its prompt) make the numpy-only test pass and leave the cupy path broken.

This rule is **not batch-specific** — it matters for the single-function `/fn` path too (a lone
xp-agnostic function is just as prone to the host/device bug). So it goes in `fn.md` proper, governing
both direct `/fn` use and `/fn`-as-sub-agent.

### 2.3 Pipeline signal — `xp_untested` flag (sibling to `thin_test_warning`)

`batch_pipeline.py` already emits `thin_test_warning` per function (`:162`, `:422`). Add a parallel
**`xp_untested`** warning: an xp-agnostic spec whose gate never actually ran cupy.

**Detection (cheap, two heuristics, no new dependency):**
1. **Spec is xp-agnostic** — the function signature/spec mentions an `xp` parameter (the manifest specs
   all carry the `## xp-agnostic` section + an `xp` last arg). A regex on `fn["spec"]`/`fn["test"]`
   for an `xp` parameter token, OR a new `meta.json` field `"xp_agnostic": true` (preferred — explicit,
   set by `gen_manifest.py`; see §3.1, the same meta file the deps map lives in).
2. **cupy did not run** — parse the gate's pytest output for a `cupy` parametrisation id. With the §2.1
   fixture, a backend that ran shows up as `…[cupy]` in pytest's `-v` line / the report header
   (`synthds xp backends: numpy, cupy`). If the function is xp-agnostic (heuristic 1) **and** no
   `[cupy]` / `cupy` backend token appears in the captured output, set `xp_untested = True`.

**Report fields (additive, no breaking change to the existing schema):**

```jsonc
"snr_scale_noise": {
   ...
   "thin_test_warning": true,
   "xp_agnostic": true,            // NEW — from meta / spec heuristic
   "xp_backends_tested": ["numpy"],// NEW — backends the gate actually executed
   "xp_untested": true,            // NEW — xp_agnostic && "cupy" not in xp_backends_tested
   ...
}
```

and in `summary`:

```jsonc
"summary": { ..., "xp_untested_count": 1, "xp_backends_available": ["numpy"] }
```

**Console line** (extend the existing per-function print at `batch_pipeline.py:551-556`): append
`" XP-UNTESTED!"` next to `" THIN-TEST!"`. Like `thin_test_warning`, `xp_untested` **warns, never
blocks** — a numpy-only box (no GPU) is a legitimate run; the flag tells the caller "this body's cupy
path was not validated here; validate on a GPU box or accept the risk." This mirrors the proposal's
existing correctness-discipline stance (§5 of the production design: warn on a thin gate, don't fail).

**Where the work lands:** §2.1 + the `gen_manifest.py` test-template change = **manifest convention**
(orchestrator/manifest-author owns it, but `gen_manifest.py` is a scratch tool, not repo source — see
§7). §2.2 = **`fn.md`** (orchestrator-applied). §2.3 = **`batch_pipeline.py` + `meta.json` schema**
(dev-dsfix owns it).

---

## 3. Gap B — sibling-dependency awareness (declare → schedule → expose)

Three coordinated mechanisms. All live in the **batch pipeline** + the **manifest convention**; the
single-fn `/fn` path gets only the planning note (§3.6).

### 3.1 Declaration — the manifest names each function's dependencies

**Where:** the per-function **`<name>.meta.json`** (already a supported, optional manifest file —
`batch_pipeline.load_manifest` reads `meta.json` for `target_module`/`language` at `:127-130`). Add a
`"deps"` array (names of sibling functions/helpers this function may call) plus the `"xp_agnostic"`
field from §2.3.

```jsonc
// build_match_cost_matrix.meta.json
{ "target_module": "impl_build_match_cost_matrix.py",
  "language": "python",
  "xp_agnostic": true,
  "deps": ["compute_mac"] }
```
```jsonc
// precision_scorecard.meta.json
{ "deps": ["compute_mac", "relative_error"], "xp_agnostic": true }
```
```jsonc
// integrate_modal_oscillator.meta.json
{ "deps": ["oscillator_zoh_coeffs"], "xp_agnostic": true }
```

For the **explicit `manifest.json`** form (`load_manifest` `:85-114`), add the same key per entry:

```jsonc
{ "functions": [
  { "name": "build_match_cost_matrix", "spec": "...", "test": "...",
    "deps": ["compute_mac"], "xp_agnostic": true } ] }
```

**Why a per-function `deps` list (vs a single manifest-level graph file):** it co-locates the
dependency with the function it constrains, survives the directory-convention discovery the pipeline
already does (no extra file to find), and is trivially diffable. The pipeline assembles the full DAG
from the union of the per-function `deps` (a manifest-level map is reconstructable from this and adds a
second source of truth to keep in sync — avoided). `deps` defaults to `[]` (a leaf) so **existing
manifests without meta files keep working unchanged** (full backward compat — they just schedule as a
single all-leaf layer, i.e. today's behaviour).

`load_manifest` change: read `meta.get("deps", [])` and `meta.get("xp_agnostic", <spec-heuristic>)`
into each function dict (`fn["deps"]`, `fn["xp_agnostic"]`). Validate deps reference **declared
function names** (a `dep` not in the manifest → `ConfigError`, consistent with the existing fail-loud
config-error policy at `:62`). Detect **cycles** → `ConfigError` (a dependency cycle is a manifest
authoring bug; the pipeline refuses rather than deadlock).

### 3.2 Scheduling — topological layers, parallel within each layer

Replace the **flat** `ThreadPoolExecutor` fan-out (`run_batch` at `batch_pipeline.py:433-462`) with a
**layered** scheduler that preserves as much concurrency as the DAG allows.

**Algorithm (Kahn layering):**
1. Build a dependency graph from `fn["deps"]`. Compute layers by Kahn's algorithm: **layer 0** = all
   functions with no unbuilt deps (the leaves); **layer k** = functions all of whose deps are in layers
   `< k`.
2. For each layer **in order**, run that layer's functions **in parallel** through the *same*
   `ThreadPoolExecutor` capped at `--concurrency` (the existing rolling pool, unchanged). Block on the
   whole layer before starting the next — a dependent must not start until its deps have **shipped
   bodies** to expose (§3.3).
3. A function whose dep **escalated/failed** (no shipped body to expose) is still attempted, but the
   pipeline records `"deps_unsatisfied": ["compute_mac"]` on it and exposes whatever **did** ship
   (degrade gracefully: a missing helper means that dependent may re-implement — no worse than today,
   and surfaced).

**Concurrency preserved within layers:** for the A/B manifest the DAG is shallow — **depth 2**: layer
0 = **14 leaves** (all geometry/pulse/parity + `compute_mac`, `relative_error`,
`oscillator_zoh_coeffs`), layer 1 = **3 dependents** (`build_match_cost_matrix`,
`precision_scorecard`, `integrate_modal_oscillator`). So 14 functions still fan out fully in layer 0
(rolling pool of 4), then 3 fan out in layer 1. The only serialisation introduced is "all of layer 0
before any of layer 1," which is precisely the constraint that makes reuse possible.

**Sketch (replaces the body of `run_batch`):**

```python
def run_batch(functions, cfg):
    by_name = {fn["name"]: fn for fn in functions}
    layers = topo_layers(functions)                 # [[leaf names...], [dependent names...], ...]
    per_function, shipped_bodies = {}, {}            # name -> shipped code, for exposure
    run_t0 = time.time()
    with concurrent.futures.ThreadPoolExecutor(max_workers=cfg["concurrency"]) as ex:
        for layer in layers:
            # expose already-shipped deps to each function in this layer (§3.3)
            futs = {}
            for name in layer:
                fn = dict(by_name[name])
                fn["_dep_bodies"] = {d: shipped_bodies[d] for d in fn.get("deps", [])
                                     if d in shipped_bodies}
                fn["_dep_missing"] = [d for d in fn.get("deps", []) if d not in shipped_bodies]
                futs[ex.submit(run_one_function, fn, cfg)] = name
            for fut in concurrent.futures.as_completed(futs):
                rec = fut.result()
                per_function[rec["name"]] = rec
                if rec["public_test_passed"]:
                    shipped_bodies[rec["name"]] = rec["_final_code"]   # available to later layers
    ...
```

`topo_layers` is ~20 lines (Kahn). The escalation invariant, cost math, harness-error classification,
and report assembly are **unchanged** — only the order of submission and the per-function `_dep_bodies`
injection are new.

### 3.3 Exposure — pass dependency signatures (and bodies) into the delegate prompt

`run_one_function` builds the delegation via `core.to_tool_result(function_spec=…, test_or_signature=…,
constraints=…, language=…)` (`batch_pipeline.py:333`). `core.build_messages` already has a
**`context_snippets`** parameter for exactly this — *"CONTEXT (surrounding patterns — do NOT
re-implement these, use them)"* (`core.py:140-142`) — but the pipeline never populates it. Wire the
exposed dependencies through it.

**Two changes:**

1. **`run_one_function`** assembles a `context_snippets` string from the injected `_dep_bodies`:

```python
dep_ctx = ""
if fn.get("_dep_bodies"):
    blocks = []
    for dep_name, dep_code in fn["_dep_bodies"].items():
        blocks.append(f"# Already-implemented sibling `{dep_name}` — CALL IT, do NOT re-implement:\n"
                      f"{dep_code.strip()}")
    dep_ctx = ("\n\n".join(blocks)
               + "\n\n# Use the above sibling function(s) by name. Do NOT inline or re-derive their "
                 "logic. Import is not needed — they are in the same module.")
```

2. Pass it through `core.to_tool_result(..., context_snippets=dep_ctx)` (the parameter already exists
   on `delegate_codegen`/`build_messages`/`to_tool_result` — `core.py:122,238`; the pipeline just isn't
   using it). On a **re-delegation** (the failure-tail retry loop), keep `context_snippets` set so the
   reuse instruction persists across retries.

**Signatures vs bodies — pass both, default to bodies:** exposing the **body** (not just the
signature) is what lets DeepSeek call it confidently *and* matches the canonical implementation (which
suppresses the non-canonical-factoring residual for the dependent — it will call
`oscillator_zoh_coeffs`, not hand-roll a different-but-correct ZOH). Token cost is negligible (§5). A
`--expose signatures|bodies` flag (default **bodies**) lets a caller dial it back if a dependency body
is large; signatures-only still helps (DeepSeek knows the call exists and its contract). The reviewer
self-review prompt (`_self_review`, `batch_pipeline.py:174`) should also receive `dep_ctx` so the
critique step doesn't "repair" a correct sibling-call back into an inline re-implementation.

**The instruction is the load-bearing part.** `build_messages`' existing context header says "do NOT
re-implement these, use them" — strengthen it for the dependency case (the `dep_ctx` text above is
explicit: "CALL IT … Do NOT inline or re-derive"). This converts the spec's *prose* hint ("same formula
as `compute_mac`") into an *operational* instruction backed by the actual sibling code.

### 3.4 The UI generalisation (React components) — same DAG, same exposure

The user flagged the divergence risk of DeepSeek re-implementing **UI** components. The mechanism
generalises **verbatim** — only the artefact type and the "interface" change:

- **Declaration:** a React component/hook's `meta.json` `deps` names the **shared components/hooks** it
  composes (e.g. `NumInput.meta.json` is a leaf; `ExcitationEditor.meta.json` →
  `"deps": ["NumInput", "useDebouncedParam"]`). The Pianoid UI standards already mandate reuse of
  `NumInput` and the `usePreset`/debounced-API pattern (`.claude/CLAUDE.md` Frontend UI Standards) —
  Gap-B is the **enforcement mechanism** for that mandate when codegen is delegated.
- **Scheduling:** build the **leaf component first** (`NumInput`), then the composing component
  (`ExcitationEditor`) in a later layer — a component that uses a shared component is built **after**
  it, never in isolation.
- **Exposure:** when delegating `ExcitationEditor`, pass `NumInput`'s **interface** (its prop types /
  `export` signature — the component's public contract) into `context_snippets` with "render
  `<NumInput …/>`; do NOT re-create a numeric input." This is the React analogue of passing
  `compute_mac`'s signature. For UI, **signatures (prop interfaces) are usually enough** (the body is
  large JSX) — so `--expose signatures` is the sensible default for `language ∈ {jsx,tsx,react}`, while
  `bodies` stays default for Python math helpers. The per-language default can live in the
  `_LANG_*` tables the pipeline already keys on (`batch_pipeline.py:50-59`).
- **Why it matters more for UI:** a re-implemented `compute_mac` is caught by a numerical test; a
  re-implemented numeric input **diverges in styling, a11y, and debounce behaviour** in ways a unit
  test rarely asserts — exactly the "divergence risk" the user named. The DAG+exposure stops the
  divergence at generation time rather than hoping a Jest test catches it.

### 3.5 Planning discipline — who builds the graph

The dependency graph is **a planning artefact the batch author owns**, not something the pipeline
infers. This is the most important non-code change:

- **The manifest author** (whoever assembles the `(spec, test)` batch — for the A/B test that was
  `gen_manifest.py`; in production it is the `/dev` or `/fn` agent that prepares the batch) must
  **identify the shared helpers/components up front and declare the `deps` edges**. This is a
  decomposition step: "before I batch N functions, which are leaf utilities the others call?" It is the
  same judgement a good engineer applies when ordering their own work — made explicit and machine-
  consumable.
- **Implication for `/fn`/`/dev` handing the pipeline a batch (the `dev.md` Step-4b change):** when a
  `/dev` agent decomposes a task into a function suite and routes it to the batch pipeline, it must
  **name the shared helpers and set the `deps`** in the per-function meta. The dev agent already writes
  the tests first (Step 4b "Prepare tests FIRST"); declaring deps is the natural sibling of that step.
  Add to `dev.md` Step 4b a short subsection: *"When batching ≥2 functions where some call others,
  declare the dependency edges (`meta.json` `deps`) so the pipeline builds leaf helpers first and
  exposes them — otherwise DeepSeek re-implements shared logic (build_match_cost_matrix re-implemented
  compute_mac in the 2026-06-06 A/B test). Same rule for React: a component that uses a shared
  component declares it as a dep."*

### 3.6 Single-fn `/fn` Step-2a — exposure mostly N/A, one note

Helper-exposure is **inherently a batch concern** — a lone `/fn` delegation has no sibling being
generated alongside it. The single-fn analogue is *"reuse an **existing** repo helper"*, which is
already handled by `/fn` Step 1 (read context) + Step 2a's `context_snippets` (the caller curates
adjacent patterns). So **no Step-2a scheduling change**. Add only a one-line note to `fn.md` Step 2a:

> - If the function should call an **existing** helper (in the repo or written earlier in this `/dev`
>   run), put that helper's **signature** in `context_snippets` with "call this; do not re-implement."
>   (For generating **several interdependent** functions at once, use the **batch pipeline**, which
>   schedules + exposes dependencies automatically — see the batch design.)

So: **dual-backend testing (Gap A) lands in BOTH the batch pipeline and single-fn `/fn`** (the
host/device bug bites a lone function too). **Helper-exposure/scheduling (Gap B) lands in the BATCH
pipeline only**, with single-fn `/fn` getting just the "reuse existing helpers via context_snippets"
reminder.

---

## 4. Strategic frame — why invest in closing 7.5-vs-7.0

The blind review's third lesson: DeepSeek's **better readability** and **native error-messaging**
(f-strings echoing the offending value in raised `ValueError`s) are **model traits** — hard to buy via
prompting, and pure Claude doesn't reliably produce them. Combined with the pipeline's measured wins —
**DeepSeek API ≈ free** (0.08% of arm cost; the v4-flash call is $0.0009-class), and the **zero-LLM
orchestration** that collapses the delegation crossover (the loop's Claude context ≈ 0 because the
orchestrator is *Python*) — the pipeline already **wins on cost/latency** and **ties-or-leads on
style**. The only thing standing between 7.0 and parity-or-better is the **two correctness gaps**, both
of which are **mechanical** (a fixture, a DAG) rather than model-limited.

So the investment thesis is: **spend a small, bounded engineering effort on A+B to make the pipeline
quality-competitive, and keep every win.** Neither fix touches the model, the model pin, the
non-thinking mode, or the cost structure:
- Gap A adds **local test runs** (numpy+cupy) — **zero** DeepSeek/Claude tokens (tests are
  subprocesses), only wall-clock.
- Gap B adds **a few hundred prompt tokens** per dependent (sibling bodies) and **some lost
  parallelism** (the dependent layer waits for the leaf layer) — both quantified in §5 as cheap.

The pipeline stays "nearly free + fast"; it just stops shipping a re-implemented helper or an untested
cupy path. **This is the highest-leverage upgrade available** because it closes the *entire* measured
quality gap without eroding the reason the pipeline exists.

---

## 5. Quantitative analysis (cost / latency of each upgrade)

Anchored to the A/B `report.json` (17 fns, flat run: **wall = 90.1 s**, **cost = $0.0311**, concurrency
4) and the overhead doc's per-call model.

### 5.1 Layered DAG scheduler — lost parallelism (latency only, no $)

- **DAG is shallow (depth 2):** 14 leaves, 3 dependents. Layer 0 already needs ⌈14/4⌉ = **4 rolling
  waves**; layer 1 is **1 wave** (3 functions ≤ cap 4).
- **Critical path:** the slowest dependent is `integrate_modal_oscillator` (chain **43.7 s** per
  report). Its dep `oscillator_zoh_coeffs` is a 23.0 s chain. Flat run could overlap them; the layered
  run cannot (integrate must wait for the leaf layer to finish). Added serialisation on that path ≈ the
  leaf layer's tail before layer 1 starts.
- **Estimate:** layered wall ≈ flat wall + **one extra wave** ≈ 90 s + ~20–40 s → **~1.2–1.4×**
  wall-clock. When dependents (3) are few relative to leaves (14), the penalty is small.
- **Crucially, this is latency, not cost.** The whole batch is **one Bash round-trip** for Claude
  (`batch_pipeline.py` is the zero-LLM orchestrator), so **Claude-side cost is unchanged by wall-clock**
  — the overhead doc's entire point. The +20-40 s buys: no re-implemented helpers, canonical factoring
  in dependents. **Verdict: clearly worth it.** (If a future batch had a deep/wide dependent layer, the
  pool still parallelises within each layer, so the penalty stays bounded by DAG depth, not N.)

### 5.2 Helper-exposure — prompt-token growth (cheap; estimate)

- A helper **signature** ≈ 15-40 tokens; a helper **body** ≈ 120-200 tokens (`compute_mac` is ~10
  lines ≈ 130 tokens; `oscillator_zoh_coeffs` ~20 lines ≈ 260 tokens).
- Per dependent, expose 1-2 deps' bodies → **+150-500 prompt tokens**. At v4-flash **$0.14/1M prompt**,
  that's **~$0.00002-0.00007 per dependent delegation**, × 3 dependents × up to 3 attempts ≈ **< $0.001
  added to the whole run** (which cost $0.031). **Negligible.** Exposing bodies for **all** dependents,
  every retry, still rounds to **+~3%** of the run's DeepSeek cost at most.
- Latency: a few hundred extra prompt tokens add **single-digit-ms** to each DeepSeek call. Immaterial
  next to the 1.6-9 s per-call latencies in the report.
- **Verdict: bodies-by-default is free.** Use `--expose signatures` only for large UI/JSX bodies, where
  the signature is the useful part anyway.

### 5.3 Dual-backend testing — ~2× test runs (latency only, no $)

- The §2.1 fixture parametrises each test over {numpy, cupy} → **up to 2× pytest parametrisations** per
  gate. pytest subprocess launch + collection ≈ 0.2-1.0 s; cupy adds device alloc/transfer per test.
- The gate runs up to **K=3 times per function** already; dual-backend doubles the *parametrised cases*
  inside each run, not the number of subprocess launches. Net added wall ≈ the cupy parametrisation's
  compute, realistically **+tens of seconds across the whole 17-fn run** on a GPU box.
- **On a box without cupy:** the fixture parametrises numpy-only → **0 added cost** (and `xp_untested`
  flags it). So the 2× only applies where a GPU exists to validate against — exactly where you want it.
- **Cost: $0** — tests are local subprocesses; **no** DeepSeek/Claude tokens. **Verdict: worth it; the
  added wall is small and only incurred where cupy can actually catch the bug.**

### 5.4 Net

| Upgrade | Δ Claude $ | Δ DeepSeek $ | Δ wall | Quality |
|---|---|---|---|---|
| Layered DAG | 0 | 0 | +~20-40 s (~1.2-1.4×) | removes helper re-implementation |
| Helper-exposure | 0 | < +$0.001 (~+3%) | +ms | reuse + canonical factoring in dependents |
| Dual-backend test | 0 | 0 | +~tens of s (GPU box only) | catches latent cupy bugs |

The entire upgrade adds **< $0.001 DeepSeek cost, $0 Claude cost**, and **modest wall-clock**, to close
**both** measured quality gaps. The cost/latency wins that motivated the pipeline are untouched.

---

## 6. Residual gaps — what these upgrades do NOT close (honest)

1. **Non-canonical-but-correct factoring (audit/maintainability hazard).** DeepSeek's
   `integrate_modal_oscillator` hand-inverted `A` (`A^{-1}=[[-2ζ/w²,-1/w²],[1,0]]`) instead of
   `xp.linalg.solve`. Helper-exposure **mitigates** this *for dependents* (the dependent now **calls**
   the canonical `oscillator_zoh_coeffs` rather than re-deriving), but a **leaf** function that DeepSeek
   writes idiosyncratically (correct, odd, harder to audit) is **not** addressed — there is no sibling
   to defer to. The test gate passes it; a human reviewer may still find it surprising. **Partial
   mitigation only.** (A separate "canonical-style" reviewer pass — the deferred `--review haiku|sonnet`
   hook at `batch_pipeline.py:509` — could target this, at the cost the production design already
   discusses.)
2. **Intermittent failures on the hardest functions.** Even with a strong dual-backend gate and helper
   exposure, non-thinking DeepSeek remains **correctness-lossy on the hardest specs** (the 155/160
   benchmark; the report's hardest chains — `integrate_modal_oscillator`, `sample_shape_at_points` —
   burned all 3 delegations). The upgrades make the **gate** sharper and reuse **structural**; they do
   **not** make DeepSeek smarter. The **escalation backstop** (Claude writes the few that stay red) is
   still load-bearing and unchanged. A sharper gate may even **raise** the escalation rate (good — it
   stops shipping subtly-wrong bodies), trading silent wrongness for honest escalation.
3. **Spec-prose dependencies the manifest author misses.** Gap B is closed **only for declared edges**.
   If the batch author forgets to declare `precision_scorecard → relative_error`, DeepSeek re-implements
   it again. The pipeline can **warn** (heuristic: a spec body that name-drops another manifest
   function's name without a corresponding `deps` edge → "possible undeclared dependency"), but the
   declaration is ultimately a **human planning act** (§3.5). Auto-inferring deps from spec prose is
   out of scope (and unreliable).
4. **The fragile conftest/`_candidate` gate wiring (§1.3).** Orthogonal to A/B, but the A/B run's
   `shipped=0` shows the gate can silently fail to resolve the candidate and mis-classify everything as
   escalated. The Gap-A conftest rewrite is the moment to harden + re-verify this (canary: a green
   `compute_mac[numpy]` gate). Not closed by A/B themselves.
5. **Cross-backend numerical tolerance.** Dual-backend testing executes the cupy path, but cupy/numpy
   can differ at ULP level (different BLAS, fast-math). Tests asserting `atol=1e-12` may need per-backend
   tolerances. The §2.1 fixture surfaces the backend; **choosing tolerances** that pass on both is a
   test-authoring nuance the `/fn` rule should mention but cannot fully automate.

---

## 7. Phased implementation plan

Ownership boundaries match the existing split: **dev-dsfix** owns the pipeline tool + `core.py`; the
**orchestrator** owns the skill files (`fn.md`, `dev.md`); the **manifest convention** is owned by
whoever authors batches (with `gen_manifest.py` as the reference template — a scratch tool under
`D:\tmp\`, not repo source).

### Phase 1 — Gap A, dual-backend (lowest-risk, highest-clarity)
1. **dev-dsfix → `batch_pipeline.py`:** add `xp_agnostic` (from `meta.json` or spec heuristic),
   `xp_backends_tested` (parse gate output for backend ids), `xp_untested` per-function field +
   `xp_untested_count`/`xp_backends_available` in `summary`; extend the console line. Extend
   `meta.json` schema doc. Add a unit test (stubbed core) asserting `xp_untested` fires for an
   xp-agnostic spec whose gate ran numpy-only.
2. **Manifest convention (`gen_manifest.py` template, scratch):** rewrite `conftest.py` to the
   parametrised `xp` fixture (§2.1); change the test template so xp-agnostic tests take `xp` as an arg
   and use the `_host()` device→host helper; set `"xp_agnostic": true` in each meta. Regenerate the 17
   triples.
3. **Orchestrator → `fn.md`:** add the §2.2 dual-backend MANDATORY rule (Step 2 + Step 2a bullet).
4. **Verify:** re-run the A/B manifest with the new conftest; confirm the gate **resolves `_candidate`**
   (fixes §1.3) and that `snr_scale_noise[cupy]` **fails** on the host-array bug (on a GPU box) or
   `xp_untested=true` (no GPU). Record under `D:\tmp\ab-upgrade\`.

### Phase 2 — Gap B, declare + schedule + expose
5. **dev-dsfix → `batch_pipeline.py`:** `load_manifest` reads `deps` (+ validates names, detects
   cycles → `ConfigError`); add `topo_layers` (Kahn); replace `run_batch`'s flat fan-out with the
   layered scheduler (§3.2) that threads `_dep_bodies`/`_dep_missing` into each function; `run_one_function`
   builds `dep_ctx` and passes `context_snippets=dep_ctx` through `core.to_tool_result` (and into
   `_self_review`); add `--expose signatures|bodies` (default bodies; per-language default for
   jsx/tsx/react = signatures). Report: add `deps`, `deps_unsatisfied` per function. Unit tests
   (stubbed core): topo layering; a dependent receives its dep's body in the prompt; a missing dep is
   recorded; a cycle is a ConfigError.
6. **`core.py`:** **no change required** — `build_messages`/`delegate_codegen`/`to_tool_result` already
   carry `context_snippets`. Optionally strengthen the context header wording (`core.py:140-142`) for
   the dependency case, but the pipeline's `dep_ctx` text already supplies the explicit "CALL IT, do
   NOT re-implement" instruction. (Keeping `core.py` untouched minimises the held-lock surface.)
7. **Manifest convention:** add `deps` to the three dependent metas
   (`build_match_cost_matrix→[compute_mac]`, `precision_scorecard→[compute_mac, relative_error]`,
   `integrate_modal_oscillator→[oscillator_zoh_coeffs]`); leaves get `deps: []` (or no meta).
8. **Orchestrator → `dev.md` Step 4b + `fn.md` Step 2a:** add the planning-discipline note (§3.5 —
   declare deps when batching interdependent functions; same rule for React shared components) and the
   single-fn "reuse existing helper via context_snippets" note (§3.6).
9. **Verify:** re-run the A/B manifest; confirm the three dependents now **call** their helpers
   (`build_match_cost_matrix` contains `compute_mac(`, `integrate_modal_oscillator` contains
   `oscillator_zoh_coeffs(`) and that the leaf layer completes before the dependent layer. Record the
   new pass-rate/cost/wall and compare to the 7.0 baseline.

### Phase 3 — UI generalisation (when the first React batch is delegated)
10. Apply §3.4: per-language exposure default (signatures for jsx/tsx/react), the `deps` convention for
    shared components/hooks, and a Jest dual-backend analogue is **not** needed (UI isn't xp-agnostic),
    but the **shared-component-reuse** declaration is. Documented in the README + `dev.md` Frontend note.

### What changes where (summary)
| Surface | Owner | Change |
|---|---|---|
| `batch_pipeline.py` | dev-dsfix | `xp_untested` fields; `deps` load+validate; `topo_layers`; layered `run_batch`; `dep_ctx` exposure; `--expose`; report fields |
| `core.py` | dev-dsfix | none required (already has `context_snippets`); optional header wording tweak |
| manifest `conftest.py` + test template + `meta.json` | manifest author (`gen_manifest.py`) | parametrised `xp` fixture; dual-backend tests; `xp_agnostic` + `deps` meta |
| `fn.md` | orchestrator | dual-backend MANDATORY rule (Step 2/2a); single-fn reuse note (Step 2a) |
| `dev.md` Step 4b | orchestrator | planning-discipline: declare deps when batching interdependent fns; React shared-component rule |
| `README.md` (tool) | dev-dsfix | document dual-backend signal, `deps`/scheduling/exposure, `--expose`, residuals |

---

## 8. Open decisions for sign-off

1. **`deps` location** — per-function `meta.json` `"deps": [...]` (recommended, §3.1) vs a manifest-level
   graph file. Confirm per-function.
2. **Exposure default** — bodies for Python (recommended), signatures for jsx/tsx/react (§3.3/§3.4).
   Confirm, or set a single global default.
3. **`xp_untested` policy** — warn-only (recommended, mirrors `thin_test_warning`) vs escalate when an
   xp-agnostic body's cupy path was never validated **and** a GPU was available. Confirm warn-only.
4. **Dual-backend in single-fn `/fn`** — confirm the MANDATORY rule applies to direct `/fn` use too
   (recommended — the host/device bug bites lone functions), not just batches.
5. **Scope of the §1.3 harness re-verification** — fold the conftest hardening into Phase 1 (recommended)
   vs track separately.
6. Anything to add to the **report** contract for downstream consumers (deps graph echo? per-backend
   pass/fail breakdown?).

---

### Investigation history
- A/B artefacts: `D:\tmp\synthds-ab\` — `manifest/` (17 spec/test/constraints triples + conftest +
  pytest.ini), `arm_pipeline/out/*.escalated` + `report.json` (DeepSeek arm — bodies + the broken-gate
  run), `arm_claude/impl.py` (pure-Opus arm), `_private_ref/reference_impls.py` (oracle),
  `_private_ref/gen_manifest.py` (the manifest author/template).
- Confirmed-evidence scratch: `D:\tmp\ab-upgrade\evidence.md`.
- Crossover/cost model: `deepseek-delegation-overhead-2026-06-06.md` (the `F > N_extra·ctx·0.02`
  break-even and the per-call cost constants used in §5).
- Pipeline design this upgrades: `deepseek-batch-pipeline-production-2026-06-06.md` + the implementation
  at `tools/deepseek-codegen-mcp/` (held by dev-dsfix).
