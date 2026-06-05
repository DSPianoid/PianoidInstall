"""
dev-steinway-preset: CONFIDENCE-GATED, REVERT-SAFE re-tune of preset B + end-of-run WAV render.

Combines the robust patterns (team-lead course-correction 2026-06-04 after multi-pass-everything
DIVERGED on low-confidence bass/extreme-treble notes):
  - CONSTRAINED detection (search_semitones) — salvages C6.
  - CONFIDENCE GATE: only correct a note when conf >= HIGH_CONF AND |cents| >= TOL AND the implied
    tension change is within the per-pass clamp. A note the detector can't confidently measure
    (bass + extreme treble) is LEFT DERIVED and never iterated.
  - BEST-SO-FAR + REVERT-IF-NOT-IMPROVING: each note remembers its lowest-|cents| tension seen
    (initialised to DERIVED). If a pass makes a note worse, it reverts to its best and FREEZES.
    INVARIANT: no note ever ends WORSE than its derived value.
  - Bounded passes. Final tensions = per-note best-so-far.
Then RENDER the full-keyboard WAV and write a DONE marker. ONE detached job (launch via
PowerShell Start-Process -WindowStyle Hidden -> D:\\tmp\\steinway-tune.log).
"""
import sys, os, json, math, wave
sys.path.insert(0, r"D:\repos\PianoidInstall\PianoidCore\pianoid_middleware")
os.chdir(r"D:\repos\PianoidInstall\PianoidCore\pianoid_middleware")
import numpy as np
import pianoidCuda  # noqa
from pianoid import initialize  # noqa
from auto_tuner import MeasurementEngine, FrequencyTuner, measurement_window  # noqa

PRESET = "Belarus_196modesC_Steinway1860_56SM"
PRESET_A = "Belarus_196modesC_Steinway1860"
PRESETS_DIR = "presets"
PASSES = 5
SEARCH_SEMITONES = 2.0
STEP = 0.20            # per-pass tension clamp
TOL = 5.0             # cents within which a note is "done"
HIGH_CONF = 0.80      # only correct on confident measurements; else keep derived
                      # (calibrated from real-render comb-confidence: genuine reads >=0.8,
                      #  unmeasurable extremes <0.5 — dev-steinway-preset log 2026-06-04)
VEL = 20
WAV_OUT = r"D:\tmp\Belarus_196modesC_Steinway1860_56SM_fullkeyboard.wav"
WAV_NOTE_S = 1.5
ET = pianoidCuda.EventType

def log(m): print(m, flush=True)

def load_preset(name):
    return json.load(open(os.path.join(PRESETS_DIR, name), encoding="utf-8"))

def write_tensions(name, tensions):
    d = load_preset(name)
    for pk, pp in d["pitches"].items():
        mi = int(pk)
        if mi in tensions:
            pp["physics"]["tension"] = round(tensions[mi], 6)
    with open(os.path.join(PRESETS_DIR, name), "w", encoding="utf-8") as f:
        json.dump(d, f, indent=2)

def render_note_signal(p, eng, pid, tgt):
    skip_ms, window_ms = measurement_window(tgt)
    dur = int(skip_ms + window_ms + 100)
    return eng.render_note(p, pid, VEL, dur)

def measure(p, eng, pid, tgt):
    sig = render_note_signal(p, eng, pid, tgt)
    m = eng.measure_frequency(sig, p.mp.sample_rate(), tgt, search_semitones=SEARCH_SEMITONES)
    if m.hz <= 0 or m.confidence <= 0:   # one re-measure
        sig = render_note_signal(p, eng, pid, tgt)
        m = eng.measure_frequency(sig, p.mp.sample_rate(), tgt, search_semitones=SEARCH_SEMITONES)
    return m

