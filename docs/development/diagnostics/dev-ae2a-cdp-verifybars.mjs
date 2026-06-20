// dev-ae2a — verify Issue 1 AFTER: bars carry the 2-D accent color, titles uniform.
// Finds workbench tiles BY TITLE (the wrapper is gone now), samples the actual rendered
// bar PIXEL color from each workbench canvas, and checks the title bar has NO accent.
// Also opens workbenches for DIFFERENT panels (Strings=blue, Modes=green, Excitation=red)
// so the per-panel hue difference is visible. Assumes preset already loaded + populated by
// the caller having run the final populate first (or it loads via seeded localStorage).
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
const DEBUG_PORT = Number(process.argv[3] || 9254);
const OUT = process.argv[2] || "dev-ae2a-verifybars";
const PRESET = "presets/BaselinePreset1.json";
const SAFE = { path: PRESET, volume:64, sample_rate:48, string_iterations:4, number_of_modes:64, use_simulation:0, debug_mode:0, cycle_iterations:64, start_right_away:0, audio_on:0, listen_to_midi:0, use_cuda:1, audio_driver_type:0, audio_buffer_size:4 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function getJSON(url){return new Promise((resolve,reject)=>{http.get(url,(res)=>{let d="";res.on("data",c=>d+=c);res.on("end",()=>{try{resolve(JSON.parse(d))}catch(e){reject(e)}})}).on("error",reject)})}
class CDP{constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();ws.on("message",raw=>{const m=JSON.parse(raw.toString());if(m.id&&this.pending.has(m.id)){const{resolve,reject}=this.pending.get(m.id);this.pending.delete(m.id);if(m.error)reject(new Error(JSON.stringify(m.error)));else resolve(m.result)}})}send(method,params={}){const id=++this.id;return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params}))})}}
async function ev(cdp,expression){const r=await cdp.send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error("eval: "+JSON.stringify(r.exceptionDetails));return r.result.value}
async function clickAt(cdp,x,y){await cdp.send("Input.dispatchMouseEvent",{type:"mousePressed",x,y,button:"left",clickCount:1});await cdp.send("Input.dispatchMouseEvent",{type:"mouseReleased",x,y,button:"left",clickCount:1})}

// Sample bar color: read the ECharts canvas pixel data at several x's, mid-low height,
// and return the most-saturated non-grey/non-white color found (the bar fill).
const SAMPLE_FN = `(canvas) => {
  try {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const data = ctx.getImageData(0, 0, w, h).data;
    const counts = {};
    for (let y = Math.floor(h*0.45); y < h*0.95; y += 2) {
      for (let x = Math.floor(w*0.1); x < w*0.95; x += 2) {
        const i = (y*w + x)*4;
        const r=data[i], g=data[i+1], b=data[i+2], a=data[i+3];
        if (a < 200) continue;
        // skip near-white (bg) and near-grey (axis/text)
        const mx=Math.max(r,g,b), mn=Math.min(r,g,b);
        if (mx > 235 && mn > 235) continue;       // white-ish
        if (mx - mn < 18) continue;               // grey-ish (low saturation)
        const key = r+','+g+','+b;
        counts[key] = (counts[key]||0)+1;
      }
    }
    let best=null, bestN=0;
    for (const k in counts){ if(counts[k]>bestN){bestN=counts[k]; best=k;} }
    return best ? {rgb: best, n: bestN} : null;
  } catch(e){ return 'sample-err:'+e.message }
}`;

async function probeWorkbenches(cdp){
  return ev(cdp, `(() => {
    const sample = ${SAMPLE_FN};
    const tiles=[...document.querySelectorAll('.mosaic-tile')];
    const out=[];
    for(const t of tiles){
      const title=t.querySelector('.mosaic-window-title')?.textContent||'';
      // workbench panes: title is "Workbench" or "<groupe> · ..." (contains ' · ') or '(panel)'
      const isWb = title==='Workbench' || / · /.test(title) || /\\(panel\\)/.test(title);
      if(!isWb) continue;
      const tb=t.querySelector('.mosaic-window-toolbar');
      const body=t.querySelector('.mosaic-window-body');
      const canvases=body?[...body.querySelectorAll('canvas')]:[];
      // the bar chart is the FIRST/larger canvas; sample it
      let barColor=null;
      for(const c of canvases){ const r=c.getBoundingClientRect(); if(r.height>50){ barColor=sample(c); if(barColor&&barColor.rgb) break; } }
      out.push({
        title,
        titleToolbarBg: tb?getComputedStyle(tb).backgroundColor:null,
        titleBorderLeft: tb?(getComputedStyle(tb).borderLeftColor+' '+getComputedStyle(tb).borderLeftWidth):null,
        canvasCount: canvases.length,
        barColorSample: barColor,
      });
    }
    return out;
  })()`);
}

