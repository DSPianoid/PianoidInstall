"""Unit tests for run_perf.py — perf metric parser, deltas, and the static-threshold verdict_hint.

No real pytest is ever run: the parser is exercised on captured-log text, and the one test that
covers the run path monkeypatches run_perf.run_pytest. The verdict_hint thresholds are checked
against dev.md Step-5 (>10% GPU mean / <0.95 corr → fail; >20% p99 / >50% underrun → warn).
"""
from __future__ import annotations

import json

import pytest

import common
import run_perf


# A realistic audio_off + audio_on perf-suite stdout (the exact print-line formats from
# test_performance_audio_off.py / test_performance_audio_on.py).
SAMPLE_LOG = """\
tests/system/test_performance_audio_off.py::TestGpuCycleTiming::test_gpu_cycle_timing
  GPU timing: mean=0.234ms, budget=1.333ms, over=2/750 (0.3%)
PASSED
  Total timing: mean=1.456ms, budget=2.000ms, over=5/750 (0.7%), max_consecutive=2
  Detected frequency: 261.6 Hz (expected 261.6, error=0.01%)
  peak=1.23e-02, rms=4.56e-03, samples=144000
  Waveform cross-correlation: 0.9981
  Spectral cross-correlation: 0.9994
  GPU compute mean:       0.230 ms
  GPU compute p99:        0.456 ms
  Callback count:         3200
  Underrun count:         3
============== 5 passed, 1 skipped in 12.34s ==============
"""


# --------------------------------------------------------------------------------------------------
# parse_metrics
# --------------------------------------------------------------------------------------------------
def test_parse_metrics_extracts_all_fields():
    m = run_perf.parse_metrics(SAMPLE_LOG)
    assert m["gpu_mean"] == pytest.approx(0.234)   # GPU timing: mean= line wins (first match)
    assert m["gpu_p99"] == pytest.approx(0.456)
    assert m["total_mean"] == pytest.approx(1.456)
    assert m["sound_corr"] == pytest.approx(0.9981)
    assert m["underrun"] == 3
    assert isinstance(m["underrun"], int)


def test_parse_metrics_missing_are_none():
    # audio_off-only run: no GPU p99 / underrun lines.
    log = (
        "  GPU timing: mean=0.250ms, over=0/750 (0.0%)\n"
        "  Waveform cross-correlation: 0.9990\n"
        "============== 4 passed in 9.0s ==============\n"
    )
    m = run_perf.parse_metrics(log)
    assert m["gpu_mean"] == pytest.approx(0.250)
    assert m["sound_corr"] == pytest.approx(0.9990)
    assert m["gpu_p99"] is None
    assert m["underrun"] is None
    assert m["total_mean"] is None


def test_parse_metrics_falls_back_to_compute_mean_line():
    # If only the audio_on "GPU compute mean:" form is present, it is still parsed.
    log = "  GPU compute mean:       0.321 ms\n"
    m = run_perf.parse_metrics(log)
    assert m["gpu_mean"] == pytest.approx(0.321)


def test_parse_metrics_handles_scientific_notation_corr():
    log = "  Waveform cross-correlation: 9.81e-01\n"
    m = run_perf.parse_metrics(log)
    assert m["sound_corr"] == pytest.approx(0.981)


# --------------------------------------------------------------------------------------------------
# parse_pytest_outcome
# --------------------------------------------------------------------------------------------------
def test_parse_outcome_passed_skipped():
    o = run_perf.parse_pytest_outcome("=== 5 passed, 1 skipped in 12.3s ===")
    assert o["passed"] == 5
    assert o["skipped"] == 1
    assert o["failed"] is None


def test_parse_outcome_with_failures():
    o = run_perf.parse_pytest_outcome("=== 2 failed, 3 passed, 1 error in 4s ===")
    assert o["failed"] == 2
    assert o["passed"] == 3
    assert o["errors"] == 1


# --------------------------------------------------------------------------------------------------
# deltas
# --------------------------------------------------------------------------------------------------
def test_pct_delta_basic():
    assert run_perf.pct_delta(100.0, 110.0) == pytest.approx(10.0)
    assert run_perf.pct_delta(100.0, 90.0) == pytest.approx(-10.0)


