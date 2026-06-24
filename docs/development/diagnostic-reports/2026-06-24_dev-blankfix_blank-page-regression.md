# dev-blankfix — Blank-page mount crash (dev-volcal regression)

**Date:** 2026-06-24
**Severity:** Blocking (system unusable — blank page on load)
**Status:** FIXED + merged to `PianoidTunner` `origin/dev` (`8d78bf1`)

## Symptom

Fresh load of the frontend at `http://localhost:3000` rendered a **blank page**.
The dev server was up and serving the HTML shell + `bundle.js` ("Compiled
successfully"), so this was a JS runtime error crashing the React mount, not a
build/serve failure.

## Console error (root cause)

```
Uncaught TypeError: Cannot read properties of undefined (reading 'split')
  The above error occurred in the <PianoidTuner> component
```

A pure frontend crash — independent of the backend being down (the WebSocket
warnings on `:5000`/`:3001` were separate and harmless).

## Root cause

The dev-volcal commit `8213368` ("volume formula mirror — unity at init-vol
100") changed the volume default `64 -> 100` in
`PianoidTunner/src/hooks/useSettings.js` `DEFAULT_PRESET_LOAD_SETTINGS`. Its diff
removed **both** the `path: \`\`` line and the `volume: 64` line but only
re-added `volume: 100` — silently **dropping the `path` key**.

With `path` absent from the factory default, `presetLoadSettings.path` was
`undefined` on a fresh mount. `PianoidTunner/src/PianoidTuner.js` calls
`presetLoadSettings.path.split("/")` **unguarded** in two mount effects (the
Apply effect ~line 1437 and the last-filename tracker ~line 1451) → TypeError →
`<PianoidTuner>` threw during render → blank page (no error boundary).

## Fix (PianoidTunner, branch `feature/dev-blankfix` → merged to `dev`)

1. `src/hooks/useSettings.js` — restored `path: \`\`` to the factory default
   (empty string = "no preset chosen yet"; the load effects no-op on a falsy
   fileName). **Primary fix.**
2. `src/PianoidTuner.js` — optional-chained both `path?.split(...)` callsites
   (defence in depth, matching the already-safe bare-recovery sibling) so a
   missing `path` can never blank the page again.
3. `src/hooks/__tests__/useSettings.presetConfigs.test.jsx` — regression test
   locking the invariant: factory-default `presetLoadSettings` exposes a string
   `path` after the mount-time load.

## Verification

- Live `:3000` reloaded → full UI renders (toolbar + preset selector +
  Strings/Excitation panes + BottomBar Volume/Feedback/Sensitivity/Reset),
  **zero console errors**. Backend `:5000` up, preset loaded, `audio_off`.
- Jest on merged `dev`: **131 suites / 1344 tests green**.
- CRA production build compiled cleanly.

## Commits

- Hotfix: `PianoidTunner` `b4eb097` (`feature/dev-blankfix`)
- Merge to dev: `PianoidTunner` `8d78bf1` (pushed to `origin/dev`)

## Lesson

A combined-line edit (default value + adjacent key on consecutive lines) can
silently delete the neighbouring key. The unguarded `.path.split()` callsites
were the latent hazard that turned a missing-key into a hard mount crash — now
hardened with optional chaining + a guard test.
