"""ana-mmnan-7c3a — Audit persisted modal mass results for LG_p3.

Read-only audit of `D:/modal_projects/LG_p3/modal_adapter/modal_mass/`.
Categorises every chain into:

* VALID        — m_relative finite, m_absolute finite, shapes finite,
                 fit_quality in [0,1], shapes consistent with each other.
* NAN_BY_DESIGN — m_relative is null AND m_absolute is null AND
                  shape arrays are all empty AND fit_quality_overall is 0
                  AND every per-scenario residue has fit_quality=0.
                  This is the documented "kernel refused" output for
                  chains with insufficient data.
* INVALID      — anything else (the bug-hunt bucket).

Outputs:
  - Per-category counts to stdout
  - JSON dump of all INVALID chain reasons (so /dev can act on them)
  - Reference-chain consistency check (must have m_relative == 1.0)
  - Reasons sub-classification of NAN_BY_DESIGN (no FRF, low bins, etc.)
"""
from __future__ import annotations

import json
import math
import os
from collections import Counter, defaultdict
from typing import Any, Dict, List, Tuple

BASE = r"D:/modal_projects/LG_p3/modal_adapter/modal_mass"


def is_finite_number(v: Any) -> bool:
    if v is None:
        return False
    if isinstance(v, bool):
        return False  # JSON true/false should not appear in numeric slots
    try:
        f = float(v)
    except (TypeError, ValueError):
        return False
    return math.isfinite(f)


def shape_list_all_finite(arr: List[Dict[str, Any]]) -> bool:
    """True if every entry in the indexed-list shape has finite real+imag."""
    for entry in arr:
        if not is_finite_number(entry.get("real")):
            return False
        if not is_finite_number(entry.get("imag")):
            return False
    return True


