// Classic worker required by MediaPipe's WASM loader.
let detector;
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      importScripts('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js');
      // WASM SIMD accelerates COCO without sharing the UI thread. Registration can fail independently.
      try {
        importScripts('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm@4.22.0/dist/tf-backend-wasm.js');
        self.tf.wasm.setWasmPaths('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm@4.22.0/dist/');
      } catch { /* CPU remains available inside this worker. */ }
      const vision = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/vision_bundle.mjs');
      const { createCameraInference } = await import('./camera-inference.js?v=20261025-8');
      const { createStudyObjectDetector } = await import('./camera-objects.js?v=20261024-11');
      const { createLocalFaceGuard } = await import('./camera-identity.js?v=20261024-19');
      detector = await createCameraInference(vision, {load:options=>createStudyObjectDetector(self.tf,options)}, self.tf, undefined,
        { light: data.light, phoneRedesign:data.phoneRedesign!==false, onPhoneObservation:message=>self.postMessage(message), identityFactory:()=>createLocalFaceGuard(self.tf,data.identityKey) });
      self.postMessage({ type: 'ready' });
    } else if (data.type === 'frame') {
      try {
        self.postMessage({ ...await detector.detect(data.bitmap, data.time, data.epoch), epoch: data.epoch });
      } finally { data.bitmap.close(); }
    }
  } catch (error) { self.postMessage({ type: 'error', message: String(error?.message || error), stage: data.type, epoch: data.epoch }); }
};
