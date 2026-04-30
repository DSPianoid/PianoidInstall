# Mode Physics & The 2026-04-30 `mass` → `mass_inv` Rename

## TL;DR

The Python attribute previously named `Mode.mass` was packed into the GPU as the
**inverse-mass coefficient** (`1/m`) — the kernel evaluates

```
q̈ + 2γq̇ + ω²q = mass_inv · F
```

not the textbook `F/m`. The Python identifier was renamed `Mode.mass` →
`Mode.mass_inv` to match the kernel's actual usage. **Numerical values are
unchanged.** Audio output is byte-identical pre/post rename. Preset JSON
files keep their `"mass"` key (not migrated; the loader accepts either name).

The UI now labels the field as `1/mass` so the inverted role is visible to
users editing modes.

## What changed (rename surface)

| Layer | Pre-rename | Post-rename |
|-------|-----------|-------------|
| Python attribute | `Mode.mass` | `Mode.mass_inv` |
| Mode SoA tuple | `(dec, omega, mass)` | `(dec, omega, mass_inv)` |
| `pack_for_interface('mode')` field | `mass` only | `mass_inv` (canonical) + `mass` (read-only legacy alias, same value) |
| `update_mode_params_GRANULAR` REST key | `mass` only | `mass_inv` (preferred) or `mass` (legacy, deprecation warning) |
| Frontend `Mode.jsx` field key | `mass` | `mass_inv` |
| Frontend label | `mass` | `1/mass` |
| Preset JSON key | `"mass"` | `"mass"` (NOT migrated — same value, loader accepts either) |
| C++ pybind arg name | `mass_values` | `mass_values` (kept for ABI; comment clarifies it carries `1/m`) |
| Kernel register | `mode_mass_inv` | `mode_mass_inv` (already correct, unchanged) |

## What did NOT change

- **The number stored in every preset, every GPU buffer, every kernel
  register.** Byte-for-byte identical. The rename is a name-only operation.
- **The kernel.** `MainKernel.cu` line 637 still reads
  `s_mode_applied_force[quarterNumber] * mode_mass_inv`. No CUDA rebuild
  required.
- **Preset files on disk.** Existing JSON presets keep `"mass"` keys. The
  loader (`Mode.__init__`) accepts both `"mass_inv"` and `"mass"` and stores
  the value into `self.mass_inv`. Newly-written presets via
  `pack_for_preset()` continue to emit `"mass"` for backwards compatibility
  with older Pianoid versions.
- **`Mode.fit_params` formulas.** The stiffness/damping derivations
  (`stiffness = mass_inv * (2*pi*f)^2`, `damping = 2*zeta*sqrt(k * mass_inv)`)
  preserve their pre-rename numerical output. In those expressions
  `mass_inv` plays the role of `m` because that's the calibration convention
  the entire preset library and the kernel coefficients depend on. Changing
  the formulas to "physically correct" (using `mass_inv` truly as `1/m`)
  would alter the SoA values packed for path 2 (preset path with
  mass+stiffness on disk) and path 3 (frequency-only seed) of `fit_params`,
  breaking audio output for every preset.

## Why we did NOT "fix the physics"

The relationship between the Python-side derivations and the kernel's actual
behavior has two equivalent interpretations:

1. **Python-correct view:** `Mode.mass` is the actual mass `m`. The kernel
   has a bug — it uses `m` where it should use `1/m`. The fix would be to
   patch the kernel.
2. **Kernel-correct view:** the kernel uses `1/m` correctly. Python's
   `Mode.mass` was a misnomer all along; it stores `1/m` (now renamed
   `mass_inv`). The Python-side stiffness/damping formulas are then "wrong"
   by SI standards but are calibrated to match the legacy presets.

We chose view (2) for the rename because:

- Every preset file on disk has its `mass` value calibrated to be packed
  verbatim into the kernel's `mode_mass_inv` register. Migrating presets
  would require rescaling thousands of mode entries across dozens of presets,
  with a lot of room for off-by-`(2πf)²` errors.
