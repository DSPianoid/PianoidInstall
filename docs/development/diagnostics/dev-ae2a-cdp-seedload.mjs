// dev-ae2a (follow-up) — pre-seed localStorage so the frontend AUTO-loads the default
// preset on boot (its mount effect calls ensureBackendAndLoadPreset when path is set),
// then select a pitch and screenshot + probe a POPULATED workbench: the BAR colors and
// the toolbar open-workbench ICONS. Real browser via CDP. Coordinator-authorized preset
// load into the running stack (default preset).
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
const DEBUG_PORT = Number(process.argv[3] || 9240);
const OUT = process.argv[2] || "dev-ae2a-seedload";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function getJSON(url){return new Promise((resolve,reject)=>{http.get(url,(res)=>{let d="";res.on("data",c=>d+=c);res.on("end",()=>{try{resolve(JSON.parse(d))}catch(e){reject(e)}})}).on("error",reject)})}
class CDP{constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();ws.on("message",raw=>{const m=JSON.parse(raw.toString());if(m.id&&this.pending.has(m.id)){const{resolve,reject}=this.pending.get(m.id);this.pending.delete(m.id);if(m.error)reject(new Error(JSON.stringify(m.error)));else resolve(m.result)}})}send(method,params={}){const id=++this.id;return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params}))})}}
async function ev(cdp,expression){const r=await cdp.send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error("eval: "+JSON.stringify(r.exceptionDetails));return r.result.value}
async function clickAt(cdp,x,y){await cdp.send("Input.dispatchMouseEvent",{type:"mousePressed",x,y,button:"left",clickCount:1});await cdp.send("Input.dispatchMouseEvent",{type:"mouseReleased",x,y,button:"left",clickCount:1})}

const PRESET_SETTINGS = {
  path: "presets/BaselinePreset1.json",
  volume: 64, sample_rate: 48, string_iterations: 4, number_of_modes: 64,
  use_simulation: 0, debug_mode: 0, cycle_iterations: 64, start_right_away: 1,
  audio_on: 1, listen_to_midi: 0, use_cuda: 1, audio_driver_type: 4, audio_buffer_size: 4,
};

