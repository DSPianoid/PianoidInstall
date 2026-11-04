"""dev-tuneskill observe mode: trait deltas, phrase keys, the derived lexicon (agreement, ranges, unchanged,
contradictions, small-sample honesty), the library's observe pairing by tags, the versioned export and the CLI."""
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import lexicon as lx  # noqa: E402
import sample_lib  # noqa: E402

SR = 48000


def write_note(path, f0, tilt=-6.0, dur=2.0, decay_db_s=12.0):
    t = np.arange(int(dur * SR)) / SR
    x = sum(10 ** (tilt * np.log2(k) / 20) * np.sin(2 * np.pi * k * f0 * t) for k in range(1, 13)) * 10 ** (-decay_db_s * t / 20)
    sf.write(str(path), 0.5 * x / np.abs(x).max(), SR, subtype="PCM_24")
    return path


def card(centroid=1000.0, rolloff=-6.0, levels=(0, -6, -10, -14, -18, -20, -22, -24, -26, -28, -30, -32), t60=(2.0,) * 6, rise=3.0):
    bands = ((100, 250), (250, 500), (500, 1000), (1000, 2000), (2000, 4000), (4000, 8000))
    return {"spectrum": {"centroid_attack_hz": centroid * 1.5, "centroid_body_hz": centroid, "rolloff_db_per_oct": rolloff},
            "partials": [{"k": k + 1, "level_db": lv} for k, lv in enumerate(levels)],
            "decay": [{"band_hz": list(b), "t60_s": t, "valid": True} for b, t in zip(bands, t60)],
            "attack": {"rise_10_90_ms": rise}, "cloud_db": [[-30.0, -30.0]], "thump": {"excess_db": 2.0},
            "pitch": {"f0_hz": 261.6, "inharmonicity_B": 4e-4}, "beating": {"depth_db": 1.0}}


def obs(oid, phrase, **traits):
    base = dict.fromkeys(lx.TRAITS)
    base.update(traits)
    return {"id": oid, "recorded_at": f"2026-11-04T10:00:0{oid[-1]}Z", "phrases": [phrase], "traits": base, "pitches": [60], "verdict": "kept"}


def test_traits_delta_signs_and_groups():
    a = card()
    b = card(centroid=850.0, rolloff=-8.0, levels=(0, -6, -10, -18, -22, -24, -26, -28, -26, -28, -30, -32), t60=(2.0, 2.0, 2.0, 2.0, 1.6, 1.6), rise=3.0)
    d = lx.traits_delta(a, b)
    assert d["centroid_body_pct"] == pytest.approx(-15.0) and d["centroid_attack_pct"] == pytest.approx(-15.0)
    assert d["rolloff_db_per_oct"] == pytest.approx(-2.0)
    assert d["partials_1_3_db"] == 0 and d["partials_4_8_db"] == pytest.approx(-4.0) and d["partials_9_12_db"] == 0
    assert d["t60_low_pct"] == 0 and d["t60_high_pct"] == pytest.approx(-20.0) and d["attack_rise_pct"] == 0
    assert d["pitch_cents"] == 0 and d["cloud_db"] == 0
    # a missing field gives None, not 0
    assert lx.traits_delta({}, b)["centroid_body_pct"] is None


def test_phrase_keys_en_ru():
    assert lx.phrases("Warmer, but a bit too woody.") == ["warmer", "too woody"]
    assert lx.phrases("чуть мягче и теплее") == ["мягче", "теплее"]
    assert lx.phrases("more singing; MORE SINGING") == ["more singing"]
    assert lx.phrases("ok") == []


def test_build_agreement_ranges_unchanged_and_confidence():
    warmer = [obs(f"o{i}", "warmer", centroid_body_pct=c, partials_4_8_db=p, attack_rise_pct=0.5)
              for i, (c, p) in enumerate([(-12, -3.5), (-15, -4.0), (-18, -5.0), (-20, -6.0)])]
    lex = lx.build(warmer)
    e = lex["warmer"]
    assert e["n"] == 4 and e["confidence"] == "medium"
    assert e["meaning"]["centroid_body_pct"]["direction"] == "down"
    assert e["meaning"]["centroid_body_pct"]["range"] == [-20, -12] and e["meaning"]["centroid_body_pct"]["agree"] == 4
    assert e["meaning"]["partials_4_8_db"]["range"] == [-6.0, -3.5]
    assert e["unchanged"] == ["attack_rise_pct"] and e["contradictions"] == []
    assert "spectral centroid 100-400 ms -20..-12 % (4/4)" in lx.summary(e) and "unchanged: attack rise" in lx.summary(e)


