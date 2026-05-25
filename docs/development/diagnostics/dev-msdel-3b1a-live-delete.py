"""dev-msdel-3b1a diagnostic — live HTTP DELETE measurement timing.

Connects to the running modal_adapter_server (default port 5001), creates a fake
measurement on disk (with realistic scenarios) and times the DELETE round-trip.
This captures the full Flask request/response cost, NOT just the catalog call.
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "PianoidCore"))

# Reuse the builder from the catalog-level diagnostic.
from importlib.util import spec_from_file_location, module_from_spec  # noqa: E402

spec = spec_from_file_location(
    "ms_build",
    str(REPO_ROOT / "docs" / "development" / "diagnostics"
        / "dev-msdel-3b1a-delete-timing.py"),
)
ms_build = module_from_spec(spec)
spec.loader.exec_module(ms_build)


def http_delete(url: str, timeout: float = 60.0) -> tuple[int, dict, float]:
    req = urllib.request.Request(url, method="DELETE")
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = json.loads(r.read() or b"{}")
            return r.status, body, (time.perf_counter() - t0) * 1000
    except urllib.error.HTTPError as e:
        body = json.loads(e.read() or b"{}") if e.fp else {}
        return e.code, body, (time.perf_counter() - t0) * 1000


def http_get(url: str, timeout: float = 10.0) -> tuple[int, dict, float]:
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            body = json.loads(r.read() or b"{}")
            return r.status, body, (time.perf_counter() - t0) * 1000
    except urllib.error.HTTPError as e:
        body = json.loads(e.read() or b"{}") if e.fp else {}
        return e.code, body, (time.perf_counter() - t0) * 1000


def main() -> int:
    port = int(os.environ.get("MODAL_ADAPTER_PORT", "5001"))
    backend_base = f"http://127.0.0.1:{port}"

    profile = sys.argv[1] if len(sys.argv) > 1 else "normal"
    profiles = ms_build.profiles if hasattr(ms_build, "profiles") else None
    # The diagnostic script defines profiles inside main(); duplicate here:
    fallback_profiles = {
        "small":  dict(num_scenarios=10, wavs_per_scenario=2,  seconds=1.0, num_channels=2),
        "normal": dict(num_scenarios=30, wavs_per_scenario=5,  seconds=2.0, num_channels=4),
        "large":  dict(num_scenarios=60, wavs_per_scenario=10, seconds=3.0, num_channels=8),
        "huge":   dict(num_scenarios=120, wavs_per_scenario=20, seconds=5.0, num_channels=8),
    }
    params = (profiles or fallback_profiles).get(profile)
    if not params:
        print(f"Unknown profile {profile!r}")
        return 1
    print(f"[profile={profile}] params={params}")

    base = Path(os.environ.get(
        "PIANOID_MEASUREMENTS_DIR", r"D:\modal_measurements"
    ))
    base.mkdir(parents=True, exist_ok=True)

    measurement_id = f"dev_msdel_3b1a_live_{profile}"
    target = base / measurement_id
    if target.exists():
        print(f"Cleaning leftover {target} ...")
        shutil.rmtree(target)

    print(f"Building fake measurement {measurement_id} ...")
    t0 = time.perf_counter()
    ms_build.make_fake_measurement(base, measurement_id, **params)
    print(f"  built in {time.perf_counter() - t0:.1f}s")

    # Live backend may not pick the new folder up automatically — the catalog
    # is a thin "scan on every call" wrapper, so the GET should see it fine.
    status, body, dt = http_get(f"{backend_base}/modal/measurements")
    ids = [m.get("measurement_id") for m in body.get("measurements", [])]
    print(f"GET /modal/measurements -> {status} in {dt:.0f}ms ({len(ids)} entries)")
    if measurement_id not in ids:
        print(f"  WARN: {measurement_id!r} not in {ids[:5]}... — backend cache?")

    # Time the DELETE through Flask
    url = f"{backend_base}/modal/measurements/{measurement_id}"
    print(f"DELETE {url}")
    status, body, dt = http_delete(url, timeout=120.0)
    print(f"  status={status} duration={dt:.0f}ms body={body}")

    print()
    print("==== HEADLINE ====")
    print(f"  DELETE round-trip : {dt:.0f} ms (status={status})")
    if dt > 5000:
        print("  VERDICT           : EXCEEDS frontend axios timeout (5000 ms)")
    elif dt > 2500:
        print("  VERDICT           : within budget but close (>50%)")
    else:
        print(f"  VERDICT           : comfortably within budget ({dt:.0f}/5000 ms)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
