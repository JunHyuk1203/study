import test from 'node:test';
import './camera-phone.test.mjs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createFocusTracker, FOCUS_LIMITS } from '../camera-focus.js';
import { extractFocusSignals, createCameraInference, createStudyMotionTracker, phoneSearchRegion, phoneSearchRegions, createFaceContinuity } from '../camera-inference.js';
import { focusDebugRows } from '../camera-debug.js';
import { createIdentityMatcher } from '../camera-identity.js';
import { decodeStudyObjects } from '../camera-objects.js';

const healthy = { reliable: true, face: true, body: true, eyesClosed: false, gazeValid: true, phoneUse: false, studyActivity: false, activityVector: [.5,.5,.5,.5,0,.4,0,0,0] };
const IDLE_AT=FOCUS_LIMITS.idle;
test('phone class survives a higher person score and retains sub-threshold diagnostics',()=>{
  const scores=new Float32Array(180),boxes=new Float32Array([.1,.1,.4,.4,.5,.5,.7,.7]);
  scores[0]=.99;scores[76]=.35;scores[90+76]=.057;
  const result=decodeStudyObjects(scores,boxes,640,480);
  assert.equal(result.filter(item=>item.class==='cell phone').length,2);
  assert.ok(result[0].score>.34);assert.ok(result[1].score<.06);
});
test('encrypted-profile matcher keeps its owner and requires fresh observations',()=>{
  const owner=Array(1024).fill(0),other=[...owner];owner[0]=1;other[1]=1;
  const matcher=createIdentityMatcher(Array(12).fill(owner));
  for(let i=0;i<4;i++)assert.equal(matcher.observe(owner).matched,false);
  assert.equal(matcher.observe(owner).matched,true);
  assert.equal(matcher.observe(other).status,'mismatch');
  assert.deepEqual(matcher.samples,Array(12).fill(owner));
  assert.equal(createIdentityMatcher().observe(owner).matched,false);
});

test('timer keeps running during a ten second identity grace and pauses at its exact boundary',()=>{
  const tracker=createFocusTracker(),wrong={...healthy,identity:{matched:false,status:'mismatch',enrolled:true}};
  advance(tracker,{...healthy,identity:{matched:true,status:'matched',enrolled:true}},0,2000);
  for(let t=2200;t<12200;t+=200){const result=tracker.update(wrong,t);assert.equal(result.tracking,true);assert.equal(Boolean(result.identityWarning),false);}
  assert.equal(tracker.update(wrong,12199).tracking,true);
  const expired=tracker.update(wrong,12200);assert.equal(expired.identityWarning,true);assert.equal(expired.tracking,false);
  const restored=tracker.update({...healthy,identity:{matched:true,status:'matched',enrolled:true}},12400);
  assert.equal(restored.status,'scanning');assert.equal(Boolean(restored.identityWarning),false);
  for(const status of ['enrolling','checking','missing','multiple']){
    const signals={...healthy,face:status!=='missing',identity:{matched:false,status,enrolled:false}};
    assert.equal(createFocusTracker().update(signals,0).tracking,false);
  }
});
test('missing faces pause at five seconds while unknown returning faces retain the ten second identity deadline',()=>{
  const tracker=createFocusTracker(),owner={...healthy,identity:{matched:true,status:'matched',enrolled:true}};
  const wrong={...healthy,identity:{matched:false,status:'mismatch',enrolled:true}};
  advance(tracker,owner,0,2000);
  const absent={...healthy,face:false,identity:{matched:false,status:'missing',enrolled:true}};
  assert.equal(advance(tracker,absent,2500,7000).tracking,true);
  assert.equal(tracker.update(absent,7499).tracking,true);
  const missing=tracker.update(absent,7500);
  assert.equal(missing.tracking,false);assert.equal(missing.status,'paused');assert.equal(missing.reason,'away');
  assert.equal(missing.identityWarning,false);
  assert.equal(tracker.update(wrong,7700).tracking,false);
  assert.equal(advance(tracker,wrong,7900,9500,200).tracking,false);
  assert.equal(tracker.update(wrong,9700).tracking,true);
  assert.equal(advance(tracker,wrong,9900,12300,200).tracking,true);
  const expired=tracker.update(wrong,12500);assert.equal(expired.identityWarning,true);assert.equal(expired.tracking,false);
});
test('only the recognized owner clears a continuous mismatch deadline',()=>{
  const tracker=createFocusTracker(),owner={...healthy,studyActivity:true,identity:{matched:true,status:'matched',enrolled:true}},wrong={...healthy,studyActivity:true,identity:{matched:false,status:'mismatch',enrolled:true}};
  advance(tracker,owner,0,2000);advance(tracker,wrong,2200,6000,200);
  tracker.update({...wrong,identity:{matched:false,status:'checking',enrolled:true}},6200);
  assert.equal(advance(tracker,wrong,6400,12200,200).identityWarning,true);
  assert.equal(Boolean(tracker.update(owner,12400).identityWarning),false);
  assert.equal(advance(tracker,owner,12600,14400,200).tracking,true);
  assert.equal(advance(tracker,wrong,14600,24400,200).tracking,true);
  assert.equal(tracker.update(wrong,24600).identityWarning,true);
});
for(const loss of [null,{reliable:false},{...healthy,face:false}])test(`missing face observations pause at five seconds before identity expiry: ${JSON.stringify(loss)}`,()=>{
  const tracker=createFocusTracker(),owner={...healthy,identity:{matched:true,status:'matched',enrolled:true}};
  advance(tracker,owner,0,2000);
  assert.equal(advance(tracker,loss,2200,7000,200).tracking,true);
  assert.equal(tracker.update(loss,7199).tracking,true);
  const paused=tracker.update(loss,7200);
  assert.equal(paused.tracking,false);assert.equal(paused.reason,'away');assert.equal(paused.identityWarning,false);
  const stillMissing=advance(tracker,loss,7400,12200,200);
  assert.equal(stillMissing.tracking,false);assert.equal(stillMissing.reason,'away');assert.equal(stillMissing.identityWarning,false);
  assert.equal(tracker.update(owner,12400).tracking,false);
  assert.equal(advance(tracker,owner,12600,14400,200).tracking,true);
});

