import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const cacheSource=(await readFile(new URL('../client-cache.js',import.meta.url),'utf8')).replace(/^export /gm,'');
const source=cacheSource+'\n'+(await readFile(new URL('../data.js',import.meta.url),'utf8'))
  .replace(/^import .*;\r?\n/gm,'').replace('export function getStudyData','function getStudyData').split('\ntry {\n  authServices')[0];

test('camera startup errors keep the focus exit enabled and close without saving a nonexistent session',async()=>{
  const clicks=[],camera={enabled:false,tracking:false,status:'error'};
  const stop={disabled:true,dataset:{studyAction:'stop'}};
  let stopped=0,closed=0;
  const context=vm.createContext({
    cameraController:'controller',cameraState:()=>camera,getAuthUser:()=>null,
    stopCamera:()=>{stopped++;},closeCameraFocus:async()=>{closed++;},
    document:{querySelectorAll:selector=>['[data-study-action]','.camera-focus [data-study-action="stop"]'].includes(selector)?[stop]:[],
      addEventListener:(name,handler)=>{if(name==='click')clicks.push(handler);}},
    window:{addEventListener(){},setInterval(){}},
  });
  vm.runInContext(`${source}\npaintTimer();`,context);
  assert.equal(stop.disabled,false);
  const event={target:{closest:selector=>selector==='[data-study-action]'?stop:null}};
  for(const click of clicks)await click(event);
  assert.equal(stopped,1);assert.equal(closed,1);
});

function timerUi(skew) {
  let now=100000,monotonic=0;
  const handlers={},display={textContent:''},camera={tracking:true,enabled:true};
  const context=vm.createContext({
    Date:class extends Date {static now(){return now+skew;}},performance:{now:()=>monotonic},
    cameraController:'controller',cameraState:()=>camera,getAuthUser:()=>null,
    document:{hidden:false,querySelectorAll:selector=>selector==='[data-active-timer]'?[display]:[],addEventListener(){}},
    window:{addEventListener:(name,handler)=>{handlers[name]=handler;},setInterval(){}},
  });
  vm.runInContext(`${source}\nglobalThis.ui={observeSession,observeCameraReply,paintTimer,syncCamera};`,context);
  const configure = (send, sessionId = 'session') => {
    context.send = send;
    context.sessionId = sessionId;
    vm.runInContext('call=()=>send;state.profile={activeSessionId:sessionId};', context);
  };
  return {display,camera,handlers,ui:context.ui,configure,tick:ms=>{now+=ms;monotonic+=ms;},snapshot:(seconds,active=true,sequence=1)=>({
    cameraMode:true,controllerId:'controller',sequence,accumulatedSeconds:seconds,
    updatedAt:{toMillis:()=>now},activeSinceMs:active?now:null,leaseUntilMs:active?now+30000:null,
  })};
}

test('failed camera session creation displays the error inside the focus screen',async()=>{
  const clicks=[],camera={enabled:true,tracking:true,status:'tracking'};
  const button={disabled:false,dataset:{studyAction:'start'},hasAttribute:()=>true};
  const user={uid:'owner',emailVerified:true};
  const context=vm.createContext({
    cameraController:'controller',cameraState:()=>camera,getAuthUser:()=>user,
    openCameraFocus(){},startCamera:async()=>true,
    stopCamera:(message,error)=>{camera.enabled=false;camera.tracking=false;camera.status=error?'error':'off';camera.message=message;},
    document:{querySelectorAll:()=>[],querySelector:()=>null,addEventListener:(name,handler)=>{if(name==='click')clicks.push(handler);}},
    window:{addEventListener(){},setInterval(){},dispatchEvent(){}},Event:class {},
  });
  vm.runInContext(`${source}\nauthServices={auth:{currentUser:{getIdToken:async()=>{}}}};call=()=>async()=>{throw {code:'functions/unavailable'};};globalThis.message=cameraTimerMessage;`,context);
  for(const click of clicks)await click({target:{closest:selector=>selector==='[data-study-action]'?button:null}});
  assert.equal(camera.status,'error');
  assert.match(context.message(camera),/저장 서비스에 연결하지 못했습니다/);
});

