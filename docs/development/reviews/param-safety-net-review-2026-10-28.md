# Parameter safety net: review and port (dev-psafe1, 2026-10-28)

**Scope.** This is a review of Core `feature/backend-param-safety-net` @ `14fd5af` (dev-9a47,
2026-05-04), which never merged into `dev`. It was re-implemented on the current Core `dev` (`ce6f801`)
as `feature/dev-psafe1-param-safety-net`. This document lists every rule with its bound and the reason
for that bound. Each reason comes from the engine docs or from a measurement.

## 1. Where the check runs (one owner)

`dev` has changed since `14fd5af`. Every edit from every source now passes through **`edit_commit.commit`**
(SSOT I1). The original's wiring points have since moved or disappeared:

- the three payload walkers inside `ParameterManager.update_parameter`;
- the legacy `/set_mode_parameters` route, which was removed by dev-960f.

The port therefore puts the check one layer up:

| Stage | Owner | What it checks |
|---|---|---|
| `edit_commit.commit` → `param_safety.check_edit` | **param_safety** (new) | value domains (this review) |
| `parse_range` | backendServer | pitch / mode key ranges |
| `pitch_values.check_pitch_values` (dev-obuf1, unmerged) | pitch_values | coverage: every pitch of the range has a value |
| `mask_rows.check_deck_mask_rows` | mask_rows | mask row shape |
| `StringMap.update_deck` | PianoidBasic | feedin / feedback row length; validates every row before it writes any |
| `excitation_energy.normalize` | excitation_energy | hammer_mass `(0, 1]` kg, speeds `≥ 0`, `c > 0` |
| `runtime_params._apply_fields` | runtime_params | volume `0..127`, feedback coefficient `≥ 0` finite; **added**: volume_center / volume_range finite |
| `hammer_payload.hammer_edit` | hammer_payload | hammer field names |

`check_edit` runs after the read-only guard. It runs before `HISTORY.begin`, before `apply()` and before
the journal. A rejected edit therefore changes nothing in the model, the engine, the undo history or the
journal, and the tests pin this.

`parameter_manager.py` is untouched. It is locked by dev-elat1 and already 1001 LOC (RED).

Every write path is covered:

- REST and WS `set_parameter`, `set_string_excitation` and `set_hammer_shape`;
- assistant `param.set`, which calls REST `/set_parameter`;
- `/mute/*` and `/excitation_energy`;
- the calibration commits (HammerMassGain);
- MIDI CC and the pitch wheel;
- the auto-tuner and NoteTunner;
- the runtime "Set" fold;
- undo / redo, which goes through `apply_parameter_request` → commit.

A structural test asserts that every `param_manager` mutator call in the middleware is the `apply`
lambda of an `edit_commit.commit`.

**Preset load.** `POST /load_preset` calls `preset_error_for_path`. It builds the preset's model at the
requested `sample_rate` (StringMap + ModeMap, about 0.4 s, no GPU) and runs `check_model`. This happens
for every non-`hot` reload, **before** in-place re-init or teardown. On a failure the request gets a
`400` and the loaded engine keeps running, with no half-applied state. `POST /preset/load` (the library)
calls `check_model` before the GPU slot is created.

**Realtime path.** Nothing is added there. All checks run on request threads, and their cost is O(payload)
(`check_model` takes about 5 ms after the build).

## 2. Design rule (what counts as "catastrophic")

A value is rejected if at least one of these holds:

- **(N)** it is not finite;
- **(D)** the host or kernel arithmetic is undefined for it (division by zero);
- **(G)** it makes a resonator grow instead of decay;
- **(P)** it is outside the definition of a quantity that is positive by definition (a density, a
  length, a width, a ratio).

There are **no magnitude caps**, per the dev-2706 directive that neither the UI nor the backend clamps
ranges. The FDTD Courant/CFL stability of a positive-tension string remains an **indication**, never a
rejection (user decision 2026-07-08, PARAMETER_SYSTEM "Host-Side CFL"). The string sign rules below are
type (P) and (G) domain rules, not Courant rules. **The user should confirm them against the 07-08
directive.**

