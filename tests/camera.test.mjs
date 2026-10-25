import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { checkReach, checkSegment, facePose, mergePath, mergeStroke, MERGE_DURATION_MS, paintAvatar } from '../camera-avatar.js';
import { createFocusTracker } from '../camera-focus.js';
const healthySignals = { reliable:true, face:true, body:true, eyesClosed:false, phoneUse:false, studyActivity:true };

test('independent phone completion pauses immediately without releasing an in-flight face frame',async()=>{
  let now=0;
  const document={hidden:false,createElement:()=>({setAttribute(){}}),querySelector:()=>null,addEventListener(){}};
  const source=(await readFile(new URL('../camera.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'').replaceAll('import.meta.url',JSON.stringify(import.meta.url));
  const context=vm.createContext({document,crypto,Event,createFocusTracker,performance:{now:()=>now},facePose:()=>null,window:{addEventListener(){},dispatchEvent(){}}});
  vm.runInContext(`${source}\nenabled=true;globalThis.camera={acceptResult,acceptPhoneObservation,cameraState};globalThis.pending=()=>{inFlight=true;};globalThis.flight=()=>({inFlight,lastResult});`,context);
  const camera=context.camera,box=[.3,.5,.12,.2];
  const face=()=>camera.acceptResult({signals:{...healthySignals,phonePolicy:'tracked'},time:now,epoch:4});
  const phone=(candidates)=>camera.acceptPhoneObservation({epoch:4,observation:{version:2,id:now,frameId:now,observedAt:now,completedAt:now,epoch:4,status:'ok',region:{x:0,y:0,width:1,height:1},candidates}});
  face();now=1000;face();phone([]);now=2000;face();phone([]);
  now=2200;face();phone([{box,score:.6}]);now=2600;face();context.pending();
  now=2700;phone([{box,score:.6}]);
  assert.equal(camera.cameraState().reason,'phone');assert.equal(camera.cameraState().tracking,false);
  assert.equal(context.flight().inFlight,true);assert.equal(context.flight().lastResult,2600);
});

test('manual pause during engine setup survives detection and visibility changes until explicit resume',async()=>{
  let now=0;
  const handlers={},document={hidden:false,createElement:()=>({setAttribute(){}}),querySelector:()=>null,addEventListener:(name,handler)=>{handlers[name]=handler;}};
  const source=(await readFile(new URL('../camera.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'').replaceAll('import.meta.url',JSON.stringify(import.meta.url));
  const context=vm.createContext({document,crypto,Event,createFocusTracker,performance:{now:()=>now},facePose:()=>null,window:{addEventListener(){},dispatchEvent(){}}});
  vm.runInContext(`${source}\nenabled=true;globalThis.camera={toggleCameraPause,cameraState,acceptResult,setStatus};`,context);
  const camera=context.camera;
  camera.toggleCameraPause();assert.equal(camera.cameraState().manuallyPaused,true);
  for(now=0;now<=10000;now+=1000)camera.acceptResult({signals:healthySignals,time:now});
  document.hidden=true;handlers.visibilitychange();document.hidden=false;handlers.visibilitychange();
  camera.setStatus('tracking','detected',true);
  assert.equal(camera.cameraState().tracking,false);assert.equal(camera.cameraState().status,'paused');
  camera.toggleCameraPause();assert.equal(camera.cameraState().manuallyPaused,false);
  camera.acceptResult({signals:healthySignals,time:now});assert.equal(camera.cameraState().tracking,false);
  now+=2000;camera.acceptResult({signals:healthySignals,time:now});assert.equal(camera.cameraState().tracking,true);
});

test('a live SP word companion permits real background face detection and expiry restores the visibility pause',async()=>{
  let now=1000;const handlers={},document={hidden:false,createElement:()=>({setAttribute(){}}),querySelector:()=>null,addEventListener:(name,handler)=>{handlers[name]=handler;}};
  const source=(await readFile(new URL('../camera.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'').replaceAll('import.meta.url',JSON.stringify(import.meta.url));
  const context=vm.createContext({document,crypto,Event,createFocusTracker,performance:{now:()=>now},facePose:()=>null,window:{addEventListener(){},dispatchEvent(){}}});
  vm.runInContext(`${source}\nenabled=true;globalThis.camera={setCameraCompanion,cameraState,acceptResult,cameraVisible};`,context);
  const camera=context.camera;camera.setCameraCompanion(30000);document.hidden=true;handlers.visibilitychange();
  camera.acceptResult({signals:healthySignals,time:now});now+=2000;camera.acceptResult({signals:healthySignals,time:now});assert.equal(camera.cameraState().tracking,true);
  now+=30000;assert.equal(camera.cameraVisible(),false);camera.setCameraCompanion(0);assert.equal(camera.cameraState().tracking,false);
});

test('avatar follows mirrored head position and tilt within safe display bounds', () => {
  assert.deepEqual(facePose({ 1: { x: .5, y: .5 }, 33: { x: .3, y: .4 }, 263: { x: .7, y: .4 } }), { x: 0, y: 0, roll: -0 });
  const pose = facePose({ 1: { x: 0, y: 1 }, 33: { x: .3, y: .2 }, 263: { x: .6, y: .6 } });
  assert.deepEqual(pose, { x: 24, y: 15, roll: -28 });
});

test('missing or non-finite face points produce a neutral avatar', () => {
  assert.equal(facePose(null), null);
  assert.equal(facePose({ 1: { x: NaN, y: .5 } }), null);
  assert.equal(facePose({ 1: { x: .5, y: .5 }, 33: { x: .3, y: .4 }, 263: { x: Infinity, y: .4 } }), null);
});

function avatarMount() {
  const element = () => ({ classList: { toggle() {} }, style: { setProperty() {} }, setAttribute() {} });
  const avatar = element(), recognition = element();
  return { dataset: {}, querySelector: selector => selector === '.cam-avatar' ? avatar : recognition, querySelectorAll: () => [] };
}

test('all eight original strokes tile one connected check including its corner', () => {
  const segments = Array.from({ length: 8 }, (_, index) => checkSegment(index));
  assert.deepEqual(segments[0][0], [133, 160]);
  assert.deepEqual(segments[7].at(-1), [189, 139]);
  for (let index = 1; index < segments.length; index++) assert.deepEqual(segments[index - 1].at(-1), segments[index][0]);
  assert.ok(segments.flat().some(([x, y]) => x === 152 && y === 179));
});

test('check stroke first goes down from upper left, then turns upward at the elbow', () => {
  const early = Array.from({ length: 8 }, (_, index) => checkSegment(index, 8, .25)).flat();
  for (const [x, y] of early) assert.ok(Math.abs(y - x - 27) < .000001);
  const later = Array.from({ length: 8 }, (_, index) => checkSegment(index, 8, .65)).flat();
  assert.ok(later.some(([x, y]) => x === 152 && y === 179));
  assert.ok(later.at(-1)[0] > 152 && later.at(-1)[1] < 179);
  assert.deepEqual(later[0], [133, 160]);
});

test('recognition check completes despite frequent tracking updates', context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const mount = avatarMount(), pose = { x: 0, y: 0, roll: 0 };
  paintAvatar(mount, null, false, 'scanning');
  assert.equal(mount.dataset.avatarPhase, 'searching');
  paintAvatar(mount, pose, true, 'tracking');
  assert.equal(mount.dataset.avatarPhase, 'success');
  context.mock.timers.tick(MERGE_DURATION_MS);
  assert.equal(mount.dataset.avatarPhase, 'check');
  paintAvatar(mount, pose, true, 'tracking');
  context.mock.timers.tick(699);
  assert.equal(mount.dataset.avatarPhase, 'check');
  context.mock.timers.tick(1);
  assert.equal(mount.dataset.avatarPhase, 'avatar');
});

test('losing a face cancels the check and reacquisition plays it again', context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const mount = avatarMount(), pose = { x: 0, y: 0, roll: 0 };
  paintAvatar(mount, pose, true, 'tracking');
  context.mock.timers.tick(300);
  paintAvatar(mount, null, false, 'paused');
  context.mock.timers.tick(1000);
  assert.equal(mount.dataset.avatarPhase, 'searching');
  paintAvatar(mount, pose, true, 'tracking');
  assert.equal(mount.dataset.avatarPhase, 'success');
  context.mock.timers.tick(MERGE_DURATION_MS);
  assert.equal(mount.dataset.avatarPhase, 'check');
  context.mock.timers.tick(700);
  assert.equal(mount.dataset.avatarPhase, 'avatar');
});

test('SVG path interpolation writes actual geometry rather than CSS-only paths', () => {
  assert.equal(mergePath([[0, 0], [10, 10]], [[20, 30], [40, 50]], 0), 'M0.000 0.000L10.000 10.000');
  assert.equal(mergePath([[0, 0], [10, 10]], [[20, 30], [40, 50]], .5), 'M10.000 15.000L25.000 30.000');
  assert.equal(mergePath([[0, 0], [10, 10]], [[20, 30], [40, 50]], 1), 'M20.000 30.000L40.000 50.000');
});

for (const gap of [200, 2999, 3000]) test(`face returning within ${gap}ms keeps the avatar without replaying recognition`, context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const mount = avatarMount(), pose = { x: 0, y: 0, roll: 0 };
  paintAvatar(mount, pose, true, 'tracking', 0);
  context.mock.timers.tick(MERGE_DURATION_MS);
  context.mock.timers.tick(700);
  paintAvatar(mount, null, true, 'scanning', 5000);
  paintAvatar(mount, null, true, 'scanning', 5000 + gap);
  assert.equal(mount.dataset.avatarPhase, 'avatar');
  paintAvatar(mount, pose, true, 'tracking', 5000 + gap);
  assert.equal(mount.dataset.avatarPhase, 'avatar');
});

test('face missing longer than three seconds shows recognition again', context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const mount = avatarMount(), pose = { x: 0, y: 0, roll: 0 };
  paintAvatar(mount, pose, true, 'tracking', 0);
  context.mock.timers.tick(MERGE_DURATION_MS);
  context.mock.timers.tick(700);
  paintAvatar(mount, null, true, 'scanning', 5000);
  paintAvatar(mount, null, true, 'scanning', 8001);
  assert.equal(mount.dataset.avatarPhase, 'searching');
  paintAvatar(mount, pose, true, 'tracking', 8200);
  assert.equal(mount.dataset.avatarPhase, 'success');
});

test('a single missed frame during the grace period does not cancel the check', context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const mount = avatarMount(), pose = { x: 0, y: 0, roll: 0 };
  paintAvatar(mount, pose, true, 'tracking');
  context.mock.timers.tick(200);
  paintAvatar(mount, null, true, 'scanning');
  assert.equal(mount.dataset.avatarPhase, 'success');
  context.mock.timers.tick(MERGE_DURATION_MS - 200);
  assert.equal(mount.dataset.avatarPhase, 'check');
  paintAvatar(mount, null, true, 'scanning');
  assert.equal(mount.dataset.avatarPhase, 'check');
});

test('face breaks into small leftward fragments before returning as a continuous check', () => {
  const source = Array.from({ length: 17 }, (_, i) => [111 + i, 115 + i / 2]);
  const line = source.map((_, i) => [133 + i / 16 / 8 * 18 / Math.SQRT2, 160 + i / 16 / 8 * 18 / Math.SQRT2]);
  assert.deepEqual(mergeStroke(source, line, 0, 0), source);
  const left = mergeStroke(source, line, 0, .22);
  assert.ok(left[0][0] < source[0][0] - 20);
  assert.ok(left.at(-1)[0] - left[0][0] < 16 * .2);
  const other = mergeStroke(source, line, 7, .22);
  assert.ok(other[0][0] > left[0][0] + 20);
  assert.ok(other[0][1] > left[0][1] + 20);
  const beforeTurn = mergeStroke(source, line, 0, .4 - 1e-7);
  const turn = mergeStroke(source, line, 0, .4);
  assert.ok(beforeTurn.every((p, i) => Math.hypot(p[0] - turn[i][0], p[1] - turn[i][1]) < .001));
  assert.ok(mergeStroke(source, line, 0, .52)[0][0] > turn[0][0] + 40);
  assert.deepEqual(mergeStroke(source, line, 0, 1), checkSegment(0));
});

test('only the check tip extends slightly and returns once without a second bounce', () => {
  assert.ok(checkReach(.64) > 1);
  assert.equal(checkReach(.64), checkReach(.7));
  assert.ok(checkReach(.64) <= 1.12);
  assert.ok(checkReach(.84) > 1 && checkReach(.84) < checkReach(.72));
  assert.equal(checkReach(.93), 1);
  assert.equal(checkReach(1), 1);
  const extended = checkSegment(7, 8, checkReach(.64)).at(-1);
  assert.ok(extended[0] > 189 && extended[1] < 139);
  assert.deepEqual(checkSegment(7, 8, checkReach(1)).at(-1), [189, 139]);
});
