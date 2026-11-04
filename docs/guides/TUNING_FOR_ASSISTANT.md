# Tuning Skill (sound tuning with the user, for the assistant)

**Audience:** the in-UI Pianoid assistant, whenever the user asks for a change in the sound ("warmer", "less harsh",
"more thump", "C4 sounds thin", "make it like the recording") or asks what a parameter does, on any installation.
**Source:** the Belarus piano fit and the measurement sessions of 25 Oct to 4 Nov 2026 (the assistant's own notes
and reports, the dev-team's measurements), condensed into a procedure, a vocabulary and a knowledge base. The
numbers quoted here are *examples from one instrument and one board*; the knowledge base carries each one with its
source and confidence.

Read with `read_docs` (page `guides/TUNING_FOR_ASSISTANT.md`). Anchors: `hard-rules`, `loop`, `vocabulary`,
`levers`, `measure`, `knowledge`, `samples`, `record`, `observe`, `limits`.

Two modes: **cooperative** (the [loop](#loop): the user asks, you measure, offer and apply) and **observe** (the
operator tunes in the UI by hand, you watch, measure each step and learn what their words mean: [observe](#observe)).
What you learn in observe mode comes back in the cooperative loop as the operator's own lexicon.

## Hard rules: nothing here relaxes them {#hard-rules}

These hold in every mode: Autonomous, Always allow, an approved plan.

**The user's presets and work**

- Never overwrite the user's presets. Save your work to a NEW file in presets/ (`<name>_assistant_<n>.json`) and keep
  saving to that one; say which file holds the result. `preset.promote` is never a way to "finish".
- Do not load, switch or reload a preset to suit a test without asking: the live working copy can hold edits that
  are in no file. Spawn a working copy or render offline instead.
- Leave the slider, feedback, routing and sustain as found, or restore them and confirm. On the Tuning18 family the
  user sets the deck feedback (1000-15000) themselves: a value such as 1797 or 10000 is intentional, never a fault.

**Level**

- Never raise the live level without asking. "Make it louder" is a request for the slider or the level anchor the
  user controls; propose the number, do not apply it unasked. The limit is clipping: the host reverts a write that
  clips, and a sample above full scale hard-clips at the rail (nothing turns it down).
- After any full preset load the output_scale can be re-derived by 10 dB or more: before a note plays live, drop the
  slider and start quiet. Treat a hand-edited or composed preset as unverified at live level.
- Never trigger an offline calibration in a live backend.

**Parameters**

- String edits are checked against the CFL (Courant) bound by the host and undone when they break it: a refused
  write returns the pitch and the Courant number; choose a value further from the limit (lower tension, lower
  stiffness, longer string) and say so. Negative stiffness is never an option (A2 jung -2.4e12 went unstable with
  no note played).
- Masks are mutes: never write zeros into raw feedin / feedback rows to silence something.
- One change at a time, measured before and after. A change the user cannot hear or you cannot measure is not a
  result; undo it (history undo) rather than leave it in.
- Inert controls are not offered: hammer_sharpness (under 0.1 dB in two sessions), hammer_width below the grid
  quantum, the feedback mask in a single-deck matrix, mode damping for a per-key loudness jump.

**Honesty**

- State only what you measured; label a placeholder as a placeholder (a gap mode with no measured evidence is a fit,
  not a finding). Record rejections with their numbers: they are half the value of the knowledge base.
- A render is not the sound: kernel, board, speakers and mic differ. Say which surface a number comes from.

## The cooperative loop {#loop}

Tuning is a conversation. Each round is short and ends in a measured, recorded step.

1. **Hear the request in the user's words**, then map it to measurable traits: first with **their own lexicon**
   (`lexicon_get {operator, phrase: their words}`, learned in [observe mode](#observe)), else with the generic
   [vocabulary](#vocabulary). State the mapping back in one line and say which one you used: "by your lexicon,
   warmer = centroid -10..-20 % and partials 4-8 down 3-6 dB, attack unchanged (4 of 4 observations); I will read
   the centroid and partials 4-8 of C4", or "no entry for 'singing' in your lexicon yet; generically that is a long
   sustain of the top partials".
2. **Ask at most one or two targeted questions**, only where the mapping forks: which key(s) or register; attack or
   sustain; compared with what (another preset, a recording, memory); live on the board or in a render. Never ask for
   a value you can read with a tool (the active parameter, the preset, the settings).
3. **Measure the starting point** on the surface that observes the trait ([measure](#measure)): an `export: true`
   render of the key(s) at the user's velocity, `samples_add` it, read the card. If a reference exists in the library
   (`samples_list`, source `reference`), `samples_compare` against it and name the biggest difference.
4. **Consult the knowledge base** ([knowledge](#knowledge)): the aspect's entries give the levers, their direction,
   a typical magnitude, the register dependence and the side effects. Prefer per-key levers (strike point, pulses,
   feedin, detuning) before global ones (mode mass, decrement); prefer the lever with measured confidence.
5. **Offer 2-3 concrete options**, each with the expected effect, its size, and its risk / side effect, e.g.
   - "hammer_width 0.030 -> 0.038 on G4: centroid down, 8-12 kHz back; risk none, but the step is quantised";
   - "dispersion_damping 8e-15 -> 4e-15 on C4: the top rings longer and brighter; risk: partials 15-20 ring up to
     14 dB over a piano at 2e-15, so stop at 4-5e-15";
   - "copy C4's pulse set to G4: fills the partial hump; risk: the thump lead on G4 drops".
   Say what you would measure to judge each. Let the user choose; apply only with their approval through the normal
   command and approval system (a confirm, Autonomous mode or an approved plan: the host decides, you never
   bypass it).
6. **Apply ONE option**, render again, `samples_add` the after-sample, `samples_compare` before / after (and against
   the reference), then play it to the user if they want to hear it (live level rules above).
7. **Judge together.** Scores guide; the user's listening decides. Keep or undo (history undo, or the activity's Undo).
   A change that scores better but sounds worse is undone and recorded as rejected.
8. **Record** the round with `tuning_record` ([record](#record)): the request in the user's words, your interpretation,
   the options, what was chosen (or what the user did themselves: the host attaches the backend undo history), the
   before / after numbers, the sample ids, the verdict, the lesson. Then the next round.

When the user tunes by hand and asks you only to watch, switch to [observe mode](#observe): it measures before /
after and records their steps and words; that is how their own successful moves and their vocabulary enter the
knowledge base.

## Vocabulary: words to traits {#vocabulary}

Map first, then confirm the mapping in one line. The trait names are the fields of the characteristics card
([measure](#measure)). Register matters: ask which key when the request has none.

**The operator's lexicon comes first.** `lexicon_get {operator, phrase}` returns the entries their request uses
(exact phrases, then near ones sharing a word). Use an entry by its confidence: `single observation` = a hint only,
say so and confirm with the operator; `low` (2-3) = a likely reading, confirm in the same line; `medium` / `high` =
use it and name it. An entry with **contradictions** on a trait is ambiguous on that trait: ask which they mean.
When their lexicon and the table below disagree, theirs wins for them, and you say that it differs. No entry: the
table, and note the word for observe mode.

| The user says | Measurable trait (card field) | Typical levers (see the knowledge base for direction and risk) |
|---|---|---|
| bright, sharp, glassy / dull, muffled, dark | `spectrum.centroid_attack_hz`, `centroid_body_hz`, `rolloff_db_per_oct` | hammer_width, gauss pulse width (sigma), dispersion_damping, sound_derivative_order (a settings change: ask), bow string loss / force |
| thin, hollow / full, round, warm | `partials[]` levels 1-3 vs 4-12; a hole = one partial far down | hammer_position (L/n null), gauss pulse timing, feedin of the body modes near the fundamental, mode mass in that band |
| boomy, muddy, tubby | `band_time_db` 100-500 Hz body / mid rows high; long `decay` T60 in 100-500 Hz | mode decrement in that band, mode mass, radiance of the low modes, thump excess |
| harsh, edgy, buzzy | flat `rolloff_db_per_oct`, high `cloud_db` (noise between partials), high `crest_factor`; on a bowed note multi-slip | small pulse level, per-key feedin of the carrier modes, dispersion_damping, bow string loss (bow), order 1 instead of 2 (settings) |
| metallic, tinny / dead, dull top | `pitch.inharmonicity_B` (high = metallic), partials 8-12 level | string stiffness (jung), radius; retune afterwards |
| short / long sustain, dies too fast, rings on | `decay[]` T60 per band, the tail of `band_time_db` | string gamma (broadband), dispersion_damping (top), mode decrement (body band), deck feedback (late decay), pedal |
| thump, knock, click at the start | `thump.excess_db`, `thump.lead_ms` | thump enabled / gain / trim_db (presets with a thump string), thump pulse mu / sigma |
| hard / soft attack, too slow, too sharp | `attack.rise_10_90_ms`, `attack.peak_time_ms`, `crest_factor`, `band_time_db` attack row | gauss pulse timing and the first spike, hammer mass / speed (level), hammer_position |
| rattle, hiss, dirt, noise | `cloud_db` 4-14 kHz, HF rows of `band_time_db` not tied to partials | engine defects first (block comb, the order-2 layer: not tunable), then per-key feedin of the carrier modes, small pulse |
| beating, wobble, chorus, "fast first decay" | `beating.depth_db`, `beating.modulation_hz`; a first decay faster than the tail | string detuning (tension_offset of the unisons) |
| out of tune, flat / sharp | `pitch.tuning_cents` | string tension (small steps), length; check stability_ratio after a raise |
| too loud / quiet on one key, uneven keyboard | relative level per key (live stats or raw render stats; never from a WAV) | hammer_mass per pitch, excitation leveling; NOT mode damping |
| like the recording / like the other preset | `samples_compare`: band-time RMS, partial RMS, cloud RMS, T60 ratios | the biggest term of the comparison first |

Russian requests arrive too (the voice input): ярче / тусклее, резко / мягко, гудит, звенит, короткий / длинный
звук, стук, дребезг, биения, расстроен. Same traits.

## Levers at a glance {#levers}

The full map with magnitudes, registers, side effects and sources is the knowledge base
([knowledge](#knowledge)). The shape of it:

| Family | Levers | Scope | Verify with |
|---|---|---|---|
| String physics | tension, length (pitch); jung, r (inharmonicity, CFL); gamma (broadband decay); dispersion_damping (top decay); detuning (beating); damper_string / damper_tail (release) | per pitch | pitch, B, T60 per band, beating |
| Hammer and excitation | hammer_position (partial holes), hammer_width (top, quantised), gauss pulses (attack, partial balance, cloud), hammer_mass / hammer_speeds (level) | per pitch (pulses per velocity level) | partials, centroid, attack, cloud |
| Thump | enabled, gain, trim_db | global, trim per key | thump excess and lead |
| Soundboard modes | frequency, decrement, mass_inv, radiance | SHARED across keys | band-time body rows, T60 of the band, every key that uses the mode |
| Coupling | feedin / feedback rows, masks | per pitch x mode | the key alone, then its neighbours |
| Runtime and settings | slider, deck feedback (louder when lower), order, iterations, pedal | global; settings are a full reload | level, late decay, HF |
| Bow (bowed pitches) | string loss factor, force, angle, speed | per register | centroid, roll-off, slips per period |

Two rules from the fit: look for the cause outside the obvious parameter (decay was beating, G4's attack was pulse
timing, the thump's lead was the tone building later), and run a cheap one-change test before reasoning further.
Coupled levers cost elsewhere: shared modes, impulse normalisation (removing a pulse component redistributes
energy), stiffness against the numerical layer. Note what got worse with every gain.

## Measuring: before, after, against {#measure}

The surface decides what a number means:

| Surface | How | Reads |
|---|---|---|
| Offline render | `render.note_playback` / `render.chart` with `export: true`, then `samples_add` | everything in the card; level only as the RAW stats of the render (the WAV is peak-normalised) |
| Live board / speakers at the mic | `play.keyboard` with mic capture, or a `modal.rig_record` of the room while the user plays | what the user hears in the room; mic level per note; path gain changes day to day (validate with a reference tone first) |
| Real instrument | a reference recording in the library (source `reference`) | the target |

The characteristics card (`samples_get`, extracted by `tools/tuning/characteristics.py` on the CPU):

| Field | What | Read it as |
|---|---|---|
| `pitch.f0_hz`, `tuning_cents`, `inharmonicity_B` | harmonic-comb f0 refined by the partial fit; B from (f_k/k)^2 against k^2 | cents against the played key; B 1e-4 (bass) to 1e-3 (treble) on a piano |
| `partials[]` | first 12 partials, level re the strongest | a hole = one partial 10+ dB under its neighbours |
| `spectrum.centroid_attack_hz` (0-30 ms), `centroid_body_hz` (100-400 ms), `rolloff_db_per_oct` | brightness and tilt | compare the same key only |
| `decay[]` | T60 per band from the band envelope (valid only with 15 dB of range) | sustain per band; a recording's tail is often in the room noise (valid false); a held bowed note has no decay while held (its T60 means nothing) |
| `attack.rise_10_90_ms`, `peak_time_ms`, `level.crest_factor` | attack shape | a piano C4 rises in about 20 ms at v95; a render in 3 ms is a sharper attack |
| `thump.excess_db`, `lead_ms` | 50-200 Hz first 30 ms minus 0.5-1 s; the low band's half-rise before the tone | meaningless when f0 sits in the band (`f0_in_band`) |
| `beating.depth_db`, `modulation_hz` | ripple of the fundamental's envelope 0.3-3 s | several dB at a few Hz = unison beating |
| `band_time_db` (4 windows x 6 bands), `cloud_db` (4 windows x 4 bands) | the fit library's band-time matrix and the noise between partials | the inputs of `samples_compare` |

`samples_compare {a, b}` gives b minus a: level-matched band-time RMS (the fit's headline score; 6-10 dB is a
rough match, under 5 a close one on this instrument), cloud RMS, partial RMS with the per-partial list, pitch cents,
B ratio, centroid ratios, T60 ratios per band, attack rise, thump excess. Judge several numbers, never one: the
largest single gain of the Belarus fit was partly a noise-floor artefact of one score.

Rules of measurement: same key, same velocity, same settings (order, iterations, feedback, pedal, routing) before and
after; render twice after an edit when the engine is stopped (an edit can land one render late); a WAV never gives
absolute loudness; three keys across the compass before a keyboard-wide rule, then the whole keyboard at four
velocities.

## The knowledge base {#knowledge}

Versioned in the repo under `docs/tuning/`:

- **Parameter-effect map** `tuning/knowledge/PARAMETER_EFFECTS.md` (rendered from `parameter_effects.json`): one
  entry per lever and aspect with direction, magnitude, register, side effects, confidence and source. Read the
  `index` anchor, then an aspect (`brightness`, `sustain`, `noise`, ...) or an entry id. Consult it at step 4 of the
  [loop](#loop), and whenever the user asks "what does X do".
- **Tuning cases** `tuning/cases/<date>-<slug>.md`: one file per finished case (goal in the user's words,
  interpreted target, preset before / after, changes, before / after measurements, verdict, lessons, evidence). Read
  them when the request resembles one (same trait, same register) before offering options; cite the case.
- The confidence tells you how to speak: a **measured** entry is a fact of this engine (say its number and source);
  **literature** is physics you expect to hold; **anecdotal** is one session's hearing; **unknown** is unknown: say so
  and offer to measure.

You cannot edit the knowledge base; it is written by people and dev agents from the records. Your way in is
[record](#record): a kept session with its numbers is promoted to a case by the dev team, and a lever whose effect you
measured is added to the map from it.

## The sample library {#samples}

The library lives in the repo folder `samples/` (local to the machine, not committed; `samples/README.md`) and is
written only by the library CLI that your tools call:

| Tool | Does | Asks |
|---|---|---|
| `samples_add {artifact_id, file?, source, preset, pitch, velocity, settings, tags, note, id?}` | copies one of your saved WAVs into the library and extracts its card; `pitch` makes the tuning cents meaningful; `settings` must hold what the comparison depends on (order, iterations, feedback, pedal, routing, slider) | rule Sample library (Ask by default; Always allow persists) |
| `samples_list {source?, preset?, pitch?, tag?, query?}` | the cards' summaries, newest first | no |
| `samples_get {id}` | one full card | no |
| `samples_compare {a, b}` | b minus a, see [measure](#measure) | no |

Use readable ids for the samples of a session (`<preset short>_<key>_<v>_<before|after>`), and `tags` for the
session and the trait. A sample from a tainted turn is marked and reading it taints the turn, like a tainted note.
A reference recording that the user gives you as a saved output (a rig record, an imported WAV) goes in with
source `reference`.

## Recording what happened {#record}

Every round ends with `tuning_record`:

| Field | Put |
|---|---|
| `description` | the user's request in their words (the transcript if it was spoken) |
| `interpretation` | the traits you read into it, and the key(s) |
| `options_offered` | the 2-3 options as you said them (effect, size, risk) |
| `chosen` | the option taken, or "the user edited by hand" |
| `changes` | each parameter write as `domain.field pitch old -> new` |
| `before` / `after` | the numbers that matter, with units (centroid_body_hz, partial levels, T60 of a band, band-time RMS against the reference) |
| `samples` | the sample ids |
| `verdict` | kept / rejected / open (the user's judgement, not the score's) |
| `lessons` | one or two lines: what moved, what it cost, what did not work |

The host adds the backend undo history (the labels of the user's own edits) and writes a case draft next to the
record (`samples/sessions/<id>.md`); tell the user it is there. Kept sessions are promoted to `tuning/cases/`
and their measured levers into the parameter map by the dev team. When a session ends unfinished, the hand-off
note (`save_note`, kind handoff) names the record ids and the working file.

## Observe mode: watch the operator tune, learn their words {#observe}

The operator tunes in the UI themselves; you follow every edit, measure each step before and after, record how they
describe the result in their own words (typed, or spoken through the voice input, which arrives as text), and learn
what those words mean for this operator as observable changes. Use it when they say "watch me", "learn what I mean",
or tune by hand while you are open.

**Tools**

| Tool | Does | Asks |
|---|---|---|
| `observe {action: start, operator, pitches, velocities?, duration_ms?, gap_s?}` | follows the backend's state broadcast (read-only: a socket.io client that never emits a write); seeds the focus pitches' stored string / hammer / excitation values so the first edit of each has a before | no (category view) |
| `observe {action: status}` | the steps: each edit as `domain [key] field before -> after`, its time and source (fe, midi_cc, undo, ...); the step state (`open`, `ready_to_render`, `rendered`), flags, what to render, the `todo` | no |
| `observe {action: stop}` | ends watching; the steps stay readable for describe and `tuning_record` | no |
| `observe_describe {step, description, phrases?, verdict?}` | the library pairs the step's after-samples with the session's earlier samples (same pitch and velocity), measures the trait deltas, stores the observation and answers what the words meant this time and so far | rule Sample library |
| `lexicon_get {operator, phrase?}` | the operator's lexicon, whole or the entries a request uses | no |
| `render.note_playback` with `export: true`, `samples_add` | the renders and their library entries (the usual commands and rules: a render asks while live audio runs unless Offline renders is Auto; `samples_add` asks unless Sample library is Auto) | as usual |

Your own writes never count as the operator's (source `assistant` is ignored). Level-only changes (the volume
slider, `output_level`) are not steps: a peak-normalised render cannot hear them. The hammer / bow switch of a key
(`excitation_mode`) is an edit of that key.

**The flow**

1. **Start.** Ask once for the operator's name (it names their lexicon; remember it in a note) and the keys they will
   work on. `observe {action: start, operator, pitches}` (velocities default to 95; pick 2 for a dynamics question).
2. **Baseline (step 0) before the first edit:** render each focus pitch x velocity offline
   (`render.note_playback {pitch, velocity, duration_ms, export: true}`), `samples_add` each with `source: render`,
   `pitch`, `velocity`, `settings` = the session's `render_settings` exactly, and `tags: [obs-<id>, step-0]`. Tell the
   operator when they can start.
3. **Steps.** The operator edits; edits that follow each other are one step. A step is `ready_to_render` after
   `gap_s` of quiet. A render **seals** the step: its after-renders are also the next step's before. So render a
   ready step promptly and ask the operator to wait while it renders. `status` lists the pitches: the edited keys for
   per-key domains (string, hammer, gauss, excitation, feedin, ...); the focus pitches for shared ones (mode, feedback,
   thump, pedal, runtime). Tags `[obs-<id>, step-<n>]`, the same settings, the same duration.
4. **Ask and record.** "How did that come out?" Record their words verbatim with `observe_describe {step, description}`
   (pass `phrases` when you split "warmer, but a bit too woody" yourself: `["warmer", "too woody"]`). Never put your
   own words in their mouth; if they say nothing, leave the step undescribed. `verdict`: kept / undone (they undid
   it) / open.
5. **Feed back** in one line what their words meant this time ("warmer here = centroid -14 %, partials 4-8 -4 dB")
   and, when an entry has 2+ observations, what it means so far. Show a contradiction when one appears.
6. **Stop** when they are done: `observe {action: stop}`, then `tuning_record {description, observe_id, verdict,
   lessons}`: the host attaches the operator and their observed edits. A kept session becomes a tuning case
   attributed to the operator after review.

**Flags.** `merged` = they edited again before the render (one step); `contaminated` = an edit landed while a step's
renders were still running (its delta is not trusted and is not learned from; say so); `preset_changed` = a preset
load / switch broke the chain (render a new baseline); `no_baseline_render` = the first step began before step 0
was rendered; `journal_gap` = the backend restarted or the link dropped long enough to lose events. A pair is
excluded when the before sample is missing (a key outside the baseline: its after-render becomes the base of later
steps) or the settings differ.

**Safety.** Observing is read-only. Renders are offline (`note_playback`): never play live, never touch the slider or
the level, never load a preset, never undo for the operator. Observing ends on stop or after 4 hours; a session holds at most
60 steps.

**The lexicon** (derived by `tools/tuning/lexicon.py` on every read, never stored as a second copy). Per phrase, per
trait of the card (centroids, roll-off, partial groups 1-3 / 4-8 / 9-12, T60 low / mid / high, attack rise, cloud,
thump, B, pitch, beating): a direction needs 3 of 4 observations to agree beyond the trait's threshold (centroid
3 %, partial groups 1 dB, T60 5 %, ...: conventions, not measured noise floors); its range is that of the agreeing
observations; `unchanged` lists traits that stayed inside the threshold in 2+ observations; a **contradiction** is
both signs at 25 % or more. Confidence follows the count only: 1 = single observation, 2-3 low, 4-7 medium, 8+
high. Each step counts once (the median over its pitches and velocities). Evidence: the local
`samples/observations.jsonl`; the dev team exports it into the versioned knowledge base (`tuning/lexicon/<operator>.md` +
`.observations.jsonl`), and the lexicon reads both. Format and maintenance:
[operator lexicons](../tuning/lexicon/index.md).

## Limits of this page {#limits}

- The numbers here and in the knowledge base come from one piano (a Belarus upright recording), one plywood
  board, one room and a few keys; on another preset, instrument or system they are examples. Measure yours.
- The extractor runs on the CPU in the canonical venv; without it `samples_*` answers with the reason. It reads one
  channel; a stereo capture is read as its first channel. A short sample (under 0.2 s) gives level only.
- Two engine defects are not tunable from a preset: the block comb at multiples of the cycle rate and the order-2
  HF layer. Name them when the user hears "dirt" at order 2, offer order 1 as a settings change, and do not spend
  rounds on parameters that cannot remove them.
- The real piano's early level drop (17-20 dB lower at 4 s on C4 / G4 than the best fit) and the 500-1000 Hz attack
  excess are open: no lever is known. Say so when the request lands there.
- Scores from different settings (order, iterations, pedal, feedback) are not comparable; neither are live and
  rendered levels.
- Observe mode: the before value of an edit is what the session saw (the stream, or the start seed of the focus
  pitches' string / hammer / excitation); an edit of another key or domain shows "before not observed" (the backend
  undo history holds it but has no read route). An edit of more than 16 keys at once carries no values (refetch).
  The live step buffer is in the assistant service's memory: a restart of the service ends the session (the described
  steps are already stored). A phrase is read as describing the change the step caused; the lexicon learns nothing
  from a step without comparable pairs.