async function main(){
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(),"dev-ae2a-vb-"));
  const chrome = spawn(CHROME,["--headless=new","--disable-gpu",`--remote-debugging-port=${DEBUG_PORT}`,`--user-data-dir=${userDataDir}`,"--window-size=1600,1000","--no-first-run","--no-default-browser-check","about:blank"],{stdio:"ignore"});
  try{
    let targets=null;
    for(let i=0;i<40;i++){try{targets=await getJSON(`http://127.0.0.1:${DEBUG_PORT}/json`);if(targets&&targets.length)break}catch{}await sleep(250)}
    const page=targets.find(t=>t.type==="page");
    const ws=new WebSocket(page.webSocketDebuggerUrl,{perMessageDeflate:false,maxPayload:256*1024*1024});
    await new Promise((res,rej)=>{ws.on("open",res);ws.on("error",rej)});
    const cdp=new CDP(ws);await cdp.send("Runtime.enable");await cdp.send("Page.enable");

    await cdp.send("Page.navigate",{url:FRONTEND}); await sleep(3500);
    await ev(cdp, `localStorage.setItem('presetLoadSettings', ${JSON.stringify(JSON.stringify(SAFE))})`);
    await cdp.send("Page.navigate",{url:FRONTEND}); await sleep(8000);

    // open Preset gear → set path → APPLY (load)
    const gear = await ev(cdp, `(() => { const tiles=[...document.querySelectorAll('.mosaic-tile')]; const t=tiles.find(x=>/^Pre/.test(x.querySelector('.mosaic-window-title')?.textContent||'')); const ctrls=t.querySelector('.mosaic-window-controls'); const g=[...(ctrls?ctrls.querySelectorAll('button'):[])].find(b=>{const s=b.querySelector('svg');return s&&/Settings/i.test(s.getAttribute('data-testid')||'')}); if(g){const r=g.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}} return null; })()`);
    if(gear){ await clickAt(cdp, gear.x, gear.y); await sleep(1800); }
    await ev(cdp, `(() => { const dlg=document.querySelector('[role=dialog]'); if(!dlg)return; const inputs=[...dlg.querySelectorAll('input')]; let target=null; for(const inp of inputs){ if(inp.type!=='text')continue; let p=inp.closest('div'); for(let up=0;up<4&&p;up++){const t=(p.querySelector('label,span,p')?.textContent||'').trim(); if(/^path:?$/i.test(t)){target=inp;break;} p=p.parentElement;} if(target)break;} if(!target)return; const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; setter.call(target,${JSON.stringify(PRESET)}); target.dispatchEvent(new Event('input',{bubbles:true})); target.dispatchEvent(new Event('change',{bubbles:true})); target.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Enter'})); target.blur(); })()`);
    await sleep(900);
    await ev(cdp, `(() => { const dlg=document.querySelector('[role=dialog]')||document; const a=[...dlg.querySelectorAll('button')].find(b=>/^apply$/i.test((b.textContent||'').trim())&&!b.disabled); if(a)a.click(); })()`);
    await sleep(15000);

    // select pitch
    const vp = await ev(cdp, `(() => { const tiles=[...document.querySelectorAll('.mosaic-tile')]; const t=tiles.find(x=>/Virtual Piano/.test(x.querySelector('.mosaic-window-title')?.textContent||'')); if(!t)return null; const cv=t.querySelector('canvas'); if(!cv)return {hasCanvas:false}; const r=cv.getBoundingClientRect(); return {x:Math.round(r.left+r.width*0.3),y:Math.round(r.top+r.height*0.55),hasCanvas:true}; })()`);
    if(vp&&vp.hasCanvas){ await clickAt(cdp,vp.x,vp.y); await sleep(2500); }

    // open a STRINGS fixed workbench (blue) from a param row
    await ev(cdp, `(() => { const tiles=[...document.querySelectorAll('.mosaic-tile')]; const stt=tiles.find(x=>/^Strings/.test(x.querySelector('.mosaic-window-title')?.textContent||'')); if(!stt)return; const b=[...stt.querySelector('.mosaic-window-body').querySelectorAll('button')].find(x=>{const s=x.querySelector('svg');return s&&/BarChart/i.test(s.getAttribute('data-testid')||'')}); if(b)b.click(); })()`);
    await sleep(2000);
    // select a MODE so the global-dynamic "Workbench" follows Modes (green)
    await ev(cdp, `(() => { const tiles=[...document.querySelectorAll('.mosaic-tile')]; const md=tiles.find(x=>/^Modes/.test(x.querySelector('.mosaic-window-title')?.textContent||'')); if(!md)return; const b=[...md.querySelector('.mosaic-window-body').querySelectorAll('button')].find(x=>{const s=x.querySelector('svg');return s&&/BarChart/i.test(s.getAttribute('data-testid')||'')}); if(b)b.click(); })()`);
    await sleep(2500);

    const probe = await probeWorkbenches(cdp);
    console.log(JSON.stringify(probe,null,2));
    const shot=await cdp.send("Page.captureScreenshot",{format:"png"});
    fs.writeFileSync(`${OUT}-full.png`, Buffer.from(shot.data,"base64"));
    console.error("wrote", `${OUT}-full.png`);
    ws.close();
  } finally { try{process.kill(chrome.pid)}catch{} }
}
main().catch(e=>{console.error("FATAL",e);process.exit(1)});
