import test from 'node:test';
import assert from 'node:assert/strict';
import {roomClock,memberTime,memberStatus} from '../room-time.js';
import {roomDeadline,roomPreview,ROOM_IDLE_MS,syncRoom} from '../functions/room-service.js';
import {roomStudyTotals,roomStudyMember,roomRankings} from '../functions/room-study.js';

test('room inactivity expires three hours after the last service visit of any participant',()=>{
  assert.equal(roomDeadline({createdAtMs:0,members:{a:{lastSeenMs:100},b:{lastSeenMs:500}}}),500+ROOM_IDLE_MS);
  assert.equal(roomDeadline({createdAtMs:0,members:{},emptySinceMs:800}),800+ROOM_IDLE_MS);
});

test('previews sort the host first and distinguish studying, resting and offline',()=>{
  const room={title:'함께',hostUid:'host',members:{guest:{displayName:'친구',lastSeenMs:100000,status:'resting'},host:{displayName:'방장',lastSeenMs:100000,status:'studying',countUntilMs:110000},away:{displayName:'다른 친구',lastSeenMs:1,status:'studying'}}};
  const preview=roomPreview(room,'custom',101000);
  assert.equal(preview.memberCount,3);assert.equal(preview.members[0].isHost,true);
  assert.deepEqual(preview.members.map(member=>member.status),['studying','resting','offline']);
  assert.equal(roomPreview(room,'custom',111000).members[0].status,'studying');
  assert.equal(roomPreview(room,'custom',145000).members[0].status,'offline');
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

test('lease expiry freezes time without inventing a pause between room snapshots',()=>{
  const member={lastSeenMs:100000,status:'studying',seconds:120,sampledAtMs:100000,countUntilMs:105000};
  assert.equal(memberStatus(member,104000),'studying');
  assert.equal(memberStatus(member,106000),'studying');
  assert.equal(memberTime(member,106000),125);
  assert.equal(memberStatus({...member,status:'resting'},106000),'resting');
  assert.equal(memberStatus(member,145000),'offline');
});

test('room sync preserves active camera status across a delayed credit heartbeat but respects explicit pauses',async()=>{
  const now=Date.now(),session={status:'active',cameraMode:true,presenceUntilMs:now+60000,activeSinceMs:now-15000,leaseUntilMs:now-5000,accumulatedSeconds:30,startedAt:{toMillis:()=>now-60000}};
  const records={
    'users/alice':{activeRoomId:'group',activeSessionId:'session'},
    'studyRooms/group':{status:'open',visibility:'private',createdAtMs:now,memberIds:['alice'],members:{alice:{lastSeenMs:now}}},
    'users/alice/sessions/session':session,
  };
  const db={doc:path=>({path}),runTransaction:callback=>callback({get:async ref=>({data:()=>records[ref.path]}),update(){}})};
  const active=await syncRoom(db,'alice','group');
  assert.equal(active.members.alice.status,'studying');
  assert.equal(active.members.alice.seconds,0); // Session time before room tracking is excluded.
  session.activeSinceMs=null;
  const paused=await syncRoom(db,'alice','group');
  assert.equal(paused.members.alice.status,'resting');
  assert.equal(paused.members.alice.seconds,0);
});

const at=text=>Date.parse(`${text}+09:00`);
function count(member,totals,now,tracking=true,lease=10000) {
  const settled=roomStudyTotals(member,totals,now);
  return {totals:settled,member:{...roomStudyMember(member,settled,now),verificationType:'face-browser',status:tracking?'studying':'resting',countUntilMs:tracking?now+lease:now}};
}
test('room ledger excludes pre-join time, survives sessions and rejoining, and does not count absence or expired leases',()=>{
  const start=at('2026-10-23T12:00:00');
  let row=count({displayName:'나',joinedAtMs:start},undefined,start);
  row=count(row.member,row.totals,start+5000,false);
  assert.equal(row.member.seconds,5);
  row=count(row.member,row.totals,start+20000,true);
  row=count(row.member,row.totals,start+25000,false);
  assert.equal(row.member.seconds,10);
  // Remove the member while retaining the room's totals, then rejoin the SAME room.
  row=count({displayName:'나',joinedAtMs:start+60000},row.totals,start+60000);
  assert.equal(row.member.seconds,10);
  row=count(row.member,row.totals,start+90000,false);
  assert.equal(row.member.seconds,20); // Only the confirmed 10s window, never the 30s gap.
  const other=count({displayName:'나',joinedAtMs:start+90000},undefined,start+90000);
  assert.equal(other.member.seconds,0);
});
test('room ledgers split midnight, Monday and month boundaries in Korean time',()=>{
  const start=at('2026-10-31T23:59:55');
  let row=count({joinedAtMs:start},undefined,start);
  row=count(row.member,row.totals,start+8000,false);
  assert.equal(row.member.seconds,3);assert.equal(row.totals.month.ms,3000);assert.equal(row.totals.week.ms,8000);
  assert.equal(memberTime({...row.member,studyDate:'2026-10-31',studyMs:99000},start+8000),0);
  const sunday=at('2026-11-01T23:59:55');
  row=count({joinedAtMs:sunday},undefined,sunday);
  row=count(row.member,row.totals,sunday+8000,false);
  assert.equal(row.totals.today.ms,3000);assert.equal(row.totals.week.ms,3000);assert.equal(row.totals.month.ms,8000);
});
test('rankings use room-only time, retain departed winners, handle ties and empty periods',()=>{
  const now=at('2026-10-23T12:00:00');
  const a=roomStudyTotals({displayName:'가'},undefined,now),b=structuredClone(a);
  b.displayName='나';a.today.ms=b.today.ms=10000;a.week.ms=20000;b.week.ms=30000;a.month.ms=50000;b.month.ms=30000;
  const ranks=roomRankings({memberIds:['a'],members:{a:{displayName:'가'}},studyTotals:{a,b}},now);
  assert.deepEqual(ranks.today.winners.map(row=>row.displayName),['가','나']);
  assert.equal(ranks.week.winners[0].uid,'b');assert.equal(ranks.month.winners[0].uid,'a');
  assert.deepEqual(roomRankings({memberIds:[],members:{}},now).today.winners,[]);
});
