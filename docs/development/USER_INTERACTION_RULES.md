# User Interaction Rules

Operating rules for how an agent (orchestrator or sub-agent) interacts with the user. Two scopes:
**Generic** (project-agnostic — should be lifted into the machine-global generic core `~/.claude/CLAUDE.md`
and distributed via `~/claude-config` + `/self-update`) and **Project-specific (Pianoid)**.

This file is the home for behavioral interaction rules. Add new rules here as they are established;
do not scatter them across auto-memory.

## Generic (project-agnostic)

### G1 — No guessed diagnoses; reproduce + measure before any fix
When the user reports a bug:
- If you have a hypothesis that the symptom may relate to the user's own behavior or usage, you MAY ask
  the user for clarification about their experience (what they did, what they observed). Asking is allowed.
- You MUST NOT make a diagnosis, or propose/implement a fix, based on a guess — or on inference from a
  proxy measurement.
- A fix may be proposed ONLY after you have (a) reproduced the user's EXACT experience on the surface the
  user actually observes, and (b) MEASURED the real failing behavior at root cause.
- Validating a PROXY is not reproducing the user's experience. An engine setter, an offline render, or a
  value you computed yourself ("what the output *should* be") are proxies. Measure the real path the user
  exercises (e.g. realtime audio, the actual UI control the user drags) and read the engine's ACTUAL
  output — never a number you derived by assuming the system behaves as expected.
- Worked failure this rule encodes: a "volume slider doesn't work" report was twice misdiagnosed as a
  soft-limiter issue from a computed `raw_output × mvc` value, without ever measuring the engine's real
  output at different volume settings.

### G2 — Hand over a clean stack at every handoff
Before EVERY handoff back to the user — finishing a task, going idle awaiting the next instruction,
SETTING UP FOR THE USER TO TEST, or shutdown — bring the environment to full clearance: all project
servers down, all working trees clean, ready for the user to launch a fresh slate.
- "Setting up for the user to test" IS a handoff: prepare/build the code, leave the build installed,
  bring the stack DOWN, and let the user launch their own clean stack. Do NOT hand over a running stack.
- Wire the clearance check into the handoff reflex: any message that returns control to the user and then
  waits triggers a stack-down sweep first.
- The only exception: a concurrent agent is still actively using the stack for its own in-flight work
  (clearance applies at the handoff to the USER, not between overlapping agents).

## Project-specific (Pianoid)

Collect Pianoid-specific interaction rules here as they arise. Clearance (G2) uses the canonical
port-scoped sweep — see [`PROJECT_CONFIG.md#process-sweep`](../PROJECT_CONFIG.md#process-sweep) — over the
project's stack ports ([`#ports`](../PROJECT_CONFIG.md#ports)); never blanket-kill node/python.

_(No project-specific interaction rules recorded yet beyond the above.)_
