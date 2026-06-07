"""Shared helpers for the dev-pipeline bookkeeping scripts.

These scripts automate the deterministic, zero-judgment bookkeeping steps of the `/dev`
workflow (`.claude/commands/dev.md`) — Step 0 scaffold, Step 10a Phase-2 wrap, the port-scoped
env sweep, and the orchestrator's Phase-1 verification. They exist to collapse several Opus
reasoning turns into one scripted call (see
`docs/proposals/minimize-opus-calls-dev-pipeline-2026-06-06.md`, Q3 rows 1/2/3/9).

Design rules (from the proposal §2.1 "what makes an op safely scriptable"):
- Deterministic: same inputs -> same output, no interpretation.
- No branch-on-meaning: these scripts do plumbing only; every workflow decision stays with Opus.
- Loud, local failure: on any inconsistency they raise / exit non-zero with a clear message and
  NEVER silently corrupt registry state.

Stdlib-only. Invoked by absolute path (the dir name contains a hyphen, so this is not an
importable package); the test suite imports these modules via `sys.path` insertion.
"""
from __future__ import annotations

import datetime
import os
import re
import secrets
import subprocess
from pathlib import Path

# --------------------------------------------------------------------------------------------------
# Repo-root discovery
# --------------------------------------------------------------------------------------------------
# The repo root differs per machine (Windows D:\repos\PianoidInstall, Linux /media/.../PianoidInstall
# — see .claude/CLAUDE.md "Repository Roots"). We never hard-code it. This module sits at
# <root>/tools/dev-pipeline/common.py, so the root is two parents up; we also confirm via a marker
# file so a copied script can't write to the wrong tree.
_ROOT_MARKERS = ("docs", ".claude")


def repo_root(start: Path | None = None) -> Path:
    """Return the PianoidInstall repo root.

    Resolution order:
    1. The PIANOID_REPO_ROOT env var, if set (lets tests point at a throwaway tree).
    2. Walk upward from this file (or `start`) until a directory containing all _ROOT_MARKERS
       is found.

    Raises FileNotFoundError if no marker directory is found (loud failure, never a guess).
    """
    env = os.environ.get("PIANOID_REPO_ROOT")
    if env:
        p = Path(env).resolve()
        if not p.is_dir():
            raise FileNotFoundError(f"PIANOID_REPO_ROOT={env!r} is not a directory")
        return p

    here = (start or Path(__file__)).resolve()
    for candidate in (here, *here.parents):
        if candidate.is_dir() and all((candidate / m).is_dir() for m in _ROOT_MARKERS):
            return candidate
    raise FileNotFoundError(
        f"Could not locate repo root (no ancestor of {here} contains {_ROOT_MARKERS})"
    )


# Canonical registry paths, relative to the repo root.
WIP_REL = "docs/development/WORK_IN_PROGRESS.md"
LOCKS_REL = "docs/development/MODULE_LOCKS.md"
LOGS_REL = "docs/development/logs"
LOGS_ARCHIVE_REL = "docs/development/logs/archive"
PROPOSALS_REL = "docs/proposals"
PROPOSALS_ARCHIVE_REL = "docs/proposals/archive"


def wip_path(root: Path) -> Path:
    return root / WIP_REL


def locks_path(root: Path) -> Path:
    return root / LOCKS_REL


# --------------------------------------------------------------------------------------------------
# Identifiers & timestamps (match dev.md Step 0 exactly)
# --------------------------------------------------------------------------------------------------
def generate_agent_id() -> str:
    """`dev-<4 hex>` — the dev.md form `dev-$(openssl rand -hex 2)` (2 bytes = 4 hex chars)."""
    return f"dev-{secrets.token_hex(2)}"


_AGENT_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]*$")


def validate_agent_id(agent_id: str) -> str:
    """Reject anything that isn't a plausible agent ID (defends the registry-edit regexes)."""
    if not agent_id or not _AGENT_ID_RE.match(agent_id):
        raise ValueError(f"invalid agent id: {agent_id!r}")
    return agent_id


