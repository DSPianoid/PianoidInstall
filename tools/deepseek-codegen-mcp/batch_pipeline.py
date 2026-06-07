"""Batch codegen pipeline over the fixed non-thinking deepseek-codegen core.

A pure-Python (zero-LLM-in-the-loop) orchestrator that takes N (spec, test) pairs, delegates each
function body to DeepSeek via `core.delegate_codegen` (model-pinned deepseek-v4-flash, temperature 0.0,
thinking DISABLED, hardened extractor), optionally runs a cheap DeepSeek SELF-REVIEW (a second DeepSeek
call that critiques + repairs the body against a forbidden-construct / error-contract checklist BEFORE
the test gate), runs the CALLER'S test as the only gate, and re-delegates on failure (<= K). The N
functions run IN PARALLEL (capped). Any function still failing after K delegations is ESCALATED — the
pipeline NEVER ships a failing/missing body and never calls Opus itself; the caller (Claude /dev//fn)
writes the escalated few.

Design + sign-off: docs/proposals/deepseek-batch-pipeline-production-2026-06-06.md
Companion analysis: docs/proposals/deepseek-delegation-overhead-2026-06-06.md

This module NEVER writes into the repo, commits, or branches. It writes shipped bodies to --out (a
caller-chosen dir) and a JSON report. The caller applies + builds + commits.

CLI:
    <venv-python> tools/deepseek-codegen-mcp/batch_pipeline.py --manifest <dir-or-json> \
        [--out <dir>] [--report <path>] [--concurrency N] [--max-delegations K] \
        [--review-ds on|off] [--review haiku|sonnet|off]
Exit code 0 iff every function shipped a test-passing body; non-zero if any escalated (or a config error).
"""
from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

# Import the committed core (single source of truth for model pin, thinking-disabled, extractor).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import core  # noqa: E402

# --- pricing (verify against the DeepSeek catalog; one spot) ---------------------------------------
PRICE_PROMPT_PER_M = 0.14       # USD / 1M prompt tokens (deepseek-v4-flash)
PRICE_COMPLETION_PER_M = 0.28   # USD / 1M completion tokens

DEFAULT_MAX_DELEGATIONS = 3     # initial + up to 2 re-delegations (matches /fn Step-4b)
DEFAULT_CONCURRENCY = 4
DEFAULT_TEST_TIMEOUT_S = 300

# Per-language test-runner command (the caller's test is the gate). pytest for python, node --test for JS.
# `-rA` prints a short per-test summary line carrying each parametrised id (e.g. `…[cupy] PASSED`), so the
# pipeline can detect which array-module backends actually ran (Gap A / xp_untested) without full `-v`.
_LANG_TEST = {
    "python": lambda venv_py, test_file: [venv_py, "-m", "pytest", test_file,
                                          "-p", "no:cacheprovider", "-q", "-rA"],
    "py": "python",
    "javascript": lambda _venv, test_file: ["node", "--test", test_file],
    "js": "javascript", "typescript": "javascript", "ts": "javascript",
    "jsx": "javascript", "tsx": "javascript", "react": "javascript",
}
_TEST_EXT = {"python": ".py", "javascript": ".js", "typescript": ".ts",
             "jsx": ".jsx", "tsx": ".tsx", "react": ".jsx"}

# Per-language default for --expose (Gap B): Python math helpers expose full bodies (cheap, lets the
# delegate CALL the canonical impl); large UI/JSX exposes signatures only (the public contract).
_LANG_EXPOSE_DEFAULT = {
    "python": "bodies", "py": "bodies",
    "javascript": "signatures", "js": "signatures", "typescript": "signatures", "ts": "signatures",
    "jsx": "signatures", "tsx": "signatures", "react": "signatures",
}

# Detect which array-module backends a parametrised pytest run actually executed: the `xp` fixture's
# ids appear as `[numpy]` / `[cupy]` in the `-rA` summary + any failure lines. (Gap A.)
_XP_BACKEND_RE = re.compile(r"\[(numpy|cupy)\]")
# A spec/test is "xp-agnostic" when it carries an `xp` parameter token (last-arg `xp` or the
# `## xp-agnostic` spec section). Heuristic fallback when meta.json has no explicit "xp_agnostic".
_XP_AGNOSTIC_RE = re.compile(r"\bxp\b|xp-agnostic", re.IGNORECASE)


def _parse_xp_backends(out: str) -> list:
    """Backends (numpy/cupy) that actually ran, parsed from the gate's pytest output. Order: numpy, cupy."""
    found = set(_XP_BACKEND_RE.findall(out or ""))
    return [b for b in ("numpy", "cupy") if b in found]


def _spec_is_xp_agnostic(spec: str, test: str) -> bool:
    """Heuristic (when meta.json doesn't say): the function takes an `xp` array-module parameter."""
    return bool(_XP_AGNOSTIC_RE.search(spec or "")) or bool(_XP_AGNOSTIC_RE.search(test or ""))


class ConfigError(ValueError):
    """A manifest/config problem the pipeline refuses to run with (e.g. a function with no test)."""


