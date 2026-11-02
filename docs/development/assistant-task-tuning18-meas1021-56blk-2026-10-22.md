# Assistant task: Tuning18 + 10-21 measured modes, 56 blocks, 8 channels (2026-10-22)

The user's request (2026-10-22): *compose a preset based on yesterday's measurements that fits 56 blocks to run on
this system. Take Tuning18-10-26ver1 and replace the modes below 1 kHz with the measured ones, keep 8 channels,
remove the highest and lowest pitches to fit 56 blocks; channels with no measured exciter are zeros (muted).*

Everything below is supported by the tools as of PianoidBasic dev `d64373f` (dev-9cff): `string_removal:
"outer_keys"`, editor-saved base modes accepted by `build_preset`, measured channel weights kept on a channel change.
The recipe was dry-run on the real files: step 2 gives 224 strings / 56 blocks / 8 channels, keys 24–105.

Run the steps in order. Follow every `jobId` to its end (`job.*`). If a result differs from **Expect**, stop and report
it to the user instead of improvising.

## Step 0: check the output map {#step-0}

`system.snapshot` (or your context) must show `PIANOID_AUDIO_OUTPUT_MAP` = `8,9,2,3,4,5,6,7` (8 entries). An
8-channel preset is refused (409 `output_map_mismatch`) with a shorter map. If it is not 8 entries, stop and tell the
user: the map is a Windows user environment variable, read when the backend starts.

## Step 1: measured build {#step-1}

The builder needs all 88 keys, so the keys are removed only in step 2.

```json
modal.rig_process {"step": "build_preset", "run": "20261021T131618-full-6x7",
                   "build": {"name": "Tuning18-10-26ver1_meas1021", "base_preset": "Tuning18-10-26ver1", "n_modes": 196}}
```

**Expect:** `n_measured` 74, `n_base_kept_above_boundary` 122 (196 modes), structure 236 strings, 6 channels in the
measured order E1, E2, E3, E4, E6, E7 (E5 was not measured). Tuning18 stores its modes as mass / stiffness / damping
(the editor's save format); the builder converts them with the loader's own law.

## Step 2: fit to 56 blocks by dropping the outer keys {#step-2}

```json
preset.create {"name": "Tuning18-10-26ver1_meas1021_56blk_8ch", "base_preset": "Tuning18-10-26ver1_meas1021",
               "num_strings": 224, "num_channels": 8, "array_size": 512, "string_removal": "outer_keys"}
```

`outer_keys` removes whole piano blocks, the one holding the lowest remaining key first; each block pairs the lowest
key (1 string) with the highest (3 unison), so exactly those keys go and every other key and block stays as it was.

**Expect:** 224 strings, 56 blocks, 8 channels; `removed_strings` only from keys 21, 22, 23, 106, 107, 108. Channels
0–5 keep the measured weights E1, E2, E3, E4, E6, E7; channels 6 and 7 are new and are copies of E1 (not silent).

Do not touch the older file `Tuning18-10-26ver1_56blk_8ch.json` (a different preset).

## Step 3: load {#step-3}

```json
preset.load {"path": "presets/Tuning18-10-26ver1_meas1021_56blk_8ch.json", "array_size": 512,
             "string_iterations": 16, "sound_derivative_order": 1, "audio_driver_type": 4}
```

**Expect:** 200. A 409 `coop_launch_shortage` (the grid does not fit this GPU) or `output_map_mismatch` means the
load was refused and the current preset kept: report it.

## Step 4: put each channel on its output {#step-4}

Engine channel k plays on output `map[k]`. The weights of channel k are the `feedback` row of output pitch 128 + k
(the preset plays in strings mode, `listen_to_modes` 0).

| Channel | Pitch | Output | Wanted | After step 2 |
|---|---|---|---|---|
| 0 | 128 | Out 9 | E1 | E1 |
| 1 | 129 | Out 10 | E2 | E2 |
| 2 | 130 | Out 3 | E3 | E3 |
| 3 | 131 | Out 4 | E4 | E4 |
| 4 | 132 | Out 5 | zeros (no E5) | E6 |
| 5 | 133 | Out 6 | E6 | E7 |
| 6 | 134 | Out 7 | E7 | copy of E1 |
| 7 | 135 | Out 8 | zeros | copy of E1 |

In this order (each later step overwrites a row an earlier one has read):

1. `param.get {"parameter": "feedback", "key_no": "133"}` (E7) → `param.set {"parameter": "feedback", "key_no": "134", "values": <those values>}`
2. `param.get {"parameter": "feedback", "key_no": "132"}` (E6) → `param.set` the same values to `key_no` `"133"`
3. `param.set` `key_no` `"132"` to all zeros, same shape
4. `param.set` `key_no` `"135"` to all zeros, same shape
5. `param.get` 132, 133, 134, 135 again: 132 and 135 all zero, 133 = the old 132 (E6), 134 = the old 133 (E7).

## Step 5: save {#step-5}

```json
preset.save {"path": "presets/Tuning18-10-26ver1_meas1021_56blk_8ch.json"}
```

## Step 6: check and report {#step-6}

Play one note (key 60). Report the level, any clipping, and the output scale the engine re-derived. Then summarise the
file for the user: strings, blocks, key range (24–105), channels and their outputs, modes (74 measured below 1 kHz +
122 base above).
