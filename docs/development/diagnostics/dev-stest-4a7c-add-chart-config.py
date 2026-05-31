"""Inject the sound_test chart entry into chart_config.json.

One-shot helper for dev-stest-4a7c Phase B M4. Run once from the agent;
the new entry is then carried by the file. Idempotent — re-runs simply
overwrite the existing entry without duplicating it.
"""
import json
import os

CONFIG = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..", "..", "..",
    "PianoidCore", "pianoid_middleware", "chart_config.json",
)

with open(CONFIG, "r", encoding="utf-8") as f:
    cfg = json.load(f)

SOUND_TEST = {
    "name": "sound_test",
    "label": "Sound Test (multi-source)",
    "function": "sound_test_function",
    "item_type": "chart",
    "parameters": [
        # Mode gate (dev-stest-4a7c M9, 2026-05-31): offline keeps the
        # deterministic runOfflinePlayback path (kernel only); online engages
        # the live audio driver so the fir/sint host rings get fed and mic
        # capture can run alongside.
        {
            "name": "mode",
            "type": "choice",
            "defaultValue": "offline",
            "label": "Mode",
            "description": "offline: deterministic runOfflinePlayback (only kernel populates; fir/sint/mic show Unavailable). online: live audio-driver path (kernel/fir/sint populate live rings; mic captures when its checkbox is on).",
            "choices": ["offline", "online"],
        },
        {
            "name": "play_kind",
            "type": "choice",
            "defaultValue": "note",
            "label": "Play Kind",
            "description": "How to interpret pitches/velocities/note_durations_ms: note=single MIDI pitch, chord=N simultaneous pitches, sequence=N back-to-back notes.",
            "choices": ["note", "chord", "sequence"],
        },
        {
            "name": "pitches",
            "type": "string",
            "defaultValue": "60",
            "label": "Pitches (CSV)",
            "description": "Comma-separated MIDI pitches. note=first only; chord=all simultaneous; sequence=in order.",
            "choices": None,
        },
        {
            "name": "velocities",
            "type": "string",
            "defaultValue": "100",
            "label": "Velocities (CSV)",
            "description": "Comma-separated MIDI velocities. If shorter than pitches, last value is broadcast.",
            "choices": None,
        },
        {
            "name": "note_durations_ms",
            "type": "string",
            "defaultValue": "500",
            "label": "Note Durations (CSV, ms)",
            "description": "Per-note hold time (NOTE_ON->NOTE_OFF). Broadcast like velocities. For sequence, the next NOTE_ON follows immediately after the previous NOTE_OFF (no gap).",
            "choices": None,
        },
        {
            "name": "tail_ms",
            "type": "number",
            "defaultValue": 2000,
            "label": "Tail (ms)",
            "description": "Capture tail after the last NOTE_OFF, to record decay.",
            "choices": None,
        },
        {
            "name": "display_length_ms",
            "type": "number",
            "defaultValue": 0,
            "label": "Display Length (ms)",
            "description": "0 -> display full capture (notes + tail). >0 -> display window of this many ms from the first NOTE_ON.",
            "choices": None,
        },
        {
            "name": "channels",
            "type": "string",
            "defaultValue": "all",
            "label": "Channels (CSV or all)",
            "description": "'all' OR comma-separated 0-based channel indices. Channels not present in the active preset are silently dropped.",
            "choices": None,
        },
        # Per-source toggles (dev-stest-4a7c M9, 2026-05-31): the original
        # `sources` CSV string was replaced with 4 booleans so the
        # auto-rendered chart UI exposes every selectable source as its own
        # labelled MUI Checkbox (discoverable). Defaults reproduce the old
        # `kernel,sint` default.
        {
            "name": "include_kernel",
            "type": "boolean",
            "defaultValue": True,
            "label": "Source: Kernel (pre-FIR float)",
            "description": "dev_soundFloat — the raw kernel output before any FIR/volume processing. Available in BOTH offline and online modes.",
            "choices": None,
        },
        {
            "name": "include_fir",
            "type": "boolean",
            "defaultValue": False,
            "label": "Source: FIR (post-filter float)",
            "description": "dev_filteredSoundFloat — the FIR convolution output. Online-mode only, requires FIRfilterON==true (otherwise reports Unavailable).",
            "choices": None,
        },
        {
            "name": "include_sint",
            "type": "boolean",
            "defaultValue": True,
            "label": "Source: Sint (driver input, Sint32)",
            "description": "dev_soundInt — the post-volume Sint32 buffer the audio driver consumes. Online-mode only (offline never reaches the Online ring).",
            "choices": None,
        },
        {
            "name": "include_mic",
            "type": "boolean",
            "defaultValue": False,
            "label": "Source: Mic (live capture)",
            "description": "Microphone capture during playback. Online-mode only, requires active audio driver (audio_on=true).",
            "choices": None,
        },
        {
            "name": "include_full_result",
            "type": "boolean",
            "defaultValue": False,
            "label": "Include full PianoidResult",
            "description": "When true, the response gains a `pianoid_result` field with all PianoidResult buffers. Can be MB-scale.",
            "choices": None,
        },
    ],
}

# Idempotent: replace existing entry or append.
existing_idx = next((i for i, e in enumerate(cfg) if e.get("name") == "sound_test"), None)
if existing_idx is not None:
    cfg[existing_idx] = SOUND_TEST
    print(f"[chart_config] Replaced existing sound_test entry at index {existing_idx}")
else:
    cfg.append(SOUND_TEST)
    print(f"[chart_config] Appended sound_test entry; total entries now {len(cfg)}")

with open(CONFIG, "w", encoding="utf-8") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")

print("[chart_config] Wrote", CONFIG)
