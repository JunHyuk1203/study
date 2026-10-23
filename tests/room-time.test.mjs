import test from 'node:test';
import assert from 'node:assert/strict';
import {roomClock,memberTime} from '../room-time.js';
import {roomDeadline,roomPreview,ROOM_IDLE_MS} from '../functions/room-service.js';

test('room inactivity expires three hours after the last service visit of any participant',()=>{
  assert.equal(roomDeadline({createdAtMs:0,members:{a:{lastSeenMs:100},b:{lastSeenMs:500}}}),500+ROOM_IDLE_MS);
  assert.equal(roomDeadline({createdAtMs:0,members:{},emptySinceMs:800}),800+ROOM_IDLE_MS);
});

test('previews sort the host first and distinguish studying, resting and offline',()=>{
  const room={title:'함께',hostUid:'host',members:{guest:{displayName:'친구',lastSeenMs:100000,status:'resting'},host:{displayName:'방장',lastSeenMs:100000,status:'studying',countUntilMs:110000},away:{displayName:'다른 친구',lastSeenMs:1,status:'studying'}}};
  const preview=roomPreview(room,'custom',101000);
  assert.equal(preview.memberCount,3);assert.equal(preview.members[0].isHost,true);
  assert.deepEqual(preview.members.map(member=>member.status),['studying','resting','offline']);
  assert.equal(roomPreview(room,'custom',111000).members[0].status,'resting');
  delete room.members.host;room.hostName='원래 방장';
  const left=roomPreview(room,'custom',101000);
  assert.equal(left.memberCount,2);assert.equal(left.members[0].displayName,'원래 방장');assert.equal(left.members[0].participating,false);
});

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
