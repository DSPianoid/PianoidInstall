# No-CUDA Graceful Mode — Design Proposal

- **Author:** dev-cudaguard
- **Date:** 2026-06-10
- **Status:** PROPOSAL — awaiting user decision (do NOT implement the PianoidCore change without explicit approval)
- **Related shipped work:** `tools/cuda_diagnostic.ps1` (CUDA diagnostic, master `fa2cde1`); `check-cuda.ps1` broken-NVML detection fix (on `feature/dev-cudaguard`).

## 1. Problem (user-stated, authoritative)

On a system where the GPU is present but CUDA is unusable ("nvidia-smi → NVML not found"),
the launcher starts the frontend, then the **synthesis backend hard-crashes** at APPLY with
"no CUDA-capable device is detected." The user wants **graceful degradation**:

- The backend(s) should **start** in a no-CUDA mode.
- **CPU simulation + most of the Modal Adapter functionality** work without CUDA.
- `/load_preset` should be **gated to the cpu-simulation option only** — loading a regular
  (GPU-synthesis) preset must be **blocked** (it would drive the CUDA engine → crash).
- The launcher should **warn**: "limited mode (CPU sim + Modal Adapter; GPU presets disabled)."

## 2. Measured architecture (how the no-CUDA range is actually reached)

The stack is **two independent backends** plus a launcher:

| Component | Port | CUDA dependency | Started by |
|---|---|---|---|
| React frontend | 3000 | none | `start-pianoid.bat` → `npm` |
| Launcher (`server/launcher.js`) | 3001 | none | `start-pianoid.bat` |
| **Synthesis backend** (`backendServer.py` → `pianoid.py` → `pianoidCuda`) | 5000 | **REQUIRED** — `initialize_pianoid()` → `devMemoryInit()` allocates GPU memory; crashes with no GPU | launcher `startBackend()` (on APPLY) |
| **Modal Adapter** (`modal_adapter_server.py`) | 5001 | **NOT required** — boots without `import pianoidCuda`; ESPRIT uses CuPy **with a NumPy fallback** | launcher `startModal()` (independent) |

**Measured (read, not inferred):**

