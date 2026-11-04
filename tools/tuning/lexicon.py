"""
The operator lexicon (dev-tuneskill, observe mode): what an operator's own words mean as observable changes of
the sound, derived from (description, measured delta) pairs. Pure functions, no I/O: the sample library CLI
(sample_lib.py, the one writer) stores the observations and calls these.

    traits_delta(card_a, card_b)   the trait vector of one before / after pair (b minus a), from two cards
    step_traits(pairs)             one value per trait for a step: the median over its pairs (pitches x velocities)
    phrases(text)                  a description split into phrase keys ("warmer, but too woody" -> warmer, too woody)
    build(observations)            phrase -> meaning: per trait the direction, range, k of n agreeing, contradictions
    lookup(lexicon, text)          the entries a request uses: exact phrase keys, then near ones (shared words)
    render_md(operator, lexicon, observations)    the versioned page docs/tuning/lexicon/<operator>.md

A phrase is read as describing the CHANGE the step caused ("warmer", and also "too woody" = the step made it
woody). Thresholds below are conventions for "changed" (not measured noise floors; the offline render itself
repeats to ~2e-4 relative): a delta inside its threshold counts as unchanged.
"""
from __future__ import annotations

import math
import re
import statistics

# trait -> (unit, threshold for "changed", what it is)
TRAITS = {
    "centroid_attack_pct": ("%", 3.0, "spectral centroid 0-30 ms"),
    "centroid_body_pct": ("%", 3.0, "spectral centroid 100-400 ms"),
    "rolloff_db_per_oct": ("dB/oct", 0.5, "spectral tilt over the partials"),
    "partials_1_3_db": ("dB", 1.0, "partials 1-3, level re the strongest"),
    "partials_4_8_db": ("dB", 1.0, "partials 4-8"),
    "partials_9_12_db": ("dB", 1.0, "partials 9-12"),
    "t60_low_pct": ("%", 5.0, "T60 100-500 Hz"),
    "t60_mid_pct": ("%", 5.0, "T60 500-2000 Hz"),
    "t60_high_pct": ("%", 5.0, "T60 2-8 kHz"),
    "attack_rise_pct": ("%", 10.0, "attack rise 10-90 %"),
    "cloud_db": ("dB", 1.0, "noise between the partials (mean of the cloud matrix)"),
    "thump_excess_db": ("dB", 1.0, "thump excess 50-200 Hz"),
    "inharmonicity_pct": ("%", 5.0, "inharmonicity B"),
    "pitch_cents": ("cents", 1.0, "pitch"),
    "beating_depth_db": ("dB", 1.0, "beating depth of the fundamental"),
}
PARTIAL_GROUPS = {"partials_1_3_db": (1, 3), "partials_4_8_db": (4, 8), "partials_9_12_db": (9, 12)}
T60_GROUPS = {"t60_low_pct": (100, 500), "t60_mid_pct": (500, 2000), "t60_high_pct": (2000, 8000)}
AGREE = 0.75            # share of observations that must agree for a direction
CONTRA = 0.25           # both signs at least this share = a contradiction
SPLIT = re.compile(r"[,;.!?\n]+|\s+(?:but|and|however|though|но|и|а|зато|однако)\s+", re.IGNORECASE)
FILLERS = ("a little bit", "a little", "a bit", "slightly", "somewhat", "much", "very", "way", "really",
           "чуть-чуть", "чуть", "немного", "немножко", "слегка", "гораздо", "намного", "очень", "совсем")
NOT_PHRASES = {"", "it", "it's", "its", "now", "yes", "ok", "okay", "да", "теперь", "стало", "it is", "sounds", "звучит"}


def _pct(a, b):
    return None if not a or b is None else (b / a - 1.0) * 100.0


def _get(card, *path):
    for p in path:
        if not isinstance(card, dict):
            return None
        card = card.get(p)
    return card


