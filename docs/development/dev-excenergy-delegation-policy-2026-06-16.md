# dev-excenergy — DeepSeek delegation policy addendum (2026-06-16)

Companion to the session log `logs/dev-excenergy-20260616-093205.md`. Standing
policy from team-lead/user: the DeepSeek codegen backend is the DEFAULT path for
ELIGIBLE routine PURE functions (test-first → delegate body → test-gate). Backend
confirmed present: `tools/deepseek-codegen-mcp/batch_pipeline.py`.

## Invocation (from `.claude/skill-examples/dev.md` §4b)
```
PianoidCore/.venv/Scripts/python tools/deepseek-codegen-mcp/batch_pipeline.py \
  --manifest <dir> --out <outdir> --review-ds on --expose bodies --concurrency 4
```
Manifest per fn `<name>`: `<name>.spec.md` (signature+behaviour) · `<name>.test.py`
(the gate — imports the candidate as `import impl_<name>`) · `<name>.meta.json`
(`{target_module, language, xp_agnostic, deps:[...]}`). Single-unit alternative:
`mcp__deepseek-codegen__delegate_codegen`. Markers: `[TEST-WRITTEN]` before,
`[MCP-CALL]`/`[FN-RESULT]` around. JS/TS/React → Jest; Python → pytest.

## DELEGATE (eligible — I write spec + test FIRST, then delegate the body)
- **W1 (Python/pytest):** `temporal_curve_impulse(level_params) -> float` — the
  discrete point-SUM of the curve using the GPU formula (per-component ReLU
  `max(g - shift, 0)` BEFORE summation; sample on the engine grid `EXCITATION_FACTOR`
  window). Pure, deterministic, gateable.
- **W4 (JS/Jest, PianoidTunner `src/utils/excitationImpulse.js`):** `curveImpulse`
  (temporal point-sum, same GPU formula), `hammerSpatialImpulse` (SPARSE sum of the
  per-node array from `GET /get_hammer_shape/<pitch>`), `renormalizeToImpulse`
  (linear rescale by `I_prev / I_new`), any interpolation helper.

## KEEP ON ME (Opus — judgment / data-model / wiring / compiled)
- the kernel `.cu` edits (gaussTest.cu uncomment + Pianoid_excitation.cu note-on write)
- the note-on coefficient wiring; coefficient COMPOSITION (`c·m·v·tInt·hammerSpatial`)
  + the incremental ratio-update logic (data-model)
- param-schema / preset persistence (DONE: hammer_mass, hammer_speeds, calibration)
- StringMap pack of the coefficient; middleware REST; the dual-integration HOOKS
  (which edit paths trigger renormalize)

## Resume order for the StringExcitation unit
1. Write `temporal_curve_impulse` spec + pytest gate (GPU per-component-ReLU point-sum).
2. Run the DeepSeek batch pipeline for it; test-gate; apply the passing body.
3. I compose the per-(pitch,level) coefficient + incremental update AROUND that
   delegated point-sum (Opus), then StringMap pack + unit tests + wheel rebuild.