# ---------------------------------------------------------------------------------------------------
# Manifest loading
# ---------------------------------------------------------------------------------------------------
def _read(path: str) -> str:
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def _make_fn(name, lang, spec, test, test_basename, constraints, target_module, meta):
    """Build one function dict, deriving the Gap-A `xp_agnostic` flag (meta wins; else spec/test
    heuristic) and the Gap-B `deps` list (meta `deps`, default `[]` = a leaf)."""
    xp_agnostic = meta.get("xp_agnostic")
    if xp_agnostic is None:
        xp_agnostic = _spec_is_xp_agnostic(spec, test)
    deps = meta.get("deps", []) or []
    if not isinstance(deps, (list, tuple)):
        raise ConfigError(f"function {name!r}: 'deps' must be a list of names, got {type(deps).__name__}.")
    return {
        "name": name, "language": lang, "spec": spec, "test": test,
        "test_basename": test_basename, "constraints": constraints,
        "target_module": target_module,
        "xp_agnostic": bool(xp_agnostic), "deps": list(deps),
    }


def _validate_deps(functions: list[dict]) -> None:
    """Gap B: every `deps` name must reference a declared function (dangling → ConfigError); the
    dependency graph must be acyclic (cycle → ConfigError)."""
    names = {fn["name"] for fn in functions}
    for fn in functions:
        for d in fn["deps"]:
            if d not in names:
                raise ConfigError(f"function {fn['name']!r}: dep {d!r} is not a declared function "
                                  f"in this manifest (declared: {sorted(names)}).")
            if d == fn["name"]:
                raise ConfigError(f"function {fn['name']!r} depends on itself.")
    # cycle detection via Kahn — if any node never reaches in-degree 0, there's a cycle.
    indeg = {fn["name"]: 0 for fn in functions}
    for fn in functions:
        for _d in fn["deps"]:
            indeg[fn["name"]] += 1
    ready = [n for n, d in indeg.items() if d == 0]
    by_name = {fn["name"]: fn for fn in functions}
    seen = 0
    while ready:
        n = ready.pop()
        seen += 1
        for fn in functions:                       # decrement dependents of n
            if n in fn["deps"]:
                indeg[fn["name"]] -= 1
                if indeg[fn["name"]] == 0:
                    ready.append(fn["name"])
    if seen != len(functions):
        cyclic = sorted(n for n, d in indeg.items() if d > 0)
        raise ConfigError(f"dependency cycle detected among: {cyclic}.")


def load_manifest(manifest_path: str) -> list[dict]:
    """Resolve the manifest into a list of function dicts:
       {name, language, spec, test, constraints, target_module, xp_agnostic, deps}.

    Two forms:
      - a JSON file: {"functions": [{name, language?, spec, test, constraints?, target_module?,
        xp_agnostic?, deps?}, ...]} where spec/test/constraints are PATHS (rel to the JSON's dir).
      - a directory: discovered by file-stem convention
        <name>.spec.md  <name>.test.<ext>  [<name>.constraints.md]  [<name>.meta.json]
        (meta.json may carry {target_module, language, xp_agnostic, deps}).
    """
    if os.path.isfile(manifest_path) and manifest_path.lower().endswith(".json"):
        base = os.path.dirname(os.path.abspath(manifest_path))
        spec_doc = json.loads(_read(manifest_path))
        out = []
        for fn in spec_doc.get("functions", []):
            name = fn.get("name")
            if not name:
                raise ConfigError("a manifest function entry has no 'name'.")
            lang = (fn.get("language") or "python").strip().lower()
            spec_p = os.path.join(base, fn["spec"]) if "spec" in fn else None
            test_p = os.path.join(base, fn["test"]) if "test" in fn else None
            if not spec_p or not os.path.isfile(spec_p):
                raise ConfigError(f"function {name!r}: spec file missing ({fn.get('spec')!r}).")
            if not test_p or not os.path.isfile(test_p):
                raise ConfigError(f"function {name!r}: test file missing ({fn.get('test')!r}) — "
                                  "every function REQUIRES a test (no silent skip).")
            constraints = ""
            if fn.get("constraints"):
                cp = os.path.join(base, fn["constraints"])
                constraints = _read(cp) if os.path.isfile(cp) else ""
            out.append(_make_fn(
                name, lang, _read(spec_p), _read(test_p), os.path.basename(test_p), constraints,
                fn.get("target_module") or f"impl_{name}{_TEST_EXT.get(lang, '.py')}", fn))
        if not out:
            raise ConfigError("manifest JSON has no functions.")
        _validate_deps(out)
        return out

    if os.path.isdir(manifest_path):
        out = []
        names = sorted({fname.split(".spec.")[0]
                        for fname in os.listdir(manifest_path) if ".spec." in fname})
        for name in names:
            spec_p = os.path.join(manifest_path, f"{name}.spec.md")
            if not os.path.isfile(spec_p):
                alt = os.path.join(manifest_path, f"{name}.spec.txt")  # tolerate .spec.txt
                spec_p = alt if os.path.isfile(alt) else spec_p
            meta = {}
            meta_p = os.path.join(manifest_path, f"{name}.meta.json")
            if os.path.isfile(meta_p):
                meta = json.loads(_read(meta_p))
            lang = (meta.get("language") or "python").strip().lower()
            ext = _TEST_EXT.get(lang, ".py")
            test_p = os.path.join(manifest_path, f"{name}.test{ext}")
            if not os.path.isfile(test_p):
                raise ConfigError(f"function {name!r}: no test file {name}.test{ext} — "
                                  "every function REQUIRES a test (no silent skip).")
            if not os.path.isfile(spec_p):
                raise ConfigError(f"function {name!r}: no spec file {name}.spec.md/.txt.")
            cons_p = os.path.join(manifest_path, f"{name}.constraints.md")
            constraints = _read(cons_p) if os.path.isfile(cons_p) else ""
            out.append(_make_fn(
                name, lang, _read(spec_p), _read(test_p), os.path.basename(test_p), constraints,
                meta.get("target_module") or f"impl_{name}{ext}", meta))
        if not out:
            raise ConfigError(f"no functions discovered in manifest dir {manifest_path!r} "
                              "(expected <name>.spec.md + <name>.test.<ext>).")
        _validate_deps(out)
        return out

    raise ConfigError(f"manifest path is neither a .json file nor a directory: {manifest_path!r}")


