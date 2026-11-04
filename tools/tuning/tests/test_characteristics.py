"""dev-tuneskill: the extractor on synthetic notes with known f0, inharmonicity, decay and attack."""
import math
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import characteristics as ch  # noqa: E402

SR = 48000


def synth_note(f0=261.63, B=3e-4, n=12, t60_s=2.0, dur=4.0, attack_ms=5.0, tilt_db_per_oct=-6.0, noise=0.0, seed=0):
    """Inharmonic partials with one exponential decay, a short linear attack and an optional noise floor."""
    t = np.arange(int(dur * SR)) / SR
    x = np.zeros_like(t)
    rate = 60.0 / t60_s                                   # dB/s
    for k in range(1, n + 1):
        fk = k * f0 * math.sqrt(1 + B * k * k)
        amp = 10 ** (tilt_db_per_oct * math.log2(k) / 20)
        x += amp * np.sin(2 * np.pi * fk * t) * 10 ** (-rate * t / 20)
    ramp = np.minimum(1.0, t / (attack_ms / 1000))
    x *= ramp
    if noise:
        x += noise * np.random.default_rng(seed).standard_normal(len(t))
    return 0.5 * x / np.abs(x).max()


def test_pitch_inharmonicity_and_tuning():
    x = synth_note(f0=261.63 * 2 ** (10 / 1200), B=4e-4)
    c = ch.analyse(x, SR, nominal_midi=60)
    assert abs(c["pitch"]["tuning_cents"] - 10) < 1.5
    assert abs(c["pitch"]["f0_hz"] - 261.63 * 2 ** (10 / 1200)) < 0.3
    assert 0.8 < c["pitch"]["inharmonicity_B"] / 4e-4 < 1.2
    assert len(c["partials"]) == 12 and c["partials"][0]["level_db"] == 0.0


def test_pitch_without_nominal_finds_the_fundamental_not_a_partial():
    c = ch.analyse(synth_note(f0=110.0, B=1e-4), SR)
    assert c["pitch"]["nominal_midi"] == 45
    assert abs(c["pitch"]["f0_hz"] - 110.0) < 0.2


def test_rolloff_and_centroid_follow_the_tilt():
    bright = ch.analyse(synth_note(tilt_db_per_oct=-3.0), SR, 60)
    dull = ch.analyse(synth_note(tilt_db_per_oct=-12.0), SR, 60)
    assert bright["spectrum"]["rolloff_db_per_oct"] > dull["spectrum"]["rolloff_db_per_oct"]
    assert bright["spectrum"]["centroid_body_hz"] > dull["spectrum"]["centroid_body_hz"]
    assert abs(dull["spectrum"]["rolloff_db_per_oct"] - (-12.0)) < 2.0


def test_decay_t60_per_band():
    c = ch.analyse(synth_note(t60_s=1.5, dur=5.0), SR, 60)
    band = next(d for d in c["decay"] if d["band_hz"] == [250, 500])        # holds the fundamental (261 Hz)
    assert band["valid"] and abs(band["t60_s"] - 1.5) / 1.5 < 0.15


def test_attack_rise_time():
    slow = ch.analyse(synth_note(attack_ms=40.0), SR, 60)["attack"]
    fast = ch.analyse(synth_note(attack_ms=2.0), SR, 60)["attack"]
    assert slow["rise_10_90_ms"] > 20 > fast["rise_10_90_ms"]


def test_cloud_sees_noise_between_partials():
    clean = ch.analyse(synth_note(), SR, 60)
    noisy = ch.analyse(synth_note(noise=0.02), SR, 60)
    assert noisy["cloud_db"][3][0] > clean["cloud_db"][3][0] + 6         # 1-2 kHz (partials 4-7), 0.5-1 s window
    assert clean["cloud_db"][0][0] < -25                                   # clean partials: little between them


def test_beating_of_detuned_unison():
    t = np.arange(int(4 * SR)) / SR
    x = (np.sin(2 * np.pi * 261.63 * t) + np.sin(2 * np.pi * 263.63 * t)) * 10 ** (-10 * t / 20)
    c = ch.analyse(0.4 * x / np.abs(x).max(), SR, 60)
    assert c["beating"]["depth_db"] > 6
    assert abs(c["beating"]["modulation_hz"] - 2.0) < 0.3
    assert ch.analyse(synth_note(), SR, 60)["beating"]["depth_db"] < 2


def test_thump_lead_and_excess():
    t = np.arange(int(2 * SR)) / SR
    tone = np.sin(2 * np.pi * 392 * t) * np.minimum(1, t / 0.03) * 10 ** (-8 * t / 20)
    thump = np.sin(2 * np.pi * 90 * t) * np.exp(-t / 0.02)            # 20 ms thud, ahead of the tone
    c = ch.analyse(0.5 * (tone + 2 * thump), SR, 67)
    assert c["thump"]["excess_db"] > 20 and not c["thump"]["f0_in_band"]
    assert c["thump"]["lead_ms"] > 5
    assert ch.analyse(synth_note(f0=110.0), SR, 45)["thump"]["f0_in_band"]


def test_compare_is_signed_b_minus_a():
    a = ch.analyse(synth_note(tilt_db_per_oct=-9.0, t60_s=1.0, dur=5.0), SR, 60)
    b = ch.analyse(synth_note(tilt_db_per_oct=-3.0, t60_s=2.0, dur=5.0), SR, 60)
    d = ch.compare(a, b)
    assert d["centroid_body_ratio"] > 1.2 and d["partials_rms_db"] > 5
    r = dict((tuple(k), v) for k, v in d["decay_t60_ratio"])[(250, 500)]
    assert 1.6 < r < 2.4
    assert abs(d["pitch_cents"]) < 0.5
    assert d["band_time_rms_db"] > 0


def test_silence_gives_a_card_without_pitch():
    c = ch.analyse(np.zeros(SR), SR, 60)
    assert c["pitch"] is None and c["partials"] == [] and c["level"]["crest_factor"] is None


@pytest.mark.parametrize("nominal", [None, 60])
def test_short_signal_does_not_crash(nominal):
    c = ch.analyse(synth_note(dur=0.25), SR, nominal)
    assert c["duration_s"] == pytest.approx(0.25, abs=0.005)            # the onset trim takes 1 ms
