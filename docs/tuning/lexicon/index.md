# Operator lexicons

What one operator's words mean as measured changes of the sound, learned in **observe mode** (the operator tunes in
the UI, the assistant follows the edits, renders each step before and after, and records how the operator describes
the result: [Tuning skill, observe](../../guides/TUNING_FOR_ASSISTANT.md#observe)). The assistant reads a lexicon with
`lexicon_get` in the cooperative loop, so that a later vague request ("a bit warmer") is read the way that operator
meant it before, and it says which reading it used.

## Files {#files}

| File | What | Written by |
|---|---|---|
| `<operator>.observations.jsonl` | the evidence: one observation per described step (the words verbatim, the phrase keys, the step's edits, the before / after sample pairs, the trait deltas, the verdict); line format `samples/schema.json` `$defs.observation` | `tools/tuning/sample_lib.py lexicon-export` (copies new lines from the local `samples/observations.jsonl`) |
| `<operator>.md` | the lexicon page, rendered from the evidence | the same command; `--check` fails when it is out of date |

The lexicon itself is **derived** (`tools/tuning/lexicon.py build`) on every read, from the versioned evidence plus
the observations on the machine that are not exported yet; nothing stores a second copy of it.

## How a meaning is derived {#derivation}

| Step | Rule |
|---|---|
| a pair | one pitch x velocity of the step: the after-sample (tags `obs-<id>`, `step-<n>`) against the same pitch and velocity at the latest earlier step; excluded when there is none or the render settings differ |
| traits | b minus a from the two characteristics cards: centroid attack / body (%), roll-off (dB/oct), partials 1-3 / 4-8 / 9-12 (dB re the strongest), T60 100-500 Hz / 500-2000 Hz / 2-8 kHz (%), attack rise (%), cloud (dB), thump excess (dB), inharmonicity B (%), pitch (cents), beating depth (dB) |
| a step | the median of each trait over its comparable pairs: one step counts once |
| phrases | the operator's words split at punctuation and conjunctions (but, and, но, и, а, ...), lower-cased, intensifiers (a bit, slightly, чуть, немного, ...) removed; "too" is kept. A phrase is read as describing the change the step caused |
| a direction | 3 of 4 observations (75 %) beyond the trait's threshold the same way; the range is that of the agreeing ones |
| unchanged | the trait stayed inside its threshold in 75 % of 2 or more observations |
| contradiction | both signs at 25 % or more of the observations |
| confidence | by the count only: 1 single observation, 2-3 low, 4-7 medium, 8+ high |

Thresholds for "changed" (centroid 3 %, roll-off 0.5 dB/oct, partial groups 1 dB, T60 5 %, attack 10 %, cloud /
thump / beating 1 dB, B 5 %, pitch 1 cent) are **conventions**, not measured noise floors of the extractor; the
offline render itself repeats to about 2e-4 relative. Not learned from: a step flagged `contaminated` (an edit landed
while its renders ran) and a step with no comparable pair.

## Example (illustrative format, synthetic numbers) {#example}

Four observed steps where the operator said "warmer" (two with hammer_width up, one dispersion_damping up, one
mode decrement down in 1-2 kHz), C4 and G4 at v95:

| Phrase | n | Confidence | Means (range, agreeing / n) | Unchanged | Contradictions |
|---|---|---|---|---|---|
| warmer | 4 | medium | spectral centroid 100-400 ms -20..-12 % (4/4); partials 4-8 -6..-3.5 dB (4/4) | attack_rise_pct | - |
| too woody | 1 | single observation | partials 1-3 +3 dB (1/1) | - | - |

In the loop the assistant then says: "By your lexicon, warmer = centroid -12..-20 % with partials 4-8 down 3.5-6 dB,
attack unchanged (4 of 4 observations). I will read the centroid and partials 4-8 of C4."

## Operators {#operators}

No operator lexicon is versioned yet. Add each exported page here: `- [<operator>](<operator>.md)`.
