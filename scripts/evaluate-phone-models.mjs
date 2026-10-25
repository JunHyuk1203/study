import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
let chromium;
try{({chromium}=require('playwright'));}catch{({chromium}=createRequire('C:/Users/tntdr/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/x.js')('playwright'));}
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const server=createServer(async(req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  if(path==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Phone model comparison</title>');return;}
  const file=resolve(root,'.'+decodeURIComponent(path));
  if(!file.startsWith(root+sep)||extname(file)!=='.js'){res.writeHead(404).end();return;}
  try{res.setHeader('Content-Type','text/javascript');res.end(await readFile(file));}catch{res.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try{
  browser=await chromium.launch({headless:true,channel:'msedge'});
  const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);
  const occludedOnly=process.argv.includes('--occluded-only');
  const results=await page.evaluate(async({pipeline,occludedOnly})=>{
    const worker=new Worker(pipeline?'/camera-worker.js':'/scripts/phone-evaluation-worker.js');
    const message=()=>new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(Error('Phone model evaluation timeout')),180000);
      worker.onmessage=({data})=>{
        if(pipeline&&data.type==='result')return;
        clearTimeout(timeout);data.type==='error'?reject(Error(data.message)):resolve(data);
      };
      worker.onerror=e=>{clearTimeout(timeout);reject(Error(e.message));};
    });
    try{
      let pending=message();worker.postMessage({type:'init'});await pending;
      const fixtures=[
        {name:'phone-clear',url:'https://upload.wikimedia.org/wikipedia/commons/0/0b/Hand_holding_Smartphone.jpg',expected:true},
        {name:'phone-occluded',url:'https://upload.wikimedia.org/wikipedia/commons/e/eb/Teenager_using_mobile_phone.jpg',expected:true},
        {name:'closed-fist',url:'https://upload.wikimedia.org/wikipedia/commons/b/b5/Hand_in_closed_fist_black_background.jpg',expected:false},
        {name:'rock-hand',url:'https://upload.wikimedia.org/wikipedia/commons/7/7e/Rock-paper-scissors_%28rock%29.png',expected:false},
        {name:'open-palm',url:'https://upload.wikimedia.org/wikipedia/commons/a/af/Rock-paper-scissors_%28paper%29.png',expected:false},
      ];
      const rows=[];let epoch=0;
      for(const fixture of fixtures){
        if(occludedOnly&&!fixture.name.includes('occluded'))continue;
        const image=new Image();image.crossOrigin='anonymous';image.src=fixture.url;await image.decode();
        for(const scale of [1,.55]){
          const canvas=document.createElement('canvas');canvas.width=640;canvas.height=480;
          const ctx=canvas.getContext('2d');ctx.fillStyle='#aaa';ctx.fillRect(0,0,640,480);
          const ratio=Math.min(640/image.width,480/image.height)*scale,w=image.width*ratio,h=image.height*ratio;
          ctx.drawImage(image,(640-w)/2,(480-h)/2,w,h);
          epoch++;
          const trace=[];
          for(let frame=0;frame<(pipeline?8:1);frame++){
            if(frame)await new Promise(resolve=>setTimeout(resolve,450));
            const capturedAt=performance.now(),bitmap=await createImageBitmap(canvas);pending=message();worker.postMessage({type:'frame',bitmap,name:`${fixture.name}-${scale}`,time:capturedAt,clockOrigin:performance.timeOrigin,epoch},[bitmap]);
            const result=await pending;
            if(pipeline)trace.push({region:result.observation.region.key,score:Math.max(0,...result.observation.candidates.map(c=>c.score)),state:result.state.status,latency:Math.round(result.observation.completedAt-result.observation.observedAt)});
            else rows.push({...result,expected:fixture.expected});
          }
          if(pipeline)rows.push({name:`${fixture.name}-${scale}`,expected:fixture.expected,confirmed:trace.some(r=>r.state==='confirmed'),trace});
        }
      }
      return rows;
    }finally{worker.terminate();}
  },{pipeline:process.argv.includes('--pipeline'),occludedOnly});
  const reportPath=resolve(root,occludedOnly?'.codex-phone-pipeline-occluded-evaluation.json':process.argv.includes('--pipeline')?'.codex-phone-pipeline-evaluation.json':'.codex-phone-model-evaluation.json');
  await writeFile(reportPath,JSON.stringify(results,null,2));
  for(const row of results)console.log(JSON.stringify(row.result?{name:row.name,expected:row.expected,result:Object.fromEntries(Object.entries(row.result).map(([key,value])=>[key,{ms:value.ms,score:Math.max(0,...value.phones.map(p=>p.score))}]))}:row));
  console.log('Full results: '+reportPath);
  if(process.argv.includes('--pipeline')){
    for(const row of results){
      if(!row.expected)assert.equal(row.confirmed,false,`${row.name}: false phone pause`);
      if(row.name.startsWith('phone-clear'))assert.equal(row.confirmed,true,`${row.name}: visible phone missed`);
    }
  }
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