- Kernel coefficients (deck normalization, hammer scaling, force amplitudes)
  are tuned to balance the kernel's `mass_inv · F` magnitude. Patching the
  kernel to use `F/m` would invert all those coefficients.
- The user's directive was explicit: keep behavior unchanged, just clarify
  the naming.

A future rationalization pass that wants `Mode.stiffness` and `Mode.damping`
to be true SI quantities must rescale presets and kernel coefficients
together — out of scope for this rename.

## What the user sees

In the **Mode** parameter pane:

- Field labelled `1/mass` (canonical key: `mass_inv`).
- Editing it updates the kernel's inverse-mass coefficient. Numerical scale
  is the same as before; only the label changed.
- Stiffness and damping continue to be displayed read-only, recomputed
  client-side using the same formulas the backend uses (kept consistent so
  the UI doesn't lag the GET round-trip).

In REST (`POST /set_parameter/mode/<idx>` body
`{"<idx>": {"mass_inv": <value>}}`):

- Preferred key: `"mass_inv"`.
- Legacy key `"mass"` still accepted; the backend logs a one-shot
  deprecation warning per process.
- Same numerical value either way.

## Files touched in the rename

Python:

- `PianoidBasic/Pianoid/Mode.py` — attribute renamed throughout, both
  legacy (`'mass'`) and new (`'mass_inv'`) keys accepted in `__init__` and
  `update_params`. `fit_params` formulas verbatim; comments explain why.
- `PianoidCore/pianoid_middleware/parameter_manager.py` —
  `EDITABLE_MODE_FIELDS` accepts both keys; `mass_inv_values` packed for the
  GRANULAR upload. One-shot deprecation warning at the REST entry point.
- `PianoidCore/pianoid_middleware/pianoid.py` — `pack_for_interface('mode')`
  emits both `mass_inv` (canonical) and `mass` (read-only legacy alias).

Frontend:

- `PianoidTunner/src/components/Mode.jsx` — field key `mass_inv`, label
  `1/mass`. Legacy `mass` field hidden from rendering (it arrives as a
  duplicate from the backend's compat shim).
- `PianoidTunner/src/hooks/usePreset.js` — optimistic recompute reads
  `modeState.mass_inv` (with `mass` fallback). Same formulas.

Tests:

- `PianoidCore/tests/integration/test_mode_param_independence.py` —
  asserts `mass_inv` in GET payload, accepts legacy `mass` REST key,
  validates the editable/derived independence rule.

C++ comments only (no rebuild required):

- `PianoidCore/pianoid_cuda/Pianoid.cu` — comments updated to refer to
  `mass_inv` in the SoA layout. Function/variable names kept (`mass_values`)
  for ABI stability.
- `PianoidCore/pianoid_cuda/AddArraysWithCUDA.cpp` — pybind docstring at
  `getModeDisplacements` was already correct (`[..., mass_inv[0..N]]`); no
  change. Pybind arg name `mass_values` is kept.

Docs:

- `docs/modules/pianoid-cuda/SYNTHESIS_ENGINE.md` — ODE form, SoA layout
  table, and the running-vs-config buffer split corrected (the legacy 5-row
  doc had been stale since the preset-double-buffer split).
- `docs/architecture/DATA_FLOWS.md` — mode update flow refers to
  `mass_inv`.
- `PianoidCore/pianoid_cuda/COMPREHENSIVE_TECHNICAL_DOCUMENTATION.md` —
  layout comments updated.
- `docs/modules/pianoid-cuda/MODE_PHYSICS.md` — this page.

## Cross-references

- Kernel update equation: `docs/modules/pianoid-cuda/SYNTHESIS_ENGINE.md`
  → "Mode Simulation: Harmonic Oscillator".
- Mode SoA upload flow: `docs/architecture/DATA_FLOWS.md`
  → "2.3 Mode Parameters".
- REST surface for mode updates:
  `docs/modules/pianoid-middleware/REST_API.md`
  → `/set_parameter/mode/<idx>`.
