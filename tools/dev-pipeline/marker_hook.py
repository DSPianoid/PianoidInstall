#!/usr/bin/env python
"""marker_hook.py — PostToolUse hook that auto-records tool-call markers (minimize-opus Q3 row 8).

STATUS: PROTOTYPE / OPT-IN / NOT REGISTERED in any settings.json. This exists so the "session-level
marker variant" option in the Phase-1 feasibility report is a concrete, testable artifact rather
than a sketch. See the feasibility note in the dev-pipeline README before wiring this into settings.

WHY IT IS NOT THE FULL row-8 HOOK
---------------------------------
The proposal's row 8 wanted a hook that appends `[BASH-CALL]`/`[READ]`/`[MCP-CALL]`/... to the
CURRENT /dev agent's per-agent session log `docs/development/logs/<dev-XXXX>-<ts>.md`. That is NOT
cleanly feasible: a PostToolUse hook's stdin carries the HARNESS subagent id (`agent_id`) — NOT the
`dev-XXXX` id the agent chooses at Step 0 and uses to name its log. No hook event binds those two
identifiers at a deterministic moment, so the hook cannot reliably resolve the per-agent log under
concurrency (the orchestrator routinely runs 3+ /dev + /fn agents at once; "append to the
most-recently-modified log" misattributes markers across agents — worse than a missing marker,
because the controller's per-agent stall detection would read a stalled agent as alive).

WHAT THIS PROTOTYPE DOES INSTEAD (the defensible variant)
---------------------------------------------------------
It writes markers to a SESSION-KEYED file `docs/development/logs/hook-markers/<key>.md`, where
`<key>` = the harness `agent_id` if present (subagent), else `session_id` (top-level). That mapping
IS deterministic and concurrency-safe — each agent/session gets its own file, no cross-attribution.
The cost: the controller currently reads the per-agent dev log, not these files, so making this
USEFUL for stall-detection needs a controller-side change to also consult the session-keyed file
(orchestrator-owned — out of this script's scope). Until that exists, this is a self-contained,
side-effect-only audit trail and a reference implementation of the marker-format-once principle.

SAFETY (mandatory per the brief): additive + non-fatal. ANY error -> silent exit 0 -> the agent
keeps hand-emitting markers exactly as today (current behavior). The hook NEVER blocks a tool call
(PostToolUse cannot block anyway) and NEVER writes outside docs/development/logs/hook-markers/.

Reads the PostToolUse JSON on stdin. Configure (when/if approved) as a PostToolUse hook matching
`Bash|Read|Grep|Glob` and the MCP tools; see README "Phase-1 marker hook (opt-in)".
"""
from __future__ import annotations

import datetime
import json
import os
import re
import sys
from pathlib import Path

# Markers this hook knows how to emit, keyed by tool name. Mirrors dev.md's marker catalogue so the
# format lives in exactly one place (the whole point of row 8).
_TOOL_MARKER = {
    "Bash": "BASH-CALL",
    "Read": "READ",
    "Grep": "GREP",
    "Glob": "GREP",
}


def _iso_utc() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _safe_key(raw: str) -> str:
    """Sanitize an id into a filename-safe key (defends the path join)."""
    key = re.sub(r"[^A-Za-z0-9._-]", "_", raw)[:80]
    return key or "unknown"


def _summarize(tool_name: str, tool_input: dict) -> str:
    """Build the marker line body from the tool input (first ~80 chars, escaped to one line)."""
    if tool_name == "Bash":
        val = str(tool_input.get("command", ""))
        body = val.replace("\n", " ")[:80]
        return f'[BASH-CALL] {_iso_utc()} {body}'
    if tool_name in ("Read",):
        return f'[READ] {_iso_utc()} path={tool_input.get("file_path", "")}'
    if tool_name in ("Grep", "Glob"):
        pat = tool_input.get("pattern", "")
        path = tool_input.get("path", "")
        return f'[GREP] {_iso_utc()} pattern={pat} path={path}'
    if tool_name.startswith("mcp__"):
        # mcp__<server>__<tool>
        parts = tool_name.split("__")
        server = parts[1] if len(parts) > 1 else "?"
        tool = parts[2] if len(parts) > 2 else "?"
        return f'[MCP-CALL] {_iso_utc()} server={server} tool={tool}'
    return ""


def main() -> int:
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            return 0
        data = json.loads(raw)

        tool_name = data.get("tool_name", "")
        tool_input = data.get("tool_input", {}) or {}
        line = _summarize(tool_name, tool_input)
        if not line:
            return 0  # nothing to record for this tool

        # Deterministic, concurrency-safe key: harness subagent id, else session id.
        key = data.get("agent_id") or data.get("session_id") or "unknown"
        key = _safe_key(str(key))

        # Resolve the markers dir under the project. CLAUDE_PROJECT_DIR is the documented project
        # root env var the harness exposes to hook commands; fall back to cwd.
        project_dir = os.environ.get("CLAUDE_PROJECT_DIR") or data.get("cwd") or os.getcwd()
        markers_dir = Path(project_dir) / "docs" / "development" / "logs" / "hook-markers"
        markers_dir.mkdir(parents=True, exist_ok=True)

        agent_type = data.get("agent_type", "")
        out = markers_dir / f"{key}.md"
        with out.open("a", encoding="utf-8") as fh:
            if out.stat().st_size == 0:
                fh.write(f"# Hook markers for {key}"
                         f"{(' (' + agent_type + ')') if agent_type else ''}\n\n")
            fh.write(line + "\n")
    except Exception:  # noqa: BLE001 — additive + non-fatal: never disturb the agent on any error.
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
