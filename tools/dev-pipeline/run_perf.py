#!/usr/bin/env python
"""run_perf.py — perf-test runner + metric PARSER + delta table + verdict_hint (minimize-opus row 4).

This is the deliberately-SPLIT op from the proposal (§2.2 row 4 / §2.3): the script does the
deterministic half — run the perf pytest, parse the metrics from its `-s` output, format the
baseline-vs-after markdown delta table, and emit the dev.md marker fields plus a `verdict_hint`
computed from the STATIC dev.md Step-5 thresholds. The **regression VERDICT stays with Opus** (is a
+12% GPU bump acceptable *for this change*? — judgment). The script only computes deltas + the hint;
Opus confirms.

dev.md drives this in two places:
  • Step 2 (baseline, before edits):  `--baseline`  → runs the suite, parses, writes a baseline.json,
    prints `[BASELINE-TEST] … result=<pass|fail> perf_log=… gpu_mean_ms=<N> sound_corr=<N>`.
  • Step 5 (post-change):             `--compare <baseline.json>` → runs the suite again, parses,
    prints the **delta table** + `[REGRESSION-CHECK] … gpu_mean_delta_pct=<N> sound_corr=<N>
    verdict=<verdict_hint>` (and, when the hint is `fail`, a `[REGRESSION-DETECTED]` per offending
    metric). The emitted verdict is the *hint*; Opus owns the final call.

Metrics are parsed from the perf suite's printed lines (the tests run with `-s`; there is no junit /
json output). Parsed fields (dev.md Step-5 metric table):
  • gpu_mean   (ms)  — "GPU timing: mean=…ms" / "GPU compute mean: … ms"
  • gpu_p99    (ms)  — "GPU compute p99: … ms"            (audio_on suite only)
  • total_mean (ms)  — "Total timing: mean=…ms"
  • sound_corr       — "Waveform cross-correlation: …"
  • underrun   (count) — "Underrun count: …"              (audio_on suite only)
A metric absent from the run (e.g. underrun/p99 need the audio_on suite + hardware) is recorded as
null and skipped in the thresholds — never guessed.

Static thresholds (dev.md Step 5 — kept here verbatim; changing dev.md changes these):
  HARD FAIL → verdict_hint=fail :  GPU mean +>10%   OR  sound_corr < 0.95   OR  any new test failure
  WARN      → verdict_hint=warn :  GPU p99  +>20%   OR  underrun count +>50%
  else                          :  verdict_hint=pass

Usage:
    python run_perf.py --baseline [--out baseline.json] [options]
    python run_perf.py --compare <baseline.json>        [options]
  options:
    [--test-path tests/system/test_performance_audio_off.py]   # what pytest target to run
    [--audio-on]          # also run the audio_on perf file (needs a real driver; auto-skips else)
    [--perf-log <path>]   # tee the raw pytest output here (default <tmp>/{baseline,postchange}_perf.log)
    [--from-log <path>]   # PARSE this existing pytest log instead of running pytest (offline/tests)
    [--json]              # also print the machine JSON (metrics + deltas + verdict_hint)

Exit codes: 0 on a clean run whose `verdict_hint` is pass/warn; 2 when `verdict_hint=fail` (regression
or a test failure — Opus then branches to debug); 1 on an internal/usage error. The exit code mirrors
the HINT so a controller can gate, but the authoritative verdict is still Opus's.
"""
from __future__ import annotations

import argparse
import json
import platform
import re
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

IS_WINDOWS = platform.system() == "Windows"

DEFAULT_TEST_PATH = "tests/system/test_performance_audio_off.py"
AUDIO_ON_TEST_PATH = "tests/system/test_performance_audio_on.py"

# Static dev.md Step-5 thresholds (verbatim).
GPU_MEAN_FAIL_PCT = 10.0     # GPU mean increase > 10% → hard fail
SOUND_CORR_FAIL = 0.95       # sound correlation below 0.95 → hard fail
GPU_P99_WARN_PCT = 20.0      # GPU p99 increase > 20% → warn
UNDERRUN_WARN_PCT = 50.0     # underrun count increase > 50% → warn

# Metric line patterns. Each maps a metric key -> a regex with one capturing group (the value). We
# take the FIRST match in the log for each metric (the suite may print a metric more than once).
_FLOAT = r"([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)"
_METRIC_PATTERNS = {
    # "GPU timing: mean=0.234ms" (audio_off) or "GPU compute mean:   0.234 ms" (audio_on).
    "gpu_mean": re.compile(rf"GPU (?:timing: mean=|compute mean:\s*){_FLOAT}\s*ms", re.IGNORECASE),
    # "GPU compute p99:    0.456 ms" (audio_on only).
    "gpu_p99": re.compile(rf"GPU compute p99:\s*{_FLOAT}\s*ms", re.IGNORECASE),
    # "Total timing: mean=1.456ms" (audio_off).
    "total_mean": re.compile(rf"Total timing: mean={_FLOAT}\s*ms", re.IGNORECASE),
    # "Waveform cross-correlation: 0.9981" (audio_off).
    "sound_corr": re.compile(rf"Waveform cross-correlation:\s*{_FLOAT}", re.IGNORECASE),
    # "Underrun count:    3" (audio_on only).
    "underrun": re.compile(r"Underrun count:\s*(\d+)", re.IGNORECASE),
}