def test_contradiction_mixed_and_single_observation():
    lex = lx.build([obs("o1", "brighter", centroid_body_pct=10), obs("o2", "brighter", centroid_body_pct=-10),
                    obs("o3", "glassy", centroid_body_pct=8)])
    b = lex["brighter"]
    assert b["meaning"] == {} and b["contradictions"] == ["centroid_body_pct"]
    assert "CONTRADICTORY" in lx.summary(b)
    g = lex["glassy"]
    assert g["confidence"] == "single observation" and g["meaning"]["centroid_body_pct"]["direction"] == "up"
    # 3 of 4 agree = a direction; 2 of 4 do not
    three = lx.build([obs(f"o{i}", "x", cloud_db=v) for i, v in enumerate([-3, -2, -4, 0.2])])["x"]
    assert three["meaning"]["cloud_db"]["direction"] == "down" and three["meaning"]["cloud_db"]["agree"] == 3
    two = lx.build([obs(f"o{i}", "y", cloud_db=v) for i, v in enumerate([-3, -2, 0.1, 0.2])])["y"]
    assert "cloud_db" not in two["meaning"]
    # an observation without traits (contaminated / no pairs) never counts
    assert lx.build([{"id": "o9", "phrases": ["z"], "traits": None}]) == {}


def test_lookup_exact_then_near():
    lex = lx.build([obs("o1", "warmer", centroid_body_pct=-10), obs("o2", "too woody", partials_1_3_db=3)])
    r = lx.lookup(lex, "a bit warmer please, less woody")
    assert list(r["exact"]) == ["warmer"] and list(r["near"]) == ["too woody"]


@pytest.fixture
def lib(tmp_path):
    return sample_lib.Library(tmp_path / "samples", kb=tmp_path / "kb")


def add(lib, tmp_path, name, step, tilt, settings=None, pitch=60, velocity=95, oid="ob1"):
    wav = write_note(tmp_path / f"{name}.wav", 261.63 if pitch == 60 else 392.0, tilt=tilt)
    return lib.add(wav, "render", pitch=pitch, velocity=velocity, tags=[f"obs-{oid}", f"step-{step}"],
                   settings=settings or {"duration_ms": 2000}, sid=name)


def test_observe_pairs_by_tags_and_lexicon(lib, tmp_path):
    add(lib, tmp_path, "c4_0", 0, -6)
    add(lib, tmp_path, "c4_1", 1, -12)                        # darker: the operator says warmer
    add(lib, tmp_path, "g4_1", 1, -12, pitch=67)               # no baseline for G4
    add(lib, tmp_path, "c4_1_v60", 1, -12, velocity=60)        # no baseline at v60
    add(lib, tmp_path, "c4_0_x", 0, -6, velocity=40, settings={"duration_ms": 3000})
    add(lib, tmp_path, "c4_1_x", 1, -12, velocity=40)          # settings differ
    edits = [{"label": "hammer hammer_width [60] 0.03 -> 0.04", "domain": "hammer", "key": "60"}]
    out = lib.observe({"operator": "Leonid", "observe_id": "ob1", "step": 1, "description": "warmer, a bit too woody",
                       "verdict": "kept", "edits": edits})
    o = out["observation"]
    assert o["operator"] == "leonid" and o["phrases"] == ["warmer", "too woody"] and o["pitches"] == [60]
    assert out["comparable_pairs"] == 1
    reasons = sorted(p["excluded"] for p in out["excluded_pairs"])
    assert reasons == ["no earlier sample of this pitch and velocity in the session"] * 2 + ["render settings differ between before and after"]
    assert o["traits"]["centroid_body_pct"] < -3 and o["traits"]["rolloff_db_per_oct"] < -0.5
    assert out["lexicon"]["warmer"]["confidence"] == "single observation"
    assert lib.lexicon("leonid", "warmer")["exact"]["warmer"]["n"] == 1
    # a contaminated step is recorded but carries no traits (it never enters the lexicon)
    bad = lib.observe({"operator": "leonid", "observe_id": "ob1", "step": 1, "description": "warmer", "flags": ["contaminated"]})
    assert bad["observation"]["traits"] is None and lib.lexicon("leonid")["lexicon"]["warmer"]["n"] == 1
    with pytest.raises(ValueError):
        lib.observe({"operator": "///", "observe_id": "ob1", "step": 1, "description": "w"})
    with pytest.raises(ValueError):
        lib.observe({"operator": "leonid", "observe_id": "ob1", "step": 0, "description": "w"})


