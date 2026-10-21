import test from 'node:test';
import assert from 'node:assert/strict';
import { facePose, paintAvatar } from '../camera-avatar.js';

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
  return { dataset: {}, querySelector: selector => selector === '.cam-avatar' ? avatar : recognition };
}

test('recognition check completes despite frequent tracking updates', context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const mount = avatarMount(), pose = { x: 0, y: 0, roll: 0 };
  paintAvatar(mount, null, false, 'scanning');
  assert.equal(mount.dataset.avatarPhase, 'searching');
  paintAvatar(mount, pose, true, 'tracking');
  assert.equal(mount.dataset.avatarPhase, 'success');
  context.mock.timers.tick(800);
  paintAvatar(mount, pose, true, 'tracking');
  context.mock.timers.tick(100);
  assert.equal(mount.dataset.avatarPhase, 'avatar');
});

test('losing a face cancels the check and reacquisition plays it again', context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const mount = avatarMount(), pose = { x: 0, y: 0, roll: 0 };
  paintAvatar(mount, pose, true, 'tracking');
  context.mock.timers.tick(300);
  paintAvatar(mount, null, true, 'scanning');
  context.mock.timers.tick(1000);
  assert.equal(mount.dataset.avatarPhase, 'searching');
  paintAvatar(mount, pose, true, 'tracking');
  assert.equal(mount.dataset.avatarPhase, 'success');
  context.mock.timers.tick(900);
  assert.equal(mount.dataset.avatarPhase, 'avatar');
});