## 3. Rules: kept, changed, added, dropped

The *Presets* column gives the extreme value found in the 49 loadable presets. The scan covered
`PianoidCore/pianoid_middleware/presets`, recursively, including the untracked user presets in the
main checkout. `PresetsFromFpga` contains no JSON presets.

| # | Rule | Status | Bound | Justification | Presets (extreme) |
|---|---|---|---|---|---|
| 1 | any numeric leaf | **kept, widened** | finite (also numeric strings `"nan"`; owners `float()` them) | (N) NaN/Inf survive the float cast into GPU buffers | all finite |
| 2 | mode `mass_inv` | **kept, reason corrected** | `> 0` | The original's reason, "division-by-zero in mode update", is **wrong**: the kernel *multiplies* force × mass_inv (MODE_PHYSICS.md). Real reasons: (G/P) a negative inverse mass inverts the force on the soundboard, turning the passive string↔mode loop active. (D) `0` divides by zero in `fit_params`' legacy mass + stiffness path `f = √(k/mass_inv)/2π`. *Not measured on the engine (build lock); see §6.* | min 1.1e-19 |
| 3 | mode `frequency` lower | **changed** `< 0` → `≤ 0` | `> 0` | (G) The recurrence (pianoid-basic OVERVIEW "Piano_mode") has `dec = decrement·f/sr`. At `f < 0`, `dec < 0` and the mode grows. At `f = 0`, `ω = 0` and `dec = 0`: a double root at z = 1, an undamped integrator that drifts under force and that no decrement can damp | min 44.45 Hz |
| 4 | mode `frequency` upper | **added** | `≤ sr/π` (15 279 Hz at 48 kHz) | (G) Roots are `(1−dec)e^{±iθ}`, `cos θ = 1 − ω/2`, `ω = (2πf/sr)²`. `ω ≤ 4 ⇔ f ≤ sr/π`, which is the played Nyquist (`acos(1−ω/2)·sr/2π = sr/2`; `gpu_mode_frequency` maps any played f ≤ Nyquist into `[0, sr/π]`). Above it the roots are real with magnitude `> 1`. The bound is inclusive. It follows the **load** sample rate: F15 (9457 Hz) loads at 48 kHz but is refused at 24 kHz (tested) | max 0.619·sr/π |
| 5 | mode `decrement` | **kept** | `≥ 0` | (G) negative damping means `1 − dec > 1`, so the mode grows | min 0.027 |
| 6 | mode `dec = decrement·f/sr` | **added** (cross-field, prospective state) | `< 1` | (G) The per-sample factor `(1−dec)` must lie in `(0, 1]`. `dec ≥ 1` flips the sign every sample, and `dec > 2` diverges. The FPGA converter's `dec = 1 − e^{−γ/sr} < 1` by construction. A `frequency` edit can trip it, and the error names the edited field | max 0.66 |
| 7 | excitation `sigma` | **kept, reason corrected** | `> 0` | (D) Force `exp(−0.5((x−mu)/σ)²)`: at `σ = 0` it is `0/0 = NaN` at the pulse centre, and the host `level_impulse` → coefficient is NaN (the `temporal = 0` guard does not catch NaN). For `σ < 0` the formula is numerically the same as `|σ|`, so this is a (P) rule only: a width can't be negative. The original's "division by zero" holds only for 0 | min 0.0076 (piano), output pitches 1.0 |
| 8 | excitation `volume`, `shift`, `mu` | **not ruled** (finite only) | — | FPGA presets store **negative** Gaussian volumes (22 898 cells). A sign rule would reject `Belarus_8band_196modes_FPGAexc` and others. `shift ≥ 1` only silences a component, and `mu` outside the 8 ms window only truncates | volume −0.54…6.15 |
| 9 | gauss level key / curve key | **added** | level `0..127`, curve `0..4` | (D) `load_from_dict_to_matrix` writes `levels_matrix[level, :, curve]` (128, 4, 5) in place. Level 128 raises IndexError **half-way** (partial write), and level −1 silently writes level 127 | — |
| 10 | string `rho` | **added** | `> 0` | (D) T and B divide by rho (cfl_stability `_coeffs`, `Pitch.get_coefficients`). Measured: `rho < 0` gives `max|g| = 1.47` | min 0.00436 |
| 11 | string `length`, `dx` | **added** | `> 0` | (D) `dx = length/main`. The coefficients divide by `dx²` and `dx⁴`, and `c2dec = disp_decay/(2·dt·dx²)` | min 0.068 m |
| 12 | string `tension` + `tension_offset` | **added** | `> 0` on every unison string `tension·(1+i·offset)` | (P) A string carries tension. Stored vs effective: the engine packs the per-string tension (`amp_for_pitch_strings`). Measured: tension 0 or −1 is numerically **stable** (`max|g| = 0.999997`, held by bending), and −650 gives 1.25. So this is a domain rule, not a stability rule. **Confirm with the user** | min 478.5 N, offset ≥ 3.6e-5 |
| 13 | string `gamma` | **added** | `≥ 0` | (G) Measured `max|g|` = 1.000005 at −1 and 1.00052 at −100 (grows). (D) at `gamma = −1/dt`, `dec_inv` divides by zero | min 0.032 |
| 14 | string `disp_decay` | **added** | `≥ 0` | (G) Measured `max|g|` = 1.000058 at −3.2e-14 and 1.0019 at −1e-12 | min 2.2e-15 |
| 15 | string `damper_string`, `damper_tail` | **added** | `≥ 0` | (G) A damper term subtracts energy; a negative one adds it (`damper_tail` multiplies `damper_string`, SYNTHESIS_ENGINE "Damper multiplier") | min 7.4e-10 / 3e-6 |
| 16 | string `r` | **added** | `≥ 0` | (P) a radius; `r = 0` is an ideal string (measured stable). `r < 0` is numerically the same as `|r|` (r⁴) | min 0.0003 |
| 17 | string `jung` | **not ruled** | — | **Every** shipped preset stores jung negative (−1.2e10…−1.8e13). Both signs measured stable | all < 0 |
| 18 | string / physics `hammer_mass` | **added** | `> 0` | consistency with the existing owner bound of `/excitation_energy` (`(0, 1]` kg). The 1 kg cap is not copied (no magnitude caps) | min 7.5e-5 |
| 19 | hammer `position` (ratio) | **added** (atomic copy of the owner bound) | `[0, 1]` | `Hammer.set_params` raises `EnvironmentError` **after** writing the attributes, so the edit was half-applied | 0.07–0.47 |
| 20 | hammer `sharpness` | **added** | `[0, 1)` | (D) `radius = width / sin(acos(sharpness))`: 1 divides by zero, and outside [−1, 1] acos raises (after the model write) | all 0.5 |
| 21 | hammer `width` | **added** | `≥ 0` | (P) a width (the owner floors small widths to `3·dx`) | min 0.0044 |
| 22 | `sound_channel` / `string_sound_channel` row | **added** | exactly the stored row length (`num_channels`) | REST_API "Parameter key spaces" (measured `[num_channels]`). The dispatcher stores `np.array(row)` unchecked, so a wrong length breaks the next pack | — |
| 23 | preset model (load) | **added** | rules 1–21 on every real mode / piano pitch; deck and SC rows finite; `hammer_speeds ≥ 0`, `excitation_impulse_calibration > 0`, `deck_feedback_coefficient ≥ 0` | a bad file used to tear the engine down before failing | all pass |
| 24 | runtime `volume_center`, `volume_range` | **added** | finite | (N) They reached `RuntimeParameters` unchecked | — |
| — | `/set_mode_parameters` wiring | **dropped** | — | route retired by dev-960f (B1) | — |
| — | WS `code: "parameter_range_error"` | **changed** | `parameter_out_of_range` + structured body | one code for REST and WS, in the same shape as `invalid_mask_row` / `missing_pitch_values` | — |

