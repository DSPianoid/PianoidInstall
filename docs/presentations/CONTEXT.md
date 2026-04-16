# Soundboard Design Research Proposal — Context

## Purpose

Co-development proposal from Pianoid (industry) to a university partner for closed-loop soundboard design research. Target audience: academic committee evaluating a research collaboration.

## Core Argument

A closed-loop methodology — FEA design, real-time GPU acoustic preview, physical fabrication, and quantified modal verification — can make soundboard design systematic and reproducible for the first time. The core experiment: A/B synthesis comparing FEA-predicted modes vs. physically measured modes on the same engine, isolating model accuracy from synthesizer fidelity.

## Narrative Structure (12 slides)

1. **Title** — "What if the soundboard were the only thing that mattered?"
2. **Problem** — Why systematic soundboard design is impossible with current tools. Research question + A/B experiment.
3. **Research Landscape** — 6 key groups (Chabassier, MAESSTRO, Ege, Välimäki, Pianoteq, Weinreich). Gap: no one closes the FEA-to-verification loop.
4. **Platform Baseline** — What exists (NAMM + concerts demonstrated): finite-difference string solver, 256 modes, string-mode coupling, patented excitation (8-ch), ESPRIT measurement. What this proposal builds: FEA import, algorithm improvement (256→2048), fabrication pipeline, perceptual validation.
5. **State of Art Table** — Split columns: Pianoid (current) vs Proposed System. Blue = what the project delivers.
6. **How We Enable the Loop** — Two capabilities (real-time preview + patented excitation). Secondary: freeing soundboard from structural role opens novel design space.
7. **The Closed Loop** — 5-phase pipeline with return arrow. Loop closure criterion: modal correlation metrics. Phase 5 (A/B evaluation) visually accented as the core experiment.
8. **Co-Development** — Industry brings: engine, excitation, measurement, FEA import tool, algorithm R&D. University brings: FEA expertise, perception science, facilities, radiation modelling, credentialing. IP: commercial retained by Pianoid, publications open.
9. **Why Now** — GPU threshold, MAESSTRO groundwork, ESPRIT maturity, platform demonstrated, sustainable materials demand, digital twin methodology.
10. **Timeline & Risks** — 12 months with overlapping phases. 4 risks: algorithm improvements fail (fallback: current algorithm), poor FEA correlation ("this is the research"), prototype validity (spruce baseline), partnership timeline (parallel workstreams).
11. **Outcomes** — Scientific: first study freed from piano constraints, A/B results, design guidelines, open dataset. Publications: Acta Acustica lead. Technological: playable prototype, software pipeline, measurement toolkit. Industrial: CAD tool, sustainable materials, novel instrument design.
12. **Closing** — "What does a soundboard sound like when designed purely for sound? ... Now we have the tools to find out — and to design instruments that could never have existed before."

## Key Terminology

| Term | Meaning |
|------|---------|
| String-mode coupling (network/matrices) | Bidirectional energy exchange between all strings and all soundboard modes. Previously called "feedin/feedback matrices" or "inter-string coupling" — unified to this term. |
| Finite-difference wave equation solver | Pianoid's string model — explicit time-stepping FDTD, NOT digital waveguide. |
| MAC (Modal Assurance Criterion) | Mode shape correlation metric (0–1). |
| ABX | Forced-choice perceptual comparison test. |
| Full set of strings | Model parameter is 256 but real piano has ~230 — use "full set" not "256 strings". |

## Design Decisions Made During Development

- **Methodology as core claim** (not the unconstrained soundboard vision — that's a consequence, not the thesis)
- **S5/S6 order**: gap table before constraints (show the gap, then explain how we fill it)
- **Comparison table split** into current/proposed columns for honesty
- **Novel instrument concept** kept as industrial outcome + closing hint, not a separate slide (avoids interrupting methodology→partnership flow)
- **"Killer octave"** qualified: mechanism understood, design solution is not (not presented as unsolved mystery)
- **Algorithm improvements** (mode scaling, string discretisation, hammer model) separated into individual scope items but merged into single risk with single fallback: "current algorithm stays as-is"
- **Acoustic radiation model** is university responsibility, not in Pianoid's scope column
- **Phase 5 visually accented** in blue in the pipeline diagram — it's "the core experiment"
- **S6 secondary comment** ("beyond the loop") as a content box alongside summary, not a footnote

## Related Files

| File | Description |
|------|-------------|
| `soundboard_design_proposal.html` | Interactive HTML presentation (arrow keys to navigate, F for fullscreen) |
| `soundboard_design_proposal.pdf` | PDF export (rendered at 1100x619 viewport for correct font scaling) |
| `soundboard_design_proposal_document.md` | Full written research proposal document |

## Research References

1. Elie et al., "Physically-based sound synthesis software for CAD of piano soundboards," Acta Acustica 6:30, 2022 (MAESSTRO)
2. Chabassier, Chaigne, Joly, "Modeling and simulation of a grand piano," JASA 134(1), 2013
3. Trevisan, Ege, Laulagnet, "A modal approach to piano soundboard vibroacoustic behavior," JASA 141(2), 2017
4. Ege, Boutillon, David, "Modal analysis of a grand piano soundboard at successive manufacturing stages," Applied Acoustics, 2018
5. Weinreich, "Coupled piano strings," JASA 62(6), 1977
6. Bank, Välimäki, "Robust loss filter design for digital waveguide synthesis," IEEE SPL, 2003

## Generation

- HTML is the source of truth — edit there, regenerate PDF with: `cd PianoidCore && .venv/Scripts/python D:/tmp/gen_pdf_hires.py`
- PDF generation uses Playwright (chromium) at 1100x619 viewport, 2x device scale, landscape 13.333"x7.5"
- Marp markdown version (`slides.md` in research/) exists but is deprecated — the HTML version has better visual design