def test_pct_delta_none_and_zero():
    assert run_perf.pct_delta(None, 1.0) is None
    assert run_perf.pct_delta(1.0, None) is None
    assert run_perf.pct_delta(0.0, 1.0) is None


def test_compute_deltas_covers_all_keys():
    base = {"gpu_mean": 0.2, "sound_corr": 0.99}
    after = {"gpu_mean": 0.22, "sound_corr": 0.98}
    d = run_perf.compute_deltas(base, after)
    assert set(d.keys()) == set(run_perf._METRIC_ORDER)
    assert d["gpu_mean"]["delta_pct"] == pytest.approx(10.0)
    assert d["gpu_p99"]["delta_pct"] is None  # absent both sides


# --------------------------------------------------------------------------------------------------
# verdict_hint — every dev.md Step-5 threshold branch
# --------------------------------------------------------------------------------------------------
def _hint(base, after, outcome=None):
    deltas = run_perf.compute_deltas(base, after)
    return run_perf.verdict_hint(deltas, after, outcome)


def test_verdict_pass_when_within_thresholds():
    hint, off = _hint({"gpu_mean": 0.20, "sound_corr": 0.99},
                      {"gpu_mean": 0.21, "sound_corr": 0.99})  # +5%, corr ok
    assert hint == "pass"
    assert off == []


def test_verdict_fail_gpu_mean_over_10pct():
    hint, off = _hint({"gpu_mean": 0.20, "sound_corr": 0.99},
                      {"gpu_mean": 0.23, "sound_corr": 0.99})  # +15%
    assert hint == "fail"
    assert any(o["metric"] == "gpu_mean" and o["kind"] == "fail" for o in off)


def test_verdict_fail_sound_corr_below_095():
    hint, off = _hint({"gpu_mean": 0.20, "sound_corr": 0.99},
                      {"gpu_mean": 0.20, "sound_corr": 0.94})
    assert hint == "fail"
    assert any(o["metric"] == "sound_corr" and o["kind"] == "fail" for o in off)


def test_verdict_fail_on_test_failure():
    hint, off = _hint({"gpu_mean": 0.20, "sound_corr": 0.99},
                      {"gpu_mean": 0.20, "sound_corr": 0.99},
                      outcome={"failed": 1, "errors": 0})
    assert hint == "fail"
    assert any(o["metric"] == "tests" for o in off)


def test_verdict_warn_gpu_p99_over_20pct():
    hint, off = _hint({"gpu_mean": 0.20, "gpu_p99": 0.40, "sound_corr": 0.99},
                      {"gpu_mean": 0.20, "gpu_p99": 0.50, "sound_corr": 0.99})  # p99 +25%
    assert hint == "warn"
    assert any(o["metric"] == "gpu_p99" and o["kind"] == "warn" for o in off)


def test_verdict_warn_underrun_over_50pct():
    hint, off = _hint({"gpu_mean": 0.20, "underrun": 2, "sound_corr": 0.99},
                      {"gpu_mean": 0.20, "underrun": 4, "sound_corr": 0.99})  # +100%
    assert hint == "warn"
    assert any(o["metric"] == "underrun" and o["kind"] == "warn" for o in off)


def test_verdict_fail_dominates_warn():
    # Both a fail (gpu mean +20%) and a warn (p99 +30%) present → fail wins.
    hint, off = _hint({"gpu_mean": 0.20, "gpu_p99": 0.40, "sound_corr": 0.99},
                      {"gpu_mean": 0.24, "gpu_p99": 0.52, "sound_corr": 0.99})
    assert hint == "fail"


def test_verdict_missing_metrics_do_not_trip():
    # Only gpu_mean present, within budget; everything else None → pass (never guessed).
    hint, off = _hint({"gpu_mean": 0.20}, {"gpu_mean": 0.205})
    assert hint == "pass"


# --------------------------------------------------------------------------------------------------
# rendering
# --------------------------------------------------------------------------------------------------
def test_render_delta_table_shape():
    d = run_perf.compute_deltas({"gpu_mean": 0.20, "sound_corr": 0.99},
                                {"gpu_mean": 0.22, "sound_corr": 0.98})
    table = run_perf.render_delta_table(d)
    assert "| Metric | Baseline | After | Delta |" in table
    assert "GPU mean (ms)" in table
    assert "+10.0%" in table
    # Missing metric renders as em-dash, not a crash.
    assert "| GPU p99 (ms) | — | — | — |" in table


