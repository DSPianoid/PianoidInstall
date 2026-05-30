# Research Proposal: Closed-Loop Soundboard Design Using GPU-Accelerated Physical Modeling and Modal Verification

**Principal Technology:** Pianoid — Real-Time GPU-Accelerated Physical Modeling Piano Synthesizer

---

## 1. Executive Summary

We propose a closed-loop methodology for piano soundboard design that bridges the gap between computational modeling and physical realization. The pipeline combines finite-element analysis (FEA) for soundboard design, GPU-accelerated modal synthesis for real-time acoustic preview, physical fabrication, proprietary modal measurement technology for verification, and an electromechanical excitation system for live performance on the fabricated soundboard — all integrated through Pianoid's unified modal framework.

Unlike existing approaches (e.g., MAESSTRO/ANR) that simulate single notes offline in minutes, this pipeline enables real-time polyphonic playback on both the virtual and physical soundboard, closing the design-fabrication-verification loop in a single workflow.

---

## 2. Motivation

### The Piano as an Unsolved Acoustics Problem

The piano is the most mechanically complex acoustic instrument ever created. A concert grand contains over 12,000 parts, with 230+ strings coupled through a wooden soundboard whose vibroacoustic behavior involves thousands of interacting resonance modes. Despite three centuries of refinement, fundamental questions about soundboard design remain unanswered: Why do some instruments "sing" while others remain dull? What structural properties produce the characteristic warmth of a Steinway versus the brilliance of a Fazioli? Why does the "killer octave" (5th-6th octave) suffer from poor sustain regardless of hammer adjustment?

These questions persist because the answers lie in the complex modal interaction between strings and soundboard — a domain where human intuition fails and only computational physics can provide systematic understanding.

### The Craft Knowledge Crisis

Piano making is a dying art. The number of skilled piano builders worldwide has declined steadily over decades, and with them disappears centuries of empirical knowledge about soundboard voicing, rib placement, and wood selection. The few remaining master builders (Steinway, Fazioli, Bechstein, Paulello) guard proprietary techniques that cannot be transmitted through conventional documentation because they are fundamentally experiential — the builder must hear and feel the result of each design choice.

A computational design methodology would not replace the luthier's ear, but would preserve and extend their knowledge: capturing design intuitions as quantifiable modal relationships, enabling apprentices to explore the design space with immediate acoustic feedback, and allowing master builders to test radical innovations (composite materials, novel rib geometries, alternative bridge designs) without the prohibitive cost of physical prototyping.

### The Material Sustainability Challenge

Traditional piano soundboards require high-grade Sitka or Engelmann spruce — slow-growth, quarter-sawn, defect-free timber that is increasingly scarce and expensive as old-growth forests diminish. Alternative materials (carbon fiber composites, sandwich panels, engineered wood) could offer superior acoustic properties at lower environmental cost, but evaluating them empirically requires building full-scale prototypes — an investment no manufacturer will make without strong evidence of acoustic viability.

A simulation pipeline that can predict how material substitutions affect the instrument's sound would unlock a new generation of sustainable piano designs, tested computationally before committing physical resources.

### Beyond the Piano: Relaxing Physical Constraints

The acoustic character of a conventional piano is not only shaped by design choices — it is fundamentally constrained by physical limitations that no amount of craft refinement can overcome:

- **Shape and size** — the soundboard must fit inside a standardized case geometry (grand or upright), limiting its area, aspect ratio, and boundary conditions. The radiating surface is dictated by furniture convention, not acoustic optimality
- **String tension and layout** — strings must sustain 70–100 kg of tension each (15–20 tonnes total), requiring a massive cast-iron plate and rigid frame that constrain soundboard mounting, crown, and vibration. The string layout (fan-shaped, with bass strings crossing treble) is a compromise between musical range and physical space, not acoustic ideality
- **Coupling structure** — the bridge transmits string energy to the soundboard through a narrow wooden strip, whose geometry is constrained by the need to support string downbearing force. The coupling is inherently localized and one-dimensional (along the bridge), limiting how modal energy distributes across the soundboard

These constraints are intrinsic to the acoustic piano as a physical object. But in a hybrid computational-physical system, they can be systematically relaxed or removed entirely:

