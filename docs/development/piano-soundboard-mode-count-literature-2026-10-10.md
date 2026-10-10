# Piano soundboard mode count and modal density: literature review (2026-10-10)

**Purpose:** find out where the "~4000 modes are needed for a faithful piano" figure comes from, gather
measured and computed soundboard modal densities, damping and modal overlap from the literature, and
recommend a target (N, f_max, density law) for the synthetic N-mode generator that feeds the
[4000-mode two-tier proposal](http://localhost:8001/proposals/mode-scaling-4000-implementation-proposal-2026-06-06/).

**Legend:** **[V]** = verified by reading the primary source text (quote given). **[S]** = secondary
(search-engine snippet or citing paper; full text not read). **[I]** = my inference or calculation,
not stated in any source.

---

## 1. Bottom line

1. **No source states "about 4000 modes".** I searched for it directly and through all the obvious
   authors and found nothing. The figure that does exist, and is widely re-cited, is
   **Chabassier, Chaigne & Joly (2013): "In practice, 2400 modes are needed to model the soundboard
   vibrations up to 10 kHz"** (Steinway D grand, FEM Reissner–Mindlin plate). **[V]**
   Later papers repeat it, sometimes rounded: Xie (2024) writes "around 2500 modes of the soundboard
   system as estimated in [10]", where [10] is the Chabassier paper. **[V]**
   - **Likely source of "4000" [I]:** if you extend Chabassier's average density (2400/10 kHz =
     0.24 modes/Hz) to the upper part of the audio band, you get ~4000 at about 17 kHz and ~4800 at
     20 kHz. A second possible mix-up is "1000 modes cover 50–4000 Hz" from Miranda Valiente,
     Squicciarini & Thompson (JASA 2024). **[S]**, as I could not read the full text.
   - In short, ~4000 is a sound *engineering* target for a full-band grand soundboard, but it is an
     extrapolation. It is not a figure from the literature.
2. **Two different "modal densities" need to be kept apart.** This matters directly for Pianoid
   (Ege & Boutillon 2013).
   - **Global** density counts every mode of the board (what FEM produces). For an upright it is about
     0.06 modes/Hz up to ~1 kHz and then holds or rises (FEM). For a grand it is about 0.1–0.24
     modes/Hz.
   - **Apparent (local)** density counts the modes visible from one point. Above f_lim ≈ 1.1 kHz the
     ribs act as waveguides and the modes become *localised*, so this density *falls* with frequency.
     It goes from ~0.06 to ~0.01–0.02 modes/Hz, which gives "about 200 modes … in the [0,10] kHz
     range" as seen from one point. **[V]**
   - Pianoid's measured decks (196 modes; cumulative N ∝ f^0.78 / f^0.60, i.e. density *decreasing*
     with f) match this **apparent** density, both in count and in shape. This strongly suggests that
     ESPRIT on point measurements recovered the locally visible modes, not the global set. **[I]**
3. **Damping:** the loss factor is η ≈ 2 % ± 1 %, with no strong trend over several kHz (Q ≈ 50). The
   decay rate is σ = π η f. There is a bump to ~130 s⁻¹ between 1.2 and 1.5 kHz, which is the onset of
   radiation. **[V]**
4. **Modal overlap** is above 30 % for all frequencies over 150 Hz and about 100 % at 1 kHz (apparent
   density, upright) **[V]**. With the global density of a grand it is several times higher **[I]**.
   Above roughly 0.5–1 kHz, individual board modes cannot be resolved, and what the ear gets is the
   board's response *statistics*: the mean mobility, its fluctuations and the decay rates.
5. **Perceptual evidence:** I found **no listening test** that sets a required number of soundboard
   modes or a frequency limit. The arguments used in practice are (a) the content of the signal: piano
   tones have "significant energy up to 10 kHz and more" (Chabassier) **[V]**; and (b) the board's
   impulse response is "noiselike, similarly to the impulse response of a room" (Bank & Chabassier
   2019) **[V]**, so above the overlap transition a statistical (reverb-like) representation is enough.
   Point (b) is the room-acoustics / Schroeder-frequency argument applied to the board **[I]**.

**Recommended generator target [I]**, justified in §5:
- **Grand:** global density n_g ≈ 0.2 modes/Hz (plausible range 0.12–0.24) above ~1 kHz, with a
  clamped-plate rise below ~1 kHz.
