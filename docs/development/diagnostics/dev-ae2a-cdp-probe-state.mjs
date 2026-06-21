// dev-ae2a — probe the live frontend's actual data state + console errors to find
// why workbenches won't populate. Reads /get_available_notes directly from the page,
// dumps console errors, and inspects the VP/Strings DOM more deeply.
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
const DEBUG_PORT = Number(process.argv[2] || 9244);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function getJSON(url){return new Promise((resolve,reject)=>{http.get(url,(res)=>{let d="";res.on("data",c=>d+=c);res.on("end",()=>{try{resolve(JSON.parse(d))}catch(e){reject(e)}})}).on("error",reject)})}
class CDP{constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();this.console=[];ws.on("message",raw=>{const m=JSON.parse(raw.toString());if(m.method==='Runtime.consoleAPICalled'){this.console.push((m.params.type||'')+': '+(m.params.args||[]).map(a=>a.value||a.description||'').join(' ').slice(0,160))}if(m.method==='Runtime.exceptionThrown'){this.console.push('EXC: '+(m.params.exceptionDetails?.exception?.description||'').slice(0,200))}if(m.id&&this.pending.has(m.id)){const{resolve,reject}=this.pending.get(m.id);this.pending.delete(m.id);if(m.error)reject(new Error(JSON.stringify(m.error)));else resolve(m.result)}})}send(method,params={}){const id=++this.id;return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params}))})}}
async function ev(cdp,expression){const r=await cdp.send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error("eval: "+JSON.stringify(r.exceptionDetails));return r.result.value}

async function main(){
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(),"dev-ae2a-ps-"));
  const chrome = spawn(CHROME,["--headless=new","--disable-gpu",`--remote-debugging-port=${DEBUG_PORT}`,`--user-data-dir=${userDataDir}`,"--window-size=1600,1000","--no-first-run","--no-default-browser-check",FRONTEND],{stdio:"ignore"});
  try{
    let targets=null;
    for(let i=0;i<40;i++){try{targets=await getJSON(`http://127.0.0.1:${DEBUG_PORT}/json`);if(targets&&targets.length)break}catch{}await sleep(250)}
    const page=targets.find(t=>t.type==="page");
    const ws=new WebSocket(page.webSocketDebuggerUrl,{perMessageDeflate:false,maxPayload:256*1024*1024});
    await new Promise((res,rej)=>{ws.on("open",res);ws.on("error",rej)});
    const cdp=new CDP(ws);await cdp.send("Runtime.enable");await cdp.send("Page.enable");await sleep(7000);

    // direct backend reachability from the page
    const notes = await ev(cdp, `(async () => {
      try { const r=await fetch('http://127.0.0.1:5000/get_available_notes'); const j=await r.json(); return {ok:r.ok, type:Array.isArray(j)?'array['+j.length+']':typeof j, sample: Array.isArray(j)?j.slice(0,5):j }; }
      catch(e){ return 'fetch-err:'+e.message } })()`);
    console.log("GET /get_available_notes from page:", JSON.stringify(notes));

    const health = await ev(cdp, `(async () => { try { const r=await fetch('http://127.0.0.1:5000/health'); const j=await r.json(); return {notes:j.available_notes_count, running:j.backend_thread_running}; } catch(e){return 'err:'+e.message} })()`);
    console.log("health from page:", JSON.stringify(health));

    // DOM deep dump of Strings + VP
    const dom = await ev(cdp, `(() => {
      const tiles=[...document.querySelectorAll('.mosaic-tile')];
      const s=tiles.find(x=>/^Strings/.test(x.querySelector('.mosaic-window-title')?.textContent||''));
      const vp=tiles.find(x=>/Virtual Piano/.test(x.querySelector('.mosaic-window-title')?.textContent||''));
      return {
        stringsHTML: s? s.querySelector('.mosaic-window-body').innerHTML.slice(0,600):'-',
        vpHTML: vp? vp.querySelector('.mosaic-window-body').innerHTML.slice(0,600):'-',
        currentPresetText: (document.body.textContent.match(/CURRENT PRESET[\\s\\S]{0,40}/)||[''])[0].replace(/\\s+/g,' '),
      };
    })()`);
    console.log("=== Strings body ===\\n"+dom.stringsHTML);
    console.log("=== VP body ===\\n"+dom.vpHTML);
    console.log("=== current preset ===\\n"+dom.currentPresetText);

    console.log("=== console (last 25) ===");
    console.log(cdp.console.slice(-25).join("\\n"));
    ws.close();
  } finally { try{process.kill(chrome.pid)}catch{} }
}
main().catch(e=>{console.error("FATAL",e);process.exit(1)});