# Display metadata: pretty label + whether smaller-is-better (for delta direction) + format.
_METRIC_META = {
    "gpu_mean":   {"label": "GPU mean (ms)",        "fmt": "{:.3f}"},
    "gpu_p99":    {"label": "GPU p99 (ms)",         "fmt": "{:.3f}"},
    "total_mean": {"label": "Total cycle mean (ms)", "fmt": "{:.3f}"},
    "underrun":   {"label": "Underrun count",       "fmt": "{:.0f}"},
    "sound_corr": {"label": "Sound correlation",    "fmt": "{:.4f}"},
}
# dev.md Step-5 row order.
_METRIC_ORDER = ("gpu_mean", "gpu_p99", "total_mean", "underrun", "sound_corr")


# --------------------------------------------------------------------------------------------------
# Run pytest (or read a pre-captured log) and parse the metrics
# --------------------------------------------------------------------------------------------------
def venv_python(root: Path) -> Path:
    """The PianoidCore venv interpreter for this OS (BUILD_SYSTEM.md venv-location rule)."""
    core = root / "PianoidCore"
    return core / (".venv/Scripts/python.exe" if IS_WINDOWS else ".venv/bin/python")


def run_pytest(root: Path, test_paths: list[str], perf_log: Path) -> tuple[int, str]:
    """Run the perf suite with `-s`, tee combined output to perf_log, return (returncode, output).

    Mirrors dev.md Step 2/5: `python -m pytest <paths> -v -s`. We capture combined stdout+stderr so
    both the printed metric lines and the pass/fail summary are parseable. cwd is PianoidCore (the
    test paths + conftest resolve from there).
    """
    core = root / "PianoidCore"
    cmd = [str(venv_python(root)), "-m", "pytest", *test_paths, "-v", "-s"]
    proc = subprocess.run(cmd, cwd=str(core), capture_output=True, text=True)
    output = (proc.stdout or "") + (proc.stderr or "")
    perf_log.parent.mkdir(parents=True, exist_ok=True)
    perf_log.write_text(output, encoding="utf-8")
    return proc.returncode, output


def parse_metrics(output: str) -> dict:
    """Extract the metric values from pytest `-s` output. Missing metric → None (never guessed)."""
    metrics: dict[str, float | None] = {}
    for key, pat in _METRIC_PATTERNS.items():
        m = pat.search(output)
        if m is None:
            metrics[key] = None
        else:
            val = float(m.group(1))
            metrics[key] = int(val) if key == "underrun" else val
    return metrics


def parse_pytest_outcome(output: str) -> dict:
    """Parse pytest's result summary line into {'passed','failed','errors','xfailed','skipped'}.

    Reads the terminal summary (e.g. "5 passed, 1 skipped in 12.3s" or "2 failed, 3 passed ...").
    'failed'/'errors' > 0 is a NEW TEST FAILURE for the dev.md hard-fail rule. If no summary is
    found (the run never produced one), failed is left as None so the caller can flag the anomaly.
    """
    outcome = {"passed": None, "failed": None, "errors": None, "xfailed": None, "skipped": None}
    # The last summary line is the authoritative one; scan all "===…===" summary lines.
    for kind in ("passed", "failed", "error", "errors", "xfailed", "skipped"):
        m = re.search(rf"(\d+)\s+{kind}\b", output)
        if m:
            key = "errors" if kind == "error" else kind
            outcome[key] = int(m.group(1))
    return outcome


# --------------------------------------------------------------------------------------------------
# Deltas + the static-threshold verdict_hint
# --------------------------------------------------------------------------------------------------
def pct_delta(baseline: float | None, after: float | None) -> float | None:
    """Percent change after vs baseline ((after-base)/base*100). None if either side is missing/zero."""
    if baseline is None or after is None or baseline == 0:
        return None
    return (after - baseline) / abs(baseline) * 100.0


def compute_deltas(base: dict, after: dict) -> dict:
    """Per-metric {baseline, after, delta_pct} for every metric key (delta_pct may be None)."""
    out = {}
    for key in _METRIC_ORDER:
        b = base.get(key) if base else None
        a = after.get(key) if after else None
        out[key] = {"baseline": b, "after": a, "delta_pct": pct_delta(b, a)}
    return out


