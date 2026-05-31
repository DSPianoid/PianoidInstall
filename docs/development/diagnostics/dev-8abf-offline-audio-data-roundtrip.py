"""
dev-8abf — Isolated verification of the OFFLINE /play_keyboard `audio_data`
base64-WAV transform, WITHOUT spinning up the GPU engine or touching the
user's running backend (port 5000 is the user's stack — must not be disturbed;
its process predates this change anyway).

This replicates EXACTLY what the offline branch of backendServer.py does:
  1. write a peak-normalized 16-bit PCM WAV via `wave` (the unchanged code,
     lines ~2091-2095),
  2. then my NEW lines: read the file bytes back and
     `base64.b64encode(...).decode('utf-8')`, list-wrapped as `audio_data`.

It then verifies the result is a valid, frontend-decodable WAV by:
  - decoding base64 back to bytes (what the browser `atob` does) and asserting
    byte-identity with the file,
  - parsing the decoded bytes as a WAV (valid RIFF header) and confirming
    channels / sampwidth / framerate / frame count round-trip,
  - confirming the decoded samples equal the written int16 samples.

A PASS proves `audio_data[0]` is a well-formed, playable base64 WAV that the
frontend's atob -> Uint8Array -> Blob({type:'audio/wav'}) path will reconstruct
exactly.
"""
import base64
import io
import os
import tempfile
import wave

import numpy as np


def build_offline_wav_bytes_and_audio_data(audio_arr, sample_rate):
    """Mirror of backendServer.py offline branch WAV write + my new b64 step."""
    peak = float(np.max(np.abs(audio_arr)))
    scale = (32767.0 / peak) if peak > 1e-9 else 1.0
    int16 = np.clip(audio_arr * scale, -32768, 32767).astype(np.int16)

    tmpdir = tempfile.mkdtemp(prefix="dev-8abf-")
    wav_path = os.path.join(tmpdir, "keyboard_offline_test.wav")
    with wave.open(wav_path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(int16.tobytes())

    # ---- the NEW lines under test ----
    with open(wav_path, "rb") as fh:
        wav_b64 = base64.b64encode(fh.read()).decode("utf-8")
    audio_data = [wav_b64]
    # ----------------------------------
    return wav_path, int16, audio_data, scale


def main():
    sample_rate = 48000
    # Two synthetic "pitches" worth of a decaying tone (no engine needed) —
    # stands in for the small 2-3 pitch offline render the task suggests.
    t = np.linspace(0, 0.4, int(sample_rate * 0.4), endpoint=False)
    tone = (np.sin(2 * np.pi * 220.0 * t) * np.exp(-3 * t)
            + 0.5 * np.sin(2 * np.pi * 440.0 * t) * np.exp(-4 * t))
    audio_arr = np.asarray(tone, dtype=np.float64)

    wav_path, int16, audio_data, scale = build_offline_wav_bytes_and_audio_data(
        audio_arr, sample_rate)

    results = []

    def check(name, cond):
        results.append((name, bool(cond)))
        print(f"  [{'PASS' if cond else 'FAIL'}] {name}")

    print("dev-8abf offline audio_data round-trip verification")
    print(f"  wav_path = {wav_path}")
    print(f"  peak_normalized_scale = {scale:.4f}")

    # --- audio_data shape ---
    check("audio_data is a list", isinstance(audio_data, list))
    check("audio_data has exactly one entry", len(audio_data) == 1)
    b64 = audio_data[0]
    check("audio_data[0] is a str", isinstance(b64, str))
    check("audio_data[0] non-empty", len(b64) > 0)

    # --- base64 decodes (what the browser atob does), byte-identical to file ---
    file_bytes = open(wav_path, "rb").read()
    decoded = base64.b64decode(b64)
    check("base64 decodes back to the exact file bytes", decoded == file_bytes)

    # --- decoded bytes are a valid WAV (RIFF header) ---
    check("decoded starts with RIFF", decoded[:4] == b"RIFF")
    check("decoded contains WAVE tag", decoded[8:12] == b"WAVE")

    # --- parse decoded bytes as a WAV and round-trip the audio ---
    with wave.open(io.BytesIO(decoded), "rb") as wf:
        nchan = wf.getnchannels()
        sampw = wf.getsampwidth()
        fr = wf.getframerate()
        nframes = wf.getnframes()
        frames = wf.readframes(nframes)
    check("decoded WAV nchannels == 1", nchan == 1)
    check("decoded WAV sampwidth == 2 (16-bit)", sampw == 2)
    check("decoded WAV framerate == sample_rate", fr == sample_rate)
    check("decoded WAV frame count == input samples", nframes == int16.size)
    recovered = np.frombuffer(frames, dtype=np.int16)
    check("decoded WAV samples are byte-identical to the written int16",
          np.array_equal(recovered, int16))

    # cleanup
    try:
        os.remove(wav_path)
        os.rmdir(os.path.dirname(wav_path))
    except OSError:
        pass

    n_pass = sum(1 for _, ok in results if ok)
    n_total = len(results)
    print(f"\n  {n_pass}/{n_total} checks passed")
    if n_pass != n_total:
        raise SystemExit(1)
    print("  RESULT: audio_data[0] is a well-formed, frontend-decodable, playable base64 WAV.")


if __name__ == "__main__":
    main()
