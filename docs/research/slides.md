---
marp: true
theme: uncover
paginate: true
backgroundColor: #0a0a14
color: #e0e0e8
style: |
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');
  section {
    font-family: 'Inter', sans-serif;
    font-size: 23px;
    padding: 40px 60px;
  }
  section.lead {
    text-align: center;
    display: flex;
    flex-direction: column;
    justify-content: center;
  }
  section.lead h1 {
    font-size: 2.4em;
    margin-bottom: 0.4em;
  }
  h1 { color: #ffffff; font-size: 1.5em; border-bottom: 3px solid #2255aa; padding-bottom: 0.15em; margin-bottom: 0.3em; }
  h2 { color: #7799dd; font-size: 1.0em; margin-top: 0.3em; margin-bottom: 0.2em; }
  h3 { color: #5599ee; font-size: 0.95em; margin-bottom: 0.15em; }
  strong { color: #ffffff; }
  a { color: #5599ee; }
  table { font-size: 0.78em; width: 100%; }
  th { background: #1a1a2e; color: #7799dd; padding: 5px 10px; border-bottom: 3px solid #2255aa; }
  td { padding: 4px 10px; border-bottom: 1px solid #1a1a2e; }
  blockquote {
    background: #0e1222;
    border-left: 4px solid #2255aa;
    padding: 0.3em 0.8em;
    margin: 0.25em 0;
    font-size: 0.88em;
    color: #99bbee;
  }
  blockquote strong { color: #ffffff; }
  ul { font-size: 0.88em; }
  li { margin: 0.08em 0; }
  .aside {
    background: #111122;
    border: 2px solid #2a2a55;
    border-radius: 8px;
    padding: 0.4em 0.8em;
    text-align: center;
    font-style: italic;
    color: #9999bb;
    margin-top: 0.5em;
    font-size: 0.85em;
  }
  .green { color: #44bb77; }
  .red { color: #886666; }
  .blue { color: #5599ee; }
  .dim { color: #888899; }
  .orange { color: #cc8855; }
  .small { font-size: 0.75em; color: #8888aa; }
---

<!-- _class: lead -->

# What if the soundboard were the only thing that mattered?

GPU-Accelerated Soundboard Design with Physical Fabrication and Acoustic Verification

Co-Development Proposal: Industry + University

**PIANOID** — Real-Time GPU-Accelerated Physical Modeling Piano Synthesizer

---

# The Problem

### Why do some pianos sing while others stay dull — and why can't we answer this systematically?

**Systematic soundboard design is economically and methodologically impossible with current tools.** A concert grand has 230 strings coupled through a soundboard with thousands of resonance modes. Evaluating a single design change requires weeks of skilled labor and thousands in materials.

- "Killer octave" — poor sustain in 5th–6th octave. Mechanism understood; the **design solution is not**
- Design knowledge exists as **intuition accumulated over decades**, not as transferable parameters

> **Research question:** Can a closed-loop methodology — FEA design, real-time acoustic preview, physical fabrication, and quantified modal verification — make soundboard design systematic and reproducible?

**The core experiment: A/B synthesis** — FEA-predicted modes vs. physically measured modes on the same engine, isolating model accuracy from synthesizer fidelity.

---

# Research Landscape

| Group | Focus | Key Contribution |
|-------|-------|-----------------|
| Chabassier, Chaigne (Inria/ENSTA) | Full piano FE simulation | Energy-preserving string + soundboard + air (JASA 2013) |
| MAESSTRO (ANR consortium) | Soundboard CAD tool | FEA modal synthesis; string-soundboard coupling; offline (2022) |
| Ege, Boutillon (Polytechnique) | Experimental modal analysis | High-res soundboard characterization at mfg stages (2018) |
| Välimäki, Bank (Aalto/Budapest) | Real-time piano models | Efficient digital waveguide / IIR with psychoacoustic tuning |
| Modartt Pianoteq | Commercial physical model | ~1000 modes/note, proprietary, no design pipeline |
| Weinreich (U. Michigan) | String coupling theory | Coupled polarization and double decay (JASA 1977) |

**All prior work operates within the conventional piano's constraints.** No existing project treats the soundboard as an independent design variable, and no work closes the loop from FEA-derived modes through real-time synthesis to quantified physical verification.

---

# What Already Exists: The Pianoid Platform

## Working System — demonstrated at NAMM Show and in live concert performances

- **Synthesis algorithm** — full string set with waveguide model, 256 soundboard modes coupled to all strings, real-time on NVIDIA 4070 Ti with 30–50% margin
- **String-mode coupling network** — each soundboard mode is energised by string motion and returns energy back, creating continuous bidirectional exchange. Sympathetic resonance, pedal effects emerge naturally
- **Patented excitation system** — 8-channel electromechanical actuators, tested on a real piano soundboard
- **Modal measurement pipeline** — multi-band ESPRIT extraction with automated mode tracking across 78+ positions

## What This Proposal Builds

- **FEA import pipeline** — extract string-mode coupling matrices from FEA eigenmode output
- **Algorithm improvement** — 256 → 2048 modes (in pipeline), string discretisation, hammer model
- **Soundboard fabrication pipeline** — rapid prototyping, material testing, encasing design
- **Perceptual validation** — ABX (forced-choice perceptual comparison) listening tests

---

# Piano Modelling State of the Art — And Its Gaps

| Capability | MAESSTRO | Pianoteq | Pianoid (current) | <span class="blue">Proposed System</span> |
|---|---|---|---|---|
| Synthesis speed | <span class="red">16 min/note</span> | <span class="green">Real-time</span> | <span class="green">Real-time, 48 kHz</span> | <span class="green">Real-time, 48 kHz</span> |
| Polyphony | <span class="red">Single note</span> | <span class="green">Full</span> | <span class="green">Full set of strings</span> | <span class="green">Full set of strings</span> |
| Multi-string coupling | <span class="red">No</span> | <span class="dim">Proprietary</span> | <span class="green">256 modes</span> | <span class="blue">2048 modes</span> |
| Soundboard from FEA | <span class="green">Yes</span> | <span class="red">Hand-tuned</span> | <span class="red">Measured only</span> | <span class="blue">FEA-derived</span> |
| Modal measurement | <span class="red">No</span> | <span class="red">No</span> | <span class="green">ESPRIT pipeline</span> | <span class="green">ESPRIT pipeline</span> |
| Design verification | <span class="red">No</span> | <span class="red">No</span> | <span class="red">Not yet</span> | <span class="blue">A/B synthesis</span> |
| Unconstrained soundboard | <span class="red">Conventional</span> | <span class="red">Conventional</span> | <span class="green">8-ch prototype</span> | <span class="blue">Multi-point excitation</span> |

<span class="small">Blue = proposed capabilities that this project delivers.</span>

---

# How We Enable the Loop

Closing the design loop requires two capabilities that no existing tool provides:

> **Real-Time Polyphonic Preview**
> GPU modal synthesis with full string-mode coupling lets a pianist **play** the designed soundboard — not listen to single offline notes. Design changes are heard instantly. Iteration takes minutes, not weeks.

> **Patented Excitation System**
> Electromechanical actuators replace physical strings entirely. No permanent tension, no iron plate, no frame. Soundboards are **swappable** — free mounting with no stress. A new design can be tested acoustically in hours.

Together, these make the FEA → preview → fabricate → measure → verify cycle practically executable.

<div class="aside">Freeing the soundboard from its structural role also opens the door to designs that no conventional piano could accommodate.</div>

---

# The Closed Loop

**FEA Design** → **GPU Preview** → **Fabrication** → **Measurement** → **A/B Evaluation**
← ← ← *Below threshold? Revise FEA model, iterate from Phase 1* ← ← ←

**Loop closure:** quantified modal correlation (frequency, MAC, damping) defines go/no-go. A/B perceptual test validates convergence.

> **Phases 1–2: Design & Preview** — FEA eigenvalue analysis. Per mode: **frequency, quality factor, modal mass, mode shape amplitudes at excitation positions**. Mode shapes define the string-mode coupling matrices.

> **Phase 3: Fabrication** — Reduced-scale test boards. Spruce, plywood, composites. Carbon fiber ribs are **a hypothesis to test**, not a proven approach.

> **Phase 4: Modal Verification** — Multi-channel ESPRIT + automated mode tracking. FEA-vs-measured: frequency, MAC (Modal Assurance Criterion), damping.

> <span class="blue">**Phase 5: A/B Synthesis & Evaluation** — **The core experiment:** same engine, FEA modes vs. measured modes. Isolates model accuracy from synthesizer fidelity. ABX listening tests, expert musician assessment.</span>

---

# Co-Development: Industry + University
<span class="small">(partner institution TBD)</span>

## Pianoid (Industry Partner) Brings
- **GPU synthesis engine** — real-time modal synthesis with string-mode coupling (working)
- **Patented excitation system** — 8-channel actuator prototype
- **Modal measurement pipeline** — ESPRIT extraction, automated mode tracking
- **FEA import tool development** — FEA eigenmode output → engine parameters
- **Engine and algorithm R&D** — mode capacity, string discretisation, hammer model

## University Partner Brings
- **FEA expertise** — orthotropic material characterization, rib/bridge geometry, mesh convergence
- **Music perception science** — ABX test design, psychoacoustic evaluation, statistical analysis
- **Prototyping and testing facilities** — vibration lab, anechoic chamber, accelerometers, CNC
- **Acoustic radiation modelling** — sound field prediction; potential coupled structural-acoustic FEA
- **Credentialing in acoustics community** — peer-reviewed venues, conference networks

<span class="small">IP: commercial technology retained by Pianoid. Academic publications and modal datasets fully open. Terms negotiated jointly.</span>

---

# Why Now?

## Technology Convergence
- **GPU compute is crossing the threshold** — real-time synthesis with waveguide strings and full string-mode coupling is feasible for the first time
- **MAESSTRO laid the FEA groundwork** — soundboard modal synthesis is proven; missing piece is real-time performance and a verification loop
- **Modal analysis tools are mature** — ESPRIT and related methods extract hundreds of modes reliably

## Platform Readiness
- **Pianoid is demonstrated** — patented excitation, engine, and measurement pipeline shown at NAMM and in live concert performances
- **The unconstrained design concept is now executable** — the required combination of technologies has only recently become available

## Growing Demand
- **Sustainable materials** — new candidate soundboard materials need acoustic evaluation tools
- **Digital twin methodology** — established in aerospace/automotive; extending to acoustic instruments is timely

---

# Timeline and Risks

| Phase | Months | Deliverable |
|-------|--------|------------|
| Mode capacity scaling | 1–2 | 2048-mode validation |
| String & hammer improvements | 1–3 | Upgraded waveguide + excitation |
| FEA import tool | 1–3 | Working pipeline |
| FEA soundboard design | 2–5 | Modal basis, 2+ designs |
| GPU preview & iteration | 4–6 | Playable virtual instruments |
| Prototype fabrication | 4–8 | Reduced-scale test boards |
| Measurement & verification | 7–9 | FEA-vs-measured data |
| A/B evaluation & performance | 8–11 | Playable prototype, ABX |
| Publication | 10–12 | Papers, dataset |

> <span class="orange">**Algorithm improvements fail**</span> — Mode scaling, discretisation, or hammer model exceed budget. **Fallback:** current algorithm stays as-is — proven in live performances.
> <span class="orange">**Poor FEA correlation**</span> — Start simple. Discrepancies inform refinement — **this is the research.**
> <span class="orange">**Prototype validity**</span> — Spruce baseline alongside experimental materials.
> <span class="orange">**Partnership timeline**</span> — Parallel workstreams; industry work proceeds independently months 1–3.

---

# Expected Outcomes

## Scientific
- **First systematic study** of soundboard acoustics freed from string tension, case geometry, and fixed bridge constraints
- **A/B synthesis results** — controlled comparison of FEA vs. measured modes on the same engine
- **Design guidelines** — quantified sensitivity of acoustic features to structural parameters
- **Open modal dataset** — published characterizations at successive construction stages

## Technological
- **Playable prototype** — fabricated soundboard with excitation system, live acoustic performance
- **Software pipeline** — integrated FEA-to-Pianoid import workflow
- **Modal measurement toolkit** — automated ESPRIT + tracking for instrument characterization

## Industrial
- **Computer-aided soundboard design** with real-time preview
- **Sustainable materials evaluation** pathway
- Foundation for **novel acoustic instrument design** — soundboards unconstrained by piano geometry

---

<!-- _class: lead -->

# What does a soundboard sound like when it is designed purely for sound?

Arbitrary geometry. Any material. Excitation at any point.
No tension. No frame. No constraints inherited from strings.
Every design decision driven by acoustic goals alone.

*Now we have the tools to find out — and to design instruments that could never have existed before.*

**PIANOID**
