// dev-ae2a — inspect the live DOM to find the right selectors for (a) selecting a
// pitch and (b) opening a workbench from a parameter row, so the verify script can
// populate a workbench with real data.
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
const DEBUG_PORT = 9236;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function getJSON(url){return new Promise((resolve,reject)=>{http.get(url,(res)=>{let d="";res.on("data",c=>d+=c);res.on("end",()=>{try{resolve(JSON.parse(d))}catch(e){reject(e)}})}).on("error",reject)})}
class CDP{constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();ws.on("message",raw=>{const m=JSON.parse(raw.toString());if(m.id&&this.pending.has(m.id)){const{resolve,reject}=this.pending.get(m.id);this.pending.delete(m.id);if(m.error)reject(new Error(JSON.stringify(m.error)));else resolve(m.result)}})}send(method,params={}){const id=++this.id;return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params}))})}}
async function ev(cdp,expression){const r=await cdp.send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error("eval error: "+JSON.stringify(r.exceptionDetails));return r.result.value}

async function main(){
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(),"dev-ae2a-cdp3-"));
  const chrome = spawn(CHROME,["--headless=new","--disable-gpu",`--remote-debugging-port=${DEBUG_PORT}`,`--user-data-dir=${userDataDir}`,"--window-size=1600,1000","--no-first-run","--no-default-browser-check",FRONTEND],{stdio:"ignore"});
  try{
    let targets=null;
    for(let i=0;i<40;i++){try{targets=await getJSON(`http://127.0.0.1:${DEBUG_PORT}/json`);if(targets&&targets.length)break}catch{}await sleep(250)}
    const page=targets.find(t=>t.type==="page");
    const ws=new WebSocket(page.webSocketDebuggerUrl,{perMessageDeflate:false,maxPayload:256*1024*1024});
    await new Promise((res,rej)=>{ws.on("open",res);ws.on("error",rej)});
    const cdp=new CDP(ws);await cdp.send("Page.enable");await cdp.send("Runtime.enable");await sleep(6000);

    // (a) Virtual Piano internals
    const vp = await ev(cdp, `(() => {
      const tiles=[...document.querySelectorAll('.mosaic-tile')];
      const t=tiles.find(x=>/Virtual Piano/.test(x.querySelector('.mosaic-window-title')?.textContent||''));
      if(!t) return 'no-vp';
      const body=t.querySelector('.mosaic-window-body');
      const kids=[...body.children].map(c=>({tag:c.tagName,cls:(c.className||'').toString().slice(0,60),childCount:c.children.length}));
      const buttons=[...body.querySelectorAll('button')].slice(0,6).map(b=>({al:b.getAttribute('aria-label'),txt:(b.textContent||'').slice(0,20)}));
      const anyCanvas=body.querySelectorAll('canvas').length;
      const svg=body.querySelectorAll('svg').length;
      return { bodyHTMLhead: body.innerHTML.slice(0,400), kids, buttons, anyCanvas, svg };
    })()`);
    console.log("=== VIRTUAL PIANO ==="); console.log(JSON.stringify(vp,null,2));

    // (b) all buttons whose aria-label/title mention workbench (the open-workbench icon)
    const wbButtons = await ev(cdp, `(() => {
      const btns=[...document.querySelectorAll('button,[role=button]')];
      return btns.filter(b=>/workbench/i.test((b.getAttribute('aria-label')||'')+' '+(b.getAttribute('title')||''))).map(b=>({
        al:b.getAttribute('aria-label'), title:b.getAttribute('title'),
        inTitle: (b.closest('.mosaic-window-title')?'TITLEBAR':'') ,
        paneTitle: b.closest('.mosaic-tile')?.querySelector('.mosaic-window-title')?.textContent||''
      })).slice(0,30);
    })()`);
    console.log("=== WORKBENCH BUTTONS ==="); console.log(JSON.stringify(wbButtons,null,2));

    // (c) Strings pane content (does selecting a pitch require a working copy?)
    const strings = await ev(cdp, `(() => {
      const tiles=[...document.querySelectorAll('.mosaic-tile')];
      const t=tiles.find(x=>/^Strings/.test(x.querySelector('.mosaic-window-title')?.textContent||''));
      if(!t) return 'no-strings';
      const body=t.querySelector('.mosaic-window-body');
      return { textHead: (body.textContent||'').slice(0,200), buttons:[...body.querySelectorAll('button')].slice(0,10).map(b=>({al:b.getAttribute('aria-label'),txt:(b.textContent||'').slice(0,18)})) };
    })()`);
    console.log("=== STRINGS ==="); console.log(JSON.stringify(strings,null,2));

    // (d) Is a preset loaded / can we APPLY? Probe the Preset pane + APPLY button.
    const presetState = await ev(cdp, `(() => {
      const apply=[...document.querySelectorAll('button')].find(b=>/apply/i.test(b.textContent||''));
      return { applyDisabled: apply?apply.disabled:'no-apply-btn', curPresetText: (document.body.textContent.match(/CURRENT PRESET[\\s\\S]{0,60}/)||[''])[0] };
    })()`);
    console.log("=== PRESET ==="); console.log(JSON.stringify(presetState,null,2));

    ws.close();
  } finally { try{process.kill(chrome.pid)}catch{} }
}
main().catch(e=>{console.error("FATAL",e);process.exit(1)});
