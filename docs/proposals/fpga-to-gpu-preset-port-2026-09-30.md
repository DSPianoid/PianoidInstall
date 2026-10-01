# FPGA → GPU Preset Port: Algorithm Comparison and Mapping (Elyashev F_15)

**Date:** 2026-09-30
**Status:** ANALYSIS + DRAFT CONVERTER, revised with batch 2 (§10), batch 3 / host program (§11), and Dima's answers (§11.8). Nothing has been loaded into the engine. No engine, source or preset edits were made.
**Author:** `/analyse` sub-agent
**Predecessor:** [FPGA Preset Excitation Loader (archived 2026-06-05)](archive/fpga-preset-excitation-loader-2026-05-17.md). It covered the excitation files only. This document covers the whole preset and **challenges one of its conclusions** (§4.3).

**Inputs.** Two mails from Dima Elyashev, forwarded 2026-09-30. They are saved read-only under `PresetsFromFpga/elyashev-2026-09-30/`:

| File | What it is |
|---|---|
| `algorythm.c` | A C sketch of the string update `Calc_pianoid()`: the reference formula, not production code (§1.7) |
| `test_mashinka_mapp_4.slx` | Xilinx System Generator model, Simulink R2020b, target `xcvu9p` (Virtex UltraScale+) at 100 MHz. It holds a **test bench**: one 4-note string engine ("mashinka"), the Gaussian exciter, and a stub for the mode coupling |
| `Coeff_converter_0.slx` | A decoder model that shows the **fixed-point format** of the preset ROMs (raw integer → value) |
| `F_15.rar` → `unpacked/F_15/F_15/*.txt` | The preset: 53 text tables, same schema as `PresetsFromFpga/Bl_Apr_19/` (the earlier dump) plus a new `ttn_micro.txt` |

