// Classic worker required by MediaPipe's WASM loader.
let detector;
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      importScripts('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js',
        'https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js');
      const vision = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/vision_bundle.mjs');
      const { createCameraInference } = await import('./camera-inference.js?v=20261023-1');
      detector = await createCameraInference(vision, self.cocoSsd, self.tf);
      self.postMessage({ type: 'ready' });
    } else if (data.type === 'frame') {
      try {
        self.postMessage(await detector.detect(data.bitmap, data.time));
      } finally { data.bitmap.close(); }
    }
  } catch (error) { self.postMessage({ type: 'error', message: String(error?.message || error), stage: data.type }); }
};
