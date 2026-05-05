"""dev-qc02 visualization helper: render before/after charts for a
"good" and a "bad" scenario showing signal_A vs signal_B + the
env_diff/env_signal ratio with the 0.10 threshold line.

Outputs to docs/development/logs/dev-qc02-fix-{good,bad}-scenario.png.

Usage (from repo root):
    cd PianoidCore
    .venv/Scripts/python ../scripts/dev-qc02-charts.py
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

# Resolve repo paths
REPO_ROOT = Path(__file__).resolve().parents[1]
PIANOID_CORE = REPO_ROOT / "PianoidCore"
ROOMRESPONSE = REPO_ROOT.parent / "RoomResponse"

sys.path.insert(0, str(PIANOID_CORE / "pianoid_middleware"))
sys.path.insert(0, str(ROOMRESPONSE))

from modal_adapter import scenario_averager as sa  # noqa: E402

# Pick scenarios
GOOD_SCENARIO = "PlyWood-Scenario19-Take1"  # NEW T_eff = ~160 ms (best class)
BAD_SCENARIO = "PlyWood-Scenario5-Take1"     # NEW T_eff = 0 ms (residual outlier)

PROJECT_DIR = Path(r"D:/modal_measurements/PlyWoodTake1_1")
OUTPUT_DIR = REPO_ROOT / "docs" / "development" / "logs"


def reconstruct_per_channel_pool(scenario_dir: Path):
    """Replicate the canonical preprocessing and return the pooled
    aligned-normalized cycle stack per channel."""
    from signal_processor import SignalProcessor, SignalProcessingConfig
    from calibration_validator_v2 import (
        CalibrationValidatorV2, QualityThresholds)

    raw_dir = scenario_dir / "raw_recordings"
    pattern = re.compile(r"_ch(\d+)\.npy$", re.IGNORECASE)
    raw_by_ch: dict = {}
    for p in sorted(raw_dir.glob("*.npy")):
        m = pattern.search(p.name)
        if m:
            raw_by_ch.setdefault(int(m.group(1)), []).append(p)

    meta_path = scenario_dir / "metadata" / f"{scenario_dir.name}_metadata.json"
    with open(meta_path) as f:
        meta = json.load(f)
    sp_params = meta["measurements"][0]["signal_params"]
    sample_rate = sp_params["sample_rate"]
    cycle_samples = int(round(sample_rate * sp_params["cycle_duration"]))
    num_pulses = sp_params["num_pulses"]
    multichannel_config = sp_params.get("multichannel_config") or {}
    cal_ch = multichannel_config.get("calibration_channel", 0)
    correlation_threshold = multichannel_config.get(
        "alignment_correlation_threshold", 0.7)
    normalize_enabled = multichannel_config.get(
        "normalize_by_calibration", False)

    spc = SignalProcessingConfig(
        num_pulses=num_pulses, cycle_samples=cycle_samples,
        sample_rate=sample_rate, multichannel_config=multichannel_config)
    sp_proc = SignalProcessor(spc)
    thresholds = QualityThresholds.from_config(
        sp_params.get("calibration_quality_config") or {})
    validator = CalibrationValidatorV2(thresholds, sample_rate)

    accs: dict = {}
    for mi in range(len(raw_by_ch[cal_ch])):
        recorded = {c: np.load(raw_by_ch[c][mi]) for c in raw_by_ch}
        initial = sp_proc.extract_cycles(recorded[cal_ch])
        vresults = []
        for i, cyc in enumerate(initial):
            v = validator.validate_cycle(cyc, i)
            vresults.append({
                "cycle_index": i,
                "is_valid": v.calibration_valid,
                "calibration_valid": v.calibration_valid,
                "calibration_metrics": v.calibration_metrics,
                "calibration_failures": v.calibration_failures,
            })
        alignment = sp_proc.align_cycles_by_onset(
            initial, vresults, correlation_threshold=correlation_threshold)
        if len(alignment.get("valid_cycle_indices", [])) == 0:
            continue
        aligned_mc = {
            c: sp_proc.apply_alignment_to_channel(recorded[c], alignment)
            for c in raw_by_ch}
        if normalize_enabled:
            processed, _ = sp_proc.normalize_by_calibration(
                aligned_mc, vresults, cal_ch,
                alignment["valid_cycle_indices"])
        else:
            processed = aligned_mc
        for c, cycles in processed.items():
            if cycles is not None and cycles.size > 0:
                accs.setdefault(c, []).append(cycles)

    return {c: np.concatenate(stacks, axis=0) for c, stacks in accs.items()}, sample_rate, cal_ch


def render_scenario_chart(scenario_name: str, kind: str, out_path: Path) -> None:
    scenario_dir = PROJECT_DIR / scenario_name
    pooled, sample_rate, cal_ch = reconstruct_per_channel_pool(scenario_dir)
    response_channels = sorted(c for c in pooled if c != cal_ch)

    # Use the production seed
    seed = abs(hash(scenario_name)) & 0xFFFF

    # Pick one representative response channel: the WORST T_eff for both
    # scenarios so the chart shows the actual bottleneck.
    qc_path = scenario_dir / "averaged_responses" / sa.EFFECTIVE_SIGNAL_LENGTH_FILENAME
    with open(qc_path) as f:
        qc = json.load(f)
    per_ch = qc["per_channel_t_eff_ms"]
    response_t_effs = {int(c): v for c, v in per_ch.items()
                       if c != str(cal_ch) and v is not None}
    if not response_t_effs:
        return
    worst_ch = min(response_t_effs, key=lambda c: response_t_effs[c])
    worst_t_eff = response_t_effs[worst_ch]

    p = pooled[worst_ch]
    n_cycles = p.shape[0]
    ha, hb = sa._split_indices(n_cycles, seed)
    avg_a = p[ha].mean(axis=0)
    avg_b = p[hb].mean(axis=0)
    full = p.mean(axis=0)

    n = len(full)
    t_ms = np.arange(n) * 1000.0 / sample_rate

    # Compute envelopes (Hilbert) + smoothing (5 ms uniform) — match
    # what the real algorithm uses
    smoothing_samples = max(1, int(round(5.0 * sample_rate / 1000.0)))
    env_signal = sa._compute_envelope(
        full, "hilbert", smoothing_samples, smoothing_samples)
    diff = avg_a - avg_b
    env_diff = sa._compute_envelope(
        diff, "hilbert", smoothing_samples, smoothing_samples)
    safe_es = np.maximum(env_signal, 1e-12)
    ratio = env_diff / safe_es

    # Plot two stacked subplots
    fig, (ax_top, ax_bot) = plt.subplots(
        2, 1, figsize=(11, 7), gridspec_kw={"height_ratios": [1.4, 1]})

    # Top: signal_A vs signal_B overlay (with envelope shadow)
    ax_top.plot(t_ms, avg_a, lw=0.8, color="#1f77b4",
                label=f"Half A (cycles={len(ha)})")
    ax_top.plot(t_ms, avg_b, lw=0.8, color="#ff7f0e",
                label=f"Half B (cycles={len(hb)})", alpha=0.7)
    ax_top.plot(t_ms, env_signal, lw=1.2, color="black",
                label="env(full mean)", alpha=0.5)
    ax_top.set_ylabel("Amplitude (normalized)")
    ax_top.legend(loc="upper right", fontsize=9)
    title = (f"{kind.upper()} scenario: {scenario_name}, ch{worst_ch}\n"
             f"T_eff (ch{worst_ch}) = {worst_t_eff:.1f} ms · "
             f"split seed={seed} · n_cycles_total={n_cycles}")
    ax_top.set_title(title, fontsize=11)
    ax_top.grid(alpha=0.3)

    # Bottom: env_diff/env_signal ratio + threshold line + T_eff marker
    ax_bot.plot(t_ms, ratio, lw=1.0, color="#d62728",
                label="env_diff / env_signal")
    ax_bot.axhline(0.10, color="black", ls="--", lw=1,
                   label="Threshold = 0.10")
    if worst_t_eff is not None:
        ax_bot.axvline(worst_t_eff, color="green", ls=":", lw=1.5,
                       label=f"T_eff = {worst_t_eff:.1f} ms")
    ax_bot.set_xlabel("Time (ms)")
    ax_bot.set_ylabel("Ratio")
    ax_bot.legend(loc="upper right", fontsize=9)
    ax_bot.set_ylim(0, max(0.5, np.percentile(ratio, 99)))
    ax_bot.grid(alpha=0.3)

    fig.tight_layout()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out_path, dpi=120)
    plt.close(fig)
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    render_scenario_chart(
        GOOD_SCENARIO, "good",
        OUTPUT_DIR / "dev-qc02-fix-good-scenario.png")
    render_scenario_chart(
        BAD_SCENARIO, "bad",
        OUTPUT_DIR / "dev-qc02-fix-bad-scenario.png")
    print("done")
