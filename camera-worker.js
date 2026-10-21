// MediaPipe's WASM loader requires importScripts, which is unavailable in module workers.
importScripts('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/vision_bundle.js');
const { FilesetResolver, FaceLandmarker } = Vision;

let detector;
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      const files = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/wasm');
      detector = await FaceLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task', delegate: 'CPU' },
        runningMode: 'VIDEO', numFaces: 1,
        minFaceDetectionConfidence: 0.5, minFacePresenceConfidence: 0.5,
        outputFaceBlendshapes: false, outputFacialTransformationMatrixes: false,
      });
      self.postMessage({ type: 'ready' });
    } else if (data.type === 'frame') {
      try {
        const result = detector.detectForVideo(data.bitmap, data.time);
        self.postMessage({ type: 'result', present: result.faceLandmarks.length === 1, landmarks: result.faceLandmarks[0] ? [result.faceLandmarks[0][1], result.faceLandmarks[0][33], result.faceLandmarks[0][263]] : null });
      } finally { data.bitmap.close(); }
    }
  } catch (error) { self.postMessage({ type: 'error', message: String(error?.message || error), stage: data.type }); }
};
