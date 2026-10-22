# Managing the FPGA System from the Pianoid UI

**Date:** 2026-10-22
**Status:** PROPOSAL (design only, no code changed). Agent `dsg-fpga`.
**Request (user, Telegram 2026-10-22):** "I want Pianoid UI to be able to manage FPGA based system."
**Builds on:** [FPGA → GPU Preset Port](fpga-to-gpu-preset-port-2026-09-30.md) (§10–§13 are the reverse-engineered
protocol and data model), [PianoidBasic OVERVIEW — FPGA preset converter](../modules/pianoid-basic/OVERVIEW.md#fpga-preset-converter),
[middleware OVERVIEW — Loading FPGA presets](../modules/pianoid-middleware/OVERVIEW.md#loading-fpga-presets),
[Dima vs Pianoid mode discovery](../development/dima-vs-pianoid-mode-discovery-2026-10-11.md),
[Assistant v2](assistant-v2-2026-10-16.md) (command registry, approval tiers).

Every fact below carries one of the port proposal's labels: **[SRC]** read from Dima's delivered source
(host `Pianoid_QM.c`, stm32 `pianoid.c`, `adjust_tr_10e_4khz.py`), **[DOC]** from our docs, **[INF]** inferred,
**[UNKNOWN]** not in any file we have.

---

## 1. What the repos know about the FPGA system

### 1.1 What it is

| Item | Finding | Label | Source |
|---|---|---|---|
| Owner | Dima Elyashev (with Anton, author of the stm32 firmware headers, 2021) | [SRC] | `batch4/pianoid_commands.h` |
| FPGA | Xilinx Virtex UltraScale+ `xcvu9p`, Simulink / System Generator design. Clock 393.216 MHz (Dima) | [SRC] | port §1.1, §11.8 |
| Controller | **STM32H7** (Nucleo config) between the PC and the FPGA. It receives UDP, forwards every table **verbatim** to the FPGA over SPI (`[0, addr_hi, addr_lo, d3..d0, cmd]`), stores presets in flash, and takes MIDI | [SRC] | port §11.12.1 |
| Synthesis model | The **same closed-loop model as the GPU engine**: FDTD stiff damped strings (228 strings in 57 arrays × 512 points), Gaussian hammer exciter (4 Gaussians × 5 velocity layers), 256 modal oscillators with the identical update equation, signed feed-in (`Ci_coef_cos`) and a separate feedback matrix (`Ci_coef_str`), global FB | [SRC] | port §10.2, §10.5 |
| Output | **16 outputs = per-transducer drive signals** of a physical soundboard: `au_ch = Σ_m decka[m,ch]·out_vol·Ci_str_1_out[m]·Δq_m`, ~97.7 kHz | [SRC] | port §11.2, §13 |
| Physical instrument | A soundboard with 16 transducer channels (7 "working" by default in Dima's tool: 8, 9, 11–15), 6 piezo pickups, a movable current transformer, "powerful low-THD amplifiers" | [SRC] | `adjust_tr_10e_4khz.py:76-85`, `elyashev-2026-10-12/summary_en.md` |
| Relation to our rig | Our rig is an 8 mm plywood board driven by the GPU engine through a UMC1820 (4–7 exciters). Whether Dima's board is the same physical board, a twin, or a different instrument is **not stated anywhere** | [UNKNOWN] | measured-plywood-preset §2 |

### 1.2 How presets move today (one direction only: FPGA → GPU)

| Path | Status | Where |
|---|---|---|
| FPGA preset folder = **53 one-value-per-line `.txt` tables** (`exp_all`, `ind_vol_0..4`, `ind_mult_0..4`, `ttn`, `decr_*`, `omega_coef`, `Mass`, `Q_coeff`, `Ci_coef_cos/str`, `decka_coeff`, `others`, …) + `Pitch.txt` | Dumps received: `Bl_Apr_19`, `Fanera_6`, `F_15` (in `elyashev-2026-09-30`) | `PresetsFromFpga/` |
| **FPGA → GPU converter** (exact host/stm32 formulas, term-by-term string physics, output role) | **Implemented, merged** (dev-a480 / f2b8 / 029c / da62 / b59d). CLI only: `python -m Pianoid.fpga_preset_converter FPGA_DIR PITCH_TXT --template T --out O` | `PianoidBasic/Pianoid/fpga_*.py` |
| Presets produced | `F15_Elyashev_array512*.json`, `Belarus_8band_196modes_FPGAexc`, `Belarus_196modesC_Fanera6exc`, and the measured-mode presets built on F15 | `PianoidCore/pianoid_middleware/presets/` |
| UI | The Tunner loads the **converted JSON** like any preset; it warns on declared load params (`fpga_conversion.load_params`). There is **no UI import of an FPGA folder** and **no export** | `loadParamWarning.js`, REST_API `/load_preset` |
| GPU → FPGA | **Does not exist.** No inverse converter, no table writer | — |

### 1.3 The communication interface (fully specified in Dima's sources; never implemented by us)

| Layer | Finding | Label | Source |
|---|---|---|---|
| Transport | **UDP, fire-and-forget**, PC → `192.168.1.2:5555`. No ack or reply on the network. (An old `ComWrt` serial path is commented out in the host) | [SRC] | `Pianoid_QM.c:59,128,248`; `adjust_tr…py:82-83` |
| Frame | `0x21 0x21 0x22 <cmd0> <cmd1> <lenHi> <lenLo> <payload> 0x23`. Payload = little-endian int32 codes (most tables) or float32 (Ci, decka, FB) | [SRC] | port §11; `adjust_tr…py:1333-1360` |
| Command set | ~69 `cmd0_*` codes: tables (`cmd0_omega`, `cmd0_Ci_out`, `cmd0_Ci_str`, `cmd0_FRQ`, `cmd0_force_graph`, `CMD_recieve_ttn` subs …), runtime (`cmd0_pedal 0xA4`, `cmd0_gain 0xA6`, `cmd0_reset 0xA3`, `cmd0_FB_test 0xC6`, `cmd0_notes_off 0xC8`, `cmd0_transmit_sel 0xB2`), notes (`cmd0_midi 0xA5`, payload `[note, vel]`), flash (`cmd0_erase 0xD0`, `cmd0_write 0xD1`, `cmd0_send_preset 0xD3` = load slot n, 120 sectors per slot) | [SRC] | `batch3/main.h:20-157`, `batch4/pianoid_commands.h` |
| Upload sequence | `send_all` = `send_pitch, Send_params, send_all_molot, send_shape, send_exp_coef, send_udar_param, send_FB, send_ci_zeros, send_ci_out, Send_Omega, Send_Q_coef, out_vol_out, send_mass`. **Dima: "trust the send-all path"** | [SRC] | port §11.8 |
| Encoding formulas | Every `.txt` → code formula is known and already implemented (forward direction) in `fpga_tables.py`, citing `QM:` / `S:` lines | [SRC]+[DOC] | port §11.2, §11.12 |
| Read-back | **None over the network.** `cmd0_read 0xD2` only `printf`s on the stm32 debug UART | [SRC] | `pianoid.c:1367` |
| Notes / MIDI | The stm32 has its own MIDI input (FIFO, note-on 144) and an XY-pad voice path; `cmd0_midi` over UDP plays notes only when `controller == 1`. The CVI host forwards a Windows MIDI-in device over UDP | [SRC] | `pianoid.c:361-368, 2561`; `Pianoid_QM.c:135, 1113` |
| Existing control tools | (a) **LabWindows/CVI host `Pianoid_QM`** (31 k lines, Windows); (b) **`adjust_tr_10e_4khz.py`** — PyQt5 + numpy + `sounddevice`: a working **Python** implementation of the frame format, used for transducer surveys and `decka_coeff` / `omega_coef` | [SRC] | `batch3/`, `elyashev-2026-10-11/` |
| Firmware | The FPGA bitstream (Vivado / System Generator) and the stm32 image are built by Dima; the RTL we have is a 2026-03 reduced model with known version skew | [SRC] | port §11.12.5 |

### 1.4 The gaps

1. **No link code** in any Pianoid repo (no UDP, no frame encoder, no inverse formulas).
2. **No read-back**: any "state of the board" we show would be a shadow of what we last sent.
3. **No GPU → FPGA path**, and the GPU and FPGA feature sets differ (port §3, §11.6): GPU lacks tail tension, a separate feedback matrix, per-(pitch, level) loudness, 16 outputs, noise / knock exciters; the FPGA lacks the bow excitation, the GPU damper law, the parametric hammer.
4. **Network reachability unknown**: whether a Pianoid PC can reach the board's LAN at all.
5. **Safety**: the board drives power amplifiers into transducers. Our side has a current limiter for *our* rig ([Controlled Playback](controlled-playback-exciter-current-2026-10-20.md)); the FPGA side has none we know of.
6. **Absolute scales** (mode mass, output level) are still unconfirmed in the FPGA → GPU direction (port §11.12.4).

---

## 2. What "manage the FPGA system from the Pianoid UI" could mean

| Tier | Meaning | Needs hardware | Effort (agent-days) |
|---|---|---|---|
| **1. Preset exchange** | Import an FPGA folder in the UI (today: CLI); export a GPU preset as an FPGA folder | No | Import **S** (1–2); export **M** (4–6) |
| **2. Live link** | Connect to the board, push a whole preset (`send_all`) or single tables / runtime values (gain, FB, pedal, decka), show a "last-sent" shadow state, panic | Yes (LAN) | **M** (5–8) + hardware session |
| **3. Full control** | Play notes on the board, manage flash preset slots, measure the board's output, (firmware) | Yes | Notes **S**; flash **M**; measurement **M–L** (depends on audio access); firmware **XL — recommend out of scope** |
| **4. Unified UI** | The same panes edit either the GPU engine or the FPGA target; per-field exactness and capability gating | Yes for live | **L** (10–20) |

Tiers are cumulative: 2 needs the encoder of 1-export; 4 needs 2.

---

## 3. Architecture

### 3.1 Principles

- **The FPGA preset is its own document.** The FPGA target's source of truth is the native table set
  (`FpgaPresetDoc`: the 53 tables + `Pitch.txt`), not a GPU preset. GPU ↔ FPGA is a **converter** with
  per-field exactness marks (E / A / X from port §4, §11.5), never a silent identity.
- **One encoder, two directions.** The forward formulas in `fpga_tables.py` already are the host
  `send_all` formulas. The packet encoder and the inverse converter reuse them, so import, export and the
  live link cannot disagree.
- **No GPU needed.** Everything FPGA runs without a loaded CUDA engine (pure Python, no `pianoidCuda`).
- **Wrap, do not fork, the command layer.** New operations are registry commands
  (`schemas/commands/fpga.json`) wrapping new routes, so the assistant, the journal, the read-only guard
  and approval tiers apply automatically ([REST_API — Commands and jobs (I4)](../modules/pianoid-middleware/REST_API.md)).

### 3.2 Components

```
PianoidTunner (:3000)                      Assistant (:3002)
  FPGA pane / target selector                fpga.* commands (registry)
        |  REST + socket.io                        |
        v                                          v
backendServer (:5000) ── fpga_routes.py (blueprint, no engine required)
        |
        ├── targets/  Target interface  ── GpuTarget (wraps today's Pianoid; Tier 4 only)
        |                               └─ FpgaTarget (shadow FpgaPresetDoc + link)
        v
PianoidBasic/Pianoid/
  fpga_tables.py           (existing: .txt read + forward host formulas)
  fpga_preset_converter.py (existing: FPGA → GPU)
  fpga_export.py           (NEW: GPU → FPGA tables, inverse formulas + exactness report)
  fpga_protocol.py         (NEW: frame encoder, send_all sequence, command codes — pure, testable)
  fpga_link.py             (NEW: UDP transport, pacing, dry-run / capture sink, fake-board listener)
```

| Piece | Responsibility |
|---|---|
| `fpga_protocol.py` | `encode_frame(cmd0, cmd1, payload)`; one function per host sender (`send_omega`, `send_q`, `send_mass`, `send_ci`, `send_decka`, …) returning **frames, not I/O**; `send_all(doc) → [frames]` in the host order. Golden tests: byte-exact against frames reconstructed from `Pianoid_QM.c` / `adjust_tr…py` |
| `fpga_link.py` | `FpgaLink(host, port)`: `send(frames, pace_ms)`; `DryRunLink` writes a `.pcap`-like capture; `FakeBoard` = a local UDP listener that decodes frames back into tables (round-trip test without hardware) |
| `fpga_export.py` | GPU preset → `FpgaPresetDoc`, inverting `fpga_string_layout` / `fpga_preset_converter`; refuses or flags fields with no FPGA equivalent; round-trip test F_15 → GPU → FPGA = F_15 within the host `(int)` casts |
| `FpgaTarget` | Holds `doc` (shadow of what was sent), `link`, `connected`, `last_sent[table] = (hash, time)`, `dirty` tables; `push_all()`, `push_table(name)`, `set_runtime(gain/FB/pedal/out_vol)`, `note(n, v)`, `panic()`, `flash_save(slot)`, `flash_load(slot)` |
| `fpga_routes.py` | `GET /fpga/status`, `POST /fpga/connect`, `POST /fpga/import` (folder → doc, and optionally → GPU preset), `POST /fpga/export`, `POST /fpga/push`, `POST /fpga/table/<name>`, `POST /fpga/runtime`, `POST /fpga/note`, `POST /fpga/panic`, `POST /fpga/flash/{save,load}`; socket.io `fpga_status` broadcast |
| UI | Tier 1: "Import FPGA folder…" / "Export to FPGA folder…" in the preset library menu (reuses the launcher file dialog). Tier 2: an **FPGA mosaic pane**: connection (IP / port, reachability), last-sent table list with dirty markers, Send-all, per-table send, runtime sliders (gain, FB, out_vol, pedal), a big Panic button, the transducer mute mask. Tier 4: a toolbar **target selector** (GPU / FPGA / both) |

### 3.3 Assistant commands (registry family `fpga`)

| Command | Tier (approval) |
|---|---|
| `fpga.status`, `fpga.doc.summary`, `fpga.diff {gpu_preset}` | read |
| `fpga.import {folder}`, `fpga.export {preset, folder}` | write |
| `fpga.connect`, `fpga.note`, `fpga.runtime {gain, fb, out_vol, pedal}` | act (inside a volume envelope) |
| `fpga.push_all`, `fpga.push_table` | write (hard-confirm on the first push of a session) |
| `fpga.flash_save {slot}` (erases 120 sectors), `fpga.reset` | destructive (always confirm) |
| `fpga.panic` | act, never gated |

### 3.4 Per-tier design notes

**Tier 1 — preset exchange.**
- Import: a backend route wraps the existing CLI (`fpga_preset_converter.convert(...)`), runs as a job,
  returns the new preset and its `conversion_report.md`; the UI shows the UNCONFIRMED / OVERRIDDEN inputs
  before loading. Input roots are allow-listed (`PresetsFromFpga/`, a user-chosen folder).
- Export: inverse of every E / A row; X rows (GPU-only features) are reported, and FPGA-only tables
  absent from the GPU preset (tail tension, `Ci_coef_str` deviations, `NL`, knock, 16 outputs) come from a
  chosen **base FPGA folder** (e.g. F_15), as the converter does with its template in the other direction.
- Verification surface: round-trip golden test (F_15 → GPU → FPGA tables ≡ F_15 after casts) — no hardware.

**Tier 2 — live link.**
- `send_all` is the only path Dima vouches for; start with it. Single-table pushes come next, each tested
  against the same encoder.
- Pacing: Dima's tool sleeps 8 ms between packets; reuse that until he gives a limit (no flow control exists).
- No read-back: the UI must say "last sent", not "board state". If Dima can add a reply (e.g. an ack with a
  CRC per frame, or a status packet), the link upgrades to verified writes.
- Live engine isolation: the link must never run on the realtime audio thread; it is a background job.
- Verification surface: (a) offline — `FakeBoard` round-trip; (b) on hardware — Dima's own host or a
  pickup recording confirming the board plays what we pushed, with Dima present.

**Tier 3 — full control.**
- Notes: `cmd0_midi` (needs `controller == 1`) or MIDI into the stm32 directly; our MIDI router could
  fan a keyboard to GPU, FPGA or both.
- Flash slots: `cmd0_erase` / `cmd0_write` / `cmd0_send_preset`; destructive, slot map from Dima.
- Measurement: the same rig pipeline (swept sine / PolyMAX in the modal adapter) applies only if the
  board's pickups reach an audio interface we own. A/B "GPU vs FPGA on the same board" is the most useful
  research output of the whole effort.
- Firmware (bitstream / stm32 flashing): needs Vivado, STM32CubeProgrammer and Dima's projects; high risk,
  low value for a UI. **Recommend out of scope.**

**Tier 4 — unified UI.**
- A **parameter adapter** per target maps each pane's field to a target field with an exactness mark;
  panes grey out fields with no equivalent (bow, hammer parametric shape on FPGA; tail tension, 16 outputs
  on GPU) and badge approximate ones.
- Edits route through the existing single-source-of-truth editors; the target selector decides whether the
  write goes to the engine, to the FPGA shadow doc (+ push), or to both.
- The cost is the adapter coverage for every pane, not the plumbing.

---

## 4. Known vs unknown

| Known (from source) | Unknown |
|---|---|
| Model, data model and every table formula (port §11–§12) | Whether our PC can reach `192.168.1.2:5555` (where the board is, which LAN) |
| Transport, frame, command codes, `send_all` order | Whether the delivered host / stm32 code is the version on the board now |
| Flash preset commands, 120 sectors per slot | Number of slots, which slot boots, whether flash writes are safe for us |
| Notes over UDP need `controller == 1` | Pacing limits, whether pushes while playing glitch or need mute / reset |
| No network read-back | Safe output limits for the amplifiers / transducers; a reliable mute |
| Output = 16 transducer drives | Transducer → amplifier wiring; a pickup / mic feed we could record |

---

## 5. Questions only the user or Dima can answer

**For the user**
1. Which tier is the goal (and the order)? Is GPU → FPGA export wanted, i.e. Pianoid-designed presets played on Dima's board?
2. Is Dima's board the same physical plywood board as our rig, or a separate instrument? Where is it?
3. Is firmware / bitstream management in scope? (Recommendation: no.)

**For Dima**
4. Can a Pianoid PC join the board's network (`192.168.1.2:5555`)? Is a remote session possible, or only on site?
5. Are `Pianoid_QM.c` (batch 3) and `pianoid.c` (batch 4) the versions running now? Any newer bitstream / protocol?
6. Can the stm32 reply over UDP (an ack, a CRC per table, a status / version packet)? Would he add one?
7. Is `send_all` safe while sound is on? Does it need `cmd0_reset` / mute first? Minimum delay between packets?
8. Which runtime commands are safe to change live (gain, FB, `out_vol`, pedal, `decka`)?
9. Flash: how many preset slots, which boots, may we write them?
10. Safety: maximum safe `out_vol` / gain per transducer; the right mute / panic command.
11. Notes: should we play via `cmd0_midi` (`controller = 1`) or MIDI into the stm32?
12. Is there a pickup or microphone signal from his board we could record (for A/B and measurement)?
13. Will his CVI host and `adjust_tr` tool keep being used at the same time? (Two writers, no read-back.)
14. Is he fine with us re-implementing his protocol from his sources?

---

## 6. Recommended first step

1. **Send questions 4–14 to Dima now** (they block Tier 2 and 3; the user decides 1–3).
2. **Meanwhile, build the hardware-free foundation (Tier 1 + the Tier 2 encoder), one `/dev` task:**
   - `fpga_protocol.py` + `FakeBoard` with byte-exact golden tests against frames rebuilt from
     `Pianoid_QM.c` / `adjust_tr…py`;
   - "Import FPGA folder" in the UI (a route + command wrapping the existing converter);
   - `fpga_export.py` with the F_15 round-trip test.
   Effort ~1–1.5 agent-weeks; no GPU, no hardware, no risk to the live stack.
3. **First live contact** only after Dima's answers, **with Dima present**: `fpga.connect` + a single
   low-risk table (e.g. `out_vol` low, or the `decka` mute mask), then `send_all` of F_15 itself
   (identity push), confirmed by ear / pickup.

---

## 7. Evidence index

- Protocol: `PresetsFromFpga/elyashev-2026-09-30/batch3/{Pianoid_QM.c,main.h,preset_config.h}` (+ `.utf8.txt`),
  `batch4/{pianoid.c,pianoid_commands.h}`; `PresetsFromFpga/elyashev-2026-10-11/adjust_tr_10e_4khz.py:76-85, 1293-1410`.
- Data model and formulas: [FPGA → GPU port](fpga-to-gpu-preset-port-2026-09-30.md) §10.2, §11.2, §11.12, §13.
- Existing converter: `PianoidBasic/Pianoid/fpga_{tables,string_layout,preset_converter,output_mapping,conversion_metadata}.py`.
- Dima's latest replies: `PresetsFromFpga/elyashev-2026-10-12/summary_en.md`.
