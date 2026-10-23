// Shared by worker and compatibility mode. Frames never leave the device.
export const VISION_VERSION = '0.10.21';
const MODEL_ROOT = 'https://storage.googleapis.com/mediapipe-models';
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const finitePoint = p => p && Number.isFinite(p.x) && Number.isFinite(p.y);
const visiblePoint = p => finitePoint(p) && (p.visibility ?? 1) >= .5 && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;
function nearBox(point, box, margin = .04) {
  return finitePoint(point) && point.x >= box[0] - margin && point.x <= box[0] + box[2] + margin &&
    point.y >= box[1] - margin && point.y <= box[1] + box[3] + margin;
}
function eyeAspect(face, a, b, c, d, e, f) {
  return (distance(face[b], face[f]) + distance(face[c], face[e])) / Math.max(.001, 2 * distance(face[a], face[d]));
}
export function extractFocusSignals(faceResult, poseResult, handResult, objects, width, height) {
  const face = faceResult.faceLandmarks?.[0];
  const pose = poseResult.landmarks?.[0];
  const body = Boolean(pose && [11, 12].every(i => visiblePoint(pose[i])));
  const faceValid = Boolean(face && [1, 33, 133, 159, 145, 263, 362, 386, 374, 468, 473,
    160, 158, 153, 144, 385, 387, 373, 380].every(i => finitePoint(face[i])));
  const hands = (handResult.landmarks || []).flatMap(hand => hand.filter(finitePoint));
  const wrists = pose ? [15, 16].map(i => pose[i]).filter(visiblePoint) : [];
  const boxes = objects.filter(o => o.score >= .55).map(o => ({ ...o, box: [o.bbox[0] / width, o.bbox[1] / height, o.bbox[2] / width, o.bbox[3] / height] }));
  const head = faceValid ? face[1] : null;
  const eyeMid = faceValid ? { x: (face[33].x + face[263].x) / 2, y: (face[33].y + face[263].y) / 2 } : null;
  const headDown = faceValid && (head.y - eyeMid.y) / Math.max(.01, distance(face[33], face[263])) > .65;
  const phoneUse = boxes.some(o => o.class === 'cell phone' &&
    (hands.some(p => nearBox(p, o.box)) || wrists.some(p => nearBox(p, o.box, .07))) &&
    (headDown || (head && distance(head, { x: o.box[0] + o.box[2] / 2, y: o.box[1] + o.box[3] / 2 }) < .3)));
  const studyActivity = boxes.some(o => (o.class === 'book' && headDown) ||
    (o.class === 'laptop' && faceValid && !headDown && Math.abs(head.x - eyeMid.x) < .1) ||
    (o.class === 'book' && hands.some(p => nearBox(p, o.box))));
  const blends = Object.fromEntries((faceResult.faceBlendshapes?.[0]?.categories || []).map(c => [c.categoryName, c.score]));
  const eyesClosed = faceValid && ((eyeAspect(face, 33, 160, 158, 133, 153, 144) < .16 &&
    eyeAspect(face, 362, 385, 387, 263, 373, 380) < .16) || (blends.eyeBlinkLeft > .7 && blends.eyeBlinkRight > .7));
  const gaze = faceValid ? [
    (face[468].x - face[33].x) / Math.max(.001, Math.abs(face[133].x - face[33].x)),
    (face[473].x - face[362].x) / Math.max(.001, Math.abs(face[263].x - face[362].x)),
  ] : [];
  const eyeWidth = faceValid ? Math.max(.01, distance(face[33], face[263])) : 1;
  const headDirection = faceValid ? [(head.x - eyeMid.x) / eyeWidth, (head.y - eyeMid.y) / eyeWidth,
    Math.atan2(face[263].y - face[33].y, face[263].x - face[33].x)] : [];
  const verticalGaze = faceValid ? [
    (face[468].y - (face[159].y + face[145].y) / 2) / Math.max(.01, distance(face[33], face[133])),
    (face[473].y - (face[386].y + face[374].y) / 2) / Math.max(.01, distance(face[362], face[263])),
  ] : [];
  const activityVector = faceValid && wrists.length === 2 ?
    [head.x, head.y, ...gaze, ...wrists.flatMap(p => [p.x, p.y]), ...headDirection, ...verticalGaze] : null;
  return { reliable: true, face: faceValid, body, eyesClosed, phoneUse, studyActivity, activityVector };
}
export async function createCameraInference(vision, cocoSsd, tf, canvas) {
  const resources = [];
  try {
    const files = await vision.FilesetResolver.forVisionTasks(`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VERSION}/wasm`);
    const options = path => ({ ...(canvas ? { canvas } : {}), baseOptions: { modelAssetPath: `${MODEL_ROOT}/${path}`, delegate: 'CPU' }, runningMode: 'VIDEO' });
    const face = await vision.FaceLandmarker.createFromOptions(files, {
      ...options('face_landmarker/face_landmarker/float16/1/face_landmarker.task'), numFaces: 1,
      outputFaceBlendshapes: true, outputFacialTransformationMatrixes: false,
    });
    resources.push(face);
    const pose = await vision.PoseLandmarker.createFromOptions(files, {
      ...options('pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task'), numPoses: 1,
    });
    resources.push(pose);
    const hand = await vision.HandLandmarker.createFromOptions(files, {
      ...options('hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'), numHands: 2,
    });
    resources.push(hand);
    await tf.setBackend('cpu');
    await tf.ready();
    const objects = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
    resources.push(objects);
    const input = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(640, 480) : document.createElement('canvas');
    const context = input.getContext('2d', { willReadFrequently: true });
    let cachedObjects = [], objectTime = -Infinity;
    return {
      async detect(source, time) {
        const width = source.videoWidth || source.width, height = source.videoHeight || source.height;
        // ImageData is supported by TF.js fromPixels in workers and the main thread.
        if (time - objectTime >= 800) {
          input.width = width; input.height = height;
          context.drawImage(source, 0, 0, width, height);
          cachedObjects = await objects.detect(context.getImageData(0, 0, width, height), 12, .55);
          objectTime = time;
        }
        const faceResult = face.detectForVideo(source, time);
        const poseResult = pose.detectForVideo(source, time);
        const handResult = hand.detectForVideo(source, time);
        const points = faceResult.faceLandmarks[0];
        return { type: 'result', time, signals: extractFocusSignals(faceResult, poseResult, handResult, cachedObjects, width, height),
          landmarks: points ? [points[1], points[33], points[263]] : null };
      },
      close() { for (const model of resources) (model.close || model.dispose).call(model); },
    };
  } catch (error) {
    for (const model of resources) (model.close || model.dispose).call(model);
    throw error;
  }
}
let scripts;
export async function loadCameraInference(canvas) {
  const vision = await import(`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VERSION}/vision_bundle.mjs`);
  scripts ??= (async () => {
    for (const src of ['https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js',
      'https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js']) {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src; script.crossOrigin = 'anonymous'; script.onload = resolve;
        script.onerror = () => { script.remove(); reject(new Error(`Cannot load ${src}`)); };
        document.head.append(script);
      });
    }
  })().catch(error => { scripts = null; throw error; });
  await scripts;
  return createCameraInference(vision, globalThis.cocoSsd, globalThis.tf, canvas);
}
