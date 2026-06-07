"""Unit tests for the batch codegen pipeline (no network, no `mcp` package required).

Run:
    <python> -m pytest tools/deepseek-codegen-mcp/test_batch_pipeline.py -q

`core.delegate_codegen` / `core.to_tool_result` / `core._post_chat_completion` are monkeypatched so
NO real DeepSeek call is made. The REAL test gate (pytest as a subprocess) IS exercised — the pipeline
runs the venv interpreter against the candidate body, so these tests prove the escalation invariant
end-to-end (shipped file exists IFF the public test passed).
"""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import batch_pipeline as bp  # noqa: E402
import core  # noqa: E402

VENV_PY = sys.executable  # the interpreter running pytest is a fine test runner for these unit tests


# --- a trivial function + tests, written to a manifest dir -----------------------------------------
GOOD_SPEC = "def add(a, b): return a + b"
GOOD_TEST = (
    "import impl_add\n"
    "def test_add():\n"
    "    assert impl_add.add(1, 2) == 3\n"
    "def test_neg():\n"
    "    assert impl_add.add(-5, 5) == 0\n"
    "import pytest\n"
    "def test_type():\n"
    "    with pytest.raises(TypeError):\n"
    "        impl_add.add('a', 1) - 0\n"  # forces a numeric op so a bad body trips
)
GOOD_BODY = "def add(a, b):\n    return a + b\n"
BAD_BODY = "def add(a, b):\n    return a - b\n"  # fails the test


def _write_manifest_dir(tmp_path, name="add", spec=GOOD_SPEC, test=GOOD_TEST, constraints="stdlib only"):
    d = tmp_path / "manifest"
    d.mkdir()
    (d / f"{name}.spec.md").write_text(spec, encoding="utf-8")
    (d / f"{name}.test.py").write_text(test, encoding="utf-8")
    if constraints is not None:
        (d / f"{name}.constraints.md").write_text(constraints, encoding="utf-8")
    return str(d)


def _stub_delegate(monkeypatch, body):
    """Make core.to_tool_result return a fixed OK body without any network."""
    def fake(function_spec, test_or_signature, constraints="", context_snippets="",
             language="python", backend="cloud", **kw):
        return {"status": "ok", "code": body, "model": "deepseek-v4-flash", "backend": "cloud",
                "tokens": {"prompt": 100, "completion": 20, "total": 120}, "latency_ms": 50}
    monkeypatch.setattr(core, "to_tool_result", fake)
    # self-review (if it fires) must also not hit the network — return the body unchanged
    monkeypatch.setattr(bp, "_self_review", lambda spec, cons, code, lang, mt, dep_ctx="": (code, {}, 0))


# ---------------------------------------------------------------------------------------------------
# Manifest
# ---------------------------------------------------------------------------------------------------
def test_manifest_dir_discovers_function(tmp_path):
    md = _write_manifest_dir(tmp_path)
    fns = bp.load_manifest(md)
    assert len(fns) == 1
    assert fns[0]["name"] == "add"
    assert fns[0]["target_module"] == "impl_add.py"
    assert "add" in fns[0]["spec"]


def test_manifest_missing_test_is_config_error(tmp_path):
    d = tmp_path / "manifest"
    d.mkdir()
    (d / "add.spec.md").write_text(GOOD_SPEC, encoding="utf-8")
    # NO add.test.py -> must refuse (never silently skip a gateless function)
    with pytest.raises(bp.ConfigError):
        bp.load_manifest(str(d))


def test_manifest_json_form(tmp_path):
    (tmp_path / "s.md").write_text(GOOD_SPEC, encoding="utf-8")
    (tmp_path / "t.py").write_text(GOOD_TEST, encoding="utf-8")
    mj = tmp_path / "manifest.json"
    mj.write_text(json.dumps({"functions": [
        {"name": "add", "spec": "s.md", "test": "t.py", "target_module": "impl_add.py"}]}),
        encoding="utf-8")
    fns = bp.load_manifest(str(mj))
    assert fns[0]["name"] == "add" and fns[0]["target_module"] == "impl_add.py"


