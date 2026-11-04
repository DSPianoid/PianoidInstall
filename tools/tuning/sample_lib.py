"""
The sound-sample library (dev-tuneskill): the ONE writer of <PianoidInstall>/samples (git-ignored; only its
README and schema are tracked). The assistant service and the dev agents call this CLI; nothing else writes
the folder.

    samples/audio/<id>.wav         the sample (copied in, never moved)
    samples/manifest.jsonl         one JSON record per line, append-only; the LAST record of an id wins
                                   (a re-extraction appends a new record with the same id)
    samples/sessions.jsonl         tuning session records (what the user asked, what was offered and chosen,
                                   the measured result); append-only
    samples/sessions/<id>.md       the case draft of a session, ready to be promoted to docs/tuning/cases/
    samples/observations.jsonl     observe mode: one record per described step (the operator's words, the edits,
                                   the before / after pairs and their trait deltas); append-only
    docs/tuning/lexicon/<operator>.observations.jsonl + <operator>.md
                                   the VERSIONED evidence + the rendered lexicon (lexicon-export; the lexicon itself
                                   is derived on every read by lexicon.py, never stored as a second truth)

Usage (the canonical venv python, CPU only, below-normal priority):
    python tools/tuning/sample_lib.py add --file X.wav --source render --preset P --pitch 60 --velocity 95 [...]
    python tools/tuning/sample_lib.py extract --id s-...        (re-run the extractor on a stored sample)
    python tools/tuning/sample_lib.py list [--source ..] [--preset ..] [--pitch N] [--tag T] [--query text]
    python tools/tuning/sample_lib.py get --id s-...
    python tools/tuning/sample_lib.py compare --a s-... --b s-...
    python tools/tuning/sample_lib.py record --json '{...}'     (a tuning session record + its case draft)
    python tools/tuning/sample_lib.py observe --json '{...}'    (observe mode: one described step -> an observation)
    python tools/tuning/sample_lib.py lexicon --operator X [--phrase "warmer"]   (derived: versioned + local)
    python tools/tuning/sample_lib.py lexicon-export --operator X [--check]      (copy into docs/tuning/lexicon/)
    python tools/tuning/sample_lib.py stats
Every command prints ONE JSON object on stdout (ok: true | false). Root: --root, else $PIANOID_SAMPLES_DIR,
else <PianoidInstall>/samples. Record fields: samples/schema.json.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import secrets
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import characteristics as ch  # noqa: E402
import lexicon as lx  # noqa: E402
from case_draft import case_draft  # noqa: E402

SOURCES = ("render", "mic", "reference")
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
OPERATOR_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,39}$")
STEP_TAG = re.compile(r"^step-(\d+)$")
LIST_LIMIT = 50


def lower_priority():
    """CPU only, never in the way of the realtime engine."""
    try:
        if os.name == "nt":
            import ctypes
            ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), 0x4000)   # BELOW_NORMAL
        else:
            os.nice(10)
    except Exception:
        pass


def default_root():
    return Path(os.environ.get("PIANOID_SAMPLES_DIR") or HERE.parent.parent / "samples")


def default_kb():
    return Path(os.environ.get("PIANOID_LEXICON_DIR") or HERE.parent.parent / "docs" / "tuning" / "lexicon")


def operator_slug(name):
    slug = re.sub(r"[^a-z0-9_-]+", "-", str(name or "").strip().lower()).strip("-")[:40]
    if not OPERATOR_RE.match(slug):
        raise ValueError("operator: a name of letters / digits (it becomes a file name)")
    return slug


def new_id(prefix="s"):
    return f"{prefix}-{dt.datetime.now(dt.timezone.utc).strftime('%Y%m%d%H%M%S')}-{secrets.token_hex(3)}"


def now_iso():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class Library:
    def __init__(self, root, kb=None):
        self.root = Path(root)
        self.kb = Path(kb) if kb else default_kb()
        self.observations = self.root / "observations.jsonl"
        self.audio = self.root / "audio"
        self.manifest = self.root / "manifest.jsonl"
        self.sessions = self.root / "sessions.jsonl"
        self.session_dir = self.root / "sessions"

    # ---- storage --------------------------------------------------------------------------------

    def _read(self, file):
        if not file.exists():
            return {}
        out = {}
        for line in file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue                                           # a torn line never hides the rest
            if isinstance(rec, dict) and rec.get("id"):
                out[rec["id"]] = rec                               # the last record of an id wins
        return out

    def _append(self, file, rec):
        file.parent.mkdir(parents=True, exist_ok=True)
        with file.open("a", encoding="utf-8", newline="\n") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")

    def records(self):
        return self._read(self.manifest)

    def get(self, sid):
        rec = self.records().get(sid)
        if not rec:
            raise KeyError(f"no sample {sid}")
        return rec

    # ---- samples ----------------------------------------------------------------------------------

    def extract_file(self, path, nominal_midi=None):
        import soundfile as sf
        x, sr = sf.read(str(path), dtype="float64", always_2d=True)
        return ch.analyse(x[:, 0], sr, nominal_midi)

    def add(self, file, source, preset=None, pitch=None, velocity=None, settings=None, tags=(), note=None,
            sid=None, date=None, origin=None, tainted=False, extract=True):
        src = Path(file)
        if not src.is_file():
            raise FileNotFoundError(f"no such file: {src}")
        if source not in SOURCES:
            raise ValueError(f"source must be one of {', '.join(SOURCES)}")
        sid = sid or new_id()
        if not ID_RE.match(sid):
            raise ValueError("id: letters, digits, . _ - only")
        if sid in self.records():
            raise FileExistsError(f"sample {sid} exists (use extract to re-run it)")
        self.audio.mkdir(parents=True, exist_ok=True)
        dest = self.audio / f"{sid}{src.suffix.lower() or '.wav'}"
        shutil.copyfile(src, dest)
        rec = {
            "id": sid, "file": dest.relative_to(self.root).as_posix(), "added_at": now_iso(),
            "source": {"kind": source, "preset": preset, "pitch": pitch, "velocity": velocity,
                       "settings": settings or {}, "date": date or now_iso()[:10], "origin": origin, "file_name": src.name},
            "tags": sorted({t for t in tags if t}), "note": note, "tainted": bool(tainted),
            "characteristics": None, "extractor_version": None,
        }
        if extract:
            rec["characteristics"] = self.extract_file(dest, pitch)
            rec["extractor_version"] = ch.VERSION
        self._append(self.manifest, rec)
        return rec

    def extract(self, sid):
        rec = dict(self.get(sid))
        rec["characteristics"] = self.extract_file(self.root / rec["file"], rec["source"].get("pitch"))
        rec["extractor_version"] = ch.VERSION
        rec["extracted_at"] = now_iso()
        self._append(self.manifest, rec)
        return rec

    @staticmethod
    def summary(rec):
        c = rec.get("characteristics") or {}
        p, s, th = c.get("pitch") or {}, c.get("spectrum") or {}, c.get("thump") or {}
        decay = {f"{d['band_hz'][0]}-{d['band_hz'][1]}": (round(d["t60_s"], 2) if d.get("valid") else None) for d in c.get("decay") or []}
        cl = c.get("cloud_db") or []
        cloud = [v for row in cl for v in row if v is not None]
        return {
            "id": rec["id"], "source": rec["source"]["kind"], "preset": rec["source"].get("preset"), "pitch": rec["source"].get("pitch"),
            "velocity": rec["source"].get("velocity"), "date": rec["source"].get("date"), "tags": rec.get("tags", []),
            "tainted": rec.get("tainted", False), "duration_s": c.get("duration_s"),
            "f0_hz": None if not p else round(p["f0_hz"], 2), "tuning_cents": None if not p else round(p["tuning_cents"], 1),
            "inharmonicity_B": None if not p or p.get("inharmonicity_B") is None else float(f"{p['inharmonicity_B']:.3g}"),
            "centroid_attack_hz": None if not s or s.get("centroid_attack_hz") is None else round(s["centroid_attack_hz"]),
            "centroid_body_hz": None if not s or s.get("centroid_body_hz") is None else round(s["centroid_body_hz"]),
            "rolloff_db_per_oct": None if not s or s.get("rolloff_db_per_oct") is None else round(s["rolloff_db_per_oct"], 1),
            "t60_s": decay, "attack_rise_ms": None if not c.get("attack") else round(c["attack"]["rise_10_90_ms"], 1),
            "crest_factor": None if not c.get("level") or c["level"].get("crest_factor") is None else round(c["level"]["crest_factor"], 1),
            "cloud_mean_db": round(sum(cloud) / len(cloud), 1) if cloud else None,
            "thump_excess_db": None if th.get("excess_db") is None else round(th["excess_db"], 1),
            "thump_lead_ms": None if th.get("lead_ms") is None else round(th["lead_ms"], 1),
        }

    def list(self, source=None, preset=None, pitch=None, tag=None, query=None, limit=LIST_LIMIT):
        rows = []
        for rec in sorted(self.records().values(), key=lambda r: r.get("added_at", ""), reverse=True):
            s = rec["source"]
            if source and s.get("kind") != source:
                continue
            if preset and preset.lower() not in str(s.get("preset") or "").lower():
                continue
            if pitch is not None and s.get("pitch") != pitch:
                continue
            if tag and tag not in rec.get("tags", []):
                continue
            if query:
                hay = json.dumps({k: rec[k] for k in ("id", "source", "tags", "note")}, ensure_ascii=False).lower()
                if query.lower() not in hay:
                    continue
            rows.append(self.summary(rec))
        return {"total": len(rows), "samples": rows[:limit]}

    def compare(self, a, b):
        ra, rb = self.get(a), self.get(b)
        if not ra.get("characteristics") or not rb.get("characteristics"):
            raise ValueError("both samples need extracted characteristics (run extract)")
        return {"a": self.summary(ra), "b": self.summary(rb), "b_minus_a": ch.compare(ra["characteristics"], rb["characteristics"])}

    # ---- tuning session records ---------------------------------------------------------------------

    def record(self, data):
        req = ("description",)
        for k in req:
            if not str(data.get(k) or "").strip():
                raise ValueError(f"{k}: required")
        rec = {
            "id": data.get("id") or new_id("t"), "recorded_at": now_iso(), "description": data["description"],
            "interpretation": data.get("interpretation"), "preset": data.get("preset"), "pitches": data.get("pitches"),
            "options_offered": data.get("options_offered") or [], "chosen": data.get("chosen"),
            "changes": data.get("changes") or [], "user_edits": data.get("user_edits") or [],
            "before": data.get("before") or {}, "after": data.get("after") or {}, "samples": data.get("samples") or [],
            "verdict": data.get("verdict") or "open", "lessons": data.get("lessons") or [], "tainted": bool(data.get("tainted")),
            "mode": "observe" if data.get("observe_id") else "cooperative", "operator": data.get("operator"),
            "observe_id": data.get("observe_id"), "observed_steps": data.get("observed_steps") or [],
            "observations": data.get("observations") or [],
        }
        if not ID_RE.match(rec["id"]):
            raise ValueError("id: letters, digits, . _ - only")
        self._append(self.sessions, rec)
        self.session_dir.mkdir(parents=True, exist_ok=True)
        draft = self.session_dir / f"{rec['id']}.md"
        draft.write_text(case_draft(rec), encoding="utf-8", newline="\n")
        return {"id": rec["id"], "draft": str(draft), "verdict": rec["verdict"]}

    # ---- observe mode: observations and the operator lexicon ---------------------------------------

    def _pairs(self, observe_id, step):
        """The before / after pairs of a step from the library tags: after = the samples tagged obs-<id> + step-<n>,
        before = the same pitch and velocity at the latest earlier step of that observe session."""
        mine = []
        for r in self.records().values():
            if f"obs-{observe_id}" not in r.get("tags", []):
                continue
            n = next((int(m.group(1)) for t in r.get("tags", []) if (m := STEP_TAG.match(t))), None)
            if n is not None:
                mine.append((n, r))
        pairs = []
        for _, after in (x for x in mine if x[0] == step):
            src = after["source"]
            earlier = [(m, r) for m, r in mine if m < step and r["source"].get("pitch") == src.get("pitch")
                       and r["source"].get("velocity") == src.get("velocity")]
            pair = {"pitch": src.get("pitch"), "velocity": src.get("velocity"), "after": after["id"], "before": None}
            if not earlier:
                pairs.append({**pair, "excluded": "no earlier sample of this pitch and velocity in the session"})
                continue
            m, before = max(earlier, key=lambda x: (x[0], x[1].get("added_at", "")))
            pair.update(before=before["id"], before_step=m)
            if (before["source"].get("settings") or {}) != (src.get("settings") or {}):
                pair["excluded"] = "render settings differ between before and after"
            elif not before.get("characteristics") or not after.get("characteristics"):
                pair["excluded"] = "a sample has no characteristics"
            else:
                pair["traits"] = lx.traits_delta(before["characteristics"], after["characteristics"])
            pairs.append(pair)
        return sorted(pairs, key=lambda p: (p["pitch"] is None, p["pitch"] or 0, p["velocity"] or 0))

    def observe(self, data):
        """One described step of an observe session -> an observation (the operator's words + the measured delta)."""
        operator = operator_slug(data.get("operator"))
        desc = str(data.get("description") or "").strip()
        if not desc:
            raise ValueError("description: the operator's words are required")
        oid, step = str(data.get("observe_id") or ""), data.get("step")
        if not ID_RE.match(oid) or not isinstance(step, int) or step < 1:
            raise ValueError("observe_id and step (>= 1) are required")
        keys = [lx.normalise(p) for p in data.get("phrases") or []] or lx.phrases(desc)
        pairs = self._pairs(oid, step)
        good = [p for p in pairs if p.get("traits")]
        flags = sorted(set(data.get("flags") or []))
        rec = {
            "id": data.get("id") or new_id("o"), "recorded_at": now_iso(), "operator": operator, "observe_id": oid,
            "step": step, "description": desc, "phrases": [k for k in keys if k], "language": data.get("language"),
            "verdict": data.get("verdict") or "open", "preset": data.get("preset"), "edits": data.get("edits") or [],
            "flags": flags, "pitches": sorted({p["pitch"] for p in good if p["pitch"] is not None}),
            "pairs": pairs, "traits": lx.step_traits(good) if good and "contaminated" not in flags else None,
            "tainted": bool(data.get("tainted")),
        }
        if not ID_RE.match(rec["id"]):
            raise ValueError("id: letters, digits, . _ - only")
        self._append(self.observations, rec)
        lex = lx.build(self.operator_observations(operator)["observations"])
        return {"observation": rec, "lexicon": {k: {**lex[k], "summary": lx.summary(lex[k])} for k in rec["phrases"] if k in lex},
                "comparable_pairs": len(good), "excluded_pairs": [p for p in pairs if p.get("excluded")]}

    def operator_observations(self, operator):
        """The versioned evidence of the operator plus this machine's not yet exported observations (by id)."""
        operator = operator_slug(operator)
        versioned = self._read(self.kb / f"{operator}.observations.jsonl")
        local = {k: v for k, v in self._read(self.observations).items() if v.get("operator") == operator}
        merged = {**local, **versioned}
        return {"operator": operator, "observations": sorted(merged.values(), key=lambda o: o.get("recorded_at", "")),
                "versioned": len(versioned), "local_only": len(set(local) - set(versioned))}

    def lexicon(self, operator, phrase=None):
        """The operator's lexicon, derived now (never stored); with a phrase, only the entries that request uses."""
        obs = self.operator_observations(operator)
        lex = lx.build(obs["observations"])
        for e in lex.values():
            e["summary"] = lx.summary(e)
        head = {"operator": obs["operator"], "observations": len(obs["observations"]), "versioned": obs["versioned"],
                "local_only": obs["local_only"], "phrases": len(lex),
                "tainted": any(o.get("tainted") for o in obs["observations"])}
        return {**head, **lx.lookup(lex, phrase)} if phrase else {**head, "lexicon": lex}

    def lexicon_export(self, operator, check=False):
        """Copy the operator's observations into the versioned knowledge base and render its page. check: the page on
        disk must equal the render of the versioned evidence; nothing is written."""
        operator = operator_slug(operator)
        evidence, page = self.kb / f"{operator}.observations.jsonl", self.kb / f"{operator}.md"
        versioned = self._read(evidence)
        if not check:
            for o in self.operator_observations(operator)["observations"]:
                if o["id"] not in versioned:
                    self._append(evidence, o)
            versioned = self._read(evidence)
        obs = sorted(versioned.values(), key=lambda o: o.get("recorded_at", ""))
        text = lx.render_md(operator, lx.build(obs), obs)
        if check:
            return {"operator": operator, "in_sync": page.exists() and page.read_text(encoding="utf-8") == text}
        page.write_text(text, encoding="utf-8", newline="\n")
        return {"operator": operator, "evidence": str(evidence), "page": str(page), "observations": len(obs)}

    def sessions_list(self, limit=LIST_LIMIT):
        rows = sorted(self._read(self.sessions).values(), key=lambda r: r.get("recorded_at", ""), reverse=True)
        return {"total": len(rows), "sessions": [{k: r.get(k) for k in ("id", "recorded_at", "description", "preset", "verdict", "tainted")} for r in rows[:limit]]}

    def stats(self):
        recs = self.records()
        by = {}
        for r in recs.values():
            by[r["source"]["kind"]] = by.get(r["source"]["kind"], 0) + 1
        return {"root": str(self.root), "samples": len(recs), "by_source": by, "sessions": len(self._read(self.sessions)),
                "observations": len(self._read(self.observations)), "extractor_version": ch.VERSION}


# ---- CLI ----------------------------------------------------------------------------------------------

def main(argv=None):
    ap = argparse.ArgumentParser(prog="sample_lib", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", help="library folder (default $PIANOID_SAMPLES_DIR or <PianoidInstall>/samples)")
    ap.add_argument("--kb", help="versioned lexicon folder (default $PIANOID_LEXICON_DIR or <PianoidInstall>/docs/tuning/lexicon)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("add")
    a.add_argument("--file", required=True)
    a.add_argument("--source", required=True, choices=SOURCES)
    a.add_argument("--preset")
    a.add_argument("--pitch", type=int)
    a.add_argument("--velocity", type=int)
    a.add_argument("--settings", help="JSON object: load settings / routing / feedback at the time")
    a.add_argument("--tags", default="", help="comma-separated")
    a.add_argument("--note")
    a.add_argument("--id")
    a.add_argument("--date", help="YYYY-MM-DD of the recording / render")
    a.add_argument("--origin", help="where it came from: artefact id, rig run, file")
    a.add_argument("--tainted", action="store_true")
    a.add_argument("--no-extract", action="store_true")
    e = sub.add_parser("extract")
    e.add_argument("--id", required=True)
    ls = sub.add_parser("list")
    ls.add_argument("--source", choices=SOURCES)
    ls.add_argument("--preset")
    ls.add_argument("--pitch", type=int)
    ls.add_argument("--tag")
    ls.add_argument("--query")
    ls.add_argument("--limit", type=int, default=LIST_LIMIT)
    g = sub.add_parser("get")
    g.add_argument("--id", required=True)
    c = sub.add_parser("compare")
    c.add_argument("--a", required=True)
    c.add_argument("--b", required=True)
    r = sub.add_parser("record")
    r.add_argument("--json", required=True, help="the session record as a JSON object (or @file)")
    o = sub.add_parser("observe")
    o.add_argument("--json", required=True, help="the observation as a JSON object (or @file)")
    lxp = sub.add_parser("lexicon")
    lxp.add_argument("--operator", required=True)
    lxp.add_argument("--phrase", help="a request in the operator's words: the entries it uses")
    lxe = sub.add_parser("lexicon-export")
    lxe.add_argument("--operator", required=True)
    lxe.add_argument("--check", action="store_true")
    sub.add_parser("sessions")
    sub.add_parser("stats")
    args = ap.parse_args(argv)
    lower_priority()
    lib = Library(args.root or default_root(), args.kb)
    try:
        if args.cmd == "add":
            settings = json.loads(args.settings) if args.settings else None
            out = lib.add(args.file, args.source, args.preset, args.pitch, args.velocity, settings, args.tags.split(","),
                          args.note, args.id, args.date, args.origin, args.tainted, not args.no_extract)
            out = {"record": lib.summary(out), "file": out["file"]}
        elif args.cmd == "extract":
            out = {"record": lib.summary(lib.extract(args.id))}
        elif args.cmd == "list":
            out = lib.list(args.source, args.preset, args.pitch, args.tag, args.query, args.limit)
        elif args.cmd == "get":
            out = {"record": lib.get(args.id)}
        elif args.cmd == "compare":
            out = lib.compare(args.a, args.b)
        elif args.cmd == "record":
            text = Path(args.json[1:]).read_text(encoding="utf-8") if args.json.startswith("@") else args.json
            out = lib.record(json.loads(text))
        elif args.cmd == "observe":
            text = Path(args.json[1:]).read_text(encoding="utf-8") if args.json.startswith("@") else args.json
            out = lib.observe(json.loads(text))
        elif args.cmd == "lexicon":
            out = lib.lexicon(args.operator, args.phrase)
        elif args.cmd == "lexicon-export":
            out = lib.lexicon_export(args.operator, args.check)
            if args.check and not out["in_sync"]:
                print(json.dumps({"ok": False, "error": f"{out['operator']}.md is out of date: run lexicon-export", **out}))
                return 1
        elif args.cmd == "sessions":
            out = lib.sessions_list()
        else:
            out = lib.stats()
        print(json.dumps({"ok": True, **out}, ensure_ascii=False, default=float))
        return 0
    except Exception as exc:                                   # one JSON line, never a traceback on stdout
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