for(const withIdentity of [false,true])test(`away recovery waits two continuous seconds and resets on another face loss (identity: ${withIdentity})`,()=>{
  const tracker=createFocusTracker();
  const owner={...healthy,studyActivity:true,...(withIdentity?{identity:{matched:true,enrolled:true}}:{})};
  const absent={...owner,face:false,...(withIdentity?{identity:{matched:false,enrolled:true}}:{})};
  advance(tracker,owner,0,2000);
  advance(tracker,absent,2200,7200,200);
  assert.equal(tracker.update(owner,7400).reason,'away');
  assert.equal(tracker.getDebug().resumeRemainingMs,2000);
  assert.equal(tracker.update(owner,8400).tracking,false);
  assert.equal(tracker.getDebug().resumeRemainingMs,1000);
  assert.equal(tracker.update(absent,8500).tracking,false);
  assert.equal(tracker.getDebug().resumeRemainingMs,null);
  assert.equal(tracker.update(owner,8600).tracking,false);
  assert.equal(tracker.getDebug().resumeRemainingMs,2000);
  advance(tracker,owner,8800,10400,200);
  const before=tracker.update(owner,10599);
  assert.equal(before.tracking,false);assert.equal(before.reason,'away');
  assert.equal(tracker.getDebug().resumeRemainingMs,1);
  const resumed=tracker.update(owner,10600);
  assert.equal(resumed.tracking,true);assert.equal(resumed.reason,null);
});

test('missing face grace takes priority even when the identity deadline expires first',()=>{
  const tracker=createFocusTracker(),owner={...healthy,identity:{matched:true,enrolled:true}};
  const wrong={...healthy,identity:{matched:false,status:'mismatch',enrolled:true}};
  advance(tracker,owner,0,2000);
  advance(tracker,wrong,2200,11000,200);
  const absent={...wrong,face:false};
  advance(tracker,absent,11200,12200,200);
  assert.equal(tracker.update(absent,12201).identityWarning,false);
  assert.equal(advance(tracker,absent,12400,16000,200).tracking,true);
  assert.equal(tracker.update(absent,16199).tracking,true);
  const paused=tracker.update(absent,16200);
  assert.equal(paused.tracking,false);assert.equal(paused.reason,'away');
  const returned=tracker.update(wrong,16400);
  assert.equal(returned.tracking,false);assert.equal(returned.identityWarning,true);
});
test('learning can start before the first match but an unrecognized face pauses after ten seconds',()=>{
  const tracker=createFocusTracker(),wrong={...healthy,identity:{matched:false,status:'checking',enrolled:true}};
  assert.equal(tracker.update(wrong,0).tracking,false);
  assert.equal(tracker.update(wrong,2000).tracking,true);
  assert.equal(advance(tracker,wrong,2200,9800,200).tracking,true);
  assert.equal(tracker.update(wrong,9999).tracking,true);
  assert.equal(tracker.update(wrong,10000).identityWarning,true);
});
test('idle and gaze observation continue after identity failure pauses the timer',()=>{
  const tracker=createFocusTracker(),wrong={...healthy,identity:{matched:false,enrolled:true,status:'mismatch'}};
  for(let now=0;now<=16000;now+=200)tracker.update(wrong,now);
  const idle=tracker.getDebug().rows.find(row=>row.key==='idle');
  assert.equal(idle.active,true);assert.equal(idle.blocked,null);assert.ok(idle.elapsedMs>=15000);
  assert.equal(tracker.getDebug().gaze.tracking,true);
  assert.equal(tracker.update(wrong,16200).tracking,false);
  const moving={...wrong,activityVector:[.7,.5,.5,.5,0,.4,0,0,0]};advance(tracker,moving,16400,17200,200);
  assert.ok(tracker.getDebug().rows.find(row=>row.key==='idle').elapsedMs<15000);
});

test('sleep and phone counters remain visible together with the idle timer',()=>{
  const tracker=createFocusTracker();advance(tracker,healthy,0,2000);
  const both={...healthy,eyesClosed:true,phoneUse:true};tracker.update(both,2200);tracker.update(both,3000);
  const debug=tracker.getDebug(),rows=focusDebugRows(debug);
  for(const key of ['sleep','phone','idle'])assert.equal(debug.rows.find(row=>row.key===key).active,true);
  assert.equal(debug.rows.find(row=>row.key==='sleep').elapsedMs,800);
  assert.ok(rows.every(row=>!row.text.includes('다른 행동')));
});
test('an unconfirmed phone candidate cannot mask an already confirmed sleep pause',()=>{
  const tracker=createFocusTracker();advance(tracker,healthy,0,2000);
  advance(tracker,{...healthy,eyesClosed:true},2200,6600,200);
  const result=tracker.update({...healthy,eyesClosed:true,phoneUse:true,phoneObservation:{id:1,positive:true,observedAt:6700,ageMs:0}},6700);
  assert.equal(result.reason,'sleep');assert.equal(result.tracking,false);
});
test('cached phone evidence cannot confirm use and a new negative resets the candidate',()=>{
  const tracker=createFocusTracker();advance(tracker,healthy,0,2000);
  const signal=(id,at,positive,age=0)=>({...healthy,phoneUse:positive,phoneObservation:{id,observedAt:at,ageMs:age,fresh:age===0,positive}});
  tracker.update(signal(1,2200,true),2200);
  assert.equal(tracker.update(signal(1,2200,true,800),3000).tracking,true);
  assert.equal(tracker.update(signal(2,3200,false),3200).reason,null);
  tracker.update(signal(3,3400,true),3400);
  assert.equal(tracker.update(signal(3,3400,true,800),4200).tracking,true);
  assert.equal(tracker.update(signal(4,4400,true),4400).reason,'phone');
});