**Output pitches (≥ 128)** are exempt from rules 7, 10–21, because their placeholder physics stores
tension, r, length and gamma as 0 in every preset. They still get rule 1.

## 4. Preset scan

- **49 / 49** loadable presets pass `check_model` and `preset_error_for_path`. This is the parametrised
  test in `tests/unit/test_param_safety.py` (tracked presets) plus the same scan over the main checkout,
  which includes the untracked `Tuning18-10-26ver1_work_assistant_*`.
- **No preset would fail.**
- `IversPond_ESPRIT_128modes.json` cannot be built at all. ModeSoundChannels raises "Illegal number of
  channels 0". This is pre-existing and unrelated to the safety net; the test skips it explicitly.
- `Apr_13/*.json`, `menzura*.json` and `note_frequencies.json` are not presets.

## 5. Overlap with dev-obuf1 (`pitch_values.py`, Core `19474b3`, unmerged)

The two checks are complementary and never contradict each other:

- `check_pitch_values` raises `400 missing_pitch_values` for a pitch of the range that is absent from
  `values`.
- `check_edit` only walks the keys that are present.

Order: `check_edit` runs first, in commit. `check_pitch_values` runs inside `ParameterManager`, still
before any write. A payload that has both faults reports the domain error first.

Merge conflict to expect: one adjacent hunk in `backendServer.set_parameter`, where both branches add
an `except … as e: return jsonify(e.body()), 400` clause. Resolve it to
`except (MaskRowError, MissingPitchValues, ParameterRangeError)`.