# ---------------------------------------------------------------------------------------------------
# Thin-test heuristic
# ---------------------------------------------------------------------------------------------------
_ASSERT_RE = re.compile(r"\bassert\b|\bexpect\(")
_RAISES_RE = re.compile(r"pytest\.raises|assertRaises|toThrow|\.throws\b")


def thin_test_warning(test_src: str, min_asserts: int = 3) -> bool:
    """Heuristic: a test looks THIN if it has fewer than `min_asserts` assertions OR has no
    exception-raising case. Non-thinking DeepSeek cuts corners; a thin gate ships them (the 155/160
    risk). This only WARNS — it never blocks."""
    n_assert = len(_ASSERT_RE.findall(test_src or ""))
    has_raises = bool(_RAISES_RE.search(test_src or ""))
    return n_assert < min_asserts or not has_raises


# ---------------------------------------------------------------------------------------------------
# Gap B — topological layering (Kahn) + sibling-dependency exposure in the prompt
# ---------------------------------------------------------------------------------------------------
def topo_layers(functions: list[dict]) -> list:
    """Kahn layering of the dependency DAG. Returns a list of layers (each a sorted list of names):
    layer 0 = all functions with no deps (leaves); layer k = functions all of whose deps are in
    layers < k. Within a layer the order is irrelevant (run in parallel). Assumes deps already
    validated acyclic (load_manifest → _validate_deps)."""
    deps = {fn["name"]: set(fn["deps"]) for fn in functions}
    placed: set = set()
    layers = []
    remaining = set(deps)
    while remaining:
        ready = sorted(n for n in remaining if deps[n] <= placed)
        if not ready:                                   # defensive — should not happen post-validation
            raise ConfigError(f"dependency cycle / unresolved deps among: {sorted(remaining)}")
        layers.append(ready)
        placed.update(ready)
        remaining -= set(ready)
    return layers


# A Python `def name(...):` signature line (across line continuations) — for `--expose signatures`.
_PY_DEF_RE = re.compile(r"^\s*def\s+[A-Za-z_]\w*\s*\([^)]*\)\s*(->[^:]+)?:", re.MULTILINE)
# A JS/TS export signature (function / const arrow / component) — best-effort first line.
_JS_SIG_RE = re.compile(r"^\s*export\s+.*", re.MULTILINE)


def _extract_signature(code: str, language: str) -> str:
    """Best-effort: the public signature/contract line(s) of a body, for `--expose signatures`."""
    lang = (language or "").strip().lower()
    if lang in ("python", "py"):
        m = _PY_DEF_RE.search(code or "")
        return m.group(0).strip() if m else (code or "").splitlines()[0:1] and (code or "").splitlines()[0].strip()
    m = _JS_SIG_RE.search(code or "")
    return m.group(0).strip() if m else ((code or "").splitlines()[0].strip() if code else "")


def _build_dep_context(dep_bodies: dict, expose: str, language: str) -> str:
    """Assemble the `context_snippets` string that exposes already-shipped sibling deps so the
    dependent CALLS them rather than re-implementing (Gap B). `expose` is 'bodies' or 'signatures'."""
    if not dep_bodies:
        return ""
    blocks = []
    for dep_name, dep_code in dep_bodies.items():
        shown = dep_code.strip() if expose == "bodies" else _extract_signature(dep_code, language)
        blocks.append(f"# Already-implemented sibling `{dep_name}` — CALL IT, do NOT re-implement:\n{shown}")
    return ("\n\n".join(blocks)
            + "\n\n# Use the above sibling function(s) by name. Do NOT inline or re-derive their logic. "
              "Import is not needed — they are in the same module.")