def iso_utc(now: datetime.datetime | None = None) -> str:
    """ISO-8601 UTC like `2026-05-05T12:30:22Z` (dev.md step-heading + marker timestamp form)."""
    dt = now or datetime.datetime.now(datetime.timezone.utc)
    return dt.astimezone(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log_stamp(now: datetime.datetime | None = None) -> str:
    """`YYYY-MM-DD-HHMMSS` for the log filename (dev.md `date +%Y-%m-%d-%H%M%S`)."""
    dt = now or datetime.datetime.now(datetime.timezone.utc)
    return dt.astimezone(datetime.timezone.utc).strftime("%Y-%m-%d-%H%M%S")


def date_stamp(now: datetime.datetime | None = None) -> str:
    """`YYYY-MM-DD` for the WIP row `Started` column."""
    dt = now or datetime.datetime.now(datetime.timezone.utc)
    return dt.astimezone(datetime.timezone.utc).strftime("%Y-%m-%d")


# --------------------------------------------------------------------------------------------------
# Git plumbing (deterministic; raises on failure)
# --------------------------------------------------------------------------------------------------
def run_git(args: list[str], cwd: Path, check: bool = True) -> subprocess.CompletedProcess:
    """Run `git <args>` in `cwd`, capturing text output. Raises on non-zero when check=True."""
    proc = subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        capture_output=True,
        text=True,
    )
    if check and proc.returncode != 0:
        raise RuntimeError(
            f"git {' '.join(args)} failed (exit {proc.returncode}) in {cwd}:\n{proc.stderr.strip()}"
        )
    return proc


def git_mv(root: Path, src_rel: str, dst_rel: str) -> None:
    """`git mv src dst`, creating the destination directory first (git mv needs it to exist)."""
    dst_dir = (root / dst_rel).parent
    dst_dir.mkdir(parents=True, exist_ok=True)
    run_git(["mv", src_rel, dst_rel], cwd=root)


# --------------------------------------------------------------------------------------------------
# WIP "Active Dev Sessions" table editing
# --------------------------------------------------------------------------------------------------
# The table lives under a `## Active Dev Sessions` heading with this exact 5-column shape
# (dev.md Step 0 "Register in WIP"):
#     | Agent | Task | Log | Started | Status |
#     |-------|------|-----|---------|--------|
#     | dev-a3f1 | <task> | [log](logs/dev-a3f1-...md) | 2026-04-10 | <status> |
_WIP_HEADING = "## Active Dev Sessions"


def _escape_table_cell(text: str) -> str:
    """Make a free-text task description safe for a single markdown table cell.

    Pipes would split the cell; newlines would break the row. Collapse whitespace and escape pipes.
    """
    collapsed = " ".join(text.split())
    return collapsed.replace("|", "\\|")


def build_wip_row(agent_id: str, task: str, log_rel_to_dev: str, started: str,
                  status: str = "In Progress") -> str:
    """One `| ... |` Active-Dev-Sessions row.

    `log_rel_to_dev` is the log path relative to docs/development/ (e.g.
    `logs/dev-a3f1-2026-04-10-143022.md`) so the markdown link resolves from WORK_IN_PROGRESS.md.
    """
    cell_task = _escape_table_cell(task)
    cell_status = _escape_table_cell(status)
    return f"| {agent_id} | {cell_task} | [log]({log_rel_to_dev}) | {started} | {cell_status} |"


def _find_wip_table_bounds(lines: list[str]) -> tuple[int, int, int]:
    """Locate the Active-Dev-Sessions table.

    Returns (heading_idx, separator_idx, first_data_idx) — separator_idx is the `|---|` line,
    first_data_idx is the line just after it (where rows begin / a new row is inserted).
    Raises ValueError if the heading or its table header/separator can't be found.
    """
    heading_idx = None
    for i, line in enumerate(lines):
        if line.strip() == _WIP_HEADING:
            heading_idx = i
            break
    if heading_idx is None:
        raise ValueError(f"'{_WIP_HEADING}' heading not found in WIP file")

    # The header row + separator are the next two non-blank table lines after the heading.
    header_idx = None
    for i in range(heading_idx + 1, len(lines)):
        s = lines[i].strip()
        if not s:
            continue
        if s.startswith("|") and "Agent" in s:
            header_idx = i
            break
        # A non-table line before the header means the table is malformed/missing.
        if not s.startswith("|") and not s.startswith("<!--"):
            break
    if header_idx is None:
        raise ValueError("Active-Dev-Sessions table header row not found under heading")

    sep_idx = header_idx + 1
    if sep_idx >= len(lines) or not lines[sep_idx].strip().startswith("|"):
        raise ValueError("Active-Dev-Sessions table separator row not found")
    return heading_idx, sep_idx, sep_idx + 1


