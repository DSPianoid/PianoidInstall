"""
dev-3a08 UI Reproduction Decoder
Decode captured base64 WAVs, save to disk, compute metrics, diff against baseline.
"""
import base64
import io
import json
import wave
import numpy as np
import csv
from pathlib import Path

CAP_JSON = Path(r"D:\tmp\currentdev-2026-05-28-captures-restpath.json")
OUT_DIR = Path(r"D:\tmp")
BASELINE_DIR = Path(r"D:\tmp")

def decode_b64_wav(b64: str):
    """Decode base64 WAV. Return (rate, samples_int16, channels)."""
    raw = base64.b64decode(b64)
    wf = wave.open(io.BytesIO(raw), "rb")
    rate = wf.getframerate()
    channels = wf.getnchannels()
    sampwidth = wf.getsampwidth()
    nframes = wf.getnframes()
    data = wf.readframes(nframes)
    wf.close()
    if sampwidth == 2:
        arr = np.frombuffer(data, dtype=np.int16).astype(np.float64)
    elif sampwidth == 4:
        arr = np.frombuffer(data, dtype=np.int32).astype(np.float64) / (1 << 16)
    else:
        arr = np.frombuffer(data, dtype=np.uint8).astype(np.float64) - 128
    if channels > 1:
        arr = arr.reshape(-1, channels)[:, 0]
    return rate, arr, channels

def save_wav(path: Path, samples: np.ndarray, rate: int):
    samples16 = np.clip(samples, -32768, 32767).astype(np.int16)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(samples16.tobytes())

def find_attack_window(samples: np.ndarray, rate: int, threshold_factor: float = 0.05):
    """Find first sample above threshold * max. Returns sample index."""
    peak = float(np.max(np.abs(samples)))
    if peak < 1e-6:
        return 0
    thresh = peak * threshold_factor
    above = np.where(np.abs(samples) >= thresh)[0]
    if len(above) == 0:
        return 0
    return int(above[0])

def compute_per_note_metrics(samples: np.ndarray, rate: int,
                              note_dur_ms: int = 600, tail_dur_ms: int = 600,
                              attack_dur_ms: int = 100):
    """
    Locate the note in the buffer, compute attack_pk, attack_rms, sustain_rms, post_rms.
    Strategy: find attack start (first sample > 5% of peak), then assume note spans
    note_dur_ms from there, post-noteoff is the next tail_dur_ms.
    """
    n_attack = int(rate * attack_dur_ms / 1000)
    n_note = int(rate * note_dur_ms / 1000)
    n_tail = int(rate * tail_dur_ms / 1000)
    start = find_attack_window(samples, rate)
    end_note = min(start + n_note, len(samples))
    end_tail = min(end_note + n_tail, len(samples))

    attack = samples[start: start + n_attack]
    sustain = samples[start + n_attack: end_note]
    post = samples[end_note: end_tail]

    attack_pk = float(np.max(np.abs(attack))) if len(attack) else 0.0
    attack_rms = float(np.sqrt(np.mean(attack ** 2))) if len(attack) else 0.0
    sustain_rms = float(np.sqrt(np.mean(sustain ** 2))) if len(sustain) else 0.0
    post_rms = float(np.sqrt(np.mean(post ** 2))) if len(post) else 0.0
    peak_amp = float(np.max(np.abs(samples)))
    return {
        "start_idx": int(start),
        "attack_pk": attack_pk,
        "attack_rms": attack_rms,
        "sustain_rms": sustain_rms,
        "post_noteoff_rms": post_rms,
        "peak_amplitude": peak_amp,
        "total_samples": len(samples),
    }

def diff_to_baseline(curr: np.ndarray, base: np.ndarray, rate: int):
    """Align by attack start, then sample-subtract on overlap."""
    s_c = find_attack_window(curr, rate)
    s_b = find_attack_window(base, rate)
    # align
    a_c = curr[s_c:]
    a_b = base[s_b:]
    n = min(len(a_c), len(a_b))
    if n < 100:
        return {"err": "alignment too short", "n": n}
    a_c = a_c[:n]
    a_b = a_b[:n]
    diff = a_c - a_b
    # find divergence window: cumulative RMS error per 100ms window
    win = int(rate * 0.1)
    n_wins = n // win
    rms_per_win = []
    for i in range(n_wins):
        w = diff[i*win:(i+1)*win]
        rms_per_win.append(float(np.sqrt(np.mean(w**2))))
    return {
        "align_curr_start": int(s_c),
        "align_base_start": int(s_b),
        "overlap_samples": int(n),
        "diff_rms": float(np.sqrt(np.mean(diff**2))),
        "diff_peak": float(np.max(np.abs(diff))),
        "curr_rms": float(np.sqrt(np.mean(a_c**2))),
        "base_rms": float(np.sqrt(np.mean(a_b**2))),
        "rms_per_100ms_window": rms_per_win,
    }