- **Arbitrary soundboard geometry** — freed from the piano case, a soundboard can take any shape, size, or curvature optimized for target modal properties. Circular, elliptical, or asymmetric designs become viable
- **Decoupled string physics** — when string vibration is computed on GPU rather than sustained by physical tension, string layout, length, and tension become free parameters. The "strings" can have any physical properties, including ones impossible with real wire (e.g., frequency-dependent damping profiles, non-metallic materials)
- **Programmable coupling** — feedin/feedback matrices can implement arbitrary coupling topologies between strings and soundboard modes, not limited to bridge geometry. Energy can be injected at multiple points, with frequency-dependent spatial patterns, or with coupling coefficients that vary dynamically during performance
- **Novel radiating structures** — the soundboard need not be a wooden plate. Composite panels, tensioned membranes, resonant shells, or arrays of small radiators could be designed for specific acoustic goals (directivity, frequency balance, room interaction) that a traditional soundboard cannot achieve

This proposal explicitly includes the exploration of non-traditional designs that would be impossible to evaluate — or even conceive — within the conventional piano paradigm.

### The Scientific Gap: From Simulation to Verification

The MAESSTRO project (ANR-14-CE07-0014, Elie et al., Acta Acustica 2022) made an important first step by demonstrating that FEA-derived modal bases can drive physically-based sound synthesis for soundboard design evaluation. However, their pipeline stops at synthesis — it produces a sound file but provides no methodology for:

- **Interactive evaluation** — computing one 2-second tone requires ~16 minutes, making musical assessment impossible. A pianist cannot judge a soundboard from isolated notes; they need to play chords, arpeggios, pedaled passages, and feel the instrument's dynamic response
- **Polyphonic coupling** — each note is computed independently, omitting the inter-string energy exchange through the soundboard (sympathetic resonance, sustain pedal bloom, after-sound) that constitutes much of what makes a piano sound like a piano
- **Physical verification** — the pipeline has no return path from fabrication to measurement. Without quantitative comparison between predicted and measured modal characteristics, the model's accuracy remains unvalidated, and errors accumulate silently
- **Musical reality** — the designed soundboard cannot be played as a musical instrument until installed in a complete piano, which requires a frame, plate, action, and strings — an investment that defeats the purpose of rapid prototyping

### The Opportunity: Pianoid as the Missing Link

Pianoid's technology stack closes each of these gaps:

- **Real-time GPU synthesis** at 48 kHz with 256 strings × 256 modes in parallel — enabling interactive, polyphonic playback of any soundboard design. A pianist can play the virtual soundboard and evaluate it musically, not just acoustically
- **Feedin/feedback matrices** that model inter-string energy exchange through the soundboard's modal network — capturing sympathetic resonance, sustain pedal effects, and the collective resonance behavior that MAESSTRO cannot model
- **Proprietary modal measurement** using multi-channel ESPRIT extraction with automated sliding-window mode tracking — enabling rapid, high-resolution characterization of fabricated soundboards with quantitative comparison to FEA predictions
- **Electromechanical excitation system** — allowing the fabricated soundboard to be played as a musical instrument directly, without installation in a traditional piano frame. The soundboard becomes a standalone instrument driven by GPU-computed string physics

This creates a closed loop: design → preview → fabricate → measure → verify → redesign — with real-time musical evaluation at every stage.

---

## 3. Proposed Pipeline

### Phase 1: Computational Soundboard Design

**Objective:** Design a soundboard geometry and predict its modal characteristics.

**Method:**
1. Define soundboard geometry in FEA-enabled CAD software (e.g., COMSOL, Abaqus, or open-source Montjoie/GMSH as used by MAESSTRO)
   - Panel shape, thickness profile, wood species and grain orientation
   - Rib count, spacing, height, taper profile
   - Bridge geometry, position, mass distribution
   - Boundary conditions (rim attachment method)
2. Compute the modal basis using eigenvalue analysis of the Reissner-Mindlin plate model
   - Extract mode frequencies, damping estimates, and spatial mode shapes up to 10 kHz
   - Target: 500–2500 modes depending on design and frequency range
