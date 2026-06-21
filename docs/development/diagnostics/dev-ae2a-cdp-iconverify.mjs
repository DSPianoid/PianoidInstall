// dev-ae2a — verify Issue 2 (reversed): the panel-following open-workbench toolbar
// button now shows the SAME BarChartIcon as the fixed-workbench per-row buttons.
// Loads the default preset (so the panel toolbars render the workbench button, which
// only appears when availableNotes>0), then dumps the Strings panel TOOLBAR icons +
// row icons and screenshots the Strings pane toolbar region.
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
const DEBUG_PORT = Number(process.argv[3] || 9260);
const OUT = process.argv[2] || "dev-ae2a-iconverify";
const PRESET = "presets/BaselinePreset1.json";
const SAFE = { path: PRESET, volume:64, sample_rate:48, string_iterations:4, number_of_modes:64, use_simulation:0, debug_mode:0, cycle_iterations:64, start_right_away:0, audio_on:0, listen_to_midi:0, use_cuda:1, audio_driver_type:0, audio_buffer_size:4 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function getJSON(url){return new Promise((resolve,reject)=>{http.get(url,(res)=>{let d="";res.on("data",c=>d+=c);res.on("end",()=>{try{resolve(JSON.parse(d))}catch(e){reject(e)}})}).on("error",reject)})}
class CDP{constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();ws.on("message",raw=>{const m=JSON.parse(raw.toString());if(m.id&&this.pending.has(m.id)){const{resolve,reject}=this.pending.get(m.id);this.pending.delete(m.id);if(m.error)reject(new Error(JSON.stringify(m.error)));else resolve(m.result)}})}send(method,params={}){const id=++this.id;return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params}))})}}
async function ev(cdp,expression){const r=await cdp.send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error("eval: "+JSON.stringify(r.exceptionDetails));return r.result.value}
async function clickAt(cdp,x,y){await cdp.send("Input.dispatchMouseEvent",{type:"mousePressed",x,y,button:"left",clickCount:1});await cdp.send("Input.dispatchMouseEvent",{type:"mouseReleased",x,y,button:"left",clickCount:1})}

async function main(){
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(),"dev-ae2a-iv-"));
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

    // load via Preset gear → path field → APPLY
    const gear = await ev(cdp, `(() => { const tiles=[...document.querySelectorAll('.mosaic-tile')]; const t=tiles.find(x=>/^Pre/.test(x.querySelector('.mosaic-window-title')?.textContent||'')); const ctrls=t.querySelector('.mosaic-window-controls'); const g=[...(ctrls?ctrls.querySelectorAll('button'):[])].find(b=>{const s=b.querySelector('svg');return s&&/Settings/i.test(s.getAttribute('data-testid')||'')}); if(g){const r=g.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}} return null; })()`);
    if(gear){ await clickAt(cdp, gear.x, gear.y); await sleep(1800); }
    await ev(cdp, `(() => { const dlg=document.querySelector('[role=dialog]'); if(!dlg)return; const inputs=[...dlg.querySelectorAll('input')]; let target=null; for(const inp of inputs){ if(inp.type!=='text')continue; let p=inp.closest('div'); for(let up=0;up<4&&p;up++){const t=(p.querySelector('label,span,p')?.textContent||'').trim(); if(/^path:?$/i.test(t)){target=inp;break;} p=p.parentElement;} if(target)break;} if(!target)return; const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; setter.call(target,${JSON.stringify(PRESET)}); target.dispatchEvent(new Event('input',{bubbles:true})); target.dispatchEvent(new Event('change',{bubbles:true})); target.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Enter'})); target.blur(); })()`);
    await sleep(900);
    await ev(cdp, `(() => { const dlg=document.querySelector('[role=dialog]')||document; const a=[...dlg.querySelectorAll('button')].find(b=>/^apply$/i.test((b.textContent||'').trim())&&!b.disabled); if(a)a.click(); })()`);
    await sleep(15000);

    // dump Strings panel toolbar icons + row icons; also Feedin (matrix panel — its ONLY wb button is the panel one)
    const icons = await ev(cdp, `(() => {
      const tiles=[...document.querySelectorAll('.mosaic-tile')];
      const grab = (re) => {
        const t=tiles.find(x=>re.test(x.querySelector('.mosaic-window-title')?.textContent||''));
        if(!t) return null;
        const tb=[...(t.querySelector('.mosaic-window-controls')?.querySelectorAll('button svg')||[])].map(s=>s.getAttribute('data-testid')).filter(Boolean);
        const row=[...t.querySelector('.mosaic-window-body').querySelectorAll('button svg')].map(s=>s.getAttribute('data-testid')).filter(Boolean).slice(0,6);
        return { toolbar: tb, row };
      };
      return { Strings: grab(/^Strings/), Feedin: grab(/^Feedin/), Modes: grab(/^Modes/) };
    })()`);
    console.log(JSON.stringify(icons,null,2));

    // screenshot the Strings pane (toolbar region) — clip to the Strings tile rect
    const rect = await ev(cdp, `(() => { const tiles=[...document.querySelectorAll('.mosaic-tile')]; const t=tiles.find(x=>/^Strings/.test(x.querySelector('.mosaic-window-title')?.textContent||'')); if(!t)return null; const r=t.getBoundingClientRect(); return {x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.min(120,Math.round(r.height))}; })()`);
    let shotParams = { format:"png" };
    if(rect){ shotParams.clip = { x:rect.x, y:rect.y, width:rect.w, height:rect.h, scale:1 }; }
    const shot=await cdp.send("Page.captureScreenshot", shotParams);
    fs.writeFileSync(`${OUT}-toolbar.png`, Buffer.from(shot.data,"base64"));
    // also a full-page shot for context
    const full=await cdp.send("Page.captureScreenshot",{format:"png"});
    fs.writeFileSync(`${OUT}-full.png`, Buffer.from(full.data,"base64"));
    console.error("wrote", `${OUT}-toolbar.png`, "+", `${OUT}-full.png`);
    ws.close();
  } finally { try{process.kill(chrome.pid)}catch{} }
}
main().catch(e=>{console.error("FATAL",e);process.exit(1)});
