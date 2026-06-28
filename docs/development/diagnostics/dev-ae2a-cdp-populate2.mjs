// dev-ae2a — definitive populated-workbench proof. Sets the Preset path field to the
// default preset (so APPLY enables), APPLYs (loads the preset → frontend syncs),
// selects a pitch, opens a FIXED workbench from a Strings param row, and screenshots
// + probes the workbench for a rendered barchart canvas + ruler. Real browser via CDP.
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
const DEBUG_PORT = 9238;
const OUT = process.argv[2] || "dev-ae2a-populated2";
const PRESET = "presets/BaselinePreset1.json";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function getJSON(url){return new Promise((resolve,reject)=>{http.get(url,(res)=>{let d="";res.on("data",c=>d+=c);res.on("end",()=>{try{resolve(JSON.parse(d))}catch(e){reject(e)}})}).on("error",reject)})}
class CDP{constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();ws.on("message",raw=>{const m=JSON.parse(raw.toString());if(m.id&&this.pending.has(m.id)){const{resolve,reject}=this.pending.get(m.id);this.pending.delete(m.id);if(m.error)reject(new Error(JSON.stringify(m.error)));else resolve(m.result)}})}send(method,params={}){const id=++this.id;return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params}))})}}
async function ev(cdp,expression){const r=await cdp.send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error("eval: "+JSON.stringify(r.exceptionDetails));return r.result.value}
async function clickAt(cdp,x,y){await cdp.send("Input.dispatchMouseEvent",{type:"mousePressed",x,y,button:"left",clickCount:1});await cdp.send("Input.dispatchMouseEvent",{type:"mouseReleased",x,y,button:"left",clickCount:1})}

