// Keep browser/runtime selection separate from detection accuracy policy.
export const ORT_WASM_ROOT='https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';
export const ORT_WASM_SCRIPT=ORT_WASM_ROOT+'ort.wasm.min.js';
export function cameraRuntimeProfile(browser=globalThis.navigator) {
  const ios=/iPad|iPhone|iPod/.test(browser?.userAgent||'') || browser?.platform==='MacIntel'&&(browser?.maxTouchPoints||0)>1;
  return {ios,light:ios,lowMemory:ios,initializationMs:ios?120000:60000};
}
export function cameraInitializationDiagnostic(stage,message) {
  const phase=String(stage||'worker').replace(/^init:/,'');
  const phases={'vision-files':'VISION',face:'FACE',pose:'POSE',hand:'HAND',backend:'BACKEND',phone:'PHONE',identity:'IDENTITY',canvases:'CANVAS',tensorflow:'TF','vision-module':'VISIONJS','onnx-runtime':'ORT',profile:'PROFILE'};
  const text=String(message||'Worker stopped without an error message').replace(/[\r\n]+/g,' ').slice(0,240);
  const reason=/memory|allocat|out of bounds/i.test(text)?'MEMORY':/fetch|network|download|load failed|403|404/i.test(text)?'NETWORK':/webgl|canvas|document/i.test(text)?'CANVAS':/indexeddb|database|storage/i.test(text)?'STORAGE':'ERROR';
  return {build:'20261025-6',phase,code:`C6-${phases[phase]||'WORKER'}-${reason}`,message:text};
}
export function configureCameraOrt(ort) {
  // The general ort.min.js bundle pulls JSEP even for a CPU-only session, which
  // can exhaust WebKit's memory. Use the WASM-only bootstrap and matching files.
  ort.env.wasm.wasmPaths=ORT_WASM_ROOT;
  ort.env.wasm.numThreads=1;
  ort.env.wasm.proxy=false;
}