def insert_wip_row(content: str, row: str) -> str:
    """Insert a new data row directly below the table separator (top of the row list).

    dev.md says "Append rows for new agents; do not replace existing entries" — inserting at the
    top of the data block satisfies that (existing rows are preserved) and keeps the newest session
    most visible. Returns the new file content.
    """
    lines = content.splitlines()
    _, _, first_data_idx = _find_wip_table_bounds(lines)
    lines.insert(first_data_idx, row)
    return _rejoin(content, lines)


def remove_wip_row(content: str, agent_id: str) -> tuple[str, int]:
    """Remove the Active-Dev-Sessions data row(s) whose Agent cell is exactly `agent_id`.

    Matches the first table cell against the agent id, tolerant of `~~strikethrough~~`/`**bold**`
    markdown that paused/active rows use. Returns (new_content, n_removed). Does NOT touch HTML
    comments (released-lock history) or placeholder rows. n_removed==0 is reported to the caller,
    which decides whether that's an error (it is, for a wrap).
    """
    validate_agent_id(agent_id)
    lines = content.splitlines()
    heading_idx, sep_idx, _ = _find_wip_table_bounds(lines)

    kept: list[str] = []
    removed = 0
    for i, line in enumerate(lines):
        if i > sep_idx and _row_agent_matches(line, agent_id):
            removed += 1
            continue
        kept.append(line)
    return _rejoin(content, kept), removed


def _row_agent_matches(line: str, agent_id: str) -> bool:
    """True if `line` is a markdown table data row whose first cell names `agent_id`."""
    s = line.strip()
    if not s.startswith("|") or s.startswith("|--"):
        return False
    cells = [c.strip() for c in s.strip("|").split("|")]
    if not cells:
        return False
    first = cells[0]
    # Strip markdown emphasis the row formats use for paused/active rows.
    first = first.replace("~~", "").replace("**", "").strip()
    return first == agent_id


def _rejoin(original: str, lines: list[str]) -> str:
    """Re-join lines, preserving whether the original file ended with a trailing newline."""
    text = "\n".join(lines)
    if original.endswith("\n"):
        text += "\n"
    return text


def wip_has_agent_row(content: str, agent_id: str) -> bool:
    """True if the Active-Dev-Sessions table has a (non-comment) data row for `agent_id`."""
    validate_agent_id(agent_id)
    try:
        lines = content.splitlines()
        _, sep_idx, _ = _find_wip_table_bounds(lines)
    except ValueError:
        return False
    return any(_row_agent_matches(line, agent_id)
               for i, line in enumerate(lines) if i > sep_idx)


# --------------------------------------------------------------------------------------------------
# MODULE_LOCKS.md inspection (read-only here; lock edits stay with the agent/Opus per proposal §2.3)
# --------------------------------------------------------------------------------------------------
def locks_held_by(content: str, agent_id: str) -> bool:
    """True if `agent_id` appears in an ACTIVE (non-comment) lock row.

    The lock table uses `| Agent | Files | Locked At | Task |`. Released locks are recorded as HTML
    comments (`<!-- dev-xxxx locks RELEASED ... -->`) and placeholder rows like
    `| <!-- (none) --> | | | |`; those must NOT count as held. We therefore consider only lines
    that are table rows AND are not inside an HTML comment.
    """
    validate_agent_id(agent_id)
    for line in _non_comment_lines(content):
        s = line.strip()
        if not s.startswith("|") or s.startswith("|--"):
            continue
        cells = [c.strip() for c in s.strip("|").split("|")]
        if not cells:
            continue
        first = cells[0]
        if first.startswith("<!--"):
            continue
        # First cell may be `dev-xxxx` or a backticked/space-joined list — match on word boundary.
        if re.search(rf"(^|[^\w-]){re.escape(agent_id)}([^\w-]|$)", first):
            return True
    return False


def _non_comment_lines(content: str):
    """Yield lines with HTML-comment blocks (`<!-- ... -->`, possibly multi-line) stripped out.

    A lock row that is entirely inside a `<!-- ... -->` block is historical and must be ignored.
    We track comment depth across lines; any line that opens but doesn't close a comment, or sits
    inside one, is suppressed.
    """
    in_comment = False
    for raw in content.splitlines():
        line = raw
        if in_comment:
            end = line.find("-->")
            if end == -1:
                continue  # whole line still inside the comment
            line = line[end + 3:]
            in_comment = False
        # Strip any complete `<!-- ... -->` spans on this line, then detect a dangling open.
        while True:
            start = line.find("<!--")
            if start == -1:
                break
            end = line.find("-->", start + 4)
            if end == -1:
                line = line[:start]
                in_comment = True
                break
            line = line[:start] + line[end + 3:]
        yield line
