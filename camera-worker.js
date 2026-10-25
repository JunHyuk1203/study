// Classic worker required by MediaPipe's WASM loader.
let detector;
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      importScripts('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js');
      // TensorFlow is used for local face identity, separately from the phone detector.
      try {
        importScripts('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm@4.22.0/dist/tf-backend-wasm.js');
        self.tf.wasm.setWasmPaths('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm@4.22.0/dist/');
      } catch { /* CPU remains available inside this worker. */ }
      const vision = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/vision_bundle.mjs');
      const { createCameraInference } = await import('./camera-inference.js?v=20261025-4');
      importScripts('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.min.js');
      self.ort.env.wasm.wasmPaths='https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';
      self.ort.env.wasm.numThreads=1;
      const { createPhoneObjectDetector,PHONE_MODEL,PHONE_MODEL_ACCURATE } = await import('./camera-detector.js?v=20261025-4');
      const { createLocalFaceGuard } = await import('./camera-identity.js?v=20261024-19');
      detector = await createCameraInference(vision, {load:()=>createPhoneObjectDetector(self.ort,{model:data.light?PHONE_MODEL:PHONE_MODEL_ACCURATE})}, self.tf, undefined,
        { light: data.light, onPhoneObservation:message=>self.postMessage(message), identityFactory:()=>createLocalFaceGuard(self.tf,data.identityKey) });
      self.postMessage({ type: 'ready' });
    } else if (data.type === 'frame') {
      try {
        self.postMessage({ ...await detector.detect(data.bitmap, data.time, data.epoch, data.clockOrigin), epoch: data.epoch });
      } finally { data.bitmap.close(); }
    }
  } catch (error) { self.postMessage({ type: 'error', message: String(error?.message || error), stage: data.type, epoch: data.epoch }); }
};