# ---------------------------------------------------------------------------------------------------
# The escalation invariant (load-bearing): shipped file exists IFF the public test passed
# ---------------------------------------------------------------------------------------------------
def test_shipped_body_when_test_passes(tmp_path, monkeypatch):
    md = _write_manifest_dir(tmp_path)
    _stub_delegate(monkeypatch, GOOD_BODY)
    out = tmp_path / "out"
    rc = bp.main(["--manifest", md, "--out", str(out), "--review-ds", "off",
                  "--venv-python", VENV_PY])
    assert rc == 0
    assert (out / "impl_add.py").exists()                 # shipped
    assert not (out / "impl_add.py.escalated").exists()    # no escalation
    report = json.loads((out / "report.json").read_text(encoding="utf-8"))
    assert report["summary"]["shipped"] == 1 and report["summary"]["escalated"] == 0
    assert report["functions"]["add"]["status"] == "shipped"
    assert report["functions"]["add"]["public_test_passed"] is True


def test_escalates_and_writes_NO_shipped_file_when_test_always_fails(tmp_path, monkeypatch):
    md = _write_manifest_dir(tmp_path)
    _stub_delegate(monkeypatch, BAD_BODY)  # body that fails the gate every time
    out = tmp_path / "out"
    rc = bp.main(["--manifest", md, "--out", str(out), "--review-ds", "off",
                  "--max-delegations", "2", "--venv-python", VENV_PY])
    assert rc == 1                                          # non-zero exit on escalation
    # INVARIANT: an escalated function must leave NO shipped file, only a .escalated reference
    assert not (out / "impl_add.py").exists()
    assert (out / "impl_add.py.escalated").exists()
    report = json.loads((out / "report.json").read_text(encoding="utf-8"))
    assert report["summary"]["escalated"] == 1 and report["summary"]["shipped"] == 0
    rec = report["functions"]["add"]
    assert rec["status"] == "escalated"
    assert rec["public_test_passed"] is False
    assert rec["n_delegations"] == 2                        # exhausted the cap
    assert rec["escalation_reason"]


def test_retries_up_to_cap(tmp_path, monkeypatch):
    md = _write_manifest_dir(tmp_path)
    _stub_delegate(monkeypatch, BAD_BODY)
    out = tmp_path / "out"
    bp.main(["--manifest", md, "--out", str(out), "--review-ds", "off",
             "--max-delegations", "3", "--venv-python", VENV_PY])
    report = json.loads((out / "report.json").read_text(encoding="utf-8"))
    assert report["functions"]["add"]["n_delegations"] == 3  # initial + 2 retries


# ---------------------------------------------------------------------------------------------------
# Cost + thin-test warning + self-review wiring
# ---------------------------------------------------------------------------------------------------
def test_cost_is_computed_from_tokens(tmp_path, monkeypatch):
    md = _write_manifest_dir(tmp_path)
    _stub_delegate(monkeypatch, GOOD_BODY)  # 100 prompt + 20 completion per call, 1 call (passes)
    out = tmp_path / "out"
    bp.main(["--manifest", md, "--out", str(out), "--review-ds", "off", "--venv-python", VENV_PY])
    report = json.loads((out / "report.json").read_text(encoding="utf-8"))
    rec = report["functions"]["add"]
    expected = 100 / 1_000_000 * bp.PRICE_PROMPT_PER_M + 20 / 1_000_000 * bp.PRICE_COMPLETION_PER_M
    assert abs(rec["cost_usd"] - round(expected, 6)) < 1e-9
    assert rec["deepseek_tokens"] == {"prompt": 100, "completion": 20}


def test_thin_test_warning_flagged_in_report(tmp_path, monkeypatch):
    thin = "import impl_add\ndef test_add():\n    assert impl_add.add(1,2)==3\n"  # 1 assert, no raises
    md = _write_manifest_dir(tmp_path, test=thin)
    _stub_delegate(monkeypatch, GOOD_BODY)
    out = tmp_path / "out"
    bp.main(["--manifest", md, "--out", str(out), "--review-ds", "off", "--venv-python", VENV_PY])
    report = json.loads((out / "report.json").read_text(encoding="utf-8"))
    assert report["functions"]["add"]["thin_test_warning"] is True


