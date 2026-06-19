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
- Same-symptom is NOT same-bug: reproducing a bug that shows the SAME SYMPTOM is not the same as
  reproducing the USER'S bug. A plausible look-alike (same observable symptom, e.g. "no notes / can't
  select pitch") reproduced on a DIFFERENT scenario or environment than the user's must NOT be accepted as
  the diagnosis. Confirm the reproduced failure matches the user's ACTUAL error and exact conditions
  (their environment, their steps) — not just the symptom category — before proposing a fix. When the
  user's environment is inaccessible, get their exact error text + exact steps (allowed clarification) and
  reproduce THAT, rather than fixing a same-symptom stand-in.
- Worked failure this rule encodes: a "volume slider doesn't work" report was twice misdiagnosed as a
  soft-limiter issue from a computed `raw_output × mvc` value, without ever measuring the engine's real
  output at different volume settings.
- Worked failure (same-symptom trap): a "cannot select pitch" report was diagnosed from a reload-triggered
  backend-kill bug reproduced on a correctly-built local system — but the user was on a broken-wheel
  system and hadn't reported reloading; the fix addressed the look-alike, not their bug, and was reverted.

### G2 — Check yourself before asking; never ask what you can determine
> "never ask user a question if you can check yourself"

This is the autonomy principle applied to QUESTIONS — the generalization of G1's diagnose-first /
reproduce-yourself stance to ALL user-facing questions, not just diagnoses. Do NOT ask the user
anything you can determine yourself by checking the system.

- **The gate:** before sending ANY question to the user, ask yourself — "can I answer this by checking
  the repo / the installed build / the running stack / the logs / git state / the docs / or by
  reproducing it?" If YES: DO THAT and answer it yourself; do NOT ask.
- **The ONLY questions that legitimately go to the user** are genuine DECISIONS (a design preference,
  which of two valid approaches), APPROVALS (a merge, a destructive action), or INFORMATION ONLY THEY
  HOLD (knowledge that is not in the system — a fact about their intent, an external constraint, a
  preference). Everything else is a check you owe yourself first.
- This extends, and is the parent of, G1 (no-guess-diagnosis) and the generic diagnose-first /
  reproduce-yourself stance: G1 forbids guessing a *diagnosis*; G2 forbids *asking* the user for any
  fact you could check. The family hangs together — reproduce/measure for failures (G1), check-the-
  system for questions (G2).
- Worked example this rule encodes: instead of asking the user "did your test system have the
  consolidation rebuilt?", the correct move was to CHECK the installed wheel/middleware directly —
  grep the installed package for the consolidation marker + the calibration constant, and read the
  wheel's mtime — and answer the question myself. The fact lived in the system; asking the user for it
  was the violation.

## Project-specific (Pianoid)

### P1 — Hand over a clean stack at every handoff
Before EVERY handoff back to the user — finishing a task, going idle awaiting the next instruction,
SETTING UP FOR THE USER TO TEST, or shutdown — bring the environment to full clearance: all project
servers down, all working trees clean, ready for the user to launch a fresh slate.
- "Setting up for the user to test" IS a handoff: prepare/build the code, leave the build installed,
  bring the stack DOWN, and let the user launch their own clean stack. Do NOT hand over a running stack.
- Wire the clearance check into the handoff reflex: any message that returns control to the user and then
  waits triggers a stack-down sweep first.
- The only exception: a concurrent agent is still actively using the stack for its own in-flight work
  (clearance applies at the handoff to the USER, not between overlapping agents).
- Clearance uses the canonical port-scoped sweep — see
  [`PROJECT_CONFIG.md#process-sweep`](../PROJECT_CONFIG.md#process-sweep) — over the project's stack ports
  ([`#ports`](../PROJECT_CONFIG.md#ports)); never blanket-kill node/python.

### P2 — Merge a verified fix to `dev` BEFORE the user tests it
The user tests on the `dev` branch. Merge a verified fix to `dev` BEFORE the user tests it — do NOT keep
it on a feature branch awaiting the user's test. This OVERRIDES the generic
"test-on-feature-branch-first, merge-after-approval" default FOR THIS PROJECT: here the order is
verify (agent, on branch) → merge to `dev` → user tests on `dev` → revert if rejected.
(Rationale: the user's workflow launches/tests on `dev`; a fix sitting on an unmerged feature branch is
invisible to their test — which caused real friction.)
- Corollary (restart-after-merge): After merging a frontend change to `dev`, RESTART the dev server —
  CRA does not reliably hot-reload a git merge, so a server started before the merge serves a stale
  bundle (this caused repeated "fix not showing" confusion). Verify the served bundle/render before
  telling the user it's live.