- **f_max = 10 kHz** gives **N ≈ 2000–2400**. This is the literature-backed figure.
- **f_max ≈ 17–20 kHz** gives **N ≈ 3500–4800**. This is "~4000", which is defensible but extrapolated.
- **Keep the 196 measured modes** as the low-frequency, strongly coupled set, and fill only the gap up
  to the target N(f).

---

## 2. Sources: who states which number

### 2.1 Chabassier, Chaigne & Joly 2013. This is the canonical figure.
J. Chabassier, A. Chaigne, P. Joly, "Modeling and simulation of a grand piano," *J. Acoust. Soc. Am.*
134(1), 648–665 (2013). DOI [10.1121/1.4809649](https://doi.org/10.1121/1.4809649). Preprint:
INRIA RR-8181 (Dec 2012), HAL [hal-00768234](https://hal.inria.fr/hal-00768234). I read both texts. **[V]**
- Sec. III.C "Soundboard" (p. 656 JASA; §3.3 RR): *"The soundboard model assumes a diagonal damping in
  the modal basis. Its motion is first decomposed onto the modes of the undamped Reissner–Mindlin
  plate … belonging to the audio range, after semi-discretization in space with higher-order finite
  elements. **In practice, 2400 modes are needed to model the soundboard vibrations up to 10 kHz.**"*
- Sec. III.F / IV (p. 659): *"Nearly 3000 degrees of freedom (DOFs) are used on each string of the
  triplet, **420 000 DOFs are used to compute the 2400 first modes of the soundboard**, and slightly more
  than 9×10⁷ DOFs are used in the air domain. The time step is 10⁻⁶ s."* Fig. 7 caption: modes computed
  with fourth-order FE, "nearly 450 000 degrees of freedom".
- Frequency limit rationale (p. 659 / §3): *"acoustic wave with noticeable energy content up to 10 kHz"*;
  Conclusion: *"Most of the notes, from bass to treble, show a wideband spectrum, with significant energy
  up to 10 kHz and more."* Computing *"1 s of sound … (with frequency content up to 10 kHz) takes 24 h on
  a 300 CPU cluster."*
- The board is a Steinway D: an orthotropic spruce Reissner–Mindlin plate, with ribs and bridges
  modelled as heterogeneities in material and thickness (Table I: spruce ρ = 380 kg/m³,
  E_x = 11 GPa, E_y = 0.65 GPa).
- Damping (Eq. 17 in RR): uncoupled oscillators `X'' + ξ(f_n) X' + (2πf_n)² X = F_n`, where ξ is
  *"a positive damping function matching experimental data"*. This is mode-by-mode modal damping, the
  same structure Pianoid uses.
- **What the 2400 refers to:** the *global* count of FEM eigenmodes of the full soundboard below
  10 kHz. It is not FEM DOFs (420 k), not a filter order, and not string partials.
  Average density: **0.24 modes/Hz** over 0–10 kHz **[I]**.
- Fig. 15 (G6, below the 1571 Hz fundamental) shows *"a large density of soundboard modes"* in both the
  simulated and measured pressure spectra. In other words, board modes are audible in the attack.

### 2.2 Ege, Boutillon & Rébillat 2013 (measured upright board)
K. Ege, X. Boutillon, M. Rébillat, "Vibroacoustics of the piano soundboard: (Non)linearity and modal
properties in the low- and mid-frequency ranges," *J. Sound Vib.* 332(5), 1288–1305 (2013).
DOI [10.1016/j.jsv.2012.10.012](https://doi.org/10.1016/j.jsv.2012.10.012); arXiv
[1212.2323](https://arxiv.org/abs/1212.2323). I read the full text. **[V]**
- The measurements use **ESPRIT** high-resolution modal analysis, 50 Hz–3 kHz, on an upright piano in
  playing condition (the same family of method Pianoid's decks come from).
- §5.3: *"The average modal spacing … is around **22 Hz for the 21 lowest modes**, in agreement with
  comparable low-frequency studies (≈25 Hz for a similar upright … and ≈22 Hz for a baby grand [Suzuki])."*
- §5.3: *"Below 1.1 kHz … The modal density increases slowly and **tends towards a constant value of
  about 0.06 modes Hz⁻¹**: the soundboard seems to behave more or less like a homogeneous plate."* The
  slow rise is *"characteristic of constrained boundary conditions"*, which are effectively clamped.
- §5.3: *"For frequencies above 1.1 kHz, n(f), as measured at a given point, decreases significantly …
  **the FEM and the experimental estimations of the modal density differ completely**: the apparent
  modal density, estimated at one given point, is roughly the same everywhere but not the same as the
  global modal density given by a numerical simulation. This can be explained by the localisation of
  the vibrations … the modes detected by one particular accelerometer are only those having a
  significant level where the accelerometer is located."*
- §5.1 damping: *"the modal loss-factors up to around 1200 Hz range from 1% to 3% (mean of η ≈ 2.3% for
  the 55 lowest-frequency estimations)"*; *"modal dampings increase from a mean value of about 80 s⁻¹
  below 1200 Hz to about 130 s⁻¹ between 1200 and 1500 Hz"*; *"Above 1.8 kHz … the loss factors are
  again in the order of the material loss-factors for spruce."*
- Overlap (Conclusion): *"the modal overlap appears to range from **30% at 150 Hz to 100% at 1 kHz,
  decreasing down to 60% at 3 kHz**. The loss factor appears to be maintained between 1 and 3% over
  several kHz."* §3: *"the modal overlap factor μ exceeds 30% for all frequencies above 150 Hz."*
- Companion conference paper, Ege & Boutillon, arXiv [1212.3068](https://arxiv.org/abs/1212.3068):
  *"The modal density of the spruce board varies between 0.05 and 0.01 modes/Hz"*; mean loss factor
  ≈ 2 %. **[V, via fetch summary]**

### 2.3 Boutillon & Ege 2013 (reduced models; the "200 modes" sentence)
X. Boutillon, K. Ege, "Vibroacoustics of the piano soundboard: Reduced models, mobility synthesis, and
acoustical radiation regime," *J. Sound Vib.* 332(18), 4261–4279 (2013).
DOI [10.1016/j.jsv.2013.03.015](https://doi.org/10.1016/j.jsv.2013.03.015); arXiv
[1305.3057](https://arxiv.org/abs/1305.3057). I read the full text. **[V]**
- Abstract: *"The apparent modal density of the soundboard of an upright piano in playing condition, as
  seen from various points of the structure, exhibits two well-separated regimes, below and above a
  frequency f_lim that is determined by the wood characteristics and by the distance between ribs.
  Above f_lim, most modes appear to be localised, presumably due to the irregularity of the spacing and
  height of the ribs."* §2: f_lim = min(f_gs) ≈ **1.1 kHz**.
- §1 (point 4): *"For frequencies above ≈1.1 kHz, the ribs confine wave propagation and inter-rib spaces
  appear as structural wave-guides."* Above f_lim, the apparent density at a point is modelled as the sum
  of the densities of **three adjacent inter-rib waveguides** (Eq. 19, Fig. 2). The second transverse
  waveguide mode appears above ≈4.4 kHz.
- §3: *"counting all the modes of the soundboard results in a modal density continuing the
  low-frequency trend. However, counting only the modes detected at one given point results in a modal
  density n(f) depending on the point … and decreasing with frequency."*
- §4: ***"With a modal density of roughly 0.02 Hz⁻¹, about 200 modes are potentially involved in the
  [0,10] kHz frequency range."*** This is the apparent, per-point count, and it is the relevant figure
  for what one bridge point couples to. The authors go on: *"The modal description does not bear any
  musical significance in itself … it seems reasonable to derive the values of the modal parameters"*
  from a few global quantities. This supports a statistical (synthetic) treatment.
- Appendix A, the asymptotic density of a plate of area A: n∞ = A / (2√D̃), where D̃ = D/(ρh) is the
  "dynamical rigidity" (m⁴ s⁻²). The low-frequency correction for perimeter L is
  n(f) = n∞ [1 + γ (L/A)(D̃)^{1/4} / (2√(2π f))], with γ = −1 for clamped edges (Xie, Thompson & Jones).

### 2.4 Chaigne, Cotté & Viggiano 2013 (FEM, upright-size ribbed board)
A. Chaigne, B. Cotté, R. Viggiano, "Dynamical properties of piano soundboards," *J. Acoust. Soc. Am.*
133(4), 2456–2466 (2013). DOI [10.1121/1.4794387](https://doi.org/10.1121/1.4794387). I read the full text. **[V]**
- Ribbed clamped orthotropic plate, 1.41 × 1.01 m, 9 mm thick (upright size). FE with ≈10⁴ elements
  *"expected to yield a reasonable estimation of the **nearly 700 modes** in this frequency range"*
  (0–5 kHz). Mode 173 is at **2149 Hz** (Sec. II).
- Ribs *"behave as waveguides above nearly 1.1 kHz"*. Localisation is confirmed. *"31 modes are
  sufficient to obtain the ODS"* at one frequency. Experimentally, *"it is often difficult to isolate
  modes … in the medium and high frequency range because of overlapping"*.
- Implied global density **[I]**: about 0.08/Hz on average below 2.15 kHz and **about 0.185/Hz between
  2.15 and 5 kHz**. So the global density *rises* with frequency, which is the effect of
  Mindlin-type shear and the rib structure. This is the opposite trend to the apparent density.

### 2.5 Elie, Cotté & Boutillon 2022 (CAD synthesis software)
B. Elie, B. Cotté, X. Boutillon, "Physically-based sound synthesis software for Computer-Aided-Design
of piano soundboards," *Acta Acustica* 6, 30 (2022). DOI
[10.1051/aacus/2022024](https://doi.org/10.1051/aacus/2022024). I read the full text. **[V]**
- The modal basis is computed **up to 5 kHz** (third-order FE, ~2 h), with a constant modal loss factor.
  The global density of the reference grand is *"qualitatively similar with that of an upright piano
  measured in [Ege] but with larger values. Given the smaller surface of upright soundboards … this is
  in agreement with our expectations."* The asymptote is n∞ ∝ S/√(D/ρh) ∝ S/h (Courant–Hilbert).

### 2.6 Corradi, Miccoli, Squicciarini & Fazioli 2017 (Fazioli grand, measured)
"Modal analysis of a grand piano soundboard at successive manufacturing stages," *Applied Acoustics*
125, 113–127 (2017), DOI [10.1016/j.apacoust.2017.04.010](https://doi.org/10.1016/j.apacoust.2017.04.010);
[preprint](https://miccoli.faculty.polimi.it/preprints/soundboard-20160727.pdf). I read the full text. **[V]**
- *"52 modes up to 450 Hz for the soundboard at stage 1, 39 modes up to 386 Hz … stage 2, 34 modes up to
  348 Hz … stage 3. The identified damping ratios vary from 0.4% to 1.0% for the first two stages, from
  0.8% to 4.0% for the third stage."* That is about 0.1 modes/Hz at low frequency for a grand. Note that
  the damping ratio is ζ = η/2.
- Above the transition, *"the increasing modal density makes it impossible to separate the different
  modes"*. Their FE frequency-response function up to 4 kHz uses ζ = 2 % for all higher modes.

### 2.7 Synthesis-oriented works (Bank et al.)
- B. Bank, S. Zambon, F. Fontana, "A Modal-Based Real-Time Piano Synthesizer," *IEEE TASLP* 18(4),
  809–821 (2010). [PDF](https://home.mit.bme.hu/~bank/publist/taslp10.pdf). **[V]** The soundboard is
  a *measured* response. Their example uses a typical **20 000-tap** IR via FFT convolution. As an
  alternative they use a parallel second-order filter with **100 log-spaced poles** (order 200), where
  "each second-order section [is] one normal mode". This is a perceptual/efficiency compromise, not a
  physical mode count.
- B. Bank, J. Chabassier, "Model-Based Digital Pianos: From Physics to Sound Synthesis," *IEEE Signal
  Processing Magazine* 36(1), 103–114 (2019), DOI [10.1109/MSP.2018.2872349](https://doi.org/10.1109/MSP.2018.2872349);
  HAL hal-01894219. **[V]** §4.4: *"The impulse response of a piano soundboard is quite noiselike,
  similarly to the impulse response of a room, albeit with much shorter decay."* High-frequency modes
  *"are trapped between"* ribs (Fig. 4 caption). No mode count is given.
- H. Xie, "Physical Modeling of Piano Sound," arXiv [2409.03481](https://arxiv.org/abs/2409.03481)
  (2024). **[V]** *"For around 2500 modes of the soundboard system as estimated in [10] (Chabassier)…"*
- P. Miranda Valiente, G. Squicciarini, D. J. Thompson, "Influence of soundboard modelling approaches
  on piano string vibration," *JASA* 155(5), 3213–3232 (2024), DOI
  [10.1121/10.0025925](https://doi.org/10.1121/10.0025925). **[S]**: a search snippet says *"To cover a
  frequency range between 50 and 4000 Hz, 1000 modes of the soundboard are included in the modal
  summation."* I could not read the full text because of a 403.

### 2.8 Not found
I found no explicit soundboard mode count needed for synthesis in Conklin, Wogram, Suzuki, Giordano,
Bensa, Berthaut, Askenfelt, Moore, or Fletcher & Rossing. These works give low-frequency spacings
(Suzuki ≈22 Hz on a baby grand, as quoted by Ege) or mobility data, not N for the full band. I did not
read every one in full, so this is an absence-of-evidence statement.

---

## 3. Modal density compared with frequency

The table below combines verified values with derived ones (marked [I]):

| Board | Below ~1 kHz | Above ~1.1 kHz | Cumulative N | Source |
|---|---|---|---|---|
| Upright, measured, **apparent** (per point) | 22 Hz spacing at the lowest modes (0.045/Hz), rising to 0.06/Hz | falls to ~0.01–0.02/Hz | "about 200 modes in [0,10] kHz" | Ege 2013; Boutillon & Ege 2013 [V] |
| Upright, **global** (FEM) | ~0.06–0.08/Hz | ~0.19/Hz (2–5 kHz) | 173 at 2.15 kHz; ~700 at 5 kHz | Chaigne 2013 [V], densities [I] |
| Fazioli grand, measured, low frequency | 34–52 modes below 350–450 Hz (~0.1/Hz) | not resolvable | — | Corradi 2017 [V] |
| Steinway D grand, **global** (FEM, Reissner–Mindlin) | — | — | **2400 at 10 kHz** (average 0.24/Hz) | Chabassier 2013 [V] |
| Pianoid decks (ESPRIT) | — | — | 196 modes; fitted N ∝ f^0.78 / f^0.60 → 560 / 321 below 20 kHz | measured by Pianoid |

**Thin-plate theory [V formula, I numbers].** For a thin plate, n∞ = (S/2)·√(ρh/D) modes/Hz, and the
value is independent of frequency. For an orthotropic plate, replace D with an effective √(D_x D_y)
including the twisting term. Ege's measured n∞ ≈ 0.06 /Hz with an upright area S ≈ 1.4 m² implies an
equivalent rigidity D̃ = (S/2n)² ≈ 135 m⁴ s⁻², which is consistent with Ege's Fig. B.1 range. With the same
D̃ and a grand area of ≈2.5–2.7 m², n∞ ≈ 0.11–0.12/Hz. Chabassier's higher average (0.24/Hz) is
consistent with two effects that raise the global density at high frequency: Reissner–Mindlin
shear/rotary-inertia softening, and the rib/heterogeneity structure. Chaigne's FEM shows the same rise.

**Cumulative global count, grand [I]:**

| f_max | n = 0.12/Hz (thin-plate scaling) | n = 0.24/Hz (Chabassier average) |
|---|---|---|
| 5 kHz | ~600 | ~1200 (Chabassier's own count here is probably lower, ~900, because density rises with f) |
| 10 kHz | ~1200 | **2400 (sourced)** |
| 20 kHz | ~2400 | ~4800 |

For an upright, roughly halve these.

**Modal overlap M = η·f·n(f) [formula standard; numbers I]:**
- Upright, apparent density (η 0.02): measured 0.3 at 150 Hz and 1.0 at 1 kHz (Ege) [V].
- Grand, global density 0.2/Hz with η = 0.02: M ≈ 1 at 250 Hz, M ≈ 3 at 750 Hz, M ≈ 20 at 5 kHz.
- **The resolvability limit is at about M ≈ 1–3.** That puts it near **≈0.3–1 kHz** for a grand. Above it,
  the board's frequency response is a statistically fluctuating mobility, as in a room above its
  Schroeder frequency.

**Damping [V]:** η ≈ 0.02 (range 0.01–0.03), roughly constant up to several kHz. Corradi gives
ζ = 0.4–4 % (η = 0.8–8 %) on a finished grand at low frequency. The decay rate is σ = π η f, which is
≈ 63 s⁻¹ at 1 kHz (T60 ≈ 110 ms). Ege measured ~80 s⁻¹ below 1.2 kHz, rising to ~130 s⁻¹ in 1.2–1.5 kHz.

---

## 4. Perceptual considerations

- I found no listening test that determines the number of modes or the f_max required for a
  soundboard model. Commercial and real-time systems (Bank, Pianoteq-style) use measured IRs
  (~20 k taps), ~100 log-spaced resonators, or reverb-like FDNs. Their quality comes from matching the
  *response statistics*, not from enumerating physical modes. [V for the methods; I for the
  interpretation]
- The physical argument [I]:
  - *Below ~0.5–1 kHz* individual board modes are resolvable. They shape partial decay and coupling,
    and they cause beating and phantom effects with string partials. These modes should be the measured
    ones, i.e. Pianoid's shaped tier.
  - *Above ~1 kHz* (M ≫ 1, localisation, waveguides), a synthetic set is perceptually adequate if it
    reproduces three things. First, the **mean conductance** ⟨Re Y⟩ = n(f)/(4M_total), which equals
    the plate characteristic mobility 1/(8√(Dρh)) — a standard identity, which I checked algebraically.
    Second, the **fluctuation statistics**, which need a high enough density for M ≫ 1. Third, the
    **decay rates** (η ≈ 2 %).
  - What content matters: piano spectra have significant energy to ≥10 kHz (Chabassier) [V]. Board
    content above ~10–12 kHz is low in level and partly masked, so 10 kHz is the evidence-backed cutoff
    and 20 kHz is the conservative one.

---

## 5. Recommendation for the Pianoid synthetic N-mode generator [I]

1. **Target N and f_max.**
   - The **literature-backed figure is N ≈ 2400 up to 10 kHz** for a concert grand (Chabassier 2013).
   - For full-band (20 kHz) coverage at the same density, N ≈ 4000–4800.
   - **N = 4000 is a reasonable design target** if f_max ≈ 17–20 kHz, or if the density is set to
     ≈0.2/Hz to 20 kHz. Document it as an extrapolation from Chabassier, not a sourced number.
   - Make the generator parametric in (n_g, f_max) so that 2400@10 kHz and 4000@~18 kHz are both one
     preset.
2. **Density law** (global, grand):
   - n(f) = n_g · [1 − √(f_b / f)]₊ for f ≤ ~1.1 kHz. This is the clamped-plate rise of Ege/Xie
     (Appendix A form), with f_b set so the first mode lands at the measured lowest board mode
     (~50–100 Hz).
   - n(f) ≈ n_g (constant), or a slowly rising law, above 1.1 kHz.
   - Use n_g ≈ 0.12 (thin-plate scaling) to 0.24 (Chabassier) per Hz; **0.2/Hz is a middle choice.**
   - Cumulative count: N(f) = ∫ n.
3. **Fill, don't replace.** Keep the 196 measured modes. They are the *apparent* (strongly coupled)
   set, and their count of ~200 and sublinear N ∝ f^0.6–0.8 match the per-point apparent density of
   Boutillon & Ege ("about 200 modes … [0,10] kHz"). In each frequency band, add synthetic modes equal
   to N_target − N_measured.
4. **Frequencies.** Use jittered-uniform or level-repelling spacing rather than Poisson. This avoids
   unphysical near-degenerate clusters; it is a modelling choice, not sourced.
5. **Damping.** η per mode lognormal around 0.02 (1–3 %): σ_n = π η f_n. Optionally add the 1.2–1.5 kHz
   bump to ~130 s⁻¹.
6. **Coupling and mass scaling.** Scale synthetic coupling and modal mass so that the mean bridge
   conductance follows n(f)/(4M_total), continuous with the measured low-frequency band. Adding 20×
   more modes must not add 20× more energy.
7. **Caveat for the "uniformly flat" tier.**
   - Physically, above f_lim each mode is localised within ~3 inter-rib waveguides, so a given string
     couples strongly only to the ~0.02/Hz apparent subset.
   - A flat tier where every string couples equally to all ~4000 modes gives each string a much denser
     (smoother) driving-point mobility than a real board does, and it gives strong cross-string coupling
     through all modes.
   - If the flat tier stays global, compensate in amplitude by the conductance rule in item 6. If
     timbre comes out too smooth or too reverberant, the physically motivated refinement is band-wise
     random *sparse* coupling: each high-frequency mode couples to the strings whose bridge points lie
     in its waveguide neighbourhood.

**Confidence:**
- High that the canonical sourced figure is 2400 modes / 10 kHz (Chabassier 2013), and that "4000" is
  not stated in the reviewed literature.
- High on the measured upright values: 0.06/Hz, f_lim ≈ 1.1 kHz, η ≈ 2 %, overlap 30–100 %, and
  ~200 apparent modes to 10 kHz.
- Medium on the grand's global density (0.12–0.24/Hz), which is inferred from two FEM studies and
  area scaling.
- Low to medium on the perceptual cutoff, because there is no direct listening-test evidence.
