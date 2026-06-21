// dev-ae2a — open the Preset pane settings dialog and dump every field (label + value)
// so we can target the PATH field precisely.
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
const DEBUG_PORT = Number(process.argv[2] || 9246);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function getJSON(url){return new Promise((resolve,reject)=>{http.get(url,(res)=>{let d="";res.on("data",c=>d+=c);res.on("end",()=>{try{resolve(JSON.parse(d))}catch(e){reject(e)}})}).on("error",reject)})}
class CDP{constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();ws.on("message",raw=>{const m=JSON.parse(raw.toString());if(m.id&&this.pending.has(m.id)){const{resolve,reject}=this.pending.get(m.id);this.pending.delete(m.id);if(m.error)reject(new Error(JSON.stringify(m.error)));else resolve(m.result)}})}send(method,params={}){const id=++this.id;return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params}))})}}
async function ev(cdp,expression){const r=await cdp.send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error("eval: "+JSON.stringify(r.exceptionDetails));return r.result.value}
async function clickAt(cdp,x,y){await cdp.send("Input.dispatchMouseEvent",{type:"mousePressed",x,y,button:"left",clickCount:1});await cdp.send("Input.dispatchMouseEvent",{type:"mouseReleased",x,y,button:"left",clickCount:1})}

async function main(){
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(),"dev-ae2a-dlg-"));
  const chrome = spawn(CHROME,["--headless=new","--disable-gpu",`--remote-debugging-port=${DEBUG_PORT}`,`--user-data-dir=${userDataDir}`,"--window-size=1600,1000","--no-first-run","--no-default-browser-check",FRONTEND],{stdio:"ignore"});
  try{
    let targets=null;
    for(let i=0;i<40;i++){try{targets=await getJSON(`http://127.0.0.1:${DEBUG_PORT}/json`);if(targets&&targets.length)break}catch{}await sleep(250)}
    const page=targets.find(t=>t.type==="page");
    const ws=new WebSocket(page.webSocketDebuggerUrl,{perMessageDeflate:false,maxPayload:256*1024*1024});
    await new Promise((res,rej)=>{ws.on("open",res);ws.on("error",rej)});
    const cdp=new CDP(ws);await cdp.send("Runtime.enable");await cdp.send("Page.enable");await sleep(7000);

    const gear = await ev(cdp, `(() => {
      const tiles=[...document.querySelectorAll('.mosaic-tile')];
      const t=tiles.find(x=>/^Pre/.test(x.querySelector('.mosaic-window-title')?.textContent||''));
      const ctrls=t.querySelector('.mosaic-window-controls');
      const g=[...(ctrls?ctrls.querySelectorAll('button'):[])].find(b=>{const s=b.querySelector('svg');return s&&/Settings/i.test(s.getAttribute('data-testid')||'')});
      if(g){const r=g.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}}
      return null;
    })()`);
    console.log("gear:", JSON.stringify(gear));
    if(gear){ await clickAt(cdp, gear.x, gear.y); await sleep(1800); }

    const fields = await ev(cdp, `(() => {
      const dlg=document.querySelector('[role=dialog]');
      if(!dlg) return 'no-dialog';
      // Each row: a label + an input. Dump rows.
      const rows=[];
      const inputs=[...dlg.querySelectorAll('input')];
      inputs.forEach((inp,i)=>{
        // find a nearby label text
        let label='';
        let p=inp.closest('div');
        for(let up=0; up<4 && p; up++){ const t=(p.querySelector('label,span,p')?.textContent||'').trim(); if(t){label=t;break;} p=p.parentElement; }
        rows.push({ i, type:inp.type, value:(inp.value||'').slice(0,30), label: label.slice(0,40) });
      });
      const selects=[...dlg.querySelectorAll('[role=combobox], select')].map((s,i)=>({i, text:(s.textContent||'').slice(0,30)}));
      return { inputs: rows, selects, dialogText: (dlg.textContent||'').slice(0,300) };
    })()`);
    console.log(JSON.stringify(fields,null,2));
    ws.close();
  } finally { try{process.kill(chrome.pid)}catch{} }
}
main().catch(e=>{console.error("FATAL",e);process.exit(1)});
