import test from 'node:test';
import assert from 'node:assert/strict';
import {cameraRuntimeProfile,cameraInitializationDiagnostic,configureCameraOrt,ORT_WASM_ROOT,ORT_WASM_SCRIPT} from '../camera-runtime.js';
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
test('initialization failures retain the failing model and distinguish network, storage and canvas errors',()=>{
  assert.equal(cameraInitializationDiagnostic('init:phone','Failed to fetch model').code,'C6-PHONE-NETWORK');
  assert.equal(cameraInitializationDiagnostic('init:identity','IndexedDB database unavailable').code,'C6-IDENTITY-STORAGE');
  assert.equal(cameraInitializationDiagnostic('init:face','WebGL canvas context unavailable').code,'C6-FACE-CANVAS');
});
test('iOS low-memory initialization preserves face identity and phone detection without loading three auxiliary graphs',async()=>{
  const previous=globalThis.OffscreenCanvas;let faces=0,identityCreated=0,engine;
  globalThis.OffscreenCanvas=class{getContext(){return {drawImage(){},getImageData(){return {};}};}};
  const stages=[];
  try{
    engine=await createCameraInference({FilesetResolver:{forVisionTasks:async()=>({})},
      FaceLandmarker:{createFromOptions:async()=>{faces++;return {detectForVideo:()=>({faceLandmarks:[]}),close(){}};}},
      PoseLandmarker:{createFromOptions:async()=>{throw Error('pose must not be allocated');}},HandLandmarker:{createFromOptions:async()=>{throw Error('hand must not be allocated');}}},
      {load:async()=>({detect:async()=>[],dispose(){}})},{setBackend:async()=>true,ready:async()=>{},getBackend:()=> 'cpu'},undefined,
      {lowMemory:true,onStage:s=>stages.push(s),identityFactory:async()=>{identityCreated++;return {check:async()=>({enrolled:false,matched:false}),close(){}};}});
    const result=await engine.detect({width:100,height:100},0);
    assert.equal(faces,1);assert.equal(identityCreated,1);assert.equal(result.signals.body,false);
    assert.equal(result.modelMs.pose,0);assert.equal(result.modelMs.hand,0);
    assert.ok(stages.includes('phone'));assert.ok(stages.includes('identity'));
  }finally{engine?.close();await new Promise(resolve=>setTimeout(resolve,0));if(previous===undefined)delete globalThis.OffscreenCanvas;else globalThis.OffscreenCanvas=previous;}
});
