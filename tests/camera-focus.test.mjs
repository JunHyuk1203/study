import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createFocusTracker } from '../camera-focus.js';
import { extractFocusSignals, createCameraInference, createStudyMotionTracker, phoneSearchRegion } from '../camera-inference.js';
import { focusDebugRows } from '../camera-debug.js';

const healthy = { reliable: true, face: true, body: true, eyesClosed: false, phoneUse: false, studyActivity: false, activityVector: [.5,.5,.5,.5,0,.4,0,0,0] };
function advance(tracker, signals, from, to, step = 500) {
  let state;
  for (let t = from; t <= to; t += step) state = tracker.update(signals, t);
  return state;
}
test('debug timers distinguish pause deadlines from warning deadlines and clear on reset', () => {
  const tracker=createFocusTracker();
  advance(tracker,healthy,0,2000);
  tracker.update({...healthy,eyesClosed:true},2200);
  tracker.update({...healthy,eyesClosed:true},2400);
  let row=tracker.getDebug().rows.find(row=>row.key==='sleep');
  assert.equal(row.elapsedMs,200); assert.equal(row.pauseRemainingMs,150); assert.equal(row.warningRemainingMs,1300);
  tracker.update({...healthy,phoneUse:true},2800);
  row=tracker.getDebug().rows.find(row=>row.key==='phone');
  assert.equal(row.pauseRemainingMs,0); assert.equal(row.warningRemainingMs,1500);
  assert.match(focusDebugRows(tracker.getDebug()).find(row=>row.key==='phone').text,/즉시 정지.*경고까지 1.5초/);
  tracker.update(healthy,3000); tracker.update(healthy,3500);
  assert.equal(tracker.getDebug().resumeRemainingMs,1500);
  tracker.reset(); assert.equal(tracker.getDebug(),null);
  assert.ok(focusDebugRows(null).every(row=>row.text==='분석 대기'));
});
test('idle debug countdown ignores brief movement and resets after sustained motion', () => {
  const tracker=createFocusTracker();
  advance(tracker,healthy,0,10000);
  let row=tracker.getDebug().rows.find(row=>row.key==='idle');
  assert.equal(row.elapsedMs,10000); assert.equal(row.pauseRemainingMs,35000);
  const moving={...healthy,activityVector:[.8,.5,.5,.5,0,.4,0,0,0]};
  tracker.update(moving,10500);
  row=tracker.getDebug().rows.find(row=>row.key==='idle');
  assert.equal(row.elapsedMs,10500);
  advance(tracker,moving,11000,12000);
  row=tracker.getDebug().rows.find(row=>row.key==='idle');
  assert.ok(row.elapsedMs<=500); assert.ok(row.pauseRemainingMs>=44500);
  tracker.update({...healthy,studyActivity:true},12500);
  assert.equal(tracker.getDebug().rows.find(row=>row.key==='idle').blocked,'학습 동작 감지');
  tracker.update({...healthy,activityVector:null},13000);
  assert.equal(tracker.getDebug().rows.find(row=>row.key==='idle').blocked,'얼굴 방향 확인 필요');
});
for (const [reason, signals, delay] of [
  ['sleep', { ...healthy, eyesClosed: true }, 1500],
  ['phone', { ...healthy, phoneUse: true }, 1500],
  ['away', { ...healthy, face: false, body: false }, 2000],
]) test(`${reason}: stops credit, warns after persistence and automatically recovers`, () => {
  const tracker = createFocusTracker();
  assert.equal(advance(tracker, healthy, 0, 2000).tracking, true);
  const pending = tracker.update(signals, 2500);
  assert.equal(pending.tracking, reason === 'sleep');
  assert.equal(pending.status, reason === 'sleep' ? 'tracking' : 'scanning');
  const warned = advance(tracker, signals, 3000, 2500 + delay);
  assert.equal(warned.reason, reason);
  assert.equal(warned.status, 'paused');
  assert.equal(tracker.update(healthy, 5000).tracking, false);
  assert.equal(advance(tracker, healthy, 5500, 7000).tracking, true);
});
test('a blink or brief occlusion never becomes a persistent behavior warning', () => {
  const tracker = createFocusTracker();
  advance(tracker, healthy, 0, 2000);
  assert.equal(tracker.update({ ...healthy, eyesClosed: true }, 2200).tracking, true);
  assert.equal(tracker.update(healthy, 2400).reason, null);
  assert.equal(tracker.update(healthy, 2600).tracking, true);
  assert.equal(advance(tracker, healthy, 2900, 4400).tracking, true);
});
test('prolonged eye closure stops time after blink grace, before the sleep warning', () => {
  const tracker=createFocusTracker(); advance(tracker,healthy,0,2000);
  assert.equal(tracker.update({...healthy,eyesClosed:true},2200).tracking,true);
  const state=tracker.update({...healthy,eyesClosed:true},2600);
  assert.equal(state.tracking,false); assert.equal(state.status,'scanning');
});
test('idle requires 45 seconds of stillness and exits on observed movement', () => {
  const tracker = createFocusTracker();
  assert.equal(advance(tracker, healthy, 0, 44500).tracking, true);
  assert.equal(tracker.update(healthy, 45000).reason, 'idle');
  const moving = { ...healthy, activityVector: [.7,.5,.5,.5,0,.4,0,0,0] };
  assert.equal(advance(tracker, moving, 45500, 49000).tracking, true);
});
test('ordinary blinks do not restart the long stillness observation window', () => {
  const tracker=createFocusTracker(); let state;
  for(let t=0;t<=60000;t+=200) {
    state=tracker.update({...healthy,eyesClosed:t>2000 && t%4000===0},t);
    if(t>=45000)assert.equal(state.reason,'idle');
  }
  assert.equal(state.reason,'idle'); assert.equal(state.tracking,false);
});
test('real study motion or missing face features prevents an idle verdict', () => {
  for (const signals of [{ ...healthy, studyActivity: true }, { ...healthy, activityVector: null }]) {
    assert.equal(advance(createFocusTracker(), signals, 0, 60000).tracking, true);
  }
});
test('face alone can trigger idle without shoulders, wrists or hands, despite minor motion and gaze jitter', () => {
  const tracker=createFocusTracker(); let state;
  for(let t=0;t<=60000;t+=200){
    const vector=[...healthy.activityVector];
    vector[0]+=.02*Math.sin(t/500);vector[2]+=.15*Math.sin(t/300);vector[3]+=.15*Math.sin(t/300);
    state=tracker.update({...healthy,body:false,activityVector:vector},t);
    if(t>=45000)assert.equal(state.reason,'idle');
  }
  assert.equal(state.tracking,false);
});
test('a one-frame head landmark spike does not restart the 45 second countdown', () => {
  const tracker=createFocusTracker();let state;
  for(let t=0;t<=46000;t+=200){
    const vector=[...healthy.activityVector];if(t===20000)vector[0]+=.2;
    state=tracker.update({...healthy,activityVector:vector},t);
  }
  assert.equal(state.reason,'idle');
});
test('missing/partial observations and long gaps cannot keep crediting time', () => {
  for (const signals of [null, {}, { ...healthy, reliable: false }, { ...healthy, face: false }]) {
    const tracker = createFocusTracker(); advance(tracker, healthy, 0, 2000);
    assert.equal(tracker.update(signals, 2500).tracking, false);
  }
  const tracker = createFocusTracker(); advance(tracker, healthy, 0, 2000);
  assert.equal(tracker.update(healthy, 9000).tracking, false);
  assert.equal(advance(tracker, healthy, 9500, 11000).tracking, true);
  tracker.reset(); assert.equal(tracker.update(healthy, 12000).tracking, false);
});
function scene() {
  const face = Array.from({ length: 478 }, () => ({ x: .5, y: .4 }));
  for (const [i, x, y] of [[33,.3,.3],[133,.4,.3],[160,.32,.28],[158,.38,.28],[153,.38,.32],[144,.32,.32],
    [362,.6,.3],[263,.7,.3],[385,.62,.28],[387,.68,.28],[373,.68,.32],[380,.62,.32],
    [468,.35,.3],[473,.65,.3],[1,.5,.6]]) face[i] = { x, y };
  const pose = Array.from({ length: 33 }, () => ({ x: .5, y: .5, visibility: 1 }));
  pose[15] = { x:.1,y:.8,visibility:1 }; pose[16] = { x:.9,y:.8,visibility:1 };
  return { face: { faceLandmarks: [face] }, pose: { landmarks: [pose] }, hands: { landmarks: [] } };
}
const phone = { class: 'cell phone', score: .9, bbox: [40,50,20,25] };
test('a raised phone is usable without hands or a downward head, while a desk phone alone is ignored', () => {
  const s = scene();
  const extract = () => extractFocusSignals(s.face,s.pose,s.hands,[phone],100,100);
  assert.equal(extract().phoneUse, true);
  assert.equal(extractFocusSignals(s.face,{landmarks:[]},s.hands,[phone],100,100).phoneUse,true);
  assert.equal(extractFocusSignals(s.face,s.pose,s.hands,[{...phone,bbox:[40,80,20,20]}],100,100).phoneUse,false);
  s.hands.landmarks = [[{ x:.5,y:.6 }]];
  assert.equal(extract().phoneUse, true);
  s.hands.landmarks = []; s.pose.landmarks[0][15] = { x:.5,y:.6,visibility:.9 };
  assert.equal(extract().phoneUse, true);
  assert.equal(extractFocusSignals(s.face,s.pose,s.hands,[{ ...phone,score:.3 }],100,100).phoneUse,false);
  assert.equal(extractFocusSignals(s.face,s.pose,s.hands,[{ ...phone,score:.4 }],100,100).phoneUse,true);
});
test('eye closure, reading context, absence and wrist visibility are extracted independently', () => {
  const s = scene();
  assert.equal(extractFocusSignals(s.face,s.pose,s.hands,[],100,100).eyesClosed,false);
  s.face.faceBlendshapes = [{ categories: [{ categoryName:'eyeBlinkLeft',score:.9 },{ categoryName:'eyeBlinkRight',score:.9 }] }];
  assert.equal(extractFocusSignals(s.face,s.pose,s.hands,[],100,100).eyesClosed,true);
  const reading=extractFocusSignals(s.face,s.pose,s.hands,[{ class:'book',score:.9,bbox:[0,70,100,30] }],100,100);
  assert.equal(reading.studyContext,true);assert.equal(reading.studyActivity,false);
  s.pose.landmarks[0][16].visibility = .1;
  assert.equal(extractFocusSignals(s.face,s.pose,s.hands,[],100,100).activityVector.length,9);
  assert.equal(extractFocusSignals(s.face,{landmarks:[]},s.hands,[],100,100).activityVector.length,9);
  const absent = extractFocusSignals({ faceLandmarks:[] },{ landmarks:[] },{ landmarks:[] },[],100,100);
  assert.equal(absent.face,false); assert.equal(absent.body,false);
});
test('static books and laptops are context, only actual hand motion is study activity', () => {
  const tracker=createStudyMotionTracker();const still=[{x:.3,y:.6},null];
  assert.equal(tracker.update(true,still,0),false);
  assert.equal(tracker.update(true,still,500),false);
  assert.equal(tracker.update(true,[{x:.4,y:.6},null],1000),true);
  assert.equal(tracker.update(true,[{x:.4,y:.6},null],2500),false);
  assert.equal(tracker.update(false,still,3000),false);
});
test('phone diagnostics distinguish no object, weak predictions, desk placement and use', () => {
  const s=scene();
  for(const [objects,stage]of [[[],'not-found'],[[{...phone,score:.3}],'weak'],[[{...phone,bbox:[40,80,20,20]}],'desk'],[[phone],'using']]){
    const evidence=extractFocusSignals(s.face,s.pose,s.hands,objects,100,100).phoneEvidence;
    const tracker=createFocusTracker();tracker.update({...healthy,phoneEvidence:evidence},0);
    assert.equal(evidence.stage,stage);
    assert.notEqual(focusDebugRows(tracker.getDebug()).find(row=>row.key==='phone').text,'미감지');
  }
});
test('phone search crop follows visible hands and stays inside the frame without shoulders', () => {
  const region=phoneSearchRegion({landmarks:[]},{landmarks:[[{x:.9,y:.9},{x:.95,y:.95}]]});
  assert.ok(region.x>=0 && region.y>=0 && region.x+region.width<=1 && region.y+region.height<=1);
  assert.ok(region.x<=.9 && region.x+region.width>=.95);
  assert.ok(region.width<.5);
  const fallback=phoneSearchRegion({landmarks:[]},{landmarks:[]});
  assert.equal(fallback.width,.55);
});
test('controller propagates behavior pauses, ignores stale results and auto resumes without confirmation', async () => {
  let now = 0, events = 0;
  const document = { hidden:false, createElement:()=>({setAttribute(){}}),querySelector:()=>null,addEventListener(){} };
  const code = (await readFile(new URL('../camera.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'').replaceAll('import.meta.url',JSON.stringify(import.meta.url));
  const context = vm.createContext({document,crypto,Event,createFocusTracker,performance:{now:()=>now},facePose:()=>null,window:{addEventListener(){},dispatchEvent(){events++;}}});
  vm.runInContext(`${code}\nenabled=true;globalThis.controller={acceptResult,cameraState};`,context);
  const controller = context.controller;
  const send = (time, signals=healthy, captured=time) => { now=time; controller.acceptResult({time:captured,signals}); return controller.cameraState(); };
  send(0); assert.equal(send(2000).tracking,true);
  assert.equal(send(2200,{...healthy,phoneUse:true}).tracking,false);
  assert.equal(send(3800,{...healthy,phoneUse:true}).reason,'phone');
  send(4000); assert.equal(send(6000).tracking,true);
  assert.equal(send(9001,healthy,6000).tracking,false);
  assert.ok(events>=5);
});
test('inference initialization failure closes every model already created', async () => {
  let closed = 0;
  const vision = { FilesetResolver:{forVisionTasks:async()=>({})}, FaceLandmarker:{createFromOptions:async()=>({close(){closed++;}})},
    PoseLandmarker:{createFromOptions:async()=>{throw new Error('pose unavailable');}} };
  await assert.rejects(createCameraInference(vision,{},{}),/pose unavailable/);
  assert.equal(closed,1);
});
test('worker failures retry once in another worker, never on the UI thread, and ignore replaced-worker messages', async () => {
  let now=0;const workers=[];
  class Worker { constructor(){workers.push(this);} postMessage(message){this.init=message;} terminate(){this.terminated=true;} }
  const document={hidden:false,createElement:()=>({setAttribute(){}}),querySelector:()=>null,addEventListener(){}};
  const code=(await readFile(new URL('../camera.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'').replaceAll('import.meta.url',JSON.stringify(import.meta.url));
  const context=vm.createContext({URL,Worker,document,crypto,Event,createFocusTracker,setTimeout:()=>0,clearTimeout(){},clearInterval(){},performance:{now:()=>now},facePose:()=>null,window:{addEventListener(){},dispatchEvent(){}}});
  vm.runInContext(`${code}\nenabled=true;startRecognitionWorker(revision);globalThis.controller={cameraState};`,context);
  workers[0].onmessage({data:{type:'error',stage:'init',message:'test failure'}});
  assert.equal(workers.length,2);assert.equal(workers[0].terminated,true);assert.equal(workers[1].init.light,true);
  workers[0].onmessage({data:{type:'result',time:0,signals:healthy}});
  workers[0].onerror({preventDefault(){},message:'stale worker error'});
  assert.equal(workers.length,2);assert.notEqual(workers[1].terminated,true);
  assert.equal(context.controller.cameraState().tracking,false);
  workers[1].onmessage({data:{type:'ready'}});
  for(now=0;now<=2000;now+=500)workers[1].onmessage({data:{type:'result',time:now,signals:healthy}});
  assert.equal(context.controller.cameraState().tracking,true);
  workers[1].onmessage({data:{type:'error',stage:'frame',message:'second failure'}});
  assert.equal(workers.length,2);assert.equal(workers[1].terminated,true);
  assert.equal(context.controller.cameraState().status,'error');
  assert.doesNotMatch(code,/loadCameraInference|fallbackDetector/);
});
test('WASM inference preserves 800ms object cadence in standard and light mode', async () => {
  const previous=globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas=class {getContext(){return {drawImage(){},getImageData(){return {};}};}};
  try{
    for(const light of [false,true]){
      const s=scene(),calls=[],backends=[];
      const model=result=>({detectForVideo:()=>result,close(){}});
      const vision={FilesetResolver:{forVisionTasks:async()=>({})},
        FaceLandmarker:{createFromOptions:async()=>model(s.face)},PoseLandmarker:{createFromOptions:async()=>model(s.pose)},HandLandmarker:{createFromOptions:async()=>model(s.hands)}};
      const tf={wasm:{},setBackend:async value=>{backends.push(value);return true;},ready:async()=>{},getBackend:()=>backends.at(-1)};
      let base;
      const coco={load:async options=>{base=options.base;return {detect:async(...args)=>{calls.push(args);return [phone];},dispose(){}};}};
      const engine=await createCameraInference(vision,coco,tf,undefined,{light});
      try{
        const first=await engine.detect({width:100,height:100},0);
        await engine.detect({width:100,height:100},200);await engine.detect({width:100,height:100},800);
        assert.equal(first.backend,'wasm');assert.equal(calls.length,2);assert.equal(calls[0][2],.25);
        assert.equal(base,light?'lite_mobilenet_v2':'mobilenet_v2');
      }finally{engine.close();}
    }
  }finally{if(previous===undefined)delete globalThis.OffscreenCanvas;else globalThis.OffscreenCanvas=previous;}
});
