// Shared by worker and compatibility mode. Frames never leave the device.
import { faceBounds, faceSearchRegion, restoreFaceCoordinates, sameFace } from './camera-framing.js';
import { createPhoneTracker, createPhoneScheduler, PHONE_LIMITS } from './camera-phone.js?v=20261025-6';
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
function eyeGaze(face, left, right, iris) {
  const dx=face[right].x-face[left].x, dy=face[right].y-face[left].y;
  const size=Math.max(.000001,dx*dx+dy*dy);
  const x=face[iris].x-face[left].x, y=face[iris].y-face[left].y;
  return [(x*dx+y*dy)/size,(y*dx-x*dy)/size];
}
export function extractFocusSignals(faceResult, poseResult, handResult, objects, width, height) {
  const face = faceResult.faceLandmarks?.[0];
  const aspect = width > 0 && height > 0 ? width/height : 1;
  const geometry = face?.map(p=>finitePoint(p)?{...p,x:p.x*aspect}:p);
  const pose = poseResult.landmarks?.[0];
  const body = Boolean(pose && [11, 12].every(i => visiblePoint(pose[i])));
  const faceValid = Boolean(face && [1, 33, 263].every(i => finitePoint(face[i])) && distance(face[33],face[263]) > .01);
  const eyesValid = faceValid && [133,362,160,158,153,144,385,387,373,380].every(i => finitePoint(face[i]));
  const irisValid = faceValid && [133,362,468,473].every(i => finitePoint(face[i]));
  const hands = (handResult.landmarks || []).flatMap(hand => hand.filter(finitePoint));
  const phoneThreshold=o=>o.model?.startsWith('yolov10')?PHONE_LIMITS.create:.2;
  const boxes = objects.filter(o => o.score >= (o.class === 'cell phone' ? phoneThreshold(o) : .55)).map(o => ({ ...o, box: [o.bbox[0] / width, o.bbox[1] / height, o.bbox[2] / width, o.bbox[3] / height] }));
  const head = faceValid ? face[1] : null;
  const eyeMid = faceValid ? { x: (face[33].x + face[263].x) / 2, y: (face[33].y + face[263].y) / 2 } : null;
  const headDown = faceValid && (head.y - eyeMid.y) / Math.max(.01, distance(geometry[33], geometry[263])) > .65;
  const phones = objects.filter(o => o.class === 'cell phone' && Number.isFinite(o.score))
    .map(o => ({ score: o.score, used: o.score >= phoneThreshold(o) }));
  const phoneUse = phones.some(o => o.used);
  const bestPhone = phones.filter(o => o.used).sort((a,b) => b.score-a.score)[0] || phones.sort((a,b) => b.score-a.score)[0];
  const phoneEvidence = bestPhone ? { ...bestPhone, stage: bestPhone.used ? 'using' : 'weak' } :
    { score: 0, stage: 'not-found' };
  const studyContext = boxes.some(o => (o.class === 'book' && headDown) ||
    (o.class === 'laptop' && faceValid && !headDown && Math.abs(head.x - eyeMid.x) < .1) ||
    (o.class === 'book' && hands.some(p => nearBox(p, o.box))));
  const blends = Object.fromEntries((faceResult.faceBlendshapes?.[0]?.categories || []).map(c => [c.categoryName, c.score]));
  // A light smile can narrow both eyes; reserve geometry-based closure for a
  // more complete squint. Strong bilateral blink blendshapes still catch closure.
  const eyesClosed = faceValid && ((eyesValid && eyeAspect(geometry, 33, 160, 158, 133, 153, 144) < .12 &&
    eyeAspect(geometry, 362, 385, 387, 263, 373, 380) < .12) || (blends.eyeBlinkLeft > .7 && blends.eyeBlinkRight > .7));
  // Project each iris onto its own eye axis so head roll is not eye movement.
  const leftGaze=irisValid?eyeGaze(geometry,33,133,468):[.5,0];
  const rightGaze=irisValid?eyeGaze(geometry,362,263,473):[.5,0];
  const gaze=[leftGaze[0],rightGaze[0]];
  const gazeValid=Boolean(irisValid && eyesValid && !eyesClosed &&
    [leftGaze,rightGaze].every(([x,y])=>x>=-.2 && x<=1.2 && Math.abs(y)<=.5));
  const eyeWidth = faceValid ? Math.max(.01, distance(geometry[33], geometry[263])) : 1;
  const headDirection = faceValid ? [(head.x - eyeMid.x)*aspect / eyeWidth, (head.y - eyeMid.y) / eyeWidth,
    Math.atan2(face[263].y - face[33].y, (face[263].x - face[33].x)*aspect)] : [];
  const verticalGaze = [leftGaze[1],rightGaze[1]];
  const activityVector = faceValid ? [head.x, head.y, ...gaze, ...headDirection, ...verticalGaze] : null;
  const studyPoints = [pose?.[15], pose?.[16], ...(handResult.landmarks || []).map(hand => hand[8])].map(p =>
    visiblePoint(p) ? { x: p.x, y: p.y } : null);
  return { reliable: true, face: faceValid, body, eyesClosed, gazeValid, phoneUse, phoneEvidence,
    studyActivity: false, studyContext, studyPoints, activityVector };
}

