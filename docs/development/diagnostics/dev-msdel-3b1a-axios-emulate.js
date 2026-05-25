/**
 * dev-msdel-3b1a live verification — emulate the frontend axios.delete
 * call against the running modal_adapter_server, with the new 60000 ms
 * timeout (vs the old 5000 ms). Confirms the fix is in effect by
 * reading the actual deployed source.
 *
 * Usage: node docs/development/diagnostics/dev-msdel-3b1a-axios-emulate.js
 */
const fs = require("fs");
const path = require("path");
const http = require("http");

const REPO = path.resolve(__dirname, "..", "..", "..");
const HOOK = path.join(
  REPO, "PianoidTunner", "src", "hooks", "useMeasurementCatalog.js"
);

const src = fs.readFileSync(HOOK, "utf8");

// Extract the deleteMeasurement timeout
const match = src.match(
  /const deleteMeasurement = useCallback[\s\S]*?\{ timeout: (\d+) \}/
);
if (!match) {
  console.error("Could not locate deleteMeasurement timeout in", HOOK);
  process.exit(2);
}
const declaredTimeout = parseInt(match[1], 10);
console.log(`[source] useMeasurementCatalog.deleteMeasurement timeout = ${declaredTimeout} ms`);
if (declaredTimeout < 60000) {
  console.error(`  FAIL: expected >= 60000 ms (got ${declaredTimeout})`);
  process.exit(1);
}

// Now make a real DELETE roundtrip against a measurement we know doesn't
// exist (returns 404 fast) — just to confirm the backend is up and the
// timeout machinery works end-to-end.
const port = parseInt(process.env.MODAL_ADAPTER_PORT || "5001", 10);
const target = `_dev_msdel_3b1a_should_not_exist_${Date.now()}`;
const opts = {
  host: "127.0.0.1",
  port,
  path: `/modal/measurements/${target}`,
  method: "DELETE",
  timeout: declaredTimeout,  // use the SAME timeout the frontend will use
};

console.log(`[live] DELETE http://127.0.0.1:${port}${opts.path}`);
const t0 = process.hrtime.bigint();
const req = http.request(opts, (res) => {
  const chunks = [];
  res.on("data", (d) => chunks.push(d));
  res.on("end", () => {
    const dt = Number(process.hrtime.bigint() - t0) / 1e6;
    const body = Buffer.concat(chunks).toString("utf8");
    console.log(`  status=${res.statusCode} duration=${dt.toFixed(0)}ms body=${body}`);
    console.log("");
    console.log("==== HEADLINE ====");
    console.log(`  declared timeout : ${declaredTimeout} ms (fix LANDED)`);
    console.log(`  DELETE roundtrip : ${dt.toFixed(0)} ms (status ${res.statusCode})`);
    if (res.statusCode === 404) {
      console.log("  backend          : up + responsive (404 expected for non-existent id)");
    } else if (res.statusCode === 200) {
      console.log("  backend          : up + actually deleted something (unexpected)");
    } else {
      console.log(`  backend          : returned ${res.statusCode} unexpectedly`);
    }
  });
});
req.on("error", (e) => {
  const dt = Number(process.hrtime.bigint() - t0) / 1e6;
  console.error(`  request error after ${dt.toFixed(0)}ms:`, e.message);
  process.exit(1);
});
req.on("timeout", () => {
  const dt = Number(process.hrtime.bigint() - t0) / 1e6;
  console.error(`  TIMEOUT after ${dt.toFixed(0)}ms (declared ${declaredTimeout})`);
  req.destroy();
  process.exit(1);
});
req.end();
