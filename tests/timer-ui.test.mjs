import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const cacheSource=(await readFile(new URL('../client-cache.js',import.meta.url),'utf8')).replace(/^export /gm,'');
const toastSource=(await readFile(new URL('../notifications.js',import.meta.url),'utf8')).replace(/^export /gm,'');
const source=(await readFile(new URL('../word-time.js',import.meta.url),'utf8')).replace(/^export /gm,'')+'\n'+cacheSource+'\n'+toastSource+'\n'+(await readFile(new URL('../data.js',import.meta.url),'utf8'))
  .replace(/^import .*;\r?\n/gm,'').replace('export function getStudyData','function getStudyData').split(/\r?\ntry \{\r?\n  authServices/)[0];

test('production import graph creates only one instance of each shared state module',async()=>{
  const versions=new Map(),visited=new Set();
  async function visit(url) {
    if(visited.has(url.href))return;
    visited.add(url.href);
    const path=new URL(url);path.search='';
    const identities=versions.get(path.href)||new Set();identities.add(url.href);versions.set(path.href,identities);
    const code=await readFile(path,'utf8');
    for(const match of code.matchAll(/^import\s+(?:[^'";]*?\s+from\s+)?['"](\.[^'"]+)['"]/gm))await visit(new URL(match[1],url));
  }
  await visit(new URL('../app.js',import.meta.url));
  for(const [path,identities]of versions)assert.equal(identities.size,1,`Duplicate module handlers: ${path}: ${[...identities].join(', ')}`);
  for(const name of ['data.js','camera.js','integrations.js'])assert.ok([...versions.keys()].some(path=>path.endsWith('/'+name)));
});

test('page errors stay on their originating page and success messages never occupy inline status',()=>{
  const status={textContent:'',hidden:true,classList:{toggle(){}}};
  const context=vm.createContext({
    cameraState:()=>({enabled:false,status:'off'}),getAuthUser:()=>({uid:'owner'}),
    document:{querySelector:()=>null,querySelectorAll:selector=>selector==='[data-sync-status]'?[status]:[],addEventListener(){}},
    window:{location:{pathname:'/study.html'},addEventListener(){},setInterval(){},dispatchEvent(){}},Event:class {},
  });
  vm.runInContext(`${source}\nnotice('저장하지 못했습니다.',true);`,context);
  assert.equal(status.textContent,'저장하지 못했습니다.');assert.equal(status.hidden,false);
  for(const page of ['school','account']) {
    context.window.location.pathname=`/${page}.html`;
    vm.runInContext('paint();',context);
    assert.equal(status.textContent,'');assert.equal(status.hidden,true);
  }
  vm.runInContext("notice('닉네임을 저장했습니다.');",context);
  assert.equal(status.textContent,'');assert.equal(status.hidden,true);
});

test('weekly goal progress sums Sunday through Saturday daily records including custom subjects',()=>{
  const now=Date.parse('2026-10-22T00:00:00Z');
  class Clock extends Date {static now(){return now;}}
  const context=vm.createContext({Date:Clock,getAuthUser:()=>null,cameraState:()=>({}),document:{addEventListener(){}},window:{addEventListener(){},setInterval(){}}});
  vm.runInContext(`${source}\nstate.days=[{date:'2026-10-17',totalSeconds:999,subjectSeconds:{s_physics:999}},{date:'2026-10-18',totalSeconds:600,subjectSeconds:{s_physics:600}},{date:'2026-10-22',totalSeconds:300,subjectSeconds:{other:300}}];globalThis.result=getStudyData().stats.week;`,context);
  assert.equal(context.result.totalSeconds,900);assert.equal(context.result.subjectSeconds.s_physics,600);assert.equal(context.result.subjectSeconds.other,300);
});

test('subject chart switches daily, weekly and monthly totals with matching hour/minute details',()=>{
  const node=()=>({children:[],textContent:'',attributes:{},style:{setProperty(){}},append(...items){this.children.push(...items);},replaceChildren(){this.children=[];this.textContent='';},setAttribute(name,value){this.attributes[name]=value;}});
  const chart=node(),details=node(),period={value:'week'},label=node();chart.dataset={chart:'subjects'};
  const context=vm.createContext({getAuthUser:()=>({uid:'owner'}),cameraState:()=>({}),
    document:{createElement:node,addEventListener(){},querySelector:selector=>selector==='[data-subject-period]'?period:selector==='[data-subject-times]'?details:null,querySelectorAll:selector=>selector==='[data-subject-period-label]'?[label]:[]},
    window:{addEventListener(){},setInterval(){}},chart,
  });
  vm.runInContext(`${source}\nauthResolved=true;state.pending.clear();state.profile={subjects:[{id:'custom',name:'물리'}]};state.today={subjectSeconds:{custom:3660}};state.week={subjectSeconds:{custom:7320,math:60,removed:120}};state.month={subjectSeconds:{custom:10980,other:30}};`,context);
  for(const [key,title,duration] of [['today','오늘','1시간 01분'],['week','이번 주','2시간 02분'],['month','이번 달','3시간 03분']]) {
    period.value=key;vm.runInContext('paintChart(chart);',context);
    assert.equal(label.textContent,title);assert.equal(chart.attributes['aria-label'],`${title} 과목별 학습 시간`);
    const totals=Object.fromEntries(details.children.map(row=>row.children.map(cell=>cell.textContent)));
    assert.equal(totals['물리'],duration);assert.equal(details.children.length,chart.children.length);
    if(key==='week'){assert.equal(totals['수학'],'0시간 01분');assert.equal(totals['삭제된 과목'],'0시간 02분');}
    if(key==='today')assert.equal(totals['기타'],'0시간 00분');
    if(key==='month')assert.equal(totals['기타'],'0시간 00분 (1분 미만)');
  }
  vm.runInContext("state.pending.add('month');paintChart(chart);",context);
  assert.equal(chart.textContent,'로딩 중…');assert.equal(details.children.length,0);
  vm.runInContext("state.pending.clear();state.failed.add('month');paintChart(chart);",context);
  assert.equal(chart.textContent,'기록을 불러오지 못했습니다.');assert.equal(details.children.length,0);
});

test('subject period change repaints and requests the selected aggregate',()=>{
  const handlers={},period={value:'month'};
  const context=vm.createContext({getAuthUser:()=>null,cameraState:()=>({}),
    document:{addEventListener:(name,handler)=>{(handlers[name]??=[]).push(handler);},querySelector:selector=>selector==='[data-subject-period]'?period:selector==='[data-chart="subjects"]'?{}:null,querySelectorAll:()=>[]},
    window:{addEventListener(){},setInterval(){}},
  });
  vm.runInContext(`${source}\nglobalThis.paints=0;globalThis.loads=0;paint=()=>{paints++;};loadVisibleData=async()=>{loads++;};globalThis.keys=()=>Array.from(visibleDataKeys());`,context);
  assert.deepEqual(Array.from(context.keys()),['month']);
  for(const handler of handlers.change)handler({target:{matches:selector=>selector==='[data-subject-period]'}});
  assert.equal(context.paints,1);assert.equal(context.loads,1);
  period.value='today';assert.deepEqual(Array.from(context.keys()),['today']);
  period.value='invalid';assert.deepEqual(Array.from(context.keys()),['week']);
});

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
  vm.runInContext(`${source}\nglobalThis.ui={observeSession,observeCameraReply,paintTimer,syncCamera,message:cameraTimerMessage,setProfile:value=>{state.profile=value;}};`,context);
  const configure = (send, sessionId = 'session') => {
    context.send = send;
    context.sessionId = sessionId;
    vm.runInContext('call=()=>send;state.profile={activeSessionId:sessionId};', context);
  };
  return {display,camera,handlers,ui:context.ui,configure,shiftClock:ms=>{now+=ms;},tick:ms=>{now+=ms;monotonic+=ms;},snapshot:(seconds,active=true,sequence=1)=>({
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

test('SP word counting freezes the camera display and menu/idle state releases it',()=>{
  const t=timerUi(0);t.ui.observeSession(t.snapshot(0));t.tick(2000);t.ui.paintTimer();
  assert.equal(t.display.textContent,'00:00:02');
  t.ui.setProfile({activeSessionId:'camera',wordCameraSessionId:'camera',wordPresenceUntilMs:200000});
  t.ui.paintTimer();assert.match(t.ui.message(t.camera),/SP word 사용 중/);
  t.tick(5000);t.ui.paintTimer();assert.equal(t.display.textContent,'00:00:02');
  t.ui.observeSession(t.snapshot(2,false,2));
  t.ui.setProfile({activeSessionId:'camera',wordCameraSessionId:'camera',wordPresenceUntilMs:null});
  t.ui.observeSession(t.snapshot(2,true,3));t.tick(1000);t.ui.paintTimer();assert.equal(t.display.textContent,'00:00:03');
});

test('camera display stops extrapolating when its server lease expires',()=>{
  const t=timerUi(6000);t.ui.observeSession(t.snapshot(0));
  t.tick(40000);t.ui.paintTimer();assert.equal(t.display.textContent,'00:00:30');
});

test('delayed checkpoints never add paused gaps or rewind the displayed time',()=>{
  const t=timerUi(0);
  t.ui.observeSession(t.snapshot(0));
  t.tick(3500);t.camera.tracking=false;t.handlers['study:camera-changed']();
  assert.equal(t.display.textContent,'00:00:03');
  t.tick(8000);t.ui.observeSession(t.snapshot(11,false,2));t.ui.paintTimer();
  assert.equal(t.display.textContent,'00:00:03');
  t.camera.tracking=true;t.handlers['study:camera-changed']();
  t.tick(2000);t.ui.observeSession(t.snapshot(11,true,3));
  t.tick(2000);t.ui.paintTimer();assert.equal(t.display.textContent,'00:00:05');
  t.ui.observeSession(t.snapshot(4,true,4));t.ui.paintTimer();
  assert.equal(t.display.textContent,'00:00:05');
});

test('wall clock changes and duplicate snapshots cannot shift an active display',()=>{
  const t=timerUi(0),snapshot=t.snapshot(0);
  t.ui.observeSession(snapshot);t.tick(3000);t.ui.paintTimer();
  t.ui.observeSession(snapshot);t.shiftClock(60000);t.tick(2000);t.ui.paintTimer();
  assert.equal(t.display.textContent,'00:00:05');
  t.camera.tracking=false;t.handlers['study:camera-changed']();
  t.shiftClock(-120000);t.tick(8000);t.ui.paintTimer();
  assert.equal(t.display.textContent,'00:00:05');
});

test('manual pause blocks timer and sync even if tracking is still true',async()=>{
  const t=timerUi(0),requests=[];
  t.configure(async request=>{requests.push(request);return {data:{session:{sequence:request.sequence,serverNowMs:100000,activeSinceMs:null,leaseUntilMs:null}}};});
  t.ui.observeSession(t.snapshot(0));t.tick(3000);
  t.camera.manuallyPaused=true;t.handlers['study:camera-changed']();
  await Promise.resolve();t.tick(8000);t.ui.paintTimer();
  assert.equal(t.display.textContent,'00:00:03');
  assert.equal(requests[0].tracking,false);
});

test('recognition bouncing during a heartbeat schedules a fresh resume acknowledgement',async()=>{
  const t=timerUi(0),requests=[];let acknowledge;
  t.configure(request=>{requests.push(request);return new Promise(resolve=>{acknowledge=()=>resolve({data:{session:{sequence:request.sequence,serverNowMs:100000,activeSinceMs:100000,leaseUntilMs:130000,accumulatedSeconds:0}}});});});
  t.ui.observeSession(t.snapshot(0));const pending=t.ui.syncCamera();
  t.camera.tracking=false;t.handlers['study:camera-changed']();
  t.camera.tracking=true;t.handlers['study:camera-changed']();
  acknowledge();await pending;
  assert.equal(requests.length,2);assert.equal(requests[1].tracking,true);
  acknowledge();await new Promise(resolve=>setImmediate(resolve));t.tick(2000);t.ui.paintTimer();
  assert.equal(t.display.textContent,'00:00:02');
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

test('camera setup and synchronization use a normal pending state while real failures remain paused',()=>{
  const classes=new Set(),camera={enabled:true,tracking:false,status:'scanning'},message={textContent:''};
  const context=vm.createContext({
    performance,
    cameraController:'controller',cameraState:()=>camera,getAuthUser:()=>null,
    document:{hidden:false,querySelectorAll:selector=>selector==='.timer-panel'?[{classList:{toggle:(name,on)=>on?classes.add(name):classes.delete(name)}}]:selector==='[data-timer-state]'?[message]:[],addEventListener(){}},
    window:{addEventListener(){},setInterval(){}},
  });
  vm.runInContext(`${source}\nstate.profile={activeSessionId:'session'};state.active={cameraMode:true,controllerId:'controller'};paintTimer();`,context);
  assert.equal(classes.has('camera-pending'),true);assert.equal(classes.has('camera-paused'),false);
  camera.status='tracking';camera.tracking=true;
  vm.runInContext('cameraResumeSequence=2;paintTimer();',context);
  assert.match(message.textContent,/서버와 동기화/);
  assert.equal(classes.has('camera-pending'),true);assert.equal(classes.has('camera-paused'),false);
  camera.status='paused';camera.tracking=false;
  vm.runInContext('paintTimer();',context);
  assert.equal(classes.has('camera-pending'),false);assert.equal(classes.has('camera-paused'),true);
  camera.status='scanning';
  vm.runInContext('cameraSyncFailed=true;paintTimer();',context);
  assert.equal(classes.has('camera-pending'),false);assert.equal(classes.has('camera-paused'),true);
});

test('normal camera termination shows saving without paused error styling until the server replies',async()=>{
  const clicks=[],classes=new Set(),message={textContent:''},camera={enabled:true,tracking:true,status:'tracking'};
  const button={disabled:false,dataset:{studyAction:'stop'}};
  let resolveSave,resolveClose,closed=0;
  const save=new Promise(resolve=>{resolveSave=resolve;});
  const close=new Promise(resolve=>{resolveClose=resolve;});
  const context=vm.createContext({
    performance,
    cameraController:'controller',cameraState:()=>camera,getAuthUser:()=>({uid:'owner',emailVerified:true}),
    stopCamera:(text='얼굴 인식으로 학습 시작')=>{camera.enabled=false;camera.tracking=false;camera.status='off';camera.message=text;},
    closeCameraFocus:async()=>{closed++;await close;},send:()=>save,Event:class {},
    document:{hidden:false,querySelector:()=>null,querySelectorAll:selector=>selector==='[data-study-action]'?[button]:selector==='[data-timer-state]'?[message]:selector==='.timer-panel'?[{classList:{toggle:(name,on)=>on?classes.add(name):classes.delete(name)}}]:[],addEventListener:(name,handler)=>{if(name==='click')clicks.push(handler);}},
    window:{addEventListener(){},setInterval(){},dispatchEvent(){}},
  });
  vm.runInContext(`${source}\ncall=()=>send;authServices={auth:{currentUser:{getIdToken:async()=>{}}}};state.profile={activeSessionId:'session'};state.active={cameraMode:true,controllerId:'controller'};`,context);
  const pending=clicks.map(click=>click({target:{closest:selector=>selector==='[data-study-action]'?button:null}}));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(message.textContent,'서버에 저장 중…');assert.equal(camera.message,'서버에 저장 중…');
  assert.equal(classes.has('camera-pending'),true);assert.equal(classes.has('camera-paused'),false);assert.equal(closed,0);
  resolveSave({data:{creditedSeconds:30,studyRevision:1}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(camera.message,'얼굴 인식으로 학습 시작');
  assert.equal(message.textContent,'학습 시작 대기');
  assert.equal(vm.runInContext('state.notice',context),'');
  resolveClose();await Promise.all(pending);
  assert.equal(closed,1);assert.equal(classes.has('camera-pending'),false);
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