def audit_chain(payload: Dict[str, Any]) -> Tuple[str, List[str]]:
    """Return (bucket, reasons). bucket is one of VALID/NAN_BY_DESIGN/INVALID."""
    reasons: List[str] = []

    m_abs = payload.get("m_absolute")
    m_rel = payload.get("m_relative")
    fq = payload.get("fit_quality_overall")
    sa = payload.get("shape_actuator", [])
    sr = payload.get("shape_response", [])
    sa_mn = payload.get("shape_actuator_mass_normalised", [])
    sr_mn = payload.get("shape_response_mass_normalised", [])
    per_sc = payload.get("per_scenario_residues", {}) or {}

    # Reference chain detection
    is_ref = bool(payload.get("is_reference_mode", False))

    # fit_quality_overall must be a finite number in [0, 1]
    if fq is None or not isinstance(fq, (int, float)) or not math.isfinite(float(fq)):
        return "INVALID", [f"fit_quality_overall not finite: {fq!r}"]
    fq = float(fq)
    if fq < 0.0 or fq > 1.0:
        return "INVALID", [f"fit_quality_overall out of [0,1]: {fq}"]

    # Compute per-scenario stats
    n_per_sc_entries = 0
    n_per_sc_zero_residue = 0
    n_per_sc_nonzero_residue = 0
    n_per_sc_nonzero_fq = 0
    n_per_sc_nan_residue = 0
    n_per_sc_invalid_fq = 0
    for sc_idx, channels in per_sc.items():
        for ch_idx, entry in (channels or {}).items():
            n_per_sc_entries += 1
            r = entry.get("real")
            im = entry.get("imag")
            q = entry.get("fit_quality")
            if not isinstance(r, (int, float)) or not isinstance(im, (int, float)):
                n_per_sc_nan_residue += 1
                continue
            if not math.isfinite(float(r)) or not math.isfinite(float(im)):
                n_per_sc_nan_residue += 1
                continue
            if r == 0.0 and im == 0.0:
                n_per_sc_zero_residue += 1
            else:
                n_per_sc_nonzero_residue += 1
            if not isinstance(q, (int, float)) or not math.isfinite(float(q)):
                n_per_sc_invalid_fq += 1
            elif float(q) > 0.0:
                n_per_sc_nonzero_fq += 1

    # NAN-BY-DESIGN classification
    # The kernel produced no usable residue → orchestrator wrote nulls.
    # Conditions: m_absolute is None AND m_relative is None AND both shape
    # lists empty AND fit_quality_overall is exactly 0.0 AND every
    # per-scenario residue is exactly 0+0j with fit_quality 0.
    nan_by_design = (
        m_abs is None
        and m_rel is None
        and len(sa) == 0
        and len(sr) == 0
        and len(sa_mn) == 0
        and len(sr_mn) == 0
        and fq == 0.0
        and n_per_sc_nonzero_residue == 0
        and n_per_sc_nonzero_fq == 0
        and n_per_sc_nan_residue == 0
    )

    if nan_by_design:
        # Sub-classify the reason
        if n_per_sc_entries == 0:
            sub = "no_scenarios_with_frf"  # detections didn't intersect with persisted FRF
        else:
            sub = "kernel_refused_zero_residue"
        return "NAN_BY_DESIGN", [sub]

    # Now check VALID conditions
    # m_absolute must be a positive finite number
    if not is_finite_number(m_abs):
        reasons.append(f"m_absolute not finite: {m_abs!r}")
    elif float(m_abs) <= 0:
        reasons.append(f"m_absolute non-positive: {m_abs}")
    if not is_finite_number(m_rel):
        # m_rel can legitimately be None if no reference mode was set,
        # but the orchestrator computed reference_mode_chain_id=312 → m_rel
        # should be finite when m_absolute is finite.
        # We treat m_rel=None as INVALID *if* m_absolute is finite (and
        # the reference is set globally — see top-level check).
        reasons.append(f"m_relative not finite: {m_rel!r}")
    elif float(m_rel) <= 0:
        reasons.append(f"m_relative non-positive: {m_rel}")

    # Shapes must have finite entries (the serialiser drops NaN entries,
    # so any present entry must be finite)
    if not shape_list_all_finite(sa):
        reasons.append("shape_actuator contains non-finite entries")
    if not shape_list_all_finite(sr):
        reasons.append("shape_response contains non-finite entries")
    if not shape_list_all_finite(sa_mn):
        reasons.append("shape_actuator_mass_normalised contains non-finite entries")
    if not shape_list_all_finite(sr_mn):
        reasons.append("shape_response_mass_normalised contains non-finite entries")

    # Mass-normalised must mirror raw indices
    raw_a_idx = sorted(e["index"] for e in sa)
    mn_a_idx = sorted(e["index"] for e in sa_mn)
    if raw_a_idx != mn_a_idx:
        reasons.append(
            f"shape_actuator vs mass_normalised index mismatch: "
            f"{len(raw_a_idx)} vs {len(mn_a_idx)} entries")
    raw_s_idx = sorted(e["index"] for e in sr)
    mn_s_idx = sorted(e["index"] for e in sr_mn)
    if raw_s_idx != mn_s_idx:
        reasons.append(
            f"shape_response vs mass_normalised index mismatch: "
            f"{len(raw_s_idx)} vs {len(mn_s_idx)} entries")

    # Consistency: if m_abs is finite and >0, mass-normalised entry must
    # equal raw / sqrt(m_abs). Sample-check (not every entry, just first).
    if (
        is_finite_number(m_abs)
        and float(m_abs) > 0
        and sa
        and sa_mn
        and raw_a_idx == mn_a_idx
    ):
        sqrt_m = math.sqrt(float(m_abs))
        idx_to_raw = {e["index"]: (e["real"], e["imag"]) for e in sa}
        for mn_entry in sa_mn[:3]:
            raw_r, raw_i = idx_to_raw[mn_entry["index"]]
            expect_r = raw_r / sqrt_m
            expect_i = raw_i / sqrt_m
            if (abs(mn_entry["real"] - expect_r) > 1e-9
                    + 1e-9 * abs(expect_r)
                    or abs(mn_entry["imag"] - expect_i)
                    > 1e-9 + 1e-9 * abs(expect_i)):
                reasons.append(
                    f"shape_actuator_mass_normalised inconsistent with "
                    f"raw/sqrt(m_absolute) at index {mn_entry['index']}")
                break

    # Reference chain: m_relative must be exactly 1.0
    if is_ref:
        if not is_finite_number(m_rel) or float(m_rel) != 1.0:
            reasons.append(
                f"reference chain m_relative != 1.0 exactly: {m_rel!r}")

    if reasons:
        return "INVALID", reasons
    return "VALID", []


