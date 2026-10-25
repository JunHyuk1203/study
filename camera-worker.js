// Classic worker required by MediaPipe's WASM loader.
let detector;
self.onmessage = async ({ data }) => {
  let stage=data.type;
  try {
    if (data.type === 'init') {
      stage='init:profile';
      const {cameraRuntimeProfile,configureCameraOrt,ORT_WASM_SCRIPT}=await import('./camera-runtime.js?v=20261025-5');
      const profile=cameraRuntimeProfile(self.navigator),light=Boolean(data.light||profile.light);
      if(typeof OffscreenCanvas!=='function')throw Object.assign(new Error('Worker canvas is unavailable'),{code:'unsupported-canvas'});
      stage='init:tensorflow';
      importScripts('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js');
      // TensorFlow is used for local face identity, separately from the phone detector.
      try {
        importScripts('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm@4.22.0/dist/tf-backend-wasm.js');
        self.tf.wasm.setWasmPaths('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm@4.22.0/dist/');
      } catch { /* CPU remains available inside this worker. */ }
      stage='init:vision-module';
      const vision = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/vision_bundle.mjs');
      const { createCameraInference } = await import('./camera-inference.js?v=20261025-5');
      stage='init:onnx-runtime';
      importScripts(ORT_WASM_SCRIPT);
      configureCameraOrt(self.ort);
      const { createPhoneObjectDetector,PHONE_MODEL,PHONE_MODEL_ACCURATE } = await import('./camera-detector.js?v=20261025-5');
      const { createLocalFaceGuard } = await import('./camera-identity.js?v=20261024-19');
      stage='init:models';
      detector = await createCameraInference(vision, {load:()=>createPhoneObjectDetector(self.ort,{model:light?PHONE_MODEL:PHONE_MODEL_ACCURATE})}, self.tf, undefined,
        { light, onPhoneObservation:message=>self.postMessage(message), identityFactory:()=>createLocalFaceGuard(self.tf,data.identityKey) });
      self.postMessage({ type: 'ready' });
    } else if (data.type === 'frame') {
      try {
        self.postMessage({ ...await detector.detect(data.bitmap, data.time, data.epoch, data.clockOrigin), epoch: data.epoch });
      } finally { data.bitmap.close(); }
    }
  } catch (error) { self.postMessage({ type: 'error', message: String(error?.message || error), detail:String(error?.stack||''), code:error?.code, stage, epoch: data.epoch }); }
};
