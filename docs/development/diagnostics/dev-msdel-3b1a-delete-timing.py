"""dev-msdel-3b1a diagnostic — time MeasurementCatalog.delete() on a realistic
fake measurement.

Creates a temporary v2 measurement with N scenarios × M channels × T seconds of
synthetic 48 kHz int16 audio, then runs delete and reports timing for each step.

Usage:
    .venv/Scripts/python.exe docs/development/diagnostics/dev-msdel-3b1a-delete-timing.py
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

# Add PianoidCore to path so we can import the middleware.
REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "PianoidCore"))

import numpy as np
from scipy.io import wavfile  # type: ignore

from pianoid_middleware.modal_adapter.measurement_catalog import (
    MeasurementCatalog,
    find_projects_referencing,
)


def make_fake_measurement(
    base: Path,
    measurement_id: str,
    *,
    num_scenarios: int = 30,
    wavs_per_scenario: int = 5,
    seconds: float = 2.0,
    sample_rate: int = 48000,
    num_channels: int = 4,
) -> Path:
    """Build a realistic-looking v2 Measurement folder.

    Layout mirrors `MeasurementEntity` (setup/* JSON + scenarios/<sid>/*.wav).
    """
    root = base / measurement_id
    (root / "setup").mkdir(parents=True, exist_ok=True)
    (root / "scenarios").mkdir(parents=True, exist_ok=True)

    # Minimal v2 manifest
    manifest = {
        "measurement_id": measurement_id,
        "schema_version": 2,
        "sample_rate": sample_rate,
    }
    (root / "measurement.json").write_text(json.dumps(manifest, indent=2))

    # Required setup files (empty payloads — delete doesn't care)
    for name in (
        "audio_config",
        "impulse_config",
        "series_config",
        "mapping_config",
        "calibration_criteria",
    ):
        (root / "setup" / f"{name}.json").write_text("{}")

    # Synthetic noise per scenario, written as multi-channel int16 WAVs.
    n_samples = int(sample_rate * seconds)
    rng = np.random.default_rng(seed=42)
    for sid in range(num_scenarios):
        sdir = root / "scenarios" / f"scenario_{sid}"
        sdir.mkdir(parents=True, exist_ok=True)
        for w in range(wavs_per_scenario):
            data = (
                rng.standard_normal((n_samples, num_channels)) * 8000
            ).astype(np.int16)
            wavfile.write(str(sdir / f"channel_{w}.wav"), sample_rate, data)
        # A small JSON per scenario
        (sdir / "scenario.json").write_text(
            json.dumps({"sid": sid, "num_channels": num_channels})
        )

    return root


def count_tree(path: Path) -> tuple[int, int]:
    files, bytes_ = 0, 0
    for p in path.rglob("*"):
        if p.is_file():
            files += 1
            try:
                bytes_ += p.stat().st_size
            except OSError:
                pass
    return files, bytes_


def main() -> int:
    # Use a real-looking base folder under D:\modal_measurements so the path
    # length and filesystem are identical to production.
    base = Path(os.environ.get("PIANOID_MEASUREMENTS_DIR", r"D:\modal_measurements"))
    base.mkdir(parents=True, exist_ok=True)
    projects_base = Path(os.environ.get(
        "PIANOID_PROJECTS_DIR", r"D:\modal_projects"
    ))
    projects_base.mkdir(parents=True, exist_ok=True)

    # Allow tuning the load via CLI flag — default is "normal" (matches
    # typical user measurement); pass "huge" to simulate a heavy session.
    profile = sys.argv[1] if len(sys.argv) > 1 else "normal"
    profiles = {
        "small":  dict(num_scenarios=10, wavs_per_scenario=2,  seconds=1.0, num_channels=2),
        "normal": dict(num_scenarios=30, wavs_per_scenario=5,  seconds=2.0, num_channels=4),
        "large":  dict(num_scenarios=60, wavs_per_scenario=10, seconds=3.0, num_channels=8),
        "huge":   dict(num_scenarios=120, wavs_per_scenario=20, seconds=5.0, num_channels=8),
    }
    if profile not in profiles:
        print(f"Unknown profile {profile!r}; options: {list(profiles)}")
        return 1
    params = profiles[profile]
    print(f"[profile={profile}] params={params}")

    measurement_id = f"dev_msdel_3b1a_fake_{profile}"
    target = base / measurement_id
    if target.exists():
        print(f"Cleaning leftover {target} ...")
        shutil.rmtree(target)

    # ---- Build a realistic fake measurement -------------------------------
    print(f"Building fake measurement {measurement_id} under {base} ...")
    t0 = time.perf_counter()
    root = make_fake_measurement(base, measurement_id, **params)
    build_secs = time.perf_counter() - t0
    files, bytes_ = count_tree(root)
    print(
        f"  Built in {build_secs:.2f}s - {files} files, "
        f"{bytes_ / 1024 / 1024:.1f} MB"
    )

    # ---- Time find_projects_referencing -----------------------------------
    n_iter = 3
    fpr_times = []
    for _ in range(n_iter):
        t0 = time.perf_counter()
        linked = find_projects_referencing(measurement_id, str(projects_base))
        fpr_times.append(time.perf_counter() - t0)
    print(
        f"find_projects_referencing on {projects_base}: "
        f"min={min(fpr_times) * 1000:.1f}ms "
        f"max={max(fpr_times) * 1000:.1f}ms "
        f"(linked={linked})"
    )

    # ---- Time the actual delete -------------------------------------------
    cat = MeasurementCatalog(measurements_base=str(base))
    t0 = time.perf_counter()
    result = cat.delete(measurement_id, projects_base=str(projects_base))
    delete_secs = time.perf_counter() - t0
    print(f"MeasurementCatalog.delete: {delete_secs * 1000:.1f}ms")
    print(f"  result={result}")

    # ---- Headline ---------------------------------------------------------
    print()
    print("==== HEADLINE ====")
    print(f"  measurement size : {files} files, {bytes_ / 1024 / 1024:.1f} MB")
    print(f"  delete duration  : {delete_secs * 1000:.0f} ms")
    if delete_secs * 1000 > 5000:
        print(
            "  VERDICT          : EXCEEDS 5000 ms axios timeout "
            "→ frontend will fail."
        )
    elif delete_secs * 1000 > 2500:
        print(
            "  VERDICT          : within 5000 ms but uncomfortably close "
            "(>50% of budget)."
        )
    else:
        print(
            f"  VERDICT          : comfortably within budget "
            f"({delete_secs * 1000:.0f}/5000 ms)."
        )

    return 0


if __name__ == "__main__":
    sys.exit(main())