test('Focus Time shows saved currency independently of the active timer and total study time', async () => {
  const balance={textContent:''};
  const context=vm.createContext({
    cameraState:()=>({}),getAuthUser:()=>({uid:'owner'}),cameraController:'controller',
    document:{querySelectorAll:selector=>selector==='[data-focus-balance]'?[balance]:[],addEventListener(){},querySelector:()=>null},
    window:{addEventListener(){},dispatchEvent(){},setInterval(){}},Event:class {},
  });
  vm.runInContext(`${source}\nauthResolved=true;state.pending.clear();state.focusTime={balanceSeconds:3661};state.summary={totalSeconds:999999};paint();`,context);
  assert.equal(balance.textContent,'01:01:01');
  vm.runInContext('paintTimer();',context);
  assert.equal(balance.textContent,'01:01:01');
  vm.runInContext('state.focusTime={balanceSeconds:61};paint();',context);
  assert.equal(balance.textContent,'00:01:01');
  vm.runInContext('state.focusTime={};paint();',context);
  assert.equal(balance.textContent,'00:00:00');
  const html=await readFile(new URL('../play.html',import.meta.url),'utf8');
  assert.match(html,/data-focus-balance/);
  assert.doesNotMatch(html,/data-active-timer/);
});

for(const skew of [6000,-6000])test(`camera timer starts at zero and pauses/resumes without device clock skew ${skew}`,()=>{
  const t=timerUi(skew);
  t.ui.observeSession(t.snapshot(0));t.ui.paintTimer();assert.equal(t.display.textContent,'00:00:00');
  t.tick(3000);t.ui.paintTimer();assert.equal(t.display.textContent,'00:00:03');
  t.camera.tracking=false;t.handlers['study:camera-changed']();
  t.tick(2000);t.ui.paintTimer();assert.equal(t.display.textContent,'00:00:03');
  // Resuming before the pause acknowledgement must not count the paused gap.
  t.camera.tracking=true;t.handlers['study:camera-changed']();
  t.ui.paintTimer();assert.equal(t.display.textContent,'00:00:03');
  t.ui.observeSession(t.snapshot(3,true,2));t.ui.paintTimer();assert.equal(t.display.textContent,'00:00:03');
  t.tick(2000);t.ui.paintTimer();assert.equal(t.display.textContent,'00:00:05');
  t.camera.tracking=false;t.handlers['study:camera-changed']();
  t.ui.observeSession(t.snapshot(5,false,3));t.ui.paintTimer();assert.equal(t.display.textContent,'00:00:05');
  t.tick(6000);t.ui.paintTimer();assert.equal(t.display.textContent,'00:00:05');
});

test('camera display stops extrapolating when its server lease expires',()=>{
  const t=timerUi(6000);t.ui.observeSession(t.snapshot(0));
  t.tick(40000);t.ui.paintTimer();assert.equal(t.display.textContent,'00:00:30');
});

test('camera starts from the server reply without waiting for a session listener',async()=>{
  const t=timerUi(6000),requests=[];
  t.configure(async request=>{
    requests.push(request);
    return {data:{session:{sequence:request.sequence,serverNowMs:100000,activeSinceMs:100000,leaseUntilMs:130000,accumulatedSeconds:0}}};
  });
  t.ui.observeCameraReply({session:{cameraMode:true,controllerId:'controller',sequence:0,startedAtMs:100000,serverNowMs:100000,activeSinceMs:null,leaseUntilMs:null}},'session');
  await t.ui.syncCamera();
  assert.equal(requests.length,1);
  t.tick(3000);t.ui.paintTimer();
  assert.equal(t.display.textContent,'00:00:03');
  // A queued pre-sync snapshot must not put the acknowledged timer back on pause.
  t.ui.observeSession(t.snapshot(0,false,0));
  t.tick(2000);t.ui.paintTimer();
  assert.equal(t.display.textContent,'00:00:05');
});