export function createFaceContinuity(holdMs = 3000) {
  let points = null, missingSince = null, lastUpdate = null;
  return {
    update(result, time) {
      const face=result.faceLandmarks?.[0];
      if (lastUpdate !== null && (time<lastUpdate || time-lastUpdate>holdMs)) points=null;
      lastUpdate=time;
      if (face && [1,33,263].every(i=>finitePoint(face[i])) && distance(face[33],face[263])>.01) {
        points=[face[1],face[33],face[263]].map(p=>({x:p.x,y:p.y,z:p.z}));missingSince=null;
      } else missingSince??=time;
      return missingSince === null || time-missingSince<holdMs ? points : null;
    },
  };
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
export function phoneSearchRegions(poseResult, handResult, scan = 0) {
  // Separate hands must not turn a close-up into another nearly full-frame view.
  const hands = (handResult.landmarks || []).filter(hand => hand.some(visiblePoint));
  const wrists = [poseResult.landmarks?.[0]?.[15], poseResult.landmarks?.[0]?.[16]].filter(visiblePoint);
  const targets = hands.length ? hands : wrists.map(point => [point]);
  const regions = targets.map(hand => phoneSearchRegion({ landmarks: [] }, { landmarks: [hand] }));
  // Sweep overlapping quadrants when fewer than two hands are visible.
  const corner = scan % 4;
  const sweep = { x: corner % 2 ? .4 : 0, y: corner >= 2 ? .4 : 0, width: .6, height: .6 };
  return regions.length > 1 ? regions.slice(0, 2) :
    [regions[0] || phoneSearchRegion(poseResult, handResult), sweep];
}
export async function createCameraInference(vision, cocoSsd, tf, canvas, { light = false, lowMemory = false, onStage = () => {}, identityFactory, onPhoneObservation, phoneRedesign = true } = {}) {
  const resources = [];
  try {
    onStage('vision-files');
    const files = await vision.FilesetResolver.forVisionTasks(`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VERSION}/wasm`);
    // MediaPipe's Safari auto-canvas branch uses document even in a Worker.
    // Supplying a canvas bypasses that branch; each model gets its own canvas.
    const options = path => ({ ...(canvas ? { canvas } : typeof OffscreenCanvas==='function' ? {canvas:new OffscreenCanvas(1,1)} : {}), baseOptions: { modelAssetPath: `${MODEL_ROOT}/${path}`, delegate: 'CPU' }, runningMode: 'VIDEO' });
    onStage('face');
    const face = await vision.FaceLandmarker.createFromOptions(files, {
      ...options('face_landmarker/face_landmarker/float16/1/face_landmarker.task'), numFaces: 2,
      minFaceDetectionConfidence: .25, minFacePresenceConfidence: .25, minTrackingConfidence: .25,
      outputFaceBlendshapes: true, outputFacialTransformationMatrixes: false,
    });
    resources.push(face);
    const empty=()=>({landmarks:[]});
    if(!lowMemory)onStage('pose');
    const pose = lowMemory ? {detectForVideo:empty,close(){}} : await vision.PoseLandmarker.createFromOptions(files, {
      ...options('pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task'), numPoses: 1,
    });
    resources.push(pose);
    if(!lowMemory)onStage('hand');
    const hand = lowMemory ? {detectForVideo:empty,close(){}} : await vision.HandLandmarker.createFromOptions(files, {
      ...options('hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'), numHands: 2,
    });
    resources.push(hand);
    onStage('backend');
    let accelerated = false;
    if (tf.wasm) {
      try { accelerated = await tf.setBackend('wasm'); } catch { /* Worker-only CPU fallback. */ }
    }
    if (!accelerated) await tf.setBackend('cpu');
    await tf.ready();
    onStage('phone');
    const objects = await cocoSsd.load({ base: light ? 'lite_mobilenet_v2' : 'mobilenet_v2' });
    resources.push(objects);
    onStage('identity');
    const identity=identityFactory?await identityFactory():null;
    if(identity)resources.push(identity);
    onStage('canvases');
    const input = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(640, 480) : document.createElement('canvas');
    const context = input.getContext('2d', { willReadFrequently: true });
    let cachedObjects = [], objectTime = -Infinity, observedAt=-Infinity, observationId=0, deliveredId=0, phoneScan=0;
    let phoneTracker=createPhoneTracker(), phoneScheduler=createPhoneScheduler(), phoneEpoch=null, latestPhone=null,phoneLagCount=0;
    let objectPending=null,objectEpoch=null,closed=false,objectWidth=1,objectHeight=1,poseTime=-Infinity,handTime=-Infinity,poseResult={landmarks:[]},handResult={landmarks:[]};
    const modelMs={face:0,pose:0,hand:0,objects:0};
    const studyMotion = createStudyMotionTracker();
    const faceContinuity = createFaceContinuity();
    const faceInput = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(512, 512) : document.createElement('canvas');
    faceInput.width = faceInput.height = 512;
    const faceContext = faceInput.getContext('2d');
    let closeup = null, lastBounds = null, lastFaceTime = -Infinity, scan = 0;
    return {
      async detect(source, time, epoch = 0, clockOrigin) {
        const startedAt = performance.now();
        if(phoneEpoch!==epoch){phoneEpoch=epoch;phoneTracker=createPhoneTracker();phoneScheduler=createPhoneScheduler();latestPhone=null;phoneLagCount=0;cachedObjects=[];observedAt=-Infinity;objectTime=-Infinity;}
        const width = source.videoWidth || source.width, height = source.videoHeight || source.height;
        let began=performance.now();
        let faceResult = face.detectForVideo(source, time);
        const fullFaceMs = performance.now() - began;
        const bounds = faceBounds(faceResult), count = faceResult.faceLandmarks?.length || 0;
        if(!lowMemory&&time-poseTime>=400){began=performance.now();poseResult=pose.detectForVideo(source,time);poseTime=time;modelMs.pose=performance.now()-began;}
        const faceStarted = performance.now();
        if (!lowMemory && count < 2 && (!bounds || Math.max(bounds.width * width, bounds.height * height) < Math.min(width, height) * .22)) {
          if (!closeup) {
            closeup = await vision.FaceLandmarker.createFromOptions(files, {
              ...options('face_landmarker/face_landmarker/float16/1/face_landmarker.task'), runningMode: 'IMAGE', numFaces: 2,
              minFaceDetectionConfidence: .25, minFacePresenceConfidence: .25,
              outputFaceBlendshapes: true, outputFacialTransformationMatrixes: false,
            });
            resources.push(closeup);
          }
          const previous = time >= lastFaceTime && time - lastFaceTime < 1200 ? lastBounds : null;
          const attempt = scan++;
          const region = faceSearchRegion(bounds || previous, attempt % 3 === 2 ? {} : poseResult, width, height, Math.floor(attempt / 3));
          faceContext.drawImage(source, region.x * width, region.y * height, region.width * width, region.height * height, 0, 0, 512, 512);
          const zoomed = restoreFaceCoordinates(closeup.detect(faceInput), region);
          if (zoomed.faceLandmarks.length > 1 || (zoomed.faceLandmarks.length === 1 && (!bounds || sameFace(bounds, faceBounds(zoomed))))) faceResult = zoomed;
        }
        modelMs.face = fullFaceMs + performance.now() - faceStarted;
        if (faceResult.faceLandmarks?.length === 1) { lastBounds = faceBounds(faceResult); lastFaceTime = time; }
        const identityState=identity?await identity.check(source,faceResult,time):null;
        if(!lowMemory&&time-handTime>=400){began=performance.now();handResult=hand.detectForVideo(source,time);handTime=time;modelMs.hand=performance.now()-began;}
        // ImageData is supported by TF.js fromPixels in workers and the main thread.
        if (phoneRedesign && !objectPending) {
          objectEpoch=epoch;
          const region=phoneScheduler.next(width,height,time,phoneTracker.targets(time),phoneSearchRegions(poseResult,handResult));
          const scale=Math.min(1,640/Math.max(region.width*width,region.height*height));
          const cropWidth=Math.max(1,Math.round(region.width*width*scale)),cropHeight=Math.max(1,Math.round(region.height*height*scale));
          input.width=cropWidth;input.height=cropHeight;
          context.drawImage(source,region.x*width,region.y*height,region.width*width,region.height*height,0,0,cropWidth,cropHeight);
          const pixels=context.getImageData(0,0,cropWidth,cropHeight),objectStarted=performance.now();
          const publish=(found,status)=>{
            if(closed||phoneEpoch!==epoch)return;
            const completedAt=Number.isFinite(clockOrigin)?performance.timeOrigin+performance.now()-clockOrigin:time+performance.now()-startedAt;
            const candidates=found.filter(o=>o.class==='cell phone').map(o=>({score:o.score,box:[region.x+o.bbox[0]/cropWidth*region.width,region.y+o.bbox[1]/cropHeight*region.height,o.bbox[2]/cropWidth*region.width,o.bbox[3]/cropHeight*region.height]}));
            latestPhone={version:3,model:objects.name||'test',id:++observationId,frameId:time,observedAt:time,completedAt,region,resolution:{width,height,inputSize:640},candidates,status,epoch};
            phoneTracker.observe(latestPhone,completedAt);
            phoneLagCount=completedAt-time>PHONE_LIMITS.maxAge?phoneLagCount+1:0;
            if(status==='ok'){
              cachedObjects=found.map(o=>({...o,bbox:[(region.x+o.bbox[0]/cropWidth*region.width)*width,(region.y+o.bbox[1]/cropHeight*region.height)*height,o.bbox[2]/cropWidth*region.width*width,o.bbox[3]/cropHeight*region.height*height]}));
              objectWidth=width;objectHeight=height;observedAt=time;
            }else {cachedObjects=[];observedAt=-Infinity;}
            onPhoneObservation?.({type:'phone-observation',observation:latestPhone,epoch,diagnostics:phoneTracker.diagnostics(),state:phoneTracker.state(completedAt),search:phoneScheduler.diagnostics(),slow:objects.name!=='yolov10n'&&!light&&phoneLagCount>=2});
          };
          objectPending=new Promise(resolve=>setTimeout(resolve,0)).then(async()=>{
            if(closed||phoneEpoch!==epoch)return;
            try {publish(await objects.detect(pixels,30,PHONE_LIMITS.seed),'ok');}catch {publish([],'error');}
          }).finally(()=>{modelMs.objects=performance.now()-objectStarted;objectPending=null;});
        } else if (!phoneRedesign && !objectPending && time - objectTime >= 800) {
          objectTime=time;
          const objectScale = Math.min(1, 640 / Math.max(width, height));
          const fullWidth = Math.max(1, Math.round(width * objectScale)), fullHeight = Math.max(1, Math.round(height * objectScale));
          input.width = fullWidth; input.height = fullHeight;
          context.drawImage(source, 0, 0, fullWidth, fullHeight);
          const full=context.getImageData(0,0,fullWidth,fullHeight);
          const crops=phoneSearchRegions(poseResult,handResult,phoneScan++).map(region=>{
            const scale=Math.min(1,640/Math.max(region.width*width,region.height*height));
            const cropWidth=Math.max(1,Math.round(region.width*width*scale)),cropHeight=Math.max(1,Math.round(region.height*height*scale));
            input.width=cropWidth;input.height=cropHeight;
            context.drawImage(source,region.x*width,region.y*height,region.width*width,region.height*height,0,0,cropWidth,cropHeight);
            return {region,cropWidth,cropHeight,pixels:context.getImageData(0,0,cropWidth,cropHeight)};
          }),objectStarted=performance.now();
          // Copy pixels before returning: the worker may close the input bitmap.
          // A new task lets the Worker post this face result before TF CPU work.
          objectPending=new Promise(resolve=>setTimeout(resolve,0)).then(async()=>{
            if(closed)return;
            let found=(await objects.detect(full,30,.2)).map(o=>({...o,bbox:[o.bbox[0]*width/fullWidth,o.bbox[1]*height/fullHeight,o.bbox[2]*width/fullWidth,o.bbox[3]*height/fullHeight]}));
            for(const {region,cropWidth,cropHeight,pixels} of crops) {
              if(closed || extractFocusSignals(faceResult,poseResult,handResult,found,width,height).phoneUse)break;
              const zoomed=await objects.detect(pixels,30,.2);
              found=found.concat(zoomed.filter(o=>o.class==='cell phone').map(o=>({...o,bbox:[region.x*width+o.bbox[0]*region.width*width/cropWidth,region.y*height+o.bbox[1]*region.height*height/cropHeight,o.bbox[2]*region.width*width/cropWidth,o.bbox[3]*region.height*height/cropHeight]})));
            }
            if(!closed){cachedObjects=found;objectWidth=width;objectHeight=height;observedAt=time;observationId++;}
          }).catch(()=>{if(!closed){cachedObjects=[];observedAt=-Infinity;observationId++;}}).finally(()=>{modelMs.objects=performance.now()-objectStarted;objectPending=null;});
        }
        const ageMs=time-observedAt;
        const currentObjects=ageMs<=1500?cachedObjects.map(o=>({...o,bbox:[o.bbox[0]*width/objectWidth,o.bbox[1]*height/objectHeight,o.bbox[2]*width/objectWidth,o.bbox[3]*height/objectHeight]})):[];
        const signals = extractFocusSignals(faceResult, poseResult, handResult, currentObjects, width, height);
        if(identityState)signals.identity=identityState;
        signals.phoneObservation=phoneRedesign ? latestPhone : {id:observationId,observedAt,ageMs,fresh:observationId!==deliveredId,positive:signals.phoneUse,confidence:signals.phoneEvidence.score};
        if(phoneRedesign)signals.phonePolicy='tracked';
        deliveredId=observationId;
        signals.studyActivity = studyMotion.update(signals.studyContext, signals.studyPoints, time);
        delete signals.studyPoints;
        return { type: 'result', time, signals, backend: tf.getBackend(), mode: light ? 'light' : 'standard', inferenceMs: performance.now()-startedAt,
          modelMs:{...modelMs},objectAgeMs:ageMs,phonePending:Boolean(objectPending&&objectEpoch===epoch),landmarks: faceContinuity.update(faceResult,time) };
      },
      close() { closed=true;const dispose=()=>{for(const model of resources)(model.close||model.dispose).call(model);};if(objectPending)void objectPending.finally(dispose);else dispose(); },
    };
  } catch (error) {
    for (const model of resources) (model.close || model.dispose).call(model);
    throw error;
  }
}
