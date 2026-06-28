// dev-ae2a — populate a workbench with data and verify the ruler + barchart render.
// Loads the running PianoidTunner (3000), selects a pitch so the global-dynamic
// Workbench follows a parameter and draws, then probes the Workbench tile for a
// canvas (the bar chart) + a ruler strip, and screenshots. Real browser via CDP.
//
// Strategy to populate: a Strings param row exposes an "open workbench" IconButton
// (aria-label ~ "workbench"). Clicking it spawns a FIXED workbench bound to that
// param with the full per-pitch vector → bars + ruler. We also try selecting a pitch
// first (Virtual Piano key) so the global-dynamic Workbench has an active param.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const require = createRequire(
  "file:///D:/repos/PianoidInstall/PianoidTunner/package.json"
);
const WebSocket = require("ws");

const OUT_PREFIX = process.argv[2] || "dev-ae2a-verify";
const FRONTEND = "http://127.0.0.1:3000";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const DEBUG_PORT = 9235;
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

async function ev(cdp, expression) {
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
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dev-ae2a-cdp2-"));
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
    { stdio: "ignore" }
  );

  try {
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
    await sleep(6000);

    // 1) Select a pitch: click a Virtual Piano key (the pane canvas). The VP draws
    //    keys on a canvas; click near the left third at mid-height to hit a key.
    const vpClick = await ev(
      cdp,
      `(() => {
        const tiles = Array.from(document.querySelectorAll('.mosaic-tile'));
        const vp = tiles.find(t => /Virtual Piano/.test(t.querySelector('.mosaic-window-title')?.textContent||''));
        if (!vp) return 'no-vp';
        const cv = vp.querySelector('canvas');
        const body = vp.querySelector('.mosaic-window-body');
        const r = (cv||body).getBoundingClientRect();
        return { x: Math.round(r.left + r.width*0.2), y: Math.round(r.top + r.height*0.6), hasCanvas: !!cv };
      })()`
    );
    console.error("vp target:", JSON.stringify(vpClick));
    if (vpClick && vpClick.x) {
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: vpClick.x,
        y: vpClick.y,
        button: "left",
        clickCount: 1,
      });
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: vpClick.x,
        y: vpClick.y,
        button: "left",
        clickCount: 1,
      });
      await sleep(2000);
    }

    // 2) Also open a FIXED workbench from a Strings param row (most reliable data path).
    const openWb = await ev(
      cdp,
      `(() => {
        const btns = Array.from(document.querySelectorAll('button, [role=button]'));
        const m = btns.find(b => /workbench/i.test((b.getAttribute('aria-label')||'') + ' ' + (b.getAttribute('title')||'')));
        if (m) { m.click(); return (m.getAttribute('aria-label')||m.getAttribute('title')||'clicked'); }
        return 'no-open-wb-button';
      })()`
    );
    console.error("open-workbench:", openWb);
    await sleep(2500);

    // 3) Probe ALL workbench tiles for canvas (barchart) + a ruler strip.
    const probe = await ev(
      cdp,
      `(() => {
        const tiles = Array.from(document.querySelectorAll('.mosaic-tile'));
        const wbs = [];
        for (const t of tiles) {
          const title = t.querySelector('.mosaic-window-title')?.textContent || '';
          const host = t.querySelector(':scope > .wb-accent-host');
          const win = t.querySelector('.mosaic-window');
          const body = win ? win.querySelector('.mosaic-window-body') : null;
          if (!host) continue; // only workbench panes carry the accent host
          const canvases = body ? body.querySelectorAll('canvas') : [];
          const cr = canvases.length ? canvases[0].getBoundingClientRect() : null;
          const wr = win.getBoundingClientRect();
          const br = body ? body.getBoundingClientRect() : null;
          // ruler heuristics: a VirtualPiano/ModesRule/FlatBarAxis renders extra canvas(es)
          // or a keyed strip; count child canvases + look for known ruler class fragments.
          const rulerLike = body ? body.querySelectorAll('[class*=ruler],[class*=Rule],[class*=piano],[class*=axis],[class*=Axis]').length : 0;
          wbs.push({
            title,
            accentVar: host ? host.style.getPropertyValue('--wb-accent') : null,
            hostDisplay: getComputedStyle(host).display,
            window: { w: Math.round(wr.width), h: Math.round(wr.height) },
            body: br ? { w: Math.round(br.width), h: Math.round(br.height) } : null,
            canvasCount: canvases.length,
            firstCanvas: cr ? { w: Math.round(cr.width), h: Math.round(cr.height) } : null,
            rulerLikeNodes: rulerLike,
          });
        }
        return { workbenchCount: wbs.length, workbenches: wbs };
      })()`
    );
    console.log(JSON.stringify(probe, null, 2));

    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(`${OUT_PREFIX}-full.png`, Buffer.from(shot.data, "base64"));
    console.error("wrote", `${OUT_PREFIX}-full.png`);
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
