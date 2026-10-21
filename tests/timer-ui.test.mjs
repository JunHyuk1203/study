import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const source=(await readFile(new URL('../data.js',import.meta.url),'utf8'))
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
  vm.runInContext(`${source}\nglobalThis.ui={observeSession,paintTimer};`,context);
  return {display,camera,handlers,ui:context.ui,tick:ms=>{now+=ms;monotonic+=ms;},snapshot:(seconds,active=true,sequence=1)=>({
    cameraMode:true,controllerId:'controller',sequence,accumulatedSeconds:seconds,
    updatedAt:{toMillis:()=>now},activeSinceMs:active?now:null,leaseUntilMs:active?now+30000:null,
  })};
}

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
