/**
 * dev-paramrefactor2 — F2/F2b/F3 emit-lands-on-backend verification.
 *
 * Drives the REAL socket.io transport (same contract as useSocketIO.emitWithAck:
 * 'set_parameter' {parameter,key,values} + 2s ack timeout) with the EXACT payload
 * shapes the migrated imperative emit mappers (emitStrings/Modes/ExcitationFromChange)
 * produce, then reads the AUTHORITATIVE backend GET to confirm each landed — not the
 * optimistic UI. Each check is transient: it restores the original value afterwards so
 * the user's live preset is left untouched.
 *
 * The gauss (excitation) check runs a change→revert sequence, mirroring exactly what
 * excitationRedo then excitationUndo emit (parameter:'excitation' batch payload, with
 * NO selectedParameter gate — the F2b fix). run: node <this> from the worktree.
 */
const { io } = require("socket.io-client");
const http = require("http");

const URL = "http://127.0.0.1:5000";

const httpJson = (method, path, body) =>
  new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      URL + path,
      { method, headers: { "Content-Type": "application/json" } },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try { resolve(JSON.parse(buf)); } catch (e) { resolve(buf); }
        });
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });

const get = (path) => httpJson("GET", path);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const close = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

let socket;
const emitAck = (payload) =>
  new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve({ acked: false }); } }, 2000);
    socket.emit("set_parameter", payload, (ack) => {
      if (!done) { done = true; clearTimeout(t); resolve({ acked: true, ack }); }
    });
  });

const results = [];
const record = (name, passed, detail) => {
  results.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}  — ${detail}`);
};

async function checkStrings() {
  // gamma is a primary (non-derived) physical string param — same as the paramTransport
  // Jest test. (tail is derived from length, so the backend recomputes it — not settable.)
  const P = "gamma";
  const before = await get("/get_parameter/string/60");
  const orig = before["60"][P];
  const test = Number((orig + 0.05).toFixed(6));
  // emitStringsFromChange Cell payload:
  await emitAck({ parameter: "string", key: "60", values: { 60: { [P]: test } } });
  await sleep(300);
  const after = await get("/get_parameter/string/60");
  const landed = close(after["60"][P], test, 1e-4);
  // restore
  await emitAck({ parameter: "string", key: "60", values: { 60: { [P]: orig } } });
  await sleep(300);
  const restored = close((await get("/get_parameter/string/60"))["60"][P], orig, 1e-4);
  record(`STRINGS Cell (${P}@60)`, landed && restored,
    `orig=${orig} -> set ${test} -> got ${after["60"][P]} (landed=${landed}); restored=${restored}`);
}

async function checkModes() {
  const before = await get("/get_parameter/mode/1");
  const orig = before["1"].decrement;
  const test = Number((orig + 0.05).toFixed(6));
  // emitModesFromChange Cell payload:
  await emitAck({ parameter: "mode", key: "1", values: { 1: { decrement: test } } });
  await sleep(300);
  const after = await get("/get_parameter/mode/1");
  const landed = close(after["1"].decrement, test, 1e-4);
  await emitAck({ parameter: "mode", key: "1", values: { 1: { decrement: orig } } });
  await sleep(300);
  const restored = close((await get("/get_parameter/mode/1"))["1"].decrement, orig, 1e-4);
  record("MODES Cell (decrement@1)", landed && restored,
    `orig=${orig} -> set ${test} -> got ${after["1"].decrement} (landed=${landed}); restored=${restored}`);
}

async function checkExcitationHammer() {
  const before = await get("/get_parameter/hammer/60");
  const orig = before["60"].hammer.hammer_width;
  const test = Number((orig + 0.005).toFixed(6));
  // emitExcitationFromChange Cell-flat payload (parameter:'hammer'):
  await emitAck({ parameter: "hammer", key: "60", values: { 60: { hammer_width: test } } });
  await sleep(300);
  const after = await get("/get_parameter/hammer/60");
  const landed = close(after["60"].hammer.hammer_width, test);
  await emitAck({ parameter: "hammer", key: "60", values: { 60: { hammer_width: orig } } });
  await sleep(300);
  const restored = close((await get("/get_parameter/hammer/60"))["60"].hammer.hammer_width, orig);
  record("EXCITATION hammer flat (hammer_width@60)", landed && restored,
    `orig=${orig} -> set ${test} -> got ${after["60"].hammer.hammer_width} (landed=${landed}); restored=${restored}`);
}

async function checkExcitationGaussUndoRedo() {
  // ★F2b: mirror the excitationRedo/Undo emit sequence for a GAUSS cell. The migrated
  // emitExcitationFromChange sends parameter:'excitation' with the nested batch payload
  // for a gauss change, with NO dependence on the selected param.
  const path = "/get_parameter/gauss/60";
  const before = await get(path);
  const orig = before["60"]["0"]["0"].mu; // level "0", chart "0", param mu
  const test = Number((orig + 1.0).toFixed(6));
  // "redo" emits the new value:
  await emitAck({ parameter: "excitation", key: "60", values: { 60: { 0: { 0: { mu: test } } } } });
  await sleep(300);
  const afterRedo = await get(path);
  const redoLanded = close(afterRedo["60"]["0"]["0"].mu, test);
  // "undo" emits the reverted value (the F2b-critical path — previously dropped):
  await emitAck({ parameter: "excitation", key: "60", values: { 60: { 0: { 0: { mu: orig } } } } });
  await sleep(300);
  const afterUndo = await get(path);
  const undoLanded = close(afterUndo["60"]["0"]["0"].mu, orig);
  record("EXCITATION gauss redo→undo (mu@60,L0,C0) [F2b]", redoLanded && undoLanded,
    `orig=${orig} -> redo ${test} -> got ${afterRedo["60"]["0"]["0"].mu} (${redoLanded}); undo -> got ${afterUndo["60"]["0"]["0"].mu} (${undoLanded})`);
}

async function main() {
  socket = io(URL, { transports: ["websocket", "polling"], timeout: 5000 });
  await new Promise((resolve, reject) => {
    socket.on("connect", resolve);
    socket.on("connect_error", (e) => reject(new Error("WS connect_error: " + e.message)));
    setTimeout(() => reject(new Error("WS connect timeout")), 6000);
  });
  console.log("WS connected id=" + socket.id);
  // Probe one ack so we know the transport confirms writes like the FE relies on.
  const probe = await emitAck({ parameter: "string", key: "60", values: { 60: {} } });
  console.log("ack probe: acked=" + probe.acked);

  await checkStrings();
  await checkModes();
  await checkExcitationHammer();
  await checkExcitationGaussUndoRedo();

  socket.close();
  const passed = results.filter((r) => r.passed).length;
  console.log(`\n=== ${passed}/${results.length} checks passed ===`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(2); });
