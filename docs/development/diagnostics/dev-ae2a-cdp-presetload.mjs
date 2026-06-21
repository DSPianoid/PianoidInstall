// dev-ae2a — drive the frontend's OWN preset load so availableNotes/workbench data
// populate: open the Preset pane settings gear, set the path field to the default
// preset, APPLY. Then select a pitch + open workbenches and screenshot/probe.
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
const DEBUG_PORT = Number(process.argv[3] || 9242);
const OUT = process.argv[2] || "dev-ae2a-presetload";
const PRESET = "presets/BaselinePreset1.json";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function getJSON(url){return new Promise((resolve,reject)=>{http.get(url,(res)=>{let d="";res.on("data",c=>d+=c);res.on("end",()=>{try{resolve(JSON.parse(d))}catch(e){reject(e)}})}).on("error",reject)})}
class CDP{constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();ws.on("message",raw=>{const m=JSON.parse(raw.toString());if(m.id&&this.pending.has(m.id)){const{resolve,reject}=this.pending.get(m.id);this.pending.delete(m.id);if(m.error)reject(new Error(JSON.stringify(m.error)));else resolve(m.result)}})}send(method,params={}){const id=++this.id;return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params}))})}}
async function ev(cdp,expression){const r=await cdp.send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error("eval: "+JSON.stringify(r.exceptionDetails));return r.result.value}
async function clickAt(cdp,x,y){await cdp.send("Input.dispatchMouseEvent",{type:"mousePressed",x,y,button:"left",clickCount:1});await cdp.send("Input.dispatchMouseEvent",{type:"mouseReleased",x,y,button:"left",clickCount:1})}