- `modal_adapter_server.py` top imports are `flask`, `flask_cors`, `modal_adapter` — **no `pianoidCuda`, no `devMemoryInit`**. Its docstring: "Runs on port 5001 to avoid CUDA context conflicts… CuPy GPU ESPRIT requires its own process." `/modal/gpu_status` is a safe CuPy import-probe returning `gpu_available` true/false (never crashes); ESPRIT `_to_gpu_or_cpu` falls back CuPy→NumPy and logs a WARNING (dev-5dd4).
- `launcher.js` manages 5000 (`startBackend`) and 5001 (`startModal`) as **separate child processes** with separate REST endpoints (`/api/start-backend`, modal start, `/api/backend-status` → `modalRunning`). So **5001 can run while 5000 fails** — the no-CUDA functional surface (Modal Adapter on CPU) is fully reachable today.
- The synthesis crash locus: `backendServer.py:load_preset_route` → `destroyPianoid()` (tears down the running engine FIRST) → `initialize(path,…)` → `initialize_pianoid()` → `devMemoryInit()` (GPU alloc = the throw). `use_cuda` is **never read** in this route (it only flows to the Modal Adapter's ESPRIT `use_gpu`).

## 3. The "cpu-simulation option" reality (a blocker the gate depends on)

The user's gate ("allow only the cpu-simulation option") points at a target that **does not
functionally exist today**:

- The only synthesis-side cpu-sim candidate is `use_simulation=1` → `pianoid_cuda_placeholder.py`.
  That module is a **mock** ("Placeholder module that mimics the C++ interface"); it does **not**
  implement FDTD synthesis, prints "Pianoid in simulation mode, midi listener not working", and is
  **rejected with HTTP 400** because its API is out of sync with the live engine (dev-b001: letting
  it through destroys the engine then raises `TypeError`).
- `audio_driver_type=0` ("hardware-free") is about the **audio output device** (SDL3), not the GPU.
  `pushSamplesCPU` is a CPU audio-output buffer, not CPU synthesis.
- The Modal Adapter's `forward_model` (synthetic-dataset, CuPy/NumPy `xp`-switch) is
  dataset-generation, not "play notes on CPU."

**So there is no working "play a preset on CPU" mode.** "CPU simulation" today effectively means
**the Modal Adapter (5001) feature set running on CPU**.

## 4. Proposed design (3 layers)

### Layer 1 — Launcher awareness + warning (NO PianoidCore change)

- `check-cuda.ps1` already **detects** no-CUDA / broken-NVML (the Deliverable-2 fix on
  `feature/dev-cudaguard`). Change only the **warning wording** to the limited-mode framing:
  *"GPU unavailable — Pianoid will run in LIMITED mode: the Modal Adapter (CPU) works, but loading
  a GPU-synthesis preset will be blocked. Run `tools/cuda_diagnostic.ps1` for details."* Then proceed
  (warn-and-continue), exit-code contract unchanged.
- **Scope:** `check-cuda.ps1` wording only (already on the feature branch). `start-pianoid.bat` unchanged.

### Layer 2 — Synthesis backend (5000) graceful no-CUDA start + `/load_preset` gate (Python-middleware-only — PianoidCore change, NEEDS APPROVAL)

- Add a **GPU-availability probe** at backend startup (a CuPy `getDeviceCount` try/catch, mirroring
  the Modal Adapter's `/gpu_status`), cached as `gpu_available`.
- In `load_preset_route`, **before `destroyPianoid()`**: if `gpu_available` is false (or the probe
  is broken) AND the request is a GPU-synthesis preset → return a clean **`4xx` "GPU unavailable —
  limited mode; this preset needs CUDA"** WITHOUT destroying the engine and WITHOUT calling
  `devMemoryInit()`. (Fixes the current destroy-then-crash order too.)
- Expose `gpu_available` in `/health` (mirrors the dev-asioload `audio_driver_fallback` precedent),
  so the frontend can show a limited-mode banner + disable GPU-preset APPLY.
- **Scope:** `backendServer.py` + `pianoid.py` (Python only — **no CUDA C++ rebuild**). The backend
  process starts and serves non-GPU endpoints; GPU presets are blocked cleanly.

### Layer 3 — Modal Adapter (5001)

- **No change needed** — already CPU-capable.

### The "gate to cpu-sim only" clause

Because no working cpu-sim preset exists (§3), the realistic gate is **"block GPU presets under
no-CUDA; the Modal Adapter is the usable surface."** Three ways to honor the user's exact words —
**user picks**:

- **Opt C (recommended, smallest):** no cpu-sim preset; Layer 1 + Layer 2 as above. Ships the
  graceful no-CUDA mode now (Python-only). "cpu-sim preset" becomes a later feature when defined.
- **Opt A (medium):** resurrect `pianoid_cuda_placeholder.py` into a real **inspect-only / silent**
  mode (loads a preset's params, UI + Modal Adapter work, **no audio**). Non-trivial Python (the
  placeholder API is out of sync) — and honest framing required ("loaded; no synthesis").
- **Opt B (large, separate project):** implement **real CPU FDTD synthesis** so notes render
  without a GPU. Major engine effort, almost certainly **CUDA-C++/host** work + Python.

## 5. Scope / build-type summary

| Layer | Files | Build | Approval |
|---|---|---|---|
| L1 warning wording | `check-cuda.ps1` | none (.ps1) | included in launcher task |
| L2 backend graceful start + gate + `/health` flag | `backendServer.py`, `pianoid.py` | **Python-only, NO CUDA rebuild** | **NEEDS USER APPROVAL** |
| L3 Modal Adapter | — | — | none (already works) |
| Opt A cpu-sim resurrection | + `pianoid_cuda_placeholder.py` + route | Python-only | separate decision |
| Opt B real CPU FDTD | engine | **CUDA-C++ rebuild** | separate project |

## 6. Recommendation

Ship **Layer 1 + Layer 2 + Opt C** as the no-CUDA graceful mode: backend starts, GPU presets
blocked with a clear message, `/health gpu_available` flag, launcher warns limited-mode, Modal
Adapter usable. All **Python-middleware + launcher only — no CUDA C++ rebuild.** Treat a real
cpu-sim preset (Opt A/B) as a scoped follow-up once the user defines what "CPU simulation" should do.

## 7. Open questions for the user

1. Approve **Layer 2** (Python-only backend graceful no-CUDA start + GPU-preset gate + `/health` flag)?
2. The "cpu-simulation option" doesn't exist as a working preset today — is **Opt C** (block GPU
   presets; Modal Adapter is the no-CUDA surface) acceptable now, with a real cpu-sim (Opt A/B) as a
   later feature? Or is a working cpu-sim required up front (Opt A inspect-only, or Opt B real synth = big)?
