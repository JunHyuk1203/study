import test from 'node:test';
import assert from 'node:assert/strict';
import { facePose } from '../camera-avatar.js';

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
