# ============================================================================
# Sound Test diagnostic chart (dev-stest-4a7c, 2026-05-31)
#
# A multi-source overlay chart that reads ALL 4 selectable audio sources via
# PianoidResult accessors only:
#   - kernel  : pre-FIR, pre-volume float       -> result.get_synth_audio()
#   - fir     : post-FIR, post-volume float     -> result.get_post_fir_audio()
#   - sint    : post-volume Sint32 driver input -> result.get_sint_audio()
#   - mic     : recorded mic capture (audio_on) -> result.get_mic_audio()
#
# ARCHITECTURAL CONTRACT (Phase A3, msg 3055): this function MUST NOT call
# any of the raw C++ getters (pianoid.pianoid.getRawSoundRecord,
# getRawFilteredFloatRecord, getRawSoundRecordInt, getRecordedAudio). Those
# are transport primitives, called only by PianoidResult's loader methods
# (result.get_sound_from_pianoid / load_offline_sound_from_pianoid /
# load_post_fir_audio_from_pianoid / load_sint_audio_from_pianoid). The
# unit test `tests/unit/test_sound_test_chart.py` asserts this structurally
# via `.assert_not_called()` on each raw getter mock.
# ============================================================================

_SOUND_TEST_VALID_KINDS = ("note", "chord", "sequence")
_SOUND_TEST_VALID_SOURCES = ("kernel", "fir", "sint", "mic")
_SOUND_TEST_ALLOWED_PIANOID_CALLS = {
    # The chart fn legitimately drives these orchestration primitives.
    "runOfflinePlayback", "startMicCapture", "stopMicCapture",
    "resetStringsState", "runSynthesisKernel", "clearRecords",
    "endMainLoop", "shouldContinue", "stopApplication",
}


def _sound_test_parse_csv_ints(csv_str, default_single, broadcast_to=None):
    """Parse a CSV string of ints. Empty -> [default_single]. broadcast_to: if
    not None, the list is broadcast to this length (last value extended)."""
    raw = (csv_str or "").strip()
    if not raw:
        result = [int(default_single)]
    else:
        result = []
        for tok in raw.split(","):
            tok = tok.strip()
            if not tok:
                continue
            try:
                result.append(int(float(tok)))
            except ValueError:
                raise ValueError(f"sound_test: invalid integer in CSV: {tok!r}")
        if not result:
            result = [int(default_single)]
    if broadcast_to is not None and len(result) < broadcast_to:
        result = result + [result[-1]] * (broadcast_to - len(result))
    return result


def _sound_test_parse_sources(csv_str):
    """Parse the CSV sources spec; return ordered subset of valid sources."""
    raw = (csv_str or "").strip()
    tokens = [t.strip().lower() for t in raw.split(",") if t.strip()]
    if not tokens:
        tokens = ["kernel"]
    seen = set()
    ordered = []
    for tok in tokens:
        if tok not in _SOUND_TEST_VALID_SOURCES:
            raise ValueError(
                f"sound_test: unknown source {tok!r}; valid: {_SOUND_TEST_VALID_SOURCES}"
            )
        if tok not in seen:
            ordered.append(tok)
            seen.add(tok)
    return ordered


def _sound_test_resolve_channels(csv_or_all, num_channels):
    raw = (csv_or_all or "all").strip().lower()
    if raw == "all" or raw == "":
        return list(range(num_channels))
    chans = []
    for tok in raw.split(","):
        tok = tok.strip()
        if not tok:
            continue
        try:
            ch = int(tok)
        except ValueError:
            raise ValueError(f"sound_test: invalid channel index: {tok!r}")
        if 0 <= ch < num_channels:
            chans.append(ch)
        # silently drop out-of-range channels per the proposal contract
    if not chans:
        chans = [0]
    return chans