Recommended follow-up (not done here): move the coverage and shape checks (`pitch_values`,
`mask_rows`) next to `check_edit` as one pre-commit validation stage. Each would keep its own module,
and the stage would have a single caller.

## 6. Not done / open

- **Engine measurement of `mass_inv < 0`** (live loop runaway) was not run. A coordinator-announced
  heavy rebuild holds the `.pyd`. Rule 2 rests on MODE_PHYSICS plus the `fit_params` division.
- **Bulk raw GPU uploads** pack the already-validated model. They are not a user-value path and are
  out of scope.
- A wrong-length feedin / feedback row still answers `416` (owner: `StringMap.update_deck`, which is
  atomic). Mapping it to `400` is a follow-up.
- The WORK_IN_PROGRESS item "Backend parameter safety net (post dev-2706)" (it says "FIXED" and
  "unmerged") should be updated at merge.

## 7. Verification

**Unit tests.** `tests/unit/test_param_safety.py` passes 76, with 1 skip (IversPond). It covers:

- the per-rule cases;
- the commit order;
- the structural write-path test;
- 11 REST routes and WS `set_parameter`;
- `/load_preset` and library load;
- the 49-preset scan.

The neighbouring unit files (the baseline subset of 238) still pass. A broad `tests/unit` run (ESPRIT
excluded) shows 6 failures that also fail on the unmodified base `ce6f801`: `start_right_away` ×4,
`command_registry`, `rig_pipeline`. They come from the test environment and schema dir.

The broad run found **one real bug in the first port**. The FE sends `sample_rate: 48` (kHz), and the
preset check treated it as Hz, which would have refused **every** APPLY. The fix reuses
`preset_load_params._hz`.

**Live run.** Isolated backend on `:5017`, audio off, `BaselinePreset1` loaded with `sample_rate: 48`.
Script: `docs/development/diagnostics/dev-psafe1-live-verify.py`. Result: **14 / 14 PASS**.

- Bad writes, each answering `400` with the right `field` and an unchanged GET model value:
  - mode `decrement` / `frequency` / `mass_inv`;
  - string `gamma` / `rho` / `tension` = NaN;
  - gauss `sigma`;
  - hammer `sharpness`;
  - `/set_string_excitation` sigma;
  - `/excitation_energy` NaN speed.
- After every bad write, the `note_playback` render matched the baseline within 5× the measured
  render-to-render noise (rel diff 1.9–2.6e-4, tolerance 1.3e-3).
- A good write (`gamma` ×3) applied: the render moved 0.034 relative. Restoring it brought the render
  back to the baseline.
