// dev-ae2a — FINAL populate: set the Preset dialog PATH field (input labelled "path:")
// + force a hardware-free load by also seeding localStorage audio settings BEFORE boot,
// then APPLY → frontend loads → availableNotes populate → select a pitch → open a
// panel-following + a fixed workbench → screenshot + probe bar colors and toolbar icons.
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
const DEBUG_PORT = Number(process.argv[3] || 9250);
const OUT = process.argv[2] || "dev-ae2a-final";
const PRESET = "presets/BaselinePreset1.json";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// hardware-free, audio-off settings to keep the backend ALIVE during the frontend load
const SAFE = { path: PRESET, volume:64, sample_rate:48, string_iterations:4, number_of_modes:64,
  use_simulation:0, debug_mode:0, cycle_iterations:64, start_right_away:0, audio_on:0,
  listen_to_midi:0, use_cuda:1, audio_driver_type:0, audio_buffer_size:4 };
function getJSON(url){return new Promise((resolve,reject)=>{http.get(url,(res)=>{let d="";res.on("data",c=>d+=c);res.on("end",()=>{try{resolve(JSON.parse(d))}catch(e){reject(e)}})}).on("error",reject)})}
class CDP{constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();this.console=[];ws.on("message",raw=>{const m=JSON.parse(raw.toString());if(m.method==='Runtime.consoleAPICalled'){this.console.push((m.params.type||'')+':'+(m.params.args||[]).map(a=>a.value||'').join(' ').slice(0,120))}if(m.id&&this.pending.has(m.id)){const{resolve,reject}=this.pending.get(m.id);this.pending.delete(m.id);if(m.error)reject(new Error(JSON.stringify(m.error)));else resolve(m.result)}})}send(method,params={}){const id=++this.id;return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params}))})}}
async function ev(cdp,expression){const r=await cdp.send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error("eval: "+JSON.stringify(r.exceptionDetails));return r.result.value}
async function clickAt(cdp,x,y){await cdp.send("Input.dispatchMouseEvent",{type:"mousePressed",x,y,button:"left",clickCount:1});await cdp.send("Input.dispatchMouseEvent",{type:"mouseReleased",x,y,button:"left",clickCount:1})}