def verdict_hint(deltas: dict, after: dict, outcome: dict | None) -> tuple[str, list[dict]]:
    """Compute the STATIC-threshold verdict hint + the list of offending metrics.

    Returns (hint, offenders) where hint ∈ {'pass','warn','fail'} and offenders is a list of
    {metric, kind('fail'|'warn'), detail, delta}. The thresholds are dev.md Step-5 VERBATIM. This is
    a HINT — Opus owns the authoritative verdict (a perf-tradeoff change may legitimately regress).
    """
    offenders: list[dict] = []

    # HARD FAIL: GPU mean increase > 10%.
    gm = deltas.get("gpu_mean", {}).get("delta_pct")
    if gm is not None and gm > GPU_MEAN_FAIL_PCT:
        offenders.append({"metric": "gpu_mean", "kind": "fail",
                          "detail": f"GPU mean +{gm:.1f}% > {GPU_MEAN_FAIL_PCT:.0f}%", "delta": gm})

    # HARD FAIL: sound correlation below 0.95 (absolute, not a delta).
    sc = after.get("sound_corr") if after else None
    if sc is not None and sc < SOUND_CORR_FAIL:
        offenders.append({"metric": "sound_corr", "kind": "fail",
                          "detail": f"sound_corr {sc:.4f} < {SOUND_CORR_FAIL}", "delta": sc})

    # HARD FAIL: any new test failure/error.
    if outcome is not None:
        failed = (outcome.get("failed") or 0) + (outcome.get("errors") or 0)
        if failed > 0:
            offenders.append({"metric": "tests", "kind": "fail",
                              "detail": f"{failed} test failure(s)/error(s)", "delta": failed})

    # WARN: GPU p99 increase > 20%.
    gp = deltas.get("gpu_p99", {}).get("delta_pct")
    if gp is not None and gp > GPU_P99_WARN_PCT:
        offenders.append({"metric": "gpu_p99", "kind": "warn",
                          "detail": f"GPU p99 +{gp:.1f}% > {GPU_P99_WARN_PCT:.0f}%", "delta": gp})

    # WARN: underrun count increase > 50%.
    up = deltas.get("underrun", {}).get("delta_pct")
    if up is not None and up > UNDERRUN_WARN_PCT:
        offenders.append({"metric": "underrun", "kind": "warn",
                          "detail": f"underrun +{up:.1f}% > {UNDERRUN_WARN_PCT:.0f}%", "delta": up})

    if any(o["kind"] == "fail" for o in offenders):
        return "fail", offenders
    if any(o["kind"] == "warn" for o in offenders):
        return "warn", offenders
    return "pass", offenders


# --------------------------------------------------------------------------------------------------
# Rendering
# --------------------------------------------------------------------------------------------------
def _fmt(key: str, value) -> str:
    if value is None:
        return "—"
    return _METRIC_META[key]["fmt"].format(value)


def render_delta_table(deltas: dict) -> str:
    """The dev.md Step-5 markdown comparison table (Metric | Baseline | After | Delta)."""
    rows = ["| Metric | Baseline | After | Delta |", "|--------|----------|-------|-------|"]
    for key in _METRIC_ORDER:
        d = deltas[key]
        label = _METRIC_META[key]["label"]
        base_s = _fmt(key, d["baseline"])
        after_s = _fmt(key, d["after"])
        dp = d["delta_pct"]
        delta_s = "—" if dp is None else f"{dp:+.1f}%"
        rows.append(f"| {label} | {base_s} | {after_s} | {delta_s} |")
    return "\n".join(rows)


def render_baseline_table(metrics: dict) -> str:
    """The dev.md Step-2 baseline metric table (Metric | Value)."""
    rows = ["| Metric | Value |", "|--------|-------|"]
    for key in _METRIC_ORDER:
        rows.append(f"| {_METRIC_META[key]['label']} | {_fmt(key, metrics.get(key))} |")
    return "\n".join(rows)


# --------------------------------------------------------------------------------------------------
# Modes: baseline / compare
# --------------------------------------------------------------------------------------------------
def _gather(root: Path, args) -> tuple[dict, dict, int]:
    """Run pytest (or read --from-log) → (metrics, outcome, pytest_returncode)."""
    if args.from_log:
        log_path = Path(args.from_log)
        if not log_path.is_file():
            raise FileNotFoundError(f"--from-log not found: {log_path}")
        output = log_path.read_text(encoding="utf-8", errors="replace")
        rc = 0  # an after-the-fact log carries no live returncode; outcome is parsed from text.
    else:
        test_paths = [args.test_path]
        if args.audio_on:
            test_paths.append(AUDIO_ON_TEST_PATH)
        rc, output = run_pytest(root, test_paths, args.perf_log)
    return parse_metrics(output), parse_pytest_outcome(output), rc


