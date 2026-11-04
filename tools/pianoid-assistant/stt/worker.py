"""Speech-to-text worker of the assistant service (dev-voice): local faster-whisper on the CPU.

One JSON request per stdin line, one JSON reply per stdout line:
  {"id": 1, "path": "<audio file>", "language": "auto" | "en" | "ru", "model": "medium"}
  -> {"id": 1, "ok": true, "text": "...", "language": "ru",
      "duration_s": 6.1, "elapsed_s": 2.4, "load_s": 0.0, "model": "small"}
  -> {"id": 1, "ok": false, "error": "..."}
  {"id": 2, "warm": true, "model": "small"} -> {"id": 2, "ok": true, "load_s": 2.4, "model": "small"} (load only)
On start it prints {"ready": true, ...}. The model stays loaded between requests (the service ends the
worker when idle). CPU only, int8, a capped thread count and below-normal priority: it must never compete
with the realtime engine (GPU, MMCSS synth thread). "auto" lets Whisper detect the language per segment from
the same encoder pass (multilingual=True; a separate detect_language pass would cost a second encoder run,
measured +3 s on "small"); the reply's language is then read from the text's script (Cyrillic = ru).
A short domain prompt (Pianoid vocabulary) biases the decoder towards the terms users say.
"""
import json
import os
import re
import sys
import time

os.environ["CUDA_VISIBLE_DEVICES"] = ""          # never the GPU, even if CTranslate2 finds one
ALLOWED = ("en", "ru")
PROMPTS = {
    "en": "Pianoid piano tuning: preset, baseline, soundboard, modes, strings, feedback, decrement, volume.",
    "ru": "Pianoid, настройка фортепиано: пресет, дека, моды, струна, затухание, громкость, октава.",
    "auto": "Pianoid: preset, soundboard, modes, feedback, decrement. Пресет, дека, моды, струна, затухание.",
}
CYRILLIC = re.compile(r"[Ѐ-ӿ]")
LATIN = re.compile("[A-Za-z]")


def lower_priority():
    if os.name == "nt":
        import ctypes
        BELOW_NORMAL_PRIORITY_CLASS = 0x4000
        k32 = ctypes.windll.kernel32
        k32.SetPriorityClass(k32.GetCurrentProcess(), BELOW_NORMAL_PRIORITY_CLASS)
    else:
        os.nice(5)


class Transcriber:
    def __init__(self, threads):
        self.threads = threads
        self.name = None
        self.model = None

    def load(self, name):
        if self.name == name:
            return 0.0
        from faster_whisper import WhisperModel
        t0 = time.perf_counter()
        self.model = WhisperModel(name, device="cpu", compute_type="int8", cpu_threads=self.threads)
        self.name = name
        return time.perf_counter() - t0

    def transcribe(self, req):
        from faster_whisper import decode_audio
        load_s = self.load(req.get("model") or "medium")
        t0 = time.perf_counter()
        audio = decode_audio(req["path"], sampling_rate=16000)
        peak = float(abs(audio).max()) if len(audio) else 0.0
        if 0 < peak < 0.5:                       # a quiet clip (the rig mic: room level, no AGC): to -6 dBFS, <= +40 dB
            audio = audio * min(0.5 / peak, 100.0)
        language = req.get("language") or "auto"
        if language != "auto" and language not in ALLOWED:
            raise ValueError(f"language must be auto, {' or '.join(ALLOWED)}")
        segments, _ = self.model.transcribe(
            audio, language="en" if language == "auto" else language, multilingual=language == "auto",
            beam_size=5, vad_filter=True, condition_on_previous_text=False, initial_prompt=PROMPTS[language])
        text = " ".join(s.text.strip() for s in segments).strip()
        if language == "auto":
            language = "ru" if len(CYRILLIC.findall(text)) > len(LATIN.findall(text)) else "en"
        return {
            "text": text, "language": language,
            "duration_s": round(len(audio) / 16000, 2), "elapsed_s": round(time.perf_counter() - t0, 2),
            "load_s": round(load_s, 2), "model": self.name,
        }


def reply(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    lower_priority()
    threads = int(os.environ.get("PIANOID_STT_THREADS") or max(1, min(4, (os.cpu_count() or 2) // 2)))
    worker = Transcriber(threads)
    try:
        import faster_whisper
        reply({"ready": True, "threads": threads, "faster_whisper": faster_whisper.__version__})
    except ImportError as e:
        reply({"ready": False, "error": f"faster-whisper is not installed in this Python: {e}"})
        return
    for line in sys.stdin:
        if not line.strip():
            continue
        req = {}
        try:
            req = json.loads(line)
            if req.get("warm"):
                load_s = worker.load(req.get("model") or "medium")
                reply({"id": req.get("id"), "ok": True, "load_s": round(load_s, 2), "model": worker.name})
                continue
            reply({"id": req.get("id"), "ok": True, **worker.transcribe(req)})
        except Exception as e:                    # one bad request never ends the worker
            reply({"id": req.get("id"), "ok": False, "error": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
    main()