test('slow or failed object inference does not hold face results or reuse stale phone evidence',async()=>{
  const previous=globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas=class{getContext(){return {drawImage(){},getImageData(){return {};}};}};
  const s=scene(),model=result=>({detectForVideo:()=>result,close(){}});
  let reject,objectCalls=0;
  const engine=await createCameraInference({FilesetResolver:{forVisionTasks:async()=>({})},FaceLandmarker:{createFromOptions:async()=>model(s.face)},PoseLandmarker:{createFromOptions:async()=>model(s.pose)},HandLandmarker:{createFromOptions:async()=>model(s.hands)}},
    {load:async()=>({detect:()=>{objectCalls++;return new Promise((resolve,no)=>{reject=no;});},dispose(){}})},
    {setBackend:async()=>true,ready:async()=>{},getBackend:()=> 'cpu'});
  try {
    const first=await engine.detect({width:100,height:100},0);
    await new Promise(resolve=>setTimeout(resolve,0));
    const next=await engine.detect({width:100,height:100},1000);
    assert.equal(first.signals.face,true);assert.equal(next.signals.face,true);assert.equal(objectCalls,1);
    reject(Error('object model failed'));await new Promise(resolve=>setImmediate(resolve));
    const after=await engine.detect({width:100,height:100},1200);
    await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(after.signals.face,true);assert.equal(after.signals.phoneUse,false);
    assert.ok(after.modelMs.face>=0);reject(Error('shutdown'));await new Promise(resolve=>setImmediate(resolve));
  } finally {engine.close();if(previous===undefined)delete globalThis.OffscreenCanvas;else globalThis.OffscreenCanvas=previous;}
});