# ---------------------------------------------------------------------------------------------------
# DeepSeek self-review (a 2nd DeepSeek call that critiques + repairs against a checklist)
# ---------------------------------------------------------------------------------------------------
def _self_review(spec: str, constraints: str, code: str, language: str, max_tokens: int, dep_ctx: str = ""):
    """Ask DeepSeek to CRITIQUE its own body against the spec + an explicit error-contract /
    forbidden-construct checklist and return a REPAIRED body. Reuses core's HTTP path (same model pin,
    thinking disabled, extractor). Returns (new_code, usage_dict, latency_ms). On any failure returns
    (code, {}, 0) — review is best-effort, never fatal.

    The reviewer prompt is deliberately SHARPER than the generator's: it enumerates the failure classes
    non-thinking DeepSeek is known to cut (missing error-contract cases; banned constructs like
    eval/exec/ast/the csv module; stray-token / unbalanced cases). `dep_ctx` (Gap B) carries any
    already-shipped sibling deps so the review does NOT 'repair' a correct sibling-call back into an
    inline re-implementation."""
    lang_label = core._LANG_LABELS.get((language or "").strip().lower(), language or "the language")
    fence = core._LANG_FENCE.get((language or "").strip().lower(), "")
    system = (
        f"You are a meticulous {lang_label} code reviewer. You are given a SPEC, its REQUIREMENTS, and a "
        f"candidate implementation. Critically check the implementation against the spec, then return a "
        f"CORRECTED implementation. Check ESPECIALLY: (1) does it raise EXACTLY the specified error/"
        f"exception for EVERY error-contract case in the spec (empty input, malformed input, "
        f"out-of-range, unbalanced/stray/dangling tokens, unterminated quotes, cycles, self-deps — "
        f"whatever the spec lists)? (2) does it use any FORBIDDEN construct the spec bans (e.g. eval, "
        f"exec, the ast module, the csv module, third-party imports)? Replace any banned construct with a "
        f"hand-written equivalent. (3) does it honour every stated behaviour and edge case? "
        f"If the SIBLING CONTEXT below names already-implemented helper functions, the candidate SHOULD "
        f"CALL them — do NOT rewrite a sibling call into an inline re-implementation. "
        f"Return ONLY a single complete {lang_label} code block (imports + the function). No prose."
    )
    parts = ["SPEC:", spec.strip()]
    if constraints and constraints.strip():
        parts += ["", "REQUIREMENTS:", constraints.strip()]
    if dep_ctx and dep_ctx.strip():
        parts += ["", "SIBLING CONTEXT (already-implemented helpers — the candidate should call these):",
                  dep_ctx.strip()]
    parts += ["", "CANDIDATE IMPLEMENTATION:", "```" + fence, code.strip(), "```", "",
              f"Return the corrected implementation as one {lang_label} code block."]
    messages = [{"role": "system", "content": system}, {"role": "user", "content": "\n".join(parts)}]
    try:
        t0 = time.time()
        payload = core._post_chat_completion(messages, timeout_s=core.DEFAULT_TIMEOUT_S,
                                             max_tokens=max_tokens)
        latency = int((time.time() - t0) * 1000)
        content = payload["choices"][0]["message"]["content"]
        new_code = core.extract_code(content)
        usage = payload.get("usage") or {}
        if not new_code:
            return code, usage, latency
        return new_code, usage, latency
    except Exception:
        return code, {}, 0


# ---------------------------------------------------------------------------------------------------
# Test gate
# ---------------------------------------------------------------------------------------------------
# Pytest exit code 5 = "no tests collected"; phrases that mark a COLLECTION/import error (the test
# harness is broken, NOT the body). Used to classify a gate result as a harness_error so a broken
# harness does not get charged to the body or burn the re-delegation budget.
_PYTEST_NO_TESTS_EXIT = 5
_COLLECTION_ERROR_MARKERS = (
    "error during collection", "errors during collection", "Interrupted:",
    "no tests ran", "no tests collected", "ERROR collecting", "ModuleNotFoundError",
    "ImportError", "INTERNALERROR",
)


def _is_collection_error(returncode: int, out: str) -> bool:
    """True if the pytest run was a COLLECTION/import failure (harness broken) rather than a test
    failure. Conservative: returncode 5 (no tests collected) OR an explicit collection-error marker
    while ALSO not reporting any passed/failed test outcome."""
    if returncode == _PYTEST_NO_TESTS_EXIT:
        return True
    low = out.lower()
    has_marker = any(m.lower() in low for m in _COLLECTION_ERROR_MARKERS)
    # If real test outcomes were reported (e.g. "3 failed", "5 passed"), it's a genuine test result,
    # not a pure collection error — don't mask a real failure as a harness error.
    ran_tests = bool(re.search(r"\d+\s+(passed|failed)", low))
    return has_marker and not ran_tests


