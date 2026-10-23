import test from 'node:test';
import assert from 'node:assert/strict';
import {roomClock,memberTime} from '../room-time.js';

test('room clocks show changing seconds and preserve hours over one day',()=>{
  assert.equal(roomClock(59),'00:00:59');assert.equal(roomClock(60),'00:01:00');
  assert.equal(roomClock(3661),'01:01:01');assert.equal(roomClock(90000),'25:00:00');
});
test('studying peers count every second only until their confirmed lease expires',()=>{
  const member={seconds:120,status:'studying',sampledAtMs:100000,countUntilMs:105000};
  assert.equal(memberTime(member,101000),121);assert.equal(memberTime(member,104999),124);
  assert.equal(memberTime(member,130000),125);assert.equal(memberTime(member,90000),120);
});
test('paused peers and legacy snapshots never invent study time',()=>{
  assert.equal(memberTime({seconds:60,status:'resting',sampledAtMs:1000,countUntilMs:20000},10000),60);
  assert.equal(memberTime({seconds:60,status:'studying',lastSeenMs:1000},10000),60);
  assert.equal(memberTime(null,10000),0);
});