def traits_delta(a, b):
    """The trait vector of one pair (b minus a). A trait either card lacks is None."""
    out = dict.fromkeys(TRAITS)
    for key in ("attack", "body"):
        out[f"centroid_{key}_pct"] = _pct(_get(a, "spectrum", f"centroid_{key}_hz"), _get(b, "spectrum", f"centroid_{key}_hz"))
    ra, rb = _get(a, "spectrum", "rolloff_db_per_oct"), _get(b, "spectrum", "rolloff_db_per_oct")
    out["rolloff_db_per_oct"] = None if ra is None or rb is None else rb - ra
    pa = {p["k"]: p["level_db"] for p in a.get("partials") or []}
    pb = {p["k"]: p["level_db"] for p in b.get("partials") or []}
    for name, (lo, hi) in PARTIAL_GROUPS.items():
        d = [pb[k] - pa[k] for k in range(lo, hi + 1) if k in pa and k in pb]
        out[name] = sum(d) / len(d) if d else None
    da = {tuple(d["band_hz"]): d for d in a.get("decay") or []}
    for name, (lo, hi) in T60_GROUPS.items():
        logs = []
        for d in b.get("decay") or []:
            band, before = tuple(d["band_hz"]), da.get(tuple(d["band_hz"]))
            if band[0] >= lo and band[1] <= hi and before and before["valid"] and d["valid"] and before["t60_s"] > 0 and d["t60_s"] > 0:
                logs.append(d["t60_s"] / before["t60_s"])
        out[name] = (statistics.geometric_mean(logs) - 1.0) * 100.0 if logs else None
    out["attack_rise_pct"] = _pct(_get(a, "attack", "rise_10_90_ms"), _get(b, "attack", "rise_10_90_ms"))
    ca = [v for row in a.get("cloud_db") or [] for v in row if v is not None]
    cb = [v for row in b.get("cloud_db") or [] for v in row if v is not None]
    out["cloud_db"] = sum(cb) / len(cb) - sum(ca) / len(ca) if ca and cb else None
    ta, tb = _get(a, "thump", "excess_db"), _get(b, "thump", "excess_db")
    out["thump_excess_db"] = None if ta is None or tb is None else tb - ta
    out["inharmonicity_pct"] = _pct(_get(a, "pitch", "inharmonicity_B"), _get(b, "pitch", "inharmonicity_B"))
    fa, fb = _get(a, "pitch", "f0_hz"), _get(b, "pitch", "f0_hz")
    out["pitch_cents"] = None if not fa or not fb else 1200.0 * math.log2(fb / fa)
    ba, bb = _get(a, "beating", "depth_db"), _get(b, "beating", "depth_db")
    out["beating_depth_db"] = None if ba is None or bb is None else bb - ba
    return {k: (None if v is None else round(float(v), 2)) for k, v in out.items()}


def step_traits(pairs):
    """One value per trait for a step: the median over the step's comparable pairs (a step counts once)."""
    out = {}
    for t in TRAITS:
        vals = [p["traits"][t] for p in pairs if p.get("traits") and p["traits"].get(t) is not None]
        out[t] = round(statistics.median(vals), 2) if vals else None
    return out


def normalise(phrase):
    s = re.sub(r"\s+", " ", str(phrase).strip().lower()).strip(" \"'«»“”-")
    for f in FILLERS:
        s = re.sub(rf"(^|\s){re.escape(f)}(\s|$)", " ", s).strip()
    return re.sub(r"\s+", " ", s)


def phrases(text):
    """Phrase keys of a description, in order, without duplicates."""
    out = []
    for part in SPLIT.split(str(text or "")):
        key = normalise(part)
        if key not in NOT_PHRASES and len(key) <= 80 and key not in out:
            out.append(key)
    return out


def _direction(vals, thr):
    n = len(vals)
    up = sum(v > thr for v in vals)
    down = sum(v < -thr for v in vals)
    flat = n - up - down
    best = max((up, "up"), (down, "down"), (flat, "unchanged"))
    direction = best[1] if best[0] / n >= AGREE else "mixed"
    agreeing = [v for v in vals if (direction == "up" and v > thr) or (direction == "down" and v < -thr)
                or (direction == "unchanged" and abs(v) <= thr)]
    return {"direction": direction, "agree": best[0] if direction != "mixed" else max(up, down, flat), "n": n,
            "range": [min(agreeing), max(agreeing)] if agreeing else None, "median": round(statistics.median(vals), 2),
            "contradiction": up > 0 and down > 0 and min(up, down) / n >= CONTRA, "up": up, "down": down}


def confidence(n):
    """Honest about small samples: the count decides the word, never the score."""
    return "single observation" if n <= 1 else "low" if n <= 3 else "medium" if n <= 7 else "high"