def _run_test(name: str, target_module: str, test_basename: str, code: str, test_src: str,
              language: str, venv_py: str, timeout_s: int, manifest_dir: str = "", dep_bodies=None):
    """Write `code` + the test to an isolated temp dir, run the language's test runner.
    Returns (passed: bool, tail: str, harness_error: bool, backends_ran: list[str]).
    `backends_ran` = array-module backends (numpy/cupy) the parametrised gate actually executed (Gap A).

    `dep_bodies` (Gap B): {dep_name: shipped_code} of already-shipped sibling helpers this function may
    CALL. They are PREPENDED to the candidate module so the dependent resolves its sibling calls at the
    gate exactly as it will in the final single-module assembly ("same module" model). Python only.

    Supports BOTH gate conventions, robustly:
      - **conftest/_candidate harness** (the synthetic-dataset manifest): if `manifest_dir` has a
        conftest.py and/or pytest.ini, copy them into the tempdir and set SYNTHDS_CANDIDATE to the
        written body path (the body exports the fn, so the conftest resolves `from _candidate import …`).
        The test keeps its original `<name>.test.py` name (pytest.ini collects `*.test.py`).
      - **bare-import** (`import impl_<name>` + a plain test): no conftest in the manifest dir → write
        the test under a pytest-collectable name (`test_<name>.py` if the basename doesn't already
        qualify) and let it import `impl_<name>` directly.
    """
    lang = (language or "python").strip().lower()
    runner = _LANG_TEST.get(lang)
    while isinstance(runner, str):  # follow aliases (e.g. "py" -> "python")
        runner = _LANG_TEST.get(runner)
    if not callable(runner):
        return False, f"no test runner for language {language!r}", True, []

    is_python = lang in ("python", "py")
    conftest_p = os.path.join(manifest_dir, "conftest.py") if manifest_dir else ""
    pytestini_p = os.path.join(manifest_dir, "pytest.ini") if manifest_dir else ""
    use_conftest = is_python and (os.path.isfile(conftest_p) or os.path.isfile(pytestini_p))

    work = tempfile.mkdtemp(prefix=f"batch_{name}_")
    try:
        body_path = os.path.join(work, target_module)
        # Gap B — assemble the candidate module = shipped sibling deps + this body, so a dependent's
        # sibling CALLS resolve at the gate ("same module" model). Deps come first (definition order).
        module_src = code
        if is_python and dep_bodies:
            dep_src = "\n\n".join(dep_bodies[d].strip() for d in dep_bodies)
            module_src = dep_src + "\n\n" + code
        with open(body_path, "w", encoding="utf-8") as f:
            f.write(module_src)

        env = dict(os.environ)
        env.pop("PYTHONPATH", None)

        if use_conftest:
            # conftest/_candidate convention — copy the harness files + point it at the body.
            if os.path.isfile(conftest_p):
                shutil.copy(conftest_p, os.path.join(work, "conftest.py"))
            if os.path.isfile(pytestini_p):
                shutil.copy(pytestini_p, os.path.join(work, "pytest.ini"))
            run_test_name = test_basename  # pytest.ini collects *.test.py
            env["SYNTHDS_CANDIDATE"] = body_path
        else:
            # bare-import convention — ensure a pytest-collectable filename.
            run_test_name = test_basename
            if is_python and not (test_basename.startswith("test_") or test_basename.endswith("_test.py")):
                run_test_name = "test_" + name + ".py"

        with open(os.path.join(work, run_test_name), "w", encoding="utf-8") as f:
            f.write(test_src)

        cmd = runner(venv_py, run_test_name)
        proc = subprocess.run(cmd, cwd=work, capture_output=True, text=True, env=env, timeout=timeout_s)
        out = ((proc.stdout or "") + (proc.stderr or "")).strip()
        backends_ran = _parse_xp_backends(out) if is_python else []
        if is_python and _is_collection_error(proc.returncode, out):
            return False, out[-2500:], True, backends_ran    # harness broken — NOT a code failure
        return proc.returncode == 0, out[-2500:], False, backends_ran
    except subprocess.TimeoutExpired:
        return False, "test runner timeout", False, []
    except OSError as e:
        return False, f"test runner launch failed: {e}", True, []
    finally:
        shutil.rmtree(work, ignore_errors=True)


