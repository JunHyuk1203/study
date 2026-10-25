// Hardware-free smoke: real CDN models in standard and light workers. Never infer on the UI thread.
// No login, camera access, remote writes or user data. Requires Playwright and Edge.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
let chromium,webkit;
try { ({ chromium,webkit } = require('playwright')); }
catch { ({ chromium,webkit } = createRequire('C:/Users/tntdr/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/x.js')('playwright')); }
const testWebKit=process.argv.includes('--webkit'),iosProfile=testWebKit||process.argv.includes('--ios-profile');
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path === '/') {
      const study=await readFile(resolve(root,'study.html'),'utf8');
      const camera=study.match(/<section id="study-camera"[\s\S]*?<\/section>/)[0];
      const template=study.match(/<template id="camera-focus-template">[\s\S]*?<\/template>/)[0];
      response.setHeader('Content-Type','text/html; charset=utf-8');
      response.end(`<!doctype html><html lang="ko"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles.css"><title>Camera model smoke</title><div class="app"><main>${camera}</main></div>${template}</html>`); return;
    }
    const file = resolve(root, '.' + decodeURIComponent(path));
    if (!file.startsWith(root + sep) || !['.js','.css'].includes(extname(file))) { response.writeHead(404).end(); return; }
    response.setHeader('Content-Type', extname(file)==='.css'?'text/css':'text/javascript'); response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = testWebKit?await webkit.launch({headless:true}):await chromium.launch({ headless:true, channel:'msedge', args:[
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  ] });
  const page = await browser.newPage(iosProfile?{userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',viewport:{width:390,height:844},isMobile:true,hasTouch:true}:{});
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  console.log('Browser capabilities: '+JSON.stringify(await page.evaluate(async()=>{
    const script=new Blob(["self.postMessage({canvas:typeof OffscreenCanvas,bitmap:typeof createImageBitmap,webgl:typeof WebGL2RenderingContext})"],{type:'text/javascript'});
    const url=URL.createObjectURL(script),worker=new Worker(url);
    try{return {pageCanvas:typeof OffscreenCanvas,worker:await new Promise((resolve,reject)=>{worker.onmessage=e=>resolve(e.data);worker.onerror=e=>reject(Error(e.message));})};}
    finally{worker.terminate();URL.revokeObjectURL(url);}
  })));
  if(process.argv.includes('--diagnostic-ui-only')){
    await page.setViewportSize({width:390,height:844});
    const result=await page.evaluate(async()=>{
      const {paintCameraDebug}=await import('/camera-debug.js');
      const root=document.createElement('section');document.querySelector('main').append(root);
      paintCameraDebug(root,{engine:{build:'20261025-6',code:'C6-IDENTITY-STORAGE',phase:'identity',message:'IndexedDB database unavailable'}},{status:'error',tracking:false});
      const panel=root.querySelector('[data-camera-debug]'),note=panel.querySelector('.cam-debug-note');
      return {text:note.textContent,overflow:panel.scrollWidth>panel.clientWidth,selectable:getComputedStyle(note).userSelect};
    });
    assert.match(result.text,/C6-IDENTITY-STORAGE/);assert.match(result.text,/IndexedDB/);
    assert.equal(result.overflow,false);assert.equal(result.selectable,'text');
    console.log('iPhone-width error diagnostics: readable stage code and raw message, selectable text, no overflow');
  }else if(process.argv.includes('--runtime-only')){
    const result=await page.evaluate(()=>new Promise((resolve,reject)=>{
      const worker=new Worker('/scripts/camera-runtime-smoke-worker.js');
      const timeout=setTimeout(()=>{worker.terminate();reject(Error('WASM runtime smoke timeout'));},120000);
      worker.onmessage=({data})=>{clearTimeout(timeout);worker.terminate();data.type==='error'?reject(Error(data.message)):resolve(data);};
      worker.onerror=e=>{clearTimeout(timeout);worker.terminate();reject(Error(e.message));};
      worker.postMessage({type:'run'});
    }));
    assert.equal(result.model,'yolov10n');assert.deepEqual(result.dims,[1,300,6]);
    assert.match(result.bootstrap,/ort\.wasm\.min\.js$/);
    console.log(`CPU-only ONNX runtime: ${JSON.stringify(result)}; this probe does not test MediaPipe or an actual iPhone`);
  }else{
  const results = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width=640; canvas.height=480;
    const context=canvas.getContext('2d'); context.fillStyle='#888'; context.fillRect(0,0,640,480);
    let maxTickGap=0,previousTick=performance.now();
    const monitor=setInterval(()=>{const now=performance.now();maxTickGap=Math.max(maxTickGap,now-previousTick);previousTick=now;},50);
    async function infer(light){return new Promise((resolve,reject) => {
      const worker = new Worker('./camera-worker.js?v=smoke');
      let faceResult,phoneObservation;
      const timeout=setTimeout(()=>{worker.terminate();reject(new Error('Worker smoke timeout'));},120000);
      function finish(error,result){clearTimeout(timeout);worker.terminate();error?reject(error):resolve(result);}
      worker.onerror=error=>finish(new Error(error.message));
      worker.onmessage=async({data})=>{
        if(data.type==='error')finish(new Error(`${data.stage}: ${data.message}\n${data.detail||''}`));
        if(data.type==='ready'){
          const capturedAt=performance.now();
          const bitmap=await createImageBitmap(canvas);
          worker.postMessage({type:'frame',bitmap,time:capturedAt,clockOrigin:performance.timeOrigin},[bitmap]);
        }
        if(data.type==='result')faceResult=data;
        if(data.type==='phone-observation')phoneObservation=data.observation;
        if(faceResult&&phoneObservation)finish(null,{...faceResult,phoneObservation});
      };
      worker.postMessage({type:'init',light});
    });}
    try{return {worker:await infer(false),light:await infer(true)};}
    finally{clearInterval(monitor);window.cameraMaxTickGap=maxTickGap;}
  });
  for (const [mode,result] of Object.entries(results)) {
    assert.equal(result.type,'result'); assert.equal(result.signals.reliable,true);
    assert.equal(result.signals.face,false); assert.equal(result.signals.body,false);
    assert.equal(result.signals.phoneUse,false); assert.ok(Number.isFinite(result.time));
    assert.equal(result.backend,'wasm');
    assert.equal(result.phoneObservation.status,'ok');
    assert.equal(result.phoneObservation.observedAt,result.time);
    assert.ok(result.phoneObservation.completedAt>=result.phoneObservation.observedAt);
    assert.equal(result.phoneObservation.model,iosProfile||mode==='light'?'yolov10n':'yolov10s');
    if(iosProfile){assert.equal(result.modelMs.pose,0);assert.equal(result.modelMs.hand,0);}
    console.log(`${mode}: real face/pose/hand/YOLO models loaded; WASM inference ${Math.round(result.inferenceMs)}ms`);
  }
  const tickGap=await page.evaluate(()=>window.cameraMaxTickGap);
  assert.ok(tickGap<500,`UI thread stalled for ${tickGap.toFixed(0)}ms during worker inference`);
  console.log(`UI timer during both worker modes: maximum gap ${tickGap.toFixed(0)}ms`);
  if(process.argv.includes('--phone-fixture')||process.argv.includes('--hand-fixture')){
    // Mictlancihuatl / TheEgdeLord, CC BY-SA 4.0. Remote references; no images are bundled.
    // https://commons.wikimedia.org/wiki/File:Hand_holding_Smartphone.jpg
    // https://commons.wikimedia.org/wiki/File:Teenager_using_mobile_phone.jpg
    const challenging=process.argv.includes('--occluded-phone-fixture');
    const negative=process.argv.includes('--hand-fixture');
    const source=negative?'https://upload.wikimedia.org/wikipedia/commons/b/b5/Hand_in_closed_fist_black_background.jpg':challenging?'https://upload.wikimedia.org/wikipedia/commons/e/eb/Teenager_using_mobile_phone.jpg':
      'https://upload.wikimedia.org/wikipedia/commons/0/0b/Hand_holding_Smartphone.jpg';
    const phone=await page.evaluate(async({source,sequence})=>{
      const photo=new Image();photo.crossOrigin='anonymous';
      photo.src=source;
      await photo.decode();
      photo.dataset.phoneFixture='';photo.style.cssText='position:fixed;inset:0;width:100vw;height:100vh;object-fit:contain;background:white;z-index:999';document.body.append(photo);
      return new Promise((resolve,reject)=>{
        const worker=new Worker('/camera-worker.js?v=phone-smoke');
        const trace=[],samples=sequence?12:1;
        async function send(){
          const scale=Math.min(640/photo.naturalWidth,480/photo.naturalHeight);
          const capturedAt=performance.now();
          const bitmap=await createImageBitmap(photo,{resizeWidth:Math.round(photo.naturalWidth*scale),resizeHeight:Math.round(photo.naturalHeight*scale)});
          worker.postMessage({type:'frame',bitmap,time:capturedAt,clockOrigin:performance.timeOrigin},[bitmap]);
        }
        const timeout=setTimeout(()=>{worker.terminate();reject(new Error('Phone fixture timeout'));},120000);
        function finish(error,result){clearTimeout(timeout);worker.terminate();error?reject(error):resolve(result);}
        worker.onerror=error=>finish(new Error(error.message));
        worker.onmessage=async({data})=>{
          if(data.type==='error')finish(new Error(data.message));
          if(data.type==='ready')await send();
          if(data.type==='phone-observation'){
            if(data.observation.status!=='ok')finish(new Error('Phone object inference failed'));
            else {
              trace.push({region:data.observation.region.key,score:Math.max(0,...data.observation.candidates.map(c=>c.score)),latency:Math.round(data.observation.completedAt-data.observation.observedAt),state:data.state?.status});
              if(trace.length<samples)setTimeout(()=>void send().catch(error=>finish(error)),450);
              else finish(null,{score:Math.max(...trace.map(r=>r.score)),confirmed:trace.some(r=>r.state==='confirmed'),trace});
            }
          }
        };
        worker.postMessage({type:'init'});
      });
    },{source,sequence:process.argv.includes('--phone-sequence')});
    console.log('public '+(negative?'empty-hand':'phone')+' fixture evidence: '+JSON.stringify(phone));
    await page.screenshot({path:resolve(root,'.codex-phone-reference.png')});
    await page.locator('[data-phone-fixture]').evaluate(image=>image.remove());
    if(negative){assert.equal(phone.confirmed,false,'An empty hand must not confirm a phone');assert.ok(phone.score<.55,'An empty hand must not produce strong phone evidence');}
    else if(challenging && phone.score<.55) console.log('Known model limitation: small, mostly occluded phone remains undetected; UI exposes not-found evidence.');
    else {
      assert.ok(phone.score>=.55,'The real phone model did not detect the reference phone');
      if(process.argv.includes('--phone-sequence'))assert.equal(phone.confirmed,true,'Repeated real-model phone results must confirm the same phone');
    }
  }
  if(!process.argv.includes('--models-only')){
  const controllerResult = await page.evaluate(async () => {
    const camera = await import('/camera.js?v=20261023-6');
    camera.openCameraFocus(document.querySelector('[data-camera-toggle]'));
    if (!await camera.startCamera()) throw new Error(camera.cameraState().message);
    try {
      // A synthetic camera cannot enroll an owner. Require safe enrollment waiting,
      // rather than expecting the absence policy reserved for an enrolled session.
      const paused = await new Promise((resolve,reject) => {
        const timer=setTimeout(()=>{clearInterval(poll);reject(new Error('Controller enrollment timeout'));},90000);
        const poll=setInterval(()=>{
          const state=camera.cameraState();
          if(state.status==='error'){clearTimeout(timer);clearInterval(poll);reject(new Error(state.message));}
          if(state.reason==='identity' && state.status==='scanning' && document.querySelector('[data-camera-debug]')?.textContent.includes('얼굴 등록 중')){
            clearTimeout(timer);clearInterval(poll);resolve(state);
          }
        },200);
      });
      const debugText=document.querySelector('[data-camera-debug]').textContent;
      const originalHidden=Object.getOwnPropertyDescriptor(document,'hidden');
      let background=true;
      Object.defineProperty(document,'hidden',{configurable:true,get:()=>background});
      try{
        document.dispatchEvent(new Event('visibilitychange'));
        document.querySelector('video').pause();
        await new Promise(resolve=>setTimeout(resolve,300));
        background=false;document.dispatchEvent(new Event('visibilitychange'));
        await new Promise((resolve,reject)=>{
          const timeout=setTimeout(()=>{clearInterval(poll);reject(new Error('Camera did not recover after visibility return'));},15000);
          const poll=setInterval(()=>{const state=camera.cameraState();if(state.reason==='identity' && state.status==='scanning'){
            clearInterval(poll);clearTimeout(timeout);resolve();
          }},100);
        });
      }finally{if(originalHidden)Object.defineProperty(document,'hidden',originalHidden);else delete document.hidden;}
      return {paused,debugText,recovered:true,stopped: (camera.stopCamera(),camera.cameraState()),remainingVideos:document.querySelectorAll('video').length};
    } finally { camera.stopCamera(); }
  });
  assert.equal(controllerResult.paused.tracking,false);
  assert.equal(controllerResult.stopped.enabled,false);
  assert.equal(controllerResult.remainingVideos,0);
  assert.equal(controllerResult.recovered,true);
  assert.match(controllerResult.debugText,/얼굴 등록 중/);
  console.log('controller: safe enrollment waiting, background return/video restart, and stop cleanup passed');
  for(const width of [390,1280]){
    await page.setViewportSize({width,height:900});
    const layout=await page.evaluate(async()=>{
      const {createFocusTracker}=await import('/camera-focus.js?v=20261023-6');
      const {paintCameraDebug}=await import('/camera-debug.js?v=20261023-3');
      const tracker=createFocusTracker();
      for(let t=0;t<=10000;t+=500)tracker.update({reliable:true,face:true,body:false,activityVector:[.5,.5,.5,.5,0,.4,0,0,0]},t);
      const root=document.querySelector('.camera-focus [data-camera]');
      paintCameraDebug(root,tracker.getDebug(),{status:'tracking',tracking:true});
      const panel=root.querySelector('[data-camera-debug]'),rect=panel.getBoundingClientRect();
      return {left:rect.left,right:rect.right,viewport:innerWidth,overflow:panel.scrollWidth>panel.clientWidth,text:panel.textContent};
    });
    assert.ok(layout.left>=0 && layout.right<=layout.viewport,`debug panel outside viewport: ${width}`);
    assert.equal(layout.overflow,false);assert.match(layout.text,/경고·정지까지 5.0초/);
    await page.locator('[data-camera-debug]').scrollIntoViewIfNeeded();
    await page.screenshot({path:resolve(root,`.codex-focus-debug-${width}.png`),fullPage:true});
    console.log(`debug UI ${width}px: countdown visible, no horizontal overflow`);
  }
  }
  }
} finally { await browser?.close(); await new Promise(resolve=>server.close(resolve)); }