def build(observations):
    """phrase -> entry. Only observations with step traits count; each counts once per phrase."""
    by = {}
    for o in observations:
        if not o.get("traits") or not any(v is not None for v in o["traits"].values()):
            continue
        for p in o.get("phrases") or []:
            by.setdefault(p, []).append(o)
    lex = {}
    for p, obs in sorted(by.items()):
        traits = {}
        for t, (unit, thr, _) in TRAITS.items():
            vals = [o["traits"][t] for o in obs if o["traits"].get(t) is not None]
            if vals:
                traits[t] = {**_direction(vals, thr), "unit": unit}
        meaning = {t: v for t, v in traits.items() if v["direction"] in ("up", "down")}
        lex[p] = {
            "phrase": p, "n": len(obs), "confidence": confidence(len(obs)),
            "meaning": meaning,
            "unchanged": sorted(t for t, v in traits.items() if v["direction"] == "unchanged" and v["n"] >= 2),
            "contradictions": sorted(t for t, v in traits.items() if v["contradiction"]),
            "pitches": sorted({pp for o in obs for pp in o.get("pitches") or []}),
            "verdicts": {v: sum(1 for o in obs if (o.get("verdict") or "open") == v) for v in sorted({o.get("verdict") or "open" for o in obs})},
            "observations": [o["id"] for o in obs],
            "tainted": any(o.get("tainted") for o in obs),
        }
    return lex


def describe_trait(t, v):
    unit = v["unit"]
    lo, hi = v["range"] if v["range"] else (v["median"], v["median"])
    rng = f"{lo:+g}" if lo == hi else f"{lo:+g}..{hi:+g}"
    return f"{TRAITS[t][2]} {rng} {unit} ({v['agree']}/{v['n']})"


def summary(entry):
    """One line: what the phrase means for this operator, with its evidence."""
    parts = [describe_trait(t, v) for t, v in sorted(entry["meaning"].items(), key=lambda kv: -kv[1]["agree"])]
    s = "; ".join(parts) if parts else "no consistent change yet"
    if entry["unchanged"]:
        s += f"; unchanged: {', '.join(TRAITS[t][2] for t in entry['unchanged'])}"
    if entry["contradictions"]:
        s += f"; CONTRADICTORY: {', '.join(TRAITS[t][2] for t in entry['contradictions'])}"
    return f"{s} [{entry['n']} observation{'s' if entry['n'] != 1 else ''}, {entry['confidence']}]"


def lookup(lex, text):
    """Entries for a request: phrases the request contains word for word first, then entries sharing a word with it."""
    keys = phrases(text) or [normalise(text)]
    padded = [f" {k} " for k in keys]
    exact = {k: e for k, e in lex.items() if any(f" {k} " in q for q in padded)}
    words = {w for k in keys for w in k.split() if len(w) > 2}
    near = {k: e for k, e in lex.items() if k not in exact and words & set(k.split())}
    return {"query": keys, "exact": exact, "near": near}


def render_md(operator, lex, observations):
    out = [f"# Operator lexicon: {operator}", "",
           "**Generated** by `tools/tuning/sample_lib.py lexicon-export` from "
           f"`{operator}.observations.jsonl` (the evidence, versioned); do not edit by hand. What this operator's words "
           "mean as measured changes of the sound (b minus a of each observed step, the median over its pitches and "
           "velocities). How it is used: [`guides/TUNING_FOR_ASSISTANT.md#observe`](../../guides/TUNING_FOR_ASSISTANT.md#observe). "
           "A direction needs 3 of 4 observations to agree; one observation is never a rule.", "",
           f"{len(observations)} observations · {len(lex)} phrases.", "", "## Phrases {#phrases}", "",
           "| Phrase | n | Confidence | Means (range, agreeing / n) | Unchanged | Contradictions |", "|---|---|---|---|---|---|"]
    for p, e in lex.items():
        means = "; ".join(describe_trait(t, v) for t, v in e["meaning"].items()) or "-"
        out.append(f"| {p} | {e['n']} | {e['confidence']} | {means} | {', '.join(e['unchanged']) or '-'} | "
                   f"{', '.join(e['contradictions']) or '-'} |")
    out += ["", "## Observations {#observations}", "", "| Id | Date | Step | Description | Pitches | Verdict | Edits |", "|---|---|---|---|---|---|---|"]
    for o in sorted(observations, key=lambda o: o.get("recorded_at", "")):
        desc = str(o.get("description", "")).replace("|", "/")
        edits = "; ".join(e.get("label", "") for e in (o.get("edits") or [])[:4]).replace("|", "/")
        out.append(f"| `{o['id']}` | {str(o.get('recorded_at', ''))[:10]} | {o.get('step')} | {desc} | "
                   f"{', '.join(map(str, o.get('pitches') or [])) or '-'} | {o.get('verdict') or 'open'} | {edits or '-'} |")
    return "\n".join(out).rstrip() + "\n"