def main():
    with open(CAP_JSON, "r") as f:
        cap = json.load(f)

    print(f"Loaded capture json: {CAP_JSON}")
    print(f"Mode: {cap.get('mode')}, ts: {cap.get('timestamp')}")
    captures = cap.get("captures", {})
    print(f"Captures: {list(captures.keys())}")

    rows = []
    diffs = []
    for key, entry in captures.items():
        b64 = entry["audio_b64"]
        rate, samples, channels = decode_b64_wav(b64)
        print(f"  {key}: rate={rate} Hz, samples={len(samples)}, channels={channels}, peak={np.max(np.abs(samples)):.2f}")

        # Save WAV
        out_wav = OUT_DIR / f"currentdev-2026-05-28-{key}.wav"
        save_wav(out_wav, samples, rate)

        if key.startswith("p") and key[1:].isdigit():
            pitch = int(key[1:])
            metrics = compute_per_note_metrics(samples, rate)
            row = {"pitch": pitch, **metrics, "rate": rate}
            rows.append(row)

            # Try baseline diff
            base_path = BASELINE_DIR / f"baseline-2026-05-10-p{pitch}.wav"
            if base_path.exists():
                with wave.open(str(base_path), "rb") as wf:
                    b_rate = wf.getframerate()
                    b_nframes = wf.getnframes()
                    b_data = wf.readframes(b_nframes)
                    b_channels = wf.getnchannels()
                    b_sampwidth = wf.getsampwidth()
                if b_sampwidth == 2:
                    base_samples = np.frombuffer(b_data, dtype=np.int16).astype(np.float64)
                else:
                    base_samples = np.frombuffer(b_data, dtype=np.int32).astype(np.float64)
                if b_channels > 1:
                    base_samples = base_samples.reshape(-1, b_channels)[:, 0]
                d = diff_to_baseline(samples, base_samples, rate)
                diffs.append({"pitch": pitch, **d})
            else:
                print(f"    NO BASELINE: {base_path}")
        elif key == "seq":
            # Sequence: total + per-segment via heuristic
            print(f"  sequence stats: peak={np.max(np.abs(samples)):.2f}, total_rms={np.sqrt(np.mean(samples**2)):.2f}")

    # Save summary CSV
    summary_path = OUT_DIR / "currentdev-2026-05-28-summary.csv"
    with open(summary_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["pitch", "rate", "start_idx", "attack_pk", "attack_rms", "sustain_rms", "post_noteoff_rms", "peak_amplitude", "total_samples"])
        writer.writeheader()
        for row in rows:
            writer.writerow(row)
    print(f"Wrote summary: {summary_path}")

    # Save diff report
    diff_path = OUT_DIR / "currentdev-2026-05-28-diff-vs-baseline.json"
    with open(diff_path, "w") as f:
        json.dump({"diffs": diffs}, f, indent=2)
    print(f"Wrote diff: {diff_path}")

    print("\n=== PER-PITCH COMPARISON: current-dev WAV vs baseline-2026-05-10 WAV ===")
    print("(Note: both at int16 scale. Baseline summary CSV is from soundFloat path — different units. WAV-vs-WAV is the correct comparison.)")
    base_metrics = {}
    for pitch in [55, 56, 57]:
        bp = BASELINE_DIR / f"baseline-2026-05-10-p{pitch}.wav"
        if not bp.exists():
            continue
        with wave.open(str(bp), "rb") as wf:
            b_rate = wf.getframerate()
            b_data = wf.readframes(wf.getnframes())
            b_channels = wf.getnchannels()
        b_arr = np.frombuffer(b_data, dtype=np.int16).astype(np.float64)
        if b_channels > 1:
            b_arr = b_arr.reshape(-1, b_channels)[:, 0]
        m = compute_per_note_metrics(b_arr, b_rate)
        base_metrics[pitch] = m

    for row in rows:
        pitch = row["pitch"]
        b = base_metrics.get(pitch)
        if not b:
            continue
        c_apk = row["attack_pk"]; b_apk = b["attack_pk"]
        c_arms = row["attack_rms"]; b_arms = b["attack_rms"]
        c_srms = row["sustain_rms"]; b_srms = b["sustain_rms"]
        c_prms = row["post_noteoff_rms"]; b_prms = b["post_noteoff_rms"]
        def pct(c, bb):
            if abs(bb) < 1e-6: return float('inf') if abs(c) > 1e-6 else 0.0
            return (c - bb) / bb * 100
        print(f"P{pitch}: attack_pk curr={c_apk:.0f} base={b_apk:.0f} ({pct(c_apk, b_apk):+.0f}%) | attack_rms curr={c_arms:.0f} base={b_arms:.0f} ({pct(c_arms, b_arms):+.0f}%) | sustain_rms curr={c_srms:.0f} base={b_srms:.0f} ({pct(c_srms, b_srms):+.0f}%) | post_rms curr={c_prms:.1f} base={b_prms:.1f} ({pct(c_prms, b_prms):+.0f}%)")

if __name__ == "__main__":
    main()
