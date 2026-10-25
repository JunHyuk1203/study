import test from 'node:test';
import assert from 'node:assert/strict';
import {createPhoneTracker,createPhoneScheduler,FULL_FRAME} from '../camera-phone.js';
import {createFocusTracker} from '../camera-focus.js';
import {createCameraInference,extractFocusSignals} from '../camera-inference.js';
import './camera-detector.test.mjs';
const box=[.3,.5,.12,.2], other=[.8,.1,.1,.18];
const observation=(at,candidates=[{box,score:.85}],extra={})=>({version:3,id:at,frameId:at,observedAt:at,completedAt:at,region:FULL_FRAME,candidates,status:'ok',...extra});
test('raw YOLO evidence uses the new threshold consistently with temporal confirmation',()=>{
  const signal=score=>extractFocusSignals({faceLandmarks:[]},{landmarks:[]},{landmarks:[]},[{class:'cell phone',model:'yolov10n',score,bbox:[20,30,20,30]}],100,100);
  assert.equal(signal(.4).phoneUse,false);assert.equal(signal(.8).phoneUse,true);
});
test('phone confirmation needs separated independent frames of the same object',()=>{
  const t=createPhoneTracker();t.observe(observation(0),0);
  assert.equal(t.observe(observation(200),200).confirmed,false);
  assert.equal(t.observe(observation(450),450).confirmed,true);
  const separate=createPhoneTracker();separate.observe(observation(0),0);
  assert.equal(separate.observe(observation(500,[{box:other,score:.5}]),500).confirmed,false);
});
test('cached results and multiple regions of the same frame count once',()=>{
  const t=createPhoneTracker();t.observe(observation(0),0);
  assert.equal(t.observe(observation(0),500).confirmed,false);
  assert.equal(t.observe(observation(0,undefined,{id:'crop'}),500).confirmed,false);
  assert.equal(t.observe(observation(500),500).confirmed,true);
});
test('one missed frame is tolerated, two covered negatives release after grace',()=>{
  const t=createPhoneTracker();t.observe(observation(0),0);t.observe(observation(400),400);
  assert.equal(t.observe(observation(700,[]),700).status,'missing');
  assert.equal(t.observe(observation(1000),1000).confirmed,true);
  t.observe(observation(1300,[]),1300);
  assert.equal(t.observe(observation(2000,[]),2000).status,'released');
});
test('two positives among three recent observations confirm despite one miss',()=>{
  const t=createPhoneTracker();t.observe(observation(0),0);t.observe(observation(250,[]),250);
  assert.equal(t.observe(observation(500),500).confirmed,true);
});
test('another tile, failed model, and silence cannot manufacture negatives',()=>{
  for(const extra of [{region:{x:0,y:0,width:.1,height:.1}},{status:'error'}]){
    const t=createPhoneTracker();t.observe(observation(0),0);t.observe(observation(400),400);
    t.observe(observation(800,[],extra),800);t.observe(observation(1100,[],extra),1100);
    assert.equal(t.state(1200).confirmed,true);
    assert.equal(t.state(1500).status,'unavailable');
  }
  const t=createPhoneTracker();t.observe(observation(0),0);t.observe(observation(400),400);
  assert.equal(t.state(1500).status,'unavailable');
});
test('stale, future, malformed and out-of-order observations are discarded',()=>{
  const t=createPhoneTracker();t.observe(observation(500),500);
  t.observe(observation(400),600);t.observe(observation(700),2300);
  t.observe(observation(4000),2400);t.observe(observation(2400,undefined,{completedAt:NaN}),2400);
  assert.equal(t.state(2400).confirmed,false);
  assert.equal(t.diagnostics().discarded,4);
  assert.equal(t.diagnostics().reasons.stale,1);
});
test('weak observations can retain a candidate but cannot confirm it',()=>{
  const t=createPhoneTracker();t.observe(observation(0),0);
  assert.equal(t.observe(observation(500,[{box,score:.15}]),500).confirmed,false);
  assert.equal(t.targets(500).length,1);
  const weak=createPhoneTracker();weak.observe(observation(0,[{box,score:.15}]),0);
  assert.equal(weak.targets(0).length,1);
});
test('moderate seeds schedule a close-up without counting as pause evidence',()=>{
  const t=createPhoneTracker(),weak=[{box,score:.2}];
  for(const at of [0,500,1000])assert.equal(t.observe(observation(at,weak),at).confirmed,false);
  assert.equal(t.targets(1000).length,1);
  const s=createPhoneScheduler();s.next(640,480,1000);
  assert.match(s.next(640,480,1100,t.targets(1100)).key,/^track-/);
  assert.equal(t.observe(observation(1400),1400).confirmed,false);
  assert.equal(t.observe(observation(1900),1900).confirmed,true);
  const noise=createPhoneTracker();noise.observe(observation(0,[{box,score:.057}]),0);
  assert.equal(noise.targets(0).length,0);
});
test('repeating a hand-like weak detection never pauses, even if tight crops get strong scores',()=>{
  const t=createPhoneTracker(),crop={x:.2,y:.4,width:.3,height:.4,key:'track-1'};
  for(const at of [0,500,1000])assert.equal(t.observe(observation(at,[{box,score:.3}]),at).confirmed,false);
  assert.equal(t.observe(observation(1400,undefined,{region:crop}),1400).confirmed,false);
  assert.equal(t.observe(observation(1900,undefined,{region:crop}),1900).confirmed,false);
  assert.equal(t.observe(observation(2100,undefined,{region:{...crop,key:'tile-1-0'}}),2100).confirmed,true);
});
test('tight crops cannot keep an old context classification alive indefinitely',()=>{
  const t=createPhoneTracker(),region={...FULL_FRAME,key:'track-1'};
  t.observe(observation(0),0);
  assert.equal(t.observe(observation(500,undefined,{region}),500).confirmed,true);
  for(const at of [1500,2500,3500])t.observe(observation(at,undefined,{region}),at);
  assert.equal(t.observe(observation(4500,undefined,{region}),4500).confirmed,false);
});
test('a full-frame miss cannot erase a tiny phone it has insufficient pixels to classify',()=>{
  const t=createPhoneTracker(),tiny=[.3,.5,.02,.02],resolution={width:640,height:480,inputSize:640};
  t.observe(observation(0,[{box:tiny,score:.9}],{resolution}),0);
  t.observe(observation(500,[{box:tiny,score:.9}],{resolution}),500);
  t.observe(observation(800,[],{resolution}),800);
  assert.equal(t.observe(observation(1200,[],{resolution}),1200).confirmed,true);
  assert.equal(t.state(3100).status,'unavailable');
});
test('new candidates are checked next and deadline scans do not trigger adjacent full frames',()=>{
  const s=createPhoneScheduler(),target={trackId:1,box,lastSeen:900};
  assert.equal(s.next(640,480,0).key,'full');
  assert.match(s.next(640,480,900,[],[FULL_FRAME]).key,/hand/);
  assert.match(s.next(640,480,1800,[target]).key,/track/);
  assert.match(s.next(640,480,2700,[target]).key,/verify/);
  assert.equal(s.next(640,480,3500,[target]).key,'full');
  assert.match(s.next(640,480,4400,[{...target,lastSeen:3500}]).key,/track/);
});
test('a successful wider view is reused instead of repeatedly returning to a failed tight crop',()=>{
  const t=createPhoneTracker(),region={x:.1,y:.2,width:.5,height:.6,key:'verify-1'};
  t.observe(observation(0,[{box,score:.2}]),0);
  t.observe(observation(500,undefined,{region}),500);
  const s=createPhoneScheduler();s.next(640,480,500);
  const next=s.next(640,480,1000,t.targets(1000));
  assert.match(next.key,/verify/);assert.ok(next.width>=.5);assert.ok(next.height>=.6);
  assert.ok(Math.abs(next.x-region.x)<1e-9);assert.ok(Math.abs(next.y-region.y)<1e-9);
  assert.equal(t.observe(observation(1000,undefined,{region}),1000).confirmed,true);
});
test('weak crop boxes cannot move the next verification away from the original candidate',()=>{
  const t=createPhoneTracker();t.observe(observation(0,[{box,score:.2}]),0);
  const shifted=[box[0]+.02,box[1]+.03,box[2],box[3]];
  t.observe(observation(500,[{box:shifted,score:.4}]),500);
  assert.deepEqual(t.targets(500)[0].box,box);
  t.observe(observation(1000,[{box:shifted,score:.8}]),1000);
  assert.deepEqual(t.targets(1000)[0].box,shifted);
});
test('1.2-second inference can confirm and remain stable between independent results',()=>{
  const t=createPhoneTracker();
  const slow=at=>observation(at,undefined,{completedAt:at+1200});
  assert.equal(t.observe(slow(0),1200).confirmed,false);
  assert.equal(t.observe(slow(1500),2700).confirmed,true);
  assert.equal(t.state(4100).confirmed,true);
  assert.equal(t.observe(slow(3000),4200).confirmed,true);
  assert.equal(t.state(6701).status,'unavailable','silence must eventually expire a slow result');
  assert.equal(t.diagnostics().p95,1200);
});
test('slow completion still uses capture time to reject stale frames and require independent evidence',()=>{
  const t=createPhoneTracker();
  t.observe(observation(0,undefined,{completedAt:1200}),1200);
  assert.equal(t.observe(observation(0,undefined,{id:'crop',completedAt:1300}),1300).confirmed,false);
  assert.equal(t.observe(observation(1500,undefined,{completedAt:3100}),3100).confirmed,false);
  assert.equal(t.diagnostics().reasons.stale,1);
  assert.equal(t.diagnostics().p95,1600,'diagnostics must also measure discarded slow inference');
});
test('scheduler revisits full frame and tiles while tracking or seeing two hands',()=>{
  for(const targets of [[],[{trackId:1,box,lastSeen:0}]]){
    const s=createPhoneScheduler(),regions=[];
    for(let i=0;i<80;i++)regions.push(s.next(640,480,i*100,targets,[FULL_FRAME,FULL_FRAME]));
    assert.equal(regions[0].key,'full');
    assert.ok(regions.filter(r=>r.key==='full').length>=20);
    // 640x480 produces three columns and two rows of overlapping square tiles.
    assert.equal(new Set(regions.filter(r=>r.key.startsWith('tile')).map(r=>r.key)).size,6);
    if(targets.length)assert.ok(regions.some(r=>r.key==='track-1'));
  }
});
test('portrait and landscape tiles are square in pixels and cover the frame corners',()=>{
  for(const [w,h] of [[1280,720],[720,1280]]){
    const s=createPhoneScheduler(),tiles=[];
    for(let i=0;i<160;i++){const r=s.next(w,h,i*10);if(r.key.startsWith('tile'))tiles.push(r);}
    for(const r of tiles)assert.ok(Math.abs(r.width*w-r.height*h)<.001);
    for(const [x,y] of [[0,0],[1,0],[0,1],[1,1]])assert.ok(tiles.some(r=>x>=r.x-1e-9&&x<=r.x+r.width+1e-9&&y>=r.y-1e-9&&y<=r.y+r.height+1e-9));
  }
});
test('tracked phone pauses without face or hand and resumes only after release and healthy delay',()=>{
  const t=createFocusTracker(),healthy={reliable:true,face:true,studyActivity:true,phonePolicy:'tracked'};
  const run=(at,candidates,extra={})=>t.update({...healthy,...extra,phoneObservation:observation(at,candidates)},at);
  run(0,[]);run(1000,[]);assert.equal(run(2000,[]).tracking,true);
  assert.equal(run(2200).tracking,true);
  assert.equal(run(2700,undefined,{face:false}).reason,'phone');
  assert.equal(run(3000,[]).tracking,false);
  assert.equal(run(3700,[]).tracking,false);
  run(4700,[]);assert.equal(run(5700,[]).tracking,true);
});
test('phone inference failure does not turn a real face into an absent face',()=>{
  const t=createFocusTracker(),healthy={reliable:true,face:true,studyActivity:true,phonePolicy:'tracked',identity:{matched:true,enrolled:true}};
  t.update({...healthy,phoneObservation:observation(0,[])},0);
  const decision=t.update({...healthy,phoneObservation:observation(2000,[],{status:'error'})},2000);
  assert.equal(decision.reason,'unknown');assert.equal(decision.tracking,false);
  assert.equal(t.getDebug().rows.find(r=>r.key==='away').active,false);
  const absent=createFocusTracker();
  for(let at=0;at<=5000;at+=1000){
    const result=absent.update({...healthy,face:false,identity:{enrolled:true,matched:false},phoneObservation:observation(at,[],{status:'error'})},at);
    if(at===5000)assert.equal(result.reason,'away');
  }
});
test('inference emits phone completion independently and preserves capture time and epoch',async()=>{
  const previous=globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas=class{getContext(){return {drawImage(){},getImageData(){return {width:100,height:100};}};}};
  let resolveModel;const messages=[];
  const face=Array.from({length:478},()=>({x:.5,y:.5}));face[33]={x:.3,y:.4};face[263]={x:.7,y:.4};
  const model=result=>({detectForVideo:()=>result,close(){}});
  const engine=await createCameraInference({FilesetResolver:{forVisionTasks:async()=>({})},FaceLandmarker:{createFromOptions:async()=>model({faceLandmarks:[face]})},PoseLandmarker:{createFromOptions:async()=>model({landmarks:[]})},HandLandmarker:{createFromOptions:async()=>model({landmarks:[]})}},
    {load:async()=>({detect:()=>new Promise(resolve=>{resolveModel=resolve;}),dispose(){}})},
    {setBackend:async()=>true,ready:async()=>{},getBackend:()=> 'cpu'},undefined,{onPhoneObservation:m=>messages.push(m)});
  try {
    const result=await engine.detect({width:100,height:100},100,7);
    assert.equal(result.phonePending,true);
    assert.equal(result.signals.phonePolicy,'tracked');assert.equal(messages.length,0);
    await new Promise(resolve=>setTimeout(resolve,0));
    resolveModel([{class:'cell phone',score:.6,bbox:[30,50,12,20]}]);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(messages.length,1);assert.equal(messages[0].observation.observedAt,100);
    assert.ok(messages[0].observation.completedAt>=100);assert.equal(messages[0].epoch,7);
    assert.deepEqual(messages[0].observation.candidates[0].box,box);
    await engine.detect({width:100,height:100},500,7);await new Promise(resolve=>setTimeout(resolve,0));
    const resumed=await engine.detect({width:100,height:100},700,8);
    assert.equal(resumed.phonePending,false,'an old epoch completion will be discarded, so it must not lock new frame capture');
    resolveModel([]);await new Promise(resolve=>setImmediate(resolve));
    assert.equal(messages.length,1,'old epoch completion must be suppressed');
    const origin=performance.timeOrigin+performance.now()-1000-2000;
    await engine.detect({width:100,height:100},1000,8,origin);
    await new Promise(resolve=>setTimeout(resolve,0));resolveModel([]);
    await new Promise(resolve=>setImmediate(resolve));
    assert.ok(messages.at(-1).observation.completedAt>=3000,'completion must include time spent waiting in the Worker queue');
    assert.equal(messages.at(-1).diagnostics.reasons.stale,1);
  }finally{engine.close();if(previous===undefined)delete globalThis.OffscreenCanvas;else globalThis.OffscreenCanvas=previous;}
});