# ---------------------------------------------------------------------------------------------------
# Per-function chain
# ---------------------------------------------------------------------------------------------------
def run_one_function(fn: dict, cfg: dict) -> dict:
    """delegate -> (self-review) -> test -> re-delegate(with failure tail) ... up to K delegations.
    Returns a per-function report record. Writes NOTHING here (the caller's main() writes files after,
    so the escalation invariant — no shipped file iff escalated — lives in one place)."""
    name = fn["name"]
    base_constraints = fn["constraints"]
    constraints = base_constraints
    max_tokens = core.DEFAULT_MAX_TOKENS

    # Gap B — expose already-shipped sibling deps in the prompt so the dependent CALLS them instead of
    # re-implementing. `--expose bodies` passes the full canonical body; `signatures` passes only the
    # signature line (default per-language: bodies for Python math, signatures for large UI/JSX).
    expose = cfg.get("expose") or _LANG_EXPOSE_DEFAULT.get(fn["language"], "bodies")
    dep_ctx = _build_dep_context(fn.get("_dep_bodies") or {}, expose, fn["language"])
    dep_missing = list(fn.get("_dep_missing") or [])

    chain_t0 = time.time()
    attempts = []
    final_code = ""          # last NON-EMPTY body produced (for the .escalated reference)
    final_passed = False
    harness_error = False     # the test harness is broken (collection/import) — NOT a code failure
    last_tail = ""
    xp_backends_tested = []   # array-module backends the gate actually ran (Gap A)
    review_summary = {"fired": False, "changed": False, "what": None}

    for attempt in range(1, cfg["max_delegations"] + 1):
        a_t0 = time.time()
        result = core.to_tool_result(
            function_spec=fn["spec"], test_or_signature=fn["test"],
            constraints=constraints, language=fn["language"],
            context_snippets=dep_ctx,          # Gap B — sibling-dep exposure (persists across retries)
        )
        rec = {"attempt": attempt, "status": result.get("status"),
               "deepseek_prompt_tokens": (result.get("tokens") or {}).get("prompt"),
               "deepseek_completion_tokens": (result.get("tokens") or {}).get("completion"),
               "latency_ms": result.get("latency_ms"),
               "reason": result.get("reason"), "review": None}

        if result.get("status") != "ok" or not result.get("code"):
            rec["test_passed"] = None
            attempts.append(rec)
            constraints = (base_constraints + "\n\nNOTE: the previous attempt FAILED to return code: "
                           + str(result.get("reason"))[:400]
                           + "\nReturn ONLY a single valid code block implementing the function.")
            continue

        code = result["code"]

        # --- DeepSeek self-review (default-on; --review-ds off to skip) ---
        if cfg["review_ds"]:
            new_code, r_usage, r_lat = _self_review(fn["spec"], base_constraints, code,
                                                    fn["language"], max_tokens, dep_ctx=dep_ctx)
            changed = bool(new_code) and new_code.strip() != code.strip()
            rec["review"] = {
                "fired": True, "changed": changed,
                "prompt_tokens": (r_usage or {}).get("prompt_tokens"),
                "completion_tokens": (r_usage or {}).get("completion_tokens"),
                "latency_ms": r_lat,
            }
            review_summary = {"fired": True, "changed": changed or review_summary["changed"],
                              "what": ("repaired body on attempt %d" % attempt) if changed
                                      else review_summary["what"]}
            if changed:
                code = new_code

        final_code = code
        passed, tail, harness_err, backends_ran = _run_test(
            name, fn["target_module"], fn["test_basename"], code, fn["test"],
            fn["language"], cfg["venv_py"], cfg["test_timeout_s"], manifest_dir=cfg.get("manifest_dir", ""),
            dep_bodies=fn.get("_dep_bodies") or {})
        last_tail = tail
        if backends_ran:
            xp_backends_tested = backends_ran     # backends the most recent gate run executed
        if harness_err:
            # The test/harness is broken (collection/import error), NOT the body. Do NOT count this as
            # a code failure and do NOT burn the re-delegation budget — re-delegating can't fix a
            # broken gate. Record + stop the chain; the caller surfaces it as a harness_error.
            rec["test_passed"] = None
            rec["harness_error"] = True
            attempts.append(rec)
            harness_error = True
            break
        rec["test_passed"] = passed
        attempts.append(rec)
        if passed:
            final_passed = True
            break
        constraints = (base_constraints
                       + "\n\nThe PREVIOUS implementation FAILED the test. Fix it (do NOT modify the "
                       + "test; make the function pass it). Test failure output:\n" + tail)

    chain_ms = int((time.time() - chain_t0) * 1000)
    prompt_tok = sum((a.get("deepseek_prompt_tokens") or 0) for a in attempts)
    comp_tok = sum((a.get("deepseek_completion_tokens") or 0) for a in attempts)
    # include self-review tokens in the cost
    for a in attempts:
        if a.get("review"):
            prompt_tok += a["review"].get("prompt_tokens") or 0
            comp_tok += a["review"].get("completion_tokens") or 0
    cost = prompt_tok / 1_000_000 * PRICE_PROMPT_PER_M + comp_tok / 1_000_000 * PRICE_COMPLETION_PER_M

    if final_passed:
        status = "shipped"
        escalation_reason = None
    elif harness_error:
        status = "harness_error"      # the test/setup is broken — NOT a code failure (GAP 2)
        escalation_reason = "test harness collection/import error — fix the test setup, not the body"
    else:
        status = "escalated"
        escalation_reason = f"still failing after {len(attempts)} delegation(s)"

    # Gap A — xp_untested: an xp-agnostic spec whose gate never actually ran cupy (WARN-ONLY).
    xp_untested = bool(fn.get("xp_agnostic")) and ("cupy" not in xp_backends_tested)

    return {
        "name": name, "target_module": fn["target_module"], "language": fn["language"],
        "status": status,
        "public_test_passed": final_passed,
        "harness_error": harness_error,
        "n_delegations": len(attempts), "attempts": attempts,
        "deepseek_tokens": {"prompt": prompt_tok, "completion": comp_tok},
        "cost_usd": round(cost, 6),
        "chain_wall_ms": chain_ms,
        "thin_test_warning": thin_test_warning(fn["test"]),
        # Gap A — dual-backend signal
        "xp_agnostic": bool(fn.get("xp_agnostic")),
        "xp_backends_tested": xp_backends_tested,
        "xp_untested": xp_untested,
        # Gap B — dependency declaration + which deps were not satisfied at schedule time
        "deps": list(fn.get("deps") or []),
        "deps_unsatisfied": dep_missing,
        "review": review_summary,
        "escalation_reason": escalation_reason,
        "_final_code": final_code,            # consumed by main() to write files; stripped from report
        "_last_tail": last_tail if not final_passed else "",
    }