3. Export modal parameters in Pianoid-compatible format:
   - Per-mode: frequency, damping ratio, complex mode shape vector at bridge contact points
   - Bridge geometry: mapping from string positions to mode shape sampling points

**Deliverable:** A complete modal characterization of the virtual soundboard, ready for synthesis.

### Phase 2: Real-Time Acoustic Preview via Pianoid

**Objective:** Hear the designed soundboard in real time, with full polyphonic performance capability.

**Method:**
1. Import FEA-derived modal parameters into Pianoid's preset format
   - Map mode shapes at bridge positions to feedin coefficients (string → mode coupling)
   - Derive feedback coefficients from mode shapes (mode → string back-coupling)
   - Compute inter-string coupling through shared modal network
2. Configure the acoustic radiation model
   - Rayleigh integral or equivalent radiation model maps modal velocities to sound pressure at the listening position
   - Configurable listener position, room characteristics
3. Perform real-time synthesis on GPU
   - 256 strings × 256 modes, 48 kHz, < 1.5 ms latency
   - Full MIDI input: keyboard, pedals, velocity sensitivity
   - Interactive parameter adjustment: modify soundboard properties and hear changes immediately

**Deliverable:** A playable virtual instrument embodying the designed soundboard's acoustic behavior, with real-time polyphonic performance and inter-string coupling.

### Phase 3: Physical Fabrication

**Objective:** Build the designed soundboard as a physical object.

**Method:**
1. Generate CNC toolpaths from the 3D CAD model
   - Panel contouring, rib profiling, bridge shaping
   - Material selection guided by Phase 1 sensitivity analysis (which parameters most affect target modes)
2. Fabricate the soundboard using CNC-assisted lutherie
   - Spruce panel, rib gluing, bridge installation
   - Crown forming per design specification
3. Mount the soundboard on a test frame with controlled boundary conditions
   - Rigid rim simulation or actual rim coupling, matching the FEA boundary conditions
   - String installation at specified tensions

**Deliverable:** A physical soundboard ready for modal measurement and performance.

### Phase 4: Modal Verification Using Pianoid Technology

**Objective:** Measure the fabricated soundboard's actual modal characteristics and compare with FEA predictions.

**Method:**
1. Install multi-channel accelerometer array on the soundboard (5+ channels at strategic positions)
2. Perform bridge-scanning impulse response measurements
   - Excite at each string position along the bridge (78+ scenarios for a full-range instrument)
   - Record multi-channel impulse responses at high sample rate
3. Extract modal parameters using Pianoid's proprietary ESPRIT pipeline
   - Multi-band ESPRIT extraction with automatic model order selection
   - Band merging with MAC-based cross-band deduplication
   - **Sliding-window frequency-shape clustering** for automated mode tracking across all measurement positions
   - Output: measured mode frequencies, damping ratios, complex mode shapes, and spatial amplitude profiles along the bridge
4. Compare measured vs. predicted modal parameters
   - Frequency correlation: scatter plot of FEA frequencies vs. measured frequencies
   - Mode shape correlation: MAC matrix between FEA mode shapes and measured mode shapes
   - Damping comparison: measured damping ratios vs. FEA estimates
   - Modal density comparison: number of modes per frequency band
5. Update the Pianoid preset with measured parameters
   - Replace FEA-predicted modes with measured modes
   - Re-derive feedin/feedback matrices from measured mode shapes
   - A/B comparison: synthesized sound from FEA modes vs. measured modes

**Deliverable:** Quantitative validation of the FEA model accuracy, measured modal dataset, and an updated Pianoid preset reflecting the actual soundboard.

### Phase 5: Live Performance on the Designed Soundboard

**Objective:** Play the fabricated soundboard as a musical instrument using Pianoid's excitation system.

**Method:**
1. Install Pianoid's electromechanical excitation system on the fabricated soundboard
   - Actuators at string/bridge contact points driven by Pianoid's real-time synthesis engine
   - The GPU computes string vibration in real time; the actuators physically drive the soundboard at the bridge
