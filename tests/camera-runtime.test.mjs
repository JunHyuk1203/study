import test from 'node:test';
import assert from 'node:assert/strict';
import {cameraRuntimeProfile,configureCameraOrt,ORT_WASM_ROOT,ORT_WASM_SCRIPT} from '../camera-runtime.js';
import {createCameraInference} from '../camera-inference.js';
test('iPhone Safari and iOS Chrome start with the small model before allocating an accurate model',()=>{
  for(const userAgent of ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile Safari/604.1','Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) CriOS/130.0 Mobile/15E148 Safari/604.1']){
    const p=cameraRuntimeProfile({userAgent,platform:'iPhone',maxTouchPoints:5});
    assert.equal(p.ios,true);assert.equal(p.light,true);assert.equal(p.initializationMs,120000);
  }
});
test('iPadOS desktop-style user agent selects the low-memory profile without classifying a Mac as iOS',()=>{
  assert.equal(cameraRuntimeProfile({userAgent:'Macintosh',platform:'MacIntel',maxTouchPoints:5}).ios,true);
  assert.equal(cameraRuntimeProfile({userAgent:'Macintosh',platform:'MacIntel',maxTouchPoints:0}).ios,false);
  assert.equal(cameraRuntimeProfile({userAgent:'Windows',platform:'Win32'}).initializationMs,60000);
});
test('CPU-only ONNX bootstrap matches the pinned WASM files and does not spawn nested worker proxies',()=>{
  const ort={env:{wasm:{}}};configureCameraOrt(ort);
  assert.equal(ORT_WASM_SCRIPT,ORT_WASM_ROOT+'ort.wasm.min.js');
  assert.equal(ort.env.wasm.wasmPaths,ORT_WASM_ROOT);assert.equal(ort.env.wasm.numThreads,1);assert.equal(ort.env.wasm.proxy,false);
});
test('Safari MediaPipe models receive distinct explicit Worker canvases without accessing document',async()=>{
  const previous=globalThis.OffscreenCanvas,canvases=[];
  class Canvas{getContext(){return {};}}
  globalThis.OffscreenCanvas=Canvas;
  const createFromOptions=async(_files,options)=>{assert.ok(options.canvas instanceof Canvas);canvases.push(options.canvas);return {close(){}};};
  let engine;
  try{
    engine=await createCameraInference({FilesetResolver:{forVisionTasks:async()=>({})},FaceLandmarker:{createFromOptions},PoseLandmarker:{createFromOptions},HandLandmarker:{createFromOptions}},
      {load:async()=>({dispose(){}})},{setBackend:async()=>true,ready:async()=>{}});
    assert.equal(canvases.length,3);assert.equal(new Set(canvases).size,3);
  }finally{engine?.close();if(previous===undefined)delete globalThis.OffscreenCanvas;else globalThis.OffscreenCanvas=previous;}
});