test('a camera acknowledgement cannot update a different active session',async()=>{
  const t=timerUi(0);
  t.configure(async()=>({data:{}}),'new-session');
  t.ui.observeSession(t.snapshot(0,false,0));
  t.ui.observeCameraReply({session:{sequence:1,serverNowMs:100000,activeSinceMs:100000,leaseUntilMs:130000}},'old-session');
  t.tick(3000);t.ui.paintTimer();
  assert.equal(t.display.textContent,'00:00:00');
});

test('status-only camera events do not add writes and heartbeats use a twenty-second interval',async()=>{
  const t=timerUi(0),requests=[];
  t.configure(async request=>{requests.push(request);return {data:{}};});
  t.ui.observeSession(t.snapshot(0));
  await t.ui.syncCamera();
  for(let i=0;i<100;i++)await t.ui.syncCamera(true);
  assert.equal(requests.length,1);
  t.tick(19000);await t.ui.syncCamera();assert.equal(requests.length,1);
  t.tick(1000);await t.ui.syncCamera();assert.equal(requests.length,2);
  t.camera.tracking=false;await t.ui.syncCamera(true);
  assert.equal(requests.length,3);assert.equal(requests.at(-1).tracking,false);
});

test('connection failures back off instead of retrying every second',async()=>{
  const t=timerUi(0);let calls=0;
  t.configure(async()=>{calls++;throw Error('offline');});
  t.ui.observeSession(t.snapshot(0));await t.ui.syncCamera();
  for(let i=0;i<4;i++){t.tick(1000);await t.ui.syncCamera(true);}
  assert.equal(calls,1);
  t.tick(1000);await t.ui.syncCamera();assert.equal(calls,2);
  t.tick(9000);await t.ui.syncCamera();assert.equal(calls,2);
  t.tick(1000);await t.ui.syncCamera();assert.equal(calls,3);
  t.camera.tracking=false;await t.ui.syncCamera();assert.equal(calls,4);
});

function dataUi() {
  const reads=[],listeners=[],calls=[];
  const context=vm.createContext({
    queueMicrotask,Event:class {},performance:{now:()=>0},
    cameraController:'controller',cameraState:()=>({}),getAuthUser:()=>({uid:'owner',displayName:'사용자'}),
    document:{hidden:false,addEventListener(){},querySelector:()=>null,querySelectorAll:selector=>selector==='[data-time]'?[{dataset:{time:'today'}}]:[]},
    window:{addEventListener(){},setInterval(){},dispatchEvent(){}},
    mockSdk:{doc:(_, ...parts)=>parts.join('/'),getDoc:async path=>{reads.push(path);return {data:()=>({totalSeconds:60})};},onSnapshot:(path,callback)=>{listeners.push({path,callback});return ()=>{};}},
    mockCall:name=>async()=>{calls.push(name);return {data:{}};},
  });
  vm.runInContext(`${source}\nsdk=mockSdk;call=mockCall;globalThis.dataUi={connectUser,loadVisibleData,revision:value=>{state.profile.studyRevision=value;},reset:()=>{connectedUid=null;},logout:()=>{generation++;connectedUid=null;state=emptyState();}};`,context);
  return {context,reads,listeners,calls,ui:context.dataUi};
}