2. The soundboard radiates sound acoustically — the listener hears the actual physical soundboard responding to computed string forces
3. Full MIDI performance capability
   - Keyboard input drives the synthesis engine
   - The synthesis engine drives the actuators
   - The soundboard produces acoustic output
   - The result is a hybrid instrument: computationally driven, physically radiated

**Deliverable:** A playable physical instrument embodying the designed soundboard, allowing musical evaluation by performers and listeners in a real acoustic environment.

---

## 4. Innovation and Differentiation

| Capability | MAESSTRO (State of Art) | This Proposal |
|-----------|------------------------|---------------|
| Synthesis speed | 16 min / note (offline) | Real-time, 48 kHz, < 1.5 ms latency |
| Polyphony | Single note | 256 simultaneous strings |
| Inter-string coupling | None | Full feedin/feedback modal network |
| Pedal effects | None | Sustain, damper, una corda |
| Sympathetic resonance | None | Emergent from coupled modal network |
| Modal measurement | External (not integrated) | Proprietary ESPRIT + sliding-window tracking |
| Design verification | Not addressed | Quantitative FEA vs. measurement comparison |
| Physical performance | Not addressed | Electromechanical excitation system |
| Design iteration cycle | Weeks (rebuild required) | Minutes (modify parameters, re-synthesize) |

### Key Innovations

1. **Closed-loop design methodology** — from FEA model to physical verification to live performance, with quantitative validation at each stage
2. **Real-time acoustic preview** — hear any soundboard design instantly with full musical expressiveness, enabling rapid design space exploration
3. **Automated modal verification** — proprietary ESPRIT pipeline with sliding-window clustering provides high-resolution comparison between predicted and measured modal characteristics
4. **Hybrid physical-computational instrument** — the fabricated soundboard becomes a playable instrument through Pianoid's excitation system, bridging the gap between simulation and musical reality

---

## 5. Expected Outcomes

1. **Validated design methodology** — demonstrated correlation between FEA-predicted and measured modal parameters for at least two soundboard designs (traditional and experimental)
2. **Open modal dataset** — published modal characterizations (frequencies, damping, mode shapes) of fabricated soundboards at successive construction stages
3. **Design guidelines** — quantified sensitivity of perceptually relevant acoustic features (sustain, brightness, evenness) to structural parameters (rib spacing, panel thickness, bridge mass)
4. **Playable prototype** — at least one fabricated soundboard with Pianoid excitation system, demonstrated in live performance
5. **Software pipeline** — integrated FEA-to-Pianoid import workflow, available as open-source tooling

---

## 6. Required Resources

### Equipment
- Multi-channel accelerometer array (8+ channels, up to 10 kHz bandwidth)
- Impact hammer with force sensor (PCB or equivalent)
- High-speed multi-channel DAQ system (24-bit, 48+ kHz, 8+ channels)
- CNC router access for soundboard fabrication
- Pianoid excitation system hardware (actuators, amplifiers, mounting hardware)
- NVIDIA GPU (RTX 4090 or equivalent) for real-time synthesis

### Software
- FEA package (COMSOL Multiphysics, Abaqus, or Montjoie/GMSH)
- Pianoid synthesis engine (proprietary)
- Pianoid ESPRIT modal extraction pipeline (proprietary)
- CAD software for soundboard geometry design

### Expertise
- Structural acoustics / finite-element modeling
- Experimental modal analysis
- Piano acoustics and lutherie
- GPU computing and real-time audio systems
- Musical performance (for evaluation)

---

## 7. Timeline

| Phase | Duration | Dependencies |
|-------|----------|-------------|
| Phase 1: FEA Design | 3 months | FEA software, soundboard geometry |
| Phase 2: Acoustic Preview | 1 month | Phase 1 modal export, Pianoid FEA import tool |
| Phase 3: Fabrication | 2 months | Phase 1 CAD model, CNC access |
| Phase 4: Modal Verification | 1 month | Phase 3 soundboard, measurement equipment |
| Phase 5: Live Performance | 1 month | Phase 3 soundboard, excitation system |
| Integration and Publication | 2 months | All phases complete |
| **Total** | **10 months** | |

---

## 8. Related Work and Research Landscape

### 8.1 Soundboard Modelling