def tune():
    targets = FrequencyTuner()._load_default_frequencies()
    eng = MeasurementEngine()
    d0 = load_preset(PRESET)
    piano = sorted(int(k) for k in d0["pitches"] if int(k) < 128)
    derived = {pid: d0["pitches"][str(pid)]["physics"]["tension"] for pid in piano}

    best_T = dict(derived)          # best-so-far tension (init derived)
    best_abs_cents = {pid: None for pid in piano}  # lowest |cents| seen (None = unmeasured)
    frozen = {pid: False for pid in piano}
    cur_T = dict(derived)
    meas_log = {}

    for pass_no in range(1, PASSES + 1):
        write_tensions(PRESET, cur_T)               # render this pass at cur_T
        d = load_preset(PRESET); mp = d["model_parameters"]
        p = initialize(os.path.join(PRESETS_DIR, PRESET), filterlen=48*128*3,
                       string_iteration=mp["string_iteration"], array_size=mp["array_size"],
                       buffer_size=mp.get("buffer_size", 2), sample_rate=mp["sr"],
                       samples_in_cycle=mp["mode_iteration"], max_volume=5e18,
                       audio_on=False, audio_driver_type=0)
        log(f"=== PASS {pass_no}/{PASSES} (gate conf>={HIGH_CONF}, clamp +-{STEP*100:.0f}%, search +-{SEARCH_SEMITONES}st) ===")
        active = 0
        for i, pid in enumerate(piano):
            tgt = targets[pid]
            if frozen[pid]:
                continue
            m = measure(p, eng, pid, tgt)
            ac = abs(m.cents_error) if (m.hz > 0 and m.confidence > 0) else None
            meas_log[pid] = (round(m.hz, 2), round(m.cents_error, 1) if m.hz > 0 else None, round(m.confidence, 2))
            # update best-so-far (only on a valid measurement that improves)
            if ac is not None and (best_abs_cents[pid] is None or ac < best_abs_cents[pid]):
                best_abs_cents[pid] = ac
                best_T[pid] = cur_T[pid]
            # decide
            if ac is None or m.confidence < HIGH_CONF:
                cur_T[pid] = best_T[pid]; frozen[pid] = True   # unmeasurable -> keep best (derived) + freeze
                continue
            if ac < TOL:
                cur_T[pid] = best_T[pid]; frozen[pid] = True   # converged
                continue
            if best_abs_cents[pid] is not None and ac > best_abs_cents[pid] + 1.0:
                cur_T[pid] = best_T[pid]; frozen[pid] = True   # got worse -> revert + freeze (no divergence)
                continue
            factor = (tgt / m.hz) ** 2
            factor = max(1 - STEP, min(1 + STEP, factor))      # confident + improving -> clamped correction
            cur_T[pid] = cur_T[pid] * factor
            active += 1
            if pass_no == PASSES or i % 24 == 0:
                log(f"  pitch {pid}: {m.hz:.1f} ({m.cents_error:+.0f}c conf{m.confidence:.2f}) -> *{factor:.3f}")
        try: p.pianoid.shutdownGpu()
        except Exception: pass
        log(f"  PASS {pass_no}: {active} active, {sum(frozen.values())} frozen.")
        if active == 0:
            log("  CONVERGED — all notes frozen."); break

    # R6: for notes that stayed UNMEASURABLE (never confidently measured → best_abs_cents is None,
    # at derived), interpolate a tension from the LOCAL TUNED TREND — apply the mean correction
    # factor (tuned_T/derived_T) of measured neighbours within ±NEIGH semitones, clamped to ±STEP.
    # Better than raw-derived at the band edges (top octave); bounded so it never goes wild.
    NEIGH = 5
    interpolated = []
    measured_pids = [pid for pid in piano if best_abs_cents[pid] is not None
                     and abs(best_T[pid] - derived[pid]) > 1e-9]
    for pid in piano:
        if best_abs_cents[pid] is None:  # genuinely unmeasurable
            facs = [best_T[q] / derived[q] for q in measured_pids
                    if abs(q - pid) <= NEIGH and derived[q] > 0]
            if facs:
                f = sum(facs) / len(facs)
                f = max(1 - STEP, min(1 + STEP, f))
                best_T[pid] = derived[pid] * f
                interpolated.append((pid, round(f, 3)))
    if interpolated:
        log(f"  R6 interpolated (unmeasurable notes given local-trend tension): {interpolated}")

    # finalize: write the BEST-so-far tension for every note
    write_tensions(PRESET, best_T)
    da = load_preset(PRESET_A)
    for pk, pp in da["pitches"].items():
        mi = int(pk)
        if mi in best_T:
            pp["physics"]["tension"] = round(best_T[mi], 6)
    with open(os.path.join(PRESETS_DIR, PRESET_A), "w", encoding="utf-8") as f:
        json.dump(da, f, indent=2)

    cents = {pid: best_abs_cents[pid] for pid in piano if best_abs_cents[pid] is not None}
    unmeasured = [pid for pid in piano if best_abs_cents[pid] is None]
    am = sum(cents.values()) / len(cents) if cents else 0
    worst = sorted(cents.items(), key=lambda kv: -kv[1])[:8]
    log("=== FINAL (best |cents| per note; tensions = best-so-far) ===")
    log(f"  abs-mean |cents| (measured): {am:.1f}")
    log(f"  worst 8: {worst}")
    log(f"  unmeasurable (kept derived): {unmeasured}")
    json.dump({str(pid): {'best_abs_cents': best_abs_cents[pid], 'tension': best_T[pid],
                          'derived': derived[pid], 'frozen': frozen[pid],
                          'last_meas': meas_log.get(pid)} for pid in piano},
              open(r"D:\tmp\steinway_retune_summary.json", "w"), indent=2)
    log("WROTE D:\\tmp\\steinway_retune_summary.json")
    return piano

