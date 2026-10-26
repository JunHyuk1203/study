// Diagnostic reproductions of the reviewed implementation, not production tests.
// Run from the repository root: node --test docs/reviews/evidence/reproduce-camera-sync.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {AutoStudyTimer} from './spword-timer-core.snapshot.mjs';
import {createCameraInference} from '../../../camera-inference.js';
import {createFocusTracker} from '../../../camera-focus.js';

const root = new URL('../../../', import.meta.url);
const load = path => readFile(new URL(path, root), 'utf8');
const store = () => {let value=null;return {read:()=>value,write:next=>{value=next;}};};

test('R1: await finish resolves before the in-flight heartbeat and final save', async () => {
  let now=100000, release, finishes=0;
  const gate=new Promise(resolve=>{release=resolve;});
  const session={sequence:0,startedAtMs:now,serverNowMs:now,activeSinceMs:now,leaseUntilMs:now+10000};
  const timer=new AutoStudyTimer({store:store(),now:()=>now,heartbeatMs:5000,api:{
    start:async()=>({sessionId:'s',session,initialSyncComplete:true}),
    sync:async()=>{await gate;return {session:{...session,sequence:1}};},
    finish:async()=>{finishes++;return {creditedSeconds:5};},
  }});
  await timer.update(true);
  now+=5000;
  const pending=timer.update(true);
  await timer.finish();
  assert.equal(finishes,0);
  assert.equal(timer.busy,true);
  assert.equal(timer.record.sessionId,'s');
  console.log('R1: finish() returned; final-save calls=0, heartbeat still pending');
  release();await pending;
  assert.equal(finishes,1);
});

test('R2: permanently paused server response causes immediate repeated resume requests', async () => {
  let calls=0;
  const paused={sequence:0,startedAtMs:0,serverNowMs:43200000,activeSinceMs:null,leaseUntilMs:null};
  const timer=new AutoStudyTimer({store:store(),now:()=>43200000,heartbeatMs:5000,api:{
    start:async()=>({sessionId:'s',session:paused,initialSyncComplete:true}),
    sync:async()=>{
      if(++calls===4)throw new Error('diagnostic stop after fourth immediate request');
      return {session:{...paused,sequence:calls}};
    },finish:async()=>({creditedSeconds:0}),
  }});
  await timer.update(true);
  assert.equal(calls,4);
  assert.match(timer.error,/diagnostic stop/);
  console.log('R2: fixed clock, one update(), sync calls=4 without heartbeat delay');
});

async function timerHarness() {
  const source=(await load('word-time.js')).replace(/^export /gm,'')+'\n'+
    (await load('client-cache.js')).replace(/^export /gm,'')+'\n'+
    (await load('notifications.js')).replace(/^export /gm,'')+'\n'+
    (await load('data.js')).replace(/^import .*;\r?\n/gm,'')
      .replace('export function getStudyData','function getStudyData')
      .split(/\r?\ntry \{\r?\n  authServices/)[0];
  const existing=await load('tests/timer-ui.test.mjs');
  const start=existing.indexOf('function timerUi(skew)');
  const end=existing.indexOf("test('camera acknowledgements",start);
  const context={source,vm};
  vm.runInNewContext(existing.slice(start,end)+'\nglobalThis.makeTimer=timerUi;',context);
  return context.makeTimer(0);
}

test('R3: camera display retains a smaller local total after authoritative server credit', async () => {
  const t=await timerHarness();
  t.ui.observeSession(t.snapshot(0));
  t.tick(3500);t.camera.tracking=false;t.handlers['study:camera-changed']();
  t.tick(8000);const confirmed=t.snapshot(11,false,2);
  t.ui.observeSession(confirmed);t.ui.paintTimer();
  assert.equal(t.display.textContent,'00:00:03');
  assert.equal(confirmed.accumulatedSeconds,11);
  console.log('R3: screen=3 seconds, confirmed server total=11 seconds');
});

test('R5: pause and resume during an in-flight request never send a pause to the server', async () => {
  const t=await timerHarness();const requests=[];let release;
  t.configure(request=>{
    requests.push(request);
    if(requests.length===1)return new Promise(resolve=>{release=()=>resolve({data:{session:{
      sequence:request.sequence,serverNowMs:100000,activeSinceMs:100000,
      leaseUntilMs:110000,accumulatedSeconds:0,
    }}});});
    return Promise.resolve({data:{session:{...t.snapshot(4,true,request.sequence),serverNowMs:104000}}});
  });
  t.ui.observeSession(t.snapshot(0));const pending=t.ui.syncCamera();
  t.tick(1000);t.camera.tracking=false;t.handlers['study:camera-changed']();
  t.tick(2000);t.camera.tracking=true;t.handlers['study:camera-changed']();
  t.tick(1000);release();await pending;await new Promise(resolve=>setImmediate(resolve));
  assert.equal(requests.length,2);
  assert.deepEqual(Array.from(requests,row=>row.tracking),[true,true]);
  console.log('R5: local pause lasted 2 seconds; transmitted tracking states=[true,true]');
});

test('R4: one cached phone detection confirms a pause even after the next scan finds none', async () => {
  const previous=globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas=class {getContext(){return {drawImage(){},getImageData(){return {};}};}};
  const points=Array.from({length:478},()=>({x:.5,y:.4}));
  for(const [i,x,y] of [[33,.3,.3],[133,.4,.3],[160,.32,.28],[158,.38,.28],[153,.38,.32],[144,.32,.32],
    [362,.6,.3],[263,.7,.3],[385,.62,.28],[387,.68,.28],[373,.68,.32],[380,.62,.32],
    [468,.35,.3],[473,.65,.3],[1,.5,.6]])points[i]={x,y};
  let time=0, lastObjectPositive=false;
  const model=result=>({detectForVideo:()=>result,close(){}});
  const vision={FilesetResolver:{forVisionTasks:async()=>({})},
    FaceLandmarker:{createFromOptions:async()=>model({faceLandmarks:[points]})},
    PoseLandmarker:{createFromOptions:async()=>model({landmarks:[]})},
    HandLandmarker:{createFromOptions:async()=>model({landmarks:[]})}};
  const tf={setBackend:async()=>true,ready:async()=>{},getBackend:()=> 'cpu'};
  const objects={load:async()=>({detect:async()=>{
    lastObjectPositive=time===2400;
    return lastObjectPositive?[{class:'cell phone',score:.9,bbox:[30,25,30,50]}]:[];
  },dispose(){}})};
  let engine;
  try {
    engine=await createCameraInference(vision,objects,tf,undefined);
    const tracker=createFocusTracker();let decision;
    for(time=0;time<=3200;time+=200){
      const result=await engine.detect({width:100,height:100},time);
      decision=tracker.update(result.signals,time);
      if(time===2200)assert.equal(decision.tracking,true);
    }
    assert.equal(lastObjectPositive,false);
    assert.equal(decision.reason,'phone');assert.equal(decision.tracking,false);
    console.log('R4: next full/crop scan empty; cached positive still confirms phone pause');
  } finally {
    engine?.close();
    if(previous===undefined)delete globalThis.OffscreenCanvas;else globalThis.OffscreenCanvas=previous;
  }
});