async function main(){
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(),"dev-ae2a-pl-"));
  const chrome = spawn(CHROME,["--headless=new","--disable-gpu",`--remote-debugging-port=${DEBUG_PORT}`,`--user-data-dir=${userDataDir}`,"--window-size=1600,1000","--no-first-run","--no-default-browser-check",FRONTEND],{stdio:"ignore"});
  try{
    let targets=null;
    for(let i=0;i<40;i++){try{targets=await getJSON(`http://127.0.0.1:${DEBUG_PORT}/json`);if(targets&&targets.length)break}catch{}await sleep(250)}
    const page=targets.find(t=>t.type==="page");
    const ws=new WebSocket(page.webSocketDebuggerUrl,{perMessageDeflate:false,maxPayload:256*1024*1024});
    await new Promise((res,rej)=>{ws.on("open",res);ws.on("error",rej)});
    const cdp=new CDP(ws);await cdp.send("Page.enable");await cdp.send("Runtime.enable");await sleep(6500);

    // 1) Open the Preset pane gear (portaled into its title-bar .mosaic-window-controls).
    const gear = await ev(cdp, `(() => {
      const tiles=[...document.querySelectorAll('.mosaic-tile')];
      const t=tiles.find(x=>/^Pre/.test(x.querySelector('.mosaic-window-title')?.textContent||''));
      if(!t) return 'no-preset-pane';
      const ctrls=t.querySelector('.mosaic-window-controls');
      const gearBtn=[...(ctrls?ctrls.querySelectorAll('button'):[])].find(b=>{
        const svg=b.querySelector('svg'); return svg && /Settings/i.test(svg.getAttribute('data-testid')||'');
      });
      if(gearBtn){ const r=gearBtn.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)}; }
      return 'no-gear';
    })()`);
    console.error("gear:", JSON.stringify(gear));
    if(gear && gear.x){ await clickAt(cdp, gear.x, gear.y); await sleep(1800); }

    // 2) In the open dialog, find the path text input and set it.
    const setPath = await ev(cdp, `(() => {
      const dlg=document.querySelector('[role=dialog]');
      if(!dlg) return 'no-dialog';
      const inputs=[...dlg.querySelectorAll('input')].filter(i=>i.type==='text'||!i.type||i.type==='');
      // the path field: value contains 'preset' or '.json', else the first text input
      let target = inputs.find(i=>/preset|\\.json|\\//.test(i.value||''));
      if(!target){
        // look for a labelled "path" field
        const labels=[...dlg.querySelectorAll('label,span,div')].filter(e=>/path/i.test(e.textContent||''));
        target = inputs[0];
      }
      if(!target) return 'no-input; inputs='+inputs.length;
      const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      setter.call(target, ${JSON.stringify(PRESET)});
      target.dispatchEvent(new Event('input',{bubbles:true}));
      target.dispatchEvent(new Event('change',{bubbles:true}));
      target.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Enter',code:'Enter'}));
      target.dispatchEvent(new KeyboardEvent('keyup',{bubbles:true,key:'Enter',code:'Enter'}));
      target.blur();
      return 'set value='+target.value;
    })()`);
    console.error("setPath:", setPath);
    await sleep(1200);

    // 3) Click APPLY inside the dialog (the ObjectInspector's Apply commits + closes).
    const apply = await ev(cdp, `(() => {
      const dlg=document.querySelector('[role=dialog]') || document;
      const apply=[...dlg.querySelectorAll('button')].find(b=>/^apply$/i.test((b.textContent||'').trim()));
      if(apply && !apply.disabled){ apply.click(); return 'apply-clicked'; }
      // fallback: footer Apply outside dialog
      const f=[...document.querySelectorAll('button')].find(b=>/^apply$/i.test((b.textContent||'').trim()) && !b.disabled);
      if(f){ f.click(); return 'footer-apply-clicked'; }
      return 'apply-not-available';
    })()`);
    console.error("apply:", apply);
    await sleep(14000); // engine (re)init + frontend sync

    // 4) Check populate + select a pitch.
    const st = await ev(cdp, `(() => {
      const tiles=[...document.querySelectorAll('.mosaic-tile')];
      const s=tiles.find(x=>/^Strings/.test(x.querySelector('.mosaic-window-title')?.textContent||''));
      const vp=tiles.find(x=>/Virtual Piano/.test(x.querySelector('.mosaic-window-title')?.textContent||''));
      return { strings: s?(s.querySelector('.mosaic-window-body').textContent||'').slice(0,50):'-', vpCanvas: vp?!!vp.querySelector('canvas'):false };
    })()`);
    console.error("after apply:", JSON.stringify(st));
    const vp = await ev(cdp, `(() => {
      const tiles=[...document.querySelectorAll('.mosaic-tile')];
      const t=tiles.find(x=>/Virtual Piano/.test(x.querySelector('.mosaic-window-title')?.textContent||''));
      if(!t) return null; const cv=t.querySelector('canvas'); const body=t.querySelector('.mosaic-window-body');
      const r=(cv||body).getBoundingClientRect();
      return { x:Math.round(r.left+r.width*0.2), y:Math.round(r.top+r.height*0.55), hasCanvas:!!cv };
    })()`);
    console.error("vp:", JSON.stringify(vp));
    if(vp&&vp.x&&vp.hasCanvas){ await clickAt(cdp,vp.x,vp.y); await sleep(2500); }

    // 5) Open a panel-following workbench from the Strings toolbar (the Timeline icon).
    const openPanel = await ev(cdp, `(() => {
      const tiles=[...document.querySelectorAll('.mosaic-tile')];
      const stt=tiles.find(x=>/^Strings/.test(x.querySelector('.mosaic-window-title')?.textContent||''));
      if(!stt) return 'no-strings';
      const ctrls=stt.querySelector('.mosaic-window-controls');
      const pf=[...(ctrls?ctrls.querySelectorAll('button'):[])].find(b=>/follow/i.test(b.getAttribute('title')||''));
      if(pf){ pf.click(); return 'panel-following-opened'; }
      return 'no-pf-btn';
    })()`);
    console.error("openPanel:", openPanel);
    await sleep(2500);

    // 6) Probe bars + icons + screenshot.
    const probe = await ev(cdp, `(() => {
      const tiles=[...document.querySelectorAll('.mosaic-tile')]; const wbs=[];
      for(const t of tiles){ const host=t.querySelector(':scope > .wb-accent-host'); if(!host) continue;
        const title=t.querySelector('.mosaic-window-title')?.textContent||'';
        const body=t.querySelector('.mosaic-window-body'); const canvases=body?[...body.querySelectorAll('canvas')]:[];
        const cr=canvases.length?canvases[0].getBoundingClientRect():null;
        wbs.push({ title, accentVar:host.style.getPropertyValue('--wb-accent'),
          toolbarBg: getComputedStyle(t.querySelector('.mosaic-window-toolbar')).backgroundColor,
          canvasCount:canvases.length, firstCanvas: cr?{w:Math.round(cr.width),h:Math.round(cr.height)}:null }); }
      const stt=tiles.find(x=>/^Strings/.test(x.querySelector('.mosaic-window-title')?.textContent||''));
      const rowIcons = stt? [...stt.querySelector('.mosaic-window-body').querySelectorAll('button svg')].map(s=>s.getAttribute('data-testid')).filter(Boolean).slice(0,10):[];
      const tbIcons = stt? [...(stt.querySelector('.mosaic-window-controls')?.querySelectorAll('button svg')||[])].map(s=>s.getAttribute('data-testid')).filter(Boolean):[];
      return { workbenches:wbs, stringsRowIcons:rowIcons, stringsToolbarIcons:tbIcons };
    })()`);
    console.log(JSON.stringify(probe,null,2));
    const shot=await cdp.send("Page.captureScreenshot",{format:"png"});
    fs.writeFileSync(`${OUT}-full.png`, Buffer.from(shot.data,"base64"));
    console.error("wrote", `${OUT}-full.png`);
    ws.close();
  } finally { try{process.kill(chrome.pid)}catch{} }
}
main().catch(e=>{console.error("FATAL",e);process.exit(1)});