def test_self_review_fires_and_can_change_body(tmp_path, monkeypatch):
    md = _write_manifest_dir(tmp_path)
    # generator returns BAD body; self-review "repairs" it to the GOOD body -> test passes
    def fake_delegate(function_spec, test_or_signature, constraints="", context_snippets="",
                      language="python", backend="cloud", **kw):
        return {"status": "ok", "code": BAD_BODY, "model": "deepseek-v4-flash", "backend": "cloud",
                "tokens": {"prompt": 100, "completion": 20, "total": 120}, "latency_ms": 50}
    monkeypatch.setattr(core, "to_tool_result", fake_delegate)
    monkeypatch.setattr(bp, "_self_review",
                        lambda spec, cons, code, lang, mt, dep_ctx="": (GOOD_BODY, {"prompt_tokens": 80,
                                                                        "completion_tokens": 15}, 40))
    out = tmp_path / "out"
    rc = bp.main(["--manifest", md, "--out", str(out), "--review-ds", "on", "--venv-python", VENV_PY])
    assert rc == 0                                          # review repaired -> shipped
    assert (out / "impl_add.py").exists()
    report = json.loads((out / "report.json").read_text(encoding="utf-8"))
    rec = report["functions"]["add"]
    assert rec["review"]["fired"] is True
    assert rec["review"]["changed"] is True
    # review tokens are included in the cost
    assert rec["deepseek_tokens"]["prompt"] == 180  # 100 gen + 80 review


# ---------------------------------------------------------------------------------------------------
# GAP 1 — conftest/_candidate harness convention; GAP 2 — collection error -> harness_error (no retry)
# ---------------------------------------------------------------------------------------------------
# A conftest that resolves `from _candidate import <name>` from SYNTHDS_CANDIDATE (the real harness shape).
CONFTEST = (
    "import os, sys, importlib.util\n"
    "def _load():\n"
    "    p = os.environ.get('SYNTHDS_CANDIDATE')\n"
    "    if not p or not os.path.exists(p):\n"
    "        raise RuntimeError('no candidate')\n"
    "    spec = importlib.util.spec_from_file_location('_candidate', p)\n"
    "    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)\n"
    "    sys.modules['_candidate'] = m\n"
    "_load()\n"
)
PYTEST_INI = "[pytest]\npython_files = *.test.py test_*.py\naddopts = -q --import-mode=importlib\n"
CONFTEST_TEST = (  # imports via _candidate, NOT impl_add
    "from _candidate import add\n"
    "def test_add():\n    assert add(1, 2) == 3\n"
    "import pytest\n"
    "def test_type():\n    with pytest.raises(TypeError):\n        add('a', 1) - 0\n"
)


def test_gap1_conftest_candidate_convention_gate_passes(tmp_path, monkeypatch):
    """A manifest using conftest.py + pytest.ini + `from _candidate import ...` must gate correctly:
    the pipeline copies the harness files and sets SYNTHDS_CANDIDATE to the body -> test PASSES -> ship."""
    d = tmp_path / "manifest"
    d.mkdir()
    (d / "add.spec.md").write_text(GOOD_SPEC, encoding="utf-8")
    (d / "add.test.py").write_text(CONFTEST_TEST, encoding="utf-8")   # dotted name, collected by pytest.ini
    (d / "conftest.py").write_text(CONFTEST, encoding="utf-8")
    (d / "pytest.ini").write_text(PYTEST_INI, encoding="utf-8")
    _stub_delegate(monkeypatch, GOOD_BODY)
    out = tmp_path / "out"
    rc = bp.main(["--manifest", str(d), "--out", str(out), "--review-ds", "off", "--venv-python", VENV_PY])
    assert rc == 0
    assert (out / "impl_add.py").exists()                            # shipped via the _candidate gate
    report = json.loads((out / "report.json").read_text(encoding="utf-8"))
    assert report["functions"]["add"]["status"] == "shipped"
    assert report["functions"]["add"]["public_test_passed"] is True


def test_gap2_collection_error_is_harness_error_and_does_not_retry(tmp_path, monkeypatch):
    """A test that fails at COLLECTION (imports a missing module) must be classed harness_error, NOT a
    code failure, and must NOT burn the re-delegation budget (n_delegations == 1)."""
    d = tmp_path / "manifest"
    d.mkdir()
    (d / "add.spec.md").write_text(GOOD_SPEC, encoding="utf-8")
    # this test errors at collection (no such module) regardless of the body
    (d / "add.test.py").write_text("import nonexistent_module_xyz\ndef test_add():\n    assert True\n",
                                   encoding="utf-8")
    _stub_delegate(monkeypatch, GOOD_BODY)
    out = tmp_path / "out"
    rc = bp.main(["--manifest", str(d), "--out", str(out), "--review-ds", "off",
                  "--max-delegations", "3", "--venv-python", VENV_PY])
    assert rc == 1                                                   # not shipped -> non-zero
    report = json.loads((out / "report.json").read_text(encoding="utf-8"))
    rec = report["functions"]["add"]
    assert rec["status"] == "harness_error"                         # GAP 2: classed as harness, not fail
    assert rec["harness_error"] is True
    assert rec["public_test_passed"] is False
    assert rec["n_delegations"] == 1                                # GAP 2: did NOT burn 3 retries
    assert report["summary"]["harness_errors"] == 1
    assert not (out / "impl_add.py").exists()                       # invariant: no shipped file
    assert (out / "impl_add.py.escalated").exists()                 # reference written


