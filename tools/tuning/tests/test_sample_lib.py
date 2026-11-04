"""dev-tuneskill: the sample library CLI on a temporary root (add / extract / list / get / compare / record)."""
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import sample_lib  # noqa: E402

SR = 48000


def write_note(path, f0, tilt=-6.0, dur=2.0):
    t = np.arange(int(dur * SR)) / SR
    x = sum(10 ** (tilt * np.log2(k) / 20) * np.sin(2 * np.pi * k * f0 * t) for k in range(1, 9)) * 10 ** (-12 * t / 20)
    sf.write(str(path), 0.5 * x / np.abs(x).max(), SR, subtype="PCM_24")
    return path


@pytest.fixture
def lib(tmp_path):
    return sample_lib.Library(tmp_path / "samples")


def test_add_copies_extracts_and_appends(lib, tmp_path):
    wav = write_note(tmp_path / "c4.wav", 261.63)
    rec = lib.add(wav, "render", preset="P", pitch=60, velocity=95, tags=["x", ""], settings={"order": 2}, origin="a-1")
    assert rec["id"].startswith("s-") and (lib.root / rec["file"]).is_file()
    assert rec["characteristics"]["pitch"]["nominal_midi"] == 60 and rec["tags"] == ["x"]
    assert lib.manifest.read_text(encoding="utf-8").count("\n") == 1
    s = sample_lib.Library.summary(rec)
    assert s["f0_hz"] == pytest.approx(261.63, abs=0.5) and s["source"] == "render"
    with pytest.raises(FileExistsError):
        lib.add(wav, "render", sid=rec["id"])
    with pytest.raises(ValueError):
        lib.add(wav, "mp3")


def test_last_record_wins_after_extract(lib, tmp_path):
    rec = lib.add(write_note(tmp_path / "a.wav", 220.0), "mic", pitch=57, extract=False)
    assert rec["characteristics"] is None
    lib.extract(rec["id"])
    assert lib.manifest.read_text(encoding="utf-8").count("\n") == 2
    assert lib.get(rec["id"])["characteristics"]["pitch"]["nominal_midi"] == 57
    assert lib.stats()["samples"] == 1


def test_list_filters_and_compare(lib, tmp_path):
    a = lib.add(write_note(tmp_path / "a.wav", 261.63, tilt=-12), "reference", preset="Belarus", pitch=60, tags=["piano"])
    b = lib.add(write_note(tmp_path / "b.wav", 261.63, tilt=-3), "render", preset="F15", pitch=60, note="bright render")
    assert lib.list(source="render")["total"] == 1
    assert lib.list(preset="bel")["samples"][0]["id"] == a["id"]
    assert lib.list(tag="piano")["total"] == 1 and lib.list(pitch=61)["total"] == 0
    assert lib.list(query="BRIGHT")["samples"][0]["id"] == b["id"]
    d = lib.compare(a["id"], b["id"])["b_minus_a"]
    assert d["centroid_body_ratio"] > 1.1 and d["partials_rms_db"] > 3


def test_torn_manifest_line_is_skipped(lib, tmp_path):
    rec = lib.add(write_note(tmp_path / "a.wav", 440.0), "render", pitch=69)
    with lib.manifest.open("a", encoding="utf-8") as f:
        f.write('{"id": "broken"')
    assert list(lib.records()) == [rec["id"]]


def test_record_writes_session_and_draft(lib):
    out = lib.record({"description": "make C4 less harsh", "interpretation": "lower centroid, keep level",
                      "options_offered": ["hammer_width up", "dispersion_damping up"], "chosen": "hammer_width 0.04",
                      "changes": ["hammer.hammer_width p60 0.03 -> 0.04"], "user_edits": ["Set string gamma p60"],
                      "before": {"centroid_body_hz": 900}, "after": {"centroid_body_hz": 700}, "verdict": "kept", "lessons": ["width works at C4"]})
    assert out["id"].startswith("t-") and out["verdict"] == "kept"
    draft = Path(out["draft"]).read_text(encoding="utf-8")
    assert draft.startswith("# Tuning case: make C4 less harsh") and "hammer_width 0.04" in draft and "Set string gamma p60" in draft
    assert lib.sessions_list()["sessions"][0]["description"] == "make C4 less harsh"
    with pytest.raises(ValueError):
        lib.record({"description": "  "})


def test_cli_json_contract(tmp_path):
    wav = write_note(tmp_path / "a.wav", 261.63)
    root = tmp_path / "lib"
    run = lambda *a: json.loads(subprocess.run([sys.executable, str(ROOT / "sample_lib.py"), "--root", str(root), *a],
                                              capture_output=True, text=True, check=False).stdout)
    r = run("add", "--file", str(wav), "--source", "render", "--pitch", "60", "--id", "c4", "--tags", "t1,t2", "--settings", '{"order": 2}')
    assert r["ok"] and r["record"]["id"] == "c4" and r["record"]["tags"] == ["t1", "t2"]
    assert run("stats")["samples"] == 1
    assert run("get", "--id", "c4")["record"]["source"]["settings"] == {"order": 2}
    bad = run("get", "--id", "nope")
    assert bad["ok"] is False and "no sample" in bad["error"]
    assert run("list", "--pitch", "60")["total"] == 1