**Batch 2 (received 14:10 UTC, after our questions went out).** Three more files are saved under `PresetsFromFpga/elyashev-2026-09-30/batch2/`: `Coeff_converter.m`, `mapp_4_fir_4_str.slx` and `Pitch.txt`. The mail body was empty. The findings are in **[§10 Batch 2 findings](#10-batch-2-findings-2026-09-30-1410-utc)**. **§10 supersedes §1.4, §6 and §7 where they conflict.**

**Batch 3 (14:35 UTC): the host program.** See **[§11](#11-batch-3-the-host-program-2026-09-30-1435-utc)**. It **settles the exp_all order**: `[e, d, a]`, so the production FPGA loader has **μ and σ swapped**. It also corrects the §1–§10 reading of `others.txt[5]`, which is the output volume, not the step rate. **§11 supersedes all earlier sections where they conflict.** **Dima's answers (16:03Z) are in [§11.8](#118-dimas-answers-2026-09-30-1603z-relayed-via-telegram-and-what-they-change)**: the send-all path is authoritative, the clock is 393.216 MHz, and F_15's Pitch.txt is missing from the archive. **§11.8–§11.10 supersede the step-time, rate and feasibility statements in §11.2–§11.7.**

Both `.slx` files were read by unzipping them and parsing `simulink/systems/*.xml`. The netlists were collapsed to dataflow, with Delay and Register blocks folded into `z^-n`.

**How sure each claim is.** Every claim carries one of these labels:

| Label | Meaning |
|---|---|
| **[RTL]** | Read directly from the Simulink netlist or the C file |
| **[DOC]** | Stated by the GPU project docs |
| **[DATA]** | Measured from the F_15 tables |
| **[INF]** | Inferred, and consistent with RTL, DOC and DATA |
| **[GUESS]** | A guess |

---

## 1. FPGA algorithm (what the code and models compute)

### 1.1 Architecture and timing

| Item | Finding | Label |
|---|---|---|
| Device / clock | Xilinx `xcvu9p-flga2104-2L`, `sysclk_period = 10 ns` (100 MHz) | [RTL] |
| Datapath arithmetic | IEEE **single-precision float** for the whole string update (43 float blocks with `exp_bits=8`) | [RTL] |
| Parameter storage | **24-bit fixed point** for per-string parameters, **32-bit** for per-mode parameters (§1.6) | [RTL] |
| String engine ("mashinka") | Processes the points of several strings **sequentially, one point per clock**. The counter runs to `num_str0 × 256`, so the maximum is **256 points per string**. String state lives in BRAM: `A1` = u(t), `B3` = u(t−dt), `B2` = curvature at t−dt | [RTL] |
| Strings per engine | 4 note addresses per engine (`nota_0_0..3`). This test instance covers the notes whose addresses satisfy `91 < addr ≤ 95` | [RTL] |
| FDTD step rate | `others.txt[5] = 196078.431` = 1e8/510, so dt ≈ **5.1 µs** | [INF] |
| Audio sample rate / decimation | Not in the files. 196078/4 = 49 019.6 Hz fits the numbers, but that is a guess | [GUESS] |
| Parameter upload | Serial command receivers (`Reciever16/50`: `sdat/clk/frm`). Commands include `CMD_pedal`, `CMD_nl`, `CMD_fb`, `CMD_gain`, `CMD_reset`, and memory writes to each table (`CMD_ind_vol`, `CMD_ind_mult*`, `CMD_ci_Re_9`) | [RTL] |

### 1.2 String model: explicit FDTD on a stiff, damped string (same family as the GPU)

`algorythm.c` and the `STRINGS0` netlist compute the same update. I traced the pipelined taps: the second difference `sd` has taps at t−30/31/32, and the fourth difference `fd` has 1/−4/6/−4/1 weights at t−42…46.

```
sd1[i] = u1[i-1] + u1[i+1] - 2 u1[i]                          (curvature)
fd1[i] = u1[i-2] + u1[i+2] - 4(u1[i-1]+u1[i+1]) + 6 u1[i]     (4th difference)
ff     = Tn * sd1[i]  -  Disp * fd1[i]                        (elastic force; Tn = c²dt²/dx², Disp = EI/ρ·dt²/dx⁴)
u2[i]  = ( 2u1[i] - u0[i] + Dec*u0[i] + force*SHAPE[i] + ff  +  β*(sd1[i]-sd0[i]) ) * ddiv
```

| Term | FPGA | Label |
|---|---|---|
| Time scheme | Explicit 3-level leapfrog. Damping is centred: `(2u1 − u0 + d·u0)/(1+d)` | [RTL] |
| Velocity damping `Dec` | `Dec = Do + (Dc − Do)·pedal/128` when no key is held; `Dec = Do` while the key is down (n_n flag). `Do`/`Dc` come from `decr_op`/`decr_cl` | [RTL] |
| `ddiv` | **`1 − Dec`**, a first-order stand-in for `1/(1+Dec)`. For Dec ~1e-5 the error is 1e-10 | [RTL] |
| Bending (`Disp`) | In the C file: yes. **In `test_mashinka_mapp_4` the Disp multiplier is wired to a constant 0** (`float 3 = 0`), so the test model has no stiffness | [RTL] |
| Frequency-dependent damping `β·∂t(y_xx)` | In the C file: a placeholder, `beta_dx_kv = 0.1·beta/dt²`. **In the test model the multiplier is constant 0** (`float 11 = 0`). The `Disp_decr` input is unused | [RTL] |
| Hammer force | `force(t) × SHAPE[i]`. `SHAPE` comes from a 512-deep RAM `shape2`. In "noise mode" (vol > 127) it is replaced by a single-point impulse at `point_noise` | [RTL] |
| Tail / termination zone | From point index `sdvig` (per string) to the end of the string, the parameter set switches: `Dec → Damper`, `ddiv → 1 − Damper`, `Tn → ttn_end` (slot "1−Nl", u·2⁻²¹) | [RTL] |
| Bridge boundary | Past `sdvig`, the value written back is `LASTX_k`, a displacement imposed from outside (the soundboard). **In the test bench `LASTX0..3` = 0** | [RTL] |
| Bridge force output | `Force_nota_k` = the sum of `ff` at two points 5 samples apart, latched when the point index equals `sdvig`. The C file uses the same idea: `force_last_point_temp = ff` | [RTL] |
| C-file boundaries | `boundaries=0`: 2 clamped points at each end. `=1`: `u[0] = −u[2]`, `u[1] = 0` (simply supported) | [RTL] |

### 1.3 Excitation (hammer): a Gaussian sum per note, time-scaled

The netlist chain is `Mid_Graph1 → Exp → exp-mashinka → gauss0..3`.

```
t_note(n+1) = t_note(n) + ind_mult(pitch, vel) * ind_mult_multiplier      (u30 accumulator, stops at 1e9)
g_k(t)      = a_k * exp( -min( e_k * ((t - d_k)/2^29)^2 , 30 ) )          k = 0..3  (4 Gaussians in the RTL)
F(t)        = ind_vol(pitch, vel) * Σ_k g_k(t)
```

| Item | Finding | Label |
|---|---|---|
| Gaussian parameters | `a` (s·2⁻²⁴), `d` (enters **linearly** as `t − d`), `e` (s·2⁻¹⁸, multiplies `(t−d)²`). So `e` is `1/(2σ²)` in time-counter units | [RTL] |
| Velocity layers | 5 tables per parameter (`exp_x0..4`, `ind_vol_0..4`, `ind_mult_0..4`) at internal velocities **0, 32, 64, 96, 128**. Linear interpolation: `T[k] + (T[k+1]−T[k])·(v & 31)/32` with `k = v >> 5` | [RTL] |
| Velocity curve | `velocity.txt` (128 entries, monotone 0→127) maps MIDI velocity to the internal 7-bit velocity | [INF] |
| Time scaling | `ind_mult` is the **increment of the note's time counter**. A larger value runs the pulse faster, which divides both centre and width. This confirms the documented `set_time_scale` semantics | [RTL] |
| Loudness | **No normalisation.** The absolute amplitude is `ind_vol × a_k` for each (pitch, velocity) | [RTL] |
| Other paths | `FF_stuk` ("knock": the same Gaussians × a second `Vol_stuk` bank) exists, but its output is unused in this bench. `noise_gen` is used when vol > 127 | [RTL] |
| Note-on | `nn = vol > 0`. The per-note `n_n` flag holds the damper open while the key is down | [RTL] |

### 1.4 Soundboard modes and coupling (only a stub in this bench)

The provided model contains **no mode oscillator**. The root level multiplies the summed bridge force of the engine's notes by a per-mode coefficient streamed from a 512-deep float RAM (`ci_re_9`, `CMD_ci_Re_9`). That computes `F_mode[m] = Ci[m] · Σ F_bridge` and then dead-ends in a register.

- The **mode update equation, mode sample rate, and `LASTX` feedback path are not in the delivered files**.
- What is known about modes comes only from the data: 256 modes with a frequency, a "Mass" and a "Q" code each (§2).

### 1.5 Coeff_converter_0: the raw → value fixed-point formats

`Coeff_converter_0.slx` does **not** convert physics into coefficients. It is a readback and inspection model. Counters sweep ROMs initialised from the preset variables, and each word is reinterpreted as fixed point and converted to float:

| ROM (initVector) | Depth | Word | Decode | Label |
|---|---|---|---|---|
| `ttn`, `disp`, `decr_op`, `decr_cl`, `decr_disp`, `damping` | 88 | u24 | `signed24(raw) / 2^24` | [RTL] |
| `omega_coef`, `Mass` | 256 | u32 | `signed32(raw) / 2^31` | [RTL] |
| `Q` | 256 | u32 | `signed32(raw) / 2^31`. **The ROM is initialised with `omega_coef`, not `Q_coeff`**, which looks like a copy/paste slip | [RTL] |
| Constant `18460.73714` | | u24 | Unconnected | [RTL] |

The MATLAB script that turns the `.txt` values into these workspace variables was **not delivered**. It would also define `num_str*`, `nota_*`, `prm0`, `CMD_*`, `ind_mult_multiplier`, and `shape2`. See §2.2 for which `.txt` files look like raw codes and which look like engineering units.

### 1.6 Per-string parameter RAM (`PARAMETERS` subsystem)

The RAM is laid out **parameter-major**: `addr = slot × num_str + string`. There are 12 slots. The test initVector confirms the order.

| Slot | Name | Used in the test bench | Likely F_15 source |
|---|---|---|---|
| 0 | `Tn` (tension coefficient) | yes | `ttn.txt` [INF] |
| 1 | `Fo` | no | ? |
| 2 | `Do` (damping, damper open) | yes | `decr_op.txt` [INF] |
| 3 | `Dc` (damping, damper closed) | yes | `decr_cl.txt` [INF] |
| 4 | `Sdvig` (index of the first tail/termination point, u9) | yes | **unknown**. `shteg.txt` goes negative, so it cannot be u9 [GUESS] |
| 5 | `FB` (feedback gain) | no | `FB.txt` [INF] |
| 6 | `Disp` | no (multiplier = 0) | `disp.txt` [INF] |
| 7 | `Disp_decr` | no | `decr_disp.txt` [INF] |
| 8 | `Damper` (tail decrement) | yes | `damping.txt` [INF] |
| 9 | `point_noise` | yes (noise mode) | ? |
| 10 | `NL` | no | `NL.txt`? [GUESS] |
| 11 | `1−Nl` → `ttn_end` (tail tension, u·2⁻²¹) | yes | `ttn_tails.txt` (identical to `ttn.txt` in F_15) [GUESS] |

### 1.7 Update order per step

1. `Mid_Graph1` sweeps the 96 note slots and produces `F(t)` for each active note. Each note's time counter advances by `ind_mult`.
2. Each mashinka sweeps all points of its strings. It reads u1 and u0, computes `sd`, `fd` and `ff`, and writes u2.
3. Points past `sdvig` use the tail parameters and the imposed `LASTX` displacement.
4. The bridge force (`ff` at the termination) is latched per string.
5. **Not in the files:** the mode update and the feedback into `LASTX`.

`algorythm.c` is a sketch and should not be run as-is:
- The final loop uses `if (i = 179)` / `if (i = 180)`, which are assignments, not comparisons. As written the loop never terminates.
- `dec_Q`, `I0`, `div_dx_kv` and `str_td*` are unused.
- The β term is written as a Russian comment ("time derivative of the second spatial derivative"). The file encoding is cp1251.

---

## 2. FPGA preset data (F_15)

### 2.1 Structure

Rows are **key 0..87 = MIDI 21..108** unless stated otherwise [DATA] (`Notes_freqs.txt` starts at 27.5 Hz; the earlier documented loader uses the same convention).

| File | Shape | Meaning | Units / scaling | Label |
|---|---|---|---|---|
| `exp_all.txt` | 6600 = (5 lvl, 88 key, 3 param, 5 gauss), C-order | Gaussian exciter parameters. Param 2 = amplitude `a`. Params 0 and 1 are {`e`, `d`} or {`d`, `σ`}: **disputed, §4.3**. Gauss slot 4 ≈ slot 1 (spare) | Documented decode: p0 → `1.28/√p0` ms, p1 ms, p2 dimensionless. F_15: p0 ∈ [0.11, 5.2], p1 ∈ [0.046, 0.44], p2 ∈ [−0.001, 0.98] | [DOC]+[RTL] |
| `ind_vol_0..4.txt` | 5 × 128 (rows 0..87 used; row 88 carries a known artifact) | Amplitude multiplier per (key, level) | Float multiplier (F_15: 0.19–6.2). In the RTL it is s·2⁻²⁴, so the tool must scale by 2²⁴ | [RTL]+[DATA] |
| `ind_mult_0..4.txt` | 5 × 88 | Increment of the time counter per (key, level) | × `ind_mult_multiplier` (unknown) | [RTL] |
| `velocity.txt` | 128 | MIDI velocity → internal velocity | 0..127 | [INF] |
| `ttn.txt`, `ttn_tails.txt` | 88 | Tension coefficient `Tn` (tail = identical) | Very likely a **raw code**: `Tn = raw/2^24` (A0 = 6.4e-4, C8 = 0.027, inside the CFL limit) | [INF] |
| `ttn_micro.txt` | 88 | New in F_15. Unknown (micro-tuning?) | ? | [GUESS] |
| `disp.txt` | 88 | Bending coefficient `Disp` | raw/2^24 | [INF] |
| `decr_op.txt` / `decr_cl.txt` | 88 | Damping per step, damper open / closed | raw/2^24, which gives γ = raw/2²⁴·196078: **0.086–1.09 s⁻¹ open, 1.8–3.7 s⁻¹ closed**. Plausible decay times | [INF] |
| `decr_disp.txt` | 88 | Frequency-dependent damping β | raw/2^24 | [INF] |
| `damping.txt` | 88 | Tail-zone decrement (`Damper` slot) | raw/2^24 → γ ≈ 19–38 s⁻¹ | [INF] |
| `FB.txt` | 88 | Per-note mode→string feedback gain (mostly 160, up to 8860) | ? | [GUESS] |
| `shteg.txt`, `del.txt`, `dt.txt`, `width.txt` | 88 | Bridge ("shteg") position, delay, per-note dt(?), hammer width(?) | Unknown. `dt.txt` spans 1.17 → 865 | [GUESS] |
| `Shape_512.txt` | 512 × 88 | Hammer spatial shape per key. The upper-treble columns are empty. The two 256-row halves differ (a second string? the knock shape?) | Peak 1.0, s·2⁻²³ in RTL | [INF] |
| `Shapee.txt` | 256 × 88 | All zero | | [DATA] |
| `omega_coef.txt` | 256 | **Mode frequency, Hz** (45.55 → 9826, ascending) | Hz. The ROM decode (/2³¹) implies a further tool conversion | [DATA]+[INF] |
| `Mass.txt` | 256 | Mode "mass" (0.33–1141) | Unknown scale | [GUESS] |
| `Q_coeff.txt` | 256 | Mode damping code. `Q/2³⁴` ∈ [1.0, 1.944] and saturates at 1.9444 above ~3 kHz | Unknown. The legacy `Mode.load_modes_from_txt` formula gives decrement ~1e5, which is **nonsense** | [DATA] |
| `Ci_coef_cos.txt` | 176 × 256 (rows 0..87 = keys, 88..175 = 0) | **Deck feed-in**: mode shape at each key's bridge point, **signed**, \|max\| 0.58. 240 of 256 modes are non-zero | dimensionless | [DATA] |
| `Ci_coef_str.txt` | 176 × 256 | Feedback coefficients, ≈ **−Ci_coef_cos**. Exceptions: modes 1–2 on 40 keys | dimensionless | [DATA] |
| `Ci_str_1_out.txt` | 256 | Per-mode output (receiver) weight, 0.08–91 | ? | [INF] |
| `Ci_str_out.txt` / `Ci_str_curve.txt` | 256 × 1e5 / 88 × 1.0 | Global output gain / per-key output curve | ? | [GUESS] |
| `decka_coeff.txt` | 256 × 16 | Per-mode × 16 columns. Possibly 16 output channels or receivers | ? | [GUESS] |
| `NL.txt`, `NL_disp.txt` | 128 / 88 | Nonlinearity settings (sparse / all zero) | ? | [GUESS] |
| `Gain_FB.txt`, `others.txt`, `Strength_graph.txt` | 2 / 15 / 10 | Global scalars: 196078.43 step rate; 8.571e-5 (= 1/11 666.7, mode dt?); 12, 14, 500, 1300; strength curve | ? | [GUESS] |
| `impulse_resp_L/R.txt` | 24576 each | Output IR for convolution: **all zero** | | [DATA] |
| `Force_vozb.txt`, `pedal_out.txt`, `ind_tail_*` | | Debug capture (byte-identical to Bl_Apr_19); zeros; mostly zeros | | [DATA] |

### 2.2 Raw code or engineering unit?

This is the central ambiguity.

- **Raw codes:** the physics-coefficient tables (`ttn`, `disp`, `decr_*`, `damping`) are the fixed-point codes as floats (value = raw/2²⁴). The decoded values are dimensionally sane: stable CFL, decay times in seconds.
- **Engineering units:** the exciter, index and mode tables (`exp_all`, `ind_*`, `omega_coef`) are stored in engineering units. The host tool converts them with unknown factors: `ind_mult_multiplier`, the time unit of `d`/`e`, Hz → ω code, and the `Q_coeff` encoding.

### 2.3 F_15 compared with the earlier Bl_Apr_19 dump

- Same schema. `ttn_micro.txt` is new.
- `Force_vozb`, `FB`, `velocity`, `Notes_freqs`, `impulse_resp_*`, `Shapee`, `NL_disp` and `pedal_out` are byte-identical.
- All physics, exciter, mode and deck tables changed.
- F_15 amplitudes are essentially non-negative (min −0.001). Bl_Apr_19 had −0.56 on Gauss 2.

---

## 3. Stage-by-stage comparison: FPGA vs GPU

GPU facts are from [SYNTHESIS_ENGINE](http://localhost:8001/modules/pianoid-cuda/SYNTHESIS_ENGINE/), [PianoidBasic OVERVIEW](http://localhost:8001/modules/pianoid-basic/OVERVIEW/), [MODE_PHYSICS](http://localhost:8001/modules/pianoid-cuda/MODE_PHYSICS/), [DATA_FLOWS §2.7](http://localhost:8001/architecture/DATA_FLOWS/#27-preset-save-and-load), and [excitation loudness normalisation](http://localhost:8001/proposals/excitation-loudness-normalization-correction-2026-06-30/).

| Stage | FPGA | GPU | Verdict |
|---|---|---|---|
| String PDE | `y_tt = c²y_xx − κ y_xxxx − γy_t + β∂t y_xx + F·shape` | Identical form [DOC] | **Equivalent** |
| Discretisation | Explicit 3-level; 2nd/4th-difference stencils; `(… + d·u0)/(1+d)` | Same stencil and centring (`shift_b = (dec−1)·dec_inv`) [DOC] | **Equivalent**. FPGA uses `ddiv = 1 − d` instead of `1/(1+d)` (negligible) |
| Time step | 5.1 µs (196 078 Hz), no sub-steps per sample known | `1/(sr·string_iteration)`: 5.2 µs for Belarus (48 k × 4) [DOC] | **Near-identical dt** |
| Precision | float32 datapath, 24/32-bit fixed-point parameters | `real` (float/double build) [DOC] | GPU ≥ FPGA |
| Points per string | ≤ 256, tail from `sdvig` | `main + tail + 2 stem` ≤ `array_size` (384) [DOC] | Similar; **FPGA N per note unknown** |
| Coefficients | Stored **pre-scaled** per string (Tn, Disp, Dec…) | **Derived** from SI physics (`T, ρ, r, E, γ, dx, dt`) in `parameterKernel` [DOC] | Needs a dimensional bridge (§4) |
| Bending | Present in C; **0 in the test model** | Present [DOC] | Confirm with Dima whether the production FPGA uses it |
| HF damping β | Placeholder in C; **0 in the test model** | Present, but `coeff_frequency_decay` is not dt-scaled (known issue) [DOC] | Partially mappable |
| Tail zone | Own tension (`ttn_end`) and own decrement (`Damper`) | Same tension; `damper_tail` decrement [source, Kernels.cu:124–141] | FPGA has **tail tension**; the GPU lacks it |
| Damper / pedal | Linear interpolation `Do + (Dc−Do)·ped/128`; key held → `Do` | `γ·dt + damper_string·⌊((127−sus)·dumper_pos)^0.6⌋` [source] | **Different law**; approximate |
| Bridge coupling | Imposed displacement `LASTX` at the termination; the bridge force is the elastic `ff` at the termination | Stem points = summed mode feedback; the force accumulates at the stem [DOC] | **Equivalent concept** |
| Exciter shape | 4 (+1 spare) Gaussians `a·exp(−e(t−d)²)`, exponent clamp 30 | 5 Gaussians `vol·max(exp(−½((x−μ)/σ)²) − shift, 0)` [DOC] | Equivalent family; `e ↔ 1/(2σ²)` |
| Exciter velocity | 5 layers at 0/32/64/96/128 via `velocity.txt`, raw-domain interpolation | 6 anchors 0/5/31/63/95/127, interpolation in μ/σ/vol domain [DOC] | **Approximate** (re-sample FPGA at GPU anchors) |
| Exciter duration | Unbounded (time counter up to 1e9) | 7 written segments of ~1 ms, clamp to 0 [DOC] | GPU truncates **up to 7–8 %** of the F_15 force (§5) |
| Loudness | Absolute: `ind_vol × a`, independent per (pitch, level) | **Conserve mode**: `c·m(pitch)·v(level)`; curve volume divided out [DOC] | **Structural gap**: rank-1 fit, residual 6 dB (§5) |
| Hammer spatial shape | Tabulated per key (`Shape_512`) or single-point noise | Parametric circular/parabolic (`position, width, sharpness`) [DOC] | Approximate (fit width/position) |
| Extra excitations | Noise mode, "knock" (`stuk`) path | Bow/sustained (WRAP) mode [DOC] | Neither side has the other's |
| Modes | 256 modes; update not delivered | ≤ 256 (practically ≤ num_strings); `q̈+2γq̇+ω²q = mass_inv·F`, leapfrog per audio sample [DOC] | Mode data maps: frequency exact, damping/mass **unknown** |
| Feed-in | `F_mode = Σ Ci_cos[key,m] · F_bridge` (signed) | `deck.feedin` per pitch, **0–1 normalised per mode**, all shipped presets ≥ 0 [DOC] | Map with per-mode normalisation; **sign handling open** |
| Feedback | `Ci_coef_str ≈ −Ci_cos`, plus a per-note `FB` gain and a global `Gain_FB` | Single matrix: `feedback = feedin × deck_feedback_coeff` (global) [DOC] | GPU lacks per-note FB and separate feedback |
| Output | Per-mode weight `Ci_str_1_out` (+ possibly the 16-col `decka_coeff`), ×1e5 | Output pitches 128+ = receiver rows (feedback = mode shape at the receiver) → velocity (or 2nd derivative) [DOC] | Mappable onto output-pitch rows |
| Post-processing | Convolution IR (empty in F_15) | Optional FIR [DOC] | Equivalent (unused) |
| Nonlinearity | `NL` / `CMD_nl` exist; no NL term in the test datapath | None | FPGA-only (unused here) |

---

## 4. Porting mapping (GPU parameter ← FPGA source)

**Exactness key:**

| Mark | Meaning |
|---|---|
| **E** | Exact |
| **A** | Approximate (a documented assumption or a lossy fit) |
| **X** | No equivalent |
| **?** | Blocked on an open question |

**Axis conventions (confirmed):**
- FPGA key row `k` → GPU pitch `k + 21`.
- FPGA mode column `m` → GPU mode `m`.
- FPGA `exp_all` axes are (level, key, param, gauss).
- GPU `levels_matrix` axes are (velocity 0..127, [μ, σ, vol, shift], gauss).
- FPGA data is **per note**; the GPU is per pitch with 1–3 strings. Unison detuning is `tension_offset`, and the FPGA has no known equivalent (`ttn_micro`?).

### 4.1 Modes

| GPU field | FPGA source | Formula | Mark |
|---|---|---|---|
| `modes[m].frequency` | `omega_coef[m]` | Identity (Hz) | **E** |
| `modes[m].decrement` | `Q_coeff[m]` | Unknown encoding. The draft uses the template median | **?** |
| `modes[m].mass` (= `mass_inv`) | `Mass[m]` | Unknown. The draft keeps the template law `0.1/(2πf)²` (option: × median(Mass)/Mass) | **?** |
| `num_modes` | 256 | GPU capacity is ≤ num_strings (224 in Belarus). The draft keeps 196 and drops 60 modes above 8.9 kHz | **A** |

### 4.2 Deck and output

| GPU field | FPGA source | Formula | Mark |
|---|---|---|---|
| `pitches[p].deck.feedin[m]` | `Ci_coef_cos[p−21, m]` | `/ max_k \|Ci[k,m]\|` per mode. Sign kept (option: abs) | **A** (sign; normalisation) |
| `deck.feedback` | `Ci_coef_str` (≈ −feedin) | Single matrix → = feedin; the sign is absorbed | **A** |
| Per-note `FB`, `Gain_FB` | `FB.txt`, `Gain_FB.txt` | No per-pitch feedback gain on the GPU (only the global `deck_feedback_coefficient`) | **X** |
| Output rows `pitches[128+ch].deck.feedback[m]` | `Ci_str_1_out[m]` (mono); `decka_coeff` (16 ch?) | Scaled to the template output-row maximum | **A / ?** |
| `string_sound_channels`, `output_scale` | `Ci_str_out` (1e5) | Keep the template; recalibrate | **A** |

### 4.3 Excitation — including a challenge to the documented decode

The production loader ([middleware OVERVIEW — Loading FPGA presets](http://localhost:8001/modules/pianoid-middleware/OVERVIEW/#loading-fpga-presets)) maps exp_all as follows:
- p0 → **μ** = `1.28/√p0` ms
- p1 → **σ** ms
- p2 → vol

This is hypothesis **H0**. The RTL points the other way:
- The FPGA Gaussian is `a·exp(−e·(t−d)²)`. The centre `d` enters **linearly**; only `e` is a quadratic coefficient.
- A decode of the form `1/√(2·raw)`, which is what `read_excitations_from_txt` does (`(raw/2^21·2)^−½`), is exactly the **width** formula `σ = 1/√(2e)`.
- So p0 is most likely `e` and decodes to **σ**, and p1 is the **centre**. This is **H1**: μ and σ swapped relative to the production loader.

Against H1:
- H0 gives smooth bumps: μ 0.2–3.8 ms, σ 0.05–0.5 ms.
- H1 gives pulses centred at 0.05–0.4 ms with widths of 0.7–3 ms, which start almost at full amplitude at t = 0.
- The legacy code also carries a commented-out `* 650 / 8` scaling on p1, which suggests that its time unit was never pinned down.

**This is a high-stakes axis-semantics question.** It cannot be settled from the delivered files, and it matters for every FPGA import, including the existing `Belarus_*_FPGAexc` presets. The draft converter supports both (`--excitation-hypothesis`), with H0 as the default for continuity.

| GPU field | FPGA source | Formula | Mark |
|---|---|---|---|
| `levels_matrix[v, 0..2, g]` (μ, σ, vol) | `exp_all[:, key, :, g]`, `ind_mult`, `velocity.txt` | For each GPU velocity v: `vint = velocity[v]`, FPGA raw-domain interpolation (§1.3), decode (H0/H1), **μ,σ ÷ ind_mult(vint)** | **A** (units; H0/H1) |
| `levels_matrix[v, 3, g]` (shift) | — | 0 | **E** |
| Gauss count | 4 RTL + 1 spare | Slot 4 carried as in the file | **E** |
| Velocity anchors | 0/32/64/96/128 internal | Re-sampled at 0/5/31/63/95/127 via `velocity.txt` | **A** |
| `hammer_mass[p]`, `hammer_speeds[L]` | `ind_vol × ∫Σg` per (key, level) | Rank-1 log fit `m(p)·v(L)` (conserve mode). F_15 residual **6.3 dB (H0) / 5.7 dB (H1)**. F_15 layers 0–3 are nearly identical in `ind_vol`, so the fitted speeds are **non-monotone** | **A** |
| `hammer.{position,width,sharpness}` | `Shape_512` column | Fit a circular profile (not done in the draft) | **A** |
| Noise / knock excitation | `nn_fl`, `FF_stuk` | — | **X** |

### 4.4 String physics

| GPU field | FPGA source | Formula | Mark |
|---|---|---|---|
| `physics.gamma` [1/s] | `decr_op` | `raw/2^24 × 196078.43`. Check: GPU `dec_curr = γ·dt` [DOC] | **A** (needs dt_FPGA confirmed) |
| `damper_string` | `decr_cl − decr_op` | `(γ_cl−γ_op)·dt_gpu / ⌊127^0.6⌋`. Gives ~5e-7 against a Belarus value of 4e-5 (80× smaller) | **A / ?** (different law; verify) |
| `damper_tail` | `damping` | Tail decrement per step → rescale by dt | **A** |
| `tension`, `rho`, `geometry.length/main` | `ttn` (=c²dt²/dx²), `Notes_freqs` | Needs **N_FPGA** (`sdvig` per note). Otherwise tune T from `Notes_freqs` on the GPU geometry. The draft keeps the template | **?** |
| `jung`, `r` (inharmonicity) | `disp`, `ttn` | `B = π²·(Disp/Tn)/N²`. Needs N | **?** |
| `disp_decay` | `decr_disp` | `β_phys = κ·dx²/dt` → GPU `disp_decay = β_phys·2·dx_mm²·1e-12`… Needs dx_FPGA; the GPU term is itself not dt-scaled | **?** |
| Tail tension | `ttn_end` / `ttn_tails` | — | **X** |
| Unison detune `tension_offset` | `ttn_micro`? | — | **?** |

---

## 5. Draft converter

**File:** `PresetsFromFpga/elyashev-2026-09-30/fpga_to_gpu_preset_draft.py`. It is **DRAFT, untested on the engine, and has not been loaded into any backend**.

**How it works:**
- Pure numpy and json. It does not import Pianoid and does not touch the GPU.
- It overlays the FPGA data onto a template GPU preset JSON (default recipe: `Belarus_8band_196modes.json`) following the §4 table.
- Every approximation is a flag and is printed as a WARNING.
- The conversion log is written to a sidecar `*.conversion_note.json`, not into the preset, because `StringMap(**preset)` takes the preset keys as kwargs.

**Offline dry-run (2026-09-30), both hypotheses:**
- The JSON is produced and has the same top-level keys as the template.
- All 88 pitch entries have `excitation [128,4,5]` and `deck [2,196]`, with no NaN or Inf.
- 84 pitches are written (the template covers MIDI 23..106).
- Warnings:
  - 60 modes above 8.9 kHz are dropped.
  - Mode decrement is a placeholder.
  - The deck has negative coefficients.
  - Up to 7.2 % (H0) / 8.1 % (H1) of the force falls outside the 7 ms window.
  - The rank-1 loudness residual is 6.3 dB / 5.7 dB.

**Before any use**, render offline through the canonical surface: `/test-ui` (audio_off) per [PROJECT_CONFIG#verification-surfaces](http://localhost:8001/PROJECT_CONFIG/#verification-surfaces). Compare H0 against H1, and keep-sign against abs deck, and do this **after** Dima answers Q1–Q4.

---

## 6. Porting feasibility

| Block | Feasibility |
|---|---|
| String update algorithm | **Identical family.** The GPU can host the FPGA string model as-is, apart from tail tension and the damper law |
| Mode frequencies, deck feed-in and output weights | **Portable now** (E/A) |
| Excitation shape | **Portable** once H0/H1 and the time units are confirmed |
| Excitation loudness | **Approximate** because of GPU conserve mode (rank-1); an exact port needs a per-(pitch, level) override that the GPU doesn't have |
| String physics (T, E, β, dampers) | **Blocked** on points-per-string and dx per note, and on the host-tool scaling |
| Mode damping and mass | **Blocked** on the `Q_coeff` and `Mass` encoding |

**Overall:** a *recognisable* port is feasible now. That means correct modal frequencies, coupling pattern, excitation shapes and string decay. A *faithful* port needs Dima's host-tool conversion script, or the answers to the questions below.

---

## 7. Open questions for Dima

1. **exp_all parameter order and units.** Which is `d` (centre) and which is `e` (1/(2σ²))? What are the time units of `d`/`e` in the `.txt`, and what is `ind_mult_multiplier`? (Our existing loader assumes p0 = centre via `1.28/√p0` ms, which conflicts with the RTL.)
2. **Host-tool conversion.** Please send the MATLAB/PC script that turns the `.txt` files into ROM/RAM codes (`initVector`s, `num_str*`, `nota_*`, `CMD_*`, `shape2`). Which `.txt` files are raw codes and which are in engineering units?
3. **Mode oscillator.** What is the update equation, its rate, and its fixed-point format? What do `Mass.txt` and `Q_coeff.txt` encode (`Q/2³⁴` ∈ [1, 1.944])? Why is the `Q` ROM in Coeff_converter initialised with `omega_coef`?
4. **String geometry.** How many points per note (`Sdvig`), and which `.txt` holds it? What are `shteg`, `del`, `dt`, `width` and `ttn_micro`? Is dt really 1/196078.43 s for every note?
5. **Stiffness and HF damping.** Are `Disp` and `Disp_decr` active in the production bitstream? In `test_mashinka_mapp_4` their multipliers are constant 0.
6. **Coupling signs and gains.** Is `Ci_coef_str = −Ci_coef_cos` intentional (the sign convention of the bridge force)? What do the exceptions on modes 1–2 mean? What role do per-note `FB` and `Gain_FB` play?
7. **Output.** Is the audio `Σ Ci_str_1_out[m]·q_m` (or ·q̇_m), and what is the 16-column `decka_coeff` (16 outputs?)? What is the audio sample rate?
8. **Strings per note.** Does the FPGA simulate 1 or several strings per note? Is the second 256-row half of `Shape_512` a second string, or the knock shape?
9. **Velocity.** Is `velocity.txt` the MIDI → internal velocity curve? What is `Strength_graph.txt`? (In F_15, `ind_vol_0..3` are identical.)
10. **Tail zone.** Is slot 11 ("1−Nl" → `ttn_end`) the tail tension, fed from `ttn_tails.txt`?

---

## 8. Follow-ups (GPU side; not started)

| # | Item | Effort |
|---|---|---|
| 1 | After Q1: fix or confirm `load_excitation_from_fpga_preset` / `read_excitations_from_txt` (μ/σ slot semantics) and re-check the `*_FPGAexc` presets. This is a high-stakes data-model fact, so it goes through `/dev` with measurement | S |
| 2 | `load_deck_from_txt` hardcodes `reshape(176,128)`. Current dumps are 176×256 (known since 2026-06-11) | S |
| 3 | Decide on GPU support for negative deck coefficients (measure first) | S |
| 4 | Optional GPU features for fidelity: tail tension, a per-pitch feedback gain, a per-(pitch, level) loudness override | M–L |
| 5 | Render the draft offline with H0 vs H1 and compare spectra against an FPGA recording from Dima | M |

## 9. Artefacts

All paths are relative to `PresetsFromFpga/elyashev-2026-09-30/`:

- `algorythm.c`, `test_mashinka_mapp_4.slx`, `Coeff_converter_0.slx`, `F_15.rar` (originals)
- `unpacked/` (extracted `.slx` XML and `F_15/F_15/*.txt`)
- `fpga_to_gpu_preset_draft.py` (the DRAFT converter)
- `batch2/` (`Coeff_converter.m`, `mapp_4_fir_4_str.slx`, `Pitch.txt`, `unpacked/`)
- `batch3/` (`Pianoid_QM.c`, `main.h`, `config_str.h`, `preset_config.h`, `Pianoid_QM.uir`, `Pitch.txt`, plus `*.utf8.txt` copies)

---

## 10. Batch 2 findings (2026-09-30, 14:10 UTC)

### 10.1 The new files

| File | What it is | Evidence |
|---|---|---|
| `Coeff_converter.m` (430 B) | **Only a loader, not a physics → code converter.** It is 11 `load 'D:/MATLAB_18_prj/<name>.txt'` lines: `ttn`, `decr_cl` (loaded twice), `decr_op`, `decr_disp`, `disp`, `damping`, `omega_coef`, `Q_coeff`, `Ci_coef_cos`, `Mass`, then `plot(damping)`. It creates the MATLAB workspace variables that the `Coeff_converter_0.slx` ROMs use as `initVector`. So those ROMs hold the `.txt` values **verbatim** | [RTL] |
| `mapp_4_fir_4_str.slx` (743 KB, R2018b, last modified 2026-03-19) | **The full closed-loop model**, but at reduced scale. It has everything `test_mashinka` had, plus: the **mode oscillator** (`oscill_dbl2`), the **string→mode feed-in** (`MUX0`), the **mode→string feedback** (`Svertka6`, which drives `LASTX`), a **16-channel output mixer** (`Svertka_ou3`, outputs `au0..au15`), a test sine oscillator (`Oscillator`, 2048-entry sine ROM), and `ind_stuk_*`/`noise_*` tables. Stiffness and HF damping are **wired** (`Mult4 = fd·Disp`, `Mult5 = Δsd·Disp_decr`). There is still one mashinka instance (4 strings), and the oscillator counter covers 64 modes. It has no MATLAB Function blocks and no model callbacks | [RTL] |
| `Pitch.txt` (88 rows × 3 groups of 4 ints) | **The string allocation map.** Each group is `(N_points, array_slot, sub_slot, offset)` and −1 means unused. Results: **12 notes × 1 string, 12 × 2, 64 × 3 = 228 strings**, packed into **57 arrays of 512 points** (max `offset+N` = 512). Lengths run from **476 points (A0) to 12 points (C8)**. Short treble strings fill the free space in the bass/mid arrays at offsets 134/260/386 and 476/488/500 | [DATA] |

### 10.2 The production signal chain

| Stage | RTL | GPU counterpart | Verdict |
|---|---|---|---|
| Mode oscillator `oscill_dbl2` | `q2 = (2q1 − q0 + D·q0 − W·q1 + M·F)·(1 − D)`. `W` = `omega_calc` (u·2⁻³¹), `D` = `Q_calc` (s·2⁻³¹), `M` = `Mass` RAM (u·2⁻³¹). State lives in the RAMs `Plector_stiffness1/2`. The outputs are q, Δq and Δ²q | `result = ((2s − m1) + m1·dec − s·omega + F·mass_inv)·(1 − dec)` [DOC SYNTHESIS_ENGINE] | **Identical update equation** (omega ↔ W, dec ↔ D, mass_inv ↔ M) |
| Feed-in `MUX0` | `F_mode[m] = Σ_notes Ci_re[note][m] · force_str[note]`. The Ci values are **float32 words** in RAMs of 1024 entries (4 notes × 256 modes) written with `CMD_ci_Re_*`. "Re" = the real part, i.e. `Ci_coef_cos` [INF] | `feedin` matrix [DOC] | **Equivalent** |
| Feedback `Svertka6` | `LASTX[note] = Σ_m Ci_str[note][m] · FB · q_m`. There are 22 RAMs × 4 notes = 88, written with `CMD_ci_str_*`, i.e. from `Ci_coef_str` [INF]. `FB` is **one global runtime value** (`CMD_fb` / `CMD_FB_mult`), not a per-note table. The accumulator has an accumulate-and-dump window at addresses 133–149 that I could not fully decode | stem = Σ feedback·q × `deck_feedback_coefficient` (global) [DOC] | **Equivalent structure**. The FPGA keeps a **separate** feedback matrix (≈ −feed-in) |
| Output `Svertka_ou3` | 16 outputs `au_ch = Σ_m Res2[ch][m] · s_m`, where `s` is chosen at runtime (`Mux1`, `CMD_init_sw`) from {test, F_mode, **q**, **Δq**, **Δ²q**}. `Res2` is 256 × 8 per bank; 256 × 16 matches **`decka_coeff.txt`** [INF, strong] | Output pitches 128+ (receiver rows); `soundDerivativeOrder` 1/2 [DOC] | **Equivalent**. The GPU has ≤ 12 output pitches; the FPGA has 16 |
| Strings | Same `STRINGS0` datapath, with `Disp`/`Disp_decr` **active**. `LASTX0..3` ← `Svertka6` (the loop is closed) | Same PDE [DOC] | **Equivalent** |
| Rates | A single `start` pulse drives the strings, `MUX0`, the oscillator and the output. So **the modes are updated once per string step** [INF]. The GPU updates modes once per audio sample | — | The mode `W`/`D` must be built with the FPGA step dt, which is still unconfirmed |
| `initVector` slips | Production `Mass` RAM `initVector = omega_calc` (same slip as `Coeff_converter_0`'s Q ROM). In practice all tables are **uploaded at runtime over the serial link** (`m_dat/m_addr/m_en` + `CMD_*`), so `initVector`s are only simulation defaults | — | The conversion is done by the **host PC program**, which we still don't have |

### 10.3 The 10 questions after batch 2

| # | Question | Status | Evidence / what's still missing |
|---|---|---|---|
| 1 | exp_all: `d` vs `e`, time units, `ind_mult_multiplier` | **STILL OPEN** | The production gauss block is unchanged: `a·exp(−min(e·((t−d)/2²⁹)², 30))`. It uses separate `exp_a*/exp_d*/exp_e*` variables. The script that splits `exp_all` into them, and `ind_mult_multiplier`, are **not** included. The H0/H1 question (§4.3) stands |
| 2 | Host-tool conversion script | **PARTIAL** | `Coeff_converter.m` shows that the simulation loads the `.txt` files verbatim. Production values arrive over serial from the host PC. The variables `omega_calc`, `Q_calc`, `Res1`, `Res2`, `shape2` and `exp_*` are computed somewhere we can't see |
| 3 | Mode oscillator equation / rate / format; `Mass`, `Q_coeff` | **PARTIAL** | **Equation ANSWERED**: identical to the GPU. Format: s/u·2⁻³¹. Rate: once per `start`, i.e. per string step [INF]. **Still open**: `Q_coeff → Q_calc` and `omega_coef(Hz) → omega_calc`. `Q_coeff` cannot be `Q_calc` directly (/2³¹ would give D = 8–15.5). Also the scale of `Mass`, and the `initVector` slip (`Mass` RAM initialised with `omega_calc`) |
| 4 | Points per string, `Sdvig`, `shteg/del/dt/width/ttn_micro`, dt | **PARTIAL** | **Allocated points per string ANSWERED** (Pitch.txt: 476 → 12). Still open: the speaking/tail split (`Sdvig`) and dt. `√(ttn/2²⁴)/(2 f N)` gives dt ≈ 0.8–1.3 µs if the whole allocation vibrates. With dt = 5.1 µs (the 196 078 Hz figure = one 512-point array sweep at 100 MHz), only **~20 % of the points would be speaking length** in bass/mid (ratio 0.19–0.23; 0.12–0.33 in the treble). Both readings fit the data. `shteg/del/dt/width/ttn_micro` are still unexplained |
| 5 | Stiffness and HF damping active in production? | **ANSWERED: yes** | In `mapp_4_fir_4_str`, `Mult4` multiplies `fd` by the `Disp` input and `Mult5` multiplies `Δsd` by `Disp_decr`. The constant-0 multipliers existed only in the test bench |
| 6 | Ci sign, modes-1–2 exceptions, `FB` / `Gain_FB` | **PARTIAL** | The two matrices are **separate RAMs**: feed-in `CMD_ci_Re_*` (Ci_coef_cos), feedback `CMD_ci_str_*` (Ci_coef_str). So the sign difference is real and the FPGA loop gain per mode is `Ci_cos·Ci_str·FB`. `FB` is a global runtime command. The per-note `FB.txt` slot is still unused in the RTL. Still open: why they are negatives, the modes-1–2 exceptions, and `Gain_FB` |
| 7 | Output formation, `decka_coeff`, audio rate | **PARTIAL** | **Formation ANSWERED**: 16 outputs = `decka_coeff`-shaped matrix × {q, Δq, Δ²q}, selectable at runtime. In F_15, `decka` columns come in identical pairs (0 = 1, 2 = 3, …), i.e. 8 distinct outputs. **Still open**: which signal the production setting selects, the audio sample rate, and decimation (no FIR/decimator on the audio path; "fir" in the model name refers only to the 4-string mashinka) |
| 8 | Strings per note; `Shape_512` halves | **PARTIAL** | **Strings per note ANSWERED** (1/2/3 = 12/12/64 notes, 228 strings; the GPU also uses 1–3 per pitch). `Shape_512` is 512 = one array. The second half probably holds the hammer shape for the strings packed in the upper part of the array [INF]. Not confirmed |
| 9 | `velocity.txt`, `Strength_graph` | **STILL OPEN** | No new evidence |
| 10 | Slot 11 (`1−Nl`) = tail tension from `ttn_tails` | **STILL OPEN** | The same `PARAMETERS`/`Delay_thresh` wiring. Nothing loads `ttn_tails` in `Coeff_converter.m` |

### 10.4 Revised mapping rows (these replace §4 where they differ)

| GPU field | FPGA source | Formula | Mark (was → now) |
|---|---|---|---|
| Mode update form | `oscill_dbl2` | Identical | — → **E** |
| `modes[m].frequency` | `omega_coef` (Hz) | Identity | E → **E** |
| `modes[m].decrement` | `Q_calc` = f(`Q_coeff`) | `decrement = D/(dt_FPGA·f)` once `Q_calc` is known | ? → **? (form known, input missing)** |
| `modes[m].mass` | `Mass` → `M` (u·2⁻³¹) | `mass_inv = M` rescaled for the GPU force/dt scale | ? → **? (form known)** |
| Output pitches `128+ch` feedback row | `decka_coeff[:, ch]` (16 outputs, pairs identical) | Per-channel column, scaled to the template output-row maximum. Up to 12 GPU output pitches | A/? → **A** (converter default updated) |
| Output signal order (`soundDerivativeOrder`) | Runtime `Mux1` select (q / Δq / Δ²q) | GPU velocity = Δq, acceleration = Δ²q | ? → **A (need the production setting)** |
| `deck_feedback_coefficient` | Global `FB` (`CMD_fb`, `CMD_FB_mult`) | Global scalar ↔ global scalar | X → **A** |
| Separate feedback matrix | `Ci_coef_str` | GPU single-matrix build uses feedback = feed-in | **X** (the GPU legacy `USE_SINGLE_DECK_MATRIX=0` path would be the fix) |
| Strings per pitch | Pitch.txt | 1/2/3 per note matches GPU chores (1–3). Belarus has 224 strings vs FPGA 228 | — → **A** (template chores kept) |
| `geometry.main/tail` | Pitch.txt `N` (+ unknown `Sdvig`) | Needs the speaking/tail split | ? → **? (partially known)** |
| `jung`, `r`, `disp_decay` | `disp`, `decr_disp`: **active in production** | Still needs dx/N | ? → **?** |

### 10.5 Revised feasibility

- **Topology.** The two engines are now confirmed to have the **same closed-loop topology and the same update equations** at every stage: FDTD string, Gaussian exciter, modal oscillator, bilinear string↔mode coupling, and the modal output mix. Porting is a data-mapping problem, not an algorithm port.
- **Portable now:**
  - Mode frequencies (exact).
  - Feed-in pattern.
  - 16 → 4/12-channel output weights.
  - Global feedback gain.
  - Strings per note.
  - γ (under the dt assumption).
- **Still blocked on host-tool data:**
  - Mode damping and mass (`Q_calc`, `omega_calc`, `M` scale).
  - Exciter parameter semantics and units (Q1).
  - The speaking/tail split and dt (Q4).
- **Structural GPU gaps** (unchanged, plus one): a separate feedback matrix, tail tension, per-(pitch, level) loudness, and 16 outputs versus 12.

### 10.6 Remaining questions for Dima (these replace §7)

1. **The host PC program**, or at least the formulas it uses, that produce `exp_a/d/e*`, `ind_mult_multiplier`, `omega_calc`, `Q_calc`, `Mass` codes, `Res1`, `Res2` and `shape2` from the `.txt` files. This one item would close Q1, Q2 and Q3.
2. In `exp_all.txt` (5 × 88 × 3 × 5), which of params 0/1 is `d` (centre) and which is `e`? What are their time units?
3. What is dt of the string/mode update (one `start` period)? Is it 1/196 078 s? How many points of each Pitch.txt allocation are speaking length (`Sdvig`), and which file holds it?
4. Which output signal (q / Δq / Δ²q) does the production `CMD_init_sw` select? What is the audio sample rate?
5. Why is `Ci_coef_str ≈ −Ci_coef_cos`, and what are the modes-1–2 exceptions? What are `FB.txt` (per note) and `Gain_FB`?
6. What do `shteg`, `del`, `dt`, `width`, `ttn_micro`, `velocity`, `Strength_graph` and slot 11 (`1−Nl` ← `ttn_tails`?) mean?

The draft converter was updated (output pitches ← `decka_coeff` columns, `--output-source`). It is still **UNTESTED ON ENGINE**. The offline dry-run is clean: 4 output rows finite, 84 pitches.

---

## 11. Batch 3 — the host program (2026-09-30, 14:35 UTC)

**Files.** Saved under `PresetsFromFpga/elyashev-2026-09-30/batch3/`: `Pianoid_QM.c` (835 KB, LabWindows/CVI, 31 331 lines), `main.h`, `config_str.h`, `preset_config.h`, `Pianoid_QM.uir` (UI resource, not parsed), and a new `Pitch.txt`. The mail body was empty. The sources are cp1251; UTF-8 copies are `*.utf8.txt`. **Citations `QM:<line>` refer to `Pianoid_QM.c.utf8.txt`** (same line numbers as the original).

**Transport.** Tables go to the FPGA as UDP packets on port 5555 (`UDPWrite`). The frame is `0x21 0x21 0x22 <cmd> <sub> <lenHi> <lenLo> <payload: little-endian int32 per value> 0x23`. Command codes are in `main.h:20-157`. Presets are also stored in FPGA flash (`write_flash`, QM:26213). The flash sector layout is in `preset_config.h`.

> **Corrections to §1–§10.**
> - `others.txt[5] = 196 078.43` is the **output volume** (QM:8158), **not** the FDTD step rate. §1.1, §2.1 and §4.4 were wrong to use it as dt.
> - The exp_all slot semantics in §4.3 are now **settled**; see §11.1.

### 11.1 Verdict on mu/sigma: the production loader has them SWAPPED

| Evidence | What it shows |
|---|---|
| `Save_fcnstr` QM:21986-22026 writes `exp_all.txt` as `for level (5): for key (88): [exp_e[0..4], exp_d[0..4], exp_a[0..4]]` | The file is (level, key, **[e, d, a]**, gauss) |
| The loader QM:22097-22123 reads it back into `exp_e ← temp[k..k+4]`, `exp_d ← temp[k+5..k+9]`, `exp_a ← temp[k+10..k+14]` | Same |
| The preview `Construct_force_shape` QM:16857-17020 computes `amp·exp(−e·(i·dt − d)²)` | **e is the exponent coefficient (width), d is the centre** |
| The RTL gauss block (`mapp_4_fir_4_str.slx`, §10.2) computes `a·exp(−e·((t−d)/2²⁹)²)` | Same |
| **Our code:** `PianoidBasic/Pianoid/StringExcitation.py:633-634` decodes slot 0 with `(raw/2²¹·2)^−½/800` (a width formula) and stores it in levels_matrix slot 0 = **μ**. Slot 1 goes to **σ** (`:631`). `Pianoid.load_excitation_from_fpga_preset` (`pianoid.py:3538-3556`, docstring "mu_encoded, sigma_ms") and the docs ([middleware OVERVIEW — Loading FPGA presets](http://localhost:8001/modules/pianoid-middleware/OVERVIEW/#loading-fpga-presets); the [archived proposal](http://localhost:8001/proposals/archive/fpga-preset-excitation-loader-2026-05-17/)) all follow this | **The width goes into μ and the centre into σ. SWAPPED.** The width decode itself (`1/√(2e)`) is correct in form. The commented-out `# * 650 / 8` at `:631` was the centre's unit conversion |

**Consequences.**
- Every preset built with `load_excitation_from_fpga_preset` has transposed Gaussian centres and widths. That includes `Belarus_8band_196modes_FPGAexc.json` and `Belarus_196modesC_Fanera6exc.json`.
- The fix is a `/dev` task: follow-up #1 in §8, now **confirmed**.
- This is a high-stakes data-model fact. The docs must be corrected together with the code. I did not edit them here (analysis only).

### 11.2 Host formulas: .txt → FPGA code

| Table | Formula (host) | Cite | RTL decode → meaning |
|---|---|---|---|
| `exp_e` | `int(16777215·e)` | QM:25311 | `e_code/2¹⁸` × `((t−d_code)/2²⁹)²` |
| `exp_d` | `int(2147000000·d)` | QM:25336 | Compared with the u30 time counter `t` |
| `exp_a` | `int(2147000000·a)` | QM:25359 | Amplitude. **Only Gaussians 0..3 are sent** (`k<4`); slot 4 is a spare copy |
| `ind_mult_L` | `int(65000·ind_mult)`, so **`ind_mult_multiplier = 65000`** | QM:13481, 26280 | Increment of the time counter per exciter step |
| `ind_vol_L` | `int(v_L·ind_vol·8388607.5)`, `v_L = Strength_graph[5+L]` (F_15: 0, 0.3, 1.8, 1.8, 1.1) | QM:13542, 13225-13240 | Per-level loudness |
| `ttn` | `(int)ttn` → cmd `CMD_recieve_ttn` sub 5; `dt.txt` → sub 6 | `send_nl` QM:17741 | Unison strings: `ttn`, `ttn+dt`, `ttn−dt` (`send_ttn` QM:1503). **`dt.txt` = unison detune in ttn units** |
| `decr_op, decr_cl, shteg, disp, decr_disp, damping, point_noise(=5), ttn_tails` | `(int)value` → PARAMETERS slots **2, 3, 4, 6, 7, 8, 9, 11** | `Send_params` QM:8591-8624, `Send_block_param` QM:254 | The `.txt` values are raw codes (value = code/2²⁴). **Slot 4 = shteg, slot 11 = `ttn_tails`** (loaded as `Quan_NL`, QM:8289) |
| `shteg` | `Sdvig = start + N − shteg` | `send_shteg` QM:675 | **shteg = tail length in points.** Speaking points = N − shteg. Changing shteg rescales `ttn ∝ (N−shteg)²` (QM:14310), which confirms `Tn = c²dt²/dx²` on the speaking grid |
| `omega_coef` (Hz) | `int(4·f²·omega_ratio)`, `omega_ratio = others[1]` (0.0086) | `Send_Omega` QM:8909. The flash and preset paths write `f²·ratio` without the 4 (QM:26435, 23707), an inconsistency | W = ω²dt² ⇒ **dt ≈ 0.637 µs (1.57 MHz)** [INF] |
| `Q_coeff` | `int(Q_coeff·q_ratio)`, `q_ratio = others[0]` (0.00015) | QM:9660 | D (s·2⁻³¹). Gives D = 1.2–2.3e-3 per step. **Implausible as decay** at the W-implied dt (Q < 1): still open |
| `Mass` | `int(Mass·2³¹/f²)` | `send_mass` QM:338, flash QM:26477 | **mass_inv ∝ Mass/f²** (u·2⁻³¹). The GPU template law is `0.1/(2πf)²`; the FPGA adds a per-mode factor `Mass` |
| `Ci_coef_cos / Ci_coef_str` | float32 bit patterns, 22 groups × 4 notes × 256 modes | QM:15840, 26396-26420 | Feed-in / feedback RAMs |
| Global FB | float `−Gain_FB[1]` (= −others[2] = −8.57e-5) | `send_FB` QM:9534 | Feedback = FB·Ci_str with **FB negative** and Ci_str ≈ −Ci_cos, so the loop gain is **+\|FB\|·Ci_cos²**. The same sign convention as the GPU single matrix |
| Output matrix | `float(decka[ch][m]·out_vol·Ci_str_1_out[m]·tr_led[ch])` | QM:27817 | 16 outputs. Per-mode weight = **decka × Ci_str_1_out** |
| `velocity.txt` | MIDI velocity → internal velocity (`p2 = velocity[p2]`) | QM:4396 | Confirms §1.3 |
| `width.txt, del.txt` | Hammer spatial cap over the whole allocation: `tt = ww + √(1 − (c − del)²)`, `c = 0.5 − i/N`, normalised, capped at a panel value | `construct_molot` QM:394-400 | **Circular hammer**: centre at fraction `0.5 − del` (≈ 0.11–0.19), half-width `√(1 − ww²)` (≈ 0.02–0.06) |
| `FB.txt` | Per-note multiplier on the legacy `shape_256` hammer shape (÷√2, ÷√3 for 2/3 strings) | QM:15627-15637 | Per-note hammer amplitude (legacy path) |
| `ttn_micro.txt` | An alternative tension table, toggled per keyboard half | `toggle_MICRO` QM:31255-31290 | Alternate tuning, not used by default |
| `others.txt` | [0] q_ratio, [1] omega_ratio, [2] FB, [3] NL low, [5] out vol, [6] out gain, [11-14] compressor attack/release/threshold/gain | QM:8138-8168 | — |
| Output rate | FIR design uses `delta_250 = 1/(1e8/1024)` (97 656 Hz) against 48 kHz | QM:14056 | **Audio out ≈ 97.656 kHz** [INF] |

### 11.3 The two Pitch.txt files

Both allocate 12 × 1 + 12 × 2 + 64 × 3 = **228 strings in 57 arrays of 512 points**, with the same slot structure. They differ in length:
- `batch2` runs 476 (A0) → 12 points (C8).
- `batch3` runs 413 → 33 points: shorter bass, longer treble.

Which layout F_15 was tuned with is **open**. Tn scales with (N−shteg)², so the choice matters for the absolute dt reading.

With `batch3`, `√(Tn/2²⁴)/(2f(N−shteg))` implies dt ≈ 0.5–1.2 µs (median 0.93 µs). With `batch2` it implies 0.5–1.3 µs. The `omega_ratio` figure gives 0.637 µs. These agree only in order of magnitude. A 2⁻²⁵ Tn scale, or firmware scaling of `ttn`, would reconcile them. Still inferred.

### 11.4 Status of the questions

| # | Question | Status | Evidence |
|---|---|---|---|
| 1 | exp_all d vs e, units, `ind_mult_multiplier` | **ANSWERED** (order + codes); absolute time base **PARTIAL** | QM:22001-22017, 22105-22123, 25311/25336/25359, 13481. The multiplier is 65000. The time base depends on the exciter step, which shares the `start` strobe with the strings [INF], so dt ≈ 0.64 µs |
| 2 | Host conversion | **ANSWERED** | §11.2 |
| 3 | Mode W/D/M codes | **PARTIAL** | W, M: ANSWERED (QM:8909, 338). D: code known (QM:9660), physical meaning **open** (implausible damping) |
| 4 | Points, Sdvig, dt, shteg/del/dt/width/ttn_micro | **PARTIAL** | shteg = tail length (QM:675); dt.txt = unison detune (QM:1503); width/del = hammer cap (QM:394); ttn_micro = alternate tuning (QM:31255). Open: which Pitch.txt applies, and dt |
| 5 | Stiffness / HF damping active | **ANSWERED** (batch 2) | — |
| 6 | Ci sign, FB, Gain_FB | **ANSWERED** (sign/FB), modes 1–2 exceptions **OPEN** | FB is sent negated (QM:9534), so the loop gain is +\|FB\|Ci². Gain_FB = [out gain, FB] (QM:5656, 9532). Per-note FB.txt = hammer-shape multiplier |
| 7 | Output formation, signal, rate | **PARTIAL** | Weights (QM:27817) and the ~97.656 kHz rate (QM:14056) are answered. The production choice of q/Δq/Δ²q is open |
| 8 | Strings per note, Shape_512 | **ANSWERED** | Pitch.txt. `Shape_512` = 512 × (array slot) cap shapes built by `construct_molot` (QM:367-470) |
| 9 | velocity, Strength_graph | **ANSWERED** | velocity = MIDI→internal (QM:4396). Strength_graph = [pp..ff display, v_0..v_4 level gains] (QM:13225-13240, 13542) |
| 10 | Slot 11 = ttn_tails | **ANSWERED** | QM:8289 + 8624 |

### 11.5 Revised mapping (replaces §4 and §10.4 where they differ)

| GPU field | FPGA source + formula | Mark |
|---|---|---|
| `levels_matrix` μ, σ | **μ ← d**, **σ ← e** (NOT the production loader's order). `rtl` decode: `μ = 2147000000·d/(65000·im)·dt`, `σ = (2²⁹/(65000·im))/√(2·16777215·e/2¹⁸)·dt` | **A** (order exact; time base via dt) |
| `levels_matrix` vol | `a` for Gaussians 0..3, slot 4 = 0 | **E** (shape) |
| Velocity | `velocity.txt` → internal v → FPGA 5-layer interpolation, evaluated at GPU v | **E** |
| `hammer_mass`, `hammer_speeds` | Rank-1 fit of `v_L·ind_vol·∫Σg`. With `v_L` the fitted speeds are **monotone** (0, 0.02, 0.51, 2.36, 4.11, 5.5); residual 6.1 dB | **A** |
| `hammer_position`, `hammer_width` | `(0.5−del)·N/(N−shteg)·L`, `2√(1−ww²)·N/(N−shteg)·L` | **A** (overridden by `initialize()` on load, DATA_FLOWS §2.7) |
| `tension_offset` | `dt.txt/ttn` (strings ttn ± dt) | **A** (also overridden on load) |
| `gamma` | `decr_op/2²⁴/dt_FPGA` → 0.68–8.7 s⁻¹ at 0.637 µs (Belarus 0.32–0.64) | **A** |
| Inharmonicity | `B = π²·(disp/ttn)/(N−shteg)²` = 8e-6 … 1.1e-3 (grid-independent) → `jung`/`r` | **A** (Pitch file), not written by the draft |
| Mode `frequency` | `omega_coef` (Hz) | **E** |
| Mode `mass` (mass_inv) | `∝ Mass/f²`, absolute scale = template median | **E relative / A absolute** |
| Mode `decrement` | `Q_coeff·q_ratio/2³¹` gives 0.4–41 in GPU units (template 0.085) | **?** |
| Deck feed-in / feedback | `Ci_coef_cos` per-mode normalised, signed; feedback sign resolved (FB < 0) | **A** |
| `deck_feedback_coefficient` | `\|FB\|` = 8.57e-5 × (FPGA→GPU force/displacement scale) | **A** |
| Output rows | `decka[:,ch]·Ci_str_1_out` | **A** (16 → template channel count) |

### 11.6 Revised feasibility

- **Can F_15 be ported faithfully now? Nearly, but not fully.**
- Algorithm and topology are identical (§10).
- These parameters now carry a known host formula:
  - Exciter shape (order settled).
  - Velocity layering and per-level gains.
  - Unison detune.
  - Tail length.
  - Hammer spatial cap.
  - Mode frequencies and relative masses.
  - Coupling signs.
  - Output weights.
- What still limits faithfulness:
  1. The absolute FPGA step dt and exciter time base. These scale all hammer timings and γ. Inferred 0.637 µs; the Pitch-based check gives ~0.9 µs.
  2. The meaning of the mode damping code `Q_coeff·q_ratio`.
  3. Which Pitch.txt F_15 uses.
  4. The GPU's structural gaps: per-(pitch, level) loudness, tail tension, 16 outputs, and hammer/tension_offset being overridden on load.
- With the draft's `rtl` decode, F_15 hammer centres are 0.6–16 ms. The median note fits the 7 ms GPU window, but the worst bass note loses up to 45 % of its force.
- **Draft converter**, revision 3: `--exc-decode rtl|legacy_ms|H0`, host mass law, `v_L`, `decka×Ci_str_1_out`, `shteg`/`Pitch.txt`, unison and hammer cap.
  - The dry-run is clean (all arrays finite).
  - It is still **UNTESTED ON ENGINE**.

### 11.7 Remaining questions for Dima

1. **Mode damping.** How does the firmware or RTL turn `Q_coeff·q_ratio` into the per-step decrement? With W = 4f²·0.0086/2³¹ (dt ≈ 0.64 µs), D ≈ 1.2e-3 per step would kill the modes in about 1 ms. Also: the flash path writes omega without the factor 4 (QM:26435, 23707) but `Send_Omega` includes it (QM:8909). Which one is live?
2. **The step.** What is the exact update period of the strings and the exciter (one `start` strobe)? Is `ttn` scaled by the soft-CPU firmware after `CMD_recieve_ttn`?
3. **Which Pitch.txt** (476…12 or 413…33 points) was F_15 tuned with?
4. **Which output signal** (q / Δq / Δ²q) does production use? What are the modes-1–2 exceptions in `Ci_coef_str`?

### 11.8 Dima's answers (2026-09-30 16:03Z, relayed via Telegram) and what they change

> *"надо верить всем параметрам, где идёт send all parameters. после этого все работает корректно. Он нашёл мой баг в загрузке флэшки. Pitch.txt из архива f15. В FPGA частота клока 393.219 mhz"*
>
> In English: "Trust all the parameters in the send-all-parameters path; after that everything works correctly. He found my bug in the flash loading. Pitch.txt is from the F_15 archive. The FPGA clock is 393.219 MHz."

| Answer | Effect |
|---|---|
| **The send-all path is authoritative** (`send_all` QM:12670). The flash writer had a bug | Live formulas win: **omega = `int(4·f²·omega_ratio)`** (QM:8909), not the flash `f²·ratio` (QM:26435, 23707). `send_all` calls, in order: `send_pitch`, `Send_params` (incl. `send_nl` → ttn/dt), `send_all_molot`, `send_shape`, `send_exp_coef`, `send_udar_param`, `send_FB`, `send_ci_zeros`, `send_ci_out`, `Send_Omega`, `Send_Q_coef`, `out_vol_out`, `send_mass`. `send_ci_out` and `send_mass` both write sub-address 202; **`send_mass` runs last, so the Mass code wins** |
| **"Pitch.txt from the F_15 archive"** | `F_15.rar` contains **no** `Pitch.txt` (50 tables; checked). Both candidates are kept. **Batch 2 (476→12 points) is more consistent with the F_15 data**; see the table below. **Unconfirmed**: we need the F_15 Pitch.txt itself |
| **Clock = 393.219 MHz** | Read as **393.216 MHz = 8192 × 48 kHz** (an audio-family clock; the 0.003 MHz is taken as a typo) [INF]. It replaces the 100 MHz assumed in §1–§11 |

**Step times at 393.216 MHz.** The clock counts are inferred from the RTL sweep sizes (one item per clock).

| Stage | Clocks / step | dt | Rate | Evidence |
|---|---|---|---|---|
| Strings | 512 (one 512-point array: 2 × 256 points, `num_str = 2` in `config_str.h`) | **1.3021 µs** | **768 kHz = 16 × 48 kHz** | Pitch.txt arrays are 512 points; the `STRINGS0` counter runs to `num_str0·256 − 1` |
| Modes | 256 (one mode per clock) | **0.6510 µs** | 1.536 MHz = 32 × 48 kHz | Live omega `4f²·0.0086/2³¹` equals `(2πf·dt)²` at dt = 0.637 µs. At 256 clk it reproduces f × 0.978 (**−38 cents**). `omega_ratio` is a user trim knob (panel `NUMERIC_87`), so ~2 % is within tuning |
| Exciter | = string step (shared `start` strobe) [INF] | 1.3021 µs | 768 kHz | At 1.302 µs the F_15 Gaussian centres span 1.3–33 ms (median note 14 % beyond the GPU 7 ms window). At 0.651 µs they span 0.65–16 ms (median 0 %). **Unconfirmed**; the draft exposes `--exc-clocks` |
| Audio out | 8192 clocks → **48 kHz** (or 4096 → 96 kHz, the host's `khz_96` option) | — | 48 / 96 kHz | The old `1e8/1024 = 97.66 kHz` (QM:14056) sat in a commented-out 100 MHz-era block; at 393.216 MHz the natural rates are exactly 48 k / 96 k [INF] |

**Pitch.txt candidates against the F_15 tuning.** Predicted fundamental `√(ttn/2²⁴)/(2·(N−shteg)·dt)·√(1+B)` with dt = 1.3021 µs, compared with `Notes_freqs`, in cents:

| Pitch.txt | Median | IQR | Bass (keys 0–11) | Mid (30–49) | Treble (70–87) |
|---|---|---|---|---|---|
| batch2 (476→12) | −369 | −666…−180 | −383 | −434 | **−61** |
| batch3 (413→33) | −576 | −1546…−130 | −119 | −521 | **−1547** |

- Batch 2 is the better candidate: its error is much more uniform across the register. Batch 3 is off by 15 semitones in the treble.
- Neither reproduces the tuning on its own. Batch 2 leaves a near-uniform ≈ −4 semitone offset. That means one of these is still missing:
  - the true string step (the data would need ≈ 1.03 µs ≈ 405 clocks);
  - a firmware scaling of `ttn` after `CMD_recieve_ttn`;
  - the real F_15 Pitch.txt.
- Mode frequency is unaffected (it is set in Hz).

**Mode damping with the send-all Q formula.** Is it physical now? **No.**
- D = `Q_coeff·0.00015/2³¹` = 1.2e-3 … 2.3e-3 per mode step.
- With the oscillator's `(1 − D)` factor at 1.536 MHz that is a decay of about 1 850–3 600 s⁻¹ (τ ≈ 0.3–0.5 ms, Q < 1).
- In GPU units it would be decrement 0.40–40.5, against a template median of 0.085.
- Unless the soft-CPU firmware transforms sub-address 201 (as it may for `ttn`), Q stays **OPEN**.

**String γ** = `decr_op/2²⁴/1.3021 µs` = **0.33–4.27 s⁻¹** (Belarus 0.32–0.64; F_15 mid-range notes 0.4–0.9). This is plausible and now the draft default.

### 11.9 Question table after Dima's answers

| # | Status | Note |
|---|---|---|
| 1 exp_all order / codes / multiplier | **ANSWERED** | §11.1–§11.2. The absolute time base depends on the exciter step (1.302 µs or 0.651 µs) |
| 2 host conversion | **ANSWERED** | `send_all` path |
| 3 modes | **PARTIAL** | W ANSWERED (−38 cents at 256 clk); M ANSWERED (Mass/f², send_mass wins over ci_out at sub 202); **D OPEN** |
| 4 dt / points / Pitch | **PARTIAL** | Clock ANSWERED (393.216 MHz); string step 512 clk [INF]. **F_15 Pitch.txt missing**: batch2 is the best candidate but leaves −4 semitones |
| 5 stiffness / HF damping | **ANSWERED** | — |
| 6 sign / FB | **ANSWERED**; modes-1–2 exceptions OPEN | — |
| 7 output | **PARTIAL** | Rate 48 k/96 k [INF]; production q/Δq/Δ²q selection OPEN |
| 8, 9, 10 | **ANSWERED** | — |

### 11.10 Feasibility after Dima's answers

- **Faithful F_15 port:** still **not quite**. Every table has an authoritative live formula. Three items remain:
  1. The **real F_15 Pitch.txt**. It sets the speaking lengths, and through them the tuning check and the hammer geometry.
  2. The **exact clocks per string and exciter step**, or any firmware scaling of `ttn`. Together with item 1 these explain the −4-semitone residual. The exciter step also sets the hammer-pulse time base.
  3. The **mode damping** transform (Q).
- **What is solid:**
  - Hammer shapes: the order is exact; the time base is one of two values.
  - Velocity layers and gains, unison detune.
  - Mode frequencies (−38 cents trim) and relative masses.
  - Coupling, feedback sign and output weights.
  - String γ.
- **Draft converter**, revision 4:
  - Clock-based steps (`--clock`, `--string-clocks 512`, `--mode-clocks 256`, `--exc-clocks`, default = string step).
  - Default Pitch = batch2.
  - Dry-run clean; **UNTESTED ON ENGINE**.

**Still needed from Dima:**
- The F_15 `Pitch.txt`.
- The number of clocks per string / exciter / mode update.
- How sub-address 201 (Q) and `CMD_recieve_ttn` are processed by the firmware.
- The production output-signal selection.

---

## 12. Production converter (dev-a480, 2026-09-30) — Phase 1, branch `feature/dev-a480-fpga-converter`

The draft (§5, rev 4) is superseded by `PianoidBasic/Pianoid/fpga_tables.py` + `fpga_preset_converter.py`
(CLI `python -m Pianoid.fpga_preset_converter`), now the only FPGA import path; `Pianoid.load_excitation_from_fpga_preset`
delegates to it and the swapped legacy readers were removed. Module reference:
[PianoidBasic OVERVIEW — FPGA preset converter](../modules/pianoid-basic/OVERVIEW.md#fpga-preset-converter).

**Findings while productionising (measured, offline render in a separate process):**

| # | Finding | Effect on the §11 mapping |
|---|---|---|
| 1 | Draft wrote `hammer_position` in **metres**; the preset/`Hammer.pack` convention is a **ratio of `l_main`** | Fixed (ratio); `hammer_radius` recomputed |
| 2 | Mode `mass_inv` from `Mass/f²` scaled to the template **median** `mass_inv` gives `k = mass_inv·(2πf)²` median 0.8 / max 4.8 vs the template's constant 0.1 → **runaway** (+150 dB, no pitch). Scaling to the median `k` is still unstable (+300 dB/s) | Default `--mode-mass host_max`: exact relative host masses, strongest mode `k` = template `k` → stable by attenuation (every mode ≤ template, weakest ~3400× lower). The absolute scale is UNCONFIRMED (in `fpga_conversion.unknowns`) and is the main cause of the level deficit (9–16 dB with the §11.11 exciter step) |
| 3 | `initialize()` no longer overrides `tension_offset` / hammer / γ (read-back equal) | The "engine gap" in §11.5 is gone; DATA_FLOWS §2.7 corrected |
| 4 | `shteg` is negative (−3.49 → −3) for keys 52–87; host arithmetic keeps `N − shteg > N` | Kept, flagged in metadata |
| 5 | Host `(int)` casts matter: `decr_op` 7.39 → 7 (γ −5 %); `send_nl` also casts `ttn` and `dt` (`dt` 1.17 → 1: unison detune up to 36 % lower than the float ratio) | Applied everywhere the host casts, incl. `tension_offset = (int)dt/(int)ttn` (review M1) |
| 6 | F_15 output columns come in identical pairs | Distinct columns 0, 2, 4, 5 → GPU output pitches 128–131 |

**F_15 renders** (first set; superseded by the updates below) (template Belarus_8band_196modes, `listen_to_modes=0`, order 1): no NaN/Inf, all notes decay;
pitch vs `Notes_freqs` A1 ≈ 0 c, C4 −19 c, C7 ≈ −24 c (low detector confidence at C7, as for the template) —
tuning is inherited from the template tension; both Pitch.txt candidates render identically except for the
hammer geometry; level 14–34 dB below the template at the then-assumed 512-clock exciter step, 9–16 dB with the derived 96 clocks (see the update below). Evidence:
`docs/development/diagnostics/dev-a480-renders/summary.md`.

**Still open:** the §11.10 items (F_15 Pitch.txt, clocks per step, Q transform, output signal) — all CLI
parameters flagged `UNCONFIRMED` in `preset["fpga_conversion"]`; the absolute FPGA→GPU loop/output scale
(level vs template); retuning tension to `Notes_freqs` (the FPGA `ttn` grid check is −365 c median with batch2).

**Update after §11.11 (2026-10-01).** The converter defaults now follow §11.11: exciter step **96 clocks**
(was 512), strings 512, modes 256, output Δq — all recorded as `DERIVED` in `fpga_conversion.unknowns`
(`OVERRIDDEN` if changed); Q stays `UNCONFIRMED` with the derived oscillator equation in its note. F_15
re-render (A1/C4/C7, both Pitch.txt): gauss centres 0.24–6.1 ms, force beyond the 7 ms window 0.02 % max
(was 79 %); level vs the previous set A1 +4…6 dB, C4 +16…20 dB, C7 +5 dB, so the deficit vs the template is
now **9–16 dB** (mainly the `host_max` mode-mass scale); A1/C4 pitch unchanged within 1 c; no NaN/Inf.

**Update after §11.12 (batch 4, 2026-10-01).** Applied §11.12.6: F_15 Pitch.txt (batch4, recognised by a
whitespace-independent content hash) and `speaking_offset = 21.3` are `DERIVED`; `mode_q = host_q` is the
`DERIVED` default with the exact decay-rate match (`γ = −ln(1−D)/dt_mode`, `decrement = (1−e^(−γ/sr))·sr/f`;
F_15 0.39–39.7); stm32 verbatim evidence in every note; negative-shteg coupling recorded as approximated.
FPGA-grid tuning check: **median +0.7 c, IQR −6.3…+13.3 c**. F_15 renders (A1/C4/C7 × v64/v110): stable, no
NaN/Inf; level **26–30 dB below the template at A1/C4, 8–10 dB at C7** (the real heavy mode damping costs
12–18 dB at A1/C4 vs `--mode-q template`); C4 decays faster (−12…−16 dB/s vs −7…−8); rendered pitch is the
template tension's (A1 ≈ −1 c, C4 −20 c). `host_median` still runs away with host_q, so `host_max` stays.
Evidence: `docs/development/diagnostics/dev-a480-renders/summary.md`.

**Update: F_15's own string physics at ArraySize 512 (2026-10-01, user directive "tuned by itself").** The
template-tension approach is gone. `fpga_string_layout` builds the strings from F_15: blocks = the 57 FPGA
512-point arrays (+1 output block, 232 strings, `array_size=512` — a runtime load parameter, no rebuild),
point counts from Pitch.txt, and tension/stiffness/damping/unison solved so the `parameterKernel`
coefficients equal the FPGA update term by term (bending sign: GPU `+2cb·fd` vs FPGA `−Disp·fd`). Mapping
bugs found by measurement and fixed: (1) `tail = 0` makes `StringGeometry.dx()` return its dummy-string
sentinel → GPU tail ≥ 1; (2) the engine vibrates `main − 1` points (pure-string sweep: treble 0.96–0.98
point) → `main = N_eff + 1`; (3) the speaking offset refit with the **exact clamped FPGA scheme** is 21.1
(median −0.2 c, IQR ±6.4 c vs the continuous formula's 21.3, IQR −6…+13). At 16 sub-steps (= the FPGA step) the then-current
engine grew +170…275 dB/s on the stiff bass strings — root cause found later by dev-1e95: float32 rounding
of the per-sub-step update at high string_iteration (fixed in PianoidCore 682a535, see the last update). **Result (16 keys, v64/v110):** every key within ±2.5 c of the
FPGA scheme's own prediction (C2 −11 c); vs `Notes_freqs` median −1.5 c, IQR −5.2…+3.5 c; A0 −36 / C8 +35 c
are F_15's own tuning. No NaN; all decay (A1 −4…−10, C4 −11…−13, C7 −55 dB/s); level 12–41 dB below the
template. Evidence: `docs/development/diagnostics/dev-a480-renders/summary.md`.

**Update: sub-steps per sample (2026-10-01).** On the pre-fix engine 12 and 16 ran away on F_15's stiff bass
strings (float32 rounding of the per-sub-step update, dev-1e95). On the fixed engine (PianoidCore 682a535,
summed-form float32 FDTD loop) N = 4/8/12/16 are all stable (MIDI 21–33, 60, 96 × v64/v110), so the converter
default is **16 = the FPGA string step** (rate scale exactly 1): full A/C sweep vs `Notes_freqs` median
−1.1 c, IQR −7.0…+3.3 c; vs the FPGA scheme median −1.0 c, max 7.8 c; ~1.0 ms per 64-sample cycle offline
(budget 1.333). Table: `docs/development/diagnostics/dev-a480-renders/summary.md`.

**Update: old swapped-decode presets regenerated (2026-10-01, user decision "Regenerate and replace").**
`Belarus_8band_196modes_FPGAexc` (source Bl_Apr_19) and `Belarus_196modesC_Fanera6exc` (source Fanera_6 —
exact swapped decode, no hand edit) had only their excitation rebuilt with the corrected decode; originals
backed up as `*.pre-a480-swapped.json`. Details: [middleware OVERVIEW](../modules/pianoid-middleware/OVERVIEW.md#loading-fpga-presets).

**Update: engine dev-f2b8 (2026-10-01, PianoidCore cc4b540 / PianoidBasic 91086d7).** The kernel now applies
`dt/dt_ref` to the HF-damping and damper terms and the excitation impulse is dt-weighted. The converter writes
`disp_decay` and `damper_string` at the reference grid (`k_ref = dt_ref/dt_fpga`, N-independent; kernel
equivalence re-tested) and sets `output_scale_calibrated = false`. F_15 at N = 4/8/16: pitch, decay and level
are now N-independent (A1/C4/C7 −101.5/−115.7/−132.2 dB; at N = 16 that is +12 dB vs before); 14–39 dB below
the Belarus template; no NaN. The regenerated `*_FPGAexc` presets (4 sub-steps) are unaffected.