# ---------------------------------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------------------------------
def run_batch(functions: list[dict], cfg: dict) -> dict:
    """Run functions in TOPOLOGICAL LAYERS (Gap B): leaf helpers first, parallelising WITHIN each DAG
    layer (capped at concurrency), blocking per layer so a dependent never starts until its deps have
    SHIPPED. Already-shipped sibling bodies are exposed to each dependent's prompt (§3.3). Returns the
    report dict (without writing files — main() writes shipped bodies + enforces the escalation
    invariant). A flat all-leaf manifest (no deps) runs as one layer = the prior behaviour."""
    by_name = {fn["name"]: fn for fn in functions}
    layers = topo_layers(functions)
    per_function: dict = {}
    shipped_bodies: dict = {}     # name -> shipped code, exposed to later layers
    run_t0 = time.time()
    with concurrent.futures.ThreadPoolExecutor(max_workers=cfg["concurrency"]) as ex:
        for layer in layers:
            futs = {}
            for name in layer:
                fn = dict(by_name[name])                 # copy — we annotate per-run dep state
                fn["_dep_bodies"] = {d: shipped_bodies[d] for d in fn["deps"] if d in shipped_bodies}
                fn["_dep_missing"] = [d for d in fn["deps"] if d not in shipped_bodies]
                futs[ex.submit(run_one_function, fn, cfg)] = name
            for fut in concurrent.futures.as_completed(futs):  # block this whole layer before the next
                rec = fut.result()
                per_function[rec["name"]] = rec
                if rec["public_test_passed"]:
                    shipped_bodies[rec["name"]] = rec["_final_code"]
    wall_ms = int((time.time() - run_t0) * 1000)

    vals = per_function.values()
    shipped = sum(1 for r in vals if r["status"] == "shipped")
    escalated = sum(1 for r in vals if r["status"] == "escalated")
    harness_errors = sum(1 for r in vals if r["status"] == "harness_error")
    xp_untested_count = sum(1 for r in vals if r.get("xp_untested"))
    total_cost = round(sum(r["cost_usd"] for r in vals), 6)
    total_prompt = sum(r["deepseek_tokens"]["prompt"] for r in vals)
    total_comp = sum(r["deepseek_tokens"]["completion"] for r in vals)
    # backends available across the whole run = union of what any function's gate actually ran (Gap A).
    backends_available = sorted({b for r in vals for b in r.get("xp_backends_tested", [])},
                                key=lambda b: ("numpy", "cupy").index(b) if b in ("numpy", "cupy") else 9)

    return {
        "summary": {
            "n": len(functions), "shipped": shipped, "escalated": escalated,
            "harness_errors": harness_errors,
            "xp_untested_count": xp_untested_count,          # Gap A
            "xp_backends_available": backends_available,      # Gap A
            "total_cost_usd": total_cost, "wall_ms": wall_ms, "model": core.DEEPSEEK_MODEL,
            "deepseek_tokens": {"prompt": total_prompt, "completion": total_comp},
            "deps_graph": {fn["name"]: fn["deps"] for fn in functions},   # Gap B — deps-graph echo
            "layers": layers,                                             # Gap B — topo layers echo
            "config": {"max_delegations": cfg["max_delegations"], "concurrency": cfg["concurrency"],
                       "review_ds": cfg["review_ds"], "review": cfg["review"], "expose": cfg.get("expose")},
        },
        "functions": per_function,
    }


def write_outputs(report: dict, out_dir: str) -> None:
    """Write shipped bodies + escalation references, ENFORCING the invariant:
    a shipped file for <module> exists IFF that function's public_test_passed is True.
    An escalated function gets only <module>.escalated (a reference, never the shipped file)."""
    os.makedirs(out_dir, exist_ok=True)
    for rec in report["functions"].values():
        module = rec["target_module"]
        final_code = rec.pop("_final_code", "")
        last_tail = rec.pop("_last_tail", "")
        shipped_path = os.path.join(out_dir, module)
        escalated_path = shipped_path + ".escalated"
        # clean any stale files for a deterministic run
        for p in (shipped_path, escalated_path):
            if os.path.exists(p):
                os.unlink(p)
        if rec["status"] == "shipped" and rec["public_test_passed"]:
            with open(shipped_path, "w", encoding="utf-8") as f:
                f.write(final_code)
        else:
            # NOT shipped (escalated OR harness_error) — never write the shipped file; leave a
            # reference + the tail so the caller knows what to fix. INVARIANT: shipped file iff passed.
            if rec["status"] == "harness_error":
                header = ("# HARNESS ERROR — the test/setup failed to collect/import (NOT the body's "
                          "fault). Fix the test harness (conftest/imports/SYNTHDS_CANDIDATE), not the "
                          "function. No re-delegation was spent on this.\n# Collection error tail:\n# ")
            else:
                header = (f"# ESCALATED — DeepSeek could not pass the test after {rec['n_delegations']} "
                          "delegation(s). Claude must implement this.\n# Last test failure tail:\n# ")
            with open(escalated_path, "w", encoding="utf-8") as f:
                f.write(header
                        + (last_tail or "").replace("\n", "\n# ")
                        + ("\n\n# Best body produced below (reference only):\n" + final_code
                           if final_code else ""))