test('eye geometry preserves pixel proportions across portrait and landscape normalization',()=>{
  const s=scene();
  const measure=(width,height)=>{
    const points=s.face.faceLandmarks[0].map(p=>({...p,x:p.x*100/width,y:p.y*100/height}));
    return extractFocusSignals({...s.face,faceLandmarks:[points]},s.pose,s.hands,[],width,height);
  };
  assert.equal(measure(200,100).eyesClosed,measure(100,200).eyesClosed);
  assert.deepEqual(measure(200,100).activityVector.slice(4),measure(100,200).activityVector.slice(4));
});
function advance(tracker, signals, from, to, step = 500) {
  let state;
  for (let t = from; t <= to; t += step) state = tracker.update(signals, t);
  return state;
}
test('iris tracking uses the eye axis and remains stable when the head rolls', () => {
  const s=scene();
  for(const index of [468,473]){s.face.faceLandmarks[0][index].x+=.01;s.face.faceLandmarks[0][index].y+=.005;}
  const initial=extractFocusSignals(s.face,s.pose,s.hands,[],100,100);
  const angle=.4;
  const rotated=s.face.faceLandmarks[0].map(({x,y,...rest})=>({...rest,
    x:.5+(x-.5)*Math.cos(angle)-(y-.5)*Math.sin(angle),
    y:.5+(x-.5)*Math.sin(angle)+(y-.5)*Math.cos(angle)}));
  const after=extractFocusSignals({...s.face,faceLandmarks:[rotated]},s.pose,s.hands,[],100,100);
  assert.equal(initial.gazeValid,true);assert.equal(after.gazeValid,true);
  for(const index of [2,3,7,8])assert.ok(Math.abs(initial.activityVector[index]-after.activityVector[index])<1e-8);
  delete rotated[468];
  assert.equal(extractFocusSignals({...s.face,faceLandmarks:[rotated]},s.pose,s.hands,[],100,100).gazeValid,false);
});
test('debug timers show identical warning and pause deadlines and clear on reset', () => {
  const tracker=createFocusTracker();
  advance(tracker,healthy,0,2000);
  tracker.update({...healthy,eyesClosed:true},2200);
  tracker.update({...healthy,eyesClosed:true},2400);
  let row=tracker.getDebug().rows.find(row=>row.key==='sleep');
  assert.equal(row.elapsedMs,200); assert.equal(row.pauseRemainingMs,4300); assert.equal(row.warningRemainingMs,4300);
  tracker.update({...healthy,phoneUse:true},2800);
  row=tracker.getDebug().rows.find(row=>row.key==='phone');
  assert.equal(row.pauseRemainingMs,750); assert.equal(row.warningRemainingMs,750);
  assert.match(focusDebugRows(tracker.getDebug()).find(row=>row.key==='phone').text,/경고·정지까지 0.75초/);
  tracker.update({...healthy,phoneUse:true},3550);
  tracker.update(healthy,4000); tracker.update(healthy,4500);
  assert.equal(tracker.getDebug().resumeRemainingMs,1500);
  tracker.reset(); assert.equal(tracker.getDebug(),null);
  assert.ok(focusDebugRows(null).every(row=>row.text==='분석 대기'));
});
test('idle debug countdown ignores brief movement and resets after sustained motion', () => {
  const tracker=createFocusTracker();
  advance(tracker,healthy,0,10000);
  let row=tracker.getDebug().rows.find(row=>row.key==='idle');
  assert.equal(row.elapsedMs,10000); assert.equal(row.pauseRemainingMs,5000);
  const moving={...healthy,activityVector:[.8,.5,.5,.5,0,.4,0,0,0]};
  tracker.update(moving,10500);
  row=tracker.getDebug().rows.find(row=>row.key==='idle');
  assert.equal(row.elapsedMs,10500);
  advance(tracker,moving,11000,12000);
  row=tracker.getDebug().rows.find(row=>row.key==='idle');
  assert.ok(row.elapsedMs<=1500); assert.ok(row.pauseRemainingMs>=13000);
  tracker.update({...healthy,studyActivity:true},12500);
  assert.equal(tracker.getDebug().rows.find(row=>row.key==='idle').blocked,'학습 동작 감지');
  tracker.update({...healthy,activityVector:null},13000);
  assert.equal(tracker.getDebug().rows.find(row=>row.key==='idle').blocked,'얼굴 방향 확인 필요');
});
for (const [reason, signals, delay] of [
  ['sleep', { ...healthy, eyesClosed: true }, 4500],
  ['phone', { ...healthy, phoneUse: true }, 750],
  ['away', { ...healthy, face: false, body: false }, 5000],
]) test(`${reason}: stops credit, warns after persistence and automatically recovers`, () => {
  const tracker = createFocusTracker();
  assert.equal(advance(tracker, healthy, 0, 2000).tracking, true);
  const pending = tracker.update(signals, 2500);
  assert.equal(pending.tracking, reason!=='away');
  assert.equal(pending.status, reason==='away'?'scanning':'tracking');
  const before=advance(tracker,signals,2750,2500+delay-250,250);
  assert.equal(before.tracking,reason!=='away');assert.notEqual(before.status,'paused');
  const warned = tracker.update(signals,2500+delay);
  assert.equal(warned.reason, reason);
  assert.equal(warned.status, 'paused');
  const recoverAt=2500+delay+500;
  assert.equal(tracker.update(healthy, recoverAt).tracking, false);
  assert.equal(advance(tracker, healthy, recoverAt+500, recoverAt+2000).tracking, true);
});
test('a blink or brief occlusion never becomes a persistent behavior warning', () => {
  const tracker = createFocusTracker();
  advance(tracker, healthy, 0, 2000);
  assert.equal(tracker.update({ ...healthy, eyesClosed: true }, 2200).tracking, true);
  assert.equal(tracker.update(healthy, 2400).reason, null);
  assert.equal(tracker.update(healthy, 2600).tracking, true);
  assert.equal(advance(tracker, healthy, 2900, 4400).tracking, true);
});
test('eye closure continues timing before confirmation and warns exactly when it pauses', () => {
  const tracker=createFocusTracker(); advance(tracker,healthy,0,2000);
  assert.equal(tracker.update({...healthy,eyesClosed:true},2200).tracking,true);
  const state=tracker.update({...healthy,eyesClosed:true},2600);
  assert.equal(state.tracking,true); assert.equal(state.status,'tracking');
  assert.equal(advance(tracker,{...healthy,eyesClosed:true},2800,6600,200).tracking,true);
  const confirmed=tracker.update({...healthy,eyesClosed:true},6700);
  assert.equal(confirmed.tracking,false);assert.equal(confirmed.status,'paused');assert.equal(confirmed.reason,'sleep');
});
test('brief false-open runs preserve closure timing and cannot confirm sleep on an open frame', () => {
  const tracker=createFocusTracker(),closed={...healthy,eyesClosed:true};
  advance(tracker,healthy,0,2000);
  for(let t=2200;t<6700;t+=100){
    const falseOpen=(t>=3400&&t<=3800)||t===5200||t>=6500;
    assert.equal(tracker.update(falseOpen?healthy:closed,t).tracking,true);
  }
  assert.equal(tracker.update(healthy,6700).tracking,true);
  assert.equal(tracker.getDebug().rows.find(row=>row.key==='sleep').elapsedMs,4500);
  const state=tracker.update(closed,6800);
  assert.equal(state.reason,'sleep');assert.equal(state.tracking,false);
});

test('sustained eye opening clears closure evidence at the reopen boundary', () => {
  const tracker=createFocusTracker(),closed={...healthy,eyesClosed:true};
  advance(tracker,healthy,0,2000);
  advance(tracker,closed,2200,4000,200);
  tracker.update(healthy,4200);
  tracker.update(healthy,4200+FOCUS_LIMITS.eyeReopen-1);
  assert.equal(tracker.getDebug().rows.find(row=>row.key==='sleep').active,true);
  tracker.update(healthy,4200+FOCUS_LIMITS.eyeReopen);
  assert.equal(tracker.getDebug().rows.find(row=>row.key==='sleep').active,false);
  tracker.update(closed,5000);
  assert.equal(tracker.getDebug().rows.find(row=>row.key==='sleep').elapsedMs,0);
});

test('a closed frame after a sustained open interval starts fresh closure evidence', () => {
  const tracker=createFocusTracker(),closed={...healthy,eyesClosed:true};
  advance(tracker,healthy,0,2000);
  advance(tracker,closed,2200,4000,200);
  tracker.update(healthy,4200);
  tracker.update(closed,5000);
  assert.equal(tracker.getDebug().rows.find(row=>row.key==='sleep').elapsedMs,0);
});

test('false-open frames cannot accumulate recovery time across continued sleep', () => {
  const tracker=createFocusTracker(),closed={...healthy,eyesClosed:true};
  advance(tracker,healthy,0,2000);
  advance(tracker,closed,2200,6800,200);
  for(let t=7000;t<=10000;t+=200){
    const result=tracker.update(t%600===0?healthy:closed,t);
    assert.equal(result.reason,'sleep');assert.equal(result.tracking,false);
  }
  tracker.update(healthy,10200);
  assert.equal(advance(tracker,healthy,10400,12200,200).tracking,true);
});

