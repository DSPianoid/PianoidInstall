"""
Render docs/tuning/knowledge/PARAMETER_EFFECTS.md from parameter_effects.json (dev-tuneskill). The JSON is the
single source of truth; the md is what the assistant reads with read_docs (one section per sound aspect, one
subsection per entry, explicit {#anchors} = the entry ids). `--check` exits 1 when the md on disk differs from
the render (the test guard).

    python tools/tuning/render_knowledge.py [--check]
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "docs" / "tuning" / "knowledge" / "parameter_effects.json"
OUT = ROOT / "docs" / "tuning" / "knowledge" / "PARAMETER_EFFECTS.md"
CONF_ORDER = {"measured": 0, "measured (mixed: effective only above the grid quantum)": 0, "literature": 1, "anecdotal": 2, "unknown": 3}


def anchor(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def render(data):
    out = ["# Parameter effects (Pianoid tuning knowledge base)", "",
           "**Generated** from `parameter_effects.json` by `tools/tuning/render_knowledge.py`; edit the JSON, not this page. "
           "One entry = one lever -> one sound aspect: direction, typical magnitude, register dependence, side effects, "
           "confidence (**measured** = a number from this engine with its source; **literature** = physics / engine docs; "
           "**anecdotal** = a listening session or a user statement; **unknown** = stated as unknown) and the source. "
           "Read with `read_docs` (page `tuning/knowledge/PARAMETER_EFFECTS.md`, anchor = an aspect or an entry id). "
           "How to use it: [`guides/TUNING_FOR_ASSISTANT.md#knowledge`](../../guides/TUNING_FOR_ASSISTANT.md#knowledge).", "",
           f"Version {data['version']} · {len(data['entries'])} entries.", "", "## Aspects {#aspects}", "",
           "| Aspect | Measured as |", "|---|---|"]
    for k, v in data["aspects"].items():
        out.append(f"| `{k}` | {v} |")
    out += ["", "## Index {#index}", "", "| Entry | Parameter | Aspect | Confidence |", "|---|---|---|---|"]
    for e in data["entries"]:
        out.append(f"| [{e['id']}](#{anchor(e['id'])}) | {e['parameter']} | {e['aspect']} | {e['confidence']} |")
    by_aspect = {}
    for e in data["entries"]:
        by_aspect.setdefault(e["aspect"], []).append(e)
    for aspect in data["aspects"]:
        entries = by_aspect.get(aspect)
        if not entries:
            continue
        out += ["", f"## {aspect} {{#{anchor(aspect)}}}", "", data["aspects"][aspect], ""]
        for e in sorted(entries, key=lambda x: CONF_ORDER.get(x["confidence"], 9)):
            out += [f"### {e['id']} {{#{anchor(e['id'])}}}", "",
                    f"- **Parameter:** {e['parameter']}",
                    f"- **Direction:** {e['direction']}",
                    f"- **Magnitude:** {e['magnitude']}",
                    f"- **Register:** {e['register']}",
                    f"- **Side effects / interactions:** {e['side_effects']}",
                    f"- **Confidence:** {e['confidence']}",
                    f"- **Source:** {e['source']}", ""]
    return "\n".join(out).rstrip() + "\n"


def main(argv=None):
    check = "--check" in (argv or sys.argv[1:])
    text = render(json.loads(SRC.read_text(encoding="utf-8")))
    if check:
        ok = OUT.exists() and OUT.read_text(encoding="utf-8") == text
        print("in sync" if ok else "PARAMETER_EFFECTS.md is out of date: run tools/tuning/render_knowledge.py")
        return 0 if ok else 1
    OUT.write_text(text, encoding="utf-8", newline="\n")
    print(f"wrote {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