async function main(){
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(),"dev-ae2a-fin-"));
  const chrome = spawn(CHROME,["--headless=new","--disable-gpu",`--remote-debugging-port=${DEBUG_PORT}`,`--user-data-dir=${userDataDir}`,"--window-size=1600,1000","--no-first-run","--no-default-browser-check","about:blank"],{stdio:"ignore"});
  try{
    let targets=null;
    for(let i=0;i<40;i++){try{targets=await getJSON(`http://127.0.0.1:${DEBUG_PORT}/json`);if(targets&&targets.length)break}catch{}await sleep(250)}
    const page=targets.find(t=>t.type==="page");
    const ws=new WebSocket(page.webSocketDebuggerUrl,{perMessageDeflate:false,maxPayload:256*1024*1024});
    await new Promise((res,rej)=>{ws.on("open",res);ws.on("error",rej)});
    const cdp=new CDP(ws);await cdp.send("Runtime.enable");await cdp.send("Page.enable");

    // seed safe settings BEFORE app boot
    await cdp.send("Page.navigate",{url:FRONTEND}); await sleep(3500);
    await ev(cdp, `localStorage.setItem('presetLoadSettings', ${JSON.stringify(JSON.stringify(SAFE))})`);
    await cdp.send("Page.navigate",{url:FRONTEND}); await sleep(8000);

    // open Preset gear, set path field (label "path:"), APPLY
    const gear = await ev(cdp, `(() => { const tiles=[...document.querySelectorAll('.mosaic-tile')]; const t=tiles.find(x=>/^Pre/.test(x.querySelector('.mosaic-window-title')?.textContent||'')); const ctrls=t.querySelector('.mosaic-window-controls'); const g=[...(ctrls?ctrls.querySelectorAll('button'):[])].find(b=>{const s=b.querySelector('svg');return s&&/Settings/i.test(s.getAttribute('data-testid')||'')}); if(g){const r=g.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}} return null; })()`);
    if(gear){ await clickAt(cdp, gear.x, gear.y); await sleep(1800); }
    const setPath = await ev(cdp, `(() => {
      const dlg=document.querySelector('[role=dialog]'); if(!dlg) return 'no-dialog';
      const inputs=[...dlg.querySelectorAll('input')];
      // the path field: the text input whose nearby label === 'path:'
      let target=null;
      for(const inp of inputs){ if(inp.type!=='text') continue; let p=inp.closest('div'); for(let up=0;up<4&&p;up++){ const t=(p.querySelector('label,span,p')?.textContent||'').trim(); if(/^path:?$/i.test(t)){target=inp;break;} p=p.parentElement;} if(target)break; }
      if(!target) return 'no-path-field';
      const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      setter.call(target, ${JSON.stringify(PRESET)});
      target.dispatchEvent(new Event('input',{bubbles:true}));
      target.dispatchEvent(new Event('change',{bubbles:true}));
      target.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Enter',code:'Enter'}));
      target.blur();
      return 'set path='+target.value;
    })()`);
    console.error("setPath:", setPath);
    await sleep(1000);
    const apply = await ev(cdp, `(() => { const dlg=document.querySelector('[role=dialog]')||document; const a=[...dlg.querySelectorAll('button')].find(b=>/^apply$/i.test((b.textContent||'').trim())&&!b.disabled); if(a){a.click();return 'apply';} return 'no-apply'; })()`);
    console.error("apply:", apply);
    await sleep(15000);

    const st = await ev(cdp, `(() => { const tiles=[...document.querySelectorAll('.mosaic-tile')]; const s=tiles.find(x=>/^Strings/.test(x.querySelector('.mosaic-window-title')?.textContent||'')); const vp=tiles.find(x=>/Virtual Piano/.test(x.querySelector('.mosaic-window-title')?.textContent||'')); return { strings:s?(s.querySelector('.mosaic-window-body').textContent||'').slice(0,45):'-', vpCanvas: vp?!!vp.querySelector('canvas'):false }; })()`);
    console.error("after apply:", JSON.stringify(st));

    // select a pitch (VP canvas)
    const vp = await ev(cdp, `(() => { const tiles=[...document.querySelectorAll('.mosaic-tile')]; const t=tiles.find(x=>/Virtual Piano/.test(x.querySelector('.mosaic-window-title')?.textContent||'')); if(!t)return null; const cv=t.querySelector('canvas'); if(!cv)return {hasCanvas:false}; const r=cv.getBoundingClientRect(); return {x:Math.round(r.left+r.width*0.25),y:Math.round(r.top+r.height*0.55),hasCanvas:true}; })()`);
    console.error("vp:", JSON.stringify(vp));
    if(vp&&vp.hasCanvas){ await clickAt(cdp,vp.x,vp.y); await sleep(2500); }

    // open a fixed workbench from a Strings param ROW (BarChart icon) + the panel-following toolbar (Timeline)
    const openFixed = await ev(cdp, `(() => { const tiles=[...document.querySelectorAll('.mosaic-tile')]; const stt=tiles.find(x=>/^Strings/.test(x.querySelector('.mosaic-window-title')?.textContent||'')); if(!stt)return 'no-strings'; const b=[...stt.querySelector('.mosaic-window-body').querySelectorAll('button')].find(x=>{const s=x.querySelector('svg');return s&&/BarChart/i.test(s.getAttribute('data-testid')||'')}); if(b){b.click();return 'fixed-opened';} return 'no-fixed-barchart-btn'; })()`);
    console.error("openFixed:", openFixed);
    await sleep(2000);
    const openPanel = await ev(cdp, `(() => { const tiles=[...document.querySelectorAll('.mosaic-tile')]; const stt=tiles.find(x=>/^Strings/.test(x.querySelector('.mosaic-window-title')?.textContent||'')); if(!stt)return 'no-strings'; const ctrls=stt.querySelector('.mosaic-window-controls'); const pf=[...(ctrls?ctrls.querySelectorAll('button'):[])].find(b=>/follow/i.test(b.getAttribute('title')||'')); if(pf){pf.click();return 'panel-opened';} return 'no-pf'; })()`);
    console.error("openPanel:", openPanel);
    await sleep(2500);

    // probe bars + icons
    const probe = await ev(cdp, `(() => {
      const tiles=[...document.querySelectorAll('.mosaic-tile')]; const wbs=[];
      for(const t of tiles){ const host=t.querySelector(':scope > .wb-accent-host'); if(!host) continue;
        const title=t.querySelector('.mosaic-window-title')?.textContent||'';
        const tb=t.querySelector('.mosaic-window-toolbar');
        const body=t.querySelector('.mosaic-window-body'); const canvases=body?[...body.querySelectorAll('canvas')]:[];
        const cr=canvases.length?canvases[0].getBoundingClientRect():null;
        wbs.push({ title, accentVar:host.style.getPropertyValue('--wb-accent'),
          toolbarBg: tb?getComputedStyle(tb).backgroundColor:null, toolbarBorderLeft: tb?getComputedStyle(tb).borderLeftColor+' '+getComputedStyle(tb).borderLeftWidth:null,
          canvasCount:canvases.length, firstCanvas:cr?{w:Math.round(cr.width),h:Math.round(cr.height)}:null }); }
      const stt=tiles.find(x=>/^Strings/.test(x.querySelector('.mosaic-window-title')?.textContent||''));
      const rowIcons = stt? [...stt.querySelector('.mosaic-window-body').querySelectorAll('button svg')].map(s=>s.getAttribute('data-testid')).filter(Boolean):[];
      const tbIcons = stt? [...(stt.querySelector('.mosaic-window-controls')?.querySelectorAll('button svg')||[])].map(s=>s.getAttribute('data-testid')).filter(Boolean):[];
      return { workbenches:wbs, stringsRowIcons:rowIcons, stringsToolbarIcons:tbIcons };
    })()`);
    console.log(JSON.stringify(probe,null,2));
    const shot=await cdp.send("Page.captureScreenshot",{format:"png"});
    fs.writeFileSync(`${OUT}-full.png`, Buffer.from(shot.data,"base64"));
    console.error("wrote", `${OUT}-full.png`);
    console.error("console tail:", cdp.console.slice(-6).join(" | "));
    ws.close();
  } finally { try{process.kill(chrome.pid)}catch{} }
}
main().catch(e=>{console.error("FATAL",e);process.exit(1)});