- A bad preset load (mode 3 `mass = −4e-7`) gave `400` (`mass_inv`, mode 3). The loaded engine kept
  running (health `idle → idle`, render unchanged).

**Side finding.** `note_playback` renders of the same state are **not bit-identical**. Back-to-back
renders differ by about 2.5e-4 relative, from sample 48 onwards. This contradicts the "deterministic"
wording in UI_TESTING, and should be investigated separately.

## 8. User decision and the rule table (dev-psafe2, 2026-10-28)

User decision (verbatim): *"Approve all, but make it mutable for every parameter with uniform
implementation and management."* All rules of §3 are approved, `tension > 0` (every unison string)
included; no sign rules on `jung` / `volume` and no magnitude caps, on purpose.

Implementation (Core `feature/dev-psafe2-param-rules`):

- **One declarative table**: `pianoid_middleware/param_rules.json` (versioned). One record per parameter
  of the parameter inventory (`schemas/params`, pinned by a completeness test) plus the global `finite`
  rule. Each record: `id`, `family`, `parameter`, `field`, `kind` (`finite` / `bound` / `relation` /
  `shape`), `min` / `max` + inclusive flags (or `check` + `expression` for a relation / shape),
  `targets` (payload addresses), `scope`, `enabled`, `reason`. Parameters without a physical rule get a
  finite entry.
- **One evaluator**: `param_safety.evaluate` flattens a payload / model into leaves and runs the enabled
  rules in table order. The only named code is the relation / shape registry (`mode_frequency_over_nyquist`,
  `mode_decay_per_sample`, `unison_tension`, `row_matches_num_channels`), each referenced from the table.
- **One owner**: `param_rules.RuleTable` merges the defaults with the user's overrides (persisted in the
  git-ignored `<PianoidInstall>/param_rules_overrides.json` / `$PIANOID_PARAM_RULES`, the MIDI-settings
  pattern), validates changes, logs them and serves REST (`GET /param_rules`, `PUT /param_rules/<id>`,
  `POST …/reset`). Disabling `finite` is allowed but warned.
- Rejections keep the §1 body and add `rule` (the id, also in the message). The Tunner dialog (Settings →
  Parameter rules) and the assistant (`param.rules`, view) read the same table.

Semantics that changed slightly with the table:

| Case | psafe1 | psafe2 |
|---|---|---|
| `tension` itself | a separate `> 0` rule + the unison check | one relation `string.tension` over every unison string (string 0 blames `tension`, the others `tension_offset`) |
| a bound rule on a non-finite value | the bound failed too | bounds judge finite values only; NaN / Inf is the `finite` rule's (so disabling a bound never lets NaN through) |
| runtime `volume_center` / `volume_range` | hard-coded in `runtime_params` | `runtime.*` finite entries (every runtime field) |
| load settings | not checked | `load_settings.*` finite entries, checked by `/load_preset` |
| a complex fit `frequency` (negative `mass_inv`) with `mode.mass_inv` **disabled** | rejected as "not a real number" | not judged (the user disabled its cause) |

Range checks moved into the table (coordinator follow-up, 2026-10-29, "no parallel check"):
`excitation_energy.normalize` (`hammer_mass` `(0, 1]` kg → `excitation_energy.hammer_mass` max 1;
speeds `≥ 0`; `c > 0`), `runtime_params` (volume `0..127` → `runtime.volume`; `feedback` direct
coefficient, `feedback_coeff`, `store_feedback_coeff` `≥ 0`; the `amplitude_limit` finite check) and
`set_fix_velocity` (level `0..127` → `fix_velocity.level`). Those owners now check payload shape and type
only. Sound-channel row length had no other owner (already table-only). Row shape of feedin / feedback /
masks (`StringMap.update_deck`, `mask_rows`) and pitch coverage (`pitch_values`) stay with their owners:
they are structural, not value domains. Radiance fields (`radiance_mono` / `radiance_stereo`, dev-rad1)
did not exist on Core yet: add `bound min 0` entries when they land.