def main() -> None:
    with open(os.path.join(BASE, "index.json")) as f:
        idx = json.load(f)

    ref_id = idx.get("reference_mode_chain_id")
    summary_chains = idx.get("chains", [])
    summary_by_id: Dict[int, Dict[str, Any]] = {
        int(c["chain_id"]): c for c in summary_chains}

    # Files on disk
    files = sorted(
        name for name in os.listdir(BASE)
        if name.startswith("chain_") and name.endswith(".json"))
    file_ids = set()
    for name in files:
        try:
            cid = int(name[len("chain_"):-len(".json")])
        except ValueError:
            continue
        file_ids.add(cid)

    # Duplicate chain_id check in summary
    id_counts = Counter(int(c["chain_id"]) for c in summary_chains)
    duplicates = [cid for cid, n in id_counts.items() if n > 1]

    # File vs summary diff
    summary_ids = set(summary_by_id.keys())
    files_only = sorted(file_ids - summary_ids)
    summary_only = sorted(summary_ids - file_ids)

    buckets: Dict[str, List[int]] = {
        "VALID": [],
        "NAN_BY_DESIGN": [],
        "INVALID": [],
    }
    nan_sub_reasons: Counter = Counter()
    invalid_reasons: Dict[int, List[str]] = {}
    summary_vs_payload_mismatches: Dict[int, List[str]] = {}

    for cid in sorted(file_ids):
        with open(os.path.join(BASE, f"chain_{cid}.json")) as f:
            payload = json.load(f)
        bucket, reasons = audit_chain(payload)
        buckets[bucket].append(cid)
        if bucket == "NAN_BY_DESIGN":
            nan_sub_reasons[reasons[0]] += 1
        if bucket == "INVALID":
            invalid_reasons[cid] = reasons

        # Cross-check summary vs payload
        s = summary_by_id.get(cid)
        if s is not None:
            mismatches: List[str] = []
            for k in (
                "m_absolute", "m_relative", "fit_quality_overall",
                "fit_method", "is_reference_mode",
            ):
                if k == "fit_quality_overall":
                    sv = float(s.get(k, 0.0))
                    pv = float(payload.get(k, 0.0))
                    if abs(sv - pv) > 1e-9:
                        mismatches.append(f"{k}: summary={sv} payload={pv}")
                else:
                    sv = s.get(k)
                    pv = payload.get(k)
                    if sv != pv:
                        mismatches.append(f"{k}: summary={sv!r} payload={pv!r}")
            if mismatches:
                summary_vs_payload_mismatches[cid] = mismatches

    print("=" * 60)
    print("LG_p3 modal-mass audit — ana-mmnan-7c3a")
    print("=" * 60)
    print(f"Total chain_*.json files on disk: {len(file_ids)}")
    print(f"Total summary chains in index.json: {len(summary_chains)}")
    print(f"Reference chain id: {ref_id}")
    print()
    print("Per-category counts:")
    for b, ids in buckets.items():
        print(f"  {b}: {len(ids)}")
    print()
    print("NAN_BY_DESIGN sub-reasons:")
    for sub, n in nan_sub_reasons.most_common():
        print(f"  {sub}: {n}")
    print()
    print("Structural checks:")
    print(f"  Duplicate chain_ids in summary: {duplicates or 'none'}")
    print(f"  Files on disk but not in summary: {files_only or 'none'}")
    print(f"  Summary entries but no file on disk: {summary_only or 'none'}")
    print(f"  Summary vs payload field mismatches: "
          f"{len(summary_vs_payload_mismatches)}")
    if summary_vs_payload_mismatches:
        for cid, ms in list(summary_vs_payload_mismatches.items())[:5]:
            print(f"    chain {cid}: {ms}")
    print()
    print("INVALID chains:")
    print(f"  total: {len(invalid_reasons)}")
    if invalid_reasons:
        # Group by reason signature for readability
        sig_counts: Counter = Counter()
        for cid, rs in invalid_reasons.items():
            sig = " | ".join(rs)
            sig_counts[sig] += 1
        for sig, n in sig_counts.most_common(15):
            print(f"  [{n}] {sig}")
        # Show a few example chain ids per top sig
        for sig, _ in list(sig_counts.most_common(5)):
            sample = [cid for cid, rs in invalid_reasons.items()
                      if " | ".join(rs) == sig][:5]
            print(f"    example chain_ids for `{sig[:60]}...`: {sample}")

    # Cross-check: reference chain
    print()
    print("Reference-chain check:")
    if ref_id is not None:
        ref_path = os.path.join(BASE, f"chain_{ref_id}.json")
        if os.path.isfile(ref_path):
            with open(ref_path) as f:
                ref_payload = json.load(f)
            print(f"  ref chain {ref_id} m_absolute: {ref_payload.get('m_absolute')}")
            print(f"  ref chain {ref_id} m_relative: {ref_payload.get('m_relative')}")
            print(f"  ref chain {ref_id} is_reference_mode: {ref_payload.get('is_reference_mode')}")
            print(f"  ref chain {ref_id} fit_quality_overall: {ref_payload.get('fit_quality_overall')}")
            print(f"  ref chain {ref_id} fit_method: {ref_payload.get('fit_method')}")
            print(f"  ref chain {ref_id} frequency_hz: {ref_payload.get('frequency_hz')}")
            print(f"  ref chain {ref_id} coverage: {ref_payload.get('coverage')}")
        else:
            print(f"  REF CHAIN FILE MISSING: {ref_path}")

    # Distribution of fit_quality across VALID chains
    print()
    print("Distribution diagnostics:")
    valid_ids = buckets["VALID"]
    if valid_ids:
        valid_fq = []
        valid_m_rel = []
        valid_m_abs = []
        valid_freqs = []
        for cid in valid_ids:
            with open(os.path.join(BASE, f"chain_{cid}.json")) as f:
                p = json.load(f)
            valid_fq.append(float(p["fit_quality_overall"]))
            valid_m_rel.append(float(p["m_relative"]))
            valid_m_abs.append(float(p["m_absolute"]))
            valid_freqs.append(float(p["frequency_hz"]))
        import statistics
        print(f"  VALID fit_quality_overall: median={statistics.median(valid_fq):.4f}, "
              f"mean={statistics.mean(valid_fq):.4f}, "
              f"min={min(valid_fq):.4f}, max={max(valid_fq):.4f}")
        print(f"  VALID m_relative: median={statistics.median(valid_m_rel):.4g}, "
              f"min={min(valid_m_rel):.4g}, max={max(valid_m_rel):.4g}")
        print(f"  VALID m_absolute: median={statistics.median(valid_m_abs):.4g}, "
              f"min={min(valid_m_abs):.4g}, max={max(valid_m_abs):.4g}")
        print(f"  VALID frequency_hz: min={min(valid_freqs):.2f}, "
              f"max={max(valid_freqs):.2f}")

    # NAN_BY_DESIGN: per-scenario entry counts
    print()
    nan_ids = buckets["NAN_BY_DESIGN"]
    if nan_ids:
        nan_per_sc_counts = []
        nan_freqs = []
        nan_methods: Counter = Counter()
        for cid in nan_ids:
            with open(os.path.join(BASE, f"chain_{cid}.json")) as f:
                p = json.load(f)
            ps = p.get("per_scenario_residues", {}) or {}
            n_entries = sum(len(v) for v in ps.values())
            nan_per_sc_counts.append(n_entries)
            nan_freqs.append(float(p.get("frequency_hz", 0.0)))
            nan_methods[p.get("fit_method", "?")] += 1
        import statistics
        n_zero_entries = sum(1 for n in nan_per_sc_counts if n == 0)
        print(f"  NAN_BY_DESIGN chains with ZERO per-scenario entries "
              f"(detected in no FRF-loaded scenario): {n_zero_entries}")
        print(f"  NAN_BY_DESIGN chains with >0 per-scenario entries but "
              f"every residue = 0+0j (kernel refused all): "
              f"{len(nan_per_sc_counts) - n_zero_entries}")
        nonzero = [n for n in nan_per_sc_counts if n > 0]
        if nonzero:
            print(f"  Of those, per-scenario entries per chain: "
                  f"median={statistics.median(nonzero)}, "
                  f"min={min(nonzero)}, max={max(nonzero)}")
        print(f"  NAN_BY_DESIGN frequency_hz: min={min(nan_freqs):.2f}, "
              f"max={max(nan_freqs):.2f}, "
              f"median={statistics.median(nan_freqs):.2f}")
        print(f"  NAN_BY_DESIGN fit_method breakdown: {dict(nan_methods)}")

    # Dump INVALID details to JSON
    out_invalid = os.path.join(
        os.path.dirname(__file__),
        "ana-mmnan-7c3a-invalid-chains.json")
    with open(out_invalid, "w") as f:
        json.dump({
            "invalid_chain_count": len(invalid_reasons),
            "invalid_chains": {
                str(cid): rs for cid, rs in invalid_reasons.items()
            },
            "summary_vs_payload_mismatches": {
                str(cid): ms for cid, ms in summary_vs_payload_mismatches.items()
            },
        }, f, indent=2)
    print()
    print(f"Wrote INVALID details to: {out_invalid}")


if __name__ == "__main__":
    main()