| Group | Institution | Key Contribution | Key Publication |
|-------|-----------|-----------------|-----------------|
| Elie, Boutillon, Chabassier et al. | MAESSTRO/ANR consortium | FEA-based soundboard SCAD tool; ~2400 modes to 10 kHz; open-source pipeline | Elie et al., *Acta Acustica* 6:30, 2022 |
| Ege, Boutillon, Rébillat | École Polytechnique / ENSTA | High-resolution modal analysis of soundboards; transition frequency where modes shift from discrete to statistical overlap | Ege et al., *J. Sound and Vibration*, 2009; *JASA*, 2013 |
| Giordano | University of Waterloo | First full 3D FEA of piano (string-soundboard-air); demonstrated computational cost was prohibitive on CPU | Giordano, *EURASIP J. Applied Signal Processing*, 2004 |
| Berthaut, Ichchou, Jézéquel | École Centrale de Lyon | Ribbed orthotropic plate models via wave-based periodic structure theory | Berthaut et al., *Applied Acoustics*, 2003 |
| Trevisan, Ege, Laulagnet | INSA Lyon / LAUM | Semi-analytical modal approach validated against Pleyel P131 | Trevisan et al., *JASA* 141(2), 2017 |

### 8.2 Physical Modelling Synthesis of Piano

| Group | Institution | Key Contribution | Key Publication |
|-------|-----------|-----------------|-----------------|
| Chabassier, Chaigne, Joly | Inria Bordeaux / ENSTA | Foundational full piano simulation; energy-preserving spectral element schemes for nonlinear strings + soundboard + air | Chabassier et al., *ESAIM: M2AN*, 2014; Chaigne & Askenfelt, *JASA*, 1994 |
| Välimäki, Bank, Erkut | Aalto University / Budapest UT | Computationally efficient piano models using digital waveguides and high-order IIR filters; psychoacoustic tuning of perceptually critical parameters | Bank & Välimäki, *IEEE SPL*, 2003; Bank PhD thesis, 2006 |
| Smith | Stanford CCRMA | Digital waveguide theory; commuted synthesis (pre-computed soundboard IR convolved with string output) | Smith, *Physical Audio Signal Processing*, online book |
| Morrison, Adrien et al. | IRCAM | Modalys — modal synthesis framework for real-time instrument simulation using modal decomposition | IRCAM Modalys documentation |
| Guillaume (Modartt) | Toulouse | Pianoteq — commercial physical modelling piano; ~1000 modes/note; based on experimental modal analysis background (PolyMAX algorithm) | Proprietary; Guillaume's background in LMS International |

### 8.3 Piano Acoustics Fundamentals

| Researcher | Institution | Key Contribution | Key Publication |
|-----------|-----------|-----------------|-----------------|
| Weinreich | University of Michigan | Discovered coupled string polarization and double decay — the two-stage decay arising from bridge coupling two string polarizations differently | Weinreich, *JASA*, 1977 |
| Conklin | Steinway & Sons | Definitive engineering reference on piano design: string scaling, inharmonicity, soundboard-bridge interaction | Conklin, "Design and tone in the mechanoacoustic piano" (3-part series), *JASA*, 1996 |
| Askenfelt, Jansson | KTH Stockholm | Comprehensive measurements of hammer-string interaction, string vibration, and soundboard response | Multiple papers in *JASA* and *Acustica*, 1980s-1990s |
| Fletcher, Rossing | Various | Canonical textbook synthesizing all piano acoustics knowledge | *The Physics of Musical Instruments*, Springer, 1998 |

### 8.4 Modal Analysis Methods in Instrument Acoustics

| Group | Key Contribution |
|-------|-----------------|
| Peeters, Van der Auweraer, Guillaume (LMS / KU Leuven) | PolyMAX — polyreference least-squares complex frequency-domain method, now an industry standard. Guillaume later founded Modartt/Pianoteq |
| Ege et al. (École Polytechnique) | Applied ESPRIT high-resolution spectral methods to extract closely-spaced soundboard modes |
| Trévisan et al. (INSA Lyon) | Operational modal analysis of instruments in playing conditions using ERA variants |

### 8.5 Research Programs and Funding