def _sound_test_build_event_queue(play_kind, pitches, velocities,
                                  durations_ms, sample_rate, samples_per_cycle):
    """Build a pianoidCuda.EventQueue per the play spec. Returns
    (queue, total_duration_ms)."""
    import pianoidCuda

    queue = pianoidCuda.EventQueue()

    # Pad velocities + durations to len(pitches).
    n = len(pitches)
    if len(velocities) < n:
        velocities = velocities + [velocities[-1]] * (n - len(velocities))
    if len(durations_ms) < n:
        durations_ms = durations_ms + [durations_ms[-1]] * (n - len(durations_ms))

    cycles_per_ms = sample_rate / samples_per_cycle / 1000.0

    if play_kind == "note":
        # First pitch only.
        pitch, vel, dur = pitches[0], velocities[0], durations_ms[0]
        on = pianoidCuda.PlaybackEvent()
        on.channel = 0
        on.cycle_index = 0
        on.type = pianoidCuda.EventType.NOTE_ON
        on.data = (pitch << 8) | vel
        queue.addEvent(on)
        off = pianoidCuda.PlaybackEvent()
        off.channel = 0
        off.cycle_index = int(dur * cycles_per_ms)
        off.type = pianoidCuda.EventType.NOTE_OFF
        off.data = (pitch << 8) | 0
        queue.addEvent(off)
        total_play_ms = dur

    elif play_kind == "chord":
        # All NOTE_ONs at cycle 0; per-pitch NOTE_OFF at its own duration.
        max_dur = max(durations_ms[:n])
        for pitch, vel, dur in zip(pitches, velocities, durations_ms):
            on = pianoidCuda.PlaybackEvent()
            on.channel = 0
            on.cycle_index = 0
            on.type = pianoidCuda.EventType.NOTE_ON
            on.data = (pitch << 8) | vel
            queue.addEvent(on)
            off = pianoidCuda.PlaybackEvent()
            off.channel = 0
            off.cycle_index = int(dur * cycles_per_ms)
            off.type = pianoidCuda.EventType.NOTE_OFF
            off.data = (pitch << 8) | 0
            queue.addEvent(off)
        total_play_ms = max_dur

    elif play_kind == "sequence":
        # Back-to-back: next NOTE_ON at previous NOTE_OFF cycle.
        accum_ms = 0.0
        for pitch, vel, dur in zip(pitches, velocities, durations_ms):
            on_cycle = int(accum_ms * cycles_per_ms)
            on = pianoidCuda.PlaybackEvent()
            on.channel = 0
            on.cycle_index = on_cycle
            on.type = pianoidCuda.EventType.NOTE_ON
            on.data = (pitch << 8) | vel
            queue.addEvent(on)
            off = pianoidCuda.PlaybackEvent()
            off.channel = 0
            off.cycle_index = on_cycle + int(dur * cycles_per_ms)
            off.type = pianoidCuda.EventType.NOTE_OFF
            off.data = (pitch << 8) | 0
            queue.addEvent(off)
            accum_ms += dur
        total_play_ms = accum_ms
    else:
        raise ValueError(f"sound_test: unknown play_kind {play_kind!r}")

    queue.sortByCycle()
    return queue, total_play_ms


def _sound_test_y_axis_label(src):
    return {
        "kernel": "amplitude (pre-FIR, pre-volume float)",
        "fir":    "amplitude (post-FIR float)",
        "sint":   "amplitude (post-volume Sint32, normalised)",
        "mic":    "amplitude (mic float -1..1)",
    }.get(src, "amplitude")