test('existing users keep one profile listener and fetch only visible statistics once until completion',async()=>{
  const t=dataUi();
  const pending=t.ui.connectUser();
  assert.deepEqual(t.listeners.map(row=>row.path),['users/owner']);
  t.listeners[0].callback({data:()=>({uid:'owner',activeSessionId:null,studyRevision:0})});
  await pending;await t.ui.loadVisibleData();
  assert.equal(t.calls.length,0);
  assert.equal(t.reads.length,1);assert.match(t.reads[0],/dailyStats/);
  await t.ui.loadVisibleData();assert.equal(t.reads.length,1);
  t.ui.revision(1);await t.ui.loadVisibleData();assert.equal(t.reads.length,2);
  assert.equal(t.listeners.length,1);
  // Reopening the app with the same persisted revision reuses the same cache.
  t.ui.reset();const reopened=t.ui.connectUser();
  t.listeners[1].callback({data:()=>({uid:'owner',activeSessionId:null,studyRevision:1})});
  await reopened;await t.ui.loadVisibleData();assert.equal(t.reads.length,2);
});

test('new users create a profile once instead of on every profile snapshot',async()=>{
  const t=dataUi(),pending=t.ui.connectUser();
  t.listeners[0].callback({data:()=>null});
  t.listeners[0].callback({data:()=>null});
  await pending;assert.deepEqual(t.calls,['ensureProfile']);
  t.listeners[0].callback({data:()=>({uid:'owner'})});
  await t.ui.loadVisibleData();assert.equal(t.calls.length,1);
});

test('first detection starts the timer even when the paused sync snapshot is delayed',async()=>{
  const t=timerUi(0),requests=[];
  let acknowledge;
  t.configure(request=>{requests.push(request);return new Promise(resolve=>{acknowledge=resolve;});});
  t.camera.tracking=false;t.handlers['study:camera-changed']();
  t.ui.observeSession(t.snapshot(0,false,0));
  const pending=t.ui.syncCamera();
  assert.equal(requests[0].sequence,1);
  t.handlers['study:camera-changed']();
  t.camera.tracking=true;t.handlers['study:camera-changed']();
  acknowledge();await pending;
  assert.equal(requests.length,2);
  assert.equal(requests[1].tracking,true);
  assert.equal(requests[1].sequence,2);
  // Status-only changes during recognition must not move the awaited acknowledgement.
  t.handlers['study:camera-changed']();
  acknowledge();await Promise.resolve();
  t.ui.observeSession(t.snapshot(0,true,2));
  t.tick(3000);t.ui.paintTimer();
  assert.equal(t.display.textContent,'00:00:03');
});

test('camera pause messages distinguish manual pause, setup, detection failure and connection errors',()=>{
  const context=vm.createContext({
    cameraController:'controller',cameraState:()=>({}),getAuthUser:()=>null,
    document:{hidden:false,addEventListener(){}},window:{addEventListener(){},setInterval(){}},
  });
  vm.runInContext(`${source}\nglobalThis.message=cameraTimerMessage;`,context);
  const message=context.message;
  assert.match(message({manuallyPaused:true}),/사용자가 수동/);
  assert.match(message({enabled:true,status:'opening'}),/최초 얼굴 인식을 준비/);
  assert.match(message({enabled:true,status:'scanning',tracking:false}),/최초 얼굴 인식을 준비/);
  assert.match(message({enabled:true,status:'paused'}),/얼굴 인식에 실패/);
  assert.match(message({enabled:true,status:'error'}),/카메라 인식 오류/);
  assert.match(message({enabled:false,status:'off'}),/카메라가 종료/);
  assert.match(message({enabled:true,status:'tracking',tracking:true}),/동기화/);
  assert.match(message({enabled:true,status:'paused',message:'카메라 영상 중단 · 일시정지'}),/카메라 영상 중단/);
  context.document.hidden=true;
  assert.match(message({enabled:true,status:'paused'}),/화면을 벗어나/);
  context.document.hidden=false;
  vm.runInContext('cameraSyncFailed=true;',context);
  assert.match(message({enabled:true,status:'tracking'}),/서버 연결/);
  assert.match(message({manuallyPaused:true}),/사용자가 수동/);
});