def test_render_baseline_table_shape():
    table = run_perf.render_baseline_table({"gpu_mean": 0.234, "sound_corr": 0.9981})
    assert "| Metric | Value |" in table
    assert "| GPU mean (ms) | 0.234 |" in table
    assert "| Underrun count | — |" in table  # absent → em-dash


# --------------------------------------------------------------------------------------------------
# main() — baseline + compare via --from-log (no pytest), and the run path mocked
# --------------------------------------------------------------------------------------------------
def test_main_baseline_from_log_writes_json_and_marker(fake_repo, tmp_path, capsys):
    log = tmp_path / "perf.log"
    log.write_text(SAMPLE_LOG, encoding="utf-8")
    out = tmp_path / "base.json"
    rc = run_perf.main(["--baseline", "--from-log", str(log), "--out", str(out)])
    captured = capsys.readouterr().out
    assert rc == 0
    assert "[BASELINE-TEST]" in captured
    assert "gpu_mean_ms=0.234" in captured
    assert "sound_corr=0.9981" in captured
    payload = json.loads(out.read_text(encoding="utf-8"))
    assert payload["metrics"]["gpu_mean"] == pytest.approx(0.234)


def test_main_compare_from_log_fail_exit2(fake_repo, tmp_path, capsys):
    base = tmp_path / "base.json"
    base.write_text(json.dumps({"metrics": {"gpu_mean": 0.20, "sound_corr": 0.99}}), encoding="utf-8")
    after_log = tmp_path / "after.log"
    after_log.write_text(
        "  GPU timing: mean=0.260ms, over=0/750 (0.0%)\n"   # +30% → fail
        "  Waveform cross-correlation: 0.9990\n"
        "============== 5 passed in 10s ==============\n",
        encoding="utf-8")
    rc = run_perf.main(["--compare", str(base), "--from-log", str(after_log)])
    out = capsys.readouterr().out
    assert rc == 2
    assert "[REGRESSION-CHECK]" in out
    assert "verdict=fail" in out
    assert "[REGRESSION-DETECTED]" in out


def test_main_compare_from_log_pass_exit0(fake_repo, tmp_path, capsys):
    base = tmp_path / "base.json"
    base.write_text(json.dumps({"metrics": {"gpu_mean": 0.20, "sound_corr": 0.99}}), encoding="utf-8")
    after_log = tmp_path / "after.log"
    after_log.write_text(
        "  GPU timing: mean=0.205ms, over=0/750 (0.0%)\n"   # +2.5% → pass
        "  Waveform cross-correlation: 0.9985\n"
        "============== 5 passed in 10s ==============\n",
        encoding="utf-8")
    rc = run_perf.main(["--compare", str(base), "--from-log", str(after_log)])
    out = capsys.readouterr().out
    assert rc == 0
    assert "verdict=pass" in out


def test_main_run_path_mocks_pytest(fake_repo, tmp_path, monkeypatch, capsys):
    """The default run path calls run_pytest; mock it so NO real pytest spawns."""
    def fake_run_pytest(root, test_paths, perf_log):
        perf_log.parent.mkdir(parents=True, exist_ok=True)
        perf_log.write_text(SAMPLE_LOG, encoding="utf-8")
        return 0, SAMPLE_LOG
    monkeypatch.setattr(run_perf, "run_pytest", fake_run_pytest)

    out_json = tmp_path / "base.json"
    rc = run_perf.main(["--baseline", "--out", str(out_json), "--perf-log", str(tmp_path / "p.log")])
    assert rc == 0
    assert "[BASELINE-TEST]" in capsys.readouterr().out
    assert out_json.exists()


def test_main_compare_missing_baseline_errors(fake_repo, tmp_path, capsys):
    rc = run_perf.main(["--compare", str(tmp_path / "nope.json"), "--from-log", str(tmp_path / "x.log")])
    assert rc == 1
    assert "ERROR" in capsys.readouterr().err


def test_main_requires_a_mode(fake_repo):
    # Neither --baseline nor --compare → argparse error (SystemExit).
    with pytest.raises(SystemExit):
        run_perf.main([])
