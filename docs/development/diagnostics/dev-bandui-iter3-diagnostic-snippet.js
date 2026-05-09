// =====================================================================
// dev-bandui iter3 DIAGNOSTIC SNIPPET
// =====================================================================
// User: paste this entire block into Chrome DevTools Console (F12)
// while looking at the Pianoid tab on http://localhost:3000/
// Then send the output back to the orchestrator.
//
// What it tells us:
//   1. Whether the LOADED bundle has the dev-bandui fixes (markers).
//   2. Whether React has already populated bands from the preset.
//   3. What the current backend returns for esprit_config.
//   4. Whether something (cache, service worker, extension) is
//      intercepting the bundle request.
// =====================================================================
(async () => {
  console.log('=== dev-bandui DIAG starting ===');

  // 1. Check loaded React state
  const root = document.querySelector('#root');
  const fiberKey = Object.keys(root || {}).find(k => k.startsWith('__reactContainer$'));
  let espritFound = null;
  let bandPresetsFound = null;
  if (fiberKey) {
    const visited = new WeakSet();
    function walk(node, depth) {
      if (!node || visited.has(node) || depth > 80) return;
      visited.add(node);
      if (node.memoizedState && node.elementType) {
        let h = node.memoizedState;
        while (h) {
          const v = h.memoizedState;
          if (v && typeof v === 'object' && v && v.preset && v.bands !== undefined && !espritFound) {
            espritFound = {
              preset: v.preset,
              bandCount: v.bands.length,
              firstBandName: v.bands[0]?.name,
              firstBandKeys: v.bands[0] ? Object.keys(v.bands[0]) : null,
              hasResolvedFadeKeys: v.bands[0] ? ('start_fade_ms' in v.bands[0]) : null,
            };
          }
          if (v && typeof v === 'object' && !bandPresetsFound && v.extended_8band) {
            bandPresetsFound = { count: v.extended_8band.length };
          }
          h = h.next;
        }
      }
      if (node.child) walk(node.child, depth + 1);
      if (node.sibling) walk(node.sibling, depth + 1);
    }
    walk(root[fiberKey].stateNode.current, 0);
  }
  console.log('React espritConfig:', espritFound);
  console.log('React bandPresets:', bandPresetsFound);

  // 2. Probe bundle for fix markers
  try {
    const bundleResp = await fetch('/static/js/bundle.js', { cache: 'no-cache' });
    const bundleBytes = bundleResp.headers.get('content-length');
    const bundleEtag = bundleResp.headers.get('etag');
    const bundle = await bundleResp.text();
    console.log('Bundle size:', bundle.length, '(header content-length:', bundleBytes, ')');
    console.log('Bundle ETag:', bundleEtag);
    console.log('Has marker "fetch band presets FIRST":',
      (bundle.match(/fetch band presets FIRST/g) || []).length, 'expect 1');
    console.log('Has marker "resolveBandsAndPreset":',
      (bundle.match(/resolveBandsAndPreset/g) || []).length, 'expect >= 4');
    console.log('Has marker "Step 3 (dev-bandui 2026-05-07 safety net)":',
      (bundle.match(/Step 3 \(dev-bandui 2026-05-07 safety net\)/g) || []).length, 'expect 1');
  } catch (e) {
    console.error('Bundle fetch failed:', e);
  }

  // 3. Probe backend
  try {
    const ps = await fetch('http://127.0.0.1:5001/modal/project_state').then(r => r.json());
    const bp = await fetch('http://127.0.0.1:5001/modal/band_presets').then(r => r.json());
    console.log('Backend project_state.esprit_config:', ps.esprit_config);
    console.log('Backend project_state.project_dir:', ps.project_dir);
    console.log('Backend band_presets keys:', Object.keys(bp || {}));
    console.log('Backend extended_8band first band:', bp?.extended_8band?.[0]);
  } catch (e) {
    console.error('Backend probe failed:', e);
  }

  // 4. Check service worker / cache
  const sw = await (navigator.serviceWorker?.getRegistrations?.() || []);
  const cacheKeys = await (caches?.keys?.() || []);
  console.log('Service workers:', sw.length, sw.map(r => r.active?.scriptURL));
  console.log('Cache keys:', cacheKeys);

  console.log('=== dev-bandui DIAG done', new Date().toISOString(), '===');
})();
