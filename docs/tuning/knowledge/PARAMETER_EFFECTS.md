# Parameter effects (Pianoid tuning knowledge base)

**Generated** from `parameter_effects.json` by `tools/tuning/render_knowledge.py`; edit the JSON, not this page. One entry = one lever -> one sound aspect: direction, typical magnitude, register dependence, side effects, confidence (**measured** = a number from this engine with its source; **literature** = physics / engine docs; **anecdotal** = a listening session or a user statement; **unknown** = stated as unknown) and the source. Read with `read_docs` (page `tuning/knowledge/PARAMETER_EFFECTS.md`, anchor = an aspect or an entry id). How to use it: [`guides/TUNING_FOR_ASSISTANT.md#knowledge`](../../guides/TUNING_FOR_ASSISTANT.md#knowledge).

Version 1 · 33 entries.

## Aspects {#aspects}

| Aspect | Measured as |
|---|---|
| `pitch` | f0 and tuning in cents (characteristics.pitch) |
| `inharmonicity` | partial stretch B (pitch.inharmonicity_B); 'metallic' when high, 'dead' when near zero |
| `level` | overall loudness; in files only relative (WAVs are peak-normalised), live from /health and the raw render stats |
| `brightness` | spectral centroid (attack 0-30 ms, body 100-400 ms) and roll-off dB/oct: bright = high centroid, flat roll-off; dull = low centroid, steep roll-off |
| `partial_balance` | levels of partials 1-12 re the strongest (partials[]): thin = weak low partials, full = strong 1-3, holes = single partials far down |
| `sustain` | T60 per band (decay[]): long / short sustain, and whether the top decays faster than the bass |
| `attack` | rise 10-90 % (attack.rise_10_90_ms), peak time, crest factor; sharp / soft attack |
| `thump` | 50-200 Hz excess in the first 30 ms and the low band's lead over the tone (thump.excess_db / lead_ms) |
| `noise` | cloud between partials (cloud_db) and HF layers that do not belong to partials: rattle, hiss, harshness |
| `beating` | ripple of the fundamental's envelope (beating.depth_db / modulation_hz): unison chorus, 'fast first decay' that is really beating |
| `body` | resonance of the soundboard modes: boom / boxiness in a band, mode-driven partial boosts shared across keys |
| `stability` | CFL / Courant margin, crash-guard trips, clipping: the limits every lever must respect |

## Index {#index}

| Entry | Parameter | Aspect | Confidence |
|---|---|---|---|
| [string.jung.inharmonicity](#string-jung-inharmonicity) | string.jung (Young's modulus coefficient E) | inharmonicity | measured |
| [string.r.inharmonicity](#string-r-inharmonicity) | string.r (radius) | inharmonicity | literature |
| [string.tension.pitch](#string-tension-pitch) | string.tension | pitch | measured |
| [string.length.pitch](#string-length-pitch) | string.length (metres) | pitch | literature |
| [string.gamma.sustain](#string-gamma-sustain) | string.gamma (velocity damping) | sustain | measured |
| [string.dispersion_damping.hf_decay](#string-dispersion-damping-hf-decay) | string.dispersion_damping (frequency-dependent HF damping) | sustain | measured |
| [string.detuning.beating](#string-detuning-beating) | string.detuning (per-string tension offset of the unisons) | beating | measured |
| [hammer.hammer_position.partial_balance](#hammer-hammer-position-partial-balance) | hammer.hammer_position (strike point, ratio of the speaking length) | partial_balance | measured |
| [hammer.hammer_width.brightness](#hammer-hammer-width-brightness) | hammer.hammer_width (contact width, m) | brightness | measured (mixed: effective only above the grid quantum) |
| [hammer.hammer_sharpness.inert](#hammer-hammer-sharpness-inert) | hammer.hammer_sharpness (profile curvature 0..1) | brightness | measured |
| [gauss.pulse_timing.partial_hump](#gauss-pulse-timing-partial-hump) | gauss (temporal excitation curve: mu / sigma / volume of the 5 components per velocity level) | partial_balance | measured |
| [gauss.small_pulse.cloud](#gauss-small-pulse-cloud) | gauss small pulse (the low-level 'aftershock' component) and the first-spike component | noise | measured |
| [gauss.sigma.brightness](#gauss-sigma-brightness) | gauss sigma (width of a component) | brightness | measured |
| [excitation_energy.hammer_mass.level](#excitation-energy-hammer-mass-level) | excitation_energy.hammer_mass (kg, per pitch) and hammer_speeds (m/s per velocity level) | level | measured |
| [excitation.curve_scatter.per_pitch_level](#excitation-curve-scatter-per-pitch-level) | excitation per-pitch curve volume row (levels_matrix[:, 2, :]) under the legacy multiply mode | level | measured |
| [thump.level_and_lead](#thump-level-and-lead) | thump.enabled / gain / trim_db (the shared keybed-thump string, presets with a thump string only) | thump | measured |
| [mode.frequency.body](#mode-frequency-body) | mode.frequency (Hz, small-angle parameter: plays sharp by about (pi f / sr)^2 / 6) | body | measured |
| [mode.decrement.band_decay](#mode-decrement-band-decay) | mode.decrement (mode damping; dec = dt x decrement x frequency) | sustain | measured |
| [mode.mass_inv.level](#mode-mass-inv-level) | mode.mass_inv (inverse mass coefficient; about 1e-12 in measured presets is normal) | body | measured |
| [mode.radiance.speaker_balance](#mode-radiance-speaker-balance) | mode.radiance_mono / radiance_left / radiance_right (speaker drive per mode) | level | measured |
| [coupling.feedin.per_key_path](#coupling-feedin-per-key-path) | feedin (deck feed-in row of a pitch, per mode, 0..1 normalised per mode) | noise | measured |
| [runtime.feedback.level_and_decay](#runtime-feedback-level-and-decay) | runtime.feedback (deck feedback coefficient; 64 -> 1.0; the Tuning18 family runs 1000-15000 by the user's choice) | level | measured |
| [load.sound_derivative_order.brightness](#load-sound-derivative-order-brightness) | load setting sound_derivative_order (1 = velocity, 2 = acceleration output) | brightness | measured |
| [load.string_iterations.precision](#load-string-iterations-precision) | load setting string_iterations (FDTD sub-steps per sample: 8 or 16) | stability | measured |
| [runtime.volume.level](#runtime-volume-level) | runtime.volume (slider 0-127) and the load anchor volume (a different thing: bare center = exp((volume - 100) / 8)) | level | measured |
| [pedal.half_pedal.decay](#pedal-half-pedal-decay) | pedal (continuous pedal value 0-127; per-string graded damper law) | sustain | measured (one comparison) |
| [bow.string_loss.brightness](#bow-string-loss-brightness) | bow: bowed-string HF loss factor (runtime, per-register curve; default x40 bass, x100 C3 region, x60 C4 up; angle scales it) | brightness | measured |
| [bow.force.level_regime](#bow-force-level-regime) | bow force (CC1 by default, 0..1 normal force) | level | measured |
| [bow.angle_and_speed](#bow-angle-and-speed) | bow angle (CC16, friction-curve softness; scales the HF loss) and bow speed (= MIDI velocity) | brightness | measured |
| [engine.block_comb.artefact](#engine-block-comb-artefact) | (engine defect, not a lever) block comb at n x 750 Hz +- partial (48000 / 64 cycle) | noise | measured (cause inferred) |
| [engine.rattle_layer.artefact](#engine-rattle-layer-artefact) | (engine defect, not a lever) the A2 'rattle': uncorrelated noise above about 4 kHz scaling with note level | noise | measured (source not located) |
| [unknown.attack_500_1000_excess](#unknown-attack-500-1000-excess) | (open) 500-1000 Hz attack excess of +8 to +11 dB for 160 ms on C4 and G4 | attack | unknown |
| [unknown.early_drop](#unknown-early-drop) | (open) the real piano's early level drop (C4 -38 dB at 4 s, render -21; G4 -42 vs -22) | sustain | unknown |

## pitch {#pitch}

f0 and tuning in cents (characteristics.pitch)

### string.tension.pitch {#string-tension-pitch}

- **Parameter:** string.tension
- **Direction:** T up -> f0 up (f0 ~ sqrt(T))
- **Magnitude:** the auto-tuner corrects pitch by tension to within 1 cent in a few iterations
- **Register:** all; at high string_iterations the bass pitch drifts with float32 (dev-1e95)
- **Side effects / interactions:** raises coeff_tension and the CFL ratio: check stability_ratio after a raise; changes the level by physics (kept as heard, output_scale not recalibrated)
- **Confidence:** measured
- **Source:** pianoid_middleware/auto_tuner.py FrequencyTuner; schemas/params/string.json; SYNTHESIS_ENGINE 'Numerical precision'

### string.length.pitch {#string-length-pitch}

- **Parameter:** string.length (metres)
- **Direction:** length up -> f0 down; re-derives dx and tail (= length / 10)
- **Magnitude:** not measured as a sweep
- **Register:** all
- **Side effects / interactions:** a longer string at the same array_size changes dx and so the CFL ratio (the length -> dx regression in SYNTHESIS_ENGINE); prefer tension for small pitch corrections
- **Confidence:** literature
- **Source:** schemas/params/string.json; SYNTHESIS_ENGINE 'Real-preset regime, and the length->dx regression'


## inharmonicity {#inharmonicity}

partial stretch B (pitch.inharmonicity_B); 'metallic' when high, 'dead' when near zero

### string.jung.inharmonicity {#string-jung-inharmonicity}

- **Parameter:** string.jung (Young's modulus coefficient E)
- **Direction:** E up -> B up (partials stretch further apart, more 'metallic' / piano-like top)
- **Magnitude:** preset 21: keys 45-69 raised to the measured piano inharmonicity, with a retune of each key afterwards (f0 moves with E)
- **Register:** all; keys 85-108 had NEGATIVE B from numerical dispersion before preset 25 fixed them (now positive, near the piano to key 99, lower at 100-104)
- **Side effects / interactions:** retune needed after every E change (f0 shifts); a higher E raises the numerical HF layer (the 'rattle' ratio grows with the stiffness Courant number, so keys 37-44 were held partway); tightens the CFL bound (coeff_bending); A2 r 0.0003 with jung -2.4e12 went unstable with no note played (gate trip, 68 x FS): never use negative E
- **Confidence:** measured
- **Source:** assistant notes 'Belarus fit report: preset 21' and 'Keyboard extension report, preset 25' (2026-11-01); schemas/params/string.json; SYNTHESIS_ENGINE FDTD stability

### string.r.inharmonicity {#string-r-inharmonicity}

- **Parameter:** string.r (radius)
- **Direction:** r up -> B up (B scales with r^4); also tightens the CFL bound through coeff_bending
- **Magnitude:** not measured on this engine as a standalone sweep
- **Register:** all
- **Side effects / interactions:** CFL margin; in the physical string-gain model r changes the string's mass and the excitation gain (level)
- **Confidence:** literature
- **Source:** schemas/params/string.json (from the engine docs); MODE/SYNTHESIS docs


## level {#level}

overall loudness; in files only relative (WAVs are peak-normalised), live from /health and the raw render stats

### excitation_energy.hammer_mass.level {#excitation-energy-hammer-mass-level}

- **Parameter:** excitation_energy.hammer_mass (kg, per pitch) and hammer_speeds (m/s per velocity level)
- **Direction:** mass up -> louder (the per-pitch loudness lever); speed up -> louder per velocity level; the delivered impulse = calibration x mass x speed, independent of curve and hammer shape
- **Magnitude:** thump string: 3.4 g -> 10 g -> 15 g gave 50-200 Hz excess at least +20 / +31 / +33 dB (C4, lower bounds); preset 25 'attack equalize C4 ref' brought all keys within 1.9 dB of C4 at v95 (keys 86+ clamped at 0.1 g, 5-13 dB over)
- **Register:** all
- **Side effects / interactions:** the loudness still carries a +-7 dB per-pitch shape term; a large mass change re-balances thump against tone; velocity 40 / 95 / 127 RMS must stay monotone (checked on C4)
- **Confidence:** measured
- **Source:** memory note 'Keybed thump (dev-thump1)' MEASURED; orchestrator memory project_excitation_normalization_corrected_model (user-confirmed model 2026-06-30); assistant note preset 19 / 25

### excitation.curve_scatter.per_pitch_level {#excitation-curve-scatter-per-pitch-level}

- **Parameter:** excitation per-pitch curve volume row (levels_matrix[:, 2, :]) under the legacy multiply mode
- **Direction:** per-pitch curve-volume scatter -> pitch-to-pitch loudness jumps (a hot curve = a loud key)
- **Magnitude:** Belarus_196modesC_Fanera6exc: pitch 52 vs 53 -14 dB at v127; keyboard-wide ripple +-5-27 dB; swap test: swapping the excitation moved the peak 44.5 -> 200, swapping physics or deck did not. Leveling by sqrt(target / current) per pitch flattened 47-72 to +-0.17 dB. The root cause (curve integral double-counted) is fixed by the conserve coefficient; the residual +-7 dB is shape
- **Register:** whole keyboard; bottom 19 bass keys physically weak (3-18 dB under the median even after leveling)
- **Side effects / interactions:** mode damping does NOT control per-pitch loudness (20 x damping on the nearby modes left the peak byte-identical): a spectral coincidence is correlation, confirm with a swap / knockout
- **Confidence:** measured
- **Source:** orchestrator memory project_perpitch_volume_ripple_modal_resonance (dev-volpitch 2026-06-25 / 26), project_excitation_normalization_corrected_model

### mode.radiance.speaker_balance {#mode-radiance-speaker-balance}

- **Parameter:** mode.radiance_mono / radiance_left / radiance_right (speaker drive per mode)
- **Direction:** factors up in a band -> more of that band on the speakers; it targets the BOARD in the room, not the reference piano
- **Magnitude:** raising 500+ Hz factors by 10-18 dB moved the mic little (render F#5 only +3 dB); after a per-note empirical match the speaker-minus-board error at vel 70 went from +17 / +18 / +12 / +15 / +6 / +6 / -5 dB (C2..C6) to +2.3 / -1.5 / -2.6 / -4.4 / -1.0 / +4.9 / -1.9 dB; factors run about 18-30k at low modes, 130-175k near 2 kHz
- **Register:** all; the treble gap was the hard part (speakers 11-20 dB short, then 18 dB down after a reconnect)
- **Side effects / interactions:** a worse piano score on speakers is not a radiance error; the row-based formula from a board / speaker FRF pair disagreed with the note test (10-12 dB less above 2 kHz) and was not applied; a digital boost clips: raise the amp MAIN first; the host reverted one radiance write for clipping
- **Confidence:** measured
- **Source:** assistant notes 'Belarus fit: speakers vs board score', 'Radiance remeasured 2026-11-02', 'Radiance against BelarusNew2Assistant', 'Ver1/Ver2 saved' (2026-10-31 / 11-02)

### runtime.feedback.level_and_decay {#runtime-feedback-level-and-decay}

- **Parameter:** runtime.feedback (deck feedback coefficient; 64 -> 1.0; the Tuning18 family runs 1000-15000 by the user's choice)
- **Direction:** LOWER feedback -> louder and sharper attack, still stable (the signal decays at every value incl. 0); higher -> quieter and a faster late decay
- **Magnitude:** coefficient 0: attack peak about 19-22 x the ceiling (clipping), still rings down; feedback 12000 speeds C4's late decay by 1.5-3.5 dB/s and lowers the 2 s level; the block-comb ratio grows with it (1 / 1000 / 12000 -> 1.7 / 7 / 10.5)
- **Register:** all
- **Side effects / interactions:** the only hazard is CLIPPING (headroom), not instability; modes have their own damping (mode_dec), feedback is not their damping source; the user sets feedback themselves on the Tuning18 presets (1797, 10000 are intentional, never 'reset' them)
- **Confidence:** measured
- **Source:** orchestrator memory project_feedback_coeff_is_damping (dev-d52b 2026-06-04, user-confirmed); assistant notes 'attack left as is at 8 iterations' and 'Feedback range for the Tuning18-10-26ver1 presets'; prompt.js data-model facts

### runtime.volume.level {#runtime-volume-level}

- **Parameter:** runtime.volume (slider 0-127) and the load anchor volume (a different thing: bare center = exp((volume - 100) / 8))
- **Direction:** slider up -> louder, about 0.317 dB per step (amplitude = center x 10^((level - 64) / 63)); slider 1 = -20 dB re 64
- **Magnitude:** a full preset load can re-derive output_scale by +10.85 dB (thump file) or -9 dB (a stale file, Ver5): the same slider is then 9-11 dB different; load volume 110.36 = -18 dB against 127
- **Register:** global
- **Side effects / interactions:** the limit is clipping (a sample above full scale hard-clips at the INT32 rail, nothing turns it down); the host reverts a volume write that makes the output clip; after any load drop the slider and start quiet
- **Confidence:** measured
- **Source:** assistant notes 'Ver4 is the working start: feedback 3312 stored, level anchor 110.36', 'Belarus fit: thump pass', 'Ver5/Ver6'; prompt.js 'Reading health and level'

### bow.force.level_regime {#bow-force-level-regime}

- **Parameter:** bow force (CC1 by default, 0..1 normal force)
- **Direction:** force up -> louder; too low leaves the clean regime (surface sound / period doubling), too high leaves it the other way (partial 4, raucous, pitch flattening: the Schelleng window)
- **Magnitude:** static force 0.1 / 0.3 / 0.5 / 0.95 -> RMS 1.07e-5 / 1.94e-5 / 2.13e-5 / 7.03e-5 engine units; 0.1 and 0.95 leave the clean regime; live change 0.5 -> 0.05 while held = a smooth -12 dB step, centroid 6.7 -> 4.7 kHz, no gap, no new attack
- **Register:** all; C3 default force x0.6
- **Side effects / interactions:** force also moves brightness (centroid down when force drops)
- **Confidence:** measured
- **Source:** dev-bow2 session log 2026-11-04 (Step 5/7 verification; v2 CPU golden)


## brightness {#brightness}

spectral centroid (attack 0-30 ms, body 100-400 ms) and roll-off dB/oct: bright = high centroid, flat roll-off; dull = low centroid, steep roll-off

### hammer.hammer_width.brightness {#hammer-hammer-width-brightness}

- **Parameter:** hammer.hammer_width (contact width, m)
- **Direction:** width up -> centroid down (duller top); width down -> more 8-12 kHz
- **Magnitude:** G4 width 0.038 restored 8-12 kHz (preset 22). Width is QUANTISED by the grid: 0.0275 and 0.034 render the same (hammer_width_effective = max(stored, about dx)); one user report (5b0dea17) and the belarusfit_3 session found no effect at all on their keys
- **Register:** all; coarse steps on short (treble) strings where dx is small relative
- **Side effects / interactions:** none measured; the effect is absent when the stored width is below the grid's quantum
- **Confidence:** measured (mixed: effective only above the grid quantum)
- **Source:** assistant notes 'Preset 22 report' ('Width is quantised'), 'Belarus fit: A2 C4 G4 offline' ('hammer_width: no effect'); schemas/params/_index.json doc_conflicts (width floor)

### hammer.hammer_sharpness.inert {#hammer-hammer-sharpness-inert}

- **Parameter:** hammer.hammer_sharpness (profile curvature 0..1)
- **Direction:** none measurable
- **Magnitude:** under 0.1 dB in two independent sessions (0.2 against 0.5; 'no effect' on A2/C4/G4)
- **Register:** all tested keys
- **Side effects / interactions:** none; do not offer it as a lever
- **Confidence:** measured
- **Source:** assistant notes 'thump_assistant_15 to 18' (rejected: hammer sharpness .2 inert) and 'Preset 22 report' (hammer sharpness no effect); schemas/params/excitation.json lists its centroid direction as UNKNOWN

### gauss.sigma.brightness {#gauss-sigma-brightness}

- **Parameter:** gauss sigma (width of a component)
- **Direction:** sigma up -> wider pulse, duller; a shorter pulse gives a louder transient at the same impulse (peak-to-integral ratio)
- **Magnitude:** sigma-widen moved force_peak -1.8 to -4.5 dB and narrow +2.4 dB at constant delivered impulse (2026-06-30 measurement); thump pulse mu 3.4 sigma .9 at level 95 removed a too-sharp peak with scores unchanged
- **Register:** all
- **Side effects / interactions:** in conserve mode the component VOLUMES divide out (scaling all volumes has zero effect); only the shape matters; the rendered loudness still varies about +-7 dB with shape at equal impulse (a physical fact, not a bug)
- **Confidence:** measured
- **Source:** orchestrator memory project_fe_excitation_renorm_inert_conserve (dev-excitanalysis 2026-06-30); assistant note 'thump_assistant_15 to 18'; schemas/params/excitation.json

### load.sound_derivative_order.brightness {#load-sound-derivative-order-brightness}

- **Parameter:** load setting sound_derivative_order (1 = velocity, 2 = acceleration output)
- **Direction:** order 2 -> a tilt near +6 dB per octave (brighter attack), about +33 dB more HF above 10 kHz and about 30 dB more numerical 'rattle'; order 1 -> darker, cleaner
- **Magnitude:** A2 HF > 10 kHz: order 2 -52 dB vs order 1 -85 dB; level differs by about 19 dB between orders; order 0 behaves as 1
- **Register:** all
- **Side effects / interactions:** a structural load setting (full reload); scores at different orders are not comparable; output_scale is valid only at the settings it was calibrated at; the user chose order 2 / 8 iterations for the Belarus fit and left the slightly bright attack as is (2026-10-31)
- **Confidence:** measured
- **Source:** assistant notes 'Comb and attack report, preset 20', 'A2 rattle report, preset 23', 'attack left as is at 8 iterations'; schemas/params/load.json

### bow.string_loss.brightness {#bow-string-loss-brightness}

- **Parameter:** bow: bowed-string HF loss factor (runtime, per-register curve; default x40 bass, x100 C3 region, x60 C4 up; angle scales it)
- **Direction:** loss factor up -> fewer slips per period (clean Helmholtz motion at 1.0 slip / period), lower centroid, steeper roll-off; too low -> multi-slip, flat spectrum, harsh
- **Magnitude:** centroid: hammer 1.09 kHz; bow x1 6.78 kHz, x20 3.23, x40 2.54 (C4); slips/period at x1 -> x20: p48 5.4 / 2.3 / 20 -> 1.02 / 1.00 / 1.00 (force 0.3 / 0.5 / 0.8); C3 harshness = flat spectrum (0 dB/oct, centroid at partial 17) -> C3 default x100 + force x0.6 gives -4.4 dB/oct, centroid at partial 12, slips 1.0-1.1; x60 / x80 clean at 48 / 60 / 67 but worse in the bass (x60 3.0 / 1.4 / 2.1 slips); levels vs x40 -0.7 to -2.3 dB
- **Register:** bass needs x40; C3 region x100; x20 was the smallest robust factor on 36 / 48 / 60 / 67
- **Side effects / interactions:** a moved bow position was rougher (rejected); the user picked x40 by ear
- **Confidence:** measured
- **Source:** dev-bow2 session log 2026-11-03 / 04 (engine sweeps, dev-bow2-timbre.py, bow_C3_soft_*.wav); proposals/bow-realism-2026-10-29

### bow.angle_and_speed {#bow-angle-and-speed}

- **Parameter:** bow angle (CC16, friction-curve softness; scales the HF loss) and bow speed (= MIDI velocity)
- **Direction:** angle up -> louder and brighter (centroid up); speed up -> louder
- **Magnitude:** angle 0 / 0.5 / 1 -> RMS 1.86e-5 / 2.22e-5 / 3.05e-5, centroid 6438 / 6655 / 6919 Hz (x1 loss, before the register curves); velocity 115 vs 40 = +6.4 dB
- **Register:** all
- **Side effects / interactions:** none measured beyond level
- **Confidence:** measured
- **Source:** dev-bow2 session log 2026-11-04


## partial_balance {#partial-balance}

levels of partials 1-12 re the strongest (partials[]): thin = weak low partials, full = strong 1-3, holes = single partials far down

### hammer.hammer_position.partial_balance {#hammer-hammer-position-partial-balance}

- **Parameter:** hammer.hammer_position (strike point, ratio of the speaking length)
- **Direction:** striking at L/n suppresses partial n (a comb); moving the point fills or digs holes in partials 2-12
- **Magnitude:** preset 15-18: C4 .19, G4 .125, A2 .185 filled the render's partial holes; preset 22: 0.125-0.13 on C#4-C5 and A2 filled 2-3 kHz and A2 partial 11; G4 at .19 and .16 made nulls (and sounded louder); preset 25: 73-76 0.125, 77 0.14, 78 0.16, 86-108 0.065-0.17 removed the top's over-level
- **Register:** all; the top keys need small ratios
- **Side effects / interactions:** level changes with the point; a null at a low partial sounds thin
- **Confidence:** measured
- **Source:** assistant notes preset 15-18, 'Preset 22 report: C4 versus G4 attack', 'Keyboard extension report, preset 25'; schemas/params/excitation.json

### gauss.pulse_timing.partial_hump {#gauss-pulse-timing-partial-hump}

- **Parameter:** gauss (temporal excitation curve: mu / sigma / volume of the 5 components per velocity level)
- **Direction:** shorter and earlier pulses -> a hump on partials 2-5 and a brighter attack; the C4 pulse set (longer, later main pulse) gave a falling partial series close to the piano
- **Magnitude:** preset 22: copying C4's pulse set to A3-B3, C#4-C5 and A2 removed G4's low-partial hump (the cause was pulse timing, not stiffness); preset 25 applied the C4 recipe to keys 37-78 (it collapsed the top: keys 79-108 keep their own pulses)
- **Register:** mid keys 37-78; the top needs its own pulses
- **Side effects / interactions:** curves are impulse-normalised in the engine (conserve mode): removing a component redistributes energy instead of removing it; the thump lead fell on G4 and A2 after the copy; key boundaries 56/57 and 72/73 were not smooth
- **Confidence:** measured
- **Source:** assistant notes 'Preset 22 report: C4 versus G4 attack', 'Keyboard extension report, preset 25', 'Comb and attack report, preset 20'


## sustain {#sustain}

T60 per band (decay[]): long / short sustain, and whether the top decays faster than the bass

### string.gamma.sustain {#string-gamma-sustain}

- **Parameter:** string.gamma (velocity damping)
- **Direction:** gamma up -> all partials decay faster (T60 down, broadband)
- **Magnitude:** preset 15-18: gamma A2 0.3, C4 0.45, G4 0.4 moved the attack centre nearer the piano; preset 19: gamma DOWN on all keys to lengthen tails (tail 3-14 s on partials 1-3 came within about 2-5.5 dB of the piano)
- **Register:** all; preset 25 carries a per-key rule for gamma (keyboard rules for gamma, dispersion damping, detuning)
- **Side effects / interactions:** the late decay also depends on the deck feedback (12000 speeds C4's late decay by 1.5-3.5 dB/s) and on the mode decrement; the 'early drop' of the real piano (level at 4 s: C4 -38 dB) was NOT reached by gamma alone (render -21 dB)
- **Confidence:** measured
- **Source:** assistant notes 'experiment report, thump_assistant_15 to 18', 'keyboard extension report, preset 19', 'attack left as is at 8 iterations' (2026-10-31 / 11-01)

### string.dispersion_damping.hf_decay {#string-dispersion-damping-hf-decay}

- **Parameter:** string.dispersion_damping (frequency-dependent HF damping)
- **Direction:** up -> high partials decay faster (duller tail, cleaner top); down -> high partials ring
- **Magnitude:** C4 / G4: 8e-15 -> 2e-15 gave the largest single score gain of the fit (C4 10.0 -> 8.5, G4 11.5 -> 9.6 band-time RMS) but left partials 15-20 ringing up to 14 dB over the piano at 4-10 kHz; corrected to 5e-15 / 4e-15. A2: 3e-15 was worse (8.6 -> 9.8), 8e-15 kept. 3e-13 killed the note
- **Register:** all; per-key rule in preset 25
- **Side effects / interactions:** part of the 2e-15 gain was a noise-floor artefact of the score (a low cloud is not always a good sound); the metric must state its floor
- **Confidence:** measured
- **Source:** assistant notes 'experiment report, thump_assistant_15 to 18' and 'keyboard extension report, preset 19' (dirt finding 1)

### mode.decrement.band_decay {#mode-decrement-band-decay}

- **Parameter:** mode.decrement (mode damping; dec = dt x decrement x frequency)
- **Direction:** decrement up -> that mode's band decays faster (shorter body ring); measured board damping is zeta 1-4 % where tuned presets carried 10-30 %
- **Magnitude:** BelarusNew2 Ver2: measured damping on 61 modes (59.7-1905 Hz) moved levels by up to 12.6 dB and the slider had far less range than assumed; Ver6: zeta x3 (a tuning choice above measured) with mass x sqrt(zeta ratio) on modes 0-23 brought A2 lows from -20.7 / -16.8 to -12.8 / -11.6 dB (piano -9.3 / -6.1); 'board Q x3' on the F15 fit was rejected
- **Register:** the band of the mode
- **Side effects / interactions:** damping and mass are coupled in the level: lower damping = a louder, longer resonance; units of decrement are UNKNOWN (not SI); mode edits do not clear output_scale_calibrated
- **Confidence:** measured
- **Source:** assistant notes 'Ver1/Ver2 saved, master level cut 18 dB', 'Ver5/Ver6, composition defect found' (2026-11-02), 'preset 21' (board Q x3 rejected); schemas/params/mode.json

### unknown.early_drop {#unknown-early-drop}

- **Parameter:** (open) the real piano's early level drop (C4 -38 dB at 4 s, render -21; G4 -42 vs -22)
- **Direction:** unknown combination; gamma, dispersion damping, detuning and feedback each moved the tails but did not produce the 17-20 dB early drop
- **Magnitude:** 17-20 dB too high at 4 s on C4 / G4 after preset 25
- **Register:** mid keys
- **Side effects / interactions:** candidates not yet tried: a two-stage decay via the damper law or per-string tension_offset beating against a damped partner; mode decrement in the 250-1000 Hz band
- **Confidence:** unknown
- **Source:** assistant notes 'Keyboard extension report, preset 19'; piano fit report sections 3 and 8

### pedal.half_pedal.decay {#pedal-half-pedal-decay}

- **Parameter:** pedal (continuous pedal value 0-127; per-string graded damper law)
- **Direction:** pedal up -> dampers lift, longer tails; half values grade the damper rate per string
- **Magnitude:** pedal 60 (half) was the fit condition; pedal 90 on A2 / G4 gave no score gain and a worse G4 cloud (rejected, 60 stays)
- **Register:** bass first with register_spread > 0
- **Side effects / interactions:** scores at different pedal values are not comparable
- **Confidence:** measured (one comparison)
- **Source:** assistant note 'thump_assistant_15 to 18' (rejected: pedal 90); schemas/params/string.json pedal domain (dev-pedal1)


## attack {#attack}

rise 10-90 % (attack.rise_10_90_ms), peak time, crest factor; sharp / soft attack

### unknown.attack_500_1000_excess {#unknown-attack-500-1000-excess}

- **Parameter:** (open) 500-1000 Hz attack excess of +8 to +11 dB for 160 ms on C4 and G4
- **Direction:** unknown lever; not the pulses (aftershock makes nothing above 1 kHz), not modes 194 / 195
- **Magnitude:** +8 to +11 dB over the piano, all 160 ms of the attack window
- **Register:** C4, G4
- **Side effects / interactions:** a 'body issue' by elimination; untested candidates: the modes between 500 and 1000 Hz, their feedin rows on those keys
- **Confidence:** unknown
- **Source:** assistant note 'Comb and attack report, preset 20'; piano fit report section 8 (open items)


## thump {#thump}

50-200 Hz excess in the first 30 ms and the low band's lead over the tone (thump.excess_db / lead_ms)

### thump.level_and_lead {#thump-level-and-lead}

- **Parameter:** thump.enabled / gain / trim_db (the shared keybed-thump string, presets with a thump string only)
- **Direction:** on -> 50-200 Hz excess in the first 20-30 ms; gain / trim up -> more; it does not move the tone's own onset
- **Magnitude:** real piano target 50-200 Hz first 30 ms minus 0.5-1 s: C4 +27, G4 +27, A2 +6 dB (A2 the only true comparison); 3.4 g low-row = at least +20 / +20 / +7.3 (best match); off = noise / noise / +3.5. On the piano the thump and tone onsets coincide; the audible lead is the tone building later: low-band half-rise lead 20-30 ms on held bass notes, about 0 in the treble
- **Register:** bass and mid; near 0 lead in the treble
- **Side effects / interactions:** acts in the first 0-20 ms only; 20-60 ms lows remain a separate problem; a full preset load re-derived output_scale (+10.85 dB) when the thump file was loaded: drop the slider first; rho / f1 of the thump string follow string_iterations
- **Confidence:** measured
- **Source:** memory note 'Keybed thump (dev-thump1, 2026-10-30)'; assistant notes 'Belarus fit: thump pass', 'preset 21, thump timing'


## noise {#noise}

cloud between partials (cloud_db) and HF layers that do not belong to partials: rattle, hiss, harshness

### gauss.small_pulse.cloud {#gauss-small-pulse-cloud}

- **Parameter:** gauss small pulse (the low-level 'aftershock' component) and the first-spike component
- **Direction:** small pulse level down -> less noise / cloud between partials and less 1-2 kHz in the first 10 ms; down to 0 -> rejected (holes)
- **Magnitude:** C4, G4: .03 then .02 kept; A2: .13 closed the partial-5 gap (-11 -> -3 dB), later .05 at level 95 took the rattle layer down 4 dB with feedin 194/195 at 0.5; A2 .3 rejected; 0 rejected. First-spike comp 2: p60 sigma .045 vol 1.0, p45 .055 vol 1.3, p67 .05 vol .6 (belarusfit_3)
- **Register:** fitted on A2, C4, G4
- **Side effects / interactions:** the aftershock makes nothing above 1 kHz; the 500-1000 Hz excess (+8 to +11 dB for 160 ms on C4 / G4) is NOT the pulses (cause unknown, 'a body issue')
- **Confidence:** measured
- **Source:** assistant notes 'thump_assistant_15 to 18', 'Comb and attack report, preset 20', 'A2 rattle report, preset 23', 'Belarus fit: A2 C4 G4 offline'

### coupling.feedin.per_key_path {#coupling-feedin-per-key-path}

- **Parameter:** feedin (deck feed-in row of a pitch, per mode, 0..1 normalised per mode)
- **Direction:** lower a key's feedin to a mode -> less of that key's energy reaches the mode's path (and whatever rides on it); the per-key alternative to a global mode change
- **Magnitude:** A2 feedin of modes 194 and 195 at 0.5 (with small pulse .05) took the HF rattle layer down 4 dB (scores 6.8 / 9.7); those two big modes carried 95 % of the broadband path on A2 AND the real 2-8 kHz attack, so muting them lost the attack
- **Register:** per key
- **Side effects / interactions:** raw un-normalised magnitudes (about 1e-4) give near-silent output: rows are per-mode normalised 0..1; output rows (pitches 128+) carry a separate gain (about 160-430 in working presets); masks are the way to silence, never zeros in raw rows; the feedback mask has no effect in a single-deck matrix
- **Confidence:** measured
- **Source:** assistant note 'A2 rattle report, preset 23'; orchestrator memory feedback_deck_normalization; schemas/params/coupling.json

### engine.block_comb.artefact {#engine-block-comb-artefact}

- **Parameter:** (engine defect, not a lever) block comb at n x 750 Hz +- partial (48000 / 64 cycle)
- **Direction:** an HF energy spike at samples 0-2 of each engine block; independent of velocity (linear); grows with feedback and with order 2
- **Magnitude:** A2: 32 % of HF energy on 2 % of bins, comb 3-13 dB above neighbours; block ratio 1.7 / 7 / 10.5 at feedback 1 / 1000 / 12000; cycle 32 moves the spacing to 1500 Hz; about 25 % of the 8-14 kHz power on A2
- **Register:** all keys; most audible on bass keys at order 2
- **Side effects / interactions:** no parameter removes it (mode mass scales with the note; dispersion_damping 0 leaves the spike; muting modes masks only); inferred cause: the mode-to-string return held per cycle (fix in the engine, not the preset)
- **Confidence:** measured (cause inferred)
- **Source:** assistant notes 'Comb and attack report, preset 20', 'preset 21' (comb test), 'A2 rattle report'; piano fit report section 3

### engine.rattle_layer.artefact {#engine-rattle-layer-artefact}

- **Parameter:** (engine defect, not a lever) the A2 'rattle': uncorrelated noise above about 4 kHz scaling with note level
- **Direction:** present at order 2; order 1 lowers it about 30 dB (below the piano floor); identical renders correlate 0.15 above 4 kHz and 1.0 below 500 Hz
- **Magnitude:** A2 above 10 kHz -45 dB against the piano's -65; halving bending moved it about 3 dB; the layer starts about 4 kHz, is bass-wide (keys 21-50) and rises with the stiffness Courant number
- **Register:** bass; keys 46-48 share it
- **Side effects / interactions:** ruled out: unison detuning, half pedal, high modes, string dispersion damping, low modes; the carrier modes 193-195 also carry the real 2-8 kHz attack; sharper lighter 194 / 195 helped A2 but worsened C4 (rejected); per-key feedin is the only preset-side relief (-4 dB)
- **Confidence:** measured (source not located)
- **Source:** assistant notes 'A2 rattle report, preset 23', 'Keyboard extension report, preset 25'


## beating {#beating}

ripple of the fundamental's envelope (beating.depth_db / modulation_hz): unison chorus, 'fast first decay' that is really beating

### string.detuning.beating {#string-detuning-beating}

- **Parameter:** string.detuning (per-string tension offset of the unisons)
- **Direction:** up -> stronger / faster beating of the unison strings; a 'fast first decay' is often beating, not damping
- **Magnitude:** A2 0.002, C4 0.001, G4 0.0016 fixed A2's long tail; cost: C4 envelope swing 10.4 dB against the piano's 6.5. Earlier p45 .0027, p60 .0019, p67 .0028
- **Register:** all; rule per key in preset 25
- **Side effects / interactions:** pitch shift from the unison spread (not measured); too much detuning reads as a chorus
- **Confidence:** measured
- **Source:** assistant notes 'Belarus fit: A2 C4 G4 offline' ('key finding: fast first decay is unison beating') and 'thump_assistant_15 to 18'


## body {#body}

resonance of the soundboard modes: boom / boxiness in a band, mode-driven partial boosts shared across keys

### mode.frequency.body {#mode-frequency-body}

- **Parameter:** mode.frequency (Hz, small-angle parameter: plays sharp by about (pi f / sr)^2 / 6)
- **Direction:** moving a mode moves that body resonance / partial boost; placing spare modes in a gap fills it
- **Magnitude:** gap fill at 590 / 632 / 668 / 705 Hz (mass 3-8e-13, dec .09): A2 665 Hz need +19.8 -> +12.6 dB; C5-G5 level spread 7.7 -> 4.3 dB; no evidence that real modes exist there (placeholders, labelled)
- **Register:** the keys whose partials fall on the mode
- **Side effects / interactions:** modes are SHARED across keys: mode 9 mass 2.7e-12 gave A2 665 +1.7 dB but E5 +10.8 dB (rejected); placeholder rows keep the feedin of their old frequencies
- **Confidence:** measured
- **Source:** assistant note 'Belarus fit: A2 C4 G4 offline, envelope + gap fill'; schemas/params/mode.json

### mode.mass_inv.level {#mode-mass-inv-level}

- **Parameter:** mode.mass_inv (inverse mass coefficient; about 1e-12 in measured presets is normal)
- **Direction:** mass_inv up -> that mode responds more (louder band / partial boost); shared across every key that feeds the mode
- **Magnitude:** 'heavier modes on C4 / G4 third partials (mass 2.5e-11)': the third partials did not rise, G4 cloud better, C4 worse (neutral, left in); high modes mass / 3 with measured decrement + low modes x3 (preset 19); slots 46 / 51 / 56 at 1 / mass up to 5400 x old caused a composition defect (feedin -1 on C2) in BelarusNew2
- **Register:** the band of the mode; every key sharing it
- **Side effects / interactions:** 'parallel modes add paths and cannot filter': a flat feedthrough layer passes through any mode (a single 784 Hz mode carried it to 20 kHz); masses from the rig are the weakest measured number (log correlation 0.78 between recipes)
- **Confidence:** measured
- **Source:** assistant notes 'thump_assistant_15 to 18', 'Keyboard extension report, preset 25', 'Ver5/Ver6, composition defect found', 'Second piezo set 2026-11-01'


## stability {#stability}

CFL / Courant margin, crash-guard trips, clipping: the limits every lever must respect

### load.string_iterations.precision {#load-string-iterations-precision}

- **Parameter:** load setting string_iterations (FDTD sub-steps per sample: 8 or 16)
- **Direction:** more iterations -> finer grid, less numerical dispersion (negative B in the top octave at 8), a higher thump-string f1; fewer -> cheaper, more numerical artefacts
- **Magnitude:** thump string: at 16 iterations rho 8.14e-5 and f1 17.5 kHz, at 8 the thump is about 8.7 kHz and the levels above were measured at 8; keys 85-108 had negative inharmonicity at the fit settings
- **Register:** top octave most affected
- **Side effects / interactions:** structural (full reload); the preset's declared settings (Ver4 declares order 1 / 16 while tuned at 2 / 8) cannot be edited with any command (feature request 63ea6bb9e3a0fccd)
- **Confidence:** measured
- **Source:** memory note 'Keybed thump'; assistant notes 'preset 25', 'Reports 2 Nov: declared settings not editable'; SYNTHESIS_ENGINE 'Numerical precision: float32 and string_iteration'