def parse_args(argv):
    ap = argparse.ArgumentParser(description="Batch DeepSeek codegen pipeline (test-gated, escalating).")
    ap.add_argument("--manifest", required=True, help="a manifest .json file OR a directory of <name>.spec.md/<name>.test.<ext>.")
    ap.add_argument("--out", default=None, help="dir for shipped bodies (default: a scratch temp dir).")
    ap.add_argument("--report", default=None, help="path for the JSON report (default: <out>/report.json).")
    ap.add_argument("--concurrency", type=int, default=DEFAULT_CONCURRENCY)
    ap.add_argument("--max-delegations", type=int, default=DEFAULT_MAX_DELEGATIONS)
    ap.add_argument("--review-ds", choices=["on", "off"], default="on",
                    help="DeepSeek self-review before the test gate (default on — nearly free).")
    ap.add_argument("--review", choices=["off", "haiku", "sonnet"], default="off",
                    help="optional cheap-model review (NOT YET IMPLEMENTED — reserved; default off).")
    ap.add_argument("--expose", choices=["bodies", "signatures"], default=None,
                    help="how to expose a dependency to a dependent's prompt (Gap B). Default: per-language "
                         "(bodies for Python, signatures for jsx/tsx/react).")
    ap.add_argument("--venv-python", default=sys.executable,
                    help="python used to run the tests (default: the current interpreter).")
    return ap.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    out_dir = args.out or tempfile.mkdtemp(prefix="batch_out_")
    report_path = args.report or os.path.join(out_dir, "report.json")
    # The conftest/pytest.ini harness (if any) lives in the manifest dir (or, for a manifest.json, its
    # parent dir). _run_test looks there to support the conftest/_candidate gate convention (GAP 1).
    manifest_dir = (args.manifest if os.path.isdir(args.manifest)
                    else os.path.dirname(os.path.abspath(args.manifest)))
    cfg = {
        "max_delegations": args.max_delegations, "concurrency": args.concurrency,
        "review_ds": args.review_ds == "on", "review": args.review,
        "expose": args.expose,        # None = per-language default (Gap B)
        "venv_py": args.venv_python, "test_timeout_s": DEFAULT_TEST_TIMEOUT_S,
        "manifest_dir": manifest_dir,
    }

    try:
        functions = load_manifest(args.manifest)
    except ConfigError as e:
        print(json.dumps({"status": "config_error", "reason": str(e)}))
        return 2

    print(f"[batch] {len(functions)} function(s), concurrency={cfg['concurrency']}, "
          f"max_delegations={cfg['max_delegations']}, review_ds={cfg['review_ds']}", flush=True)

    report = run_batch(functions, cfg)
    write_outputs(report, out_dir)  # pops the private _final_code/_last_tail keys

    os.makedirs(os.path.dirname(os.path.abspath(report_path)), exist_ok=True)
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)

    s = report["summary"]
    print(f"[batch] shipped={s['shipped']}/{s['n']}  escalated={s['escalated']}  "
          f"harness_errors={s['harness_errors']}  xp_untested={s['xp_untested_count']}  "
          f"cost=${s['total_cost_usd']:.6f}  wall={s['wall_ms']}ms", flush=True)
    print(f"[batch] xp_backends_available={s['xp_backends_available']}  layers={s['layers']}", flush=True)
    for name, rec in report["functions"].items():
        warn = " THIN-TEST!" if rec["thin_test_warning"] else ""
        xpw = " XP-UNTESTED!" if rec.get("xp_untested") else ""
        rv = " review-changed" if rec["review"].get("changed") else ""
        dep = (" deps=" + ",".join(rec["deps"])) if rec.get("deps") else ""
        outcome = "PASS" if rec["public_test_passed"] else ("HARNESS" if rec["status"] == "harness_error" else "FAIL")
        print(f"[batch]   {name:32s} {rec['status']:13s} test={outcome} "
              f"deleg={rec['n_delegations']}{dep}{rv}{warn}{xpw}", flush=True)
    print(f"[batch] report: {report_path}\n[batch] out: {out_dir}", flush=True)

    # exit non-zero iff anything was NOT shipped (escalated OR harness_error) — machine-detectable.
    return 0 if (s["escalated"] == 0 and s["harness_errors"] == 0) else 1


if __name__ == "__main__":
    sys.exit(main())