test('face loss and explicit reset discard pending closure evidence', () => {
  for(const reset of [tracker=>tracker.reset(),tracker=>tracker.update({...healthy,face:false},4200)]){
    const tracker=createFocusTracker(),closed={...healthy,eyesClosed:true};
    advance(tracker,healthy,0,2000);
    advance(tracker,closed,2200,4000,200);
    reset(tracker);
    tracker.update(closed,4400);
    assert.equal(tracker.getDebug().rows.find(row=>row.key==='sleep').elapsedMs,0);
  }
});

test('idle requires fifteen seconds of stillness and exits on observed movement', () => {
  const tracker = createFocusTracker();
  assert.equal(advance(tracker, healthy, 0, IDLE_AT-500).tracking, true);
  assert.equal(tracker.update(healthy, IDLE_AT).reason, 'idle');
  const moving = { ...healthy, activityVector: [.7,.5,.5,.5,0,.4,0,0,0] };
  assert.equal(advance(tracker, moving, IDLE_AT+500, IDLE_AT+4000).tracking, true);
});
test('ordinary blinks do not restart the long stillness observation window', () => {
  const tracker=createFocusTracker(); let state;
  for(let t=0;t<=60000;t+=200) {
    state=tracker.update({...healthy,eyesClosed:t>2000 && t%4000===0},t);
    if(t>=IDLE_AT+100)assert.equal(state.reason,'idle');
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
    vector[0]+=.02*Math.sin(t/500);vector[2]+=.015*Math.sin(t/300);vector[3]+=.015*Math.sin(t/300);
    state=tracker.update({...healthy,body:false,activityVector:vector},t);
    if(t>=IDLE_AT+100)assert.equal(state.reason,'idle');
  }
  assert.equal(state.tracking,false);
});
test('a one-frame head landmark spike does not restart the idle countdown', () => {
  const tracker=createFocusTracker();let state;
  for(let t=0;t<=46000;t+=200){
    const vector=[...healthy.activityVector];if(t===20000)vector[0]+=.2;
    state=tracker.update({...healthy,activityVector:vector},t);
  }
  assert.equal(state.reason,'idle');
});
test('reading with short bilateral horizontal or vertical gaze shifts keeps timing with a still head', () => {
  for(const [left,right,step] of [[2,3,.06],[7,8,.04]]) {
    const tracker=createFocusTracker();
    for(let t=0;t<=45000;t+=100){
      const activityVector=[...healthy.activityVector];
      const offset=Math.floor(t%1600/400)*step;
      activityVector[left]+=offset;activityVector[right]+=offset;
      const state=tracker.update({...healthy,activityVector},t);
      if(t>=2000)assert.equal(state.tracking,true,`${left}:${t}`);
    }
  }
});
test('gaze shifts alone release idle while a single-eye change or one-frame jump does not', () => {
  const tracker=createFocusTracker();advance(tracker,healthy,0,IDLE_AT);
  for(let t=IDLE_AT+200;t<=IDLE_AT+4500;t+=100){
    const activityVector=[...healthy.activityVector],offset=Math.floor((t-(IDLE_AT+200))%1600/400)*.06;
    activityVector[2]+=offset;activityVector[3]+=offset;
    tracker.update({...healthy,activityVector},t);
  }
  assert.equal(tracker.update(healthy,IDLE_AT+4600).tracking,true);
  for(const bilateral of [false,true]) {
    const paused=createFocusTracker();advance(paused,healthy,0,IDLE_AT);
    for(let t=IDLE_AT+200;t<=IDLE_AT+4500;t+=100){
      const activityVector=[...healthy.activityVector];
      if(!bilateral || t===IDLE_AT+500){activityVector[2]+=.4;if(bilateral)activityVector[3]+=.4;}
      paused.update({...healthy,activityVector},t);
    }
    assert.equal(paused.update(healthy,IDLE_AT+4600).reason,'idle');
  }
});
test('iris loss and reacquisition do not count as gaze movement', () => {
  const tracker=createFocusTracker();advance(tracker,healthy,0,IDLE_AT);
  for(let t=IDLE_AT+200;t<=IDLE_AT+4500;t+=100){
    const activityVector=[...healthy.activityVector];activityVector[2]=activityVector[3]=.9;
    assert.equal(tracker.update({...healthy,gazeValid:t>=IDLE_AT+1500,activityVector},t).reason,'idle');
  }
});
test('subtle gaze movements release idle after the same two-second recovery wait', () => {
  for(const [left,right,delta] of [[2,3,.035],[7,8,.028]]) {
    const tracker=createFocusTracker();advance(tracker,healthy,0,IDLE_AT);
    const activityVector=[...healthy.activityVector];activityVector[left]+=delta;activityVector[right]+=delta;
    const signals={...healthy,activityVector};
    advance(tracker,signals,IDLE_AT+200,IDLE_AT+2000,200);
    assert.equal(tracker.update(signals,IDLE_AT+2199).tracking,false);
    assert.equal(tracker.update(signals,IDLE_AT+2200).tracking,true);
  }
});
test('development panel shows whether iris tracking is available and moving', () => {
  const tracker=createFocusTracker();advance(tracker,healthy,0,2000);
  const label=()=>focusDebugRows(tracker.getDebug()).find(row=>row.key==='idle').text;
  assert.match(label(),/시선 추적 중/);
  tracker.update({...healthy,activityVector:[.5,.5,.62,.62,0,.4,0,0,0]},2200);
  assert.match(label(),/시선 변화 감지/);
  tracker.update({...healthy,gazeValid:false},2400);
  assert.match(label(),/시선 확인 불가/);
});
test('moderate sustained movement releases idle sooner, while a brief phone appearance never pauses time', () => {
  const tracker=createFocusTracker();advance(tracker,healthy,0,IDLE_AT);
  const moving={...healthy,activityVector:[.56,.5,.5,.5,0,.4,0,0,0]};
  assert.equal(advance(tracker,moving,IDLE_AT+500,IDLE_AT+4000,250).tracking,true);
  assert.equal(tracker.update({...moving,phoneUse:true},IDLE_AT+4250).tracking,true);
  assert.equal(tracker.update(moving,IDLE_AT+4500).tracking,true);
});
test('small sustained head and gaze movements release idle without requiring shoulders', () => {
  for (const changes of [[[0,.04]], [[4,.2]], [[6,.15]], [[2,.2],[3,.2]], [[7,.15],[8,.15]]]) {
    const tracker=createFocusTracker();
    advance(tracker,{...healthy,body:false},0,IDLE_AT);
    const activityVector=[...healthy.activityVector];
    for(const [index,delta] of changes) activityVector[index]+=delta;
    const moving={...healthy,body:false,activityVector};
    advance(tracker,moving,IDLE_AT+200,IDLE_AT+2000,200);
    assert.ok(tracker.getDebug().rows.find(row=>row.key==='idle').elapsedMs<2000,JSON.stringify(changes));
    assert.equal(advance(tracker,moving,IDLE_AT+2200,IDLE_AT+4200,200).tracking,true);
  }
});
test('small sustained neck turns and tilts release idle without waiting for large face motion', () => {
  for (const [index,delta] of [[4,.12],[5,.12],[6,.09]]) {
    const tracker=createFocusTracker();
    advance(tracker,{...healthy,body:false},0,IDLE_AT);
    const activityVector=[...healthy.activityVector];activityVector[index]+=delta;
    const moving={...healthy,body:false,activityVector};
    advance(tracker,moving,IDLE_AT+200,IDLE_AT+2000,200);
    assert.ok(tracker.getDebug().rows.find(row=>row.key==='idle').elapsedMs<1000,`${index}:${delta}`);
    assert.equal(advance(tracker,moving,IDLE_AT+2200,IDLE_AT+4200,200).tracking,true);
  }
});

