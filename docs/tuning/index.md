# Tuning knowledge base

What the Pianoid parameters do to the sound, and what has been tried, kept and rejected. Written by people and dev
agents from measured sessions; read by the in-UI assistant with `read_docs` (procedure:
[Tuning skill](../guides/TUNING_FOR_ASSISTANT.md)).

| Part | Where | Form |
|---|---|---|
| Parameter-effect map | [`knowledge/PARAMETER_EFFECTS.md`](knowledge/PARAMETER_EFFECTS.md) (rendered) / `knowledge/parameter_effects.json` (SSOT) | parameter -> aspect -> direction, magnitude, register, side effects, confidence, source |
| Tuning cases | [`cases/`](cases/index.md) | one file per finished case: goal in the user's words, target, preset before / after, changes, measurements, verdict, lessons |
| Session records (not versioned) | `samples/sessions.jsonl` + `samples/sessions/<id>.md` drafts | written by `tuning_record`; the raw material of new cases |
| Sample library (not versioned) | `samples/` ([README](../../samples/README.md)) | renders, mic recordings, references with their characteristics |

## Maintaining it

- **Add a lever:** append an entry to `knowledge/parameter_effects.json` (every field; `confidence` with its source),
  run `PianoidCore\.venv\Scripts\python tools\tuning\render_knowledge.py`, commit both files. The assistant test
  suite fails when the md is out of sync (`render_knowledge.py --check`) or an entry lacks a field.
- **Promote a session to a case:** copy `samples/sessions/<id>.md` into `cases/<date>-<slug>.md`, fill the headings
  that the record left thin (preset before / after, the numbers), add it to [`cases/index.md`](cases/index.md), and
  add or update the map entries its lessons support (with the case as the source).
- **Confidence:** `measured` = a number from this engine with its source; `literature` = physics or the engine docs;
  `anecdotal` = one listening session or a user statement; `unknown` = stated as unknown. Never upgrade a confidence
  without a new measurement; a rejected option stays recorded with its numbers.
