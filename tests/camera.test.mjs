import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSegment, facePose, mergePath, paintAvatar } from '../camera-avatar.js';

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
  context.mock.timers.tick(560);
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
  context.mock.timers.tick(560);
  assert.equal(mount.dataset.avatarPhase, 'check');
  context.mock.timers.tick(700);
  assert.equal(mount.dataset.avatarPhase, 'avatar');
});

test('SVG path interpolation writes actual geometry rather than CSS-only paths', () => {
  assert.equal(mergePath([[0, 0], [10, 10]], [[20, 30], [40, 50]], 0), 'M0.000 0.000L10.000 10.000');
  assert.equal(mergePath([[0, 0], [10, 10]], [[20, 30], [40, 50]], .5), 'M10.000 15.000L25.000 30.000');
  assert.equal(mergePath([[0, 0], [10, 10]], [[20, 30], [40, 50]], 1), 'M20.000 30.000L40.000 50.000');
});

test('a single missed frame during the grace period does not cancel the check', context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const mount = avatarMount(), pose = { x: 0, y: 0, roll: 0 };
  paintAvatar(mount, pose, true, 'tracking');
  context.mock.timers.tick(200);
  paintAvatar(mount, null, true, 'scanning');
  assert.equal(mount.dataset.avatarPhase, 'success');
  context.mock.timers.tick(360);
  assert.equal(mount.dataset.avatarPhase, 'check');
  paintAvatar(mount, null, true, 'scanning');
  assert.equal(mount.dataset.avatarPhase, 'check');
});