# ===================================================================================================
# UPGRADE — Gap A (dual-backend / xp_untested) + Gap B (deps DAG / exposure)
# ===================================================================================================
def _write_meta(manifest_dir, name, meta):
    with open(os.path.join(manifest_dir, f"{name}.meta.json"), "w", encoding="utf-8") as fh:
        json.dump(meta, fh)


# --- Gap B: topo layering (pure) -------------------------------------------------------------------
def test_topo_layers_leaves_first():
    fns = [{"name": "a", "deps": []}, {"name": "b", "deps": ["a"]},
           {"name": "c", "deps": ["a", "b"]}, {"name": "d", "deps": []}]
    layers = bp.topo_layers(fns)
    assert layers[0] == ["a", "d"]          # leaves
    assert layers[1] == ["b"]
    assert layers[2] == ["c"]


def test_all_leaf_manifest_is_single_layer():
    assert bp.topo_layers([{"name": "a", "deps": []}, {"name": "b", "deps": []}]) == [["a", "b"]]


# --- Gap B: manifest deps validation ---------------------------------------------------------------
def test_dangling_dep_is_config_error(tmp_path):
    md = _write_manifest_dir(tmp_path)
    _write_meta(md, "add", {"deps": ["nonexistent_helper"]})
    with pytest.raises(bp.ConfigError):
        bp.load_manifest(md)


def test_dependency_cycle_is_config_error(tmp_path):
    d = tmp_path / "manifest"
    d.mkdir()
    cyc_test = ("def test_x():\n    assert True\nimport pytest\n"
                "def test_r():\n    with pytest.raises(ValueError):\n        raise ValueError()\n")
    for nm in ("a", "b"):
        (d / f"{nm}.spec.md").write_text(GOOD_SPEC, encoding="utf-8")
        (d / f"{nm}.test.py").write_text(cyc_test, encoding="utf-8")
    _write_meta(str(d), "a", {"deps": ["b"]})
    _write_meta(str(d), "b", {"deps": ["a"]})       # cycle a<->b
    with pytest.raises(bp.ConfigError):
        bp.load_manifest(str(d))


# --- Gap B: dependent receives the dep body in its prompt ------------------------------------------
_HELPER_TEST = ("import impl_addk\ndef test_h():\n    assert impl_addk.addk(1) == 2\n"
                "import pytest\ndef test_hr():\n    with pytest.raises(TypeError):\n"
                "        impl_addk.addk(None) + 0\n")
_DEP_TEST = ("import impl_usek\ndef test_u():\n    assert impl_usek.usek(1) == 2\n"
             "import pytest\ndef test_ur():\n    with pytest.raises(TypeError):\n"
             "        impl_usek.usek(None) + 0\n")


def test_dependent_gets_dep_body_in_prompt(tmp_path, monkeypatch):
    """A 2-node DAG (helper -> dependent): the dependent's delegate call must carry the helper's
    shipped body in context_snippets (Gap B exposure)."""
    d = tmp_path / "manifest"
    d.mkdir()
    (d / "addk.spec.md").write_text("def addk(x): return x+1", encoding="utf-8")
    (d / "addk.test.py").write_text(_HELPER_TEST, encoding="utf-8")
    (d / "usek.spec.md").write_text("def usek(x): call addk", encoding="utf-8")
    (d / "usek.test.py").write_text(_DEP_TEST, encoding="utf-8")
    _write_meta(str(d), "usek", {"deps": ["addk"]})

    captured = {}

    def fake(function_spec, test_or_signature, constraints="", context_snippets="",
             language="python", backend="cloud", **kw):
        if "usek" in function_spec:
            captured["usek_ctx"] = context_snippets
            body = "def usek(x):\n    return addk(x)\n"
        else:
            body = "def addk(x):\n    return x + 1\n"
        return {"status": "ok", "code": body, "model": "deepseek-v4-flash", "backend": "cloud",
                "tokens": {"prompt": 100, "completion": 20, "total": 120}, "latency_ms": 50}
    monkeypatch.setattr(core, "to_tool_result", fake)
    monkeypatch.setattr(bp, "_self_review", lambda spec, cons, code, lang, mt, dep_ctx="": (code, {}, 0))

    out = tmp_path / "out"
    rc = bp.main(["--manifest", str(d), "--out", str(out), "--review-ds", "off",
                  "--expose", "bodies", "--venv-python", VENV_PY])
    assert rc == 0
    assert "usek_ctx" in captured
    assert "def addk(x)" in captured["usek_ctx"]      # helper body exposed
    assert "CALL IT" in captured["usek_ctx"]           # the reuse instruction
    report = json.loads((out / "report.json").read_text(encoding="utf-8"))
    assert report["functions"]["usek"]["deps"] == ["addk"]
    assert report["summary"]["layers"] == [["addk"], ["usek"]]


