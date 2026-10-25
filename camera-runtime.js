// Keep browser/runtime selection separate from detection accuracy policy.
export const ORT_WASM_ROOT='https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';
export const ORT_WASM_SCRIPT=ORT_WASM_ROOT+'ort.wasm.min.js';
export function cameraRuntimeProfile(browser=globalThis.navigator) {
  const ios=/iPad|iPhone|iPod/.test(browser?.userAgent||'') || browser?.platform==='MacIntel'&&(browser?.maxTouchPoints||0)>1;
  return {ios,light:ios,initializationMs:ios?120000:60000};
}
export function configureCameraOrt(ort) {
  // The general ort.min.js bundle pulls JSEP even for a CPU-only session, which
  // can exhaust WebKit's memory. Use the WASM-only bootstrap and matching files.
  ort.env.wasm.wasmPaths=ORT_WASM_ROOT;
  ort.env.wasm.numThreads=1;
  ort.env.wasm.proxy=false;
}