def do_baseline(root: Path, args) -> int:
    metrics, outcome, rc = _gather(root, args)
    out_path = Path(args.out) if args.out else (root / "baseline.json")
    payload = {"metrics": metrics, "outcome": outcome, "perf_log": str(args.perf_log),
               "test_path": args.test_path, "audio_on": bool(args.audio_on)}
    out_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    failed = (outcome.get("failed") or 0) + (outcome.get("errors") or 0)
    result = "fail" if (failed > 0 or (rc != 0 and not args.from_log)) else "pass"

    print(f"Baseline metrics (written to {out_path}):")
    print(render_baseline_table(metrics))
    gm = metrics.get("gpu_mean")
    sc = metrics.get("sound_corr")
    gm_s = "n/a" if gm is None else f"{gm:.3f}"
    sc_s = "n/a" if sc is None else f"{sc:.4f}"
    print(f"[BASELINE-TEST] {common.iso_utc()} result={result} perf_log={args.perf_log} "
          f"gpu_mean_ms={gm_s} sound_corr={sc_s}")
    if args.json:
        print(json.dumps(payload, indent=2))
    return 0 if result == "pass" else 2


def do_compare(root: Path, args) -> int:
    base_path = Path(args.compare)
    if not base_path.is_file():
        raise FileNotFoundError(f"baseline file not found: {base_path}")
    base_payload = json.loads(base_path.read_text(encoding="utf-8"))
    base_metrics = base_payload.get("metrics", {})

    after_metrics, outcome, rc = _gather(root, args)
    deltas = compute_deltas(base_metrics, after_metrics)
    hint, offenders = verdict_hint(deltas, after_metrics, outcome)

    print("Performance comparison (baseline vs after):")
    print(render_delta_table(deltas))

    gm_delta = deltas.get("gpu_mean", {}).get("delta_pct")
    sc = after_metrics.get("sound_corr")
    gm_delta_s = "n/a" if gm_delta is None else f"{gm_delta:+.1f}"
    sc_s = "n/a" if sc is None else f"{sc:.4f}"
    print(f"[REGRESSION-CHECK] {common.iso_utc()} gpu_mean_delta_pct={gm_delta_s} "
          f"sound_corr={sc_s} verdict={hint}")
    if hint == "fail":
        for o in offenders:
            if o["kind"] == "fail":
                print(f"[REGRESSION-DETECTED] {common.iso_utc()} file={args.test_path} "
                      f"metric={o['metric']} delta={o['delta']}")
    # The hint is advisory — make the human/Opus split explicit in the output.
    print(f"  verdict_hint={hint} (advisory — Opus owns the authoritative regression verdict)")

    if args.json:
        print(json.dumps({"deltas": deltas, "after": after_metrics, "outcome": outcome,
                          "verdict_hint": hint, "offenders": offenders}, indent=2))
    return 0 if hint in ("pass", "warn") else 2


def default_perf_log(mode: str) -> Path:
    name = "baseline_perf.log" if mode == "baseline" else "postchange_perf.log"
    base = Path("D:/tmp") if (IS_WINDOWS and Path("D:/tmp").exists()) else Path(tempfile.gettempdir())
    return base / name


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Run + parse the perf suite; emit deltas + verdict_hint.")
    grp = ap.add_mutually_exclusive_group(required=True)
    grp.add_argument("--baseline", action="store_true", help="run the suite + write a baseline.json")
    grp.add_argument("--compare", metavar="BASELINE_JSON",
                     help="run the suite + diff against this baseline.json")
    ap.add_argument("--out", default=None, help="baseline.json output path (--baseline; default ./baseline.json)")
    ap.add_argument("--test-path", default=DEFAULT_TEST_PATH,
                    help=f"pytest target (default {DEFAULT_TEST_PATH})")
    ap.add_argument("--audio-on", action="store_true",
                    help="also run the audio_on perf file (needs a real driver; auto-skips otherwise)")
    ap.add_argument("--perf-log", default=None, help="tee raw pytest output here")
    ap.add_argument("--from-log", default=None,
                    help="parse this existing pytest log instead of running pytest")
    ap.add_argument("--json", action="store_true", help="also print machine JSON")
    args = ap.parse_args(argv)

    mode = "baseline" if args.baseline else "compare"
    if args.perf_log is None:
        args.perf_log = default_perf_log(mode)
    else:
        args.perf_log = Path(args.perf_log)

    try:
        root = common.repo_root()
        if args.baseline:
            return do_baseline(root, args)
        return do_compare(root, args)
    except Exception as exc:  # noqa: BLE001
        print(f"[run_perf] ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