def render_wav():
    d = load_preset(PRESET); mp = d["model_parameters"]
    piano = sorted(int(k) for k in d["pitches"] if int(k) < 128)
    p = initialize(os.path.join(PRESETS_DIR, PRESET), filterlen=48*128*3,
                   string_iteration=mp["string_iteration"], array_size=mp["array_size"],
                   buffer_size=mp.get("buffer_size", 2), sample_rate=mp["sr"],
                   samples_in_cycle=mp["mode_iteration"], max_volume=5e18,
                   audio_on=False, audio_driver_type=0)
    sr = p.mp.sample_rate(); spc = p.mp.mode_iteration
    note_s = WAV_NOTE_S
    while note_s * sr * len(piano) * 2 > 45*1024*1024 and note_s > 0.4:
        note_s -= 0.1
    sustain_ms = note_s * 1000 * 0.7
    cpp = p.pianoid; chunks = []; peak = 0.0
    for pid in piano:
        off = max(1, int((sustain_ms/1000.0) * sr / spc))
        eq = pianoidCuda.EventQueue()
        e1 = pianoidCuda.PlaybackEvent(); e1.type = ET.NOTE_ON; e1.channel = 0; e1.cycle_index = 1; e1.data = (pid << 8) | 100; eq.addEvent(e1)
        e2 = pianoidCuda.PlaybackEvent(); e2.type = ET.NOTE_OFF; e2.channel = 0; e2.cycle_index = off; e2.data = (pid << 8); eq.addEvent(e2)
        eq.sortByCycle()
        cpp.resetStringsState(); cpp.runSynthesisKernel(); cpp.clearRecords()
        cfg = pianoidCuda.PlaybackConfig(); cfg.audio_enabled = False; cfg.record_to_buffer = True
        cfg.sample_rate = sr; cfg.samples_per_cycle = spc; cfg.max_duration_ms = int(note_s*1000)
        cpp.runOfflinePlayback(eq, cfg)
        a = np.array(cpp.getRecordedAudio(), dtype=np.float64); chunks.append(a)
        peak = max(peak, float(np.max(np.abs(a))) if len(a) else 0.0)
    full = np.concatenate(chunks) if chunks else np.zeros(1)
    if peak <= 0: peak = 1.0
    scaled = (full / peak * 30000.0).astype(np.int16)
    with wave.open(WAV_OUT, "wb") as wf:
        wf.setnchannels(1); wf.setsampwidth(2); wf.setframerate(sr); wf.writeframes(scaled.tobytes())
    try: cpp.shutdownGpu()
    except Exception: pass
    log(f"WAV: {WAV_OUT} notes={len(piano)} dur={len(full)/sr:.1f}s sr={sr} size={os.path.getsize(WAV_OUT)/1024/1024:.2f}MB note_s={note_s:.2f}")

if __name__ == "__main__":
    tune()
    render_wav()
    log("DONE_ALL")
