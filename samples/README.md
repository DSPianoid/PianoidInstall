# Sound-sample library (local, git-ignored)

This folder holds the sound samples the tuning work refers to (renders, mic recordings, real-piano references)
and their extracted characteristics. Only this README and `schema.json` are tracked; everything else is local
to the machine (`.gitignore` rule `/samples/*`).

| Path | What |
|---|---|
| `audio/<id>.wav` | the sample, copied in by the CLI (never moved, never edited) |
| `manifest.jsonl` | one JSON record per line (`schema.json`), append-only; the LAST record of an id wins |
| `sessions.jsonl` | tuning-session records: the user's description, the options offered, what was chosen, the measured result |
| `sessions/<id>.md` | the case draft of each session, in the layout of `docs/tuning/cases/` (promote by copying it there) |
| `observations.jsonl` | observe mode: one line per described step (the operator's words, the step's edits, the before / after pairs, the trait deltas; `schema.json` `$defs.observation`); exported into `docs/tuning/lexicon/` with `lexicon-export` |

**The one writer** is `tools/tuning/sample_lib.py` (the canonical venv python, CPU only, below-normal priority).
The in-UI assistant reaches it through its `samples_add` / `samples_list` / `samples_get` / `samples_compare` /
`tuning_record` / `observe_describe` / `lexicon_get` tools; dev agents call the CLI. Nothing else writes here.

```
PianoidCore\.venv\Scripts\python tools\tuning\sample_lib.py add --file X.wav --source render --preset P --pitch 60 --velocity 95 --settings "{\"order\": 2}" --tags a,b --origin a-...
PianoidCore\.venv\Scripts\python tools\tuning\sample_lib.py list --preset Belarus --pitch 60
PianoidCore\.venv\Scripts\python tools\tuning\sample_lib.py compare --a <id> --b <id>
PianoidCore\.venv\Scripts\python tools\tuning\sample_lib.py stats
PianoidCore\.venv\Scripts\python tools\tuning\sample_lib.py lexicon --operator leonid --phrase "warmer"
PianoidCore\.venv\Scripts\python tools\tuning\sample_lib.py lexicon-export --operator leonid
```

Why JSONL and not SQLite: append-only, diffable, readable by Python and Node without a dependency, the same
form as the assistant's audit log; the library is hundreds of files, not millions. A torn line is skipped, never
fatal.

Root: `--root`, else `$PIANOID_SAMPLES_DIR`, else this folder. The characteristics and how to read them:
[`docs/guides/TUNING_FOR_ASSISTANT.md#measure`](../docs/guides/TUNING_FOR_ASSISTANT.md#measure).