async function main(){
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(),"dev-ae2a-seed-"));
  const chrome = spawn(CHROME,["--headless=new","--disable-gpu",`--remote-debugging-port=${DEBUG_PORT}`,`--user-data-dir=${userDataDir}`,"--window-size=1600,1000","--no-first-run","--no-default-browser-check","about:blank"],{stdio:"ignore"});
  try{
    let targets=null;
    for(let i=0;i<40;i++){try{targets=await getJSON(`http://127.0.0.1:${DEBUG_PORT}/json`);if(targets&&targets.length)break}catch{}await sleep(250)}
    const page=targets.find(t=>t.type==="page");
    const ws=new WebSocket(page.webSocketDebuggerUrl,{perMessageDeflate:false,maxPayload:256*1024*1024});
    await new Promise((res,rej)=>{ws.on("open",res);ws.on("error",rej)});
    const cdp=new CDP(ws);await cdp.send("Page.enable");await cdp.send("Runtime.enable");

    // 1) Navigate to the origin first (so localStorage is for 127.0.0.1:3000), seed, then reload.
    await cdp.send("Page.navigate",{url:FRONTEND});
    await sleep(4000);
    const seeded = await ev(cdp, `(() => { try {
      localStorage.setItem('presetLoadSettings', ${JSON.stringify(JSON.stringify(PRESET_SETTINGS))});
      return 'seeded:'+localStorage.getItem('presetLoadSettings').slice(0,40);
    } catch(e){ return 'ERR:'+e.message } })()`);
    console.error("seed:", seeded);
    await cdp.send("Page.navigate",{url:FRONTEND}); // reload with the seeded path → auto-load
    await sleep(14000); // app boot + engine (re)init + frontend sync

    // 2) Probe load state: availableNotes present? Strings no longer "Select a pitch"?
    const loadState = await ev(cdp, `(() => {
      const tiles=[...document.querySelectorAll('.mosaic-tile')];
      const st=tiles.find(x=>/^Strings/.test(x.querySelector('.mosaic-window-title')?.textContent||''));
      const stText = st? (st.querySelector('.mosaic-window-body').textContent||'').slice(0,60):'no-strings';
      const vp=tiles.find(x=>/Virtual Piano/.test(x.querySelector('.mosaic-window-title')?.textContent||''));
      const vpHasCanvas = vp? !!vp.querySelector('canvas') : false;
      const apply=[...document.querySelectorAll('button')].find(b=>/^apply$/i.test((b.textContent||'').trim()));
      return { stringsText: stText, vpHasCanvas, applyDisabled: apply?apply.disabled:'n/a' };
    })()`);
    console.error("loadState:", JSON.stringify(loadState));

    // 3) Select a pitch via the VirtualPiano canvas if present.
    const vp = await ev(cdp, `(() => {
      const tiles=[...document.querySelectorAll('.mosaic-tile')];
      const t=tiles.find(x=>/Virtual Piano/.test(x.querySelector('.mosaic-window-title')?.textContent||''));
      if(!t) return null; const cv=t.querySelector('canvas'); const body=t.querySelector('.mosaic-window-body');
      const r=(cv||body).getBoundingClientRect();
      return { x:Math.round(r.left+r.width*0.18), y:Math.round(r.top+r.height*0.55), hasCanvas:!!cv };
    })()`);
    console.error("vp:", JSON.stringify(vp));
    if(vp&&vp.x){ await clickAt(cdp,vp.x,vp.y); await sleep(2500); }

    // 4) Open a panel-following workbench from the Strings panel toolbar + a FIXED one
    //    from a param row, so we can compare both bar colors + both icons.
    const openPanel = await ev(cdp, `(() => {
      const tiles=[...document.querySelectorAll('.mosaic-tile')];
      const st=tiles.find(x=>/^Strings/.test(x.querySelector('.mosaic-window-title')?.textContent||''));
      if(!st) return 'no-strings';
      // panel-following button = the toolbar IconButton with the 'follows' tooltip
      const ctrls=st.querySelector('.mosaic-window-controls');
      const btns=ctrls?[...ctrls.querySelectorAll('button')]:[];
      const pf=btns.find(b=>/follow/i.test(b.getAttribute('title')||''));
      if(pf){ pf.click(); return 'panel-following-opened'; }
      return 'no-panel-following-btn; titles='+JSON.stringify(btns.map(b=>b.getAttribute('title')));
    })()`);
    console.error("openPanel:", openPanel);
    await sleep(2500);

    // 5) Probe ALL workbench panes: bar canvas + first-bar fill color (sample a pixel),
    //    and dump the toolbar icon SVGs (data-testid) for fixed vs panel-following.
    const probe = await ev(cdp, `(() => {
      const tiles=[...document.querySelectorAll('.mosaic-tile')]; const wbs=[];
      for(const t of tiles){ const host=t.querySelector(':scope > .wb-accent-host'); if(!host) continue;
        const title=t.querySelector('.mosaic-window-title')?.textContent||'';
        const body=t.querySelector('.mosaic-window-body'); const canvases=body?[...body.querySelectorAll('canvas')]:[];
        const cr = canvases.length? canvases[0].getBoundingClientRect():null;
        wbs.push({ title, accentVar: host.style.getPropertyValue('--wb-accent'),
          toolbarHasAccentFill: getComputedStyle(t.querySelector('.mosaic-window-toolbar')).backgroundColor,
          canvasCount: canvases.length, firstCanvas: cr?{w:Math.round(cr.width),h:Math.round(cr.height)}:null });
      }
      // toolbar icons for fixed (per-row BarChart) vs panel-following (Timeline)
      const iconInfo = {};
      const stTile=tiles.find(x=>/^Strings/.test(x.querySelector('.mosaic-window-title')?.textContent||''));
      if(stTile){
        const rowBtns=[...stTile.querySelector('.mosaic-window-body').querySelectorAll('button svg')].map(s=>s.getAttribute('data-testid')).filter(Boolean);
        const ctrlBtns=[...(stTile.querySelector('.mosaic-window-controls')?.querySelectorAll('button svg')||[])].map(s=>s.getAttribute('data-testid')).filter(Boolean);
        iconInfo.stringsRowIcons = rowBtns.slice(0,8);
        iconInfo.stringsToolbarIcons = ctrlBtns;
      }
      return { workbenches:wbs, iconInfo };
    })()`);
    console.log(JSON.stringify(probe,null,2));

    const shot=await cdp.send("Page.captureScreenshot",{format:"png"});
    fs.writeFileSync(`${OUT}-full.png`, Buffer.from(shot.data,"base64"));
    console.error("wrote", `${OUT}-full.png`);
    ws.close();
  } finally { try{process.kill(chrome.pid)}catch{} }
}
main().catch(e=>{console.error("FATAL",e);process.exit(1)});