def test_missing_dep_recorded_when_helper_not_shipped(tmp_path, monkeypatch):
    """If the helper does NOT ship (escalates), the dependent records it in deps_unsatisfied."""
    d = tmp_path / "manifest"
    d.mkdir()
    helper_fail_test = ("import impl_addk\ndef test_h():\n    assert impl_addk.addk(1) == 999\n"
                        "import pytest\ndef test_hr():\n    with pytest.raises(ValueError):\n"
                        "        raise ValueError()\n")  # body returns 2 != 999 -> fails
    (d / "addk.spec.md").write_text("def addk(x): return x+1", encoding="utf-8")
    (d / "addk.test.py").write_text(helper_fail_test, encoding="utf-8")
    (d / "usek.spec.md").write_text("def usek(x): call addk", encoding="utf-8")
    (d / "usek.test.py").write_text(_DEP_TEST, encoding="utf-8")
    _write_meta(str(d), "usek", {"deps": ["addk"]})

    def fake(function_spec, test_or_signature, constraints="", context_snippets="",
             language="python", backend="cloud", **kw):
        body = ("def usek(x):\n    return x + 1\n" if "usek" in function_spec
                else "def addk(x):\n    return x + 1\n")
        return {"status": "ok", "code": body, "model": "deepseek-v4-flash", "backend": "cloud",
                "tokens": {"prompt": 100, "completion": 20, "total": 120}, "latency_ms": 50}
    monkeypatch.setattr(core, "to_tool_result", fake)
    monkeypatch.setattr(bp, "_self_review", lambda spec, cons, code, lang, mt, dep_ctx="": (code, {}, 0))

    out = tmp_path / "out"
    bp.main(["--manifest", str(d), "--out", str(out), "--review-ds", "off",
             "--max-delegations", "1", "--venv-python", VENV_PY])
    report = json.loads((out / "report.json").read_text(encoding="utf-8"))
    assert report["functions"]["addk"]["status"] == "escalated"        # helper failed its gate
    assert report["functions"]["usek"]["deps_unsatisfied"] == ["addk"]  # dependent saw it missing


# --- Gap A: xp_untested fires for a numpy-only-gated xp-agnostic spec -------------------------------
def test_xp_untested_fires_for_numpy_only_gate(tmp_path, monkeypatch):
    """An xp-agnostic function whose gate only ran numpy (no [cupy]) must flag xp_untested (WARN-ONLY,
    still ships). GOOD_TEST has no xp fixture, so no [cupy] id appears."""
    md = _write_manifest_dir(tmp_path)
    _write_meta(md, "add", {"xp_agnostic": True})
    _stub_delegate(monkeypatch, GOOD_BODY)
    out = tmp_path / "out"
    rc = bp.main(["--manifest", md, "--out", str(out), "--review-ds", "off", "--venv-python", VENV_PY])
    assert rc == 0                                        # WARN-ONLY: still ships
    report = json.loads((out / "report.json").read_text(encoding="utf-8"))
    rec = report["functions"]["add"]
    assert rec["xp_agnostic"] is True
    assert "cupy" not in rec["xp_backends_tested"]
    assert rec["xp_untested"] is True
    assert report["summary"]["xp_untested_count"] == 1


def test_non_xp_agnostic_does_not_flag_xp_untested(tmp_path, monkeypatch):
    md = _write_manifest_dir(tmp_path)
    _write_meta(md, "add", {"xp_agnostic": False})       # explicitly NOT xp-agnostic
    _stub_delegate(monkeypatch, GOOD_BODY)
    out = tmp_path / "out"
    bp.main(["--manifest", md, "--out", str(out), "--review-ds", "off", "--venv-python", VENV_PY])
    report = json.loads((out / "report.json").read_text(encoding="utf-8"))
    assert report["functions"]["add"]["xp_untested"] is False
