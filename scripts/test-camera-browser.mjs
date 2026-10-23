// Hardware-free smoke: real CDN models and inference in worker AND compatibility mode.
// No login, camera access, remote writes or user data. Requires Playwright and Edge.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = createRequire('C:/Users/tntdr/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/x.js')('playwright')); }
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
  browser = await chromium.launch({ headless:true, channel:'msedge', args:[
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  ] });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const results = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width=640; canvas.height=480;
    const context=canvas.getContext('2d'); context.fillStyle='#888'; context.fillRect(0,0,640,480);
    const workerResult = await new Promise((resolve,reject) => {
      const worker = new Worker('./camera-worker.js?v=smoke');
      const timeout=setTimeout(()=>{worker.terminate();reject(new Error('Worker smoke timeout'));},120000);
      function finish(error,result){clearTimeout(timeout);worker.terminate();error?reject(error):resolve(result);}
      worker.onerror=error=>finish(new Error(error.message));
      worker.onmessage=async({data})=>{
        if(data.type==='error')finish(new Error(`${data.stage}: ${data.message}`));
        if(data.type==='ready'){
          const bitmap=await createImageBitmap(canvas);
          worker.postMessage({type:'frame',bitmap,time:performance.now()},[bitmap]);
        }
        if(data.type==='result')finish(null,data);
      };
      worker.postMessage({type:'init'});
    });
    const {loadCameraInference}=await import('/camera-inference.js?v=20261023-1');
    const engine=await loadCameraInference(document.createElement('canvas'));
    let mainResult;
    try { mainResult=await engine.detect(canvas,performance.now()); }
    finally { engine.close(); }
    return { worker:workerResult, main:mainResult };
  });
  for (const [mode,result] of Object.entries(results)) {
    assert.equal(result.type,'result'); assert.equal(result.signals.reliable,true);
    assert.equal(result.signals.face,false); assert.equal(result.signals.body,false);
    assert.equal(result.signals.phoneUse,false); assert.ok(Number.isFinite(result.time));
    console.log(`${mode}: real face/pose/hand/COCO models loaded; blank-scene inference passed`);
  }
  const controllerResult = await page.evaluate(async () => {
    const camera = await import('/camera.js?v=20261023-2');
    camera.openCameraFocus(document.querySelector('[data-camera-toggle]'));
    if (!await camera.startCamera()) throw new Error(camera.cameraState().message);
    try {
      const paused = await new Promise((resolve,reject) => {
        const timer=setTimeout(()=>{clearInterval(poll);reject(new Error('Controller absence timeout'));},90000);
        const poll=setInterval(()=>{
          const state=camera.cameraState();
          if(state.status==='error'){clearTimeout(timer);clearInterval(poll);reject(new Error(state.message));}
          if(state.reason==='away' && state.status==='paused'){
            clearTimeout(timer);clearInterval(poll);resolve(state);
          }
        },200);
      });
      const debugText=document.querySelector('[data-camera-debug]').textContent;
      return {paused,debugText,stopped: (camera.stopCamera(),camera.cameraState()),remainingVideos:document.querySelectorAll('video').length};
    } finally { camera.stopCamera(); }
  });
  assert.equal(controllerResult.paused.tracking,false);
  assert.equal(controllerResult.stopped.enabled,false);
  assert.equal(controllerResult.remainingVideos,0);
  assert.match(controllerResult.debugText,/자리 이탈.*즉시 정지.*경고 기준 도달/);
  console.log('controller: synthetic camera automatically paused for absence; stop released video and worker');
  for(const width of [390,1280]){
    await page.setViewportSize({width,height:900});
    const layout=await page.evaluate(async()=>{
      const {createFocusTracker}=await import('/camera-focus.js?v=20261023-2');
      const {paintCameraDebug}=await import('/camera-debug.js?v=20261023-1');
      const tracker=createFocusTracker();
      for(let t=0;t<=10000;t+=500)tracker.update({reliable:true,face:true,body:true,activityVector:[.5,.5,.5,.5,.3,.7,.7,.7]},t);
      const root=document.querySelector('.camera-focus [data-camera]');
      paintCameraDebug(root,tracker.getDebug(),{status:'tracking',tracking:true});
      const panel=root.querySelector('[data-camera-debug]'),rect=panel.getBoundingClientRect();
      return {left:rect.left,right:rect.right,viewport:innerWidth,overflow:panel.scrollWidth>panel.clientWidth,text:panel.textContent};
    });
    assert.ok(layout.left>=0 && layout.right<=layout.viewport,`debug panel outside viewport: ${width}`);
    assert.equal(layout.overflow,false);assert.match(layout.text,/정지까지 35.0초/);
    await page.locator('[data-camera-debug]').scrollIntoViewIfNeeded();
    await page.screenshot({path:resolve(root,`.codex-focus-debug-${width}.png`),fullPage:true});
    console.log(`debug UI ${width}px: countdown visible, no horizontal overflow`);
  }
} finally { await browser?.close(); await new Promise(resolve=>server.close(resolve)); }