test('phone confirmation takes priority when the phone covers the face', () => {
  const tracker=createFocusTracker();advance(tracker,healthy,0,2000);
  const covered={...healthy,face:false,body:false,phoneUse:true};
  assert.equal(tracker.update(covered,2250).tracking,false);
  const state=tracker.update(covered,3000);
  assert.equal(state.reason,'phone');assert.equal(state.tracking,false);assert.equal(state.status,'paused');
});
test('missing/partial observations use bounded grace and long gaps cannot keep crediting time', () => {
  for (const signals of [null, {}, { ...healthy, reliable: false }]) {
    const tracker = createFocusTracker(); advance(tracker, healthy, 0, 2000);
    assert.equal(tracker.update(signals, 2500).tracking, false);
    assert.equal(advance(tracker,signals,3000,7500).tracking,false);
  }
  const tracker = createFocusTracker(); advance(tracker, healthy, 0, 2000);
  assert.equal(tracker.update(healthy, 9000).tracking, false);
  assert.equal(advance(tracker, healthy, 9500, 11000).tracking, true);
  tracker.reset(); assert.equal(tracker.update(healthy, 12000).tracking, false);
});
test('face loss with visible shoulders uses the same uninterrupted five-second grace', () => {
  const tracker=createFocusTracker();advance(tracker,healthy,0,2000);
  assert.equal(tracker.update({...healthy,face:false,body:true},2500).tracking,false);
  assert.equal(advance(tracker,{...healthy,face:false,body:false},3000,7000).tracking,false);
  const paused=tracker.update({...healthy,face:false,body:true},7500);
  assert.equal(paused.reason,'away');assert.equal(paused.status,'paused');assert.equal(paused.tracking,false);
});
test('brief face losses hold credit without resetting the idle observation clock', () => {
  const tracker=createFocusTracker();let state;
  for(let t=0;t<=23000;t+=500){
    const missing=t===10000||t===15000;
    state=tracker.update({...healthy,face:!missing,body:true},t);
    if(t>=2000&&t<IDLE_AT)assert.equal(state.tracking,!missing);
  }
  assert.equal(state.reason,'idle');
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
test('missing iris or eyelid detail does not discard an otherwise valid face', () => {
  const s=scene();delete s.face.faceLandmarks[0][468];delete s.face.faceLandmarks[0][160];
  const signals=extractFocusSignals(s.face,{landmarks:[]},s.hands,[],100,100);
  assert.equal(signals.face,true);assert.equal(signals.eyesClosed,false);assert.ok(signals.activityVector.every(Number.isFinite));
});
test('a mild bilateral eye squint from smiling is not treated as sleep', () => {
  const s=scene(), face=s.face.faceLandmarks[0];
  for (const i of [160,158,385,387]) face[i].y=.293;
  for (const i of [153,144,373,380]) face[i].y=.307;
  assert.equal(extractFocusSignals(s.face,s.pose,s.hands,[],100,100).eyesClosed,false);
  for (const i of [160,158,385,387]) face[i].y=.296;
  for (const i of [153,144,373,380]) face[i].y=.304;
  assert.equal(extractFocusSignals(s.face,s.pose,s.hands,[],100,100).eyesClosed,true);
});
test('avatar face points bridge short misses, expire at three seconds, and update on reacquisition', () => {
  const tracker=createFaceContinuity(),s=scene();
  const initial=tracker.update(s.face,0);
  assert.equal(initial.length,3);
  assert.deepEqual(tracker.update({faceLandmarks:[]},100),initial);
  assert.deepEqual(tracker.update({faceLandmarks:[]},3000),initial);
  assert.equal(tracker.update({faceLandmarks:[]},3100),null);
  s.face.faceLandmarks[0][1].x=.6;
  assert.equal(tracker.update(s.face,3200)[0].x,.6);
  assert.equal(tracker.update({faceLandmarks:[]},10000),null);
});
const phone = { class: 'cell phone', score: .9, bbox: [40,50,20,25] };
test('phone use depends only on a confidence of at least twenty percent', () => {
  const s = scene();
  const extract = () => extractFocusSignals(s.face,s.pose,s.hands,[phone],100,100);
  assert.equal(extract().phoneUse, true);
  assert.equal(extractFocusSignals(s.face,{landmarks:[]},s.hands,[phone],100,100).phoneUse,true);
  assert.equal(extractFocusSignals(s.face,{landmarks:[]},s.hands,[{...phone,score:.35}],100,100).phoneUse,true);
  assert.equal(extractFocusSignals(s.face,{landmarks:[]},s.hands,[{...phone,score:.2,bbox:[40,80,20,20]}],100,100).phoneUse,true);
  assert.equal(extractFocusSignals(s.face,s.pose,s.hands,[{...phone,bbox:[40,80,20,20]}],100,100).phoneUse,true);
  s.hands.landmarks = [[{ x:.5,y:.6 }]];
  assert.equal(extract().phoneUse, true);
  s.hands.landmarks = []; s.pose.landmarks[0][15] = { x:.5,y:.6,visibility:.9 };
  assert.equal(extract().phoneUse, true);
  assert.equal(extractFocusSignals(s.face,s.pose,s.hands,[{ ...phone,score:.199 }],100,100).phoneUse,false);
  assert.equal(extractFocusSignals(s.face,s.pose,s.hands,[{ ...phone,score:.25 }],100,100).phoneUse,true);
  assert.equal(extractFocusSignals(s.face,s.pose,s.hands,[{ ...phone,score:.4 }],100,100).phoneUse,true);
});
test('legacy: a below-threshold phone does not prevent close-up detection', async () => {
  const previous=globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas=class{getContext(){return {drawImage(){},getImageData(){return {};}};}};
  const s=scene(),model=result=>({detectForVideo:()=>result,close(){}});
  let calls=0;
  const engine=await createCameraInference({FilesetResolver:{forVisionTasks:async()=>({})},FaceLandmarker:{createFromOptions:async()=>model(s.face)},PoseLandmarker:{createFromOptions:async()=>model({landmarks:[]})},HandLandmarker:{createFromOptions:async()=>model(s.hands)}},
    {load:async()=>({detect:async()=>++calls===1?[{...phone,score:.19,bbox:[40,85,20,10]}]:[{...phone,score:.2,bbox:[10,20,15,25]}],dispose(){}})},
    {setBackend:async()=>true,ready:async()=>{},getBackend:()=> 'cpu'},undefined,{phoneRedesign:false});
  try {
    await engine.detect({width:100,height:100},0);
    await new Promise(resolve=>setTimeout(resolve,0));
    const result=await engine.detect({width:100,height:100},100);
    assert.equal(calls,2);
    assert.equal(result.signals.phoneUse,true);
    assert.equal(result.signals.phoneObservation.positive,true);
  } finally {engine.close();if(previous===undefined)delete globalThis.OffscreenCanvas;else globalThis.OffscreenCanvas=previous;}
});
test('legacy: low-confidence diagnostic candidates reach the display without triggering phone use', async () => {
  const previous=globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas=class{getContext(){return {drawImage(){},getImageData(){return {};}};}};
  const s=scene(),model=result=>({detectForVideo:()=>result,close(){}}),thresholds=[];
  const engine=await createCameraInference({FilesetResolver:{forVisionTasks:async()=>({})},FaceLandmarker:{createFromOptions:async()=>model(s.face)},PoseLandmarker:{createFromOptions:async()=>model(s.pose)},HandLandmarker:{createFromOptions:async()=>model(s.hands)}},
    {load:async()=>({detect:async(source,count,threshold)=>{thresholds.push(threshold);return [{...phone,score:.057}];},dispose(){}})},
    {setBackend:async()=>true,ready:async()=>{},getBackend:()=> 'cpu'},undefined,{phoneRedesign:false});
  try {
    await engine.detect({width:100,height:100},0);
    await new Promise(resolve=>setTimeout(resolve,0));
    const result=await engine.detect({width:100,height:100},100);
    assert.deepEqual(thresholds,[.2,.2,.2]);
    assert.equal(result.signals.phoneUse,false);
    assert.equal(result.signals.phoneEvidence.score,.057);
  } finally {engine.close();if(previous===undefined)delete globalThis.OffscreenCanvas;else globalThis.OffscreenCanvas=previous;}
});

test('legacy: a phone found only by the edge sweep reaches the focus tracker', async () => {
  const previous=globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas=class{getContext(){return {drawImage(){},getImageData(_x,_y,width,height){return {width,height};}};}};
  const s=scene(),model=result=>({detectForVideo:()=>result,close(){}});
  let calls=0;
  const engine=await createCameraInference({FilesetResolver:{forVisionTasks:async()=>({})},FaceLandmarker:{createFromOptions:async()=>model(s.face)},PoseLandmarker:{createFromOptions:async()=>model({landmarks:[]})},HandLandmarker:{createFromOptions:async()=>model({landmarks:[]})}},
    {load:async()=>({detect:async()=>++calls===3?[{...phone,score:.3,bbox:[10,20,15,25]}]:[],dispose(){}})},
    {setBackend:async()=>true,ready:async()=>{},getBackend:()=> 'cpu'},undefined,{phoneRedesign:false});
  try {
    await engine.detect({width:100,height:100},0);
    await new Promise(resolve=>setTimeout(resolve,0));
    const result=await engine.detect({width:100,height:100},100);
    assert.equal(calls,3);
    assert.equal(result.signals.phoneObservation.positive,true);
    assert.equal(result.signals.phoneEvidence.score,.3);
  } finally {engine.close();if(previous===undefined)delete globalThis.OffscreenCanvas;else globalThis.OffscreenCanvas=previous;}
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
test('phone diagnostics show confidence below twenty percent and distinguish missing candidates', () => {
  const s=scene();
  for(const [objects,stage]of [[[],'not-found'],[[{...phone,score:.057}],'weak'],[[{...phone,score:.2}],'using'],[[phone],'using']]){
    const evidence=extractFocusSignals(s.face,s.pose,s.hands,objects,100,100).phoneEvidence;
    const tracker=createFocusTracker();tracker.update({...healthy,phoneEvidence:evidence},0);
    assert.equal(evidence.stage,stage);
    assert.notEqual(focusDebugRows(tracker.getDebug()).find(row=>row.key==='phone').text,'미감지');
    const text=focusDebugRows(tracker.getDebug()).find(row=>row.key==='phone').text;
    if(stage==='weak')assert.match(text,/5\.7% · 20% 미만/);
    if(stage==='not-found')assert.match(text,/점수 없음/);
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

test('phone close-ups separate distant hands and sweep all frame corners without landmarks', () => {
  const hands={landmarks:[[{x:.08,y:.85}],[{x:.92,y:.85}]]};
  for(let scan=0;scan<4;scan++){
    const regions=phoneSearchRegions({landmarks:[]},hands,scan);
    for(const [index,hand] of regions.entries()){
      const point=hands.landmarks[index][0];
      assert.ok(hand.width<.5);
      assert.ok(point.x>=hand.x && point.x<=hand.x+hand.width);
      assert.ok(point.y>=hand.y && point.y<=hand.y+hand.height);
    }
    const sweep=phoneSearchRegions({landmarks:[]},{landmarks:[]},scan)[1];
    assert.equal(sweep.x,scan%2?.4:0);
    assert.equal(sweep.y,scan>=2?.4:0);
    assert.ok(sweep.x+sweep.width<=1 && sweep.y+sweep.height<=1);
  }
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
  assert.equal(send(2200,{...healthy,phoneUse:true}).tracking,true);
  assert.equal(send(3800,{...healthy,phoneUse:true}).reason,'phone');
  send(4000); assert.equal(send(6000).tracking,true);
  assert.equal(send(9001,healthy,6000).tracking,false);
  for(let t=9501;t<14001;t+=500)assert.equal(send(t,healthy,6000).tracking,false);
  assert.equal(send(14001,healthy,6000).tracking,false);
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
test('returning from a long background suspension restarts video and the frame loop, rejecting old frames', async () => {
  let now=0,plays=0,watch;
  const handlers={},events={},workers=[],posted=[];
  const video={setAttribute(){},readyState:2,currentTime:1,paused:false,play(){plays++;this.paused=false;return Promise.resolve();}};
  const document={hidden:false,createElement:()=>video,querySelector:()=>null,addEventListener:(name,fn)=>handlers[name]=fn};
  class Worker{constructor(){workers.push(this);}postMessage(data){posted.push(data);}terminate(){this.terminated=true;}}
  const code=(await readFile(new URL('../camera.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'').replaceAll('import.meta.url',JSON.stringify(import.meta.url));
  const context=vm.createContext({URL,Worker,document,crypto,Event,createFocusTracker,setTimeout:()=>1,clearTimeout(){},setInterval:fn=>{watch=fn;return 1;},clearInterval(){},
    createImageBitmap:async()=>({close(){}}),performance:{now:()=>now},facePose:()=>null,window:{addEventListener:(name,fn)=>events[name]=fn,dispatchEvent(){}}});
  vm.runInContext(`${code}\nenabled=true;stream={getVideoTracks:()=>[{muted:false}]};startRecognitionWorker(revision);ready=true;inFlight=true;startCameraWatchdog(revision);globalThis.controller={cameraState,flight:()=>inFlight};`,context);
  document.hidden=true;handlers.visibilitychange();now=60000;watch();
  assert.equal(workers.length,1);assert.notEqual(workers[0].terminated,true);
  video.paused=true;document.hidden=false;handlers.visibilitychange();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(plays,1);
  const frame=posted.find(data=>data.type==='frame');assert.ok(frame);assert.ok(frame.epoch>0);
  workers[0].onmessage({data:{type:'result',epoch:0,time:now,signals:healthy}});
  workers[0].onmessage({data:{type:'error',stage:'frame',epoch:0,message:'old background frame failed'}});
  assert.equal(workers.length,1);
  assert.equal(context.controller.flight(),true);
  for(let step=0;step<=2000;step+=500){now=60000+step;workers[0].onmessage({data:{type:'result',epoch:frame.epoch,time:now,signals:healthy}});}
  assert.equal(context.controller.cameraState().tracking,true);
  events.pagehide({persisted:true});assert.equal(context.controller.cameraState().enabled,true);
  events.pageshow({persisted:true});await new Promise(resolve=>setImmediate(resolve));
  assert.ok(posted.filter(data=>data.type==='frame').length>=2);
});
test('legacy: WASM inference preserves 800ms object cadence in standard and light mode', async () => {
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
      const engine=await createCameraInference(vision,coco,tf,undefined,{light,phoneRedesign:false});
      try{
        const first=await engine.detect({width:100,height:100},0);
        await new Promise(resolve=>setTimeout(resolve,0));
        await new Promise(resolve=>setImmediate(resolve));
        await engine.detect({width:100,height:100},200);await engine.detect({width:100,height:100},800);
        await new Promise(resolve=>setTimeout(resolve,0));
        assert.equal(first.backend,'wasm');assert.equal(calls.length,2);assert.equal(calls[0][2],.2);
        assert.equal(base,light?'lite_mobilenet_v2':'mobilenet_v2');
      }finally{engine.close();}
    }
  }finally{if(previous===undefined)delete globalThis.OffscreenCanvas;else globalThis.OffscreenCanvas=previous;}
});