- **ANR (France)**: Funded MAESSTRO and Chabassier/Chaigne's piano simulation work
- **Inria Magique-3D team**: Ongoing numerical methods for wave propagation (Bécache, Joly, Chabassier)
- **Yamaha R&D**: Internal physical modelling research; collaborated with Aalto group; published sparingly
- **Steinway**: Historically collaborated with Conklin; current research proprietary
- **EU COST Action CA15125 "DENORMS"** (2016–2020): Metamaterials for noise/vibration (tangential relevance)

### 8.6 Emerging Directions

| Direction | Key Work | Relevance |
|-----------|---------|-----------|
| ML for instrument design | Nercessian et al., Yamaha, 2021; Google DDSP, 2020 | Neural surrogates could accelerate FEA; differentiable synthesis enables gradient-based parameter optimization |
| Topology optimization | Cheng & Olhoff (1981+); Bös (Fraunhofer) | Systematic optimization of rib placement and soundboard geometry for target modal properties |
| Digital twins | Concept — no piano-specific publication yet | A physics-based digital twin of a specific instrument, calibrated to measurements, is precisely what this proposal enables. **Positioning opportunity.** |
| GPU-accelerated acoustics | Hamilton & Webb, 2017 (room acoustics FDTD on GPU, 100x speedup) | Demonstrates GPU viability for acoustic simulation; our work is novel in applying this to modal piano synthesis specifically |
| Physics-Informed Neural Networks | Raissi et al., 2019 | PINNs could accelerate soundboard FEA while maintaining physical constraints |

### 8.7 Positioning

This proposal occupies a unique intersection: **Chabassier-level physical fidelity** (FEA-derived modes, not hand-tuned) with **Välimäki/Bank-level real-time performance** (GPU parallelism instead of perceptual shortcuts), plus a **fabrication-verification loop** that no existing work addresses. Pianoteq is the closest commercial analog but uses proprietary methods, does not publish, and has no measurement or fabrication pipeline. The "digital twin" framing for piano soundboard development — where a specific physical instrument has a calibrated computational counterpart — has not been published and represents a novel contribution.

---

## 9. References

1. B. Elie et al., "Physically-based sound synthesis software for Computer-Aided-Design of piano soundboards," *Acta Acustica*, vol. 6, no. 30, 2022.
2. J. Chabassier, A. Chaigne, P. Joly, "Modeling and simulation of a grand piano," *JASA*, vol. 134(1), pp. 648–665, 2013.
3. B. Trevisan, K. Ege, B. Laulagnet, "A modal approach to piano soundboard vibroacoustic behavior," *JASA*, vol. 141(2), pp. 690–709, 2017.
4. K. Ege, X. Boutillon, B. David, "Modal analysis of a grand piano soundboard at successive manufacturing stages," *Applied Acoustics*, 2018.
5. A. Chaigne, A. Askenfelt, "Numerical simulations of piano strings," *JASA*, vol. 95(2), 1994.
6. J. Chabassier, M. Duruflé, "Energy-based upwinding for piano string simulation," *ESAIM: M2AN*, 2014.
7. B. Bank, V. Välimäki, "Robust loss filter design for digital waveguide synthesis of string tones," *IEEE Signal Processing Letters*, 2003.
8. G. Weinreich, "Coupled piano strings," *JASA*, vol. 62(6), pp. 1474–1484, 1977.
9. H. Conklin, "Design and tone in the mechanoacoustic piano" (Parts I–III), *JASA*, vol. 99–100, 1996.
10. N. Giordano, "Physical modeling of the piano," *EURASIP J. Applied Signal Processing*, 2004.
11. J. Berthaut, M.N. Ichchou, L. Jézéquel, "Piano soundboard: structural behavior, numerical and experimental study in the modal range," *Applied Acoustics*, vol. 64, 2003.
12. N.H. Fletcher, T.D. Rossing, *The Physics of Musical Instruments*, 2nd ed., Springer, 1998.
13. B. Bank, "Physics-based sound synthesis of the piano," PhD thesis, Budapest UT, 2006.
14. B. Hamilton, C.J. Webb, "Room acoustics modelling using GPU-accelerated finite difference and finite volume methods," *Digital Audio Effects (DAFx)*, 2017.
