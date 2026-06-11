#!/usr/bin/env python3
"""lint_skills.py — drift guard for the .claude/commands/ skills (P0 SSOT guardrail).

This is the "can't-recur" half of the P0 de-drift work: a one-time consolidation degrades
again without a check, so this lint FAILS (exit 2) the moment a forbidden build form or a
re-inlined duplicated block reappears in a skill file. It would have caught the original
`--heavy --release` drift across 11 skills.

Rationale + design: docs/proposals/generic-dev-skillset-opensource-2026-06-11.md (Part 3a item 1,
Part B.5) and the spec at D:\\tmp\\skillset-review\\p0-dedrift-ssot-spec.md.

Pure-Python, stdlib-only. Deterministic, loud-and-local failure (non-zero exit + clear stderr).
Run:
    python tools/dev-pipeline/lint_skills.py            # lint .claude/commands/, exit 0 clean / 2 on violations
    python tools/dev-pipeline/lint_skills.py --json     # machine-readable
    python tools/dev-pipeline/lint_skills.py --commands-dir <path>   # override the dir (tests)

Checks (each violation = a (file, line, rule, evidence) record):
  R1 stale-release   — `build_pianoid_cuda.bat ... --heavy --release` (the documented-stale default;
                       `--heavy --both` is canonical, `--release` alone leaves the debug .pyd stale).
  R2 cmd-c-heavy     — the agent-context-DESTRUCTIVE `cmd //c "...build_pianoid_cuda...--heavy"` form
                       WITHOUT `--both` on the same command (it removes the .pyd before reinstall ->
                       bricks the venv). *** Must NOT flag the LEGITIMATE interactive-human line
                       `env -u VIRTUAL_ENV cmd //c "cd /d PianoidCore && .\\build_pianoid_cuda.bat --heavy --both"`
                       (that's --both, intentionally allowed) — the `--both` discriminator handles this. ***
  R3 dup-block       — (optional, --strict) a normalized multi-line block that appears VERBATIM in >1
                       skill (the inline-duplication heuristic). WARN-only by default (does not fail the
                       build) because a small amount of shared boilerplate is legitimate; --strict makes
                       it a violation.

R1 + R2 are the load-bearing hazard checks and always fail the build on a hit. R3 is advisory.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import defaultdict

# --- repo-root resolution (mirrors the other dev-pipeline scripts) ---------------------------------
_THIS = os.path.abspath(__file__)
_REPO_ROOT = os.environ.get("PIANOID_REPO_ROOT") or os.path.dirname(os.path.dirname(os.path.dirname(_THIS)))
_DEFAULT_COMMANDS_DIR = os.path.join(_REPO_ROOT, ".claude", "commands")

# R1: any build_pianoid_cuda.bat invocation that ends up at `--heavy --release`.
#   matches `--heavy --release` and (defensively) `--release --heavy` near the bat name.
_R1 = re.compile(r"build_pianoid_cuda\.bat[^\n`]*--heavy\s+--release|build_pianoid_cuda\.bat[^\n`]*--release\s+--heavy")

# R2: a `cmd //c` (or `cmd /c`) command that runs build_pianoid_cuda...--heavy.
#   We capture the whole quoted command so we can test it for the `--both` discriminator.
#   The legit line has --both inside the same quotes -> excluded. The destructive form lacks --both.
_R2_CMD = re.compile(r"cmd\s+/{1,2}c\s+\"([^\"]*build_pianoid_cuda[^\"]*)\"")


def _read_lines(path: str) -> list[str]:
    with open(path, "r", encoding="utf-8") as f:
        return f.read().splitlines()


def _list_skill_files(commands_dir: str) -> list[str]:
    if not os.path.isdir(commands_dir):
        return []
    return sorted(
        os.path.join(commands_dir, n)
        for n in os.listdir(commands_dir)
        if n.endswith(".md") and os.path.isfile(os.path.join(commands_dir, n))
    )


def _rel(path: str) -> str:
    try:
        return os.path.relpath(path, _REPO_ROOT).replace("\\", "/")
    except ValueError:
        return path


def _ascii(s: str) -> str:
    """Make a string safe to print on a legacy cp1252 console (Windows default).

    The skills contain en/em dashes, arrows, etc.; printing them crashes under cp1252. The human
    report only needs to be readable, so transliterate the common offenders and drop the rest.
    (The --json path emits the original text; only the human printer is sanitized.)"""
    repl = {"→": "->", "←": "<-", "—": "-", "–": "-",
            "‘": "'", "’": "'", "“": '"', "”": '"', "…": "...", "•": "*"}
    for k, v in repl.items():
        s = s.replace(k, v)
    return s.encode("ascii", "replace").decode("ascii")


def lint_file(path: str) -> list[dict]:
    """Return a list of violation records for one skill file (R1 + R2; R3 handled cross-file)."""
    out: list[dict] = []
    for i, line in enumerate(_read_lines(path), start=1):
        if _R1.search(line):
            out.append({
                "file": _rel(path), "line": i, "rule": "R1-stale-release",
                "evidence": line.strip()[:200],
                "fix": "use `--heavy --both` (see BUILD_SYSTEM.md#canonical-install--rebuild + PROJECT_CONFIG.md#docs-first-build--run)",
            })
        for m in _R2_CMD.finditer(line):
            cmd = m.group(1)
            if "--heavy" in cmd and "--both" not in cmd:
                # destructive: cmd //c ... build...--heavy  with NO --both.
                out.append({
                    "file": _rel(path), "line": i, "rule": "R2-cmd-c-heavy",
                    "evidence": line.strip()[:200],
                    "fix": "in agent context use detached Start-Process (never `cmd //c ... --heavy`); see BUILD_SYSTEM.md#canonical-install--rebuild",
                })
            # else: `cmd //c ... --both` is the legitimate interactive-human form -> NOT a violation.
    return out


def find_duplicate_blocks(files: list[str], window: int = 4, min_nonblank: int = 3) -> list[dict]:
    """R3 (advisory): find substantive prose/command blocks duplicated VERBATIM across >1 skill.

    Heuristic, deliberately conservative — its job is to surface the kind of copy-pasted *prose*
    block that drifts (the docs-first preamble was the canonical example), NOT to flag every shared
    code line. So it:
      - ignores trivial lines (blank, `---`, code fences, headings, table rows / `|...|`, and lines
        inside ```` ``` ```` fenced code) — shared *code* snippets (JS UI helpers, the port-kill loop)
        are NOT the target of this prose-duplication check;
      - requires >= min_nonblank substantive lines in the window;
      - MERGES overlapping/adjacent duplicate windows into ONE finding per (file-set) region, so a
        long shared paragraph is one record, not one-per-line.
    Reports one record per merged region: the file-set, the first occurrence location, and a one-line
    excerpt. Advisory by default (use --strict to fail the build on these).
    """
    trivial = re.compile(r"^\s*(|-{3,}|`{3,}.*|#{1,6}\s.*|\|.*\|)\s*$")  # blank, hr, fence-marker, heading, table row

    def substantive_mask(lines: list[str]) -> list[bool]:
        """True where a line is substantive (not trivial and not inside a fenced code block)."""
        mask, in_fence = [], False
        for ln in lines:
            if re.match(r"^\s*`{3,}", ln):
                in_fence = not in_fence
                mask.append(False)
                continue
            mask.append((not in_fence) and (not trivial.match(ln)))
        return mask

    # block-key -> {file -> first start line}
    seen: dict[str, dict[str, int]] = defaultdict(dict)
    file_lines: dict[str, list[str]] = {}
    for path in files:
        rel = _rel(path)
        lines = _read_lines(path)
        file_lines[rel] = lines
        mask = substantive_mask(lines)
        for start in range(0, max(0, len(lines) - window + 1)):
            block = lines[start:start + window]
            if sum(mask[start:start + window]) < min_nonblank:
                continue
            key = "\n".join(s.rstrip() for s in block)
            if len(key.strip()) < 60:  # require a meaty block (a real paragraph, not a stray line)
                continue
            seen[key].setdefault(rel, start + 1)

    # collect duplicated windows as (frozenset(files), file->line) then MERGE overlapping ones per file-set
    dup_windows = [(frozenset(fm), fm) for key, fm in seen.items() if len(fm) > 1]
    by_set: dict[frozenset, list[dict]] = defaultdict(list)
    for fs, fm in dup_windows:
        # represent each window by its first file's start line (for merge ordering within a set)
        anchor_file = sorted(fm)[0]
        by_set[fs].append({"anchor_file": anchor_file, "anchor_line": fm[anchor_file], "fm": fm})

    out: list[dict] = []
    for fs, wins in by_set.items():
        wins.sort(key=lambda w: (w["anchor_file"], w["anchor_line"]))
        # merge windows whose anchor lines are within `window` of each other (overlapping region)
        merged: list[dict] = []
        for w in wins:
            if merged and w["anchor_file"] == merged[-1]["anchor_file"] and w["anchor_line"] <= merged[-1]["end_line"] + window:
                merged[-1]["end_line"] = max(merged[-1]["end_line"], w["anchor_line"] + window - 1)
            else:
                merged.append({"anchor_file": w["anchor_file"], "anchor_line": w["anchor_line"],
                               "end_line": w["anchor_line"] + window - 1, "fm": w["fm"]})
        for m in merged:
            f0, ln0 = m["anchor_file"], m["anchor_line"]
            excerpt = ""
            for ln in file_lines.get(f0, [])[ln0 - 1:]:
                if ln.strip() and not trivial.match(ln):
                    excerpt = _ascii(ln.strip())[:140]
                    break
            out.append({
                "rule": "R3-dup-block",
                "files": sorted(fs),
                "first_seen": f"{f0}:{ln0}",
                "lines_spanned": m["end_line"] - ln0 + 1,
                "evidence": excerpt,
            })
    out.sort(key=lambda r: (-len(r["files"]), -r["lines_spanned"], r["first_seen"]))
    return out


def run(commands_dir: str, strict: bool) -> dict:
    files = _list_skill_files(commands_dir)
    hard: list[dict] = []
    for path in files:
        hard.extend(lint_file(path))
    dup = find_duplicate_blocks(files)
    # R3 is advisory unless --strict
    violations = list(hard) + ([{**d, "severity": "violation"} for d in dup] if strict else [])
    advisories = [] if strict else [{**d, "severity": "advisory"} for d in dup]
    return {
        "commands_dir": _rel(commands_dir),
        "files_scanned": len(files),
        "violations": violations,
        "advisories": advisories,
        "clean": len(violations) == 0,
    }


def _print_human(result: dict) -> None:
    print(f"lint_skills: scanned {result['files_scanned']} skill file(s) in {result['commands_dir']}")
    viols = result["violations"]
    if not viols:
        nadv = len(result["advisories"])
        print("  CLEAN - no forbidden build forms (R1/R2)" + (f"  [{nadv} R3 advisory region(s)]" if nadv else ""))
    else:
        print(f"  {len(viols)} VIOLATION(S):")
        for v in viols:
            if v["rule"] == "R3-dup-block":
                print(f"    [R3] block (~{v['lines_spanned']} lines) duplicated across {len(v['files'])} files, e.g. {v['first_seen']}: {_ascii(v['evidence'])!r}")
                print(f"         files: {', '.join(v['files'])}")
            else:
                print(f"    [{v['rule']}] {v['file']}:{v['line']}  {_ascii(v['evidence'])!r}")
                print(f"         fix: {_ascii(v['fix'])}")
    for a in result["advisories"]:
        print(f"  (advisory) [R3] ~{a['lines_spanned']}-line block in {len(a['files'])} files, e.g. {a['first_seen']}: {_ascii(a['evidence'])!r}")
        print(f"             files: {', '.join(a['files'])}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Drift guard for .claude/commands/ skills (forbidden build forms + dup blocks).")
    ap.add_argument("--commands-dir", default=_DEFAULT_COMMANDS_DIR, help="skills dir (default: <repo>/.claude/commands)")
    ap.add_argument("--strict", action="store_true", help="treat R3 duplicate-block findings as violations (default: advisory)")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    args = ap.parse_args(argv)

    result = run(args.commands_dir, strict=args.strict)
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        _print_human(result)
    return 0 if result["clean"] else 2


if __name__ == "__main__":
    sys.exit(main())
