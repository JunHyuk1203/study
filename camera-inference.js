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
  const boxes = objects.filter(o => o.score >= (o.class === 'cell phone' ? .2 : .55)).map(o => ({ ...o, box: [o.bbox[0] / width, o.bbox[1] / height, o.bbox[2] / width, o.bbox[3] / height] }));
  const head = faceValid ? face[1] : null;
  const eyeMid = faceValid ? { x: (face[33].x + face[263].x) / 2, y: (face[33].y + face[263].y) / 2 } : null;
  const headDown = faceValid && (head.y - eyeMid.y) / Math.max(.01, distance(face[33], face[263])) > .65;
  const phones = boxes.filter(o => o.class === 'cell phone').map(o => {
    const center = { x: o.box[0] + o.box[2] / 2, y: o.box[1] + o.box[3] / 2 };
    const touching = hands.some(p => nearBox(p, o.box, .08)) || wrists.some(p => nearBox(p, o.box, .1));
    const upright = o.box[3] >= .18 && o.box[3] > o.box[2]*1.15 && center.x > .1 && center.x < .9;
    const raised = upright || (head ? center.y < Math.min(.8, head.y + .28) && Math.abs(center.x - head.x) < .45 :
      center.y < .7 && center.x > .1 && center.x < .9);
    const used = o.score >= .3 && (touching || o.score >= .45 && raised);
    return { score: o.score, touching, raised, used };
  });
  const phoneUse = phones.some(o => o.used);
  const bestPhone = phones.filter(o => o.used).sort((a,b) => b.score-a.score)[0] || phones.sort((a,b) => b.score-a.score)[0];
  const phoneEvidence = bestPhone ? { ...bestPhone, stage: bestPhone.used ? 'using' : bestPhone.score < .3 ? 'weak' : 'desk' } :
    { score: 0, stage: 'not-found' };
  const studyContext = boxes.some(o => (o.class === 'book' && headDown) ||
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
  const activityVector = faceValid ? [head.x, head.y, ...gaze, ...headDirection, ...verticalGaze] : null;
  const studyPoints = [pose?.[15], pose?.[16], ...(handResult.landmarks || []).map(hand => hand[8])].map(p =>
    visiblePoint(p) ? { x: p.x, y: p.y } : null);
  return { reliable: true, face: faceValid, body, eyesClosed, phoneUse, phoneEvidence,
    studyActivity: false, studyContext, studyPoints, activityVector };
}

export function createStudyMotionTracker() {
  let reference = null, referenceTime = null, lastMotion = -Infinity;
  return {
    update(context, points, now) {
      if (!context) { reference = null; referenceTime = null; lastMotion = -Infinity; return false; }
      if (reference) {
        const moving = points.some((point, i) => point && reference[i] && distance(point, reference[i]) > .025);
        if (moving) { lastMotion = now; reference = points; referenceTime = now; }
      }
      if (referenceTime === null || now-referenceTime > 1500) { reference = points; referenceTime = now; }
      return now-lastMotion <= 1000;
    },
  };
}

export function phoneSearchRegion(poseResult, handResult) {
  let points = (handResult.landmarks || []).flat().filter(visiblePoint);
  if (!points.length) points = [poseResult.landmarks?.[0]?.[15], poseResult.landmarks?.[0]?.[16]].filter(visiblePoint);
  if (!points.length) return { x: .225, y: .2, width: .55, height: .65 };
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const width = Math.min(.7, Math.max(.28, maxX - minX + .2));
  const height = Math.min(.7, Math.max(.32, maxY - minY + .22));
  return { x: Math.max(0, Math.min(1-width, (minX+maxX-width)/2)),
    y: Math.max(0, Math.min(1-height, (minY+maxY-height)/2)), width, height };
}
export async function createCameraInference(vision, cocoSsd, tf, canvas, { light = false } = {}) {
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
    let accelerated = false;
    if (tf.wasm) {
      try { accelerated = await tf.setBackend('wasm'); } catch { /* Worker-only CPU fallback. */ }
    }
    if (!accelerated) await tf.setBackend('cpu');
    await tf.ready();
    const objects = await cocoSsd.load({ base: light ? 'lite_mobilenet_v2' : 'mobilenet_v2' });
    resources.push(objects);
    const input = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(640, 480) : document.createElement('canvas');
    const context = input.getContext('2d', { willReadFrequently: true });
    let cachedObjects = [], objectTime = -Infinity, phones = [], phoneTime = -Infinity;
    const studyMotion = createStudyMotionTracker();
    return {
      async detect(source, time) {
        const startedAt = performance.now();
        const width = source.videoWidth || source.width, height = source.videoHeight || source.height;
        const faceResult = face.detectForVideo(source, time);
        const poseResult = pose.detectForVideo(source, time);
        const handResult = hand.detectForVideo(source, time);
        // ImageData is supported by TF.js fromPixels in workers and the main thread.
        if (time - objectTime >= 800) {
          input.width = width; input.height = height;
          context.drawImage(source, 0, 0, width, height);
          cachedObjects = await objects.detect(context.getImageData(0, 0, width, height), 30, .2);
          if (!cachedObjects.some(o => o.class === 'cell phone' && o.score >= .3)) {
            const region = phoneSearchRegion(poseResult, handResult);
            input.width = Math.max(1, Math.round(region.width*width)); input.height = Math.max(1, Math.round(region.height*height));
            context.drawImage(source, region.x*width, region.y*height, region.width*width, region.height*height, 0, 0, input.width, input.height);
            const zoomed = await objects.detect(context.getImageData(0, 0, input.width, input.height), 30, .2);
            cachedObjects.push(...zoomed.filter(o => o.class === 'cell phone').map(o => ({...o,
              bbox: [region.x*width + o.bbox[0]*region.width*width/input.width,
                region.y*height + o.bbox[1]*region.height*height/input.height,
                o.bbox[2]*region.width*width/input.width, o.bbox[3]*region.height*height/input.height]})));
          }
          const foundPhones = cachedObjects.filter(o => o.class === 'cell phone' && o.score >= .3);
          if (foundPhones.length) { phones = foundPhones; phoneTime = time; }
          else if (time-phoneTime < 1500) cachedObjects.push(...phones);
          objectTime = time;
        }
        const points = faceResult.faceLandmarks[0];
        const signals = extractFocusSignals(faceResult, poseResult, handResult, cachedObjects, width, height);
        signals.studyActivity = studyMotion.update(signals.studyContext, signals.studyPoints, time);
        delete signals.studyPoints;
        return { type: 'result', time, signals, backend: tf.getBackend(), mode: light ? 'light' : 'standard', inferenceMs: performance.now()-startedAt,
          landmarks: points ? [points[1], points[33], points[263]] : null };
      },
      close() { for (const model of resources) (model.close || model.dispose).call(model); },
    };
  } catch (error) {
    for (const model of resources) (model.close || model.dispose).call(model);
    throw error;
  }
}