def sound_test_function(pianoid, **kwargs):
    """Sound Test diagnostic chart — see module-level header for the architectural
    contract. ALL chart sources are read via PianoidResult accessors; raw C++
    getters are NEVER called from this function."""
    import pianoidCuda
    import time as _time

    charts = ChartArray()
    text_fields = {}

    play_kind = (kwargs.get("play_kind", "note") or "note").strip().lower()
    if play_kind not in _SOUND_TEST_VALID_KINDS:
        text_fields["Error"] = (
            f"Unknown play_kind {play_kind!r}; valid: {list(_SOUND_TEST_VALID_KINDS)}"
        )
        return charts, "Sound Test (Error)", text_fields

    try:
        pitches = _sound_test_parse_csv_ints(kwargs.get("pitches", "60"), 60)
        velocities = _sound_test_parse_csv_ints(
            kwargs.get("velocities", "100"), 100, broadcast_to=len(pitches)
        )
        durations_ms = _sound_test_parse_csv_ints(
            kwargs.get("note_durations_ms", "500"), 500, broadcast_to=len(pitches)
        )
        sources = _sound_test_parse_sources(kwargs.get("sources", "kernel,sint"))
    except ValueError as e:
        text_fields["Error"] = str(e)
        return charts, "Sound Test (Error)", text_fields

    tail_ms = max(0, int(kwargs.get("tail_ms", 2000) or 0))
    display_length_ms = max(0, int(kwargs.get("display_length_ms", 0) or 0))
    ifr = kwargs.get("include_full_result", False)
    if isinstance(ifr, str):
        include_full_result = ifr.strip().lower() in ("1", "true", "yes", "on")
    else:
        include_full_result = bool(ifr)

    sample_rate = pianoid.mp.sample_rate()
    samples_per_cycle = pianoid.mp.mode_iteration
    num_channels = pianoid.mp.num_channels
    try:
        channels = _sound_test_resolve_channels(kwargs.get("channels", "all"), num_channels)
    except ValueError as e:
        text_fields["Error"] = str(e)
        return charts, "Sound Test (Error)", text_fields

    available_pitches = pianoid.get_all_pitches_in_preset(convert_to_notes=False)
    missing = [p for p in pitches if p not in available_pitches]
    if missing:
        text_fields["Error"] = (
            f"Pitches not in preset: {missing}; first 10 available: {available_pitches[:10]}"
        )
        return charts, "Sound Test (Error)", text_fields

    # Build event queue + figure render extent.
    queue, total_play_ms = _sound_test_build_event_queue(
        play_kind, pitches, velocities, durations_ms, sample_rate, samples_per_cycle
    )
    total_capture_ms = total_play_ms + tail_ms

    # Branch: mic source requires Online + active driver. The other sources
    # (kernel/fir/sint) prefer Offline (deterministic). If mic is selected we
    # ALWAYS go Online with mic capture, and other sources read from the Online
    # rawSoundBuffer/rawSoundIntBuffer/rawFilteredFloatBuffer rings.
    want_mic = "mic" in sources

    # Engine-state assertions before render
    audio_driver_active = getattr(pianoid, "audioOn", False)
    if want_mic and not audio_driver_active:
        text_fields["Error"] = (
            "Mic source selected but audio_driver_type=0 (audio_off); mic capture requires Online regime."
        )
        return charts, "Sound Test (Error)", text_fields

    fir_on = False
    if hasattr(pianoid.pianoid, "getFIRfilterStatus"):
        try:
            fir_on = bool(pianoid.pianoid.getFIRfilterStatus())
        except Exception:
            fir_on = False
    if not fir_on and hasattr(pianoid, "FIRfilterON"):
        fir_on = bool(pianoid.FIRfilterON)

    if want_mic:
        # ----- Online + mic capture branch -----
        # Ensure the realtime engine is up.
        was_running = (hasattr(pianoid, 'online_engine')
                       and pianoid.online_engine.isRunning())
        if not was_running:
            try:
                pianoid.start_pianoid()
            except Exception as e:
                text_fields["Error"] = f"Failed to start online engine for mic capture: {e}"
                return charts, "Sound Test (Error)", text_fields

        max_dur_ms = int(total_capture_ms + 500)
        with pianoid.cuda_lock:
            pianoid.pianoid.clearRecords()
            pianoid.pianoid.startMicCapture(max_dur_ms)

        # Translate the event queue into schedule_event calls.
        if play_kind == "note":
            p, v, d = pitches[0], velocities[0], durations_ms[0]
            pianoid.schedule_event(144, p, v, delay_ms=0.0, apply_fix_velocity=False)
            pianoid.schedule_event(128, p, 0, delay_ms=float(d), apply_fix_velocity=False)
        elif play_kind == "chord":
            for p, v, d in zip(pitches, velocities, durations_ms):
                pianoid.schedule_event(144, p, v, delay_ms=0.0, apply_fix_velocity=False)
                pianoid.schedule_event(128, p, 0, delay_ms=float(d), apply_fix_velocity=False)
        elif play_kind == "sequence":
            accum = 0.0
            for p, v, d in zip(pitches, velocities, durations_ms):
                pianoid.schedule_event(144, p, v, delay_ms=accum, apply_fix_velocity=False)
                pianoid.schedule_event(128, p, 0, delay_ms=accum + float(d), apply_fix_velocity=False)
                accum += float(d)

        # Block for the full capture.
        _time.sleep(total_capture_ms / 1000.0)

        with pianoid.cuda_lock:
            mic_samples = pianoid.pianoid.stopMicCapture()
            # Populate every requested source through PianoidResult.
            if "kernel" in sources:
                pianoid.result.get_sound_from_pianoid()
            if "fir" in sources:
                pianoid.result.load_post_fir_audio_from_pianoid()
            if "sint" in sources:
                pianoid.result.load_sint_audio_from_pianoid()
            if "mic" in sources:
                mic_arr = np.asarray(mic_samples, dtype=np.float32) if mic_samples is not None else None
                pianoid.result.set_mic_audio(mic_arr)
    else:
        # ----- Offline branch (deterministic, no driver) -----
        engine_was_running = _stop_online_engine(pianoid)
        config = pianoidCuda.PlaybackConfig()
        config.audio_enabled = False
        config.record_to_buffer = True
        config.max_duration_ms = int(total_capture_ms + 500)
        config.sample_rate = sample_rate
        config.samples_per_cycle = samples_per_cycle

        with pianoid.cuda_lock:
            pianoid.pianoid.resetStringsState()
            pianoid.pianoid.runSynthesisKernel()
            pianoid.pianoid.clearRecords()
            pianoid.pianoid.runOfflinePlayback(queue, config)
            # Populate kernel/fir/sint via PianoidResult loaders.
            # NB: offline path doesn't populate Online rings, so fir + sint
            # will return empty arrays. The chart fn surfaces this in
            # text_fields rather than raising.
            if "kernel" in sources:
                pianoid.result.load_offline_sound_from_pianoid()
            if "fir" in sources:
                pianoid.result.load_post_fir_audio_from_pianoid()
            if "sint" in sources:
                pianoid.result.load_sint_audio_from_pianoid()

        # NB: We do NOT auto-restart the online engine — the caller controls that.
        if engine_was_running:
            _restart_online_engine(pianoid, engine_was_running)

    # ----- Slice + build chart entries -----
    if display_length_ms > 0:
        display_samples = int(display_length_ms * sample_rate / 1000)
    else:
        display_samples = None  # full

    render_hints = []
    chart_headers = []
    unavailable = []

    for src in sources:
        if src == "mic":
            mic = pianoid.result.get_mic_audio()
            if mic is None or (hasattr(mic, "size") and mic.size == 0):
                unavailable.append("mic")
                continue
            data = np.asarray(mic, dtype=np.float64)
            if display_samples is not None:
                data = data[:display_samples]
            header = "Mic"
            charts.append_chart(header, data.tolist())
            chart_headers.append(header)
            render_hints.append({
                "x_axis_name": "time (ms)",
                "y_axis_name": _sound_test_y_axis_label(src),
            })
            continue

        # The other 3 sources are per-channel.
        for ch in channels:
            if src == "kernel":
                data = pianoid.result.get_synth_audio(channel=ch, result_type="ndarray")
            elif src == "fir":
                # FIR is hardwired stereo (channels 0/1). Channels above 1 are
                # silently absent — we report at most channels 0 and 1.
                if ch >= 2:
                    continue
                data = pianoid.result.get_post_fir_audio(channel=ch, result_type="ndarray")
            elif src == "sint":
                # Cast Sint32 to float for plotting on a common axis. The
                # accessor preserves raw int32 by default; we use as_float=True
                # to normalise to [-1, +1] so the chart can overlay with kernel/fir.
                data = pianoid.result.get_sint_audio(
                    channel=ch, result_type="ndarray", as_float=True
                )
            else:
                continue

            data = np.asarray(data, dtype=np.float64)
            if data.size == 0:
                unavailable.append(f"{src} ch{ch}")
                continue
            if display_samples is not None:
                data = data[:display_samples]
            header = f"{src.capitalize()} ch{ch}"
            charts.append_chart(header, data.tolist())
            chart_headers.append(header)
            render_hints.append({
                "x_axis_name": "time (ms)",
                "y_axis_name": _sound_test_y_axis_label(src),
            })

    text_fields.update({
        "Play kind":     play_kind,
        "Pitches":       ", ".join(map(str, pitches)),
        "Velocities":    ", ".join(map(str, velocities[:len(pitches)])),
        "Durations ms":  ", ".join(map(str, durations_ms[:len(pitches)])),
        "Tail ms":       str(tail_ms),
        "Sources":       ", ".join(sources),
        "Channels":      ", ".join(map(str, channels)),
        "Sample rate":   f"{sample_rate} Hz",
        "Mode":          "Online (mic)" if want_mic else "Offline",
        "FIR state":     "ON" if fir_on else "OFF",
    })
    if unavailable:
        text_fields["Unavailable sources"] = ", ".join(unavailable)

    top_header = (
        f"Sound Test - {play_kind} ({len(pitches)} pitch"
        + ("es" if len(pitches) != 1 else "") + ")"
    )

    extra = {"render_hints": render_hints} if render_hints else {}
    if include_full_result:
        extra["pianoid_result"] = {
            "sound_shape":          list(pianoid.result.sound.shape) if isinstance(pianoid.result.sound, np.ndarray) else None,
            "post_fir_sound_shape": list(pianoid.result.post_fir_sound.shape),
            "sint_sound_shape":     list(pianoid.result.sint_sound.shape),
            "mic_audio_size":       int(pianoid.result.mic_audio.size) if (
                pianoid.result.mic_audio is not None and hasattr(pianoid.result.mic_audio, "size")
            ) else 0,
        }

    if extra:
        return charts, top_header, text_fields, extra
    return charts, top_header, text_fields