def test_export_versions_evidence_and_check(lib, tmp_path):
    add(lib, tmp_path, "c4_0", 0, -6)
    add(lib, tmp_path, "c4_1", 1, -12)
    lib.observe({"operator": "leonid", "observe_id": "ob1", "step": 1, "description": "warmer"})
    assert lib.lexicon_export("leonid", check=True)["in_sync"] is False
    r = lib.lexicon_export("leonid")
    assert r["observations"] == 1 and (lib.kb / "leonid.md").read_text(encoding="utf-8").startswith("# Operator lexicon: leonid")
    assert lib.lexicon_export("leonid", check=True)["in_sync"] is True
    assert lib.lexicon("leonid")["versioned"] == 1 and lib.lexicon("leonid")["local_only"] == 0
    # a later local observation: not versioned yet, still part of the derived lexicon; exporting twice adds once
    add(lib, tmp_path, "c4_2", 2, -18)
    lib.observe({"operator": "leonid", "observe_id": "ob1", "step": 2, "description": "warmer"})
    lx_now = lib.lexicon("leonid")
    assert lx_now["local_only"] == 1 and lx_now["lexicon"]["warmer"]["n"] == 2
    lib.lexicon_export("leonid")
    lib.lexicon_export("leonid")
    assert (lib.kb / "leonid.observations.jsonl").read_text(encoding="utf-8").count("\n") == 2


def test_record_observe_mode_case_draft(lib):
    out = lib.record({"description": "the operator voiced C4 by hand", "observe_id": "ob1", "operator": "leonid",
                      "observed_steps": [{"n": 1, "edits": [{"label": "string gamma [60] 1.0 -> 0.8"}], "flags": ["merged"]}],
                      "observations": ["o-1"], "verdict": "kept"})
    draft = Path(out["draft"]).read_text(encoding="utf-8")
    assert "**Mode:** observe · **Operator:** leonid" in draft and "step 1: string gamma [60] 1.0 -> 0.8 (merged)" in draft
    assert "**Observations:** o-1" in draft


def test_cli_observe_lexicon_export(tmp_path):
    root, kb = tmp_path / "lib", tmp_path / "kb"
    run = lambda *a: subprocess.run([sys.executable, str(ROOT / "sample_lib.py"), "--root", str(root), "--kb", str(kb), *a],
                                    capture_output=True, text=True, check=False)
    for name, step, tilt in (("a0", 0, -6), ("a1", 1, -12)):
        wav = write_note(tmp_path / f"{name}.wav", 261.63, tilt=tilt)
        assert json.loads(run("add", "--file", str(wav), "--source", "render", "--pitch", "60", "--velocity", "95", "--id", name,
                              "--tags", f"obs-ob2,step-{step}").stdout)["ok"]
    r = json.loads(run("observe", "--json", json.dumps({"operator": "op", "observe_id": "ob2", "step": 1, "description": "мягче"})).stdout)
    assert r["ok"] and r["observation"]["phrases"] == ["мягче"] and r["comparable_pairs"] == 1
    assert json.loads(run("lexicon", "--operator", "op", "--phrase", "мягче").stdout)["exact"]["мягче"]["n"] == 1
    chk = run("lexicon-export", "--operator", "op", "--check")
    assert chk.returncode == 1 and json.loads(chk.stdout)["ok"] is False
    assert json.loads(run("lexicon-export", "--operator", "op").stdout)["observations"] == 1
    assert run("lexicon-export", "--operator", "op", "--check").returncode == 0
