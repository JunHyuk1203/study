import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createFocusTracker } from '../camera-focus.js';
import { extractFocusSignals, createCameraInference } from '../camera-inference.js';
import { focusDebugRows } from '../camera-debug.js';

const healthy = { reliable: true, face: true, body: true, eyesClosed: false, phoneUse: false, studyActivity: false, activityVector: [.5,.5,.5,.5,.3,.7,.7,.7] };
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
test('idle debug countdown follows the stationary suffix, resets on movement, and explains blocked observations', () => {
  const tracker=createFocusTracker();
  advance(tracker,healthy,0,10000);
  let row=tracker.getDebug().rows.find(row=>row.key==='idle');
  assert.equal(row.elapsedMs,10000); assert.equal(row.pauseRemainingMs,35000);
  tracker.update({...healthy,activityVector:[.8,.5,.5,.5,.3,.7,.7,.7]},10500);
  row=tracker.getDebug().rows.find(row=>row.key==='idle');
  assert.equal(row.elapsedMs,0); assert.equal(row.pauseRemainingMs,45000);
  tracker.update({...healthy,studyActivity:true},11000);
  assert.equal(tracker.getDebug().rows.find(row=>row.key==='idle').blocked,'학습 단서 감지');
  tracker.update({...healthy,activityVector:null},11500);
  assert.equal(tracker.getDebug().rows.find(row=>row.key==='idle').blocked,'양쪽 손목 확인 필요');
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
  const moving = { ...healthy, activityVector: [.6,.5,.6,.5,.4,.7,.7,.7] };
  assert.equal(advance(tracker, moving, 45500, 47500).tracking, true);
});
test('ordinary blinks do not restart the long stillness observation window', () => {
  const tracker=createFocusTracker(); let state;
  for(let t=0;t<=60000;t+=200) {
    state=tracker.update({...healthy,eyesClosed:t>2000 && t%4000===0},t);
    if(t>=45000)assert.equal(state.reason,'idle');
  }
  assert.equal(state.reason,'idle'); assert.equal(state.tracking,false);
});
test('reading, writing, changing gaze and missing wrists prevent a stillness verdict', () => {
  for (const signals of [{ ...healthy, studyActivity: true }, { ...healthy, activityVector: null }]) {
    assert.equal(advance(createFocusTracker(), signals, 0, 60000).tracking, true);
  }
  const tracker = createFocusTracker();
  for (let t = 0; t <= 60000; t += 500) {
    const vector = [...healthy.activityVector]; vector[2] += t % 2000 ? .2 : 0;
    assert.notEqual(tracker.update({ ...healthy, activityVector: vector }, t).reason, 'idle');
  }
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
test('phone requires hand/wrist proximity plus head direction, not merely a phone on the desk', () => {
  const s = scene();
  const extract = () => extractFocusSignals(s.face,s.pose,s.hands,[phone],100,100);
  assert.equal(extract().phoneUse, false);
  s.hands.landmarks = [[{ x:.5,y:.6 }]];
  assert.equal(extract().phoneUse, true);
  s.hands.landmarks = []; s.pose.landmarks[0][15] = { x:.5,y:.6,visibility:.9 };
  assert.equal(extract().phoneUse, true);
  assert.equal(extractFocusSignals(s.face,s.pose,s.hands,[{ ...phone,score:.3 }],100,100).phoneUse,false);
});
test('eye closure, reading context, absence and wrist visibility are extracted independently', () => {
  const s = scene();
  assert.equal(extractFocusSignals(s.face,s.pose,s.hands,[],100,100).eyesClosed,false);
  s.face.faceBlendshapes = [{ categories: [{ categoryName:'eyeBlinkLeft',score:.9 },{ categoryName:'eyeBlinkRight',score:.9 }] }];
  assert.equal(extractFocusSignals(s.face,s.pose,s.hands,[],100,100).eyesClosed,true);
  assert.equal(extractFocusSignals(s.face,s.pose,s.hands,[{ class:'book',score:.9,bbox:[0,70,100,30] }],100,100).studyActivity,true);
  s.pose.landmarks[0][16].visibility = .1;
  assert.equal(extractFocusSignals(s.face,s.pose,s.hands,[],100,100).activityVector,null);
  const absent = extractFocusSignals({ faceLandmarks:[] },{ landmarks:[] },{ landmarks:[] },[],100,100);
  assert.equal(absent.face,false); assert.equal(absent.body,false);
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
