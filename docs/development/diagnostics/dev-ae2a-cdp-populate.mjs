// dev-ae2a — load the default preset into the LIVE frontend, select a pitch, then
// screenshot + probe a POPULATED workbench (ruler + barchart with data). Uses the
// app's own preset-load path so frontend state syncs (a backend-only load would not
// refresh the frontend). Best-effort UI driving with several fallbacks.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
const require = createRequire("file:///D:/repos/PianoidInstall/PianoidTunner/package.json");
const WebSocket = require("ws");
const FRONTEND = "http://127.0.0.1:3000";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const DEBUG_PORT = 9237;
const OUT = process.argv[2] || "dev-ae2a-populated";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function getJSON(url){return new Promise((resolve,reject)=>{http.get(url,(res)=>{let d="";res.on("data",c=>d+=c);res.on("end",()=>{try{resolve(JSON.parse(d))}catch(e){reject(e)}})}).on("error",reject)})}
class CDP{constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();ws.on("message",raw=>{const m=JSON.parse(raw.toString());if(m.id&&this.pending.has(m.id)){const{resolve,reject}=this.pending.get(m.id);this.pending.delete(m.id);if(m.error)reject(new Error(JSON.stringify(m.error)));else resolve(m.result)}})}send(method,params={}){const id=++this.id;return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params}))})}}
async function ev(cdp,expression){const r=await cdp.send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error("eval: "+JSON.stringify(r.exceptionDetails));return r.result.value}
async function clickAt(cdp,x,y){await cdp.send("Input.dispatchMouseEvent",{type:"mousePressed",x,y,button:"left",clickCount:1});await cdp.send("Input.dispatchMouseEvent",{type:"mouseReleased",x,y,button:"left",clickCount:1})}

async function main(){
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(),"dev-ae2a-cdp4-"));
  const chrome = spawn(CHROME,["--headless=new","--disable-gpu",`--remote-debugging-port=${DEBUG_PORT}`,`--user-data-dir=${userDataDir}`,"--window-size=1600,1000","--no-first-run","--no-default-browser-check",FRONTEND],{stdio:"ignore"});
  try{
    let targets=null;
    for(let i=0;i<40;i++){try{targets=await getJSON(`http://127.0.0.1:${DEBUG_PORT}/json`);if(targets&&targets.length)break}catch{}await sleep(250)}
    const page=targets.find(t=>t.type==="page");
    const ws=new WebSocket(page.webSocketDebuggerUrl,{perMessageDeflate:false,maxPayload:256*1024*1024});
    await new Promise((res,rej)=>{ws.on("open",res);ws.on("error",rej)});
    const cdp=new CDP(ws);await cdp.send("Page.enable");await cdp.send("Runtime.enable");await sleep(6000);

    // 1) Open the Preset pane's load: the Preset pane has a load (upload) icon button.
    //    Click the first icon button in the Preset pane (the FileUploader trigger),
    //    then if a path field exists, set it to the default preset and submit.
    // Simpler + deterministic: click the toolbar/preset APPLY after ensuring path.
    // We drive via the app's load button found by aria-label.
    const loadInfo = await ev(cdp, `(() => {
      // Find an APPLY button (Preset pane footer) — clicking it runs ensureBackendAndLoadPreset.
      const apply=[...document.querySelectorAll('button')].find(b=>/apply/i.test(b.textContent||''));
      return { applyFound: !!apply, applyDisabled: apply?apply.disabled:null };
    })()`);
    console.error("apply:", JSON.stringify(loadInfo));

    // The default preset path is pre-set in presetLoadSettings; APPLY is disabled only
    // when busy/loaded. If disabled, try clicking the Preset pane load (upload) icon first.
    // Click the Preset pane's first icon button (load).
    const presetIcons = await ev(cdp, `(() => {
      const tiles=[...document.querySelectorAll('.mosaic-tile')];
      const t=tiles.find(x=>/^Preset|^Pre\\b/.test(x.querySelector('.mosaic-window-title')?.textContent||'')) || tiles[0];
      const body=t.querySelector('.mosaic-window-body');
      const btns=[...body.querySelectorAll('button')];
      return btns.map((b,i)=>({i, al:b.getAttribute('aria-label'), title:b.getAttribute('title'), txt:(b.textContent||'').slice(0,14)}));
    })()`);
    console.error("preset pane buttons:", JSON.stringify(presetIcons));

    // Best path: invoke APPLY if enabled.
    let applied = await ev(cdp, `(() => {
      const apply=[...document.querySelectorAll('button')].find(b=>/apply/i.test(b.textContent||''));
      if(apply && !apply.disabled){ apply.click(); return 'apply-clicked'; }
      return 'apply-disabled-or-missing';
    })()`);
    console.error("apply attempt:", applied);
    await sleep(8000); // backend load + frontend sync

    // 2) Probe whether availableNotes populated → select a pitch via the VirtualPiano.
    //    After load, Strings should drop "Select a pitch". Click a VP key if present.
    const vp = await ev(cdp, `(() => {
      const tiles=[...document.querySelectorAll('.mosaic-tile')];
      const t=tiles.find(x=>/Virtual Piano/.test(x.querySelector('.mosaic-window-title')?.textContent||''));
      if(!t) return null;
      const body=t.querySelector('.mosaic-window-body');
      // keys may be buttons/divs; try a clickable child with a pitch-ish role.
      const r=body.getBoundingClientRect();
      const cv=body.querySelector('canvas');
      return { x: Math.round(r.left + r.width*0.15), y: Math.round(r.top + r.height*0.55), hasCanvas: !!cv, bodyHTMLhead: body.innerHTML.slice(0,200) };
    })()`);
    console.error("vp after load:", JSON.stringify(vp));
    if(vp && vp.x){ await clickAt(cdp, vp.x, vp.y); await sleep(2500); }

    // 3) Probe ALL workbench panes for canvas + ruler now.
    const probe = await ev(cdp, `(() => {
      const tiles=[...document.querySelectorAll('.mosaic-tile')];
      const wbs=[];
      for(const t of tiles){
        const host=t.querySelector(':scope > .wb-accent-host');
        if(!host) continue;
        const title=t.querySelector('.mosaic-window-title')?.textContent||'';
        const win=t.querySelector('.mosaic-window');
        const body=win.querySelector('.mosaic-window-body');
        const canvases=body?[...body.querySelectorAll('canvas')]:[];
        const wr=win.getBoundingClientRect(); const br=body?body.getBoundingClientRect():null;
        wbs.push({ title, window:{w:Math.round(wr.width),h:Math.round(wr.height)}, body:br?{w:Math.round(br.width),h:Math.round(br.height)}:null,
          canvasCount:canvases.length, canvasSizes:canvases.map(c=>{const r=c.getBoundingClientRect();return {w:Math.round(r.width),h:Math.round(r.height)}}),
          rulerLike: body? body.querySelectorAll('[class*=Rule],[class*=ruler],[class*=piano],[class*=axis],[class*=Axis],[class*=key]').length : 0 });
      }
      return { workbenches:wbs };
    })()`);
    console.log(JSON.stringify(probe,null,2));

    const shot=await cdp.send("Page.captureScreenshot",{format:"png"});
    fs.writeFileSync(`${OUT}-full.png`, Buffer.from(shot.data,"base64"));
    console.error("wrote", `${OUT}-full.png`);
    ws.close();
  } finally { try{process.kill(chrome.pid)}catch{} }
}
main().catch(e=>{console.error("FATAL",e);process.exit(1)});
