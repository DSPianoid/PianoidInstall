// dev-ae2a — minimal Chrome DevTools Protocol driver to capture the PianoidTunner
// UI (workbench-empty regression repro/verify). Launches headless Chrome against
// the already-running dev server (http://127.0.0.1:3000), waits for the mosaic to
// render, optionally clicks the first "open workbench" BarChart button it finds,
// and screenshots full-page + the workbench tile. Pure node + the `ws` package
// (already in PianoidTunner/node_modules) — no Puppeteer/Playwright needed.
//
// Usage:
//   node dev-ae2a-cdp-shot.mjs <outPrefix> [openWorkbench:0|1]
//
// Writes <outPrefix>-full.png and prints a JSON probe of the mosaic/workbench DOM
// geometry (tile size, window size, body size, chart canvas size) to stdout so the
// 0-height collapse is MEASURED, not just eyeballed.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Resolve `ws` from the PianoidTunner package (where it's installed), not from
// this diagnostics dir.
const require = createRequire(
  "file:///D:/repos/PianoidInstall/PianoidTunner/package.json"
);
const WebSocket = require("ws");

const OUT_PREFIX = process.argv[2] || "dev-ae2a-shot";
const DO_OPEN = process.argv[3] === "1";
const FRONTEND = "http://127.0.0.1:3000";
const CHROME =
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const DEBUG_PORT = 9234;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJSON(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(d));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

// Minimal CDP client over a single target websocket.
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

async function evaluate(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails)
    throw new Error("eval error: " + JSON.stringify(r.exceptionDetails));
  return r.result.value;
}

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dev-ae2a-cdp-"));
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${userDataDir}`,
      "--window-size=1600,1000",
      "--no-first-run",
      "--no-default-browser-check",
      FRONTEND,
    ],
    { stdio: "ignore", detached: false }
  );

  try {
    // Wait for the debugging endpoint.
    let targets = null;
    for (let i = 0; i < 40; i++) {
      try {
        targets = await getJSON(`http://127.0.0.1:${DEBUG_PORT}/json`);
        if (targets && targets.length) break;
      } catch {}
      await sleep(250);
    }
    const page = targets.find((t) => t.type === "page");
    const ws = new WebSocket(page.webSocketDebuggerUrl, {
      perMessageDeflate: false,
      maxPayload: 256 * 1024 * 1024,
    });
    await new Promise((res, rej) => {
      ws.on("open", res);
      ws.on("error", rej);
    });
    const cdp = new CDP(ws);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");

    // Give the React app + mosaic + charts time to mount and lay out.
    await sleep(6000);

    if (DO_OPEN) {
      // Click the first "open workbench" affordance — the Strings/Modes/etc panels
      // render a BarChart open-workbench IconButton (aria-label contains "workbench"
      // case-insensitively in many; fall back to title). Best-effort.
      const opened = await evaluate(
        cdp,
        `(() => {
           const btns = Array.from(document.querySelectorAll('button, [role=button]'));
           const m = btns.find(b => /workbench/i.test((b.getAttribute('aria-label')||'') + ' ' + (b.getAttribute('title')||'')));
           if (m) { m.click(); return (m.getAttribute('aria-label')||m.getAttribute('title')||'clicked'); }
           return null;
         })()`
      );
      console.error("open-workbench click:", opened);
      await sleep(2500);
    }

    // Measure mosaic/workbench geometry.
    const probe = await evaluate(
      cdp,
      `(() => {
        const tiles = Array.from(document.querySelectorAll('.mosaic-tile'));
        const out = { tileCount: tiles.length, accentHosts: document.querySelectorAll('.wb-accent-host').length, tiles: [] };
        for (const t of tiles) {
          const win = t.querySelector('.mosaic-window');
          const title = win ? (win.querySelector('.mosaic-window-title')?.textContent || '') : '';
          const body = win ? win.querySelector('.mosaic-window-body') : null;
          const canvas = body ? body.querySelector('canvas') : null;
          const tr = t.getBoundingClientRect();
          const wr = win ? win.getBoundingClientRect() : null;
          const br = body ? body.getBoundingClientRect() : null;
          const cr = canvas ? canvas.getBoundingClientRect() : null;
          // is the immediate child of the tile a display:contents wrapper?
          const firstChild = t.firstElementChild;
          const fcDisplay = firstChild ? getComputedStyle(firstChild).display : null;
          const fcClass = firstChild ? firstChild.className : null;
          out.tiles.push({
            title,
            tile: { w: Math.round(tr.width), h: Math.round(tr.height) },
            window: wr ? { w: Math.round(wr.width), h: Math.round(wr.height) } : null,
            body: br ? { w: Math.round(br.width), h: Math.round(br.height) } : null,
            canvas: cr ? { w: Math.round(cr.width), h: Math.round(cr.height) } : 'NO_CANVAS',
            firstChild: { class: fcClass, display: fcDisplay },
          });
        }
        return out;
      })()`
    );
    console.log(JSON.stringify(probe, null, 2));

    // Full-page screenshot.
    const shot = await cdp.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    const outFile = `${OUT_PREFIX}-full.png`;
    fs.writeFileSync(outFile, Buffer.from(shot.data, "base64"));
    console.error("wrote", outFile);

    ws.close();
  } finally {
    try {
      process.kill(chrome.pid);
    } catch {}
  }
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