async function main(){
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(),"dev-ae2a-cdp5-"));
  const chrome = spawn(CHROME,["--headless=new","--disable-gpu",`--remote-debugging-port=${DEBUG_PORT}`,`--user-data-dir=${userDataDir}`,"--window-size=1600,1000","--no-first-run","--no-default-browser-check",FRONTEND],{stdio:"ignore"});
  try{
    let targets=null;
    for(let i=0;i<40;i++){try{targets=await getJSON(`http://127.0.0.1:${DEBUG_PORT}/json`);if(targets&&targets.length)break}catch{}await sleep(250)}
    const page=targets.find(t=>t.type==="page");
    const ws=new WebSocket(page.webSocketDebuggerUrl,{perMessageDeflate:false,maxPayload:256*1024*1024});
    await new Promise((res,rej)=>{ws.on("open",res);ws.on("error",rej)});
    const cdp=new CDP(ws);await cdp.send("Page.enable");await cdp.send("Runtime.enable");await sleep(6000);

    // 1) Open the Preset pane gear (settings dialog hosts the path field), set path, APPLY.
    //    Open the Preset pane's settings gear (portaled into the title bar).
    const gear = await ev(cdp, `(() => {
      const tiles=[...document.querySelectorAll('.mosaic-tile')];
      const t=tiles.find(x=>/^Pre/.test(x.querySelector('.mosaic-window-title')?.textContent||'')) || tiles[0];
      const g=[...t.querySelectorAll('button')].find(b=>/setting/i.test(b.getAttribute('aria-label')||'') || /setting/i.test(b.getAttribute('title')||''));
      if(g){ g.click(); return 'gear-clicked'; }
      // fallback: title-bar control
      const tb=t.querySelector('.mosaic-window-controls button'); if(tb){tb.click(); return 'tb-clicked';}
      return 'no-gear';
    })()`);
    console.error("gear:", gear);
    await sleep(1500);

    // Set the path text input (the field showing presets/... or empty) via the native setter.
    const setPath = await ev(cdp, `(() => {
      const inputs=[...document.querySelectorAll('input[type=text], input:not([type])')];
      // pick the input whose value looks like a path or is in a dialog labelled path
      let target = inputs.find(i => /preset|\\.json|path/i.test(i.value||'') );
      if(!target){
        // any visible text input inside an open MUI dialog
        const dlg=document.querySelector('[role=dialog]');
        if(dlg) target=[...dlg.querySelectorAll('input[type=text], input:not([type])')][0];
      }
      if(!target) return 'no-input';
      const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      setter.call(target, ${JSON.stringify(PRESET)});
      target.dispatchEvent(new Event('input',{bubbles:true}));
      target.dispatchEvent(new Event('change',{bubbles:true}));
      // commit on Enter (NumInput/text commit on Enter/blur)
      target.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Enter'}));
      target.blur();
      return 'set:'+target.value;
    })()`);
    console.error("setPath:", setPath);
    await sleep(1200);

    // Close dialog (Escape) so APPLY footer is reachable, then click APPLY.
    await cdp.send("Input.dispatchKeyEvent",{type:"keyDown",key:"Escape"});
    await cdp.send("Input.dispatchKeyEvent",{type:"keyUp",key:"Escape"});
    await sleep(800);
    const applied = await ev(cdp, `(() => {
      const apply=[...document.querySelectorAll('button')].find(b=>/^apply$/i.test((b.textContent||'').trim()));
      if(apply && !apply.disabled){ apply.click(); return 'apply-clicked'; }
      return 'apply-disabled:'+(apply?apply.disabled:'missing');
    })()`);
    console.error("apply:", applied);
    await sleep(12000); // backend init + frontend sync (engine load)

    // 2) Select a pitch — click an "open workbench" BarChart button in Strings (binds data).
    //    First, does Strings now show params (not "Select a pitch")? Click the first
    //    param-row open-workbench IconButton if present. Else click VP.
    const afterLoad = await ev(cdp, `(() => {
      const tiles=[...document.querySelectorAll('.mosaic-tile')];
      const st=tiles.find(x=>/^Strings/.test(x.querySelector('.mosaic-window-title')?.textContent||''));
      const text = st? (st.querySelector('.mosaic-window-body').textContent||'').slice(0,80):'no-strings';
      return { stringsText: text };
    })()`);
    console.error("after load:", JSON.stringify(afterLoad));

    // try to select a pitch via VP key click
    const vp = await ev(cdp, `(() => {
      const tiles=[...document.querySelectorAll('.mosaic-tile')];
      const t=tiles.find(x=>/Virtual Piano/.test(x.querySelector('.mosaic-window-title')?.textContent||''));
      if(!t) return null; const body=t.querySelector('.mosaic-window-body');
      const r=body.getBoundingClientRect();
      return { x:Math.round(r.left+r.width*0.12), y:Math.round(r.top+r.height*0.5), bodyHead: body.innerHTML.slice(0,160) };
    })()`);
    console.error("vp:", JSON.stringify(vp));
    if(vp&&vp.x){ await clickAt(cdp,vp.x,vp.y); await sleep(2000); }

    // open a fixed workbench from a Strings param row (the BarChart icon), if any
    const openWb = await ev(cdp, `(() => {
      const tiles=[...document.querySelectorAll('.mosaic-tile')];
      const st=tiles.find(x=>/^Strings/.test(x.querySelector('.mosaic-window-title')?.textContent||''));
      if(!st) return 'no-strings';
      const btns=[...st.querySelectorAll('button')];
      const wb=btns.find(b=>/workbench|chart/i.test((b.getAttribute('aria-label')||'')));
      if(wb){ wb.click(); return 'opened:'+(wb.getAttribute('aria-label')); }
      return 'no-wb-button-in-strings; buttons='+JSON.stringify(btns.map(b=>b.getAttribute('aria-label')));
    })()`);
    console.error("openWb:", openWb);
    await sleep(2500);

    // 3) Probe + screenshot
    const probe = await ev(cdp, `(() => {
      const tiles=[...document.querySelectorAll('.mosaic-tile')]; const wbs=[];
      for(const t of tiles){ const host=t.querySelector(':scope > .wb-accent-host'); if(!host) continue;
        const title=t.querySelector('.mosaic-window-title')?.textContent||''; const win=t.querySelector('.mosaic-window');
        const body=win.querySelector('.mosaic-window-body'); const canvases=body?[...body.querySelectorAll('canvas')]:[];
        const br=body?body.getBoundingClientRect():null;
        wbs.push({ title, body:br?{w:Math.round(br.width),h:Math.round(br.height)}:null, canvasCount:canvases.length,
          canvasSizes:canvases.map(c=>{const r=c.getBoundingClientRect();return {w:Math.round(r.width),h:Math.round(r.height)}}),
          rulerLike: body? body.querySelectorAll('[class*=Rule],[class*=ruler],[class*=piano],[class*=axis],[class*=Axis],[class*=key]').length : 0 }); }
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
