"""The tuning-case page of a session record (dev-tuneskill), in the docs/tuning/cases layout: sample_lib.py writes it
next to the record as samples/sessions/<id>.md; a kept one is promoted by copying it to docs/tuning/cases/."""
from __future__ import annotations

import json


def mode_line(rec):
    s = rec.get("mode") or "cooperative"
    if rec.get("operator"):
        s += f" · **Operator:** {rec['operator']} (their own edits, observed)"
    if rec.get("observations"):
        s += f" · **Observations:** {', '.join(rec['observations'])}"
    return s


def step_line(st):
    edits = "; ".join(e.get("label", "") for e in st.get("edits") or [])
    return f"step {st.get('n')}: {edits or '(no edits)'}" + (f" ({', '.join(st['flags'])})" if st.get("flags") else "")


def case_draft(rec):
    """The tuning-case page of a session record, in the docs/tuning/cases layout (promote by copying it there)."""
    def lines(items, fmt=lambda x: f"- {x}"):
        return "\n".join(fmt(i) for i in items) if items else "- (none)"
    def kv(d):
        return "\n".join(f"- {k}: {json.dumps(v, ensure_ascii=False)}" for k, v in (d or {}).items()) or "- (none)"
    return f"""# Tuning case: {rec['description'][:80]}

- **Date:** {rec['recorded_at'][:10]} · **Session record:** `{rec['id']}` · **Verdict:** {rec['verdict']}
- **Preset:** {rec.get('preset') or 'unknown'} · **Pitches:** {rec.get('pitches') or 'unknown'}
- **Mode:** {mode_line(rec)}
- **Evidence:** session record (samples/sessions.jsonl); samples {', '.join(rec.get('samples') or []) or 'none'}
- **Confidence:** measured (one session) unless stated otherwise below

## Goal (the user's words)

{rec['description']}

## Interpreted target

{rec.get('interpretation') or '(not recorded)'}

## Options offered

{lines(rec.get('options_offered') or [])}

## What was done

Chosen: {rec.get('chosen') or '(not recorded)'}

{lines(rec.get('changes') or [])}

The user's own edits (backend history at the time of the record):

{lines(rec.get('user_edits') or [])}

Observed steps (observe mode: the operator's edits from the state journal, before -> after):

{lines([step_line(st) for st in rec.get('observed_steps') or []])}

## Measurements

Before:

{kv(rec.get('before'))}

After:

{kv(rec.get('after'))}

## Verdict and lessons

{lines(rec.get('lessons') or [])}
"""
